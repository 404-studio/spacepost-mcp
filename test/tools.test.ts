import { describe, expect, test } from "bun:test";
import { parseCli } from "../src/cli.ts";
import { type OpenApiDocument, operations } from "../src/openapi.ts";
import { bundledSpec } from "../src/server.ts";
import { buildTools, snakeCase, type ToolDef, usableBy } from "../src/tools.ts";

const tools = buildTools(bundledSpec);
const tool = (name: string, list: ToolDef[] = tools) => {
  const t = list.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};
const props = (t: ToolDef) => t.inputSchema.properties as Record<string, Record<string, unknown>>;

describe("tool generation", () => {
  test("one tool per operation (minus hidden ones)", () => {
    const ops = operations(bundledSpec);
    const hidden = ops.filter(({ op }) => op["x-mcp"]?.hidden).length;
    expect(ops.length).toBeGreaterThanOrEqual(46);
    expect(tools.length).toBe(ops.length - hidden);
  });

  test("names are operationIds in snake_case, and the original 12 hand-written tool names still exist", () => {
    expect(snakeCase("sendEmail")).toBe("send_email");
    expect(snakeCase("getBroadcastReadiness")).toBe("get_broadcast_readiness");
    expect(snakeCase("listAPIKeys")).toBe("list_api_keys");
    expect(snakeCase("Idempotency-Key")).toBe("idempotency_key");
    expect(snakeCase("audienceId")).toBe("audience_id");
    const names = new Set(tools.map((t) => t.name));
    for (const legacy of [
      "send_email",
      "list_emails",
      "get_email",
      "cancel_email",
      "list_domains",
      "get_domain",
      "create_domain",
      "verify_domain",
      "list_tenants",
      "list_audiences",
      "list_contacts",
      "create_contact",
    ])
      expect(names.has(legacy)).toBe(true);
    // Arguments the legacy tools used keep their names (path params are snake_cased).
    expect(Object.keys(props(tool("list_contacts")))).toContain("audience_id");
    expect(Object.keys(props(tool("create_contact")))).toEqual(
      expect.arrayContaining(["audience_id", "email", "first_name", "last_name", "unsubscribed"]),
    );
  });

  test("every tool has a description with the summary, the HTTP route and the key permission", () => {
    for (const t of tools) {
      expect(t.description).toContain(`\`${t.method} ${t.path}\``);
      expect(t.description).toMatch(/API key/);
      expect(t.inputSchema.type).toBe("object");
    }
    expect(tool("send_email").description).toContain("sending_access");
    expect(tool("list_domains").description).toContain("Requires a `full_access` API key");
    expect(tool("send_email").description).toContain("delivered@test.spacepost.dev"); // overlay
  });

  test("annotations follow the method and x-mcp", () => {
    const a = (n: string) => tool(n).annotations;
    expect(a("list_emails")).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    expect(a("delete_domain")).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    expect(a("update_domain")).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect(a("send_email")).toMatchObject({ openWorldHint: true, destructiveHint: false, idempotentHint: false });
    expect(a("send_broadcast").openWorldHint).toBe(true);
    expect(a("cancel_email")).toMatchObject({ destructiveHint: true, idempotentHint: true });
    expect(a("pause_tenant").destructiveHint).toBe(true);
    expect(a("verify_domain").idempotentHint).toBe(true);
    expect(a("list_domains").openWorldHint).toBe(false);
  });
});

describe("schema conversion", () => {
  test("send_email: refs inlined, header param, oneOf address lists, attachments and tags with full constraints", () => {
    const t = tool("send_email");
    expect(t.inputSchema.required).toEqual(["from", "to", "subject"]);
    const p = props(t);
    expect(p.idempotency_key).toMatchObject({ type: "string", minLength: 1, maxLength: 256 });
    expect(p.to!.oneOf).toHaveLength(2);
    expect((p.to!.oneOf as Record<string, unknown>[])[1]).toMatchObject({ type: "array", maxItems: 50 });
    expect(p.attachments).toMatchObject({
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        required: ["filename"],
        properties: { path: { type: "string", format: "uri" }, content: { type: "string" } },
      },
    });
    expect(p.tags).toMatchObject({
      items: { required: ["name", "value"], properties: { name: { pattern: "^[A-Za-z0-9_-]+$", maxLength: 256 } } },
    });
    expect(p.scheduled_at!.description).toContain("ISO 8601");
    expect(JSON.stringify(t.inputSchema)).not.toContain("$ref");
  });

  test("create_broadcast and create_tenant keep formats, bounds, nullability and required fields", () => {
    const b = tool("create_broadcast");
    expect(b.inputSchema.required).toEqual(["audience_id", "from", "subject"]);
    expect(props(b).audience_id).toEqual({ type: "string", format: "uuid" });
    expect(props(b).preview_text).toEqual({ type: "string", maxLength: 200 });
    const t = tool("create_tenant");
    expect(t.inputSchema.required).toEqual(["name"]);
    expect(props(t).daily_limit).toMatchObject({ type: ["integer", "null"], minimum: 1 });
    expect(props(tool("update_domain")).tls).toEqual({ type: "string", enum: ["opportunistic", "enforced"] });
    expect(props(tool("create_webhook")).events).toMatchObject({
      minItems: 1,
      items: { enum: expect.arrayContaining(["email.sent"]) },
    });
  });

  test("a non-object body (batch) is exposed as `body`", () => {
    const t = tool("send_batch_emails");
    expect(t.inputSchema.required).toEqual(["body"]);
    expect(props(t).body).toMatchObject({ type: "array", maxItems: 100, items: { required: ["from", "to", "subject"] } });
  });

  test("an optional body has no required fields; GET tools have pagination params", () => {
    expect(tool("send_broadcast").inputSchema.required).toEqual(["id"]);
    expect(Object.keys(props(tool("list_domains")))).toEqual(["limit", "after", "before"]);
    expect(props(tool("list_domains")).limit).toMatchObject({ type: "integer", minimum: 1, maximum: 100, default: 20 });
  });

  test("allOf is merged, body fields colliding with params become body_<name>, x-mcp hides and describes", () => {
    const doc: OpenApiDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/things/{id}": {
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          put: {
            operationId: "replaceThing",
            summary: "Replace a thing",
            "x-mcp": { description: "Agent note.", destructive: true },
            requestBody: {
              required: true,
              content: { "application/json": { schema: { $ref: "#/components/schemas/Thing" } } },
            },
          },
          delete: { operationId: "deleteThing", summary: "Delete", "x-mcp": { hidden: true } },
        },
      },
      components: {
        schemas: {
          Base: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
          Thing: {
            allOf: [
              { $ref: "#/components/schemas/Base" },
              { type: "object", required: ["name"], properties: { name: { type: "string", example: "x" } } },
            ],
          },
        },
      },
    };
    const list = buildTools(doc, { overlay: { replaceThing: { description: "overlay loses" } } });
    expect(list.map((t) => t.name)).toEqual(["replace_thing"]);
    const t = list[0]!;
    expect(t.inputSchema.required).toEqual(["id", "body_id", "name"]);
    expect(props(t).name).toEqual({ type: "string", examples: ["x"] });
    expect(t.bindings).toContainEqual({ arg: "body_id", in: "body", name: "id" });
    expect(t.description).toContain("Agent note.");
    expect(t.description).not.toContain("overlay loses");
    expect(t.annotations).toMatchObject({ destructiveHint: true, idempotentHint: true });
  });
});

describe("filters", () => {
  test("--read-only keeps only GET tools", () => {
    const ro = buildTools(bundledSpec, { readOnly: true });
    expect(ro.length).toBe(operations(bundledSpec).filter((o) => o.method === "get").length);
    expect(ro.every((t) => t.method === "GET" && t.annotations.readOnlyHint)).toBe(true);
  });

  test("--toolsets filters by tag (case/punctuation-insensitive) and rejects unknown names", () => {
    const emails = buildTools(bundledSpec, { toolsets: ["emails"] });
    expect(emails.map((t) => t.name).sort()).toEqual(
      ["cancel_email", "get_email", "list_emails", "send_batch_emails", "send_email", "update_email"].sort(),
    );
    const keys = buildTools(bundledSpec, { toolsets: ["API Keys"] });
    expect(buildTools(bundledSpec, { toolsets: ["api-keys"] })).toEqual(keys);
    expect(keys.map((t) => t.name).sort()).toEqual(["create_api_key", "delete_api_key", "list_api_keys"]);
    expect(buildTools(bundledSpec, { toolsets: ["domains"], readOnly: true }).map((t) => t.name)).toEqual([
      "list_domains",
      "get_domain",
    ]);
    expect(() => buildTools(bundledSpec, { toolsets: ["nope"] })).toThrow(/Unknown toolset.*Available: apikeys/);
  });

  test("permission: sending_access keeps exactly the operations marked x-permission: sending_access", () => {
    const marked = operations(bundledSpec)
      .filter(({ op }) => op["x-permission"] === "sending_access")
      .map(({ op }) => snakeCase(op.operationId!));
    expect(marked.length).toBeGreaterThan(0);
    const sending = buildTools(bundledSpec, { permission: "sending_access" });
    expect(sending.map((t) => t.name).sort()).toEqual(marked.sort());
    expect(sending.every((t) => t.permission === "sending_access")).toBe(true);
    expect(buildTools(bundledSpec, { permission: "full_access" }).length).toBe(tools.length);
    expect(usableBy(tool("send_email"), "sending_access")).toBe(true);
    expect(usableBy(tool("list_domains"), "sending_access")).toBe(false);
    expect(usableBy(tool("list_domains"), "full_access")).toBe(true);
  });

  test("argDefaults make an argument optional", () => {
    const t = tool("send_email", buildTools(bundledSpec, { argDefaults: { send_email: { from: "A <a@acme.com>" } } }));
    expect(t.inputSchema.required).toEqual(["to", "subject"]);
    expect(props(t).from!.description).toContain('Defaults to "A <a@acme.com>"');
  });

  test("CLI flags and env", () => {
    expect(parseCli([], {})).toMatchObject({ readOnly: false, toolsets: undefined });
    expect(parseCli([], { SPACEPOST_READ_ONLY: "true", SPACEPOST_TOOLSETS: "emails, domains" })).toMatchObject({
      readOnly: true,
      toolsets: ["emails", "domains"],
    });
    expect(parseCli(["--read-only", "--toolsets", "tenants"], { SPACEPOST_TOOLSETS: "emails" })).toMatchObject({
      readOnly: true,
      toolsets: ["tenants"],
    });
    expect(parseCli(["--toolsets=a,b", "--list-tools"], {})).toMatchObject({ toolsets: ["a", "b"], listTools: true });
    expect(parseCli([], { SPACEPOST_READ_ONLY: "0" }).readOnly).toBe(false);
    expect(() => parseCli(["--bogus"], {})).toThrow(/Unknown option/);
    expect(parseCli(["--permission", "sending_access"], {}).permission).toBe("sending_access");
    expect(parseCli([], { SPACEPOST_PERMISSION: "sending_access" }).permission).toBe("sending_access");
    expect(() => parseCli(["--permission=admin"], {})).toThrow(/--permission/);
  });
});
