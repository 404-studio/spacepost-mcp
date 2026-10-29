/**
 * The small slice of OpenAPI 3.1 the tool generator reads, plus `$ref`/`allOf` resolution into self-contained JSON Schema.
 * OpenAPI 3.1 schemas already are JSON Schema 2020-12, so conversion is mostly inlining refs and dropping OpenAPI-only keywords;
 * enums, formats, patterns, bounds, defaults, nullability (`type: [string, "null"]`) and descriptions pass through unchanged.
 */

export type JsonSchema = { [key: string]: unknown };

/** Vendor extension on an operation that tunes its MCP tool from the spec (preferred over src/overlay.ts). */
export interface McpExtension {
  /** Leave the operation out of MCP entirely. */
  hidden?: boolean;
  /** Extra guidance for AI agents, appended to the tool description. */
  description?: string;
  /** Sets `destructiveHint` (DELETE operations are destructive without it). */
  destructive?: boolean;
  /** Sets `idempotentHint` (GET, PUT and DELETE are idempotent without it). */
  idempotent?: boolean;
  /** Sets `openWorldHint`: true for operations that reach the outside world, such as sending email. */
  openWorld?: boolean;
}

export interface Parameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
  example?: unknown;
  $ref?: string;
}

export interface Operation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: Parameter[];
  requestBody?: { required?: boolean; description?: string; content?: Record<string, { schema?: JsonSchema }>; $ref?: string };
  "x-mcp"?: McpExtension;
  /** API key permission that is enough for this operation; absent means `full_access`. */
  "x-permission"?: "sending_access" | "full_access";
}

export const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export type PathItem = { parameters?: Parameter[] } & { [M in HttpMethod]?: Operation };

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, PathItem>;
  components?: Record<string, Record<string, unknown>>;
}

/** Every operation under `paths` (webhooks/callbacks are not callable, so they are skipped). */
export function operations(doc: OpenApiDocument): { method: HttpMethod; path: string; item: PathItem; op: Operation }[] {
  const out: { method: HttpMethod; path: string; item: PathItem; op: Operation }[] = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (op) out.push({ method, path, item, op });
    }
  }
  return out;
}

/** Resolves a local JSON pointer such as `#/components/schemas/Email`. */
export function resolvePointer(doc: OpenApiDocument, ref: string): unknown {
  if (!ref.startsWith("#/")) throw new Error(`Only local $refs are supported, got ${ref}`);
  let node: unknown = doc;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (node === null || typeof node !== "object" || !(key in node)) throw new Error(`Unresolvable $ref ${ref}`);
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** Follows `$ref` on non-schema objects (parameters, request bodies); sibling keys override the target. */
export function deref<T extends object>(doc: OpenApiDocument, value: T): T {
  let current = value as T & { $ref?: string };
  const seen = new Set<string>();
  while (typeof current.$ref === "string") {
    if (seen.has(current.$ref)) throw new Error(`Circular $ref ${current.$ref}`);
    seen.add(current.$ref);
    const { $ref, ...rest } = current;
    current = { ...(resolvePointer(doc, $ref) as T), ...rest } as T & { $ref?: string };
  }
  return current;
}

/** OpenAPI-only or noisy keywords that MCP clients don't need in an input schema. */
const DROP = new Set(["discriminator", "xml", "externalDocs", "example", "readOnly", "writeOnly", "deprecated"]);

/**
 * Converts an OpenAPI schema into a standalone JSON Schema: inlines `$ref`s, merges `allOf` of object schemas into one object,
 * turns `example` into `examples` and drops vendor extensions. Cycles collapse to `{}` (the API has none today).
 */
export function toJsonSchema(doc: OpenApiDocument, schema: unknown, stack: string[] = []): JsonSchema {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return {};
  let s = schema as JsonSchema;
  if (typeof s.$ref === "string") {
    const ref = s.$ref;
    if (stack.includes(ref)) return {};
    const { $ref: _, ...siblings } = s;
    const target = toJsonSchema(doc, resolvePointer(doc, ref), [...stack, ref]);
    return { ...target, ...toJsonSchema(doc, siblings, stack) };
  }

  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(s)) {
    if (DROP.has(key) || key.startsWith("x-")) continue;
    if (key === "properties" && value && typeof value === "object") {
      out.properties = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toJsonSchema(doc, v, stack)]),
      );
    } else if ((key === "items" || key === "additionalProperties" || key === "not") && typeof value === "object") {
      out[key] = toJsonSchema(doc, value, stack);
    } else if ((key === "allOf" || key === "oneOf" || key === "anyOf" || key === "prefixItems") && Array.isArray(value)) {
      out[key] = value.map((v) => toJsonSchema(doc, v, stack));
    } else {
      out[key] = value;
    }
  }
  if (s.example !== undefined && out.examples === undefined) out.examples = [s.example];
  s = out;
  return Array.isArray(s.allOf) ? mergeAllOf(s) : s;
}

/** Merges `allOf` parts into the parent when every part is a plain object schema; otherwise leaves `allOf` as is. */
function mergeAllOf(schema: JsonSchema): JsonSchema {
  const parts = schema.allOf as JsonSchema[];
  const mergeable = parts.every((p) => !p.oneOf && !p.anyOf && !p.allOf && (p.type === undefined || p.type === "object"));
  if (!mergeable) return schema;
  const { allOf: _, ...rest } = schema;
  const merged: JsonSchema = {};
  const properties: Record<string, JsonSchema> = {};
  const required = new Set<string>();
  for (const part of [...parts, rest]) {
    const { properties: props, required: req, ...other } = part;
    Object.assign(merged, other);
    for (const [k, v] of Object.entries((props as Record<string, JsonSchema>) ?? {})) {
      properties[k] = { ...properties[k], ...v };
    }
    for (const r of (req as string[]) ?? []) required.add(r);
  }
  if (Object.keys(properties).length) {
    merged.type = "object";
    merged.properties = properties;
  }
  if (required.size) merged.required = [...required];
  return merged;
}
