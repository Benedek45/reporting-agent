# AGENTS.md — reporting-agent

Living architecture + rules for this repository. Keep this file current: when a
decision, path, command, or constraint changes, update it in the same change
that introduced the change — not later.

---

## 1. What this is

A beta web app that wraps an AI agent around a specific, document-heavy task.
The first two tasks are **CSRD/ESRS** reporting and **voluntary ESG** reporting.

Flow for the end user (intended to be simple):

1. Pick a **goal** from a dropdown (goals are Markdown files in `goals/`).
2. Chat with an agent that interviews them and asks for source documents.
3. Upload documents (drag-and-drop). They are **converted to Markdown
   automatically on upload** (the model only reads text), so the agent can read
   them. A "Load full file into context" button injects a whole file (size-capped).
4. The agent drafts the report as Markdown, fact-checks figures, and the app
   converts it to PDF/DOCX.

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
  │                ├─ plugin: report-compaction (MIT)              │
  │                └─ MCP: workspace(delete) · time · fact-check   │
  │  converter     MarkItDown -> Markdown   :8000 (internal, MIT)  │
  │                                                                │
  │  volume: workspaces ── mounted at /workspaces in app+opencode  │
  │     <id>/goal.md  <id>/uploads/*(+.md)  <id>/output/report.md  │
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

Also verified (2026-06): the home page renders the **goal dropdown** from
`goals/*.md`; session create writes `goal.md`; uploading a non-text file routes
through the **`converter`** service and a Markdown sidecar (`uploads/<name>.md`)
appears (an HTML table became a Markdown table); the agent reads it; the **"Load
full file into context"** button (`/api/context`) injects the file's markdown;
and the engine boots clean with the `report-compaction` plugin present.

Also verified (2026-06, UI/feature pass): **SSE streaming** (`/api/chat/stream`)
renders token-by-token with a thinking animation + timer and a live **%-context
meter** (deepseek-v4-flash = **1,000,000** token context); the left **"documents in
the environment"** sidebar lists the workspace and downloads any file as its
original / `.md` / **PDF** / **DOCX** (magic bytes verified `%PDF` / `PK`); a file
is **directly deletable only before the next message** (otherwise `409` → ask the
model, which calls the `workspace_delete_file` MCP tool — verified removing a file
end-to-end); and the model's **reasoning is kept out of the answer bubble** (routed
to the Thinking box).

Also verified (2026-06, UI/feature pass 2 — Playwright + API): the **`time` MCP**
(`time_get_current_time`) and **`fact-check` MCP** (`fact-check_verify_claim`,
Tavily-backed; returns `NEEDS_CONFIG` without `FACTCHECK_API_KEY`, and the agent
then falls back to web-fetch) stream into **one expandable tool activity line**
per assistant turn (Anthropic-style; expand to inspect individual tool calls);
**assistant markdown is rendered** (react-markdown + remark-gfm — bold/tables);
the **single context bar shows an approximate breakdown** (System & tools / Documents /
Reasoning / Conversation); **dark mode** toggles + persists (`data-theme`);
**timestamps + pin** on every message; the **Documents sidebar groups Environment
(uploads) vs Output (report)** and **goal.md is hidden** (its content is injected
into the per-turn `system` instead, see §7); the **welcome message** renders
client-side so the chat is never empty; **re-uploading a file replaces it and a
real unified diff is sent to the agent** (text-file baseline bug fixed — capture
old source before overwrite); the chat composer now uses a normal consumer-chat
layout (full-width pill input + in-composer stop); and noisy internal permission
errors are hidden from non-technical users. API-tested: `time_get_current_time`,
`fact-check_verify_claim`, file replacement diff, and Hungarian first-turn setup
without internal step narration or permission errors. Built/streamed but not yet
click-tested: **stop** (`/api/chat/abort`), **edit-a-previous-message** (`revert` +
re-prompt), **report preview** content, and **pin-navigate**.

## 3. Repository layout

> **On-disk location & the AGENTS.md hardlink:** the repo root is
> `D:\AGI_gent\gold\gold`, nested one level under `D:\AGI_gent\gold`. The project
> was moved down one level because the opencode instance used for development
> runs from `D:\AGI_gent\gold`; keeping our **`opencode.json` / `.opencode/`** at
> that path collided with the dev opencode's config discovery. Those config files
> must stay nested for that reason.
>
> `AGENTS.md` is the deliberate exception. It is tracked in the repo at
> `D:\AGI_gent\gold\gold\AGENTS.md` **and hardlinked** to
> `D:\AGI_gent\gold\AGENTS.md` — one NTFS inode, one set of bytes, two directory
> entries (not two copies). This lets it load into the dev agent's context (whose
> working directory is `D:\AGI_gent\gold`) while staying version-controlled.
> Editing either path edits the single underlying file. If a tool ever replaces
> the file and breaks the link, recreate it from the repo (the source of truth):
> `cmd /c mklink /H "D:\AGI_gent\gold\AGENTS.md" "D:\AGI_gent\gold\gold\AGENTS.md"`.
> All commands below assume the repo root `D:\AGI_gent\gold\gold` as the working
> directory.

```
docker-compose.yml         the full app: app + opencode + converter + volume
docker-compose.dcp.yml     OPT-IN overlay: enable the AGPL DCP plugin (not bundled)
docker/
  opencode.Dockerfile      engine image (vendored opencode, Linux, bun)
  app.Dockerfile           Next.js UI+BFF image (multi-stage build)
  converter.Dockerfile     MarkItDown document->markdown service (python, MIT)
.dockerignore              keep build context lean (no node_modules/.git/.env)
converter/app.py           FastAPI /convert (MarkItDown) + /render (md->PDF/DOCX) + /health
goals/
  goal_csrd_esrs.md        a selectable goal (frontmatter id/title/agent/skill/template)
  goal_esg.md
  goal_test.md             developer-only tool self-test goal
scripts/enable-dcp.{sh,ps1}  one-command opt-in for the AGPL DCP plugin
opencode.json              opencode runtime config (model, agents, skills, MCP, permissions)
.env / .env.example        secrets + runtime config (.env is gitignored)
prompts/
  compliance.md            system prompt for the primary agent
  fact-checker.md          system prompt for the fact-checker subagent
.opencode/skills/
  csrd-esrs/SKILL.md       + assets/report-template.md
  esg-reporting/SKILL.md   + assets/report-template.md
.opencode/plugins/
  report-compaction.js     MIT plugin: inject goal+STATUS+[DATA NEEDED] at compaction
mcp/
  workspace/index.mjs      MCP (ENABLED, zero-dep): delete_file under /workspaces
  time/index.mjs           MCP (ENABLED, zero-dep): current date/time only
  fact-check/index.mjs     MCP (ENABLED, zero-dep): Tavily-backed verify_claim
  doc-generate/index.mjs   MCP stub: SUPERSEDED by converter /render (md->PDF/DOCX)
  doc-ingest/index.mjs     stub, SUPERSEDED by the converter service (safe to delete)
src/
  app/
    page.tsx               goal dropdown (server) + _components/GoalPicker.tsx (client)
    chat/[sessionId]/page.tsx   chat UI: streaming + tool activity + docs sidebar + todos + %context
    api/sessions/route.ts  POST: create session + provision workspace + goal.md
    api/chat/route.ts      POST: non-stream relay (used by load-to-context)
    api/chat/stream/route.ts       POST: SSE stream a turn (text/reasoning/tool/todos/usage)
    api/chat/abort/route.ts        POST: stop current generation
    api/session/[id]/state/route.ts GET: %context tokens + todos + status
    api/session/[id]/messages/route.ts GET: opencode history for render/edit/pin
    api/upload/route.ts    POST: save upload + auto-convert to markdown
    api/uploads/route.ts   GET: list a session's uploaded source files
    api/context/route.ts   POST: inject a full file's markdown into the chat (capped)
    api/files/route.ts     GET: env files (+formats, deletable?) · DELETE: direct delete
    api/files/ask-delete/route.ts  POST: ask the model to delete (workspace MCP)
    api/report/route.ts     GET: report.md markdown for preview
    api/download/route.ts  GET: download a file as original/.md/.pdf/.docx
    _components/           GoalPicker, DocumentsSidebar, FileMenu, Thinking, ContextMeter, TodoPanel, MarkdownMessage, ToolActivity, ToolCallChip, ReportPreview, ThemeToggle
    layout.tsx, globals.css
  lib/
    goals.ts               load goals/*.md (frontmatter + body)
    converter.ts           server-only client for the converter service
    opencode.ts            server-only REST client (sessions, prompt_async, /event, tokens, todos)
    workspace.ts           server-only FS helpers (provision, uploads, goal.md, .sessions state, env files)
  types/index.ts           shared types (Goal, EnvFile, StreamEvent, ...)
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
- `POST /session/:id/prompt_async?directory=<dir>` → `204` (fire-and-forget; used
  for streaming).
- `GET /event?directory=<dir>` → SSE stream of `{id,type,properties}`. **CRITICAL
  gotcha (cost real debugging):** the engine **pre-filters `/event` by the instance
  directory**, so you MUST open it with the SAME `?directory=` the session is bound
  to, or you receive *none* of that session's events. Per turn it emits
  `session.status {type:busy|idle}`, `session.idle` (terminal), `message.part.delta`
  ({sessionID,messageID,partID,field,delta}), `message.part.updated` (part.type incl.
  `reasoning`), and `todo.updated`. Filter by `properties.sessionID`.
- `GET /session/:id` (cumulative `tokens`), `GET /session/:id/todo`,
  `GET /session/status`, `GET /provider` (`…deepseek-v4-flash.limit.context` =
  1,000,000) — power the %-context meter and the live todo panel.
- `GET /agent` → lists configured agents (used to sanity-check config injection).

Our **BFF endpoints** (the UI calls these): `POST /api/sessions` (→ `{sessionId,
welcome}`); `POST /api/chat/stream` (SSE; body `{sessionId, text?, editMessageId?,
loadFileName?}`; relays `{type:text|reasoning|**tool**|todos|status|usage|done|
error}` where the `usage` frame carries an approximate `breakdown[]`; `editMessageId`
triggers a `revert` then re-prompt; `loadFileName` injects a file's markdown via the
per-turn `system`); `POST /api/chat/abort` (stop the current turn); `GET /api/session/
:id/state` (tokens + todos + status + breakdown); `GET /api/session/:id/messages`
(history with stable ids, timestamps, tool calls — powers render/edit/pin); `POST
/api/upload` (auto-convert; **re-upload replaces + returns a unified `diff`**); `GET
/api/uploads`; `POST /api/context`; `GET /api/files` (goal.md excluded) + `DELETE
/api/files`; `POST /api/files/ask-delete`; `GET /api/report?sessionId` (report.md
markdown for the preview pane); `GET /api/download?name=&format=`.

opencode control endpoints used: `POST /session/:id/abort?directory=` (stop),
`POST /session/:id/revert?directory=` `{messageID}` then re-prompt (edit/rewind;
`/unrevert` cancels), `GET /session/:id/message?directory=` (history). Tool calls
arrive on `/event` as `message.part.updated` with `part.type:"tool"`
(`part.tool`=name, `part.state.status` pending→running→completed/error). Per-turn
dynamic context (current date/time; "reply in the user's language"; the goal body
on turn 1) is passed via the **`system` field** of `prompt_async`, which opencode
**appends** to the agent prompt.

Config is injected into the engine via env (see docker-compose.yml):
`OPENCODE_CONFIG=/config/opencode.json`, `OPENCODE_CONFIG_DIR=/config/.opencode`,
`OPENCODE_DISABLE_PROJECT_CONFIG=true` (the last stops opencode walking the tree
and picking up stray configs — the original collision cause).

## 7. Agents, skills, MCP

- **Agents** (defined in `opencode.json`, prompts in `prompts/`):
  - `compliance` — primary, default. Interviews the user **in plain text**
    (the chat is the Q&A loop), reads `uploads/`, writes `output/report.md`,
    delegates verification to `fact-checker`. `bash` denied; sandboxed to the
    workspace. `external_directory` is denied by default, with a narrow allow for
    `/config/.opencode/skills/**` so skill assets/templates can be read without
    surfacing permission errors in normal chats.
  - `fact-checker` — read-only subagent; verifies figures/claims; can web-fetch.
- **No interactive `question` tool.** opencode's `question` tool *blocks* the
  synchronous `POST /message` call waiting for an answer the BFF can't supply
  yet, which hangs the request. So `permission.question: deny` for `compliance`
  and the prompt instructs it to ask in plain text. Re-enabling the structured
  question tool requires the async/SSE path (see §11).
- **Skills** (`.opencode/skills/<name>/SKILL.md`, loaded on demand by the native
  `skill` tool): `csrd-esrs`, `esg-reporting`. Each is **self-contained**; the
  report template in `assets/` is **copied into the session workspace** at init.
  The compliance agent also has narrow read access to `/config/.opencode/skills/**`
  inside the engine container so native skill/template reads do not produce noisy
  permission errors for the user.
- **MCP servers** (`mcp/`, declared in `opencode.json`):
  - `workspace` (**enabled**): `delete_file` — a **zero-dependency** stdio server
    (bun/node builtins only; `command: ["bun","run","/config/mcp/workspace/index.mjs"]`
    because the bun engine image lacks `node` and our MCP SDK isn't installed there)
    that deletes a file (+ its `.md` sidecar) under `/workspaces`. It exists because
    opencode has **no built-in delete tool** and we deny `bash`; it powers the "ask
    the model to delete" flow.
  - `time` (**enabled**): `get_current_time` — zero-dependency stdio MCP. It only
    returns the current date/time; it never schedules or auto-fires. Separately,
    the BFF injects the current date/time via per-turn `system` on the first user
    message and then only when the next user message arrives after 12+ hours.
  - `fact-check` (**enabled**): `verify_claim` — zero-dependency stdio MCP backed
    by Tavily when `FACTCHECK_API_KEY` is set. Without the key it returns
    `NEEDS_CONFIG`; the compliance prompt tells the agent to fall back to
    `webfetch`/`websearch` and flag the claim for manual verification.
  - `doc-generate` (`enabled: false`, stub). It is **superseded** by the converter
    `/render` endpoint (md→PDF/DOCX).
  - `doc-ingest` is **superseded** by the `converter` service; safe to delete.
- **Reasoning and tool-call split.** opencode emits reasoning as `reasoning` parts
  and tools as `tool` parts; `/api/chat/stream` routes reasoning to the Thinking box
  and tools to a single compact, expandable tool activity line per assistant turn
  (expand to inspect individual tool calls). Tool calls with `status:"error"` are
  hidden in the consumer UI to avoid exposing internal permission/path errors to
  business users. The prompt explicitly forbids visible setup narration; a Hungarian
  smoke test confirmed the first visible answer skips "loading skill/template" chatter.
- **`converter` does both directions:** `POST /convert` (file→Markdown, MarkItDown)
  and `POST /render` (`{markdown,format:"pdf"|"docx"}`→binary, via `markdown`+
  `weasyprint` (BSD) and `htmldocx`+`python-docx` (MIT) — all business-friendly).

- **Goals** (`goals/goal_*.md`): each is frontmatter (`id, title, agent, skill,
  template`) + a plain-language body. `src/lib/goals.ts` loads them; the home page
  shows them as a **dropdown**. On session create the BFF writes the body to
  `<workspace>/goal.md` for compaction/plugin continuity, stores it in session state,
  and injects it into the first turn's per-message `system` context; `goal.md` is
  hidden from the Documents sidebar. Add a goal = drop a new `.md` file, no code
  change. `goal_test.md` is developer-only and explicitly lets the agent expose
  internals while exercising tools.

- **Documents are converted to Markdown automatically on upload.** The model only
  reads text, so `/api/upload` sends every non-text file to the **`converter`**
  service (MarkItDown, MIT, internal `:8000`) and writes `uploads/<name>.md` beside
  the raw file; the agent reads the `.md`. The **"Load full file into context"**
  button (`/api/context`) injects a whole file's markdown into the chat, capped by
  `MAX_CONTEXT_FILE_BYTES` (default 200 000); larger files stay on-demand-only.

- **Context management.** Shipped default (MIT): opencode **native compaction** +
  `.opencode/plugins/report-compaction.js`, which hooks
  `experimental.session.compacting` to inject the active goal + report STATUS +
  every `[DATA NEEDED]` so they survive compaction. **Opt-in, not bundled:** DCP
  (`@tarquinen/opencode-dcp`, **AGPL-3.0**) via `docker compose -f
  docker-compose.yml -f docker-compose.dcp.yml up` (or `scripts/enable-dcp.*`).
  Rationale: DCP loads in-process (a "combined work" with opencode), so we never
  bundle/convey it — the operator opts in and takes on the AGPL obligations for the
  service they then run. Our app stays at arm's length over HTTP and MIT-clean.

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

Done: scaffold, vendored opencode, the **containerized app** (app + opencode +
converter), goal dropdown from `goals/`, automatic document→Markdown conversion on
upload (MarkItDown), drag-and-drop upload + "load full file into context" (capped),
the MIT **report-compaction** plugin + the **DCP opt-in** overlay, **SSE streaming
chat** (thinking animation + timer; reasoning split out of the answer), a live
**single %-context meter** with approximate breakdown + native **todo panel**, a left
**Documents** sidebar grouped as Environment vs Output, **PDF/DOCX/MD download &
export** (converter `/render`), the **delete rule** (direct only before the next
message; else ask-the-model via the zero-dep `workspace` MCP `delete_file`),
**time knowledge** (first turn + next user turn after 12h, never auto-fires),
Tavily-backed **fact-check MCP** (with NEEDS_CONFIG fallback), markdown-rendered
assistant replies, timestamps, pins, dark mode, a consumer-chat composer, file
replacement diffs, and an **end-to-end verified** flow.
**Deferred** (not yet built):

- Remove the superseded `doc-ingest` / `doc-generate` stubs.
- Re-enable the structured interactive `question` tool if desired (now possible
  over SSE, but currently plain-text Q&A is more consumer-friendly).
- Non-root container hardening, restricted egress, resource limits.
- Auth on the BFF routes (currently unauthenticated).
- Durable session↔workspace persistence (the `.sessions` map is now JSON
  `{workspaceId, messageCount, uploads}`, still file-backed).
- Fully click-test stop/edit/report-preview/pin-navigation in the browser (API and
  rendering paths are built; the main live smoke covered tool chips, markdown,
  context, dark mode, and Hungarian first-turn behavior).
- Slimming the vendored fork (delete unused `packages/*`).
