# Customer design system

**Status:** current product and visual authority  
**Approved direction:** 2026-08-21  
**Authority:** this document is the current customer and visual contract

This document defines what the product is meant to feel like, how its information is organised and what
every primary screen must help a customer do. It replaces the Architecture Studio kit, the measured
composition spec and implementation-era layout decisions as design authorities. Those artefacts remain
valuable history; they are not constraints on this system.

## Product promise

The app turns Databricks Well-Architected evidence into an understandable, defensible improvement
programme. It is not an evidence browser, a topology viewer or an administrative record directory. A
customer should always be able to answer:

1. Where does the estate stand, and how much of that posture is actually measured?
2. What material risk or opportunity deserves attention next?
3. Which named resources and observations support that conclusion?
4. What exactly should we do, where should we do it, and why?
5. Who owns the work, how will it be verified and what changed after it?
6. How do we communicate posture, assurance, progress and value to a sponsor or governor?

The customer loop is:

**Orient → identify a material gap → inspect evidence and affected resources → take an exact action →
verify improvement → communicate posture and governance.**

## Audience and reading modes

The same evidence serves different readers. The interface changes emphasis, not facts.

| Reader               | Opens the app to                               | Lead with                                             | Keep available                                               |
| -------------------- | ---------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------ |
| Executive sponsor    | Understand posture, material risk and progress | concise Dashboard and executive report                | confidence, governance assurance and evidence provenance     |
| Platform owner       | Decide what matters and coordinate improvement | ranked action queue, change and ownership             | affected resources, exact action and verification            |
| Engineer             | Diagnose and fix a requirement or opportunity  | named resources, observed state and exact destination | raw evidence, identifiers and relationship context           |
| Reviewer or partner  | Complete and defend an assessment              | current stage, outstanding decisions and scope        | source, timestamp, actor, methodology and publication record |
| Operator or governor | Keep the cycle healthy and auditable           | due work, failures, exceptions and cadence            | history, provenance, retention and technical records         |

Role-aware means these compositions offer the right entry point and report mode. It does not mean the
app invents a role from identity or hides evidence another authorised reader can inspect.

## Information architecture

### Persistent destinations

- **Dashboard** is the permanent orientation layer. It is always easy to reach and never disappears
  while a newer assessment is being collected or reviewed.
- **Assess** is Prepare → Collect → Review → Publish as one resumable guided journey.
- **Investigate** is the evidence-backed route from a material requirement to its affected resources,
  observation, expectation and closure plan.
- **Improve** is the owned work programme across WAF gaps and specialist opportunities, including
  validation and value records.
- **Operate** is the recurring inbox: review work, schedule health, due exceptions, history and cycle
  state.

Investigate and Improve share a requirement-to-action workspace and selection state; they remain distinct
navigation promises. Investigate explains and scopes the gap. Improve coordinates and verifies the work.

### Utilities

Methodology, check catalogue, audit trail, diagnostics, retention and installation settings remain
reachable through Utilities, search and contextual links. They do not compete with the five customer
destinations. Reports and exports are result actions, not permanent record-type sections.

### URL state

Assessment, requirement, opportunity, resource, action, report mode and meaningful filters are
deep-linkable. A customer can send the exact state they are discussing and reload it without losing the
selection. Compact responsive state does not create a different information model.

## Hierarchy contract

Every primary surface has three explicit levels.

### Primary — decide and act

- the current posture, material gap, workflow stage or owned action;
- the one dominant next action;
- the customer name of the selected requirement, resource or work item.

### Secondary — understand and coordinate

- why it matters;
- affected resources and resource kinds;
- evidence coverage or confidence;
- owner, status, due date and verification method;
- material change since the prior eligible result.

### Tertiary — inspect and defend

- raw observations and source payloads;
- platform identifiers, denominators and collection timestamps;
- actor, methodology revision, digest and technical provenance;
- qualification details and known limitations.

Tertiary information is never removed. It is grouped, labelled and disclosed when needed instead of
being allowed to flatten the page. A GUID may support a human name; it does not replace one.

## Action grammar

Every recommendation or opportunity uses the same order:

1. **Do this** — an imperative, concrete action.
2. **Why** — the evidence-bounded reason and expected governance or engineering intent.
3. **Where** — an exact deep link to the Databricks workspace surface or in-app workflow where the
   customer can act. If no safe exact link exists, say what is missing instead of presenting a generic
   button.
4. **Own** — assignee, status and due commitment where an action record exists.
5. **Verify** — how a later run or recorded validation will establish whether the gap changed.

The dominant button carries the action, not a generic “Learn more” or “View details” label. Evidence and
qualification follow the action. “No findings,” “nothing found SQL” and equivalent clean analyzer results
do not occupy an action queue; they may appear as one compact positive state when the customer asks for
that lens.

## Screen archetypes

### Dashboard — orient and prioritise

The Dashboard answers in one scan:

- where the estate stands;
- how much is measured and how that limits the reading;
- what materially changed;
- what needs action first;
- how to open the exact underlying work.

Posture, coverage and confidence are separate. A directional score is visually subordinate and links to
the work that would settle it. Pillars are comparable without forcing eight equal cards or treating every
score as equally trustworthy. The priority queue is customer work, not a list of every record the system
contains.

### Assess — guide one defensible result

Assess makes the current Prepare, Collect, Review or Publish stage unmistakable. It shows the remaining
decision, the evidence needed to make it and one next action. Existing answers precede requests to replace
them. A completed run exposes its indicative per-pillar scores with coverage, evidence composition and the
human-evidence review work; publication is still required before the app presents final posture, change, reports or
exports. Refusal and partial states explain what is unavailable and preserve the customer's completed work.

### Investigate — explain one material gap

Investigate begins with a selected unmet requirement, change or material opportunity—not an unfiltered
estate graph. It shows named affected resources and resource kinds, the observed and expected state, the
evidence and its limits, then the closure plan. Topology is an optional relationship aid for cases where
relationships answer a customer question. A list remains available and is the compact default.

### Improve — own and verify closure

Improve ranks WAF and specialist work by the facts the app actually carries. Selected work leads with
the action grammar above, then ownership, baseline, validation and value. Specialist qualification is
inspectable evidence, not the primary call to action. Clean results are filtered away from the work queue.

### Operate — run the recurring cycle

Operate is an actionable inbox, not a history directory. Due review work, schedule failure, expiring
exception and stale evidence appear before settled records. History remains searchable and deep-linkable.
The interface reports current policy and recorded run fields without predicting platform behavior.

### Executive and governance reports — communicate trust

Reports open with assessment identity, posture, coverage and material change; then material risks,
improvement progress or value, governance assurance and next decisions. Methodology, scope, evidence
composition, limitations, digests and technical identities remain available as an audit appendix. Screen,
print and PDF output preserve hierarchy and readable tables.

## Visual language

### Typography

Use the AppKit and Databricks host system stack. Type roles—not a globally frozen pixel ramp—create rank:
display for report or Dashboard statements, page title, section title, body, compact metadata, numeric and
monospace evidence. Sizes may vary by composition and viewport through shared role tokens. A page does not
gain hierarchy by making every label small.

### Depth and surfaces

Use tone, border, spacing and controlled elevation together. The customer must be able to distinguish:

- application canvas;
- primary task or report surface;
- supporting section;
- selected or actionable item;
- inset evidence or technical disclosure;
- transient menu, dialog or sheet.

Persistent elevation is allowed when it communicates rank, containment or action. Radius is chosen by
component role rather than capped at one historic value. Avoid a wall of independent floating cards; do
not avoid all cards so aggressively that everything becomes one flat sheet.

### Colour

Use semantic tokens and preserve identical meaning in light and dark themes. Interaction, status,
severity, confidence and resource kind may use restrained colour with text or icon support. Lava remains a
small identity accent. Do not create a decorative brand colour per pillar or use gradients and glass as
decoration.

The dark theme must establish visible tonal steps. Token acceptance measures adjacent surfaces as well as
text contrast; a technically different hex value that remains perceptually flat does not pass.

### Spacing and density

Dense means relevant information is close to its action, not that every available fact is visible.
Whitespace groups and ranks content. Empty containers collapse. Long evidence and large estates use
pagination, virtualization or a dedicated browsing mode instead of forcing every page into an internal
scrolling box.

### Iconography and resources

Icons support labels and never become the only meaning. Resource kind is visible before a technical ID
and uses one consistent icon, label and restrained colour treatment across Dashboard, investigation,
topology and actions. Human-readable workspace names lead wherever the platform provides them.

## Layout and responsive behavior

The document may scroll. A fixed viewport is appropriate for a true canvas interaction; it is not a
product-wide rule. Prefer normal document flow and sticky local context over nested scroll regions.

- **Wide desktop:** use the available host canvas. Dashboard and reports may use editorial grids;
  investigation may use master-detail, an inspector or an optional canvas when the selected task needs it.
- **Laptop:** preserve the primary action and selected context above optional telemetry. Columns may stack
  before labels or actions become cramped.
- **Tablet and mobile:** are outside the pilot support target. Existing compact behavior may remain and
  should not be deliberately broken, but these widths do not block a release and do not create a second
  information architecture to maintain.

No supported viewport may require horizontal document scrolling. Code and identifiers wrap or receive a
dedicated copy affordance without hiding their content.

## Interaction states

Build and review default, hover, selected, focus-visible, disabled, loading, empty, partial, permission,
error, success and stale states for every primary pattern. Loading names the work. Empty states explain
the value and the action that creates or locates the first useful record. Errors preserve context and a
safe recovery route. Motion communicates state change, never decoration, and respects reduced motion.

## Accessibility

- Meet WCAG 2.2 AA for text, controls, focus and non-text contrast.
- Complete every primary journey by keyboard in reading order.
- Use one clear page heading and semantic landmarks; headings reflect content hierarchy rather than a
  plane implementation.
- Never use colour, position, animation or an icon as the sole carrier of meaning.
- Keep topology and visual comparisons paired with equivalent labelled lists or tables.
- Move focus only after a customer action is accepted, and announce async results without stealing focus.
- Test zoom, text resizing, reduced motion and meaningful screen-reader names before a surface lands.

Accessibility is part of the shared foundation and each page's acceptance, not a retrofit gate.

## Evidence and content rules

The UI may restate a field the app read. It may not conclude what the platform will do, has finished doing
or would do under other conditions. A sentence may be no more specific than its payload: no definite
article, count, causal claim or prediction that the fields do not carry.

Use customer names, not repository plans, PRs, fixtures or implementation labels. State limitations in
plain language near the claim they limit. Technical provenance belongs in the tertiary level. Exact
resource or workspace links are preferred to generic documentation links, but only when the platform
identity needed to build them is present.

## Engineering contract

- Semantic tokens are the public styling API. Raw colour and unreviewed one-off geometry remain checked.
- Shared components encode roles such as task, section, action, evidence and disclosure; they do not
  encode one universal pane count or page shape.
- Tests assert action reachability, semantic hierarchy, accessible names, deep-link restoration and
  responsive task completion. Markup and class snapshots do not preserve an obsolete visual system.
- `npm run check:design-system` must enforce the current system and may be amended with it. It is not a
  whitelist of all valid appearance.

## Visual-development and release loop

1. Build deterministic local states for the screen or component.
2. Drive latest stable Chrome locally in light and dark at representative desktop and laptop widths.
3. Review hierarchy at a glance, then complete the interaction with keyboard and pointer.
4. Run source, accessibility, contrast, viewport and deep-link checks against the production client build.
5. Use the supported DAB path only when bundle configuration, Databricks resources,
   authentication, deep links or served assets need verification.
6. Compare the served customer journey with the approved local state before release.

## Authority and deprecation map

| Artefact                                              | Current status                     | What remains useful                                                                                                          |
| ----------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| This document                                         | current authority                  | product, IA, hierarchy, visual, responsive and acceptance contract                                                           |
| Historical design kits and implementation notes      | superseded for visual authority    | factual context and measured defects; current decisions are restated here                                                     |
| `app/scripts/check-design-system.mjs`                 | current guard                      | semantic-token, accessible-semantics and accidental-divergence enforcement; obsolete structural rules were removed in `126b` |
| `Plane`, `Panes`, `Workbench` and `Detail` primitives | deprecated implementation          | existing pre-`126` behavior only; no new call sites while primary journeys migrate to role-based surfaces                    |
| `useFitRows` and `.wa-fit-*` layout                   | deprecated implementation          | measured history for old fixed-height panels; document flow, pagination or virtualization replace it                         |

Historical delivery files remain in the private development record rather than this distribution repository.
