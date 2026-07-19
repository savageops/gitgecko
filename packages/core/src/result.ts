/**
 * @gitgecko/core/result — typed error handling.
 *
 * gitgecko uses Result<T, E> instead of throw-as-control-flow at module
 * boundaries (the planning-spec "explicit error returns" invariant, #13).
 * Throws are reserved for genuinely unreachable/bug states. Every async
 * result that can fail at an owner/plug boundary returns a Result.
 *
 * Salvaged shape: the Rust-style Ok/Err discriminated union, narrowed to
 * what's ergonomic in TS. Not pulling a library — this is small enough to
 * own, and owning it keeps the core dep-free (Continue's core boundary,
 * P-frontend-12).
 */

export type Result<T, E = GitGeckoError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E = GitGeckoError>(error: E): Result<never, E> => ({ ok: false, error });

/**
 * The canonical error envelope. Every plug/owner failure is normalized to
 * this shape before crossing a boundary. `code` is a stable, kebab-case
 * machine identifier (e.g. "billing.quota-exceeded"); `message` is human.
 */
export interface GitGeckoError {
  readonly code: string;
  readonly message: string;
  readonly cause?: unknown;
  readonly retryable?: boolean;
}

export const gitGeckoError = (
  code: string,
  message: string,
  opts: { cause?: unknown; retryable?: boolean } = {},
): GitGeckoError => ({
  code,
  message,
  ...(opts.cause !== undefined && { cause: opts.cause }),
  ...(opts.retryable !== undefined && { retryable: opts.retryable }),
});

/** Convenience: wrap a throwing fn in a Result. Use at the edge of untrusted calls. */
export async function tryAsync<T>(
  fn: () => Promise<T>,
  onThrow: (e: unknown) => GitGeckoError,
): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (e) {
    return err(onThrow(e));
  }
}
