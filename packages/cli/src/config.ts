import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { productIdentity } from "@gitgecko/core";
import { z } from "zod";
import {
  modelProviderConfigSchema,
  type LocalEndpointConfig,
  type ModelProviderConfig,
} from "@gitgecko/review";

const reviewCheckSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  label: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).max(64).optional(),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
  required: z.boolean().optional(),
}).strict();

/** Local-only routing may carry a user-owned key; hosted pathway records remain metadata-only. */
const cliModelProviderConfigSchema = modelProviderConfigSchema.extend({
  apiKey: z.string().trim().min(1).max(4_096).optional(),
}).superRefine((provider, context) => {
  if (provider.apiKey && provider.apiKeyEnv) {
    context.addIssue({ code: "custom", path: ["apiKey"], message: "Configure either apiKey or apiKeyEnv, not both." });
  }
});

const cliConfigSchema = z.object({
  version: z.literal(1),
  modelProvider: cliModelProviderConfigSchema.optional(),
  /** User-owned, opt-in checks. The reviewed cwd is assigned by the CLI, never config. */
  reviewChecks: z.array(reviewCheckSchema).max(8).optional(),
}).strict();

export type { ModelProviderConfig };
export type CliConfig = z.infer<typeof cliConfigSchema>;

export interface ConfigStore {
  readonly read: () => CliConfig;
  readonly write: (config: CliConfig) => void;
  readonly remove: () => void;
}

export const getConfigFilePath = (): string => join(homedir(), productIdentity.authDirectory, "config.json");

/** Persist user-owned local routing under the account-private config directory. */
export const createFileConfigStore = (path: string = getConfigFilePath()): ConfigStore => ({
  read: () => {
    if (!existsSync(path)) return { version: 1 };
    return cliConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  },
  write: (config) => {
    const parsed = cliConfigSchema.parse(config);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  },
  remove: () => { if (existsSync(path)) rmSync(path); },
});

/** Resolve an inline local key or a named environment reference for a local-only provider. */
export const resolveModelProvider = (
  config: CliConfig,
  env: NodeJS.ProcessEnv = process.env,
): (ModelProviderConfig & { readonly apiKey?: string }) | undefined => {
  const provider = config.modelProvider;
  if (!provider) return undefined;
  const { apiKey: storedApiKey, ...metadata } = provider;
  const apiKey = storedApiKey ?? (provider.apiKeyEnv ? env[provider.apiKeyEnv]?.trim() : undefined);
  return { ...metadata, ...(apiKey ? { apiKey } : {}) };
};

/** Adapt saved routing metadata without inventing a second protocol vocabulary. */
export const toLocalEndpointConfig = (provider: ModelProviderConfig & { readonly apiKey?: string }): LocalEndpointConfig => ({
  baseUrl: provider.baseUrl,
  modelId: provider.model,
  protocol: provider.protocol,
  ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
});

export const renderModelProviderConfig = (config: CliConfig): string => {
  const provider = config.modelProvider;
  if (!provider) return "No saved model provider. Run `gitgecko models configure --base-url <url> --model <id>`.";
  return [
    `Base URL: ${provider.baseUrl}`,
    `Model: ${provider.model}`,
    `Protocol: ${provider.protocol}`,
    `API key: ${provider.apiKey ? "stored in local config" : provider.apiKeyEnv ? `environment variable ${provider.apiKeyEnv}` : "not required"}`,
  ].join("\n");
};
