# reporting-agent

A beta web app that wraps an AI agent around a document-heavy compliance task.
First goals: **CSRD/ESRS** and **voluntary ESG** reporting. The user picks a
**goal** (from `goals/*.md`), chats with the agent, drag-and-drops source
documents (auto-converted to Markdown so the model can read them), and the agent
drafts a fact-checked report (Markdown → PDF/DOCX).

It ships as **one self-contained application**: a Next.js app (UI + BFF) plus a
headless, vendored [opencode](https://github.com/anomalyco/opencode) engine,
orchestrated with Docker Compose. opencode is only the internal engine — the end
user just opens a browser. See `AGENTS.md` for the full architecture.

## Quickstart (Docker)

Prerequisite: Docker + Docker Compose. Then:

```sh
cp .env.example .env        # put your OPENCODE_GO_API_KEY in .env
docker compose up --build   # builds the app + engine images and starts them
```

Open **http://localhost:3000**, pick a goal, and start the conversation. Only
the app port (3000) is published; the opencode engine stays on the internal
network.

- Rebuild after a UI/BFF change: `docker compose build app`
- Rebuild after an engine change: `docker compose build opencode`
- Config/prompts/skills are bind-mounted into the engine — after editing them
  just run `docker compose restart opencode`.

## Configuration

All in `.env` (gitignored):

| Variable | Purpose | Default |
|---|---|---|
| `OPENCODE_GO_API_KEY` | LLM gateway key (provider `opencode-go`) | — |
| `OPENCODE_SERVER_URL` | URL of the headless opencode engine | `http://opencode:4096` (compose) |
| `WORKSPACES_ROOT` | Per-session workspace root, shared by both containers | `/workspaces` (compose) |
| `CONVERTER_URL` | Internal MarkItDown converter service | `http://converter:8000` (compose) |
| `MAX_CONTEXT_FILE_BYTES` | Cap for the "load full file into context" button | `200000` |

### Optional: Dynamic Context Pruning (DCP)

The shipped default context management is opencode's native compaction plus the
MIT `report-compaction` plugin (no AGPL). DCP is a more aggressive alternative,
licensed **AGPL-3.0**, so it is **not bundled**. To opt in (you accept the AGPL
obligations for what you then run):

```sh
docker compose -f docker-compose.yml -f docker-compose.dcp.yml up -d --build
# or: scripts/enable-dcp.sh   /   scripts/enable-dcp.ps1
```

## Host dev (optional, faster inner loop)

Requires [Bun](https://bun.sh) `1.3+` and Node `18+`.

```sh
npm install
HUSKY=0 npm run opencode:install   # vendored opencode deps (use --ignore-scripts on Windows)
npm run opencode:serve             # engine on http://127.0.0.1:4096
npm run dev                        # app on http://localhost:3000
```

Set `OPENCODE_SERVER_URL` / `WORKSPACES_ROOT` consistently for host mode.

## Status

Working end-to-end in the container stack: goal dropdown, per-session workspace,
drag-and-drop upload with **automatic Markdown conversion**, "load full file into
context", **streaming chat** (token-by-token with a thinking animation + timer; the
model's reasoning is kept out of the answer bubble), a live **% context** meter and
a native **todo** panel, and a left **"documents in the environment"** sidebar with
per-file **download/export** (original · `.md` · **PDF** · **DOCX**) plus a delete
rule (direct delete only before the next message; otherwise ask the model, which
uses a `workspace` MCP tool). The agent loads the relevant skill, interviews the
user, and writes `output/report.md` with `[DATA NEEDED: …]` placeholders and no
fabricated figures. Deferred: a structured fact-check MCP, BFF auth, container
hardening, and durable session persistence. See the roadmap in `AGENTS.md`.
