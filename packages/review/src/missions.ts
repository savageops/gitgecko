/** Typed customer-selected focus areas for one bounded review without a provider-specific prompt lane. */
export const REVIEW_MISSIONS = {
  correctness: { id: "correctness", focus: "data flow, state transitions, invariants, and behavior changes" },
  security: { id: "security", focus: "trust boundaries, authorization, input handling, secret exposure, and abuse paths" },
  reliability: { id: "reliability", focus: "failure paths, retries, recovery, idempotency, and degraded behavior" },
  performance: { id: "performance", focus: "asymptotic cost, avoidable I/O, hot paths, memory growth, and resource limits" },
  testability: { id: "testability", focus: "verification gaps, deterministic seams, regression coverage, and observable behavior" },
} as const;

export type ReviewMissionId = keyof typeof REVIEW_MISSIONS;
export type ReviewMission = (typeof REVIEW_MISSIONS)[ReviewMissionId];

/** Resolve only an exact declared mission; unknown semantics are never invented. */
export const resolveReviewMission = (value: string | undefined): ReviewMission | undefined =>
  value && Object.hasOwn(REVIEW_MISSIONS, value) ? REVIEW_MISSIONS[value as ReviewMissionId] : undefined;

/** Render one provider-neutral scope section that every review backend receives through the shared prompt. */
export const renderReviewMission = (mission: ReviewMission | undefined): string => mission
  ? `\n\n## Review mission: ${mission.id}\nFocus on ${mission.focus}; deterministic findings remain authoritative. Do not report concerns outside this mission unless they are directly evidenced and merge-blocking.`
  : "";
