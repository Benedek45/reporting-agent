# reporting-agent

A beta web app that wraps an AI agent around a document-heavy compliance task.
First tasks: **CSRD/ESRS** and **voluntary ESG** reporting. The user picks a
task, chats with the agent, uploads source documents, and the agent drafts a
fact-checked report (Markdown → PDF/DOCX).

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

Open **http://localhost:3000**, pick a task, and start the conversation. Only
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

Working end-to-end in the container stack: the agent loads the relevant skill,
interviews the user (plain-text Q&A), and writes `output/report.md` with
`[DATA NEEDED: …]` placeholders and no fabricated figures. Still stubbed/deferred:
the document-processing MCP servers (PDF/DOCX ingest + export), SSE streaming,
the report-download route, and auth. See the roadmap in `AGENTS.md`.
