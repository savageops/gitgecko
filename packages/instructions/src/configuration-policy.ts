import { ruleAppliesToPath } from "@gitgecko/rules";
import { z } from "zod";

export type ConfiguredInstructionRule =
  | {
      readonly id: string;
      readonly enabled: true;
      readonly instruction: string;
      readonly files?: readonly string[];
    }
  | {
      readonly id: string;
      readonly enabled: false;
    };

export interface InstructionPolicyLayer {
  readonly revision: string;
  readonly rules: readonly ConfiguredInstructionRule[];
}

export interface RepositoryInstructionPolicy extends InstructionPolicyLayer {
  readonly inheritOrganization: boolean;
}

export interface InstructionPolicyInput {
  readonly organization?: InstructionPolicyLayer;
  readonly repository?: RepositoryInstructionPolicy;
}

export interface ResolvedConfiguredInstructionRule {
  readonly id: string;
  readonly instruction: string;
  readonly source: "organization" | "repository";
  readonly revision: string;
  readonly files?: readonly string[];
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,127}$/;

export const configuredInstructionRuleSchema = z.discriminatedUnion("enabled", [
  z.object({
    id: z.string().regex(ID_PATTERN),
    enabled: z.literal(true),
    instruction: z.string().trim().min(1).max(8_000),
    files: z.array(z.string().trim().min(1).max(512)).max(100).optional(),
  }).strict(),
  z.object({
    id: z.string().regex(ID_PATTERN),
    enabled: z.literal(false),
  }).strict(),
]);

export const instructionPolicyLayerSchema = z.object({
  revision: z.string().trim().min(1).max(160),
  rules: z.array(configuredInstructionRuleSchema).max(500),
}).strict();

export const repositoryInstructionPolicySchema = instructionPolicyLayerSchema.extend({
  inheritOrganization: z.boolean(),
}).strict();

/** Reject ambiguous policy documents before precedence can hide an authoring defect. */
const validateLayer = (name: string, layer: InstructionPolicyLayer): void => {
  if (!layer.revision.trim()) throw new Error(`${name} policy revision is required`);
  for (const rule of layer.rules) {
    if (!ID_PATTERN.test(rule.id)) throw new Error(`${name} policy rule id is invalid: ${rule.id}`);
    if (rule.enabled && !rule.instruction.trim()) throw new Error(`${name} policy rule instruction is required: ${rule.id}`);
    if (rule.enabled && rule.files?.some((path) => !path.trim())) throw new Error(`${name} policy rule contains an empty file pattern: ${rule.id}`);
  }
  const parsed = name === "repository"
    ? repositoryInstructionPolicySchema.parse(layer)
    : instructionPolicyLayerSchema.parse(layer);
  const ids = new Set<string>();
  for (const rule of parsed.rules) {
    if (ids.has(rule.id)) throw new Error(`${name} policy contains duplicate rule id: ${rule.id}`);
    ids.add(rule.id);
  }
};

const appliesToChangedPath = (
  rule: Extract<ConfiguredInstructionRule, { readonly enabled: true }>,
  changedPaths: readonly string[],
): boolean => !rule.files?.length
  || changedPaths.length === 0
  || changedPaths.some((path) => ruleAppliesToPath(rule.files ? { files: rule.files } : {}, path));

/** Resolve opt-in organization defaults with repository overrides and tombstones. */
export const resolveInstructionPolicy = (
  input: InstructionPolicyInput,
  changedPaths: readonly string[] = [],
): readonly ResolvedConfiguredInstructionRule[] => {
  if (input.organization) validateLayer("organization", input.organization);
  if (input.repository) validateLayer("repository", input.repository);

  const merged = new Map<string, ResolvedConfiguredInstructionRule>();
  if (input.organization && (!input.repository || input.repository.inheritOrganization)) {
    for (const rule of input.organization.rules) {
      if (rule.enabled && appliesToChangedPath(rule, changedPaths)) {
        merged.set(rule.id, {
          id: rule.id,
          instruction: rule.instruction,
          source: "organization",
          revision: input.organization.revision,
          ...(rule.files && { files: rule.files }),
        });
      }
    }
  }

  if (input.repository) {
    for (const rule of input.repository.rules) {
      if (!rule.enabled) {
        merged.delete(rule.id);
      } else if (appliesToChangedPath(rule, changedPaths)) {
        merged.set(rule.id, {
          id: rule.id,
          instruction: rule.instruction,
          source: "repository",
          revision: input.repository.revision,
          ...(rule.files && { files: rule.files }),
        });
      } else {
        merged.delete(rule.id);
      }
    }
  }

  return [...merged.values()];
};

/** Render provenance into the model-facing rule without exposing storage details. */
export const renderInstructionPolicy = (
  rules: readonly ResolvedConfiguredInstructionRule[],
): readonly string[] => rules.map((rule) => `[configured:${rule.id}; source=${rule.source}] ${rule.instruction}`);
