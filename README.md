<img src="https://spacepost.dev/brand/app-icon-128.png" width="56" height="56" alt="SpacePost">

# @spacepost/mcp

An [MCP](https://modelcontextprotocol.io) server that gives AI assistants the whole SpacePost API: one tool per endpoint of the
[API reference](https://docs.spacepost.dev/api-reference/), generated from the OpenAPI document. New API features become MCP
tools automatically. Docs: https://docs.spacepost.dev/tools/mcp/

[SpacePost](https://spacepost.dev) is a Resend-compatible transactional email API on Amazon SES (EU company), with an SMTP relay
and this MCP server.

Two ways to use it:

- **Hosted**: `https://api.spacepost.dev/mcp` (Streamable HTTP) with `Authorization: Bearer sp_live_...`. Nothing to install.
- **Local (this package)**: `npx -y @spacepost/mcp`, stdio. The spec is bundled, so it starts offline.

Create an API key in the [SpacePost dashboard](https://app.spacepost.dev). In the official MCP Registry the server is
[`dev.spacepost/mcp`](https://registry.modelcontextprotocol.io/v0/servers?search=dev.spacepost/mcp); on npm it is
[`@spacepost/mcp`](https://www.npmjs.com/package/@spacepost/mcp).

## Configuration

| Env                      |                                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `SPACEPOST_API_KEY`      | Required. The assistant has exactly this key's permissions (`sending_access` keys can only send).     |
| `SPACEPOST_BASE_URL`     | Optional, default `https://api.spacepost.dev`                                                         |
| `SPACEPOST_DEFAULT_FROM` | Optional sender (e.g. `Acme <hi@acme.com>`) used when `send_email` has no `from`                      |
| `SPACEPOST_READ_ONLY`    | `true` = `--read-only`                                                                                |
| `SPACEPOST_TOOLSETS`     | = `--toolsets`                                                                                        |
| `SPACEPOST_PERMISSION`   | = `--permission`                                                                                      |

| Flag                     |                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `--read-only`            | Only tools for GET endpoints                                                                                          |
| `--toolsets a,b`         | Only these API areas (OpenAPI tags): emails, domains, apikeys, webhooks, audiences, contacts, broadcasts, suppressions, tenants |
| `--permission sending_access` | Only tools a send-only key can use (operations with `x-permission: sending_access`)               |
| `--list-tools`           | Print the tools for the given options and exit                                                                        |
| `--help`, `--version`    |                                                                                                                       |

The hosted endpoint takes the same options as query parameters: `/mcp?read_only=true&toolsets=emails,domains`. It derives the
permission filter from the caller's key: `sending_access` keys see only the sending tools in `tools/list`. Other tools are not
blocked by MCP; calling one goes to the API, which answers `restricted_api_key` as it does for REST.

### Claude Code

```bash
# hosted
claude mcp add --transport http spacepost https://api.spacepost.dev/mcp --header "Authorization: Bearer sp_live_..."
# local
claude mcp add spacepost -e SPACEPOST_API_KEY=sp_live_... -e SPACEPOST_DEFAULT_FROM="Acme <hi@acme.com>" -- npx -y @spacepost/mcp
```

### Cursor (`~/.cursor/mcp.json` or `.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "spacepost": { "url": "https://api.spacepost.dev/mcp", "headers": { "Authorization": "Bearer sp_live_..." } }
  }
}
```

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "spacepost": {
      "command": "npx",
      "args": ["-y", "@spacepost/mcp"],
      "env": { "SPACEPOST_API_KEY": "sp_live_...", "SPACEPOST_DEFAULT_FROM": "Acme <hi@acme.com>" }
    }
  }
}
```

## How tools are built

- Name: `operationId` in snake_case (`sendEmail` → `send_email`, `getBroadcastReadiness` → `get_broadcast_readiness`). The 12
  hand-written tools of 0.1 keep their names.
- Input: one flat JSON Schema object with path params (snake_case: `audience_id`, `id_or_email`), query params, header params
  (`Idempotency-Key` → `idempotency_key`) and the top-level JSON body fields. A body field that collides with a parameter name is
  exposed as `body_<field>`; a non-object body (the batch array) as `body`. `$ref`/`allOf` are inlined; enums, formats, patterns,
  bounds, defaults and descriptions are kept.
- Description: summary + description from the spec, curated extras, the key permission and the HTTP route.
- Annotations: GET → `readOnlyHint`; DELETE → `destructiveHint`; GET/PUT/DELETE → `idempotentHint`; overridable per operation.
- Result: the API's JSON (text + `structuredContent`). Errors: `isError: true` with the Resend-style
  `{ statusCode, name, message }` body and a hint.

### Tuning a tool

Tools follow the API's OpenAPI document. Operations carry these extensions (set by SpacePost in the spec):

```yaml
x-mcp: { hidden: false, description: "Extra guidance for agents.", destructive: true, idempotent: true, openWorld: true }
x-permission: sending_access # only on operations a sending_access key may call
```

`src/overlay.ts` (keyed by operationId) holds the few curated descriptions that are about using a tool well rather than the
API itself; `x-mcp` wins when both set a field.

## Development

```bash
bun install
bun run build     # dist/index.js, spec included
bun test
bun run generate  # refresh src/generated/openapi.json from https://api.spacepost.dev/openapi.json
```

Issues and pull requests are welcome. Security reports: security@spacepost.dev.

0.2 breaking changes: results are the raw API JSON instead of short text summaries, and `verify_domain` returns the verify
response (call `get_domain` for the new status).

## License

MIT, see [LICENSE](LICENSE). © Studio 404 d.o.o.
