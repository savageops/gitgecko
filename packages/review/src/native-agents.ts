/**
 * @gitgecko/review/native-agents — the real binary probe (server-only).
 *
 * This module imports Node filesystem APIs — it MUST NOT be imported from the
 * client bundle. Use the explicit subpath import `@gitgecko/review/native-agents`
 * from server-side code only.
 *
 * The pure detection logic (detectNativeAgents, types) lives in
 * native-detection.ts, which IS safe for client imports.
 */
import { accessSync, constants } from "node:fs";
import { delimiter, extname, join } from "node:path";
import type { BinaryProbe } from "./native-detection.js";

// Re-export the pure types + logic so server callers get everything from one import.
export { detectNativeAgents, NATIVE_AGENT_PREFERENCE, binaryToAgentId } from "./native-detection.js";
export type { NativeAgentId, NativeAgentDetection, BinaryProbe } from "./native-detection.js";

/**
 * Resolve installation from PATH without starting the third-party CLI.
 * Authentication and executable health belong to the explicit pathway test.
 */
export const binaryExistsOnPath = (
  binary: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean => {
  const pathValue = environment.PATH ?? environment.Path ?? "";
  const extensions = platform === "win32" && extname(binary) === ""
    ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];

  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      try {
        accessSync(join(directory, `${binary}${extension}`), constants.X_OK);
        return true;
      } catch {
        // Continue through the bounded PATH candidate set.
      }
    }
  }

  return false;
};

/** Create the production installation probe with an immutable environment view. */
export const createRealBinaryProbe = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): BinaryProbe => {
  const environmentSnapshot = { ...environment };
  return (binary) => binaryExistsOnPath(binary, environmentSnapshot, platform);
};
