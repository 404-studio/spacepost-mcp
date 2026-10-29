/**
 * Refreshes src/generated/openapi.json from the published SpacePost OpenAPI document, so the stdio server works offline and its
 * tools match the API version it was built with. Run it before a release; `bun run build` uses the bundled file as it is.
 */
export const SPEC_URL = "https://api.spacepost.dev/openapi.json";
export const SPEC_JSON = new URL("../src/generated/openapi.json", import.meta.url).pathname;

if (import.meta.main) {
  const res = await fetch(SPEC_URL);
  if (!res.ok) throw new Error(`GET ${SPEC_URL}: HTTP ${res.status}`);
  await Bun.write(SPEC_JSON, `${JSON.stringify(await res.json(), null, 2)}\n`);
  console.log(`wrote ${SPEC_JSON}`);
}
