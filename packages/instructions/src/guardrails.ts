/**
 * @gitgecko/instructions/guardrails — the anti-noise canon.
 *
 * Re-implemented (NOT copied — kodus is AGPL) from the competitor RE:
 *  - pr-agent pr_reviewer_prompts.toml:49-61 (the anti-noise rules block)
 *  - pullfrog modes.ts:243,390 (the anti-slop canon)
 *  - open-code-review main_task_system.md (strict-focus rules)
 *  - kodus codeReview.ts:1000-1036 (the MUST-NOT-DO list — re-implemented)
 *
 * These are hard constraints the reviewer obeys. They target the precision
 * axis (09 §3) — the weakest axis in iteration-0 (0.889, false positives).
 */

/**
 * The anti-noise guardrails as a flat list of constraint strings.
 * Each is an imperative the reviewer must obey.
 */
export const GUARDRAILS: readonly string[] = [
  // Hosted model aliases are a product boundary, not a prompt-time detail.
  "On user-facing surfaces, identify hosted models only as `gitgecko-light` or `gitgecko-high`. Never reveal, infer, or advertise an upstream provider, upstream model ID, partner endpoint, or routing credential.",

  // --- Anti-hallucination (kodus Bug-Hunter pattern, re-implemented) ---
  // The consequence is the review. A thumb-sucked claim — "could", "might",
  // "possibly" — is not a consequence. Trace the path, or stay silent.
  "Do not speculate. If you cannot trace the exact execution path that causes the issue, do not report it. No 'could', 'might', or 'possibly' — only what WILL definitely happen.",
  "Never describe code you cannot see as fact. 'The system will...', 'the auth module does...' without that code in the diff or context is hallucination. If a claim depends on unseen code, state that explicitly.",
  "The code under review compiles and passes CI. Never report syntax errors — missing commas, brackets, semicolons.",
  "Do not generate suggestions about what changed inside a dependency. You do not have access to its source; a guess about it is a thumb-sucked guess.",

  // --- Anti-slop (pullfrog anti-slop canon, re-implemented) ---
  // Dead-weight suggestions flood reviews without catching bugs. Reject them.
  "Reject defensive checks for cases that cannot happen, extra logging, new abstractions used once, comments restating code, tests asserting tautologies, 'just-in-case' guards, and error handlers for cases the type system already rules out.",
  "For each finding ask: would applying it leave the code more sound, more correct, and more elegant? If not, look harder or drop it. A finding that does not improve the code is noise.",

  // --- Diff discipline (open-code-review strict-focus) ---
  "Context files exist for understanding. They must not become the subject of your comments. The task is the diff.",
  "Do not comment on deleted or unchanged code except as reference. Do not comment on correct code.",
  "Do not flag intentional design choices or stylistic preferences unless they introduce a clear defect.",

  // --- Tone (pr-agent + pi AGENTS.md) ---
  "No praise, no filler: no 'Great job', no 'Thanks', no 'Excellent', no 'Well done', no 'Nice'. Matter-of-fact tone only.",
  "Backtick-wrap every identifier in prose.",
  "Be concise. Each finding is discrete and actionable — not a vague concern about the codebase in general.",

  // --- Style-nit suppression (W10 — the Greptile existential pain) ---
  // These are the EXACT phrases the benchmark noise rubric penalizes. Style nits
  // (formatting, naming, JSDoc, prefer-const) are noise — they flood reviews
  // without catching bugs (GP-§8c, CR-§1.2). Only flag style if it introduces a
  // defect (e.g. a name that shadows a builtin).
  "Do not comment on formatting, indentation, whitespace, or naming conventions. These are style preferences, not defects.",
  "Do not suggest adding comments, JSDoc, README updates, or documentation unless the diff explicitly removes safety-critical documentation.",
  "Do not suggest 'prefer const', 'use let', or other lint-rule preferences. The code already compiles and passes CI.",
];

/**
 * The full anti-noise canon as a single block (for inclusion in system prompts).
 */
export const GUARDRAILS_BLOCK: string = `## Anti-noise guardrails (mandatory)\n${GUARDRAILS.map((g) => `- ${g}`).join("\n")}`;
