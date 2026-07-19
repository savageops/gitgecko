/**
 * @gitgecko/cli — the installed `gitgecko review` entry point (§1.1, A13).
 *
 * Ties all 7 owners into a runnable command. Zero-config: detects the
 * developer's installed agent (claude/codex/opencode) and uses their login.
 */
export * from "./orchestrator.js";
export * from "./threads.js";
export { runDoctor, renderDoctor, GITGECKO_VERSION, type DoctorReport, type NativeProbe } from "./doctor.js";
export { login, logoutCommand as logout, whoami, loadAuth, type AuthState, type WhoamiConfig } from "./auth.js";
export { loadAvailableModels, renderModels } from "./models.js";
export { createFileConfigStore, getConfigFilePath, renderModelProviderConfig, resolveModelProvider, type CliConfig, type ModelProviderConfig } from "./config.js";
// detectNativeAgents is in the barrel (pure); createRealBinaryProbe is server-only subpath.
export { detectNativeAgents } from "@gitgecko/review";
export { createRealBinaryProbe } from "@gitgecko/review/native-agents";
export { createGitGeckoNativeAgent } from "@gitgecko/plug-agent-gitgecko-native";
export { createAutoComplete } from "@gitgecko/model-client";
export { resolveInstructions } from "@gitgecko/instructions";
