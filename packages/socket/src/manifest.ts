/**
 * @gitgecko/socket/manifest — the plug manifest schema (Zod, runtime source-of-truth).
 *
 * Implements .docs/todo/system-design/03-plugin-socket-contract.md §2.
 * A plug's root must contain a plug.manifest.json that parses as PlugManifest.
 * The registry validates the manifest against the owner's capability enum
 * BEFORE setup() runs — a plug literally cannot call registerTool unless
 * its manifest declares the `tools` capability (Cline ContributionRegistry,
 * research manifest P-plugin-1).
 *
 * JSON Schema (for editor validation) is generated from this Zod schema
 * via zod-to-json-schema — the Continue dual-source pattern (P-frontend-11).
 */
import { z } from "zod";

export const MANIFEST_SCHEMA_VERSION = "1.0.0" as const;

export const manifestSchema = z.object({
  schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
  id: z
    .string()
    .regex(/^[a-z0-9-]+$/, "plug id must be kebab-case, globally unique, stable across versions"),
  name: z.string().min(1),
  owner: z.string().min(1), // validated against OwnerName by the registry, not here
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+/, "plug version must be semver (the plug's own version)"),
  description: z.string().min(1),

  // Non-empty subset of the owner's capability enum. Exact tokens validated
  // by the registry (each owner declares its own enum — 03 §4).
  capabilities: z.array(z.string().min(1)).min(1),

  targets: z
    .object({
      providers: z.array(z.string()).default([]),
      plans: z.array(z.string()).default([]),
      env: z.array(z.string()).default([]),
    })
    .default({ providers: [], plans: [], env: [] }),

  dependencies: z
    .object({
      requires: z.array(z.string()).default([]),
      recommends: z.array(z.string()).default([]),
    })
    .default({ requires: [], recommends: [] }),

  // Config schema ref — the plug's own JSON Schema. Validated before activate().
  config: z
    .object({ schema: z.string().min(1) })
    .optional(),

  permissions: z
    .object({
      network: z.array(z.string()).default([]),
      filesystem: z.array(z.string()).default([]),
      env: z.array(z.string()).default([]),
      // The manifest-side mirror of the mutates flag (P-plugin-7). If true,
      // every mutating tool the plug registers must carry mutates:true, and
      // the derived deny list is non-empty (throws if empty — 03 §6 invariant).
      mutatesTools: z.boolean().default(false),
    })
    .default({ network: [], filesystem: [], env: [], mutatesTools: false }),

  entrypoint: z.string().min(1),
  hooks: z.boolean().default(false),
  mcp: z.boolean().default(false),
});

export type PlugManifest = z.infer<typeof manifestSchema>;

/** Parse + validate a raw manifest object. Returns a Result to avoid throw-as-control. */
export const parseManifest = (
  raw: unknown,
): { ok: true; value: PlugManifest } | { ok: false; error: z.ZodError } => {
  const parsed = manifestSchema.safeParse(raw);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: parsed.error };
};
