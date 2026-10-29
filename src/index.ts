#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { helpText, parseCli } from "./cli.ts";
import { createFetchExecutor } from "./executor.ts";
import { bundledSpec, createServer, SERVER_VERSION } from "./server.ts";
import { buildTools } from "./tools.ts";

// stdout is the protocol channel, so every diagnostic goes to stderr. The API key is never printed.
let cli: ReturnType<typeof parseCli>;
let tools: ReturnType<typeof buildTools>;
const defaultFrom = process.env.SPACEPOST_DEFAULT_FROM;
const argDefaults = defaultFrom ? { send_email: { from: defaultFrom } } : undefined;
try {
  cli = parseCli(process.argv.slice(2), process.env);
  tools = buildTools(bundledSpec, { readOnly: cli.readOnly, toolsets: cli.toolsets, permission: cli.permission, argDefaults });
} catch (e) {
  console.error(`spacepost-mcp: ${(e as Error).message}`);
  process.exit(2);
}

if (cli.help) {
  console.log(helpText());
  process.exit(0);
}
if (cli.version) {
  console.log(SERVER_VERSION);
  process.exit(0);
}
if (cli.listTools) {
  for (const t of tools) console.log(`${t.name}\t${t.method} ${t.path}`);
  process.exit(0);
}

const apiKey = process.env.SPACEPOST_API_KEY;
if (!apiKey) {
  console.error(
    "spacepost-mcp: SPACEPOST_API_KEY is required. Create a key in the SpacePost dashboard and set it in the server's env.",
  );
  process.exit(1);
}

const execute = createFetchExecutor({
  baseUrl: process.env.SPACEPOST_BASE_URL || "https://api.spacepost.dev",
  authorization: `Bearer ${apiKey}`,
  userAgent: `spacepost-mcp/${SERVER_VERSION}`,
});
await createServer({ execute, tools, argDefaults }).connect(new StdioServerTransport());
