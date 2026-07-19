/**
 * @gitgecko/socket — the gitgecko plugin-socket runtime.
 *
 * Implements .docs/todo/system-design/03-plugin-socket-contract.md.
 * Every owner instantiates a Registry<OwnerSpec>; every plug is a PlugModule
 * that fits one owner's socket. The plug always fits no matter what it is
 * (goal §5, A6/A7/A8) because the contract is uniform: manifest + setup(api,ctx).
 *
 * Import paths:
 *   @gitgecko/socket           — public API (this file)
 *   @gitgecko/socket/manifest  — PlugManifest schema + parseManifest
 *   @gitgecko/socket/registry  — Registry, OwnerSpec, lifecycle types
 */
export * from "./manifest.js";
export * from "./registry.js";
