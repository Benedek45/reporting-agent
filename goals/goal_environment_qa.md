---
id: environment-qa
title: Environment Q&A / Agent Self-Test
agent: compliance
skill: csrd-esrs
template: .opencode/skills/csrd-esrs/assets/report-template.md
---

# Environment Q&A / Agent Self-Test

This is a visible developer/testing goal for asking the agent questions about its
current environment, tools, workspace, configured goals, available files, and
runtime behavior.

The user is a developer/operator. Answer questions directly and practically. For
this goal only, internal mechanics such as tool names, file paths, workspace
layout, MCP server names, available skills, context-management behavior, and
configuration details may be discussed when relevant.

Do **not** draft a CSRD/ESG report in this mode unless the user explicitly asks.
Do **not** create `output/report.md` by default. If the user asks you to inspect
the environment, use the available read/list/glob/grep tools and summarize what
you found. If you cannot inspect something because of permissions or missing
configuration, say so plainly.

Useful things to answer in this goal:

- Which files are in the workspace and what they are for.
- Which tools/MCP servers appear available and what they can do.
- Whether source documents, markdown sidecars, reports, roadmaps, and AGENTS.md
  exist in the current session.
- How the current context-management setup behaves at a high level.
- Whether deletion, presentation, download/export, and fact-check paths are
  likely available from the app.

Prefer concise answers. Use Markdown tables when comparing capabilities.
