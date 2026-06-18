# HANDOFF — reporting-agent

A practical "pick it up and keep going" guide. For the authoritative architecture
and rules, read **`AGENTS.md`** (kept current with every change). This file is the
quick orientation + current state + next steps.

---

## 1. What it is (in one paragraph)

A beta web app that wraps an AI agent around document-heavy reporting tasks
(first goals: **CSRD/ESRS** and **voluntary ESG**). The user picks a goal from a
dropdown, chats with an agent that interviews them and asks for documents, uploads
files (auto-converted to Markdown), and the agent drafts `output/report.md` —
never inventing data, attributing every figure, fact-checking. The app exports the
report to PDF/DOCX. It ships as **one `docker compose` stack**; `opencode` is the
internal engine the end user never sees.

## 2. Run it

```bash
cp .env.example .env          # then set OPENCODE_GO_API_KEY (required)
docker compose up --build     # → open http://localhost:3000
```

- Only port **3000** (the `app`) is published. `opencode` (4096) and `converter`
  (8000) are internal-only.
- Optional: set `FACTCHECK_API_KEY` (Tavily) to enable the structured fact-check
  MCP; without it the agent falls back to web-fetch.
- Context management: two MIT plugins auto-loaded from `.opencode/plugins/`
  (`context-manager.js` for per-request cascade + `report-compaction.js` as safety net).
  No extra config — they auto-discover from the existing `:ro` mount.

### Rebuild rules (important)
- Changed **TypeScript / UI** (`src/**`): `docker compose build app && docker compose up -d app`.
- Changed **opencode.json / prompts / skills / mcp**: these are bind-mounted →
  just `docker compose restart opencode` (no rebuild).
- Changed **converter** (`converter/app.py`, deps): `docker compose build converter`.
- Changed the **engine source** (`vendor/opencode`): `docker compose build opencode`.

## 3. Current state (verified)

Working end-to-end through the public API and a Playwright UI smoke:

- Goal dropdown from `goals/*.md`; session create provisions a per-session
  workspace and binds the opencode session to it.
- Streaming chat (SSE, token-by-token) with thinking animation + timer; reasoning
  is routed to the Thinking box, not the answer.
- Auto document→Markdown conversion on upload (MarkItDown); drag-and-drop upload;
  "load full file into context" (size-capped); re-upload replaces + sends a diff.
- Left **Documents sidebar** (Environment vs Output, goal.md hidden); per-file
  download menu (original / `.md` / **PDF** / **DOCX**, magic-bytes verified).
- Delete rule: a file is directly deletable only **before** the next message;
  afterwards you ask the model, which calls the `workspace_delete_file` MCP.
- Native **todo panel**, single **%-context bar** with an approximate breakdown.
- `time` MCP (current time only) + Tavily-backed `fact-check` MCP.
- Tool calls render as **one expandable activity line** per turn (expand for
  per-tool detail); markdown rendering, timestamps, pins, dark mode, consumer
  composer.

Latest commit: `b9c945b` (UI: tool activity line + report-download name fix).

## 4. Gotchas that cost real debugging (don't re-learn these)

- **`/event` is pre-filtered by the session directory.** You MUST open the SSE
  stream (and `prompt_async`) with the SAME `?directory=/workspaces/<uuid>` the
  session is bound to, or you get **none** of that session's events. This silently
  produced a 3-minute zero-byte stream.
- **The interactive `question` tool blocks** the synchronous prompt. It's denied
  for `compliance`; the agent asks in plain text. Re-enabling needs the SSE path.
- **MCP servers launch with `bun`, not `node`** — the engine image has no `node`.
  Our MCP servers (`mcp/{workspace,time,fact-check}`) are zero-dependency on
  purpose (node/bun builtins only).
- **Model body shape:** `model` is `{providerID, modelID}`, not a string. Working
  directory is a `?directory=` query param, not a body field.
- **AGENTS.md is hardlinked** to `D:\AGI_gent\gold\AGENTS.md` (one NTFS inode) so
  it loads into the dev agent's context while staying in the repo. If an editor
  breaks the link: `cmd /c mklink /H "D:\AGI_gent\gold\AGENTS.md" "D:\AGI_gent\gold\gold\AGENTS.md"`.
- **Secrets:** `.env` is gitignored and reaches **only** the `opencode` container.
  Never commit or print the key. `vendor/opencode/bun.lock` is intentionally not
  committed (the image installs fresh).

## 5. Known limitations / not-yet-done

- **App image must be rebuilt** to see the latest UI (the running container may be
  serving an older image): `docker compose build app && docker compose up -d app`.
- Built/streamed but **not fully click-tested in a browser**: stop
  (`/api/chat/abort`), edit-a-previous-message (`revert` + re-prompt), report
  preview content, pin-navigate.
- `deepseek-v4-flash` still occasionally leaks ~one "Let me…" preamble line.
- `doc-ingest` / `doc-generate` MCP stubs are **superseded** (by the `converter`
  service) and can be deleted.
- No **auth** on the BFF routes; no container hardening (runs as root, unrestricted
  egress, no resource limits).
- Session↔workspace map is a **file-backed JSON** (`/workspaces/.sessions/<id>`),
  not a durable DB.
- The compaction plugin loads clean and its static guidance always applies, but a
  real compaction event (long session) hasn't been force-tested.

## 6. Suggested next steps (highest value first)

1. **Rebuild the app image** and click-test stop / edit / pin / report preview in
   the browser; fix whatever the live pass surfaces.
2. **Auth** on the BFF (the app is currently open).
3. **Container hardening** — non-root user + `/workspaces` ownership, restricted
   egress (allow only the model API + Tavily), resource limits; also `reader.cancel()`
   the upstream `/event` after a turn finishes (minor connection leak).
4. **Durable persistence** for the session↔workspace map.
5. Delete the superseded `doc-ingest` / `doc-generate` stubs; consider slimming the
   vendored fork (`vendor/opencode/packages/{tui,desktop,app,web,...}`).

## 7. Repo orientation

- `AGENTS.md` — authoritative architecture + rules (read this first).
- `README.md` — quickstart + env table.
- `docker-compose.yml` — the full stack (`app` + `opencode` + `converter` + volume).
- `opencode.json` — engine config (model, agents, skills, MCP, permissions).
- `prompts/`, `.opencode/skills/`, `.opencode/plugins/`, `goals/`, `mcp/`,
  `converter/`, `src/` (Next.js UI + BFF), `vendor/opencode/` (MIT fork).

Repo: private `Benedek45/reporting-agent`. Conventional commits; commit + push per
unit of work; keep `AGENTS.md` current in the same change.
