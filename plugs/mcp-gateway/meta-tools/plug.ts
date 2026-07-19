/**
 * GitGecko mcp-gateway meta-tools — the second mcp-gateway plug (INV-2.3).
 *
 * THE INVARIANT (INV-2.3): the mcp-gateway owner is non-exclusive — multiple
 * tool-exposer plugs coexist, each registering its own set of MCP tools. This
 * plug proves that invariant by existing alongside plug-mcp-exposers as a
 * distinct, real implementation.
 *
 * WHAT THIS PLUG DOES: exposes operational/introspection MCP tools that let any
 * agent query GitGecko's own state:
 *  - list_plugs: enumerate active plugs and their owners
 *  - health_check: check orchestrator liveness + capability availability
 *  - describe_models: list the model catalog (gitgecko-light, gitgecko-high)
 *
 * HOW IT DIFFERS FROM plug-mcp-exposers: the exposers plug bridges code-analysis
 * capabilities (search_code, evaluate_rule, run_review) into MCP tools. This plug
 * bridges OPERATIONAL capabilities (plug inventory, health, model catalog) —
 * tools for managing and monitoring GitGecko itself, not for analyzing code.
 * Both register tool-exposer contributions; their tools merge in the gateway.
 *
 * Salvaged pattern: Continue's "status" command + aider's "/models" — every
 * agent tool exposes its own state for observability.
 */
import { parseManifest, type PlugManifest } from "@gitgecko/socket";
import type { McpRequestContext, ToolExposerContribution, ToolRegistry, McpTool, McpToolResult } from "@gitgecko/mcp-gateway";
import { errorResult, textResult } from "@gitgecko/mcp-gateway";
import manifestJson from "./plug.manifest.json" with { type: "json" };

// --- Manifest (parsed, not cast) --------------------------------------------
const parsedManifest = parseManifest(manifestJson);
if (!parsedManifest.ok) {
  throw new Error(`mcp-meta-tools manifest invalid: ${JSON.stringify(parsedManifest.error.issues)}`);
}
export const manifest: PlugManifest = parsedManifest.value;

// --- The capability functions (injected — production wires real sources) -----

/** Plug inventory function — returns active plugs grouped by owner. */
export type ListPlugsFn = (context?: McpRequestContext) => Promise<readonly {
  owner: string;
  plugId: string;
  capabilities: readonly string[];
}[]>;

/** Health-check function — returns orchestrator status. */
export type HealthCheckFn = (context?: McpRequestContext) => Promise<{
  status: "ok" | "degraded" | "down";
  detail?: string;
}>;

/** Model catalog function — returns available models. */
export type DescribeModelsFn = (context?: McpRequestContext) => Promise<readonly {
  id: string;
  name: string;
  description: string;
}[]>;

// --- Tool builders ----------------------------------------------------------

const listPlugsTool = (listPlugs: ListPlugsFn): McpTool => ({
  name: "list_plugs",
  description: "List all active GitGecko plugs grouped by owner. Shows which capabilities are live.",
  inputSchema: {
    type: "object",
    properties: {},
  },
  handler: async (_args, context): Promise<McpToolResult> => {
    const plugs = await listPlugs(context ?? {});
    if (plugs.length === 0) return textResult("No active plugs.");
    const grouped = new Map<string, { plugId: string; capabilities: readonly string[] }[]>();
    for (const p of plugs) {
      const arr = grouped.get(p.owner) ?? [];
      arr.push({ plugId: p.plugId, capabilities: p.capabilities });
      grouped.set(p.owner, arr);
    }
    const lines: string[] = [];
    for (const [owner, entries] of grouped) {
      lines.push(`## ${owner}`);
      for (const e of entries) {
        lines.push(`  - ${e.plugId}: ${e.capabilities.join(", ")}`);
      }
    }
    return textResult(lines.join("\n"));
  },
});

const healthCheckTool = (healthCheck: HealthCheckFn): McpTool => ({
  name: "health_check",
  description: "Check GitGecko orchestrator health. Returns status (ok/degraded/down) and detail.",
  inputSchema: {
    type: "object",
    properties: {},
  },
  handler: async (_args, context): Promise<McpToolResult> => {
    const health = await healthCheck(context ?? {});
    if (health.status === "ok") {
      return textResult(`Status: ok${health.detail ? ` — ${health.detail}` : ""}`);
    }
    return errorResult(`Orchestrator ${health.status}${health.detail ? `: ${health.detail}` : ""}`);
  },
});

const describeModelsTool = (describeModels: DescribeModelsFn): McpTool => ({
  name: "describe_models",
  description: "List the available model catalog (gitgecko-light, gitgecko-high). Shows model names and descriptions.",
  inputSchema: {
    type: "object",
    properties: {},
  },
  handler: async (_args, context): Promise<McpToolResult> => {
    const models = await describeModels(context ?? {});
    if (models.length === 0) return textResult("No models configured.");
    const text = models.map((m) => `- ${m.id}: ${m.name} — ${m.description}`).join("\n");
    return textResult(text);
  },
});

// --- The exposer (registers all tools into the gateway) ---------------------

export interface MetaToolsDeps {
  readonly listPlugs?: ListPlugsFn;
  readonly healthCheck?: HealthCheckFn;
  readonly describeModels?: DescribeModelsFn;
}

/** Create the meta-tools exposer with injected capability functions. */
export const createMetaToolsExposer = (deps: MetaToolsDeps) => ({
  expose: (registry: ToolRegistry): void => {
    if (deps.listPlugs) registry.register(listPlugsTool(deps.listPlugs));
    if (deps.healthCheck) registry.register(healthCheckTool(deps.healthCheck));
    if (deps.describeModels) registry.register(describeModelsTool(deps.describeModels));
    // Same capability-truth guard as plug-mcp-exposers: zero deps = inert.
    const wiredCount = [deps.listPlugs, deps.healthCheck, deps.describeModels].filter(Boolean).length;
    if (wiredCount === 0) {
      console.error(
        "[mcp-meta-tools] WARNING: expose() called with no capabilities wired — zero MCP tools registered. " +
          "The orchestrator must inject listPlugs/healthCheck/describeModels for the meta-tools to be live.",
      );
    }
  },
});

/** Build the dependency-injected plug module consumed by the owner Registry. */
export const createMetaToolsPlug = (deps: MetaToolsDeps) => ({
  manifest,
  setup: async (api: {
    register: (capability: "expose", contribution: ToolExposerContribution) => void;
  }): Promise<void> => {
    const exposer = createMetaToolsExposer(deps);
    api.register("expose", {
      kind: "tool-exposer",
      id: "mcp-meta-tools",
      expose: exposer.expose,
      mutates: false,
    });
  },
});

// --- Plug setup (registers the expose capability) ---------------------------
// The empty setup remains a compatibility boundary for static plug discovery.
// Production uses createMetaToolsPlug() so capability functions are real.
export async function setup(api: {
  register: (capability: "expose", contribution: ToolExposerContribution) => void;
}): Promise<void> {
  await createMetaToolsPlug({}).setup(api);
}
