/**
 * @gitgecko/cli/main — the CLI dispatch entry. Compiled by tsc to dist/main.js.
 * The bin (bin/gitgecko.js) imports this. This is a normal TS module — no dynamic
 * .ts imports, no tsx, no bundling. Deps resolve from node_modules at runtime.
 */
import { parseArgs, runReview } from "./orchestrator.js";
import { evaluateCliDiff } from "./deterministic.js";
import { loadHostedReviewHistory, renderHostedReviewHistory, runHostedReview } from "./hosted.js";
import { runDoctor, renderDoctor } from "./doctor.js";
import { createFileAuthStore, loadAuth, login, logoutCommand as logout, whoami } from "./auth.js";
import { loadAvailableModels, renderModels } from "./models.js";
import { detectNativeAgents } from "@gitgecko/review";
import { createRealBinaryProbe } from "@gitgecko/review/native-agents";
import { createGitGeckoNativeAgent } from "@gitgecko/plug-agent-gitgecko-native";
import { createAutoComplete } from "@gitgecko/model-client";
import { resolveInstructions } from "@gitgecko/instructions";
import { normalizeGitHubRepository, productIdentity } from "@gitgecko/core";
import { captureWorkspaceSnapshot } from "./workspace-observer.js";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { requireReviewInput, reviewExitCode } from "./review-input.js";
import { readWorkingTreeDiff } from "./working-tree-diff.js";
import { GITGECKO_VERSION } from "./version.js";
import { createFileConfigStore, getConfigFilePath, renderModelProviderConfig, resolveModelProvider, toLocalEndpointConfig } from "./config.js";
import { renderNativeThreadCommand, runNativeThreadCommand } from "./threads.js";
import { createBundledAgent, createBundledThreadAgent } from "./provider-registry.js";
import { createCliProgressReporter } from "./progress.js";
import { toPublicCliResult } from "./public-result.js";
import { runBundledReviewChecks } from "./sandbox-registry.js";
import { buildFixAllHandoff } from "./fix-handoff.js";

const CLI = productIdentity.cliCommand;

/** Preserve the machine-readable stdout contract for every CLI failure path. */
function emitFailure(json: boolean | undefined, message: string, failure: "auth" | "provider" | "cli"): void {
  if (json) console.log(JSON.stringify({ success: false, output: message, failure }));
  else console.error(message);
}

export async function main(): Promise<void> {
  const parsedArgs = parseArgs(process.argv.slice(2));
  const reviewCwd = resolve(parsedArgs.cwd ?? process.cwd());
  const connectedPullReview = parsedArgs.command === "review"
    && parsedArgs.cloud === true
    && parsedArgs.projectId !== undefined
    && parsedArgs.pullNumber !== undefined;
  const fixAllInstruction = parsedArgs.command === "fix-all"
    ? buildFixAllHandoff(readFileSync(resolve(reviewCwd, parsedArgs.findingsFile!), "utf8"))
    : undefined;
  const resolvedArgs = parsedArgs.diffFile
    ? { ...parsedArgs, diff: readFileSync(resolve(reviewCwd, parsedArgs.diffFile), "utf8") }
    : parsedArgs.files && parsedArgs.files.length > 0 && !parsedArgs.diff
      ? { ...parsedArgs, diff: parsedArgs.files.map((file) => `--- ${file}\n+++ ${file}\n@@\n+${readFileSync(resolve(reviewCwd, file), "utf8").replace(/\n/g, "\n+")}`).join("\n") }
      : !connectedPullReview && parsedArgs.diff === undefined && ["review", "describe", "improve", "ask", "fix", "fix-all"].includes(parsedArgs.command)
        ? { ...parsedArgs, diff: readWorkingTreeDiff(reviewCwd) }
        : parsedArgs;
  const reviewDiff = connectedPullReview ? undefined : requireReviewInput(resolvedArgs.command, resolvedArgs.diff);
  let args = {
    ...resolvedArgs,
    ...(fixAllInstruction ? { fixInstruction: fixAllInstruction } : {}),
    ...(reviewDiff !== undefined && { diff: reviewDiff }),
  };

  // --- info commands ---
  if (args.command === "version") {
    console.log(`${CLI} ${GITGECKO_VERSION}`);
    process.exit(0);
  }

  if (args.command === "help") {
    console.log(`${productIdentity.name} ${GITGECKO_VERSION} — code review through your installed tools`);
    console.log("");
    console.log("USAGE:");
    console.log(`  ${CLI} review [--diff <diff> | --diff-file <path>] [--file <path>...] [--mission correctness|security|reliability|performance|testability] [--pathway auto|codex|claude|opencode|pi|deterministic|native-loop|cloud]`);
    console.log(`  ${CLI} review --pathway cloud --project <id> --pull <number>   review a connected GitHub pull request with linked requirements`);
    console.log("             [--cwd <directory>] [--permission read-only|workspace-write|unrestricted] [--run-checks] [--json] [--agent]");
    console.log(`  ${CLI} describe [--diff <diff>]`);
    console.log(`  ${CLI} improve [--diff <diff>]`);
    console.log(`  ${CLI} ask "<question>" [--diff <diff>]`);
    console.log(`  ${CLI} fix --apply "<finding or instruction>" [--diff <diff>] [--pathway codex|claude|opencode|pi]`);
    console.log(`  ${CLI} fix-all --apply --findings-file <review.json> [--diff <diff>] [--pathway codex|claude|opencode|pi]`);
    console.log(`  ${CLI} doctor   check installed CLIs, model routes, and the selected path`);
    console.log(`  ${CLI} auth     link this device to your cloud account (alias: login)`);
    console.log(`  ${CLI} logout   unlink this device`);
    console.log(`  ${CLI} whoami   show the current auth status`);
    console.log(`  ${CLI} models   list hosted or locally discovered models`);
    console.log(`  ${CLI} models configure --base-url <url> --model <id> [--protocol <protocol>] [--api-key-env <name>]`);
    console.log(`  ${CLI} models show|clear   inspect or remove saved local model routing`);
    console.log(`  ${CLI} history [--json]   list this account's cloud review runs`);
    console.log(`  ${CLI} threads start "<instruction>" [--provider codex|claude|opencode|pi] [--cwd <directory>] [--permission <mode>] [--json]`);
    console.log(`  ${CLI} threads resume <id> "<instruction>" [--permission <mode>] [--json]`);
    console.log(`  ${CLI} threads list|read <id>|delete <id> [--json]`);
    console.log("");
    console.log("PATHWAY:");
    console.log("  auto          use an installed coding CLI, then a configured model route, then rule-only review (default)");
    console.log("  deterministic run built-in rules only; no account, model, or API key");
    console.log("  codex         use the installed Codex CLI");
    console.log("  claude        use the installed Claude Code CLI");
    console.log("  opencode      use the installed OpenCode CLI");
    console.log("  pi            use the model route saved with gitgecko models configure");
    console.log("  local         compatibility alias for pi");
    console.log("  native-loop   use the advanced API-backed model route");
    console.log("  cloud         use the authenticated GitGecko cloud review owner");
    console.log("");
    console.log("OUTPUT:");
    console.log("  --json        output the full result as JSON to stdout (machine-readable)");
    console.log("  --agent       suppress stderr noise — output only the review text (for agent workflows)");
    console.log("  --run-checks  run configured reviewChecks in the reviewed directory before review (opt-in)");
    console.log("  --apply       explicitly authorize the local workspace-writing /fix lane");
    console.log("");
    console.log("ENVIRONMENT (API-backed model routes):");
    console.log("  ANTHROPIC_API_KEY   Anthropic Claude API key");
    console.log("  OPENAI_API_KEY      OpenAI GPT API key");
    console.log("  GITGECKO_LOCAL_BASE_URL  Local endpoint URL (LM Studio/Ollama/vLLM)");
    process.exit(0);
  }

  if (args.command === "doctor") {
    console.log(renderDoctor(runDoctor(process.env, undefined, createFileConfigStore().read().modelProvider)));
    process.exit(0);
  }

  // --- auth commands ---
  if (args.command === "login") {
    const result = await login();
    console.log(result.message);
    process.exitCode = result.success ? 0 : 1;
    return;
  }

  if (args.command === "logout") {
    console.log((await logout()).message);
    return;
  }

  if (args.command === "whoami") {
    const auth = await whoami();
    if (auth.loggedIn && auth.config) {
      console.log("Logged in. Plan: " + (auth.config.planId ?? "free") + ". Device: " + (auth.config.deviceId ?? "(unlinked)"));
      console.log("Cloud: " + (auth.config.cloudUrl ?? productIdentity.domain));
    } else {
      console.log(`Not logged in. Run '${CLI} auth' to link this device (optional — local reviews work without it).`);
    }
    return;
  }

  if (args.command === "models") {
    const store = createFileConfigStore();
    if (args.modelsAction === "configure") {
      const candidate = args.modelProvider;
      if (!(candidate?.baseUrl && candidate.model)) {
        throw new Error("models configure requires --base-url <url> and --model <id>.");
      }
      store.write({ ...store.read(), modelProvider: {
        baseUrl: candidate.baseUrl,
        model: candidate.model,
        protocol: candidate.protocol ?? "openai-chat-completions",
        ...(candidate.apiKeyEnv ? { apiKeyEnv: candidate.apiKeyEnv } : {}),
      } });
      console.log(renderModelProviderConfig(store.read()));
      process.exit(0);
    }
    if (args.modelsAction === "clear") {
      const { modelProvider: _removedProvider, ...withoutProvider } = store.read();
      store.write(withoutProvider);
      console.log("Saved model provider removed. Environment-based and cloud discovery remain available.");
      process.exit(0);
    }
    if (args.modelsAction === "show") {
      console.log(renderModelProviderConfig(store.read()));
      process.exit(0);
    }
    const provider = store.read().modelProvider;
    console.log(renderModels(await loadAvailableModels(loadAuth(createFileAuthStore()), process.env, fetch, provider)));
    process.exit(0);
  }

  // --- review commands ---
  const probe = createRealBinaryProbe();
  const detection = detectNativeAgents(probe);
  const savedConfig = createFileConfigStore().read();
  const savedProvider = resolveModelProvider(savedConfig);
  const piConfig = savedProvider ? toLocalEndpointConfig(savedProvider) : undefined;

  if (args.command === "threads") {
    if (!args.threadAction) throw new Error("threads requires an action.");
    const threadProgress = args.json || (args.threadAction !== "start" && args.threadAction !== "resume") ? undefined : createCliProgressReporter();
    const result = await runNativeThreadCommand({
      action: args.threadAction,
      ...(args.threadId ? { id: args.threadId } : {}),
      ...(args.threadProvider ? { provider: args.threadProvider } : {}),
      ...(args.threadPrompt ? { prompt: args.threadPrompt } : {}),
      ...(args.cwd ? { cwd: args.cwd } : {}),
      ...(args.permission ? { permission: args.permission } : {}),
      ...(args.json ? { json: true } : {}),
    }, {
      createAgent: (provider) => createBundledThreadAgent(provider, piConfig),
      ...(threadProgress ? { onActivity: threadProgress.report } : {}),
    }).finally(() => threadProgress?.stop());
    console.log(args.json ? JSON.stringify(result) : renderNativeThreadCommand(result));
    if (!result.success) process.exit(1);
    return;
  }

  // Resolve cloud routing before checks: client-run receipts are not trusted
  // cloud evidence and must never be executed only to disappear in transport.
  const auth = loadAuth(createFileAuthStore());
  if (args.pathway?.kind === "local" && savedProvider) {
    args = { ...args, pathway: { kind: "local", config: { ...toLocalEndpointConfig(savedProvider), ...(savedProvider.apiKey ? { apiKey: savedProvider.apiKey } : {}) } } };
  }
  const useHostedReview = Boolean(
    auth
      && args.command !== "fix"
      && args.command !== "fix-all"
      && (args.diff || connectedPullReview)
      && (args.cloud === true
        || args.pathway?.kind === "native-loop"
        || (args.pathway === undefined && detection.available.length === 0)),
  );
  if (args.runChecks && useHostedReview) {
    emitFailure(args.json, `${CLI}: --run-checks is local-only; select a local pathway so checks execute in the reviewed workspace.`, "cli");
    process.exit(1);
    return;
  }

  const mutationChecks = args.runChecks && (args.command === "fix" || args.command === "fix-all");
  if (args.runChecks && (savedConfig.reviewChecks ?? []).length === 0) {
    emitFailure(args.json, `${CLI}: --run-checks requires at least one reviewChecks entry in ${getConfigFilePath()}.`, "cli");
    process.exit(1);
    return;
  }
  if (args.runChecks && !mutationChecks) {
    const checks = savedConfig.reviewChecks ?? [];
    if (!args.agent && !args.json) console.error(`[${productIdentity.shortName}] runtime validation — running ${checks.length} configured check${checks.length === 1 ? "" : "s"}`);
    const runtimeChecks = await runBundledReviewChecks(checks.map((check) => ({
      id: check.id,
      label: check.label,
      command: check.command,
      ...(check.args ? { args: check.args } : {}),
      ...(check.timeoutMs !== undefined ? { timeoutMs: check.timeoutMs } : {}),
      ...(check.required !== undefined ? { required: check.required } : {}),
    })), reviewCwd);
    if (!args.agent && !args.json) console.error(`[${productIdentity.shortName}] runtime validation — ${runtimeChecks.allRequiredPassed ? "required checks passed" : "a required check failed"}`);
    args = { ...args, runtimeChecks };
  }

  // An authenticated CLI with no explicit local/native selection uses the
  // durable cloud review owner. Explicit local and native pathways remain
  // local, so signing in never steals a user's chosen agent.
  if (args.cloud && !auth) {
    emitFailure(args.json, `${CLI}: --pathway cloud requires an authenticated device. Run '${CLI} auth' first.`, "auth");
    process.exit(1);
    return;
  }

  if ((args.command === "fix" || args.command === "fix-all") && args.cloud) {
    emitFailure(args.json, `${CLI}: /${args.command} is local-only and runs through an installed or configured local agent.`, "cli");
    process.exit(1);
    return;
  }

  if (args.command === "history") {
    const auth = loadAuth(createFileAuthStore());
    if (!auth) {
      emitFailure(args.json, `${CLI}: history requires an authenticated device. Run '${CLI} auth' first.`, "auth");
      process.exit(1);
      return;
    }
    try {
      const history = await loadHostedReviewHistory(auth);
      console.log(args.json ? JSON.stringify(history) : renderHostedReviewHistory(history));
      process.exit(0);
      return;
    } catch (error) {
      emitFailure(args.json, `${CLI}: history failed: ${error instanceof Error ? error.message : String(error)}`, "provider");
      process.exit(1);
      return;
    }
  }
  if (useHostedReview && auth) {
    try {
      const githubUrl = readWorkingTreeGitHubUrl(reviewCwd);
      const hosted = await runHostedReview(auth, {
        ...(args.diff ? { diff: args.diff } : {}),
        ...(githubUrl ? { githubUrl } : {}),
        ...(args.projectId ? { projectId: args.projectId } : {}),
        ...(args.pullNumber !== undefined ? { pullNumber: args.pullNumber } : {}),
        ...(args.title ? { title: args.title } : {}),
        ...(args.command === "review" || args.command === "describe" || args.command === "improve" || args.command === "ask"
          ? { command: args.command }
          : {}),
      });
      if (!args.agent && !args.json) console.error(`[${productIdentity.shortName}] pathway: cloud (${auth.cloudUrl})`);
      if (args.json) console.log(JSON.stringify(hosted));
      else console.log(hosted.output);
      if (reviewExitCode(args.command, hosted.success, hosted.artifact?.mergeable !== false) !== 0) process.exit(1);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emitFailure(args.json, `${productIdentity.shortName}: hosted review failed: ${message}`, "provider");
      process.exit(1);
      return;
    }
  }

  // Model provider (from environment auto-detect). null if no key is set; an
  // installed CLI path can still run with the developer's own login.
  let modelComplete: ((prompt: string, model?: string) => Promise<string>) | undefined;
  try {
    const provider = createAutoComplete({
      ...(savedProvider ? { localProvider: {
        baseUrl: savedProvider.baseUrl,
        model: savedProvider.model,
        protocol: savedProvider.protocol,
        ...(savedProvider.apiKey ? { apiKey: savedProvider.apiKey } : {}),
      } } : {}),
    });
    modelComplete = provider.complete;
  } catch {
    // No model configured: a detected installed CLI may still run; otherwise
    // the canonical factory returns an actionable failed result.
  }

  const progress = args.agent || args.json ? undefined : createCliProgressReporter();
  const result = await runReview(args, {
    probeNatives: () => detection.available,
    ...(piConfig ? { piConfig } : {}),
    inferenceAvailable: Boolean(modelComplete),
    ...(progress ? { onActivity: progress.report } : {}),
    findings: await evaluateCliDiff(args.diff ?? ""),
    captureWorkspace: captureWorkspaceSnapshot,
    ...(mutationChecks ? { verifyMutation: async (cwd: string) => runBundledReviewChecks((savedConfig.reviewChecks ?? []).map((check) => ({
      id: check.id,
      label: check.label,
      command: check.command,
      ...(check.args ? { args: check.args } : {}),
      ...(check.timeoutMs !== undefined ? { timeoutMs: check.timeoutMs } : {}),
      ...(check.required !== undefined ? { required: check.required } : {}),
    })), cwd) } : {}),
    resolveInstructions: (cliArgs, payload, findings, repoContext) =>
      resolveInstructions({ ...cliArgs, cwd: cliArgs.cwd ?? process.cwd() }, payload, findings, repoContext),
    createAgent: (res) => {
      const agent = createBundledAgent(res, createGitGeckoNativeAgent, modelComplete);

      // Suppress stderr noise in --agent and --json modes (clean pipe output).
      if (!args.agent && !args.json) {
        if (res.family === "native" && res.binary) {
          console.error(`[${productIdentity.shortName}] ${res.binary} CLI — using its existing login`);
        } else if (modelComplete) {
          console.error(`[${productIdentity.shortName}] pathway: ${res.family} (configured model route)`);
        } else {
          console.error(`[${productIdentity.shortName}] pathway: ${res.family} — no model route configured (set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GITGECKO_LOCAL_BASE_URL; or install codex, claude, or opencode)`);
        }
      }

      return agent;
    },
  }).finally(() => progress?.stop());

  if (args.json) {
    console.log(JSON.stringify(toPublicCliResult(result)));
  } else {
    console.log(result.output);
  }
  if (reviewExitCode(args.command, result.success, result.artifact.mergeable) !== 0) process.exit(1);
}

/** Join an authenticated cloud review to the current GitHub project when one exists. */
function readWorkingTreeGitHubUrl(cwd: string = process.cwd()): string | undefined {
  try {
    const remote = execFileSync("git", ["config", "--get", "remote.origin.url"], { cwd, encoding: "utf8" }).trim();
    return normalizeGitHubRepository(remote)?.url;
  } catch {
    return undefined;
  }
}

main().catch((err: Error) => {
  emitFailure(process.argv.includes("--json"), `${CLI}: ${err.message}`, "cli");
  process.exit(1);
});
