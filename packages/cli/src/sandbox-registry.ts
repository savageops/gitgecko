/** Compose the customer runtime-check path through the sandbox socket. */
import { Registry } from "@gitgecko/socket";
import { runReviewChecks, sandboxOwner, type ReviewCheckReport, type ReviewCheckRequest, type SandboxContribution } from "@gitgecko/sandbox";
import * as subprocessSandboxPlug from "@gitgecko/plug-sandbox-backends";

const logger = { info() {}, warn() {}, error() {} };
const CHECK_ENVIRONMENT_KEYS = new Set([
  "APPDATA", "CI", "COMSPEC", "HOME", "LOCALAPPDATA", "NO_COLOR", "PATH", "PATHEXT", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE",
]);

/** Give build tools process discovery and home-directory context without inheriting credentials. */
export const createReviewCheckEnvironment = (source: NodeJS.ProcessEnv): Readonly<Record<string, string>> =>
  Object.fromEntries(Object.entries(source).filter(([key, value]) => value !== undefined && CHECK_ENVIRONMENT_KEYS.has(key.toUpperCase()))) as Readonly<Record<string, string>>;

/** Load the bundled local backend through its owner; the CLI never calls a plug backend directly. */
export const runBundledReviewChecks = async (
  checks: readonly Omit<ReviewCheckRequest, "cwd" | "env" | "secretEnvKeys">[],
  cwd: string,
): Promise<ReviewCheckReport> => {
  const registry = new Registry<"exec", string, SandboxContribution>(sandboxOwner);
  const loaded = await registry.load(subprocessSandboxPlug, { config: {}, logger });
  if (!loaded.ok) throw new Error(`sandbox plug failed registry validation: ${loaded.error.message} (${loaded.error.code})`);
  const contribution = loaded.value.contributions.find((entry) => entry.capability === "exec")?.contribution;
  if (!contribution || contribution.kind !== "sandbox-backend") throw new Error("sandbox plug loaded without an exec backend");
  const env = createReviewCheckEnvironment(process.env);
  return runReviewChecks(checks.map((check) => ({ ...check, cwd, env, secretEnvKeys: [] })), contribution.backend, { maxOutputBytes: 4 * 1024 });
};
