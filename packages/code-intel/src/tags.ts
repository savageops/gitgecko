/**
 * @gitgecko/code-intel/tags — the def/ref tag data contract.
 *
 * Mirrors aider's `Tag = namedtuple("Tag", "rel_fname fname line name kind")`
 * (research manifest P-codeintel-1, .refs/02-repo-qa/aider-main/aider/repomap.py:29)
 * but adds byte-precise spans. Downstream consumers (graph-build, chunk, the
 * review agent's "jump to definition") need byte offsets, not just line numbers —
 * line numbers alone are ambiguous within a multi-statement line.
 *
 * `kind` splits into a category (def|ref) + a subtype (function|class|method|
 * call|constant|...) exactly as the SCM capture names encode:
 *   @name.definition.function  → { category: "def", subtype: "function" }
 *   @name.reference.call       → { category: "ref", subtype: "call" }
 * This is the P-codeintel-2 contract, verbatim.
 */

export type TagCategory = "def" | "ref";
export type DefSubtype = "function" | "class" | "method" | "constant" | "module";
export type RefSubtype = "call" | "class";

export interface Tag {
  /** Path relative to repo root (aider's rel_fname). */
  readonly relPath: string;
  /** 1-based line number where the captured name begins (aider's `line`). */
  readonly line: number;
  /** 0-based column where the name begins. */
  readonly column: number;
  /** The captured identifier text (aider's `name`). */
  readonly name: string;
  /** def vs ref (parsed from the SCM capture name). */
  readonly category: TagCategory;
  /** function/class/method/call/... (parsed from the SCM capture name). */
  readonly subtype: string;
  /** Byte offset where the captured NODE begins (not just the name). */
  readonly startByte: number;
  /** Byte offset where the captured NODE ends. */
  readonly endByte: number;
}

/** A parsed file's full output: the path, detected language, and all tags. */
export interface ParsedFile {
  readonly relPath: string;
  readonly language: string;
  readonly tags: readonly Tag[];
}

/**
 * Parse an SCM capture name (e.g. "name.definition.function") into category + subtype.
 * Returns null if the capture isn't a name.* capture we track.
 */
export const parseCaptureName = (
  captureName: string,
): { category: TagCategory; subtype: string } | null => {
  // Format: "name.<category>.<subtype>" — e.g. "name.definition.function"
  const parts = captureName.split(".");
  if (parts[0] !== "name" || parts.length < 3) return null;
  const cat = parts[1];
  const subtype = parts.slice(2).join(".");
  if (cat === "definition") return { category: "def", subtype };
  if (cat === "reference") return { category: "ref", subtype };
  return null;
};
