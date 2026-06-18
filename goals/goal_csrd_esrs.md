---
id: csrd-esrs
title: CSRD / ESRS Sustainability Statement
agent: compliance
skill: csrd-esrs
template: .opencode/skills/csrd-esrs/assets/report-template.md
roadmap: goals/roadmaps/roadmap_csrd_esrs.md
---

# CSRD / ESRS Sustainability Statement

You are producing a **Corporate Sustainability Reporting Directive (CSRD)**
sustainability statement structured to the **European Sustainability Reporting
Standards (ESRS)** — the mandatory EU disclosure framework for large undertakings
and listed companies (Directive 2013/34/EU as amended by Directive 2022/2464/EU,
scope narrowed by Omnibus I — Directive (EU) 2026/470).

## What you will deliver

A complete ESRS-aligned sustainability statement in `output/report.md`, covering:

- **ESRS 2 — General Disclosures** (always mandatory, regardless of materiality):
  Basis for preparation (BP), Governance (GOV), Strategy & business model (SBM),
  Impact/risk/opportunity management (IRO), Minimum Disclosure Requirements (MDR)
  for all policies, actions, targets, and metrics.
- **Topical standards reported only if assessed material** under double materiality:
  - Environment: E1 Climate change · E2 Pollution · E3 Water & marine resources ·
    E4 Biodiversity & ecosystems · E5 Resource use & circular economy
  - Social: S1 Own workforce · S2 Workers in the value chain · S3 Affected
    communities · S4 Consumers & end-users
  - Governance: G1 Business conduct
- A **double materiality assessment** (or confirmation of an existing one) that
  determines which topical standards are in scope.

## How the engagement works

1. **Frame the engagement.** Confirm the reporting entity (legal name, sector,
   employee count), the reporting period (fiscal year), the consolidation boundary
   (single entity vs. group), and whether the entity falls under Omnibus I
   simplified thresholds.
2. **Establish materiality.** Ask whether a double materiality assessment already
   exists. If yes, request it. If no, interview the user to draft a provisional
   one covering impact materiality (inside-out: actual/potential effects on people
   and the environment) and financial materiality (outside-in: sustainability
   matters affecting the company's development, performance, or position). Clearly
   label any provisional assessment as such.
3. **Interview one topic at a time.** For ESRS 2 and each material topical
   standard, ask focused questions and request the specific source documents that
   evidence each disclosure — e.g. utility bills/energy summaries for E1, HR
   headcount & diversity reports for S1, supplier codes & audit results for S2/G1.
4. **Draft incrementally.** Build the report section by section using the template
   from the `csrd-esrs` skill, maintaining a STATUS checklist at the top. Attribute
   every figure to a source document and location.
5. **Fact-check before finalising.** Every quantitative figure and regulatory
   reference must be verified. Delegate complex multi-claim verification to the
   `fact-checker` subagent. Use the `fact-check_verify_claim` tool for individual
   external facts (emission factors, regulatory thresholds, benchmarks).
6. **Never invent data.** Missing figures get a literal `[DATA NEEDED: ...]`
   placeholder. Exact ESRS datapoint IDs come from official EFRAG texts, not from
   memory. Provisional materiality conclusions must be marked provisional.

## Documents you should request

Depending on which topics are material, you may need some or all of:

- Organisational chart & board/management body charter (GOV)
- Existing materiality assessment or stakeholder engagement records (IRO)
- Energy bills, utility summaries, fuel/fleet records, prior GHG inventory (E1)
- Water withdrawal/discharge records, waste manifests (E2/E3/E5)
- Biodiversity impact assessments, site location data (E4)
- HR headcount, diversity, turnover, and injury/illness reports (S1)
- Supplier code of conduct, audit reports, grievance records (S2/G1)
- Anti-corruption policy, whistleblowing records, fines/sanctions (G1)
- Previous sustainability report or annual report (context)
- Financial statements and footnotes (for connectivity cross-check)

Load the `csrd-esrs` skill for the full report structure, disclosure requirements,
and interview script.
