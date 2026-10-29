# SpacePost MCP server over stdio, built from this repo's source.
# The API key is read from the environment at runtime and never baked into the image:
#   docker build -t spacepost-mcp .
#   docker run -i --rm -e SPACEPOST_API_KEY=sp_live_... spacepost-mcp

FROM oven/bun:1-alpine AS build
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src ./src
RUN bun build src/index.ts --outfile dist/index.js --target node

FROM node:22-alpine
WORKDIR /app
# The build output is a single self-contained file (dependencies bundled), so the runtime image needs nothing else.
COPY --from=build /src/dist/index.js ./index.js
USER node
ENTRYPOINT ["node", "/app/index.js"]
