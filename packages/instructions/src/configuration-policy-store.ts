import type {
  ConfiguredInstructionRule,
  InstructionPolicyInput,
  InstructionPolicyLayer,
  RepositoryInstructionPolicy,
} from "./configuration-policy.js";
import { resolveInstructionPolicy } from "./configuration-policy.js";
import { configuredInstructionRuleSchema } from "./configuration-policy.js";
import { z } from "zod";

export const INSTRUCTION_POLICY_CURRENT_NAMESPACE = "instruction-policy-current";
export const INSTRUCTION_POLICY_REVISION_NAMESPACE = "instruction-policy-revisions";

export type InstructionPolicyScope = "organization" | "repository";

export interface InstructionPolicyDocument {
  readonly schemaVersion: "instruction-policy.v1";
  readonly tenantId: string;
  readonly scope: InstructionPolicyScope;
  readonly projectId?: string;
  readonly revision: number;
  readonly rules: readonly ConfiguredInstructionRule[];
  readonly inheritOrganization?: boolean;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly restoredFromRevision?: number;
}

export interface InstructionPolicyDocumentStore {
  get<T>(namespace: string, key: string): T | undefined;
  list<T>(namespace: string): readonly T[];
  set<T>(namespace: string, key: string, value: T): void;
  transaction<T>(operation: () => T): T;
}

export interface PutInstructionPolicyInput {
  readonly tenantId: string;
  readonly scope: InstructionPolicyScope;
  readonly projectId?: string;
  readonly rules: readonly ConfiguredInstructionRule[];
  readonly inheritOrganization?: boolean;
  readonly expectedRevision: number;
  readonly actorId: string;
}

export interface RollbackInstructionPolicyInput {
  readonly tenantId: string;
  readonly scope: InstructionPolicyScope;
  readonly projectId?: string;
  readonly targetRevision: number;
  readonly expectedRevision: number;
  readonly actorId: string;
}

export class InstructionPolicyConflict extends Error {
  readonly code = "instruction_policy_revision_conflict";

  constructor(
    readonly expectedRevision: number,
    readonly currentRevision: number,
  ) {
    super(`instruction policy revision conflict: expected ${expectedRevision}, current ${currentRevision}`);
    this.name = "InstructionPolicyConflict";
  }
}

const requiredId = (label: string, value: string): string => {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > 160) throw new Error(`${label} is too long`);
  return normalized;
};

const tenantNamespace = (base: string, tenantId: string): string => `${base}:v1:${encodeURIComponent(requiredId("tenant id", tenantId))}`;

const scopeKey = (scope: InstructionPolicyScope, projectId?: string): string => {
  if (scope === "organization") {
    if (projectId !== undefined) throw new Error("organization policy cannot include a project id");
    return "organization";
  }
  return `repository:${encodeURIComponent(requiredId("project id", projectId ?? ""))}`;
};

const revisionKey = (key: string, revision: number): string => `${key}:${String(revision).padStart(12, "0")}`;

const assertRevision = (label: string, revision: number, minimum = 0): void => {
  if (!Number.isSafeInteger(revision) || revision < minimum) throw new Error(`${label} must be a safe integer >= ${minimum}`);
};

const policyDocumentBaseSchema = z.object({
  schemaVersion: z.literal("instruction-policy.v1"),
  tenantId: z.string().trim().min(1).max(160),
  revision: z.number().int().safe().min(1),
  rules: z.array(configuredInstructionRuleSchema).max(500),
  createdAt: z.iso.datetime(),
  createdBy: z.string().trim().min(1).max(160),
  restoredFromRevision: z.number().int().safe().min(1).optional(),
});

const instructionPolicyDocumentSchema = z.discriminatedUnion("scope", [
  policyDocumentBaseSchema.extend({ scope: z.literal("organization") }).strict(),
  policyDocumentBaseSchema.extend({
    scope: z.literal("repository"),
    projectId: z.string().trim().min(1).max(160),
    inheritOrganization: z.boolean(),
  }).strict(),
]);

const normalizeRules = (rules: readonly z.infer<typeof configuredInstructionRuleSchema>[]): readonly ConfiguredInstructionRule[] => rules.map((rule) => rule.enabled
  ? { id: rule.id, enabled: true, instruction: rule.instruction, ...(rule.files ? { files: rule.files } : {}) }
  : { id: rule.id, enabled: false });

/** Validate persisted policy before it becomes review authority. */
export const validateInstructionPolicyDocument = (value: unknown): InstructionPolicyDocument => {
  if (!value || typeof value !== "object") throw new Error("instruction policy document must be an object");
  const candidate = value as Partial<InstructionPolicyDocument>;
  if (candidate.schemaVersion !== "instruction-policy.v1") throw new Error("unsupported instruction policy schema");
  requiredId("tenant id", candidate.tenantId ?? "");
  if (candidate.scope !== "organization" && candidate.scope !== "repository") throw new Error("instruction policy scope is invalid");
  assertRevision("policy revision", candidate.revision ?? -1, 1);
  if (!Array.isArray(candidate.rules)) throw new Error("instruction policy rules must be an array");
  if (candidate.scope === "repository" && !candidate.projectId?.trim()) throw new Error("project id is required");
  if (candidate.scope === "repository" && typeof candidate.inheritOrganization !== "boolean") throw new Error("repository policy inheritance flag is required");
  if (candidate.scope === "organization" && candidate.projectId !== undefined) throw new Error("organization policy cannot include a project id");
  if (candidate.scope === "organization" && candidate.inheritOrganization !== undefined) throw new Error("organization policy cannot include an inheritance flag");
  if (!candidate.createdAt || !Number.isFinite(Date.parse(candidate.createdAt))) throw new Error("policy creation time is invalid");
  requiredId("policy actor id", candidate.createdBy ?? "");
  if (candidate.restoredFromRevision !== undefined) assertRevision("restored revision", candidate.restoredFromRevision, 1);
  const candidateLayer: InstructionPolicyLayer = {
    revision: String(candidate.revision),
    rules: candidate.rules as readonly ConfiguredInstructionRule[],
  };
  if (candidate.scope === "repository") {
    resolveInstructionPolicy({ repository: { ...candidateLayer, inheritOrganization: candidate.inheritOrganization! } });
  } else {
    resolveInstructionPolicy({ organization: candidateLayer });
  }
  const document = instructionPolicyDocumentSchema.parse(value);
  const rules = normalizeRules(document.rules);
  const layer: InstructionPolicyLayer = { revision: String(document.revision), rules };
  if (document.scope === "repository") {
    resolveInstructionPolicy({ repository: { ...layer, inheritOrganization: document.inheritOrganization } });
  } else {
    resolveInstructionPolicy({ organization: layer });
  }
  return {
    schemaVersion: "instruction-policy.v1",
    tenantId: document.tenantId,
    scope: document.scope,
    ...(document.scope === "repository" ? { projectId: document.projectId } : {}),
    revision: document.revision,
    rules,
    ...(document.scope === "repository" ? { inheritOrganization: document.inheritOrganization } : {}),
    createdAt: document.createdAt,
    createdBy: document.createdBy,
    ...(document.restoredFromRevision !== undefined ? { restoredFromRevision: document.restoredFromRevision } : {}),
  };
};

/** Own durable, tenant-scoped policy revisions without owning HTTP authorization. */
export class InstructionPolicyStore {
  constructor(
    private readonly documents: InstructionPolicyDocumentStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get(tenantId: string, scope: InstructionPolicyScope, projectId?: string): InstructionPolicyDocument | undefined {
    const value = this.documents.get<unknown>(tenantNamespace(INSTRUCTION_POLICY_CURRENT_NAMESPACE, tenantId), scopeKey(scope, projectId));
    return value === undefined ? undefined : validateInstructionPolicyDocument(value);
  }

  history(tenantId: string, scope: InstructionPolicyScope, projectId?: string): readonly InstructionPolicyDocument[] {
    const key = scopeKey(scope, projectId);
    return this.documents.list<unknown>(tenantNamespace(INSTRUCTION_POLICY_REVISION_NAMESPACE, tenantId))
      .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object")
      .filter((value) => {
        if (value.tenantId !== tenantId.trim() || value.scope !== scope) return false;
        return scope === "organization" ? value.projectId === undefined : value.projectId === projectId?.trim();
      })
      .map(validateInstructionPolicyDocument)
      .filter((document) => scopeKey(document.scope, document.projectId) === key)
      .sort((left, right) => right.revision - left.revision);
  }

  put(input: PutInstructionPolicyInput): InstructionPolicyDocument {
    assertRevision("expected revision", input.expectedRevision);
    const key = scopeKey(input.scope, input.projectId);
    const currentNamespace = tenantNamespace(INSTRUCTION_POLICY_CURRENT_NAMESPACE, input.tenantId);
    const revisionNamespace = tenantNamespace(INSTRUCTION_POLICY_REVISION_NAMESPACE, input.tenantId);
    const actorId = requiredId("policy actor id", input.actorId);
    return this.documents.transaction(() => {
      const currentValue = this.documents.get<unknown>(currentNamespace, key);
      const current = currentValue === undefined ? undefined : validateInstructionPolicyDocument(currentValue);
      const actualRevision = current?.revision ?? 0;
      if (actualRevision !== input.expectedRevision) {
        throw new InstructionPolicyConflict(input.expectedRevision, actualRevision);
      }
      const revision = actualRevision + 1;
      const document = validateInstructionPolicyDocument({
        schemaVersion: "instruction-policy.v1",
        tenantId: input.tenantId,
        scope: input.scope,
        ...(input.scope === "repository" ? { projectId: input.projectId, inheritOrganization: input.inheritOrganization } : {}),
        revision,
        rules: input.rules,
        createdAt: this.now().toISOString(),
        createdBy: actorId,
      });
      this.documents.set(revisionNamespace, revisionKey(key, revision), document);
      this.documents.set(currentNamespace, key, document);
      return document;
    });
  }

  rollback(input: RollbackInstructionPolicyInput): InstructionPolicyDocument {
    assertRevision("target revision", input.targetRevision, 1);
    assertRevision("expected revision", input.expectedRevision);
    const key = scopeKey(input.scope, input.projectId);
    const currentNamespace = tenantNamespace(INSTRUCTION_POLICY_CURRENT_NAMESPACE, input.tenantId);
    const revisionNamespace = tenantNamespace(INSTRUCTION_POLICY_REVISION_NAMESPACE, input.tenantId);
    const actorId = requiredId("policy actor id", input.actorId);
    return this.documents.transaction(() => {
      const currentValue = this.documents.get<unknown>(currentNamespace, key);
      const current = currentValue === undefined ? undefined : validateInstructionPolicyDocument(currentValue);
      const actualRevision = current?.revision ?? 0;
      if (actualRevision !== input.expectedRevision) {
        throw new InstructionPolicyConflict(input.expectedRevision, actualRevision);
      }
      const target = this.history(input.tenantId, input.scope, input.projectId)
        .find((document) => document.revision === input.targetRevision);
      if (!target) throw new Error("instruction policy rollback target was not found");
      const document = validateInstructionPolicyDocument({
        schemaVersion: "instruction-policy.v1",
        tenantId: input.tenantId,
        scope: input.scope,
        ...(input.scope === "repository" ? { projectId: input.projectId, inheritOrganization: target.inheritOrganization } : {}),
        revision: actualRevision + 1,
        rules: target.rules,
        createdAt: this.now().toISOString(),
        createdBy: actorId,
        restoredFromRevision: target.revision,
      });
      this.documents.set(revisionNamespace, revisionKey(key, document.revision), document);
      this.documents.set(currentNamespace, key, document);
      return document;
    });
  }

  resolve(tenantId: string, projectId?: string): InstructionPolicyInput {
    return this.documents.transaction(() => {
      const organization = this.get(tenantId, "organization");
      const repository = projectId ? this.get(tenantId, "repository", projectId) : undefined;
      return {
        ...(organization ? { organization: { revision: String(organization.revision), rules: organization.rules } } : {}),
        ...(repository ? {
          repository: {
            revision: String(repository.revision),
            rules: repository.rules,
            inheritOrganization: repository.inheritOrganization!,
          } satisfies RepositoryInstructionPolicy,
        } : {}),
      };
    });
  }
}
