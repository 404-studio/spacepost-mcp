import {
  deref,
  type HttpMethod,
  type JsonSchema,
  type OpenApiDocument,
  operations,
  type Parameter,
  toJsonSchema,
} from "./openapi.ts";
import { type OverlayEntry, overlay as defaultOverlay } from "./overlay.ts";

/** How one tool argument maps back onto the HTTP request. */
export type ArgBinding =
  | { arg: string; in: "path" | "query" | "header"; name: string }
  | { arg: string; in: "body"; name: string }
  /** The whole JSON body (non-object bodies such as the batch array). */
  | { arg: string; in: "body-whole" };

/** API key permission: `full_access` keys can call every tool, `sending_access` keys only the ones marked in the spec. */
export type KeyPermission = "full_access" | "sending_access";

/** Whether a key with `permission` may call `tool` (mirrors the API's requireFullAccess; source: the spec's `x-permission`). */
export function usableBy(tool: ToolDef, permission: KeyPermission): boolean {
  return permission === "full_access" || tool.permission === "sending_access";
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** A generated MCP tool plus everything the executor needs to turn its arguments into an API request. */
export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema & { type: "object"; properties: Record<string, JsonSchema>; required?: string[] };
  annotations: ToolAnnotations;
  operationId: string;
  method: Uppercase<HttpMethod>;
  path: string;
  tags: string[];
  /** Least API key permission that may call it, from `x-permission` (default `full_access`). */
  permission: KeyPermission;
  /** True when the operation declares a JSON request body (an empty `{}` is sent when no body argument is given). */
  hasBody: boolean;
  bindings: ArgBinding[];
}

export interface BuildOptions {
  /** Only GET operations. */
  readOnly?: boolean;
  /** Only tools a key with this permission can use (`sending_access` → the operations marked `x-permission: sending_access`). */
  permission?: KeyPermission;
  /** Keep only these toolsets: OpenAPI tag names or first path segments, compared case- and punctuation-insensitively. */
  toolsets?: string[];
  /** Curated extras keyed by operationId; defaults to src/overlay.ts. */
  overlay?: Record<string, OverlayEntry>;
  /**
   * Argument defaults per tool name (e.g. `{ send_email: { from: "Acme <hi@acme.com>" } }`). A defaulted argument is no longer
   * required and its description mentions the default.
   */
  argDefaults?: Record<string, Record<string, unknown>>;
}

/** `sendEmail` → `send_email`, `getBroadcastReadiness` → `get_broadcast_readiness`, `Idempotency-Key` → `idempotency_key`. */
export function snakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

/** Normalizes a toolset name: "API Keys", "api-keys" and "api_keys" all become "apikeys". */
export function toolsetKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The toolset names an operation belongs to: its tags and the first segment of its path. */
function toolsetsOf(path: string, tags: string[]): string[] {
  const first = path.split("/").find(Boolean) ?? "";
  return [...tags, first].map(toolsetKey);
}

/** Every toolset name the document offers, for `--help` and error messages. */
export function availableToolsets(doc: OpenApiDocument): string[] {
  const names = new Set<string>();
  for (const { op } of operations(doc)) for (const t of op.tags ?? []) names.add(toolsetKey(t));
  return [...names].sort();
}

const IDEMPOTENT: Record<HttpMethod, boolean> = { get: true, put: true, delete: true, post: false, patch: false };

/**
 * Builds one tool per OpenAPI operation. Input = path params + query params + header params (snake_case names, e.g.
 * `audience_id`, `idempotency_key`) + the JSON body's top-level fields. Collision rule: a body field whose name is already
 * taken by a parameter is exposed as `body_<field>`. A body that is not an object (e.g. the batch array) is exposed as `body`.
 */
export function buildTools(doc: OpenApiDocument, options: BuildOptions = {}): ToolDef[] {
  const ov = options.overlay ?? defaultOverlay;
  const wanted = options.toolsets?.length ? new Set(options.toolsets.map(toolsetKey)) : undefined;
  if (wanted) {
    const known = new Set(operations(doc).flatMap(({ path, op }) => toolsetsOf(path, op.tags ?? [])));
    const unknown = [...wanted].filter((w) => !known.has(w));
    if (unknown.length)
      throw new Error(`Unknown toolset(s): ${unknown.join(", ")}. Available: ${availableToolsets(doc).join(", ")}`);
  }

  const tools: ToolDef[] = [];
  for (const { method, path, item, op } of operations(doc)) {
    if (!op.operationId) throw new Error(`${method.toUpperCase()} ${path} has no operationId`);
    const x = op["x-mcp"] ?? {};
    const extra = ov[op.operationId] ?? {};
    if (x.hidden ?? extra.hidden) continue;
    if (options.readOnly && method !== "get") continue;
    const permission: KeyPermission = op["x-permission"] === "sending_access" ? "sending_access" : "full_access";
    if (options.permission === "sending_access" && permission !== "sending_access") continue;
    const tags = op.tags ?? [];
    if (wanted && !toolsetsOf(path, tags).some((t) => wanted.has(t))) continue;

    const name = snakeCase(op.operationId);
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    const bindings: ArgBinding[] = [];

    // Path-level parameters first, overridden by operation-level ones with the same name and location.
    const params = new Map<string, Parameter>();
    for (const p of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
      const resolved = deref(doc, p);
      params.set(`${resolved.in}:${resolved.name}`, resolved);
    }
    for (const p of params.values()) {
      if (p.in === "cookie") continue;
      const arg = snakeCase(p.name);
      const schema = toJsonSchema(doc, p.schema ?? {});
      if (p.description) schema.description = p.description;
      if (p.example !== undefined && schema.examples === undefined) schema.examples = [p.example];
      properties[arg] = schema;
      if (p.required || p.in === "path") required.push(arg);
      bindings.push({ arg, in: p.in, name: p.name });
    }

    let hasBody = false;
    let bodyNote: string | undefined;
    if (op.requestBody) {
      const body = deref(doc, op.requestBody);
      const media = body.content?.["application/json"];
      if (media) {
        hasBody = true;
        const schema = toJsonSchema(doc, media.schema ?? {});
        const isObject = (schema.type === "object" || schema.properties) && !schema.oneOf && !schema.anyOf;
        if (isObject) {
          bodyNote = typeof schema.description === "string" ? schema.description : body.description;
          const bodyRequired = new Set(body.required ? ((schema.required as string[]) ?? []) : []);
          for (const [field, fieldSchema] of Object.entries((schema.properties as Record<string, JsonSchema>) ?? {})) {
            const arg = field in properties ? `body_${field}` : field;
            properties[arg] = fieldSchema;
            if (bodyRequired.has(field)) required.push(arg);
            bindings.push({ arg, in: "body", name: field });
          }
        } else {
          const arg = "body" in properties ? "request_body" : "body";
          properties[arg] = { ...schema, description: schema.description ?? body.description ?? "The JSON request body." };
          if (body.required) required.push(arg);
          bindings.push({ arg, in: "body-whole" });
        }
      }
    }

    for (const [arg, value] of Object.entries(options.argDefaults?.[name] ?? {})) {
      if (!properties[arg]) continue;
      const i = required.indexOf(arg);
      if (i >= 0) required.splice(i, 1);
      const prev = properties[arg].description;
      properties[arg] = { ...properties[arg], description: `${prev ? `${prev} ` : ""}Defaults to ${JSON.stringify(value)}.` };
    }

    const upper = method.toUpperCase() as Uppercase<HttpMethod>;
    const permissionNote =
      permission === "sending_access"
        ? "Works with a `sending_access` or `full_access` API key."
        : "Requires a `full_access` API key.";
    const description = [
      `${op.summary ?? name}.`.replace(/\.\.$/, "."),
      op.description?.trim(),
      x.description ?? extra.description,
      bodyNote ? `Request body: ${bodyNote}` : undefined,
      `${permissionNote} API: \`${upper} ${path}\` (operationId \`${op.operationId}\`${tags.length ? `, ${tags.join(", ")}` : ""}).`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const title = op.summary ?? name;
    tools.push({
      name,
      title,
      description,
      inputSchema: { type: "object", properties, ...(required.length ? { required } : {}) },
      annotations: {
        title,
        readOnlyHint: method === "get",
        destructiveHint: method === "get" ? false : (x.destructive ?? method === "delete"),
        idempotentHint: x.idempotent ?? IDEMPOTENT[method],
        openWorldHint: x.openWorld ?? false,
      },
      operationId: op.operationId,
      method: upper,
      path,
      tags,
      permission,
      hasBody,
      bindings,
    });
  }

  const dupes = tools.map((t) => t.name).filter((n, i, all) => all.indexOf(n) !== i);
  if (dupes.length) throw new Error(`Duplicate tool names: ${dupes.join(", ")}`);
  return tools;
}
