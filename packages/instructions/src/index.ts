/**
 * @gitgecko/instructions — public surface.
 *
 * The instructions/rules/guardrails system. Encodes proprietary architecture
 * expertise into review instructions consumed by all agent backends. Conforms
 * to .docs/todo/system-design/07 (wedges) + 09 (benchmark) + the 001a Contract Lock.
 */
export { REVIEWER_PERSONA } from "./persona.js";
export { severityLabel, severityEmoji, SEVERITY_ORDER } from "./severity.js";
export {
  PROPRIETARY_RULES,
  ruleById,
  type ProprietaryRule,
  type BlastTier,
} from "./rules-corpus.js";
export {
  resolveCorpus,
  extractKeywords,
  reviewQualityBand,
  type Keywords,
} from "./corpus.js";
export { GUARDRAILS, GUARDRAILS_BLOCK } from "./guardrails.js";
export {
  outputFormatFor,
  reviewOutputFormat,
  describeOutputFormat,
  improveOutputFormat,
  askOutputFormat,
  resolveOutputFormat,
  renderFindings,
  renderRepoContext,
  type ReviewCommand,
} from "./output-format.js";
export { resolveInstructions, type ResolveArgs } from "./resolve.js";
export { extractDiffQueries } from "./diff-query.js";
export { commandTask, type CommandTask } from "./command-tasks.js";
export { discoverRepositoryRules, renderRepositoryRules, type RepositoryRule, type RepositoryRules } from "./repository-rules.js";
export {
  resolveInstructionPolicy,
  renderInstructionPolicy,
  configuredInstructionRuleSchema,
  instructionPolicyLayerSchema,
  repositoryInstructionPolicySchema,
  type ConfiguredInstructionRule,
  type InstructionPolicyLayer,
  type RepositoryInstructionPolicy,
  type InstructionPolicyInput,
  type ResolvedConfiguredInstructionRule,
} from "./configuration-policy.js";
export {
  InstructionPolicyStore,
  InstructionPolicyConflict,
  validateInstructionPolicyDocument,
  INSTRUCTION_POLICY_CURRENT_NAMESPACE,
  INSTRUCTION_POLICY_REVISION_NAMESPACE,
  type InstructionPolicyDocument,
  type InstructionPolicyDocumentStore,
  type InstructionPolicyScope,
  type PutInstructionPolicyInput,
  type RollbackInstructionPolicyInput,
} from "./configuration-policy-store.js";
export {
  CITATION_GLOSSARY,
  glossaryFor,
  glossaryTerm,
  hasGlossaryEntry,
  type GlossaryEntry,
} from "./glossary.js";
