# Multi-stage build for the whole npm-workspaces monorepo. Build once from the repo root
# (needed so workspace symlinks — @x402-poc/shared → packages/agent, packages/service —
# resolve correctly), then run either the "service" or "agent" target.
#
#   docker build --target service -t x402-service .
#   docker build --target agent   -t x402-agent   .
#
# In practice, use docker-compose.yml instead — it builds both from this one Dockerfile.

FROM node:20-alpine AS base
WORKDIR /app

# Copy just the package manifests first so `npm ci` is cached across source-only changes.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/service/package.json packages/service/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY scripts/package.json scripts/package.json
# --ignore-scripts: the root "postinstall" script (builds packages/shared) needs actual source
# files, which aren't copied in yet at this point — only manifests, for layer caching. Run the
# build explicitly below instead, once the full source is present.
RUN npm ci --ignore-scripts

COPY . .

# Builds packages/shared's dist, packages/agent's browser wallet-bundle.js + dist, and
# packages/service's dist (see each package's "build" script and the root "build" script).
RUN npm run build

# Drop devDependencies (typescript, tsx, esbuild, @types/*, ...) now that build output exists —
# runtime only needs express, the x402/hedera packages, mongodb, etc.
RUN npm prune --omit=dev

FROM node:20-alpine AS service
WORKDIR /app
ENV NODE_ENV=production
COPY --from=base /app /app
EXPOSE 4021
CMD ["node", "packages/service/dist/server.js"]

FROM node:20-alpine AS agent
WORKDIR /app
ENV NODE_ENV=production
COPY --from=base /app /app
EXPOSE 3001
CMD ["node", "packages/agent/dist/server.js"]
