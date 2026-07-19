/**
 * Browser-safe instruction policy surface.
 *
 * Repository rule discovery is intentionally server-only because it reads the
 * reviewed checkout. Keep policy schemas and validation available to settings
 * routes without importing the filesystem-backed root entrypoint.
 */
export {
  configuredInstructionRuleSchema,
  instructionPolicyLayerSchema,
  repositoryInstructionPolicySchema,
  resolveInstructionPolicy,
  renderInstructionPolicy,
  type ConfiguredInstructionRule,
  type InstructionPolicyLayer,
  type RepositoryInstructionPolicy,
  type InstructionPolicyInput,
  type ResolvedConfiguredInstructionRule,
} from "./configuration-policy.js";

export {
  validateInstructionPolicyDocument,
  type InstructionPolicyDocument,
  type InstructionPolicyDocumentStore,
  type InstructionPolicyScope,
  type PutInstructionPolicyInput,
  type RollbackInstructionPolicyInput,
} from "./configuration-policy-store.js";
