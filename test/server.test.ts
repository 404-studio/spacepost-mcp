import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildRequest, createFetchExecutor, type Execute } from "../src/executor.ts";
import { handleMcpHttp } from "../src/http.ts";
import { bundledSpec, createServer, type ServerOptions } from "../src/server.ts";
import { buildTools } from "../src/tools.ts";
import { connectHttpClient } from "./http-client.ts";

const KEY = "sp_live_TESTKEYtestkey0123456789abcdefgh";
type Seen = { url: string; method: string; headers: Record<string, string>; body: unknown };

/** A fetch executor against a fake API that records each request. */
function fakeApi(
  reply: (r: Seen) => { status: number; json?: unknown; text?: string } = () => ({ status: 200, json: { id: "x" } }),
) {
  const seen: Seen[] = [];
  const execute = createFetchExecutor({
    baseUrl: "http://api.test/",
    authorization: `Bearer ${KEY}`,
    userAgent: "spacepost-mcp/test",
    fetch: async (req) => {
      const text = await req.text();
      const s: Seen = {
        url: req.url,
        method: req.method,
        headers: Object.fromEntries(req.headers),
        body: text ? JSON.parse(text) : undefined,
      };
      seen.push(s);
      const r = reply(s);
      return new Response(r.text ?? JSON.stringify(r.json), { status: r.status });
    },
  });
  return { seen, execute };
}

async function connect(opts: Omit<ServerOptions, "execute"> & { execute: Execute }) {
  const server = createServer(opts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  return mcp;
}

const texts = (r: unknown) => (r as { content: { text: string }[] }).content.map((c) => c.text);
const tool = (name: string) => buildTools(bundledSpec).find((t) => t.name === name)!;

describe("buildRequest", () => {
  test("substitutes and encodes path params, collects query, header and body", () => {
    expect(buildRequest(tool("delete_suppression"), { id_or_email: "a+b@x.com" })).toEqual({
      method: "DELETE",
      path: "/suppressions/a%2Bb%40x.com",
      query: [],
      headers: {},
    });
    expect(buildRequest(tool("list_contacts"), { audience_id: "aud-1", limit: 5 })).toEqual({
      method: "GET",
      path: "/audiences/aud-1/contacts",
      query: [["limit", "5"]],
      headers: {},
    });
    expect(
      buildRequest(tool("send_email"), {
        idempotency_key: "k1",
        from: "a@acme.com",
        to: ["u@example.com"],
        subject: "Hi",
        text: "yo",
      }),
    ).toEqual({
      method: "POST",
      path: "/emails",
      query: [],
      headers: { "Idempotency-Key": "k1" },
      body: { from: "a@acme.com", to: ["u@example.com"], subject: "Hi", text: "yo" },
    });
    const batch = [{ from: "a@acme.com", to: "u@example.com", subject: "s", text: "t" }];
    expect(buildRequest(tool("send_batch_emails"), { body: batch }).body).toEqual(batch);
    // Declared-but-empty body is sent as {}; operations without a body send none.
    expect(buildRequest(tool("send_broadcast"), { id: "b1" }).body).toEqual({});
    expect(buildRequest(tool("cancel_email"), { id: "e1" })).not.toHaveProperty("body");
    // Explicit null passes through (daily_limit: null removes a tenant's cap).
    expect(buildRequest(tool("update_tenant"), { ref: "t1", daily_limit: null }).body).toEqual({ daily_limit: null });
  });

  test("rejects unknown and missing arguments", () => {
    expect(() => buildRequest(tool("get_email"), { id: "1", replyTo: "x" })).toThrow(/Unknown argument.*replyTo/);
    expect(() => buildRequest(tool("get_email"), {})).toThrow(/Missing required argument.*id/);
  });
});

describe("stdio-style server (in-memory transport)", () => {
  test("lists every generated tool with JSON Schema input and annotations", async () => {
    const mcp = await connect({ execute: fakeApi().execute });
    const { tools } = await mcp.listTools();
    expect(tools.length).toBe(buildTools(bundledSpec).length);
    const send = tools.find((t) => t.name === "send_email")!;
    expect(send.annotations).toMatchObject({ openWorldHint: true, readOnlyHint: false });
    expect(send.inputSchema.required).toEqual(["from", "to", "subject"]);
  });

  test("send_email: method, URL, auth, idempotency header, body and the default sender", async () => {
    const api = fakeApi();
    const mcp = await connect({ execute: api.execute, argDefaults: { send_email: { from: "Acme <hi@acme.com>" } } });
    const res = await mcp.callTool({
      name: "send_email",
      arguments: { to: "u@example.com", subject: "Hi", text: "yo", tags: [{ name: "k", value: "v" }], idempotency_key: "abc" },
    });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(texts(res)[0]!)).toEqual({ id: "x" });
    expect(res.structuredContent).toEqual({ id: "x" });
    const call = api.seen[0]!;
    expect(call).toMatchObject({ url: "http://api.test/emails", method: "POST" });
    expect(call.headers).toMatchObject({
      authorization: `Bearer ${KEY}`,
      "idempotency-key": "abc",
      "content-type": "application/json",
      "user-agent": "spacepost-mcp/test",
    });
    expect(call.body).toEqual({
      from: "Acme <hi@acme.com>",
      to: "u@example.com",
      subject: "Hi",
      text: "yo",
      tags: [{ name: "k", value: "v" }],
    });
  });

  test("GET with query params", async () => {
    const api = fakeApi(() => ({ status: 200, json: { object: "list", has_more: false, data: [] } }));
    const mcp = await connect({ execute: api.execute });
    await mcp.callTool({ name: "list_emails", arguments: { limit: 2, after: "0198" } });
    expect(api.seen[0]).toMatchObject({ url: "http://api.test/emails?limit=2&after=0198", method: "GET", body: undefined });
  });

  test("API errors come back as isError with the Resend-style body and a hint", async () => {
    const err = { statusCode: 403, name: "invalid_from_address", message: "Domain not verified" };
    const mcp = await connect({ execute: fakeApi(() => ({ status: 403, json: err })).execute });
    const res = await mcp.callTool({
      name: "send_email",
      arguments: { from: "a@nope.com", to: "u@example.com", subject: "s", text: "t" },
    });
    expect(res.isError).toBe(true);
    expect(JSON.parse(texts(res)[0]!)).toEqual(err);
    expect(texts(res)[1]).toContain("list_domains");

    const html = await connect({ execute: fakeApi(() => ({ status: 502, text: "Bad gateway" })).execute });
    const r2 = await html.callTool({ name: "list_domains", arguments: {} });
    expect(r2.isError).toBe(true);
    expect(JSON.parse(texts(r2)[0]!)).toEqual({ statusCode: 502, name: "application_error", message: "Bad gateway" });
  });

  test("argument errors, unknown tools and network failures are isError results", async () => {
    const mcp = await connect({
      execute: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    const bad = await mcp.callTool({ name: "get_domain", arguments: {} });
    expect(bad.isError).toBe(true);
    expect(JSON.parse(texts(bad)[0]!).name).toBe("validation_error");
    expect((await mcp.callTool({ name: "nope", arguments: {} })).isError).toBe(true);
    const down = await mcp.callTool({ name: "list_domains", arguments: {} });
    expect(down.isError).toBe(true);
    expect(texts(down)[0]).toContain("ECONNREFUSED");
  });

  describe("logging", () => {
    const logged: string[] = [];
    const originals = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
    beforeEach(() => {
      logged.length = 0;
      for (const k of Object.keys(originals) as (keyof typeof originals)[])
        console[k] = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    });
    afterEach(() => Object.assign(console, originals));

    test("the API key never appears in logs or tool results", async () => {
      const outputs: string[] = [];
      for (const status of [200, 401, 500]) {
        const mcp = await connect({
          execute: fakeApi(() => ({ status, json: { name: "invalid_api_key", message: "nope" } })).execute,
        });
        outputs.push(JSON.stringify(await mcp.callTool({ name: "list_domains", arguments: {} })));
        outputs.push(JSON.stringify(await mcp.callTool({ name: "get_domain", arguments: { id: KEY.slice(0, 3) } })));
      }
      const failing = await connect({
        execute: async () => {
          throw new Error("boom");
        },
      });
      outputs.push(JSON.stringify(await failing.callTool({ name: "list_domains", arguments: {} })));
      expect([...logged, ...outputs].join("\n")).not.toContain(KEY);
    });
  });
});

describe("hosted handler (Streamable HTTP, stateless)", () => {
  test("initialize, tools/list and tools/call over HTTP; options from the query string", async () => {
    const api = fakeApi(() => ({ status: 200, json: { object: "list", has_more: false, data: [{ id: "d1" }] } }));
    const handler = (req: Request) => handleMcpHttp(req, { execute: api.execute });
    const mcp = await connectHttpClient("http://api.test/mcp", handler);
    expect((await mcp.listTools()).tools.length).toBe(buildTools(bundledSpec).length);
    const res = await mcp.callTool({ name: "list_domains", arguments: {} });
    expect(res.structuredContent).toMatchObject({ data: [{ id: "d1" }] });

    const ro = await connectHttpClient("http://api.test/mcp?read_only=true&toolsets=domains", handler);
    expect((await ro.listTools()).tools.map((t) => t.name)).toEqual(["list_domains", "get_domain"]);
  });

  test("permission narrows tools/list but leaves enforcement of other tools to the API", async () => {
    const api = fakeApi(() => ({ status: 401, json: { statusCode: 401, name: "restricted_api_key", message: "send only" } }));
    const mcp = await connectHttpClient("http://api.test/mcp", (req) =>
      handleMcpHttp(req, { execute: api.execute, permission: "sending_access" }),
    );
    const listed = (await mcp.listTools()).tools.map((t) => t.name).sort();
    expect(listed).toEqual(
      buildTools(bundledSpec, { permission: "sending_access" })
        .map((t) => t.name)
        .sort(),
    );
    expect(listed).not.toContain("list_domains");
    const res = await mcp.callTool({ name: "list_domains", arguments: {} });
    expect(api.seen[0]).toMatchObject({ method: "GET", url: "http://api.test/domains" });
    expect(res.isError).toBe(true);
    expect(JSON.parse(texts(res)[0]!).name).toBe("restricted_api_key");
  });

  test("GET and DELETE are 405 in stateless mode; a bad toolset is a 400", async () => {
    const execute = fakeApi().execute;
    for (const method of ["GET", "DELETE"]) {
      const r = await handleMcpHttp(new Request("http://api.test/mcp", { method }), { execute });
      expect(r.status).toBe(405);
      expect(r.headers.get("allow")).toBe("POST");
    }
    const bad = await handleMcpHttp(
      new Request("http://api.test/mcp?toolsets=nope", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
      { execute },
    );
    expect(bad.status).toBe(400);
  });
});
