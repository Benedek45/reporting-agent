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

## 2. Architecture (the one decision that drives everything)

We do **not** build an agent loop. We run **opencode** as a headless backend and
drive it from our own UI. opencode already gives us the agentic loop, tool
calling, permissions, skills, and an MCP host. Compliance reporting is just
"read files + write files + web-search in a loop", which maps onto it directly.

```
Browser ──HTTP──► Next.js app (UI + BFF)  ──REST──►  opencode server (headless)
                                                       ├─ agent: compliance (primary)
                                                       ├─ agent: fact-checker (subagent)
                                                       ├─ skills: csrd-esrs, esg-reporting
                                                       └─ MCP: doc-ingest, doc-generate, fact-check
                          │
                          └─ per-session workspace dir (uploads/, output/report.md)
```

- **Single Next.js app** is both the UI and the BFF (API route handlers).
- The BFF talks to opencode over its **REST API** (see §6), deliberately *not*
  through `@opencode-ai/sdk`, so we are not coupled to the generated SDK's exact
  shape. The endpoints we use are stable and few.
- **opencode is vendored** into `vendor/opencode` (see §4) so all code lives in
  this repo and is modifiable.

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
    api/sessions/route.ts  POST: create session + provision workspace
    api/chat/route.ts      POST: relay a message to opencode
    api/upload/route.ts    POST: save uploaded files into the workspace
    layout.tsx, globals.css
  lib/
    tasks.ts               task registry (csrd, esg -> agent + skill + template)
    opencode.ts            server-only REST client (createSession, sendMessage)
    workspace.ts           server-only FS helpers (ensureWorkspace, saveUpload)
  types/index.ts           shared types
vendor/opencode/           vendored opencode fork (MIT) — see §4
workspaces/                local default for per-session workspaces (gitignored)
```

## 4. Vendored opencode fork

- Source: `https://github.com/anomalyco/opencode` — branch `dev`, pinned at
  commit `5d0f86606ac30690f79f0a6a9f41a1f49fe95d0b`. License: **MIT**.
- It is tracked as **plain source in this repo** (its upstream `.git` is
  removed). Treat it as our fork; record any upstream re-sync as a commit that
  notes the new upstream SHA.
- Toolchain: **Bun `1.3.14`** (`packageManager` in `vendor/opencode/package.json`).
- Run the headless server from source:
  ```
  npm run opencode:install      # bun install --cwd vendor/opencode   (first time)
  npm run opencode:serve        # bun run --cwd vendor/opencode dev serve --port 4096 ...
  ```
- **Gotcha — husky:** `bun install` runs the vendored `prepare: husky` script,
  which can try to install git hooks into *our* root repo. Install with husky
  disabled: `HUSKY=0 npm run opencode:install` (or `HUSKY=0 bun install --cwd vendor/opencode`).
- **SDK:** the JS SDK lives at `vendor/opencode/packages/sdk/js` and is generated
  from `vendor/opencode/packages/sdk/openapi.json` via
  `./packages/sdk/js/script/build.ts`. We don't depend on it at runtime (we use
  REST), but it's the source of truth for endpoint shapes.
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
- `.env` holds the dev key and is **gitignored**. Never commit secrets. Never
  print the key in logs or tool output.

## 6. opencode REST endpoints the BFF uses

Base URL = `OPENCODE_SERVER_URL` (default `http://127.0.0.1:4096`).

- `POST /session` `{title?}` → `Session{ id, ... }`
- `POST /session/:id/message` `{model?, agent?, parts:[{type:"text",text}]}` →
  `{info, parts}` (assistant text is in `parts[].text` where `type==="text"`)
- `POST /session/:id/prompt_async` → `204` (fire-and-forget)
- `GET /event` → SSE stream (for token streaming — not wired yet)
- `POST /session/:id/permissions/:permissionID` `{response, remember?}`

## 7. Agents, skills, MCP

- **Agents** (defined in `opencode.json`, prompts in `prompts/`):
  - `compliance` — primary, default. Interviews via the `question` tool, reads
    `uploads/`, writes `output/report.md`, delegates verification to
    `fact-checker`. `bash` denied; sandboxed to the workspace
    (`external_directory: deny`).
  - `fact-checker` — read-only subagent; verifies figures/claims; can web-fetch.
- **Skills** (`.opencode/skills/<name>/SKILL.md`, loaded on demand by the native
  `skill` tool): `csrd-esrs`, `esg-reporting`. Each is **self-contained**; the
  report template in `assets/` is **copied into the session workspace** at
  init (the agent can't read repo files outside its sandbox).
- **MCP servers** (`mcp/`, declared in `opencode.json`, currently
  `enabled: false` — they are stubs):
  - `doc-ingest`: `list_uploads`, `extract_document` (PDF/DOCX/XLSX → text/tables)
  - `doc-generate`: `render_report` (report.md → PDF/DOCX)
  - `fact-check`: `verify_claim` (pluggable web-search backend)
  - To activate: `npm install` (adds `@modelcontextprotocol/sdk`, `zod`),
    implement the handler, flip `enabled: true`.

## 8. Per-session workspace isolation

- Each session gets a workspace under `WORKSPACES_ROOT` (env; default
  `../reporting-agent-workspaces`, **outside** this repo). With the repo root at
  `D:\AGI_gent\gold\gold`, that default resolves to
  `D:\AGI_gent\gold\reporting-agent-workspaces` — a sibling of the repo, still
  outside it.
- It is outside the repo on purpose: opencode auto-loads any `AGENTS.md` it finds
  by walking up from the cwd. If the workspace were inside this repo, *this*
  dev-facing AGENTS.md would leak into the agent's runtime context. Keep
  workspaces external.
- Layout: `<workspace>/uploads/` (client docs), `<workspace>/output/report.md`
  (the deliverable), `<workspace>/output/report-template.md` (copied from the
  task's skill).

## 9. Conventions & rules

- **Never fabricate data or regulatory content.** Missing figures → literal
  `[DATA NEEDED: ...]` placeholders. Exact ESRS/GRI datapoint IDs come from
  official EFRAG/GRI texts, never from memory.
- TypeScript strict, no `any`. Keep server-only code (fs, fetch to opencode,
  env) out of client components.
- Scaffold stubs are marked `// TODO(scaffold):`. These are the only sanctioned
  placeholders; production code follows the global "no lazy shortcuts" rule.
- Secrets only in `.env`. Client documents only in `workspaces/` (gitignored).

## 10. Git

- Single **private** repo; `vendor/opencode` source is committed (its upstream
  `.git` removed). `.env`, `node_modules/`, `.next/`, `workspaces/`, and
  vendored build output are gitignored.
- Conventional commit messages (`type(scope): summary`). Commit and push when a
  unit of work is complete.

## 11. Status & roadmap (deferred)

Scaffold is complete: config, prompts, skills + templates, MCP stubs, Next.js
UI/BFF skeleton, vendored opencode. **Deferred** (not yet built):

- Time/clock knowledge MCP (explicitly deferred by the product owner).
- Real implementations of `doc-ingest`, `doc-generate`, `fact-check`.
- SSE token streaming in `/api/chat` (via `GET /event`).
- `/api/report` download route + the UI "Download report" button.
- Auth on the BFF routes (currently unauthenticated).
- Session↔workspace persistence (currently the workspace dir is named by the
  opencode session id).
- Slimming the vendored fork (delete unused `packages/*`).
