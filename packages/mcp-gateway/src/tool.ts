/**
 * @gitgecko/mcp-gateway/tool — the MCP tool contract + gateway.
 *
 * Salvaged from pullfrog's FastMCP pattern (research manifest P-frontend-5,
 * .refs/01-pr-review/pullfrog-main/mcp/server.ts + shared.ts). The gateway
 * collects tools from active owners + dispatches calls.
 *
 * G7 (the inversion): CodeRabbit is an MCP CLIENT (CR-§3, keeps its graph
 * closed); Greptile's MCP is hosted-only/closed (GP-§3, OQ-GP2). gitgecko
 * PUBLISHES its capabilities AS an MCP server — any agent consumes them.
 *
 * The testable unit: tool registration + dispatch (in-process, no transport).
 * The transport (stdio/SSE/HTTP via @modelcontextprotocol/sdk) plugs in later
 * as a thin envelope over this registry.
 */
import type { OwnerSpec } from "@gitgecko/socket";

/** Verified caller identity added by the transport after authentication. */
export interface McpRequestContext {
  readonly caller?: {
    readonly userId: string;
  };
}

/** An MCP tool — name + description + JSON Schema input + handler. */
export interface McpTool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the tool's input (the MCP inputSchema field). */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** The handler — called when an agent invokes this tool. Returns text content. */
  readonly handler: (
    args: Readonly<Record<string, unknown>>,
    context?: McpRequestContext,
  ) => Promise<McpToolResult>;
  /** Does this tool mutate state? (P-plugin-7 — for the deny-list derivation) */
  readonly mutates?: boolean;
}

/** MCP tool result — matches the MCP protocol's content shape. */
export interface McpToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly isError?: boolean;
}

/** Convenience: wrap a plain string as a successful MCP result. */
export const textResult = (text: string): McpToolResult => ({
  content: [{ type: "text", text }],
});

/** Convenience: wrap an error message as an error MCP result. */
export const errorResult = (message: string): McpToolResult => ({
  content: [{ type: "text", text: `Error: ${message}` }],
  isError: true,
});

/** The mcp-gateway owner's capabilities. */
export type McpGatewayCapability = "expose";

/** Contribution: a tool exposer (registers MCP tools from an owner's capabilities). */
export interface ToolExposerContribution {
  readonly kind: "tool-exposer";
  readonly id: string;
  /** Register tools into the gateway. Called at load time. */
  readonly expose: (registry: ToolRegistry) => void;
  readonly mutates?: boolean;
}

/** The tool registry — collects tools + dispatches calls. */
export interface ToolRegistry {
  readonly register: (tool: McpTool) => void;
  readonly list: () => readonly McpTool[];
  readonly call: (
    name: string,
    args: Readonly<Record<string, unknown>>,
    context?: McpRequestContext,
  ) => Promise<McpToolResult>;
}

export const mcpGatewayOwner: OwnerSpec<McpGatewayCapability, string> = {
  name: "mcp-gateway",
  capabilities: ["expose"],
  // NON-exclusive: multiple tool exposers coexist (code-intel, rules, review each expose their tools).
  exclusive: () => false,
  kindFor: () => "tool-exposer",
};

/**
 * Create an in-memory ToolRegistry. Tools are registered by exposers (one per
 * owner capability family), then dispatched by name. This is the testable core;
 * the MCP transport wraps it.
 */
export const createToolRegistry = (): ToolRegistry => {
  const tools = new Map<string, McpTool>();
  return {
    register: (tool: McpTool): void => {
      if (tools.has(tool.name)) return; // idempotent: first registration wins
      tools.set(tool.name, tool);
    },
    list: (): readonly McpTool[] => [...tools.values()],
    call: async (
      name: string,
      args: Readonly<Record<string, unknown>>,
      context: McpRequestContext = {},
    ): Promise<McpToolResult> => {
      const tool = tools.get(name);
      if (!tool) return errorResult(`unknown tool: ${name}`);
      try {
        return await tool.handler(args, context);
      } catch (e) {
        return errorResult((e as Error).message);
      }
    },
  };
};
