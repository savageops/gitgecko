import type { ModelGenerate, ModelStream } from "./model-client.js";

/** Model capabilities recognized by the canonical model socket. */
export type ModelCapability = "complete" | "stream";

/** Contribution kinds produced by model plugs. */
export type ModelContributionKind = "completion-handler" | "stream-handler";

/** Typed contribution contract shared by runtime and independently shipped plugs. */
export interface ModelContribution {
  readonly kind: ModelContributionKind;
  readonly id: string;
  readonly run?: (input: unknown) => Promise<unknown>;
  readonly generate?: ModelGenerate;
  readonly stream?: ModelStream;
  readonly mutates?: boolean;
}

/** Capability catalog shared by the orchestrator and proving tests. */
export const MODEL_CAPABILITIES = ["complete", "stream"] as const satisfies readonly ModelCapability[];

/** Canonical model owner spec, structurally compatible with the socket Registry. */
export const modelOwner = {
  name: "model",
  capabilities: MODEL_CAPABILITIES,
  kindFor: (capability: ModelCapability): ModelContributionKind =>
    capability === "stream" ? "stream-handler" : "completion-handler",
} as const;
