import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDef } from "./tools.ts";

/** A transport-neutral API call: the stdio server sends it over the network, the hosted endpoint into the in-process app. */
export interface ApiRequest {
  method: string;
  /** Path with parameters substituted, e.g. `/domains/0198…/verify`. */
  path: string;
  query: [string, string][];
  /** Extra headers declared by the operation (e.g. `Idempotency-Key`); auth is added by the executor. */
  headers: Record<string, string>;
  body?: unknown;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

export type Execute = (request: ApiRequest) => Promise<ApiResponse>;

/** Thrown for arguments that can be rejected before calling the API (unknown names, missing path params). */
export class ArgumentError extends Error {}

/** Maps tool arguments onto method, path, query, headers and body using the bindings computed from the spec. */
export function buildRequest(tool: ToolDef, args: Record<string, unknown> = {}): ApiRequest {
  const known = new Set(tool.bindings.map((b) => b.arg));
  const unknown = Object.keys(args).filter((k) => !known.has(k));
  if (unknown.length)
    throw new ArgumentError(
      `Unknown argument(s) for ${tool.name}: ${unknown.join(", ")}. Allowed: ${[...known].join(", ") || "(none)"}.`,
    );
  const missing = (tool.inputSchema.required ?? []).filter((k) => args[k] === undefined || args[k] === null);
  if (missing.length) throw new ArgumentError(`Missing required argument(s) for ${tool.name}: ${missing.join(", ")}.`);

  let path = tool.path;
  const query: [string, string][] = [];
  const headers: Record<string, string> = {};
  let body: unknown = tool.hasBody ? {} : undefined;
  for (const b of tool.bindings) {
    const value = args[b.arg];
    if (value === undefined) continue;
    switch (b.in) {
      case "path":
        path = path.replace(`{${b.name}}`, encodeURIComponent(String(value)));
        break;
      case "query":
        for (const v of Array.isArray(value) ? value : [value]) query.push([b.name, scalar(v)]);
        break;
      case "header":
        headers[b.name] = scalar(value);
        break;
      case "body":
        (body as Record<string, unknown>)[b.name] = value;
        break;
      case "body-whole":
        body = value;
        break;
    }
  }
  return { method: tool.method, path, query, headers, ...(body === undefined ? {} : { body }) };
}

function scalar(v: unknown): string {
  return typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
}

export interface FetchExecutorOptions {
  baseUrl: string;
  /** Full `Authorization` header value, e.g. `Bearer sp_live_…`. Never logged or echoed in results. */
  authorization: string;
  userAgent?: string;
  fetch?: (request: Request) => Promise<Response>;
}

/** Executes requests with fetch against `baseUrl` (stdio server) or any Request handler such as a Hono app (hosted). */
export function createFetchExecutor(opts: FetchExecutorOptions): Execute {
  const doFetch = opts.fetch ?? ((r: Request) => fetch(r));
  const base = opts.baseUrl.replace(/\/+$/, "");
  return async (req) => {
    const url = new URL(base + req.path);
    for (const [k, v] of req.query) url.searchParams.append(k, v);
    const headers: Record<string, string> = { ...req.headers, authorization: opts.authorization, accept: "application/json" };
    if (opts.userAgent) headers["user-agent"] = opts.userAgent;
    if (req.body !== undefined) headers["content-type"] = "application/json";
    const res = await doFetch(
      new Request(url, {
        method: req.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
      }),
    );
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, body };
  };
}

/** What to try next for common API errors (tool names refer to generated tools). */
export const ERROR_HINTS: Record<string, string> = {
  invalid_from_address:
    "The sender domain is not verified for this account. Call list_domains to see verified domains, or create_domain + verify_domain.",
  restricted_api_key: "This API key cannot use this tool (sending_access keys may only send email). Use a full_access key.",
  invalid_api_key: "The API key was rejected. Check the configured SpacePost API key.",
  missing_api_key: "No API key was sent. Configure a SpacePost API key.",
  sending_paused:
    "Sending is paused (for this tenant or the whole account). Use list_tenants / get_tenant to check; unpause_tenant resumes a manually paused tenant.",
  daily_quota_exceeded:
    "A daily sending limit was reached (tenant cap or account). Try again after UTC midnight or raise the limit.",
  not_found: "No item with that id. Use the matching list_* tool to find valid ids.",
  rate_limit_exceeded: "Rate limited. Wait a second and retry.",
  validation_error: "Fix the arguments named in the message and call the tool again.",
};

/** Runs a tool: API response JSON on success, `isError` with the Resend-style error body (plus a hint) on failure. */
export async function callTool(
  tool: ToolDef,
  args: Record<string, unknown> | undefined,
  execute: Execute,
): Promise<CallToolResult> {
  let request: ApiRequest;
  try {
    request = buildRequest(tool, args);
  } catch (e) {
    if (e instanceof ArgumentError) return errorResult({ statusCode: 422, name: "validation_error", message: e.message });
    throw e;
  }
  let res: ApiResponse;
  try {
    res = await execute(request);
  } catch (e) {
    return errorResult({
      statusCode: 0,
      name: "application_error",
      message: `Could not reach the SpacePost API: ${(e as Error).message}`,
    });
  }
  if (res.status >= 400) {
    const body =
      res.body && typeof res.body === "object"
        ? res.body
        : { statusCode: res.status, name: "application_error", message: String(res.body ?? `HTTP ${res.status}`) };
    return errorResult(body);
  }
  const data = res.body ?? { status: res.status };
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    ...(data && typeof data === "object" && !Array.isArray(data) ? { structuredContent: data as Record<string, unknown> } : {}),
  };
}

function errorResult(body: object): CallToolResult {
  const name = (body as { name?: unknown }).name;
  const hint = typeof name === "string" ? ERROR_HINTS[name] : undefined;
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(body) }, ...(hint ? [{ type: "text" as const, text: `Hint: ${hint}` }] : [])],
  };
}
