/**
 * @gitgecko/instructions/severity — severity→label/emoji mapping.
 *
 * REUSES the existing Severity type from @gitgecko/rules (finding.ts:53) —
 * NO duplicate enum (001a Contract Lock §2, invariant I2). The user requested
 * error/warning/info/tip levels (U7). The enum carries hint|info|tip|warning|
 * error|off; hint and tip are DISTINCT tiers, not aliases:
 *  - hint  = a gentle nudge / non-actionable awareness (context the reader
 *            should know, but no action required).
 *  - tip   = an actionable recommendation (what would be better — apply to improve).
 * They were previously aliased to one shared "tip" label, which collapsed two
 * distinct findings into one rendering group. Resolved: each renders distinctly.
 */
import type { Severity } from "@gitgecko/rules";

/**
 * Map an internal Severity to the user-facing label.
 * hint → "hint" (awareness; non-actionable context).
 * tip  → "tip"  (an actionable recommendation; what would be better).
 * off  → ""     (suppressed — no label).
 */
export const severityLabel = (sev: Severity): string => {
  switch (sev) {
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "info":
      return "info";
    case "hint":
      return "hint";
    case "tip":
      return "tip";
    case "off":
      return "";
  }
};

/** A visual emoji per severity (for markdown section headers). "" for off. */
export const severityEmoji = (sev: Severity): string => {
  switch (sev) {
    case "error":
      return "🔴";
    case "warning":
      return "🟡";
    case "info":
      return "ℹ️";
    case "hint":
      // hint = awareness/context — a muted blue, distinct from the actionable tip 💡.
      return "🔷";
    case "tip":
      // tip = an actionable recommendation (what would be better).
      return "💡";
    case "off":
      return "";
  }
};

/** Severities in display order (highest impact first). off excluded. */
export const SEVERITY_ORDER: readonly Severity[] = ["error", "warning", "info", "hint", "tip"];
