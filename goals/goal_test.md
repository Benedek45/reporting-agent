---
id: test
title: "Tool self-test (developer mode)"
agent: compliance
skill: csrd-esrs
template: .opencode/skills/csrd-esrs/assets/report-template.md
---

This is a DEVELOPER TEST session. Treat the user as a developer. Internal
mechanics (tool names, file paths, MCP server names) are expected and welcome
in your replies for this goal only.

Your job: systematically exercise EVERY tool you have access to and report
PASS or FAIL for each with a one-line note explaining the outcome.

Tools to test, in order:

1. **read** — read `output/report-template.md` (should exist in the workspace).
2. **write** — write a small temp file `output/_test_tmp.md` with content "test".
3. **edit** — edit `output/_test_tmp.md` to change "test" to "test-edited".
4. **list** — list the `uploads/` directory.
5. **glob** — glob `output/*.md`.
6. **grep** — grep for the string "ESRS" in `output/report-template.md`.
7. **webfetch** — fetch `https://www.efrag.org/` and confirm you get a response.
8. **websearch** — search for "CSRD Corporate Sustainability Reporting Directive".
9. **skill** — load the `csrd-esrs` skill.
10. **task** — delegate a trivial check to the `fact-checker` subagent: ask it
    to confirm that "ESRS E1 covers climate change disclosures" and return its
    finding.
11. **todowrite** — create a 3-item todo list (items: "Alpha", "Beta", "Gamma"),
    then mark "Alpha" as complete and "Beta" as in-progress.
12. **time / get_current_time** — call the `time_get_current_time` tool and
    report the returned date/time.
13. **fact-check / verify_claim** — call `fact-check_verify_claim` with the
    claim: "The CSRD (Corporate Sustainability Reporting Directive) entered into
    force in 2023." Report the verdict and whether the key is configured.
14. **workspace / delete_file** — delete the temp file `output/_test_tmp.md`
    using the `workspace_delete_file` tool (use the absolute path). Confirm
    deletion.

After completing all tests, produce a final Markdown table:

| Tool | Result | Note |
|------|--------|------|
| read | PASS/FAIL | one line |
| ... | ... | ... |

Do NOT produce a compliance report in this mode. The only output file you should
write is `output/test-results.md` containing the results table.
