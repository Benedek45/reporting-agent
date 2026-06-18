---
id: esg
title: Voluntary ESG / Sustainability Report
agent: compliance
skill: esg-reporting
template: .opencode/skills/esg-reporting/assets/report-template.md
roadmap: goals/roadmaps/roadmap_esg.md
---

# Voluntary ESG / Sustainability Report

You are producing a **voluntary ESG / sustainability report**, defaulting to the
**GRI Universal Standards (2021)** structure unless the user names another
framework (SASB, ISSB/IFRS S1–S2, or a blend). This is **not** a mandatory EU
CSRD/ESRS filing — for that, use the CSRD / ESRS goal instead.

## What you will deliver

A complete sustainability report in `output/report.md`, covering:

- **About this report** — scope, period, reporting boundary, chosen framework(s),
  intended audience, and contact.
- **Organisational profile & governance** (GRI 2) — legal name, ownership, sector,
  size, markets, board/management ESG oversight, governance structure.
- **Materiality** (GRI 3) — the process used to identify material topics, the
  resulting list of material topics, and how stakeholders were engaged. GRI uses
  **impact materiality** (the organisation's impacts on economy, environment, and
  people). If the audience is investors, add **financial materiality** (SASB/ISSB
  lens: topics likely to affect enterprise value).
- **Environmental** — energy consumption & mix, GHG emissions (Scope 1/2/3 where
  material), water withdrawal & discharge, waste generation & diversion,
  biodiversity impacts — reported only where assessed material.
- **Social** — workforce composition & diversity, health & safety (injury rates,
  lost-time incidents), training & development, human rights due diligence,
  community engagement — reported only where assessed material.
- **Governance** — ethics & anti-corruption policies, compliance incidents,
  whistleblowing, data privacy, board diversity & independence.
- **Targets & performance** — metrics with baselines, targets, and year-over-year
  progress for each material topic.
- **Appendix** — methodology notes, GRI/SASB content index, detailed data tables,
  key assumptions, and limitations.

## How the engagement works

1. **Frame the engagement.** Confirm the reporting entity, reporting period,
   boundary (single entity vs. group), the intended framework(s) (GRI, SASB, ISSB,
   or a blend), and the primary audience (stakeholders, investors, regulators, or
   public).
2. **Establish materiality.** Ask whether a materiality assessment already exists.
   If yes, request it. If no, interview the user to build a provisional one and
   clearly label it provisional. Determine which ESG topics are material and
   therefore in scope.
3. **Interview one topic at a time.** For each section of the report, ask focused
   questions and request the specific source documents that evidence each metric.
   Do not dump a long questionnaire — ask iteratively and come back for more as
   gaps emerge.
4. **Draft incrementally.** Build the report section by section using the template
   from the `esg-reporting` skill, maintaining a STATUS checklist at the top.
   Attribute every figure to a source document and location.
5. **Fact-check before finalising.** Verify all quantitative figures and external
   claims. Delegate complex verification to the `fact-checker` subagent. Use the
   `fact-check_verify_claim` tool for individual external facts.
6. **Never invent data.** Missing figures get a literal `[DATA NEEDED: ...]`
   placeholder. GRI/SASB disclosure codes come from the official standards, not
   from memory.

## Documents you should request

Depending on which topics are material, you may need some or all of:

- Organisational chart, ownership structure, board composition (GRI 2)
- Existing materiality assessment or stakeholder engagement records (GRI 3)
- Energy bills, utility summaries, fuel/fleet data, prior GHG inventory (GRI 302/305)
- Water records, waste manifests (GRI 303/306)
- Biodiversity site assessments (GRI 304)
- HR headcount, diversity, turnover, training hours (GRI 401–405)
- Health & safety reports — injury rates, lost-time incidents (GRI 403)
- Supplier assessment records, human rights policies (GRI 407–414)
- Anti-corruption policy, compliance incidents, fines (GRI 205/206)
- Previous sustainability report or annual report (context & baselines)
- Public commitments, targets, and progress data

Load the `esg-reporting` skill for the full report structure, disclosure
requirements, and interview script.
