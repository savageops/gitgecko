/**
 * @gitgecko/code-intel — the code-intelligence owner.
 *
 * Implements the `code-intel` owner (02-architecture-overview §2) and its
 * ParserSocket. Engine plugs (tree-sitter-parse, graph-build, ...) live under
 * plugs/code-intel/ and register against this owner via the socket runtime
 * (packages/socket). This package is the owner + types; the engines are plugs.
 */
export * from "./tags.js";
export * from "./owner.js";
export * from "./graph-schema.js";
export * from "./graph-build.js";
export * from "./chunk.js";
export * from "./embed.js";
export * from "./retrieve.js";
export * from "./search-lexical.js";
export * from "./summarize.js";
export * from "./graph-temporal.js";
export * from "./repository-context.js";
