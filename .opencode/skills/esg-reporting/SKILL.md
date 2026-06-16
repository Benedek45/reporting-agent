---
name: esg-reporting
description: >-
  Produce a voluntary ESG / sustainability report, defaulting to the GRI
  Standards structure (with optional SASB/ISSB framing). Use when the user wants
  a general ESG report, a sustainability report, a GRI-aligned report, or an
  investor-facing ESG summary that is NOT a mandatory EU CSRD/ESRS filing. Covers
  report structure, materiality approach, interview topics, and Markdown output.
  For mandatory CSRD/ESRS reports use the csrd-esrs skill instead.
license: MIT
metadata:
  domain: sustainability-compliance
  framework: GRI/SASB/ISSB (voluntary ESG)
---

# Voluntary ESG reporting

This skill guides a general-purpose ESG / sustainability report. Default to the
GRI Standards unless the user names another framework. You are drafting a report,
not issuing assurance or legal conclusions.

## When to use

The user wants a voluntary ESG or sustainability report (often GRI-aligned, or
SASB/ISSB for investor/financial-materiality framing). If they specifically need
an EU CSRD/ESRS statement, use `csrd-esrs` instead.

## Framework cheat-sheet

- **GRI (default).** Universal Standards: `GRI 1` Foundation, `GRI 2` General
  Disclosures (org profile, governance, strategy), `GRI 3` Material Topics
  (materiality process). Topic Standards: `GRI 200` Economic, `GRI 300`
  Environmental, `GRI 400` Social. GRI materiality = **impact materiality**
  (the organization's impacts on the economy, environment, and people).
- **SASB / ISSB.** Industry-specific, **financial materiality** — topics likely
  to affect enterprise value. Use when the audience is investors.
- A report can blend both: GRI for impact disclosures, SASB metrics for
  investors. Confirm the intended framework and audience up front.

## Report structure (default GRI-aligned backbone)

1. About this report — scope, period, boundary, framework(s), contact.
2. Organizational profile & governance (GRI 2).
3. Materiality — process and the list of material topics (GRI 3).
4. Environmental — energy, GHG emissions, water, waste, biodiversity (as material).
5. Social — workforce, health & safety, diversity, community, human rights.
6. Governance — ethics, anti-corruption, board oversight, data privacy.
7. Targets & performance — metrics with baselines, targets, and progress.
8. Appendix — methodology, content index, data tables, assumptions.

## Workflow

1. Confirm entity, reporting period, boundary, framework(s), and audience.
2. Establish material topics: request an existing materiality assessment, or
   interview to build a provisional one (label it provisional).
3. Interview per section and request the documents that evidence each metric.
4. Draft `output/report.md` using `output/report-template.md` (copied into the
   workspace at session start).
5. Fact-check figures and external claims before finalizing (delegate to the
   `fact-checker` subagent).

## Interview topics (one area at a time; request the listed documents)

- Profile & governance: legal name, sector, size, ownership, ESG oversight. → org chart.
- Materiality: existing assessment or stakeholder/topic inputs.
- Environment: energy & GHG → utility bills/energy summary, fuel/fleet records,
  prior GHG inventory; water and waste records if material.
- Social: headcount, diversity, turnover, injury rates → HR & H&S reports.
- Governance: code of conduct, anti-corruption policy, incidents → policy docs.
- Targets: any public commitments, baselines, and progress data.

## Output rules

- Write the report to `output/report.md` (GitHub-flavored Markdown).
- Follow `output/report-template.md` for section order and headings.
- Attribute every figure: `(source: <document>, <location>)`.
- For any missing required figure, insert `[DATA NEEDED: <what is missing>]` and
  list it in the status checklist at the top. Never invent numbers.
- State which framework(s) the report follows and the chosen materiality lens.

## Sourcing standard references

Exact GRI/SASB disclosure codes and metric definitions should come from the
official GRI Standards or the SASB/ISSB standards for the relevant industry. Do
not invent disclosure codes from memory; if a precise code is required and not
available, insert `[DATA NEEDED: confirm exact GRI/SASB reference]`.
