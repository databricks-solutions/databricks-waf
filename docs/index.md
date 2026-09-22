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
    <img src="{{ '/assets/images/dashboard.jpg' | relative_url }}" width="1270" height="714" alt="WAF assessment Dashboard showing posture, evidence coverage, confidence, unmet requirements, and the first recommended action">
    <figcaption>The Dashboard keeps posture, coverage, material change, and the next action in one view.</figcaption>
  </figure>
</section>

<section id="journey" class="landing-journey" aria-labelledby="journey-title">
  <div class="journey-intro">
    <p class="section-kicker">Customer journey</p>
    <h2 id="journey-title">Eight steps from scope to an operating cycle</h2>
    <p>Use this sequence to see where people make decisions and where the App preserves evidence. The detailed screenshots below pick up the same journey from Review onwards.</p>
  </div>
  <ol class="journey-list">
    <li>
      <h3>Prepare</h3>
      <p><strong>You:</strong> Choose the workspace scope, pillars, owners, lookback, and optional targets.</p>
      <p><strong>App records:</strong> A reusable assessment definition or the deliberate scope for a one-off run.</p>
    </li>
    <li>
      <h3>Collect</h3>
      <p><strong>You:</strong> Confirm the scope and start automated collection.</p>
      <p><strong>App records:</strong> Read-only evidence from permitted sources, visible gaps, and an indicative result.</p>
    </li>
    <li>
      <h3>Review</h3>
      <p><strong>You:</strong> Supply the remaining human evidence, then confirm or skip each selected pillar.</p>
      <p><strong>App records:</strong> Accountable answers, rationale, owners, review dates, and explicit pillar decisions.</p>
    </li>
    <li>
      <h3>Publish</h3>
      <p><strong>You:</strong> Publish after every selected pillar has a decision.</p>
      <p><strong>App records:</strong> An immutable report tied to scope, methodology, evidence, and reviewer decisions.</p>
    </li>
    <li>
      <h3>Investigate</h3>
      <p><strong>You:</strong> Trace an unmet requirement to its evidence and affected resources.</p>
      <p><strong>App records:</strong> Append-only context alongside the requirement, action, owner, and verification condition.</p>
    </li>
    <li>
      <h3>Improve</h3>
      <p><strong>You:</strong> Assign actions, due dates, implementation steps, and expected outcomes.</p>
      <p><strong>App records:</strong> Improvement plans and action status without changing the measured outcome.</p>
    </li>
    <li>
      <h3>Verify</h3>
      <p><strong>You:</strong> Run a later comparable assessment after the improvement work is complete.</p>
      <p><strong>App records:</strong> Later evidence that verifies closure or contradicts the completed action.</p>
    </li>
    <li>
      <h3>Operate</h3>
      <p><strong>You:</strong> Work the recurring queue and inspect run, month, retention, audit, and diagnostic history.</p>
      <p><strong>App records:</strong> The open reviews, overdue work, exceptions, contradictions, and settled history behind the cycle.</p>
    </li>
  </ol>
  <a class="journey-link" href="{{ '/user-guide/' | relative_url }}">Read the full customer journey guide</a>
</section>

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
    <img src="{{ '/assets/images/assessment-review.jpg' | relative_url }}" width="1280" height="720" loading="lazy" alt="Assessment Review page separating measured evidence, unanswered practices, and pillar decisions">
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
    <img src="{{ '/assets/images/published-report.jpg' | relative_url }}" width="1270" height="714" loading="lazy" alt="Published architecture report showing assessed scope, measured posture, open requirements, and improvement work">
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
    <img src="{{ '/assets/images/investigation-workbench.jpg' | relative_url }}" width="1280" height="720" loading="lazy" alt="Investigation workbench connecting an unmet requirement to its action, evidence, and three affected resources">
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
    <img src="{{ '/assets/images/improvement-plan.jpg' | relative_url }}" width="1280" height="720" loading="lazy" alt="Improvement action showing the required outcome, platform engineering owner, current standing, and later-run verification condition">
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
    <img src="{{ '/assets/images/operate.jpg' | relative_url }}" width="1280" height="720" loading="lazy" alt="Operate page prioritising an unfinished review, contradicted action, overdue work, expiring exception, and the latest scheduled run">
    <figcaption>Operate keeps the recurring queue visible while preserving the reports and runs behind it.</figcaption>
  </figure>
</section>

<section class="landing-boundary" aria-labelledby="coverage-title">
  <div>
    <p class="section-kicker">Coverage</p>
    <h2 id="coverage-title">Explore what each pillar assesses</h2>
    <p>Open a pillar to see every requirement, grouped by catalogue principle. This snapshot is generated from the same versioned control catalogue used by the App.</p>
    {{ pillar_snapshots }}
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
