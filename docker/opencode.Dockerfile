# Internal agent engine: the vendored opencode fork, run headless.
# The end user never talks to this directly — only the `app` service does, over
# the compose-internal network. Built from source so it stays our modifiable fork.
# syntax=docker/dockerfile:1
FROM oven/bun:1.3.14

# git: opencode uses it for per-workspace snapshots/undo.
# ca-certificates: TLS to the model API and web fetch/fact-check.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps from the vendored source. `--ignore-scripts` skips native build
# steps (tree-sitter grammars, node-pty) that the headless server does not need;
# this keeps the image portable and the build fast. HUSKY=0 avoids git-hook setup.
ENV HUSKY=0
COPY vendor/opencode/ ./
RUN bun install --ignore-scripts

EXPOSE 4096

# Non-root hardening: the `bun` user is created by the oven/bun base image.
# The /workspaces volume is shared with the `app` container (which runs as `node`).
# We set group ownership to the bun GID and grant group-write so both containers
# can read/write the same files.
# FLAG: volume ownership must be verified after first `docker compose up --build`.
# If the app container (node user) cannot write to /workspaces, add a shared GID
# or set the volume directory permissions to 0777 in an init container.
RUN mkdir -p /workspaces && chown bun:bun /workspaces
USER bun

# Headless engine. Our config is mounted at /config and selected via
# OPENCODE_CONFIG / OPENCODE_CONFIG_DIR (see docker-compose.yml). Bind 0.0.0.0 so
# the `app` service can reach it on the internal network.
CMD ["bun", "run", "--conditions=browser", "packages/opencode/src/index.ts", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
