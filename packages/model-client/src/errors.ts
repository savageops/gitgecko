/**
 * @gitgecko/model-client/errors — error categorization + retry.
 *
 * The cloud-pathway resilience layer. Wraps the pi-ai completeSimple call in
 * createProviderComplete with retry-on-transient + fail-fast-on-permanent.
 *
 * Re-implemented (not copied — connective tissue, different license surface)
 * from pullfrog's isTransientNetworkError.ts + billingErrors.ts + postRun.ts.
 * The pattern: classify errors so the caller can act on the category, not the
 * message string. A rate-limit (429) should retry; a billing exhaustion (402)
 * should surface a billing prompt; a genuine bug should fail fast.
 *
 * Salvage provenance:
 *  - isTransientNetworkError pattern: `.refs/01-pr-review/pullfrog-main/utils/isTransientNetworkError.ts`
 *  - BillingError vs TransientError split: `.refs/01-pr-review/pullfrog-main/utils/billingErrors.ts`
 *  - Retry budget (MAX_POST_RUN_RETRIES): `.refs/01-pr-review/pullfrog-main/agents/postRun.ts:404-546`
 *
 * Lives in model-client (not review) because this is where the HTTP errors
 * actually occur — the natural home for LLM-call resilience.
 */

/**
 * Error categories for the model layer. Each maps to a caller action:
 *  - transient: retry (network blip, rate limit, 5xx)
 *  - billing: surface a billing prompt (402, insufficient_quota)
 *  - timeout: retry with a longer timeout, or surface "model is slow"
 *  - permanent: fail fast (401 auth, 400 bad request, model not found)
 */
export type ErrorCategory = "transient" | "billing" | "timeout" | "permanent";

/**
 * Classify an error into a category. The caller decides what to do with it.
 *
 * Patterns checked (case-insensitive on message + known status codes):
 *  - ECONNRESET, ETIMEDOUT, EAI_AGAIN, "fetch failed", "network" → transient
 *  - 429, "rate limit", "too many requests", "overloaded" → transient
 *  - 503, 502, 500, "internal server error", "bad gateway" → transient
 *  - 402, "insufficient_quota", "billing" → billing
 *  - "timeout", "timed out", AbortError → timeout
 *  - everything else → permanent
 */
export const classifyError = (error: unknown): ErrorCategory => {
  if (!error) return "permanent";
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const name = error instanceof Error ? error.name : "";

  // Timeout / abort
  if (name === "AbortError" || msg.includes("timeout") || msg.includes("timed out")) return "timeout";

  // Explicit permanent (client-error) indicators take priority over embedded
  // numbers. A "400 Bad Request: expected 429 tokens, got 500" message contains
  // 429 and 500 but the authoritative status is 400 — permanent. Checking these
  // phrases first prevents misclassification when a message embeds numbers that
  // happen to look like transient codes.
  const permanentPhrases = ["bad request", "unauthorized", "forbidden", "not found", "invalid api key", "model not found"];
  if (permanentPhrases.some((p) => msg.includes(p))) return "permanent";

  // Network-level transient (TCP/connection)
  const networkPatterns = ["econnreset", "etimedout", "eai_again", "fetch failed", "network error", "socket hang up"];
  if (networkPatterns.some((p) => msg.includes(p))) return "transient";

  // Rate limiting. Anchored to a known status code (429) at a word boundary OR
  // an explicit phrase — bare "429" substring would misfire on token counts
  // ("expected 429 tokens") or model ids. The phrase checks are unambiguous.
  if (/\b429\b/.test(msg) || msg.includes("rate limit") || msg.includes("too many requests") || msg.includes("overloaded")) return "transient";

  // Server errors. Exact-code allow-list (NOT the broad 5\d{2} — that would
  // match port numbers like 5123 or model ids like claude-3-503). The phrases
  // catch providers that spell out the status instead of using the code.
  if (/\b(500|502|503|504)\b/.test(msg) || msg.includes("internal server error") || msg.includes("bad gateway") || msg.includes("service unavailable")) return "transient";

  // Billing. Anchored 402 + explicit phrases. "402" substring alone would
  // misfire on unrelated numbers.
  if (/\b402\b/.test(msg) || msg.includes("insufficient_quota") || msg.includes("billing") || msg.includes("payment required")) return "billing";

  // Everything else (401 auth code without phrase, etc.)
  return "permanent";
};

/**
 * Predicate: is this error worth retrying?
 * Transient + timeout errors should retry; billing + permanent should not.
 */
export const isTransient = (error: unknown): boolean => {
  const cat = classifyError(error);
  return cat === "transient" || cat === "timeout";
};

/**
 * Retry options. Defaults mirror pullfrog's MAX_POST_RUN_RETRIES=3 with
 * exponential backoff (1s, 2s, 4s).
 */
export interface RetryOptions {
  /** Max attempts (including the first). Default 3. */
  readonly maxAttempts?: number;
  /** Base delay in ms for exponential backoff. Default 1000. */
  readonly baseDelayMs?: number;
  /** Which errors to retry. Default: isTransient. */
  readonly shouldRetry?: (error: unknown) => boolean;
  /** Optional callback fired before each retry (for logging/trace). */
  readonly onRetry?: (error: unknown, attempt: number) => void;
}

/**
 * Wrap an async function with retry logic. Retries on transient errors
 * (network blips, rate limits, timeouts) with exponential backoff.
 * Fails fast on permanent errors (auth, bad request, billing).
 *
 * Usage:
 *   const result = await withRetry(() => models.completeSimple(model, ctx), {
 *     onRetry: (e, n) => trace.record({ step: "retry", attempt: n }),
 *   });
 */
export const withRetry = async <T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> => {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const shouldRetry = opts.shouldRetry ?? isTransient;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxAttempts || !shouldRetry(error)) {
        throw error;
      }
      opts.onRetry?.(error, attempt);
      // Exponential backoff: 1s, 2s, 4s, ... (capped at 10s)
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), 10_000);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  // Unreachable: the loop always returns or throws. If maxAttempts were 0 (not
  // allowed — caller-controlled but the loop wouldn't execute), fall through.
  throw new Error("withRetry: maxAttempts must be >= 1");
};
