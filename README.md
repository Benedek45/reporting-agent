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
cp .env.example .env             # put your OPENCODE_GO_API_KEY in .env
docker compose -f docker-compose.yml up --build
```

Open **http://localhost:3000**, pick a goal, and start the conversation. Only
the app port (3000) is published; the opencode engine stays on the internal
network.

Use `-f docker-compose.yml` for production. Plain `docker compose up` auto-merges
the DEV override and runs `next dev` in the container.

- Rebuild after a UI/BFF change: `docker compose build app`
- Rebuild after an engine change: `docker compose build opencode`
- Config/prompts/skills are bind-mounted into the engine — after editing them
  just run `docker compose restart opencode`.

## Configuration

All in `.env` (gitignored):

| Variable | Purpose | Default |
|---|---|---|
| `OPENCODE_GO_API_KEY` | LLM gateway key (provider `opencode-go`) | — |
| `OPENCODE_MODEL` | Model requested by the BFF for chat turns. Set to `gemma4-aws/google/gemma-4-E4B-it` to test the AWS vLLM endpoint. | `opencode-go/deepseek-v4-flash` |
| `OPENCODE_SERVER_URL` | URL of the headless opencode engine | `http://opencode:4096` (compose) |
| `WORKSPACES_ROOT` | Per-session workspace root, shared by both containers | `/workspaces` (compose) |
| `CONVERTER_URL` | Internal MarkItDown converter service | `http://converter:8000` (compose) |
| `MAX_CONTEXT_FILE_BYTES` | Cap for the "load full file into context" button | `200000` |
| `FACTCHECK_API_KEY` | Optional Tavily key for the `fact-check` MCP. If unset, the tool returns `NEEDS_CONFIG` and the agent falls back to web fetch/search. | — |
| `GEMMA_BASE_URL` | Optional OpenAI-compatible vLLM endpoint for the `gemma4-aws` provider. Current AWS test endpoint: `http://63.179.116.202:8000/v1`. | — |
| `GEMMA_API_KEY` | API key shared with the vLLM `--api-key` flag. Injected only into the opencode container. | — |

### Context management

The app ships with two MIT context-management plugins (`.opencode/plugins/`):

| Plugin | Role |
|---|---|
| `context-manager.js` | **Per-request cascade:** dedup → stale-error purge → observation mask/offload (Cost-ROI gated), plus a model-driven `compress` tool for structured summarization. |
| `report-compaction.js` | **Last-resort safety net:** re-injects goal + STATUS + `[DATA NEEDED]` placeholders when opencode native compaction eventually fires. |

The `compress` tool is non-interactive (no `context.ask`) so it never deadlocks the BFF stream.
Plugin state lives in `/workspaces/.context-manager/dcp/<sessionId>.json` and is cleaned up on session delete.
Both plugins are auto-discovered by opencode from the existing `/config/.opencode/plugins/` mount — no extra config needed.

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

Working end-to-end in the container stack: goal dropdown (including a developer
tool self-test goal), per-session workspace, drag-and-drop upload with **automatic
Markdown conversion**, re-upload replacement with a unified diff sent to the agent,
"load full file into context", **streaming chat** (token-by-token with a thinking
animation + timer; reasoning kept out of the answer bubble), native **tool-call
chips** (with noisy internal errors hidden), a single **% context** meter with an
approximate breakdown, a native **todo** panel, and a left **Documents** sidebar
grouped as Environment vs Output. Files can be downloaded/exported as original ·
`.md` · **PDF** · **DOCX**; direct delete is only allowed before the next message,
otherwise the model calls the `workspace_delete_file` MCP. The agent has time
knowledge (`time_get_current_time` + 12h per-turn system refresh), a Tavily-backed
`fact-check_verify_claim` MCP with fallback when unconfigured, markdown-rendered
answers, timestamps, pins, dark mode, a chat-app composer, and it writes
`output/report.md` with `[DATA NEEDED: …]` placeholders and no fabricated figures.
An AWS vLLM test endpoint is also wired as `gemma4-aws/google/gemma-4-E4B-it`
(Gemma 4 E4B on a g5.xlarge A10G spot instance); it is verified for direct opencode
prompts and a `compliance` agent smoke test, but the default production model remains
`opencode-go/deepseek-v4-flash`.
Deferred: BFF auth, container hardening, durable session persistence, and full
click-testing of stop/edit/report-preview/pin navigation. See `AGENTS.md`.
