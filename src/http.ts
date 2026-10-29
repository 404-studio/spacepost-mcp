import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Execute } from "./executor.ts";
import { createServer, bundledSpec } from "./server.ts";
import { type BuildOptions, buildTools, type KeyPermission, type ToolDef } from "./tools.ts";

const toolCache = new Map<string, ToolDef[]>();

/** Tool options from the hosted endpoint's query string: `?read_only=true&toolsets=emails,domains`. */
export function optionsFromUrl(url: URL): BuildOptions {
  const ro = url.searchParams.get("read_only") ?? url.searchParams.get("readonly");
  const toolsets = url.searchParams.get("toolsets");
  return {
    readOnly: ro !== null && ro !== "false" && ro !== "0",
    toolsets: toolsets
      ? toolsets
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
  };
}

function jsonRpcError(status: number, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }, { status, headers });
}

/**
 * Serves one Streamable HTTP request in stateless mode (a fresh server per request, JSON responses, no sessions), which is
 * what lets the hosted endpoint run on any number of instances. Only POST carries messages; GET (server-initiated stream) and
 * DELETE (session end) are answered with 405 as the spec allows for stateless servers. Authentication is the caller's job.
 */
export async function handleMcpHttp(
  request: Request,
  opts: {
    execute: Execute /** The caller key's permission: tools it cannot use are left out of tools/list. */;
    permission?: KeyPermission;
  },
): Promise<Response> {
  if (request.method !== "POST")
    return jsonRpcError(405, "Method not allowed: this MCP server is stateless, use POST.", { allow: "POST" });
  let options: BuildOptions;
  let tools: ToolDef[];
  try {
    options = optionsFromUrl(new URL(request.url));
    const key = JSON.stringify(options);
    tools = toolCache.get(key) ?? buildTools(bundledSpec, options);
    if (toolCache.size < 100) toolCache.set(key, tools);
  } catch (e) {
    return jsonRpcError(400, (e as Error).message);
  }
  const server = createServer({ execute: opts.execute, tools, listFor: opts.permission });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
