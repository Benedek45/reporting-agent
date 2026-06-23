# DECISIONS.md — reporting-agent

Permanent archive of architecture decisions, design choices, tool selections,
and key lessons. Each decision is recorded once so it survives context compaction
and doesn't need to be re-researched or re-litigated.

---

## 1. Architecture

### 1.1 Agentic engine = vendored opencode (MIT), run headless
- **Decision:** Use opencode as a headless backend (`opencode serve`), driven by our own web UI over its REST API. Do NOT build our own agent loop.
- **Rationale:** Compliance reporting is "read files + write files + web search in an agentic loop" — opencode already has the agentic loop, tool calling, permissions, skills, and MCP host.
- **Vendored fork:** Source committed under `vendor/opencode` (upstream: `anomalyco/opencode`, branch `dev`, pinned commit `5d0f86606a`, MIT license). Modifiable; upstream `.git` removed so it's plain files. See AGENTS.md §4 for patch/rebuild policy.

### 1.2 UI stack = single Next.js App Router app (UI + BFF)
- **Decision:** One Next.js app serves both the browser UI and the backend API routes (BFF). The BFF talks to opencode over `fetch` (REST), NOT the `@opencode-ai/sdk`.
- **Rationale:** Avoid coupling to the SDK's generated shape; the 5 REST endpoints we use are stable. Single deployable artifact.

### 1.3 Deployment shape = 2-service Docker Compose
- **Decision:** `app` (Next.js, port 3000, the ONLY published port) + `opencode` (engine, port 4096, internal only). Shared named `workspaces` volume.
- **Rationale:** One self-contained application. `docker compose -f docker-compose.yml up --build` → open http://localhost:3000. The DEV overlay (`docker-compose.override.yml`) is for host dev only and must NOT be auto-merged in production (use `-f docker-compose.yml`).

### 1.4 Per-session workspace isolation
- **Decision:** Each session gets `/workspaces/<uuid>/` containing `output/` (report + uploads) and the opencode session binds to it via `?directory=/workspaces/<uuid>` on `POST /session`.
- **Rationale:** `external_directory: deny` sandboxes the agent. Skill report templates are copied into the workspace at init (the agent cannot read them cross-directory).

---

## 2. Model & secrets

### 2.1 Production model = `opencode-go/deepseek-v4-flash`
- **Decision:** Paid, zero-retention (~$0.14/$0.28 per 1M tokens). Provider is `opencode-go`.
- **Negative decision:** Do NOT use `opencode/deepseek-v4-flash-free` — its data may be used for training, unacceptable for confidential ESG/CSRD client documents.

### 2.2 API key management
- `OPENCODE_GO_API_KEY` in `.env` (gitignored). Injected ONLY into the `opencode` container via `docker-compose.yml` env_file. The `app` container gets non-secret env only.

### 2.3 opencode REST endpoints the BFF uses
- Base: `http://opencode:4096` (internal compose network)
- `POST /session?directory=<abs path>` → `Session{id, directory, ...}` (directory is a QUERY PARAM, not body field)
- `POST /session/:id/message` body `{agent, model:{providerID, modelID}, parts:[{type:"text",text}]}` (model is an OBJECT, not a string)
- `POST /session/:id/prompt_async?directory=` → `204` (fire-and-forget, used for streaming)
- `GET /event?directory=` → SSE stream (MUST have same `?directory=` as the session or you receive NONE of its events — **this was a real debug cost**)
- `POST /session/:id/abort?directory=` (stop), `POST /session/:id/revert?directory=` (edit/rewind)
- `GET /session/:id`, `GET /session/:id/todo`, `GET /provider`

---

## 3. Agents, skills, MCP

### 3.1 Two agents defined in `opencode.json`
- `compliance` (primary, default): interviews, requests docs, drafts `output/report.md`, fact-checks. Denies `bash`, `external_directory`, `question` (see 3.6).
- `fact-checker` (subagent): read-only; verifies figures via webfetch. Denies `edit`, `bash`.

### 3.2 Skills are loaded on-demand by the native `skill` tool
- `csrd-esrs`: ESRS structure, double materiality, topical standards. Self-contained SKILL.md + `assets/report-template.md` (copied into workspace at init).
- `esg-reporting`: GRI-aligned structure, 5-section report template.
- Adding a goal = drop a new `goals/goal_*.md` (frontmatter `id/title/agent/skill/template/roadmap` + body) — no code change.

### 3.3 Custom MCP servers (zero-dependency, stdio, launched with `bun`)
- `workspace` (enabled): `delete_file` + `present_file` — deletes a file + its `.md` sidecar, or marks a deliverable as presented, under `/workspaces`. Needed because opencode has no built-in delete tool and bash is denied.
- `roadmap` (enabled): `mark_done` + `mark_undone` + `status` — the dedicated `roadmap-sync` subagent NAMES completed/reopened checklist items; the server fuzzy-matches them against the canonical root `roadmap.md` and flips only those checkboxes (atomic write). **Why a tool, not markdown editing:** models (esp. Gemma 4) write the wrong file (`output/roadmap.md`), destructively rewrite the checklist, or invent invalid syntax (`- [in_progress]`). **Current ownership:** the main `compliance` agent receives roadmap as read-only context and has `roadmap_*` permissions denied; after every stream turn the BFF runs `roadmap-sync` synchronously on the same event stream, hiding its text/tool chatter and surfacing only the progress bar + a live "Roadmap updated" chip when `doneSteps` increases. This replaced a background fire-and-forget sync that raced with upload notify turns.
- `time` (enabled): `get_current_time` — returns current date/time only, never schedules.
- `fact-check` (enabled): `verify_claim` — Tavily-backed; returns NEEDS_CONFIG without `FACTCHECK_API_KEY`.

### 3.4 Superseded MCP stubs
- `doc-ingest`: superseded by the `converter` service (MarkItDown auto-converts uploads to Markdown).
- `doc-generate`: superseded by `converter /render` (markdown → PDF via weasyprint/BSD; → DOCX via htmldocx+python-docx/MIT). Keep the stubs but keep them `enabled: false`.

### 3.5 `converter` service (separate compose service, internal port 8000)
- MarkItDown (Microsoft, MIT): `POST /convert` (file → Markdown). Runs automatically at upload.
- `POST /render` ({markdown, format:"pdf"|"docx"} → binary). PDF via weasyprint (BSD), DOCX via htmldocx+python-docx (MIT). All MIT/BSD — business-safe.

### 3.6 No interactive `question` tool
- **Decision:** `permission.question: deny` for the `compliance` agent. The tool BLOCKS the synchronous `POST /message` call, hanging the request. The agent asks questions in plain text (the chat IS the Q&A loop). Re-enabling requires the async/SSE path (now built).

---

## 4. File handling & uploads

### 4.1 Automatic document-to-Markdown conversion on upload
- Non-text files (PDF, DOCX, XLSX, HTML, etc.) are sent to the `converter` service at upload time. A `.md` sidecar is written beside the original. The model only ever reads text.
- `isAlreadyText()` skips conversion for `.md/.txt/.csv/` etc.

### 4.2 Files live in the environment, not model context
- Uploads go to `/workspaces/<id>/output/`. The agent reads them ON DEMAND via `read`/`grep`/`list`. Wholesale context loading is OPT-IN via the "Load full file into context" button (capped by `MAX_CONTEXT_FILE_BYTES`, default 200,000).
- This keeps tokens/cost lean — a 200-page doc is navigated, not dumped.

### 4.3 Delete rule
- A file is **directly deletable** only if no message has been sent since it was uploaded (`canDeleteDirectly`). After that, the user must **ask the model** to delete it (it calls `workspace_delete_file` MCP).

### 4.4 File replacement
- Re-uploading the same filename replaces it and sends a **unified diff** to the agent. Old content is captured BEFORE overwrite (a baseline-capture bug was found and fixed for text files).

### 4.5 Download / export in multiple formats
- Every environment file has a `⋯` menu offering download as original, `.md`, `.pdf`, `.docx` (via the converter `/render` for md→PDF/DOCX). Verified by magic bytes (`%PDF`, `PK`).

---

## 5. Context management

### 5.1 Plugin-based, two layers
- **Default (MIT, bundled):** opencode's native compaction + our `report-compaction.js` plugin (re-injects goal + report STATUS + every `[DATA NEEDED]` at compaction so they survive).
- **Context-manager (MIT, SEPARATE project `Benedek45/context-manager`):** configured as an explicit `.opencode/context-manager.js` plugin tuple in `opencode.json`, not auto-discovered from `.opencode/plugins/`, so it can receive per-model options. This repo CONSUMES only the built bundle; the source is maintained externally. Rebuild via `scripts/update-context-manager.{ps1,sh}` (pinned commit `48a187a` — estimates nudge/hard-cap context from serialized message content instead of provider per-turn usage metadata; builds on `3e7b14b9` hard-cap + Set/Map serialization fix and the `2221b92` system.transform empty-turn guard). When adopting a new context-manager commit, verify it does NOT reintroduce a throw in `onSystemTransform` (empties turns), any new `CoreState` Set/Map field is initialized in `deserializeState` with `?? []`, and `estimateMessageTokens` does NOT use provider `msg.tokens.input` for message size.

### 5.2 Plugin hook gotcha (learned from empty-response debug)
- opencode invokes `experimental.chat.system.transform` with a `Provider.Model` whose id field is `model.id` (NOT `.modelID`), provider is `model.providerID`, window is `model.limit.context`. Proof: `vendor/opencode/packages/opencode/src/session/llm/request.ts:69-73` and `provider/provider.ts:1018-1033`.
- A plugin that reads `model.modelID` gets `undefined` → `undefined.toLowerCase()` throws → `Effect.promise` with no try/catch → die → empty assistant message.
- The context-manager fix at `2221b92` null-guards `isInternalModel` and wraps `onSystemTransform` in try/catch. A read-only optimization hook MUST NEVER be able to empty a user turn.
- The context-manager fix at `48a187a` corrects the compression nudge estimate: provider token metadata on assistant messages is per-turn request usage, where `tokens.input` already includes the full prior prompt/context. Summing that across history made the nudge estimate grow cumulatively. Context-window estimation must sum serialized message parts instead.

### 5.3 Compaction hook
- `experimental.session.compacting` receives `{ sessionID }` and outputs `{ context:[], prompt }`. Our `report-compaction.js` pushes domain-preservation guidance into `output.context`.

---

## 6. UI design decisions

### 6.1 Three-region chat layout
- Left: Documents sidebar (Environment / Output groups)
- Center: Streaming chat (consumer-chat composer, pill input)
- Right: Context meter (single segmented bar) + Todo panel + Report preview

### 6.2 Streaming via SSE (`/api/chat/stream`)
- BFF opens `GET /event?directory=<session dir>` (the `?directory=` is critical — see §2.3).
- Frames: `text`, `reasoning`, `tool`, `todos`, `status`, `usage`, `done`, `error`.
- Reasoning routed to Thinking box; tools to a single expandable activity line per turn.
- `session.idle` terminates; idle-based timeout (5 min of silence) as safety net.

### 6.3 Context meter — approximate breakdown
- opencode exposes only cumulative tokens + model context limit. No per-category API. The BFF computes: Reasoning (from `tokens.reasoning`), Documents (from tracked loaded/read bytes ÷ 4), System & tools (constant baseline), Conversation (remainder). All four clamped to sum to `usedTokens` (waterfall allocation).

### 6.4 Other UI features
- Markdown rendering (react-markdown + remark-gfm). DCP tags stripped client-side before rendering.
- Gemma 4 can still put setup/planning text into the final `content` field instead of
  provider `reasoning`. The BFF injects a last-position visible-reply guard every turn,
  and `MarkdownMessage` strips a narrow leading setup preamble pattern (e.g. "The skill
  is loaded", "Now I need to", `Plan:`) before rendering.
- Dark mode (CSS variables, persisted to localStorage, no flash).
- Timestamps, pin-to-scrollbar-dots.
- Welcome message client-side (not an opencode message — no endpoint for synthetic assistant messages).
- Goal body injected into per-turn `system` context, NOT shown as a visible file.

---

## 7. Local model deployment (Gemma 4 26B A4B on AWS vLLM)

### 7.1 Instance & infrastructure
- **Current:** g6.2xlarge (L4 24GB), eu-central-1a, on-demand (~$0.98/hr). Quota increased to 8 vCPU.
- **Previous attempts:** g6e.xlarge (L40S 48GB) sold out globally; g5.xlarge spot reclaimed 3×.
- **Security group:** `gemma4-vllm-sg`, TCP 22 + 8000 (per region).
- **SSH key:** `D:\AGI_gent\gemma4-vllm-key.pem` (gitignored).
- **Quota:** G+VT vCPU increased to 8 (both on-demand L-DB2E81BA and spot L-3819A6DF) in eu-central-1.

### 7.2 vLLM command (thinking enabled, REQUIRED flags)
```
vllm serve Neural-ICE/Gemma-4-26B-A4B-it-NVFP4 \
  --host 0.0.0.0 --port 8000 \
  --max-model-len 131072 --gpu-memory-utilization 0.90 \
  --quantization modelopt --moe-backend marlin --trust-remote-code \
  --kv-cache-dtype fp8 \
  --reasoning-parser gemma4 --tool-call-parser gemma4 --enable-auto-tool-choice \
  --chat-template /home/ec2-user/tool_chat_template_gemma4.jinja \
  --default-chat-template-kwargs '{"enable_thinking": true}' \
  --api-key $GEMMA_API_KEY
```
- `--chat-template` is REQUIRED for streaming tool calls (without it, raw `<|tool_call>` tokens leak).
- `--default-chat-template-kwargs '{"enable_thinking": true}'` enables Gemma 4 thinking by default for all requests. Without it, reasoning is DISABLED — `--reasoning-parser` only parses thinking IF the model produces it, but Gemma 4 needs `enable_thinking=true` to actually generate reasoning tokens.
- Template: `https://raw.githubusercontent.com/vllm-project/vllm/main/examples/tool_chat_template_gemma4.jinja`
- Model: NVFP4 community quant (~15.3GB weights, fits L4 24GB with FP8 KV cache).
- VRAM: ~20.7/23GB used; KV cache ~164K tokens at 131K max-model-len.

### 7.3 Provider wiring in opencode.json
```json
"gemma4-aws": {
  "npm": "@ai-sdk/openai-compatible",
  "name": "Gemma 4 (AWS vLLM)",
  "options": { "apiKey": "{env:GEMMA_API_KEY}", "baseURL": "{env:GEMMA_BASE_URL}" },
  "models": { "Neural-ICE/Gemma-4-26B-A4B-it-NVFP4": { "name": "Gemma 4 26B A4B", "limit": {"context":131072,"output":8192} } }
}
```
Verified model ID: `gemma4-aws/Neural-ICE/Gemma-4-26B-A4B-it-NVFP4`. All agents + small_model set to this. DCP context-manager configured with percentage thresholds (hardCap 88%, nudges 45/62/75/45%) resolved against 131K window.

### 7.4 Thinking mode notes
- Gemma 4 reasoning is **disabled by default** in vLLM. Must pass `enable_thinking=true` either server-wide (`--default-chat-template-kwargs`) or per-request (`chat_template_kwargs`).
- `reasoning_effort` parameter ("low"/"medium"/"high") also auto-enables thinking; "none" disables it.
- Thinking produces additional tokens — increase `max_tokens` / `--max-model-len` accordingly.
- Multi-turn: strip thoughts from previous assistant turns (the chat template handles this).
- Verified live: direct vLLM returns `reasoning` field (312 chars for "2+2"); full app chat path returns 674-char CSRD interview reply.

---

## 8. Key bugs found and fixed

| Bug | Root cause | Fix |
|---|---|---|
| Streaming returned 0 bytes | `/event` opened without `?directory=` → engine pre-filters, delivers no events | Pass `?directory=/workspaces/<uuid>` to both `prompt_async` and `/event` |
| Empty response after plugin update | `experimental.chat.system.transform` read `model.modelID` (undefined) → throw → die → halt | Null-guard `isInternalModel`; wrap `onSystemTransform` in try/catch (`2221b92`) |
| Load-into-context blocked every file | `MAX_CONTEXT_FILE_BYTES` in `.env` but NOT in `docker-compose.yml` app env block → `Number("")=0` | Added to compose env; hardened `??` → `||` fallback |
| Context breakdown showed Documents > total after compression | `documentBytes` is cumulative lifetime counter, never shrinks on compaction | Clamped waterfall allocation (all four buckets always sum to `usedTokens`) |
| Question tool hung POST /message | `question` tool blocks synchronously, BFF uses the sync endpoint | Denied `question` permission; agent asks in plain text |
| Report download returned "Invalid file name" | UI sent `name=output/report.md` (slash) — route rejects path traversal | Changed to `name=report.md` (route has special-case) |
| Docker engine boot `EROFS` | Vendored engine's `ensureGitignore()` writes to read-only `:ro` config mount | Patched to swallow all write errors (EROFS + PermissionDenied) |
| Session-state torn-read crash | Concurrent read-modify-write on `.sessions/<id>` JSON | Atomic write (temp + rename) + per-session async lock |
| Gemma setup/planning leaked into answer bubble | Model emitted setup/planning as visible `text` content, not `reasoning` | Last-position system guard + narrow MarkdownMessage setup-preamble stripping |

---

## 8b. Security — agent sandbox & SSRF (2026-06)

Adversarial test ("make the agent escape"): the filesystem/shell sandbox held (no RCE,
no host FS escape — `bash` denied, `external_directory: deny`, download path-traversal
sanitized). But the agent's `webfetch` tool reached the app's own BFF via
`host.docker.internal:3000` / `172.17.0.1:3000`, and since `/api/*` is unauthenticated and
keyed only by `sessionId`, it read other sessions' data (cross-session leak / IDOR).

Fixes:
- **SSRF guard in `webfetch`** (vendored fork, always on): blocks internal hostnames + DNS-resolves
  to reject loopback/private/link-local/CGNAT/cloud-metadata ranges (IPv4 + IPv6 incl. mapped).
  Verified: internal refused, `https://example.com` still works.
- **Optional BFF Basic Auth** (`src/middleware.ts`): no-op unless `APP_BASIC_AUTH_USER` +
  `APP_BASIC_AUTH_PASS` set (app container only; never opencode/converter). Edge-safe.
- **Network-layer egress filtering** for the engine container: still TODO (defense-in-depth;
  the webfetch guard already closes the agent's only HTTP vector).

Rule of thumb: the agent's own tools (especially `webfetch`) are part of the attack surface —
treat any agent-reachable HTTP capability as hostile and guard internal targets.

## 9. AWS operational rules

- The assistant has access to AWS credentials and can perform read-only checks (describe, list, get) at any time.
- **Never submit quota requests, launch instances, terminate resources, modify security groups, or change any AWS settings without an explicit instruction from the user.** Prepare and show the command first; wait for approval.
- Instance launches and quota requests are billable/irreversible actions — they require explicit user sign-off every time.

## 10. Repository conventions

- `AGENTS.md` is the single source of truth for living architecture/rules.
- `DECISIONS.md` (this file) is the permanent archive of settled decisions.
- `conventional commits` (`type(scope): summary`). No emojis.
- TypeScript strict, no `any`. Server-only code kept out of client components.
- `TODO(scaffold)` and `TODO(harden)` are the only sanctioned placeholders.
- Secrets only in `.env` (gitignored). Never commit API keys, tokens, or credentials.
- `vendor/opencode/bun.lock` intentionally NOT committed — the Docker image installs fresh.
- Run the stack with `docker compose -f docker-compose.yml up -d` (production). Plain `docker compose up` auto-merges the DEV overlay → `EACCES` crash in `next dev`.
