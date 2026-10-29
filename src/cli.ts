import { availableToolsets, type KeyPermission } from "./tools.ts";
import { bundledSpec, SERVER_VERSION } from "./server.ts";

/** Parsed command line + environment for the stdio server. Flags win over env. */
export interface CliOptions {
  help: boolean;
  version: boolean;
  listTools: boolean;
  readOnly: boolean;
  toolsets?: string[];
  permission?: KeyPermission;
}

function permission(v: string | undefined): KeyPermission | undefined {
  if (v === undefined || v === "") return undefined;
  if (v === "full_access" || v === "sending_access") return v;
  throw new Error(`--permission must be full_access or sending_access, got ${v}`);
}

const truthy = (v: string | undefined) => v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
const list = (v: string | undefined) =>
  v
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function parseCli(argv: string[], env: Record<string, string | undefined>): CliOptions {
  const opts: CliOptions = {
    help: false,
    version: false,
    listTools: false,
    readOnly: truthy(env.SPACEPOST_READ_ONLY),
    toolsets: list(env.SPACEPOST_TOOLSETS),
    permission: permission(env.SPACEPOST_PERMISSION),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--version" || a === "-v") opts.version = true;
    else if (a === "--list-tools") opts.listTools = true;
    else if (a === "--read-only") opts.readOnly = true;
    else if (a === "--toolsets") opts.toolsets = list(argv[++i]);
    else if (a.startsWith("--toolsets=")) opts.toolsets = list(a.slice("--toolsets=".length));
    else if (a === "--permission") opts.permission = permission(argv[++i]);
    else if (a.startsWith("--permission=")) opts.permission = permission(a.slice("--permission=".length));
    else throw new Error(`Unknown option ${a}. See --help.`);
  }
  return opts;
}

export function helpText(): string {
  return `spacepost-mcp ${SERVER_VERSION}: SpacePost MCP server (stdio). One tool per SpacePost API endpoint.

Usage: spacepost-mcp [--read-only] [--toolsets emails,domains] [--permission sending_access] [--list-tools]

Options:
  --read-only            Only expose read tools (GET endpoints).              env SPACEPOST_READ_ONLY=true
  --toolsets <a,b,...>   Only expose these API areas (OpenAPI tags).          env SPACEPOST_TOOLSETS=emails,domains
                         Available: ${availableToolsets(bundledSpec).join(", ")}
  --permission <p>       sending_access: only the tools a sending_access key   env SPACEPOST_PERMISSION
                         can use (send_email, send_batch_emails).
  --list-tools           Print the tool names for the given options and exit.
  -h, --help             Show this help.   -v, --version   Print the version.

Environment:
  SPACEPOST_API_KEY      Required. Your API key (sp_live_...).
  SPACEPOST_BASE_URL     API base URL, default https://api.spacepost.dev
  SPACEPOST_DEFAULT_FROM Sender used when send_email is called without \`from\`.

Hosted alternative (no install): https://api.spacepost.dev/mcp with "Authorization: Bearer <key>".`;
}
