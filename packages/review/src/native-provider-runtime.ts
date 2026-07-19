/** Runtime profile caching and schema-default resolution for provider plugs. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { NativeAgentProviderConfig, NativeAgentProviderId, NativeAgentProviderPlug, NativeAgentRuntimeProfile } from "./native-provider.js";

const providerProfileSchema = z.object({
  schemaVersion: z.literal("native-agent-runtime.v1"),
  provider: z.enum(["codex", "claude", "opencode", "pi"]),
  providerVersion: z.string().min(1),
  executable: z.string().min(1).optional(),
  schemaHash: z.string().min(1),
  configurationHash: z.string().min(1).optional(),
  capabilities: z.object({
    cwd: z.boolean(),
    permissions: z.array(z.enum(["read-only", "workspace-write", "unrestricted"])),
    ephemeral: z.boolean(),
    threads: z.boolean(),
    resume: z.boolean(),
    cancellation: z.boolean(),
    activity: z.boolean(),
    usage: z.boolean(),
    schemaDiscovery: z.boolean(),
  }).strict(),
  rawSchema: z.unknown().optional(),
  diagnostics: z.array(z.string()).optional(),
}).strict();

/** Canonicalize object keys so semantically identical provider schemas share a hash. */
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Readonly<Record<string, unknown>>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
  return `{${entries.join(",")}}`;
};

export const hashProviderSchema = (schema: unknown): string => createHash("sha256")
  .update(canonicalJson(schema ?? null))
  .digest("hex");

export const providerProfilePath = (
  provider: NativeAgentProviderId,
  root = join(homedir(), "gitgecko", "cache", "providers"),
): string => join(resolve(root), `${provider}.json`);

export const readProviderProfile = (
  provider: NativeAgentProviderId,
  root?: string,
): NativeAgentRuntimeProfile | undefined => {
  try {
    const parsed = providerProfileSchema.safeParse(JSON.parse(readFileSync(providerProfilePath(provider, root), "utf8")));
    return parsed.success && parsed.data.provider === provider ? parsed.data as NativeAgentRuntimeProfile : undefined;
  } catch {
    return undefined;
  }
};

export const writeProviderProfile = (
  profile: NativeAgentRuntimeProfile,
  root?: string,
): void => {
  const validated = providerProfileSchema.parse(profile);
  const target = providerProfilePath(profile.provider, root);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(validated)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
};

export const profileMatchesRuntime = (
  profile: NativeAgentRuntimeProfile | undefined,
  providerVersion: string,
  executable?: string,
  schemaHash?: string,
  configurationHash?: string,
): boolean => Boolean(profile
  && profile.providerVersion === providerVersion
  && profile.executable === executable
  && (schemaHash === undefined || profile.schemaHash === schemaHash)
  && (configurationHash === undefined || profile.configurationHash === configurationHash));

/** Reuse a profile until executable, version, schema, or config-sensitive inputs change. */
export const ensureProviderRuntimeProfile = async (
  plug: NativeAgentProviderPlug,
  config?: NativeAgentProviderConfig,
): Promise<NativeAgentRuntimeProfile> => {
  const probe = await plug.probe();
  if (!probe.installed) throw new Error(probe.diagnostic ?? `${plug.id} is not installed.`);
  const configurationHash = plug.profileKey === undefined
    ? undefined
    : hashProviderSchema(plug.profileKey(config));
  const cached = readProviderProfile(plug.id);
  if (profileMatchesRuntime(cached, probe.version ?? "unknown", probe.executable, undefined, configurationHash)) return cached!;
  const discovered = await plug.discoverCapabilities(config);
  if (configurationHash !== undefined && discovered.configurationHash !== configurationHash) {
    const withConfiguration = { ...discovered, configurationHash } satisfies NativeAgentRuntimeProfile;
    writeProviderProfile(withConfiguration);
    return withConfiguration;
  }
  return discovered;
};

interface JsonSchemaProperty { readonly default?: unknown; readonly type?: string | readonly string[] }
interface JsonObjectSchema {
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchemaProperty>>;
}

/** Defaults only values the provider declared safe; unknown required semantics fail closed. */
export const applyProviderSchemaDefaults = (
  schema: JsonObjectSchema,
  user: Readonly<Record<string, unknown>> = {},
  mapped: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> => {
  const resolved: Record<string, unknown> = { ...mapped, ...user };
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    if (resolved[name] !== undefined) continue;
    if (Object.hasOwn(property, "default")) resolved[name] = property.default;
  }
  for (const name of schema.required ?? []) {
    if (resolved[name] !== undefined) continue;
    const type = schema.properties?.[name]?.type;
    if (type === "null" || (Array.isArray(type) && type.includes("null"))) resolved[name] = null;
    else throw new Error(`Unsupported provider schema: required field '${name}' has no safe default.`);
  }
  return resolved;
};
