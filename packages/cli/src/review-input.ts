/** Require a meaningful review payload before selecting or charging a review pathway. */
export function requireReviewInput(command: string, diff: string | undefined): string | undefined {
  if (!["review", "describe", "improve", "ask"].includes(command)) return diff;
  if (diff?.trim()) return diff;
  throw new Error("No tracked changes found. Pass --file for new files, or provide --diff or --diff-file.");
}

/** Separate execution success from the review policy enforced by CI callers. */
export function reviewExitCode(command: string, success: boolean, mergeable: boolean): number {
  if (!success) return 1;
  return command === "review" && !mergeable ? 1 : 0;
}
