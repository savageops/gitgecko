/**
 * @gitgecko/core — framework-agnostic shared types for gitgecko.
 *
 * This package is the cross-owner type vocabulary (Continue core-boundary
 * pattern, research manifest P-frontend-12). It has ZERO framework deps —
 * only zod (which the whole monorepo uses, P-frontend-1). The socket
 * runtime (packages/socket), all three apps, and every plug consume this
 * via workspace `file:` deps.
 *
 * Import paths:
 *   @gitgecko/core         — Result, GitGeckoError, common types (this file)
 *   @gitgecko/core/ids     — branded IDs + OwnerName
 *   @gitgecko/core/result  — Result<T,E> + ok/err/tryAsync
 */

export * from "./result.js";
export * from "./ids.js";
export * from "./store-types.js";
export * from "./persistence.js";
export * from "./sqlite-migrations.js";
export * from "./product-identity.js";
export * from "./deployment.js";
export * from "./github-repository.js";
export * from "./project-activity.js";
