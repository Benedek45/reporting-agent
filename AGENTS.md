# AGENTS.md — reporting-agent

Living architecture + rules for this repository. Keep this file current: when a
decision, path, command, or constraint changes, update it in the same change
that introduced the change — not later.

---

## 1. What this is

A beta web app that wraps an AI agent around a specific, document-heavy task.
The first two tasks are **CSRD/ESRS** reporting and **voluntary ESG** reporting.

Flow for the end user (intended to be simple):

1. Pick a task (e.g. "CSRD / ESRS report").
2. Chat with an agent that interviews them, asks for source documents, and
   drafts the report.
3. The agent writes the report as Markdown, fact-checks the figures, and the
   app converts it to PDF/DOCX.

The agent must: ask questions, request multiple documents as needed, never
invent data, and attribute every figure to a source.

**The whole thing ships as one self-contained application** (`docker compose up`
→ open http://localhost:3000). opencode is only the internal engine; the end
user never sees or talks to it directly.

## 2. Architecture (the one decision that drives everything)

We do **not** build an agent loop. We run **opencode** as a headless backend and
drive it from our own UI. opencode already gives us the agentic loop, tool
calling, permissions, skills, and an MCP host. Compliance reporting is just
"read files + write files + web-search in a loop", which maps onto it directly.

The application is a **two-service Docker Compose project**:

```
              docker compose project: "reporting-agent"
  ┌──────────────────────────────────────────────────────────────┐
  │  app        Next.js UI + BFF        :3000  ◄── ONLY port       │
  │             (what the user opens)          published to host   │
  │                │ HTTP (internal compose network)               │
  │  opencode      agent engine         :4096  (internal only,     │
  │             (vendored, headless)           never published)    │
  │                ├─ agent: compliance (primary)                  │
  │                ├─ agent: fact-checker (subagent)               │
  │                ├─ skills: csrd-esrs, esg-reporting             │
  │                └─ MCP: doc-ingest, doc-generate, fact-check    │
  │                                                                │
  │  volume: workspaces ── mounted at /workspaces in BOTH ──       │
  │     <id>/uploads/  (client docs)   <id>/output/report.md       │
  └──────────────────────────────────────────────────────────────┘
```

- **Single Next.js app** is both the UI and the BFF (API route handlers).
- The BFF talks to opencode over its **REST API** (see §6), deliberately *not*
  through `@opencode-ai/sdk`, so we are not coupled to the generated SDK's exact
  shape. The endpoints we use are stable and few.
- **opencode is vendored** into `vendor/opencode` (see §4) so all code lives in
  this repo and is modifiable; the engine image is built from that source.
- **opencode runs in its own container** — defense-in-depth isolation from the
  host, it eliminates host-config collisions, and it sidesteps Windows native
  build toolchain problems. See §8.

### Verified end-to-end (2026-06)

Proven working inside the stack: `POST /api/sessions` provisions a per-session
workspace and binds an opencode session to it; `POST /api/chat` returns the
`compliance` agent's reply (~17s for the first turn) — it loads the `csrd-esrs`
skill and asks the user for the information/documents it needs **as plain text**;
and the agent writes `output/report.md` (ESRS-structured, `[DATA NEEDED: …]`
placeholders, zero fabricated numbers). The model `opencode-go/deepseek-v4-flash`
authenticates via the injected key.

## 3. Repository layout

> **On-disk location:** the repo root is `D:\AGI_gent\gold\gold` (nested one
> level under `D:\AGI_gent\gold`). It was deliberately moved down one level
> because the opencode instance used for development runs from
> `D:\AGI_gent\gold`. Keeping our project — which has its *own* `opencode.json`
> and `AGENTS.md` — at that same path collided with the dev opencode's config /
> instruction discovery (it walks the directory tree and picked up our files).
> Nesting the project in its own subdirectory isolates the two. All commands
> below assume the repo root `D:\AGI_gent\gold\gold` as the working directory.

```
docker-compose.yml         the full app: `app` + `opencode` + shared volume
docker/
  opencode.Dockerfile      engine image (vendored opencode, Linux, bun)
  app.Dockerfile           Next.js UI+BFF image (multi-stage build)
.dockerignore              keep build context lean (no node_modules/.git/.env)
opencode.json              opencode runtime config (model, agents, skills, MCP, permissions)
.env / .env.example        secrets + runtime config (.env is gitignored)
prompts/
  compliance.md            system prompt for the primary agent
  fact-checker.md          system prompt for the fact-checker subagent
.opencode/skills/
  csrd-esrs/SKILL.md       + assets/report-template.md
  esg-reporting/SKILL.md   + assets/report-template.md
mcp/
  doc-ingest/index.mjs     MCP stub: read/extract uploaded documents
  doc-generate/index.mjs   MCP stub: render report.md -> PDF/DOCX
  fact-check/index.mjs     MCP stub: verify claims via web search backend
src/
  app/
    page.tsx               task picker
    chat/[sessionId]/page.tsx   chat UI
    api/sessions/route.ts  POST: create session + provision workspace + bind dir
    api/chat/route.ts      POST: relay a message to opencode
    api/upload/route.ts    POST: save uploaded files into the workspace
    layout.tsx, globals.css
  lib/
    tasks.ts               task registry (csrd, esg -> agent + skill + template)
    opencode.ts            server-only REST client (createSession, sendMessage)
    workspace.ts           server-only FS helpers (provision/ensure, saveUpload)
  types/index.ts           shared types
vendor/opencode/           vendored opencode fork (MIT) — see §4
workspaces/                local placeholder (gitignored); real workspaces live
                           in the `workspaces` docker volume (see §8)
```

## 4. Vendored opencode fork

- Source: `https://github.com/anomalyco/opencode` — branch `dev`, pinned at
  commit `5d0f86606ac30690f79f0a6a9f41a1f49fe95d0b`. License: **MIT**.
- It is tracked as **plain source in this repo** (its upstream `.git` is
  removed). Treat it as our fork; record any upstream re-sync as a commit that
  notes the new upstream SHA.
- Toolchain: **Bun `1.3.14`** (`packageManager` in `vendor/opencode/package.json`).
- **In production it runs in the `opencode` container** (`docker/opencode.Dockerfile`),
  built `FROM oven/bun:1.3.14`, installing deps with `bun install --ignore-scripts`
  (skips native builds like tree-sitter/node-pty that the headless server does
  not need) and starting `bun run --conditions=browser packages/opencode/src/index.ts
  serve --hostname 0.0.0.0 --port 4096`.
- **Host dev (no Docker)** is still possible:
  ```
  npm run opencode:install      # HUSKY=0 bun install --cwd vendor/opencode
  npm run opencode:serve        # bun run --cwd vendor/opencode dev serve ...
  ```
  but the supported, reproducible path is Docker.
- **Gotcha — husky:** `bun install` runs the vendored `prepare: husky` script,
  which can try to install git hooks into *our* root repo. Install with husky
  disabled: `HUSKY=0` (the Dockerfile sets it; use it on the host too).
- **Gotcha — Windows native build:** a plain `bun install` on Windows fails
  compiling `tree-sitter-powershell` (needs Visual Studio C++). Use
  `--ignore-scripts` (the engine boots fine without those native modules) or
  just use the Linux container.
- **SDK:** the JS SDK lives at `vendor/opencode/packages/sdk/js`, generated from
  `vendor/opencode/packages/sdk/openapi.json`. We don't depend on it at runtime
  (we use REST), but `openapi.json` is the source of truth for endpoint shapes.
- **Strip candidates** (unused by us; safe to delete to slim the fork later):
  `packages/{tui,desktop,app,web,storybook,console,slack,enterprise,stats}`.

## 5. Model & secrets

- Provider `opencode-go`, model **`opencode-go/deepseek-v4-flash`** (paid,
  zero-retention, ~$0.14/$0.28 per 1M tokens). Used for the agent and for title
  generation (`small_model`).
- Do **not** use `opencode/deepseek-v4-flash-free` — its data may be used for
  training, which is unacceptable for confidential client documents.
- API key: env `OPENCODE_GO_API_KEY`, wired in `opencode.json` via
  `provider.opencode-go.options.apiKey = "{env:OPENCODE_GO_API_KEY}"`.
- In Docker the key reaches **only the `opencode` container**, via compose
  `env_file: .env`. The `app` container gets non-secret env only
  (`OPENCODE_SERVER_URL`, `WORKSPACES_ROOT`).
- `.env` holds the dev key and is **gitignored**. Never commit secrets. Never
  print the key in logs or tool output.

## 6. opencode REST endpoints the BFF uses

Base URL = `OPENCODE_SERVER_URL` (in Docker: `http://opencode:4096`; host dev:
`http://127.0.0.1:4096`).

- `POST /session?directory=<abs path>` `{title?}` → `Session{ id, directory, ... }`.
  The **working directory is a query param**, not a body field. It is persisted
  on the session and reused by later messages. We pass `/workspaces/<id>`.
- `POST /session/:id/message` `{agent?, model?, parts:[{type:"text",text}]}` →
  `{info, parts}` (assistant text is in `parts[].text` where `type==="text"`).
  **`model` is an object** `{providerID, modelID}` (e.g.
  `{providerID:"opencode-go", modelID:"deepseek-v4-flash"}`), not a string.
- `POST /session/:id/prompt_async` → `204` (fire-and-forget; needed for SSE).
- `GET /event` → SSE stream (for token streaming + interactive tools — not wired yet).
- `GET /agent` → lists configured agents (used to sanity-check config injection).

Config is injected into the engine via env (see docker-compose.yml):
`OPENCODE_CONFIG=/config/opencode.json`, `OPENCODE_CONFIG_DIR=/config/.opencode`,
`OPENCODE_DISABLE_PROJECT_CONFIG=true` (the last stops opencode walking the tree
and picking up stray configs — the original collision cause).

## 7. Agents, skills, MCP

- **Agents** (defined in `opencode.json`, prompts in `prompts/`):
  - `compliance` — primary, default. Interviews the user **in plain text**
    (the chat is the Q&A loop), reads `uploads/`, writes `output/report.md`,
    delegates verification to `fact-checker`. `bash` denied; sandboxed to the
    workspace (`external_directory: deny`).
  - `fact-checker` — read-only subagent; verifies figures/claims; can web-fetch.
- **No interactive `question` tool.** opencode's `question` tool *blocks* the
  synchronous `POST /message` call waiting for an answer the BFF can't supply
  yet, which hangs the request. So `permission.question: deny` for `compliance`
  and the prompt instructs it to ask in plain text. Re-enabling the structured
  question tool requires the async/SSE path (see §11).
- **Skills** (`.opencode/skills/<name>/SKILL.md`, loaded on demand by the native
  `skill` tool): `csrd-esrs`, `esg-reporting`. Each is **self-contained**; the
  report template in `assets/` is **copied into the session workspace** at
  init (the agent can't read repo files outside its sandbox — verified: it tries
  the bundled path, is denied, and falls back to the in-workspace copy).
- **MCP servers** (`mcp/`, declared in `opencode.json`, currently
  `enabled: false` — they are stubs):
  - `doc-ingest`: `list_uploads`, `extract_document` (PDF/DOCX/XLSX → text/tables)
  - `doc-generate`: `render_report` (report.md → PDF/DOCX)
  - `fact-check`: `verify_claim` (pluggable web-search backend)
  - To activate: install their deps **into the opencode image**, implement the
    handler, flip `enabled: true`. Note `node` may be absent in the bun image —
    launch them with `bun` or add node.

## 8. Per-session workspace isolation

- Real workspaces live in the **docker named volume `workspaces`**, mounted at
  `/workspaces` in **both** the `app` and `opencode` containers. Because both
  see the same path, BFF-written `uploads/` and agent-written `output/report.md`
  are the same files — no host/container path translation needed.
- Flow (in `src/app/api/sessions/route.ts`): generate a `workspaceId`
  (`crypto.randomUUID()`), `provisionWorkspace` it (`/workspaces/<uuid>/{uploads,
  output}` + copy the skill template into `output/report-template.md`), then
  `createSession(title, "/workspaces/<uuid>")` so the opencode session is bound
  to that directory via `?directory=`. A `/workspaces/.sessions/<sessionId>`
  file maps the opencode session id back to the workspace dir for the upload route.
- `WORKSPACES_ROOT` **must** be set to the same path the opencode engine sees
  (`/workspaces` in Docker). The host-dev default differs; Docker is the run model.
- The old "AGENTS.md walk-up leak" risk is now moot: the engine loads config via
  `OPENCODE_CONFIG`/`OPENCODE_CONFIG_DIR` with `OPENCODE_DISABLE_PROJECT_CONFIG=true`,
  and `external_directory: deny` keeps the agent inside its `/workspaces/<id>` dir.

## 9. Running it

- **Full app (supported):** `docker compose up --build` → open
  http://localhost:3000. Requires `.env` with `OPENCODE_GO_API_KEY`. Only the
  `app` port (3000) is published; the engine is internal.
- **Rebuild after code/config change:** `docker compose build app` (UI/BFF) or
  `docker compose build opencode` (engine); config/prompt/skill files are bind-
  mounted into the engine, so editing them only needs `docker compose restart
  opencode`.
- **Host dev (faster inner loop, less isolation):** run the engine via
  `npm run opencode:serve` and the UI via `npm run dev`; set `OPENCODE_SERVER_URL`
  and `WORKSPACES_ROOT` consistently.

## 10. Conventions & rules

- **Never fabricate data or regulatory content.** Missing figures → literal
  `[DATA NEEDED: ...]` placeholders. Exact ESRS/GRI datapoint IDs come from
  official EFRAG/GRI texts, never from memory.
- TypeScript strict, no `any`. Keep server-only code (fs, fetch to opencode,
  env) out of client components.
- Scaffold stubs are marked `// TODO(scaffold):`. Hardening items are marked
  `// TODO(harden):`. These are the only sanctioned placeholders; production
  code follows the global "no lazy shortcuts" rule.
- Secrets only in `.env`. Client documents only in the `workspaces` volume.

## 11. Git

- Single **private** repo (`Benedek45/reporting-agent`); `vendor/opencode`
  source is committed (its upstream `.git` removed). `.env`, `node_modules/`,
  `.next/`, the `workspaces` volume, and vendored build output are gitignored.
  The host-modified `vendor/opencode/bun.lock` is intentionally not committed
  (the image installs fresh).
- Conventional commit messages (`type(scope): summary`). Commit and push when a
  unit of work is complete.

## 12. Status & roadmap (deferred)

Done: scaffold, vendored opencode, the **containerized two-service app**, and an
**end-to-end verified** flow (agent interviews in text + writes `output/report.md`).
**Deferred** (not yet built):

- SSE token streaming in `/api/chat` (via `prompt_async` + `GET /event`), which
  also unlocks re-enabling the structured interactive `question` tool.
- Real implementations of `doc-ingest`, `doc-generate`, `fact-check` MCP servers
  (incl. installing their deps into the engine image).
- `/api/report` download route + the UI "Download report" button.
- Non-root container hardening (`USER` + `/workspaces` volume ownership),
  restricted egress (allow only the model API + fact-check domains), resource limits.
- Auth on the BFF routes (currently unauthenticated).
- Durable session↔workspace persistence (currently a file-backed `.sessions` map).
- Time/clock knowledge MCP (explicitly deferred by the product owner).
- Slimming the vendored fork (delete unused `packages/*`).
