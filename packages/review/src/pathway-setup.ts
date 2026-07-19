import { z } from "zod";

export const modelProtocolSchema = z.enum([
  "openai-chat-completions",
  "openai-responses",
  "anthropic-messages",
]);

/** Provider routing metadata shared by CLI and server-side pathway setup. */
export const modelProviderConfigSchema = z.object({
  baseUrl: z.url(),
  model: z.string().trim().min(1),
  protocol: modelProtocolSchema,
  apiKeyEnv: z.string().trim().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
}).strict();

export type ModelProviderConfig = z.infer<typeof modelProviderConfigSchema>;

const ownerSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("account") }).strict(),
  z.object({ scope: z.literal("project"), projectId: z.string().trim().min(1) }).strict(),
]);

const setupBase = z.object({
  id: z.string().trim().regex(/^pathway_[a-z0-9][a-z0-9_-]{5,63}$/),
  enabled: z.boolean(),
  isDefault: z.boolean(),
});

const hostedSetup = setupBase.extend({
  kind: z.literal("hosted"),
  topology: z.enum(["cloud", "local"]),
  owner: ownerSchema,
}).strict();

const nativeSetup = setupBase.extend({
  kind: z.literal("native"),
  topology: z.literal("local"),
  owner: ownerSchema,
  binary: z.enum(["claude", "codex", "opencode"]).optional(),
}).strict();

const localSetup = setupBase.extend({
  kind: z.literal("local"),
  topology: z.enum(["cloud", "local"]),
  owner: ownerSchema,
  provider: modelProviderConfigSchema,
  credential: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }).strict(),
    z.object({ kind: z.literal("environment"), name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/) }).strict(),
    z.object({ kind: z.literal("stored"), configured: z.boolean() }).strict(),
  ]),
}).strict().superRefine((setup, context) => {
  if (setup.topology === "cloud" && setup.credential.kind === "environment") {
    context.addIssue({ code: "custom", path: ["credential"], message: "cloud pathways require a server-stored credential" });
  }
  if (setup.topology === "cloud" && setup.provider.apiKeyEnv) {
    context.addIssue({ code: "custom", path: ["provider", "apiKeyEnv"], message: "cloud pathways cannot read client environment variables" });
  }
});

/** Metadata-only pathway setup; plaintext credentials are deliberately absent. */
export const pathwaySetupSchema = z.discriminatedUnion("kind", [hostedSetup, nativeSetup, localSetup]);
export type PathwaySetup = z.infer<typeof pathwaySetupSchema>;

