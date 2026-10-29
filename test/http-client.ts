import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * An MCP client over Streamable HTTP whose requests go to `handler` (an in-process app) instead of the network.
 */
export async function connectHttpClient(
  url: string,
  handler: (request: Request) => Response | Promise<Response>,
  headers: Record<string, string> = {},
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
    fetch: async (input, init) => handler(new Request(input, init)),
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  return client;
}
