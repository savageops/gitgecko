import type { Contribution, OwnerSpec } from "@gitgecko/socket";

export type ReviewWorkState =
  | "queued"
  | "leased"
  | "retry_wait"
  | "completed"
  | "dead-letter";

export interface ReviewWorkPayload {
  readonly tenantId: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly deliveryId: string;
  readonly installationId: string;
  readonly repositoryId: string;
  readonly pullNumber: number;
}

export interface IndexWorkPayload {
  readonly tenantId: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly deliveryId: string;
  readonly installationId: string;
  readonly repositoryId: string;
  readonly ref: string;
  readonly commitSha: string;
}

export interface ReviewWorkItem {
  readonly kind: "review";
  readonly workId: string;
  readonly idempotencyKey: string;
  readonly payload: ReviewWorkPayload;
  readonly state: ReviewWorkState;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly availableAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: string;
  readonly completedAt?: string;
  readonly deadLetteredAt?: string;
  readonly lastError?: string;
}

export interface IndexWorkItem extends Omit<ReviewWorkItem, "kind" | "payload"> {
  readonly kind: "index";
  readonly payload: IndexWorkPayload;
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
};

export interface EnqueueReviewInput {
  readonly idempotencyKey: string;
  readonly payload: ReviewWorkPayload;
  readonly now?: Date;
}

export interface EnqueueReviewResult {
  readonly item: ReviewWorkItem;
  readonly created: boolean;
}

export interface EnqueueIndexInput {
  readonly idempotencyKey: string;
  readonly payload: IndexWorkPayload;
  readonly now?: Date;
}

export interface EnqueueIndexResult {
  readonly item: IndexWorkItem;
  readonly created: boolean;
}

export interface LeaseReviewInput {
  readonly workerId: string;
  readonly leaseDurationMs: number;
  readonly now?: Date;
}

export interface CompleteReviewInput {
  readonly workId: string;
  readonly workerId: string;
  readonly now?: Date;
}

export interface RetryReviewInput {
  readonly workId: string;
  readonly workerId: string;
  readonly error: string;
  /** Terminalize without another provider attempt when execution outcome is ambiguous. */
  readonly terminal?: boolean;
  readonly now?: Date;
}

export type RenewReviewInput = RenewIndexInput;

export interface RetryReviewResult {
  readonly item: ReviewWorkItem;
  readonly deadLettered: boolean;
  readonly retryAt?: string;
}

export type LeaseIndexInput = LeaseReviewInput;
export interface RenewIndexInput {
  readonly workId: string;
  readonly workerId: string;
  readonly leaseDurationMs: number;
  readonly now?: Date;
}
export type CompleteIndexInput = CompleteReviewInput;
export type RetryIndexInput = RetryReviewInput;

export interface RetryIndexResult {
  readonly item: IndexWorkItem;
  readonly deadLettered: boolean;
  readonly retryAt?: string;
}

export interface RecoverStaleLeasesInput {
  readonly now?: Date;
}

export interface RedriveWorkInput {
  readonly workId: string;
  readonly now?: Date;
}

export type JobDispatchErrorCode =
  | "invalid_input"
  | "not_found"
  | "idempotency_conflict"
  | "lease_conflict"
  | "invalid_transition";

export class JobDispatchError extends Error {
  readonly code: JobDispatchErrorCode;

  constructor(code: JobDispatchErrorCode, message: string) {
    super(message);
    this.name = "JobDispatchError";
    this.code = code;
  }
}

export type JobDispatchCapability = "review" | "index";
export type JobDispatchContributionKind = "review-work";

export interface JobDispatchContribution extends Contribution {
  readonly kind: "review-work";
  readonly id: string;
  readonly mutates: true;
  enqueueReview(input: EnqueueReviewInput): EnqueueReviewResult;
  leaseReview(input: LeaseReviewInput): ReviewWorkItem | undefined;
  renewReview(input: RenewReviewInput): ReviewWorkItem;
  completeReview(input: CompleteReviewInput): ReviewWorkItem;
  retryReview(input: RetryReviewInput): RetryReviewResult;
  recoverStaleLeases(
    input?: RecoverStaleLeasesInput,
  ): readonly ReviewWorkItem[];
  getReview(workId: string): ReviewWorkItem | undefined;
  findReviewByIdempotencyKey(idempotencyKey: string): ReviewWorkItem | undefined;
  redriveReview(input: RedriveWorkInput): ReviewWorkItem;
  enqueueIndex(input: EnqueueIndexInput): EnqueueIndexResult;
  leaseIndex(input: LeaseIndexInput): IndexWorkItem | undefined;
  renewIndex(input: RenewIndexInput): IndexWorkItem;
  completeIndex(input: CompleteIndexInput): IndexWorkItem;
  retryIndex(input: RetryIndexInput): RetryIndexResult;
  recoverStaleIndexLeases(
    input?: RecoverStaleLeasesInput,
  ): readonly IndexWorkItem[];
  getIndex(workId: string): IndexWorkItem | undefined;
  redriveIndex(input: RedriveWorkInput): IndexWorkItem;
  /** Releases a dispatcher-owned durable store during controlled shutdown. */
  close?(): void;
}

export const jobDispatchOwner: OwnerSpec<
  JobDispatchCapability,
  JobDispatchContributionKind
> = {
  name: "job-dispatch",
  capabilities: ["review", "index"],
  kindFor: () => "review-work",
};
