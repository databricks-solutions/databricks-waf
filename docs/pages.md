---
title: Every page in the App
description: Complete page reference for assessment, optimisation, method, record and operating views.
permalink: /pages/
eyebrow: Use the app
---

# Every page in the App

The top navigation is organised by customer task. The view menu within a task exposes its supporting pages; Utilities holds installation and governance tools.

## Shared controls

Every production page keeps the selected assessment and run state in the header.

| Control | Use it for |
| --- | --- |
| Search | Find a route, requirement or workflow without navigating the menus. |
| Theme | Choose light, dark or system appearance. |
| Export | Download supported assessment records. Use Print on a published report for PDF. |
| Run assessment | Set the saved or custom scope and start collection. |
| Choose assessment | Change the definition whose latest result and records populate the pages. |
| Since previous run | Open new, changed, resolved or regressed requirements for the comparable predecessor. |

## Dashboard

| Page | Path | Purpose |
| --- | --- | --- |
| Dashboard | `/overview` | Permanent state of the estate: coverage, posture, confidence, first action, next requirements, material change and pillar summaries. |

## Assess

| Page | Path | Purpose and main actions |
| --- | --- | --- |
| Review | `/review` | Resume open reviews and decide every selected pillar after collection. |
| Review detail | `/review/<review-id>` | Separate measured evidence, human answers and gaps; confirm or skip each pillar; publish when complete. |
| Pillars | `/pillars` | Compare the seven framework pillars for the selected result. |
| Pillar detail | `/pillars/<pillar-id>` | Read one pillar's posture, coverage, requirements and highest-priority results. |
| Findings | `/findings` | Search and filter every requirement outcome and open its evidence. Clean filters do not display empty “nothing found” noise. |
| Estate | `/topology` | Explore named jobs, tables, warehouses, pipelines and clusters and their observed relationships. Use after selecting a requirement when possible. |

## Investigate

| Page | Path | Purpose and main actions |
| --- | --- | --- |
| Investigation workbench | `/investigate` | Select an unmet requirement, read the closure plan and evidence, inspect affected resources, follow Databricks deep links, add notes and create improvement work. Query parameters preserve pillar, outcome, movement, requirement and selected resource. |

## Improve

| Page | Path | Purpose and main actions |
| --- | --- | --- |
| Improvements | `/improvements` | Find open and closed plans, create a plan from a requirement and review action status. |
| Improvement plan | `/improvements/<plan-id>` | Raise, own, date, move and verify actions; send or close the plan. |

## Optimisation views

These advisors are operational opportunities, not scored WAF requirements.

| Page | Path | Purpose |
| --- | --- | --- |
| Workloads | `/workloads` | Expensive query shapes, what is wrong with them and whether they are getting worse. |
| Warehouses | `/warehouses` | Warehouse sizing and billed-use opportunities for the workloads each warehouse served. |
| Jobs | `/jobs` | Run outcomes, duration and where job time was spent. |
| Writes | `/writes` | Repeated rewrites, small-file loading patterns and other write-path opportunities. |
| Serverless | `/serverless` | Jobs that can move to serverless, blockers for the rest and indicative cost considerations. |
| Serving data | `/foundation` | Readiness of declared serving data to be found, trusted and understood. |

Advisor pages use their own advisory run. Starting one does not replace or alter the selected WAF assessment.

## Method

| Page | Path | Purpose and main actions |
| --- | --- | --- |
| Methodology | `/methodology` | Published methodology identity, weighting, provenance and changes by release. |
| Definitions | `/definitions` | Create, select and revise repeatable assessment scopes; copy an id for scheduling. |
| Prepare assessment | `/definitions/setup` | Six-step definition setup for purpose, owners, workspaces, lookback, pillars, evidence sources and targets. |
| Checks | `/checks` | Every automated statement, the source it reads, permission needed, latest result and measurement failure. |
| Answers | `/answers` | Human-only requirements, current answers and approaching review dates. |
| Guided answer | `/answers/walk` | Record an outcome, supporting evidence, accountable owner and next review date for one requirement. |

## Record

| Page | Path | Purpose and main actions |
| --- | --- | --- |
| Decisions | `/decisions` | Record accepted or deferred risk separately from the measured finding. |
| Exceptions | `/exceptions` | Manage time-bounded accepted exceptions and their expiries. |
| Improvements | `/improvements` | Durable improvement plans and action histories. |
| Runs | `/history` | Search every interactive and scheduled collection run and its completion state. |
| Run detail | `/history/<scan-id>` | Exact scope, collector outcomes, timing, identity and gaps for one run. |
| Report | `/report` | Open the latest reviewed result for the selected assessment. |
| Report detail | `/report/<result-id>` | Immutable printable architecture review and evidence census. |
| Months | `/months` | Open or closed reporting periods and their publication state. |
| Month detail | `/months/<yyyy-mm>` | Period summary, selected assessment result and publication record. An open month remains a preview. |

## Operate and utilities

| Page | Path | Purpose and main actions |
| --- | --- | --- |
| Next actions | `/operate` | Prioritised recurring queue for reviews, contradicted or overdue actions, exceptions and scheduled-run problems. |
| Start here | `/start` | Installation and first-assessment readiness path. |
| Diagnostics | `/diagnostics` | Live health of warehouse, Lakebase, audit trail and identity with direct next actions. |
| Retention | `/retention` | Inspect and apply record-retention policy. Retention actions are audited. |
| Audit trail | `/trail` | Append-only history of actor, action, target and outcome. |

## URLs and sharing

Filters and selected records are encoded in the URL where a stable deep link is useful. Share a requirement from Investigation, an action from its plan, an exact run or an immutable report rather than asking another reader to reconstruct filters manually.

Do not share URLs containing customer record ids outside the authorised customer context.

## Next

[Operate, upgrade and recover the installation →]({{ '/operations/' | relative_url }})

