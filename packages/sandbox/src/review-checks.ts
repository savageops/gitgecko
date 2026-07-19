import type { ExecResult, ExecSpec, SandboxBackend } from "./socket.js";

export type ReviewCheckStatus = "passed" | "failed" | "timed_out" | "denied" | "errored";

/** A caller-owned check translated to the sandbox socket without shell interpolation. */
export interface ReviewCheckRequest {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Environment keys whose values must be removed from evidence; defaults to every key. */
  readonly secretEnvKeys?: readonly string[];
  readonly timeoutMs?: number;
  readonly required?: boolean;
}

/** Public execution evidence; environment values are intentionally excluded. */
export interface ReviewCheckReceipt {
  readonly id: string;
  readonly label: string;
  readonly required: boolean;
  readonly status: ReviewCheckStatus;
  readonly command: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
  readonly backend: { readonly id: string; readonly isolated: boolean };
  readonly detail?: string;
}

export interface ReviewCheckReport {
  readonly allRequiredPassed: boolean;
  readonly receipts: readonly ReviewCheckReceipt[];
}

export interface ReviewCheckRunOptions {
  readonly maxOutputBytes?: number;
  readonly now?: () => number;
}

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024;
const CHECK_ID = /^[a-z0-9][a-z0-9._-]*$/;

/** Remove caller-supplied environment values from every persisted output channel. */
const redactEnvironment = (
  value: string,
  env: Readonly<Record<string, string>> | undefined,
  secretEnvKeys: readonly string[] | undefined,
  args: readonly string[] | undefined,
): string => {
  const selected = secretEnvKeys === undefined
    ? Object.values(env ?? {})
    : secretEnvKeys.map((key) => env?.[key]).filter((candidate): candidate is string => candidate !== undefined);
  // Long argv values commonly carry tokens or credential-bearing URLs. They
  // still reach the process unchanged, but never survive into public evidence.
  const argumentSecrets = (args ?? []).filter((candidate) => candidate.length >= 12);
  const secrets = [...new Set([...selected, ...argumentSecrets].filter((candidate) => candidate.length > 0))]
    .sort((left, right) => right.length - left.length);
  return secrets.reduce((redacted, secret) => redacted.split(secret).join("[REDACTED]"), value);
};

/** Preserve valid UTF-8 while bounding provider-controlled process output. */
const truncateUtf8 = (value: string, maxBytes: number): { value: string; truncated: boolean } => {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxBytes) return { value, truncated: false };

  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = maxBytes; end >= 0; end -= 1) {
    try {
      return { value: decoder.decode(encoded.subarray(0, end)), truncated: true };
    } catch {
      // A byte-boundary can land inside one code point; retreat to the prior boundary.
    }
  }
  return { value: "", truncated: true };
};

/** Reject malformed batches before the first side effect so partial execution cannot occur. */
const validateRequests = (requests: readonly ReviewCheckRequest[]): void => {
  const ids = new Set<string>();
  for (const request of requests) {
    if (request.id.trim().length === 0) throw new Error("review check id must not be empty");
    if (!CHECK_ID.test(request.id)) throw new Error(`review check id '${request.id}' must be canonical lowercase kebab-case`);
    if (ids.has(request.id)) throw new Error(`duplicate check id: ${request.id}`);
    ids.add(request.id);
    if (request.label.trim().length === 0) throw new Error(`review check '${request.id}' label must not be empty`);
    if (request.command.trim().length === 0) throw new Error(`review check '${request.id}' command must not be empty`);
    if (request.timeoutMs !== undefined && (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0)) {
      throw new Error(`review check '${request.id}' timeoutMs must be a positive finite number`);
    }
  }
};

const statusFor = (result: ExecResult): ReviewCheckStatus => {
  if (result.denied) return "denied";
  if (result.timedOut) return "timed_out";
  return result.exitCode === 0 ? "passed" : "failed";
};

/**
 * Execute review checks through the canonical sandbox backend and emit bounded evidence.
 * Checks run sequentially because build tools commonly contend for the same workspace state.
 */
export const runReviewChecks = async (
  requests: readonly ReviewCheckRequest[],
  backend: SandboxBackend,
  options: ReviewCheckRunOptions = {},
): Promise<ReviewCheckReport> => {
  validateRequests(requests);
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new Error("maxOutputBytes must be a positive integer");
  }
  const now = options.now ?? Date.now;
  const receipts: ReviewCheckReceipt[] = [];

  for (const request of requests) {
    const startedAt = now();
    const spec: ExecSpec = {
      command: request.command,
      ...(request.args ? { args: request.args } : {}),
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.env ? { env: request.env } : {}),
      ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
      maxOutputBytes,
    };

    let result: ExecResult;
    let detail: string | undefined;
    let status: ReviewCheckStatus;
    try {
      result = await backend.exec(spec);
      status = statusFor(result);
      detail = result.denied ? result.denyReason ?? "execution denied by sandbox policy" : undefined;
    } catch (error) {
      result = { exitCode: -1, stdout: "", stderr: "", timedOut: false, denied: false };
      status = "errored";
      detail = error instanceof Error ? error.message : String(error);
    }

    const stdout = truncateUtf8(redactEnvironment(result.stdout, request.env, request.secretEnvKeys, request.args), maxOutputBytes);
    const stderr = truncateUtf8(redactEnvironment(result.stderr, request.env, request.secretEnvKeys, request.args), maxOutputBytes);
    const safeDetail = detail ? redactEnvironment(detail, request.env, request.secretEnvKeys, request.args) : undefined;
    receipts.push({
      id: request.id,
      label: request.label,
      required: request.required ?? true,
      status,
      command: request.command,
      exitCode: result.exitCode,
      durationMs: Math.max(0, now() - startedAt),
      stdout: stdout.value,
      stderr: stderr.value,
      outputTruncated: result.outputTruncated === true || stdout.truncated || stderr.truncated,
      backend: { id: backend.id, isolated: backend.isolated },
      ...(safeDetail ? { detail: safeDetail } : {}),
    });
  }

  return {
    allRequiredPassed: receipts.every((receipt) => !receipt.required || receipt.status === "passed"),
    receipts,
  };
};
