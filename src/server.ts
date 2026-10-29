import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { callTool, type Execute } from "./executor.ts";
import bundled from "./generated/openapi.json" with { type: "json" };
import type { OpenApiDocument } from "./openapi.ts";
import { type BuildOptions, buildTools, type KeyPermission, type ToolDef, usableBy } from "./tools.ts";

export const SERVER_VERSION = "0.2.1";

/** The OpenAPI document bundled at build time (src/generated/openapi.json, refreshed from the published spec by scripts/generate-spec.ts). */
export const bundledSpec = bundled as unknown as OpenApiDocument;

const INSTRUCTIONS =
  "SpacePost is a Resend-compatible email API. Every tool maps to one REST endpoint and returns its JSON response. " +
  "To send: list_domains to find a verified domain for `from`, then send_email. List tools paginate with `limit` and `after` " +
  "(the id of the last item). Errors come back as { statusCode, name, message }.";

export interface ServerOptions extends BuildOptions {
  /** Performs the API calls (see createFetchExecutor). */
  execute: Execute;
  /** Defaults to the bundled spec. */
  spec?: OpenApiDocument;
  /** Pre-built tools (lets the hosted endpoint build them once instead of per request). */
  tools?: ToolDef[];
  /**
   * List only the tools a key with this permission can use. The others stay callable, so the API itself refuses them with
   * `restricted_api_key` (the REST layer remains the only enforcement point).
   */
  listFor?: KeyPermission;
}

/** The MCP `tools/list` entry for a generated tool. */
export function toMcpTool(t: ToolDef): Tool {
  return { name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations };
}

/**
 * Builds the MCP server with one tool per API operation. Uses the low-level `Server` with plain JSON Schema input schemas
 * (instead of McpServer + zod) so enums, formats, patterns, bounds and descriptions from the spec reach the client unchanged.
 */
export function createServer(options: ServerOptions): Server {
  const tools = options.tools ?? buildTools(options.spec ?? bundledSpec, options);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const listed = tools.filter((t) => !options.listFor || usableBy(t, options.listFor)).map(toMcpTool);

  const server = new Server(
    { name: "spacepost", title: "SpacePost", version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listed }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = byName.get(req.params.name);
    if (!tool)
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool ${req.params.name}. Call tools/list for the available tools.` }],
      };
    // `null` is passed through on purpose: e.g. `daily_limit: null` removes a tenant's cap.
    const args = { ...options.argDefaults?.[tool.name], ...req.params.arguments };
    return callTool(tool, args, options.execute);
  });
  return server;
}
