---
title: Turn architecture evidence into owned improvement work
description: The complete guide to installing, configuring and using the Databricks Well-Architected Framework assessment.
permalink: /
eyebrow: Public user guide
---

# Turn architecture evidence into owned improvement work

The Databricks WAF assessment combines automated workspace evidence with accountable human review. It gives teams an indicative posture immediately, shows what was and was not measured, and turns unmet requirements into actions with an owner and a verification condition.

![Dashboard showing posture, coverage and the first recommended action]({{ '/assets/images/dashboard.jpg' | relative_url }}){: .hero-image }

> The screenshots in this guide use deterministic example data. They show the production layouts without exposing a customer workspace, user identity or record.

## Start with your role

<div class="card-grid">
  <div class="card">
    <h3>Workspace installer</h3>
    <p>Begin with <a href="{{ '/install/' | relative_url }}">Install</a>, then use the configuration and operating guides.</p>
  </div>
  <div class="card">
    <h3>Assessment owner</h3>
    <p>Follow the <a href="{{ '/user-guide/' | relative_url }}">customer journey</a> from preparation through publication.</p>
  </div>
  <div class="card">
    <h3>Platform or workload owner</h3>
    <p>Use Investigate to find the requirement and affected resources, then work from the improvement plan.</p>
  </div>
  <div class="card">
    <h3>Contributor</h3>
    <p>Read <a href="{{ '/contributing/' | relative_url }}">Issues and pull requests</a> before proposing a change.</p>
  </div>
</div>

## The customer journey

1. **Install** the App through the supported Databricks Asset Bundle (DAB) lifecycle.
2. **Prepare** an assessment: purpose, owners, workspaces, lookback window, pillars and targets.
3. **Collect** automated evidence for the selected scope.
4. **Review** the requirements that need human evidence and make a decision for each selected pillar.
5. **Publish** an immutable report.
6. **Investigate** an unmet requirement, its evidence and the resources it names.
7. **Improve** by recording owned, dated actions and checking them against a later run.
8. **Operate** the recurring cycle, schedule, exceptions, retention, backup and recovery.

The posture displayed by the App is application-defined from published Databricks guidance. It is not a Databricks certification.

## What is stored where

Lakebase stores the durable application record: definitions, runs, evidence outcomes, human answers, reviews, reports, decisions, exceptions, plans, actions, notes, monthly publications and the audit trail. The App-owned schema is `waf`.

The SQL warehouse executes evidence queries. Databricks system tables and APIs remain the sources of evidence; the App does not copy the estate into Lakebase. No credential is stored. Interactive reads use the signed-in user's on-behalf-of identity, while an optional schedule uses a dedicated service principal.

## Supported experience

- Current desktop and laptop Chrome.
- One workspace or every workspace visible to the scanning identity.
- Any single pillar, any subset, or all seven pillars.
- Interactive assessments by default; optional scheduled assessments.
- DAB deployment only. Marketplace installation is not a supported path.
- Tablet and mobile layouts are not supported.

## Next

[Install the App →]({{ '/install/' | relative_url }})

