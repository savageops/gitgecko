import { z } from "zod";

export const PROJECT_ACTIVITY_NAMESPACE = "project-activity";

const projectActivityBaseSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  ownerId: z.string().min(1),
  projectId: z.string().min(1),
  occurredAt: z.string().datetime(),
});

export const reviewProjectActivitySchema = projectActivityBaseSchema.extend({
  kind: z.literal("review"),
  runId: z.string().min(1),
  commitSha: z.string().min(1).optional(),
  title: z.string(),
  errorCount: z.number().int().nonnegative(),
  warningCount: z.number().int().nonnegative(),
  infoCount: z.number().int().nonnegative(),
  mergeable: z.boolean(),
  blastRadius: z.enum(["low", "medium", "high"]),
  findings: z.array(z.object({
    severity: z.string(),
    message: z.string(),
    ruleId: z.string().optional(),
  })),
});

export const pushProjectActivitySchema = projectActivityBaseSchema.extend({
  kind: z.literal("push"),
  deliveryId: z.string().min(1),
  commitSha: z.string().min(1),
  ref: z.string().min(1),
  filesIndexed: z.number().int().nonnegative(),
});

/** One tenant-owned timeline entry produced only by a completed owner path. */
export const projectActivitySchema = z.discriminatedUnion("kind", [
  reviewProjectActivitySchema,
  pushProjectActivitySchema,
]);

export type ReviewProjectActivity = z.infer<typeof reviewProjectActivitySchema>;
export type PushProjectActivity = z.infer<typeof pushProjectActivitySchema>;
export type ProjectActivity = z.infer<typeof projectActivitySchema>;

/** Keep webhook replay identity stable across worker restarts. */
export const pushProjectActivityId = (deliveryId: string): string => `push:${deliveryId}`;

/** Key one timeline entry by canonical account authority and replay identity. */
export const projectActivityRecordKey = (tenantId: string, activityId: string): string =>
  `${encodeURIComponent(tenantId)}:${encodeURIComponent(activityId)}`;
