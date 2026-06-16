---
name: csrd-esrs
description: >-
  Produce a CSRD sustainability report structured to the European ESRS
  standards. Use when the user asks for a CSRD report, ESRS report, EU
  sustainability statement, double materiality assessment, or disclosures under
  ESRS E1-E5 / S1-S4 / G1. Covers the report structure, the double materiality
  logic, the interview topics, and the Markdown output format. Not for voluntary
  GRI/SASB-style ESG reports (use the esg-reporting skill for those).
license: MIT
metadata:
  domain: sustainability-compliance
  framework: CSRD/ESRS
---

# CSRD / ESRS reporting

This skill guides you through drafting a CSRD report aligned to the European
Sustainability Reporting Standards (ESRS). You are drafting a report — you are
not issuing a legal opinion or assurance conclusion. Recommend professional
review for legally consequential determinations (final materiality outcomes,
assurance sign-off).

## When to use

The user wants a CSRD report, an ESRS sustainability statement, a double
materiality assessment, or specific ESRS topical disclosures.

## ESRS structure (use this as the report's backbone)

**Cross-cutting (always reported, not subject to materiality):**
- **ESRS 1 — General requirements.** Principles only (no disclosures): double
  materiality, value chain, time horizons, reporting boundary.
- **ESRS 2 — General disclosures.** Mandatory regardless of materiality:
  - `BP` Basis for preparation
  - `GOV` Governance — role of administrative/management bodies
  - `SBM` Strategy & business model, stakeholder interests
  - `IRO` Impact, risk & opportunity management (incl. the materiality process)
  - `MDR` Minimum disclosure requirements for policies, actions, targets, metrics

**Topical standards (reported only if assessed material, except ESRS 2):**
- Environment: `E1` Climate change · `E2` Pollution · `E3` Water & marine
  resources · `E4` Biodiversity & ecosystems · `E5` Resource use & circular economy
- Social: `S1` Own workforce · `S2` Workers in the value chain · `S3` Affected
  communities · `S4` Consumers & end-users
- Governance: `G1` Business conduct

E1 typically covers the transition plan, gross GHG emissions (Scope 1, Scope 2,
Scope 3, and total), and energy consumption.

## Double materiality (drives what is included)

A topic is **material** — and therefore its disclosures become mandatory — if it
is material under **either** lens:
- **Impact materiality (inside-out):** the company's actual/potential effects on
  people and the environment.
- **Financial materiality (outside-in):** sustainability matters that affect the
  company's development, performance, or position.

Always run/confirm the materiality assessment first; it determines which topical
standards (E/S/G) appear in the report. ESRS 2 is always included.

## Workflow

1. Confirm the reporting entity, the fiscal year/period, and the consolidation
   boundary (single entity vs. group).
2. Establish the list of material topics: ask whether a materiality assessment
   exists. If yes, request it. If no, interview the user to draft a provisional
   one and clearly label it provisional.
3. For ESRS 2 and each material topical standard, interview the user and request
   the source documents needed to substantiate the disclosures.
4. Draft `output/report.md` section by section using the template in
   `output/report-template.md` (copied into the workspace at session start).
5. Fact-check figures and references before finalizing (delegate to the
   `fact-checker` subagent).

## Interview topics (ask one area at a time; request the listed documents)

- Entity & boundary: legal name, sector, employee count, group structure.
- Governance (GOV): who oversees sustainability; board roles. → org chart, board charter.
- Strategy (SBM): business model, key products/markets, stakeholders.
- Materiality (IRO): existing assessment or the inputs to build one.
- E1 Climate: energy use and GHG data. → utility bills/energy summary, fuel
  records, fleet data, any prior GHG inventory.
- Other material E/S/G topics: request the specific records that evidence each
  (e.g. HR headcount & diversity report for S1; supplier code & audits for S2/G1).

## Output rules

- Write the report to `output/report.md` (GitHub-flavored Markdown).
- Follow `output/report-template.md` for section order and headings.
- Attribute every figure: `(source: <document>, <location>)`.
- For any missing required figure, insert `[DATA NEEDED: <what is missing>]` and
  list it in the status checklist at the top of the report. Never invent numbers.
- Mark any provisional materiality conclusion as provisional.

## Sourcing detailed datapoints

The exhaustive, ID-level ESRS datapoint list (e.g. specific E1 disclosure
requirement numbers and the mandatory datapoints under each) must come from the
official EFRAG ESRS delegated act / EFRAG datapoint catalogue. Do not invent
datapoint IDs or thresholds from memory; if a precise datapoint reference is
required and not available, insert `[DATA NEEDED: confirm exact ESRS datapoint
reference]` and recommend checking the official ESRS text.
