# reporting-agent

A beta web app that wraps an AI agent around a document-heavy compliance task.
First tasks: **CSRD/ESRS** and **voluntary ESG** reporting. The user picks a
task, chats with the agent, uploads source documents, and the agent drafts a
fact-checked report (Markdown → PDF/DOCX).

It is a single Next.js app (UI + BFF) driving a headless, vendored
[opencode](https://github.com/anomalyco/opencode) server. See `AGENTS.md` for
the full architecture.

## Prerequisites

- [Bun](https://bun.sh) `1.3+` (to run the vendored opencode server)
- Node.js `18+` and npm (for the Next.js app)
- An OpenCode Zen API key for the `opencode-go` provider

## Setup

```sh
cp .env.example .env        # then put your OPENCODE_GO_API_KEY in .env
npm install                 # installs the Next.js app deps
HUSKY=0 npm run opencode:install   # installs the vendored opencode deps (Bun)
```

## Run (two processes)

```sh
# 1) headless agent backend (from the vendored fork)
npm run opencode:serve      # http://127.0.0.1:4096

# 2) the web app
npm run dev                 # http://localhost:3000
```

Open http://localhost:3000, pick a task, and start the conversation.

## Configuration

All in `.env` (gitignored):

| Variable | Purpose | Default |
|---|---|---|
| `OPENCODE_GO_API_KEY` | LLM gateway key (provider `opencode-go`) | — |
| `OPENCODE_SERVER_URL` | URL of the headless opencode server | `http://127.0.0.1:4096` |
| `WORKSPACES_ROOT` | Where per-session workspaces live (keep outside the repo) | `../reporting-agent-workspaces` |

## Status

Scaffold stage. The agent config, domain skills, prompts, and the UI/BFF
skeleton exist; the document-processing MCP servers and live streaming are
stubbed. See the roadmap in `AGENTS.md`.
