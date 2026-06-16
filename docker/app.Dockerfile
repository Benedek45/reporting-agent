# The product the user opens: Next.js UI + BFF. Talks to the opencode engine over
# the compose-internal network. Multi-stage: install -> build -> slim runtime.
# syntax=docker/dockerfile:1

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json next.config.mjs tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS run
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# Runtime needs: built output, deps, next config, and the skill report templates
# that the BFF copies into each session workspace at init (see lib/workspace.ts).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY package.json next.config.mjs ./
COPY .opencode ./.opencode
EXPOSE 3000
# TODO(harden): run as non-root (USER node) once /workspaces volume ownership is set.
CMD ["npm", "run", "start"]
