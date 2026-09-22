---
title: Turn architecture evidence into owned improvement work
description: Review Databricks architecture evidence, trace gaps to resources, and verify owned improvement work on a later assessment.
layout: landing
permalink: /
---

<section class="landing-hero">
  <div class="landing-hero-copy">
    <p class="landing-kicker">Databricks Well-Architected Framework assessment</p>
    <h1>Turn architecture evidence into owned improvement work</h1>
    <p>Assess a workspace or account against all seven pillars, see exactly what was measured, trace unmet requirements to resources, and verify the work on a later run.</p>
    <div class="landing-actions">
      <a class="landing-button landing-button-primary" href="{{ '/install/' | relative_url }}">Read the installation guide</a>
      <a class="landing-button" href="https://github.com/databricks-solutions/databricks-waf">View on GitHub</a>
    </div>
  </div>
  <figure class="landing-figure">
    <img src="{{ '/assets/images/dashboard.jpg' | relative_url }}" width="1024" height="576" alt="WAF assessment Dashboard showing posture, evidence coverage, confidence, unmet requirements, and the first recommended action">
    <figcaption>The Dashboard keeps posture, coverage, material change, and the next action in one view.</figcaption>
  </figure>
</section>

<p class="example-data-note"><strong>Preview data:</strong> All screenshots on this page, including the hero above, contain deterministic, anonymized example data. No customer workspace, user identity, or customer record appears.</p>

<section class="landing-outcomes" aria-labelledby="outcomes-title">
  <p class="section-kicker">One accountable evidence chain</p>
  <h2 id="outcomes-title">From requirement to later verification</h2>
  <div class="outcome-grid">
    <article class="outcome-card">
      <span class="outcome-number">01</span>
      <h3>Evidence-backed posture</h3>
      <p>Every outcome carries its source, collection time, coverage, and confidence.</p>
    </article>
    <article class="outcome-card">
      <span class="outcome-number">02</span>
      <h3>Honest coverage</h3>
      <p>Unanswered and unmeasured requirements stay visible. Neither state becomes a pass.</p>
    </article>
    <article class="outcome-card">
      <span class="outcome-number">03</span>
      <h3>Resource-level investigation</h3>
      <p>An unmet requirement links to the evidence and affected Databricks resources that produced it.</p>
    </article>
    <article class="outcome-card">
      <span class="outcome-number">04</span>
      <h3>Later-run verification</h3>
      <p>Actions carry an owner and a verification condition that a later assessment can confirm or contradict.</p>
    </article>
  </div>
</section>

<section id="review" class="workflow-section">
  <div class="workflow-copy">
    <p class="section-kicker">Review</p>
    <h2>Separate collected evidence from human judgement</h2>
    <p>Automated evidence gives the team an indicative posture. Review shows measured outcomes, practices that need an accountable answer, and measurement gaps without blurring the three.</p>
    <ul>
      <li>Assess every visible workspace or an explicit workspace selection.</li>
      <li>Scope any single pillar, any subset, or all seven pillars.</li>
      <li>Answer only what platform data cannot settle.</li>
      <li>Confirm or deliberately skip each selected pillar before publication.</li>
    </ul>
  </div>
  <figure class="landing-figure">
    <img src="{{ '/assets/images/assessment-review.jpg' | relative_url }}" width="1024" height="576" loading="lazy" alt="Assessment Review page separating measured evidence, unanswered practices, and pillar decisions">
    <figcaption>Review asks for the remaining evidence and records an explicit decision for each selected pillar.</figcaption>
  </figure>
</section>

<section id="publish" class="workflow-section">
  <div class="workflow-copy">
    <p class="section-kicker">Publish</p>
    <h2>Freeze the reviewed result</h2>
    <p>Publication creates an immutable report tied to the run, assessment definition, methodology version, evidence, and reviewer decisions. Teams can govern the result without losing the indicative view that came before it.</p>
    <ul>
      <li>Keep scope, confidence, posture, risks, and measurement gaps together.</li>
      <li>Preserve answers, decisions, exceptions, and the audit history.</li>
      <li>Compare later runs only when scope and methodology are comparable.</li>
    </ul>
  </div>
  <figure class="landing-figure">
    <img src="{{ '/assets/images/published-report.jpg' | relative_url }}" width="1024" height="576" loading="lazy" alt="Published architecture report showing assessed scope, measured posture, open requirements, and improvement work">
    <figcaption>The published report becomes the reviewed record for governance and comparison.</figcaption>
  </figure>
</section>

<section id="investigate" class="workflow-section">
  <div class="workflow-copy">
    <p class="section-kicker">Investigate</p>
    <h2>Follow a gap to the resources behind it</h2>
    <p>Start with one unmet requirement. The workbench keeps the action, reason, affected resources, evidence, owner, and verification condition connected, with exact Databricks links when the evidence names a resource.</p>
    <ul>
      <li>Inspect observed and expected evidence with its confidence limits.</li>
      <li>See the workspace resources named by the selected requirement.</li>
      <li>Keep append-only context with the finding.</li>
    </ul>
  </div>
  <figure class="landing-figure">
    <img src="{{ '/assets/images/investigation-workbench.jpg' | relative_url }}" width="1024" height="576" loading="lazy" alt="Investigation workbench connecting an unmet requirement to its action, evidence, and three affected resources">
    <figcaption>Investigation stays requirement-led and opens the wider estate only when architecture relationships help.</figcaption>
  </figure>
</section>

<section id="improve" class="workflow-section">
  <div class="workflow-copy">
    <p class="section-kicker">Improve</p>
    <h2>Give the work an owner and a test</h2>
    <p>Improvement plans group work around an outcome. Each action records its owner, due date, implementation steps, requirements, and the condition a later assessment must observe.</p>
    <ul>
      <li>Track work from draft through completion or cancellation.</li>
      <li>Keep accepted risk separate from fixed work.</li>
      <li>Let a later run verify closure or show a contradiction.</li>
    </ul>
  </div>
  <figure class="landing-figure">
    <img src="{{ '/assets/images/improvement-plan.jpg' | relative_url }}" width="1024" height="576" loading="lazy" alt="Improvement action showing the required outcome, platform engineering owner, current standing, and later-run verification condition">
    <figcaption>Marking an action done does not change a requirement's outcome. A later assessment verifies it, or shows a contradiction if the requirement is still unmet.</figcaption>
  </figure>
</section>

<section id="operate" class="workflow-section">
  <div class="workflow-copy">
    <p class="section-kicker">Operate</p>
    <h2>Keep the assessment cycle moving</h2>
    <p>The operating queue puts unfinished reviews, contradicted actions, overdue work, expiring exceptions, and partial scheduled runs ahead of settled history.</p>
    <ul>
      <li>Resume the work that needs attention now.</li>
      <li>Review exact run history and closed reporting months.</li>
      <li>Manage retention, audit history, diagnostics, and the optional schedule.</li>
    </ul>
  </div>
  <figure class="landing-figure">
    <img src="{{ '/assets/images/operate.jpg' | relative_url }}" width="1024" height="576" loading="lazy" alt="Operate page prioritising an unfinished review, contradicted action, overdue work, expiring exception, and the latest scheduled run">
    <figcaption>Operate keeps the recurring queue visible while preserving the reports and runs behind it.</figcaption>
  </figure>
</section>

<section class="landing-boundary" aria-labelledby="coverage-title">
  <div>
    <p class="section-kicker">Coverage</p>
    <h2 id="coverage-title">Seven pillars, one evidence model</h2>
    <p>The App applies the same coverage, evidence, action, and verification model across the official Databricks Well-Architected Framework pillars.</p>
    <ul class="pillar-list">
      <li>Operational excellence</li>
      <li>Security, privacy, and compliance</li>
      <li>Reliability</li>
      <li>Performance efficiency</li>
      <li>Cost optimization</li>
      <li>Data and AI governance</li>
      <li>Interoperability and usability</li>
    </ul>
  </div>
  <aside class="boundary-card">
    <h3>Data and trust boundary</h3>
    <p>The SQL warehouse reads evidence from Databricks system tables and APIs. Accountable reviewers settle the practices that platform data cannot answer. Definitions, runs, evidence outcomes, reviews, reports, decisions, exceptions, plans, actions, notes, and audit history remain in customer-owned Lakebase.</p>
    <p>Interactive reads use the signed-in user's permissions. Mutations require direct membership in the configured assessor group. The App never asks for or stores a personal access token.</p>
    <p><strong>Alpha:</strong> v0.1.0 is for evaluation and field feedback. Its application-defined posture is not a Databricks certification.</p>
    <p>The landing page adapts to smaller screens. The App itself supports current desktop and laptop Chrome only. Tablet and mobile App layouts are not supported.</p>
  </aside>
</section>

<section class="landing-install" aria-labelledby="install-title">
  <p class="section-kicker">Safe installation</p>
  <h2 id="install-title">Bind first. Review the plan. Apply explicitly.</h2>
  <p>Start with an existing SQL warehouse, an existing Lakebase Autoscaling branch and database, and an assessor group whose direct members may run and review assessments. The bundle binds these customer-owned resources. It does not create or delete them.</p>
  <div class="install-steps">
    <div class="install-step">
      <strong>1. Validate</strong>
      <span>Resolve the workspace identity, resource bindings, and bundle configuration without changing the workspace.</span>
    </div>
    <div class="install-step">
      <strong>2. Preview</strong>
      <span>Inspect the complete Databricks Asset Bundle plan and fix every mismatch before continuing.</span>
    </div>
    <div class="install-step">
      <strong>3. Explicit apply</strong>
      <span>Apply the reviewed plan, verify the App and bindings, then confirm that the second plan has no changes.</span>
    </div>
  </div>
  <a class="landing-button landing-button-primary" href="{{ '/install/' | relative_url }}">Open the full installation guide</a>
</section>
