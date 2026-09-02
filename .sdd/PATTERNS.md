# WAF Implementation Patterns Reference

Complete implementation guide for adding controls, resolvers, collectors, and the admin-evidence bridge to the Databricks WAF assessment tool.

---

## A. Control YAML Schema

### Control File Structure
Controls are defined in YAML files under `/app/config/controls/` (one per pillar). The JSON Schema is the authority: `/app/config/controls/catalogue.schema.json` lines 47–178.

### Full Field Reference

A **measured control** example from `operational-excellence.yaml` lines 34–46 (system-table):
```yaml
- id: OE-01-02
  title: Use Enterprise source code management (SCM)
  provenance: waf-docs
  source_anchor: https://docs.databricks.com/aws/en/lakehouse-architecture/operational-excellence/best-practices#use-enterprise-source-code-management-scm
  evaluator_status: implemented
  measurability: system-table
  collector: sql:jobs.inventory
  severity: medium
  alias_group: infrastructure-as-code
  criteria: >-
    Same measurement as OE-02-01, read as the source-control requirement. Scored once. Caps at
    partial for the same reason: a Terraform-managed estate carries no marker and cannot be
    told from a hand-built one, so the absence of bundles asks rather than fails.
```

An **attestation control** example from `operational-excellence.yaml` lines 14–33:
```yaml
- id: OE-01-01
  title: Create a dedicated Databricks operations team
  provenance: waf-docs
  source_anchor: https://docs.databricks.com/aws/en/lakehouse-architecture/operational-excellence/best-practices#create-a-dedicated-databricks-operations-team
  measurability: attestation
  severity: medium
  evaluator_status: unimplemented
  attestation:
    question: >-
      Is there a named team or person accountable for the platform itself, distinct from the
      teams building on it?
    evidence_guidance: Who is on call for the platform, and what they own that the workload teams do not.
    cadence_days: 365
    asked_because:
      verdict: beyond-telemetry
      why: >-
        Whether a team exists and what it is accountable for is an organisational fact. No
        table records reporting lines, and a workspace with one attentive engineer looks
        identical to a workspace with a staffed platform team.
```

### Key Fields and Relationships

| Field | Required | Applies To | Meaning |
|-------|----------|-----------|---------|
| `id` | Yes | All | Pattern: `[A-Z]{2}-\d{2}-\d{2}` |
| `title` | Yes | All | Display name |
| `provenance` | Yes | All | One of: `waf-docs`, `security-guide`, `extension` |
| `measurability` | Yes | All | One of: `system-table`, `rest-api`, `cloud-api`, `attestation`, `derived` |
| `evaluator_status` | Yes | All | One of: `implemented`, `planned`, `unimplemented` |
| `severity` | Yes | All | One of: `critical`, `high`, `medium`, `low`, `informational` |
| `collector` | Yes* | Measured only | Signal ID mapping to a collector (e.g., `sql:jobs.inventory`, `rest:workspace:token.list`) |
| `criteria` | No* | Measured | Plain-language description of pass/fail; required for complex logic |
| `thresholds` | No | Measured | Object with numeric bounds (e.g., `{ pass: 0.8, partial: 0.4 }`) |
| `attestation` | Yes* | Attestation only | Object with `question`, `evidence_guidance`, `cadence_days`, `asked_because` |
| `remediation` | No | All | Object with `summary`, and one of: `sql`, `cli`, `terraform`, `by_hand` + optional `doc_url` |
| `alias_group` | No | All | When controls from different pillars measure the same thing, share this string to score once |
| `source_ref` | Yes* | `security-guide` | Upstream identifier (e.g., `IA-4`) |
| `rationale` | Yes* | `extension` | Why this control was added (min 40 chars) |

### Lifecycle: planned → implemented

To flip a control from `attestation` / `planned` to a live measured evaluator:

1. **Set `evaluator_status: implemented`**
2. **Set `measurability` to one of: `system-table`, `rest-api`, `cloud-api`** (not `attestation`)
3. **Add `collector`** referencing an existing or new signal ID
4. **Remove the `attestation` field** (schema enforces this)
5. **Write the resolver** (see section C)
6. **Validate schema** with `npm run validate:catalogue`

---

## B. Statement (SQL Signal) Files

### File Format and Location
SQL signal files live in `/app/config/statements/` as `{signal_id_name}.sql`, named after their signal but with colons replaced by underscores and dots by underscores. Example: signal `sql:jobs.inventory` → file `jobs_inventory.sql`.

### Header Contract
Every statement starts with a header block (lines 1–52 of `jobs_inventory.sql`):
```sql
-- Signal: sql:jobs.inventory
-- Rows: one per job
-- Benchmark: inventory
-- Slice: workspace_id, job_id
--
-- Detailed documentation of what the query does, assumptions, caveats about NULL columns,
-- filters applied, and how it relates to other controls.
--
-- Feeds: OE-02-04 (streaming triggers), REL-01 (job health), ...
```

Key header lines:
- `Signal:` the exact signal ID
- `Rows:` cardinality (one per X or aggregate)
- `Benchmark:` class for cost reporting (e.g., `inventory`, `spend`, `activity`)
- `Slice:` partition keys for the scan (how to split the result)
- `Feeds:` which control IDs this signal answers

### SQL Template Parameters
Statements use template parameters (e.g., `:workspace_id`) that the query runner substitutes:

From `jobs_inventory.sql` lines 56–62:
```sql
WITH ranked AS (
  SELECT
    *,
    ROW_NUMBER() OVER (PARTITION BY workspace_id, job_id ORDER BY change_time DESC) AS recency
  FROM system.lakeflow.jobs
  WHERE (:workspace_id = '' OR workspace_id = :workspace_id)
    AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), workspace_id))
),
```

Standard parameters:
- `:workspace_id` — filter to one workspace or empty string for all
- `:live_workspace_ids` — comma-separated list of workspace IDs
- `:lookback_days` — historical window (commonly 30, 90 or 180)

### Lifecycle and Recency Filtering

From `jobs_inventory.sql` lines 63–69:
```sql
latest as (
  SELECT *
  FROM ranked
  WHERE recency = 1
    AND delete_time IS NULL
)
```

Pattern: use `ROW_NUMBER()` over a timestamp, pick `recency = 1`, then filter lifecycle columns. Do NOT filter lifecycle in the window predicate — see lines 7–15 of the same file for why.

### System Tables Used by Existing Statements

| Signal | Primary Tables |
|--------|----------------|
| `sql:jobs.inventory` | `system.lakeflow.jobs` |
| `sql:uc.census` | `system.information_schema.catalogs`, `tables`, `views`, `metastores` |
| `sql:security.auth_login_paths` | `system.access.audit` (filtered on `action_name`) |
| `sql:pipelines.inventory` | `system.lakeflow.pipelines` |
| `sql:compute.clusters` | `system.compute.clusters` |
| `sql:uc.lineage_coverage` | `system.access.table_lineage` |
| `sql:estate.compute_profile` | `system.billing.usage` + `system.compute.clusters` |

---

## C. Resolver Pattern

### Function Signature
Resolvers are functions that return a `ControlResolver` type. From `/app/server/resolve/resolver.ts` lines 96–180:

```typescript
export interface Resolution {
  readonly outcome: Outcome;           // 'pass' | 'fail' | 'partial' | 'not-applicable' | 'unmeasurable'
  readonly evidence: readonly Evidence[];
  readonly outcomeReason?: string;
  readonly unmeasured?: Unmeasured;    // For 'unmeasurable': 'unreadable' or 'attestation'
  readonly remedy?: Remedy;
}
```

The `ControlResolver` interface (implied through registration) receives:
```typescript
type ControlResolver = {
  readonly controls: readonly string[];  // Which control IDs this resolves
  resolve(context: ResolverContext): Resolution;
}
```

### Real Resolver Example

From `/app/server/resolve/resolvers/operational-excellence.ts` lines 59–94 (OE-02-03, managed tables):

```typescript
const managedTables = enrichedBy(
  [VISIBILITY_CROSS_CHECK],
  fromSignal<AssetCensus>(CENSUS, ['OE-02-03'], (census, context) => {
    const storage = census.managedTables + census.externalTables;
    if (storage === 0) {
      return (
        (census.tableCount === 0 ? unestablishedEmptiness(context) : undefined) ??
        notApplicable(
          census.tableCount === 0
            ? 'This metastore contains no tables, so there is no storage to manage.'
            : `All ${census.tableCount} catalogued objects are views, which have no storage of their own to manage.`
        )
      );
    }

    const managed = share(census.managedTables, storage);
    return {
      outcome: bandOutcome(managed, bandsOf(context.spec, { pass: 0.8, partial: 0.4 })),
      evidence: [
        evidenceFrom(
          context,
          CENSUS,
          `${census.managedTables} of ${storage} tables are managed by Unity Catalog, ` +
            `${census.externalTables} are external (${percent(managed)} managed)`,
          'Tables are managed by Unity Catalog, so layout, statistics and cleanup are the platform's job'
        ),
      ],
      outcomeReason:
        'Managed tables get predictive optimization, automatic file compaction and vacuuming without anyone ' +
        'scheduling them. External tables are sometimes unavoidable — data written by a system outside this ' +
        'account cannot be managed — so treat the external share as a question to answer rather than a defect.',
    };
  })
);
```

### Verdict Helpers

From `/app/server/resolve/resolvers/helpers.ts` (implied, referenced in line 24):
- `bandOutcome(proportion, bands)` — maps a decimal to `pass`/`partial`/`fail` based on thresholds
- `notApplicable(reason)` — returns `{ outcome: 'not-applicable' }`
- `unmeasured(reason, kind)` — returns `{ outcome: 'unmeasurable', unmeasured: kind }`
- `evidenceFrom(context, signalId, observed, meaning)` — attaches a citation

### Registry and Export

From `/app/server/resolve/resolvers/index.ts` lines 481–489:

```typescript
export const OPERATIONAL_EXCELLENCE_RESOLVERS: readonly ControlResolver[] = [
  managedTables,
  automatedJobs,
  declarativePipelines,
  infrastructureAsCode,
  standardizedCompute,
  catalogStrategy,
  monitoring,
];
```

Then in the same file, the registry (lines 49–53):
```typescript
export function buildRegistry(): ResolverRegistry {
  const registry = new ResolverRegistry();
  for (const resolver of ALL) registry.register(resolver);
  return registry;
}
```

**Adding a new resolver:** Create the resolver function in a pillar file, export it in an array, add the array to `ALL` in `index.ts`.

---

## D. REST Collector Pattern

### Probe Definition

From `/app/server/collect/rest/probes.ts` lines 71–100 (workspace-conf probe):

```typescript
const workspaceConf: Probe = {
  id: 'rest:workspace:preview.workspace-conf',
  label: 'workspace-conf',
  what: 'The workspace security settings',
  endpoint: 'GET /api/2.0/workspace-conf',
  permission: 'workspace admin',
  scope: 'settings',
  grantable: false,
  async run(client): Promise<WorkspaceSettings> {
    const answer = (await client.workspaceConf.getStatus({ keys: REQUESTED_KEYS.join(',') })) as Record<
      string,
      unknown
    >;

    const values = new Map<string, string | null>();
    const unanswered: string[] = [];
    for (const key of REQUESTED_KEYS) {
      if (!(key in answer)) {
        unanswered.push(key);
        continue;
      }
      values.set(key, asSettingValue(answer[key]));
    }

    return { values, unanswered };
  },
};
```

### Probe Interface (`Probe`)

| Field | Type | Meaning |
|-------|------|---------|
| `id` | `SignalId` | Must start with `rest:` (format: `rest:{tier}:{endpoint_path}`) |
| `label` | string | Short name for logs and reports |
| `what` | string | Sentence fragment: "…was refused" or "…could not be read" |
| `endpoint` | string | API path (used in audit logs and documentation) |
| `permission` | string | Who in the workspace can read it |
| `scope` | string | OAuth scope required (as reported by refusals) |
| `grantable` | boolean | Whether apps can request this scope (see ADR 0016) |
| `run()` | async | Executes the call, returns typed data or throws |

### Registration

All probes must be added to the `PROBES` array in `/app/server/collect/rest/probes.ts` line 204:
```typescript
export const PROBES: readonly Probe[] = [workspaceConf, tokens, servingEndpoints, vectorSearchEndpoints];
```

### Declared App Scopes

From `/app/app.yaml` lines 84–126, the scopes the app requests:
```yaml
user_api_scopes:
  - sql.statement-execution
  - sql.warehouses:read
  - catalog.catalogs:read
  - catalog.schemas:read
  - catalog.tables:read
  - model-serving
  - vector-search
  - sql.query-history:read
```

These must match the scopes probes actually need. Mismatch is caught by CI (`npm run check:read-only`).

### Refused API Families (ADR 0016)

From lines 93–113 of app.yaml and `/app/server/collect/rest/reach.ts`, these scopes are refused by the platform and cannot be granted:
- `settings` (workspace settings)
- `authentication` (token management)
- `clusters` (cluster ACLs)
- `secrets` (secret scope ACLs)

These force controls to remain `attestation` unless the platform changes.

---

## E. Store + Migrations

### Schema Definition
From `/app/server/store/postgres.ts` lines 209–393, schema is created idempotently in `ensureSchema()`:

```typescript
export async function ensureSchema(sql: Sql, schema: string): Promise<void> {
  await sql.query(`create schema if not exists ${schema}`);

  // Scan history and summary
  await sql.query(`
    create table if not exists ${schema}.scans (
      id          text        primary key,
      started_at  timestamptz not null,
      summary     jsonb       not null,
      body        jsonb       not null,
      written_at  timestamptz not null default now()
    )
  `);

  // Imported evidence (admin-collected)
  await sql.query(`
    create table if not exists ${schema}.imported_evidence (
      digest       text        primary key,
      generated_at timestamptz not null,
      imported_at  timestamptz not null,
      imported_by  text        not null,
      body         jsonb       not null,
      cautions     jsonb       not null,
      written_at   timestamptz not null default now()
    )
  `);

  // Attestations (append-only)
  await sql.query(`
    create table if not exists ${schema}.attestations (
      id          text        primary key,
      control_id  text        not null,
      attested_at timestamptz not null,
      body        jsonb       not null,
      written_at  timestamptz not null default now()
    )
  `);

  // Decisions (risk acceptance, append-only)
  await sql.query(`
    create table if not exists ${schema}.decisions (
      id          text        primary key,
      control_id  text        not null,
      decided_at  timestamptz not null,
      body        jsonb       not null,
      written_at  timestamptz not null default now()
    )
  `);

  // Audit trail (chained, append-only)
  await sql.query(`
    create table if not exists ${schema}.audit_events (
      sequence    bigint      primary key,
      id          text        not null unique,
      at          timestamptz not null,
      actor       text        not null,
      action      text        not null,
      outcome     text        not null,
      target_id   text,
      correlation text,
      previous    text        not null,
      digest      text        not null,
      body        jsonb       not null,
      written_at  timestamptz not null default now()
    )
  `);
}
```

### Migration Pattern
**No migration framework exists** (ADR 0031). All schema changes are idempotent:
- Use `create table if not exists` for new tables
- Use `alter table ... add column if not exists` for additions
- Drop columns only if the app never reads them (and keep the index management clean)

Example from line 338:
```typescript
await sql.query(`alter table ${schema}.imported_evidence add column if not exists summary jsonb`);
```

### Persistence and Append-Only

Findings are derived from immutable sources:
- **Scans**: read-only history
- **Attestations**: append-only (new row = new answer, old row kept for audit)
- **Decisions**: append-only (superseding recorded explicitly)
- **Audit trail**: append-only chained log (see lines 340–368)

---

## F. Admin-Evidence Bridge

### Evidence Import Flow

1. **Collection**: Admin runs `/app/config/evidence/collect-evidence.py` (outside this app)
2. **Upload**: File arrives at the app's `/api/import` endpoint
3. **Parsing**: `/app/server/import/envelope.ts` validates JSON shape
4. **Reviving**: `/app/server/import/signals.ts` converts JSON to live signal shapes
5. **Resolution**: Resolvers read imported signals indistinguishably from live ones

### Envelope Structure

From `/app/server/import/envelope.ts` lines 124–135:
```typescript
export interface Envelope {
  readonly schema: typeof SCHEMA;  // Always 'waf-admin-evidence/1'
  readonly generatedAt: string;    // When the script ran
  readonly script: { readonly name: string; readonly version: string; readonly digest: string };
  readonly cli: { readonly version: string };
  readonly tiers: { readonly workspace: TierRecord; readonly account: TierRecord };
  readonly probes: readonly ProbeRecord[];
  readonly deferred: readonly DeferredRecord[];
  readonly digest: string;  // Re-computed at import
}
```

### Reviving Imported Signals

From `/app/server/import/signals.ts` lines 75–91 (workspace settings reviver):

```typescript
const workspaceSettings: Reviver = (probe): WorkspaceSettings => {
  const answered = asObject(probe.value);
  const values = new Map<string, string | null>();
  const unanswered: string[] = [];

  // Declared fields are the keys the script asked for
  for (const key of probe.fields) {
    if (!(key in answered)) {
      unanswered.push(key);
      continue;
    }
    values.set(key, asSettingValue(answered[key]));
  }

  return { values, unanswered };
};
```

**Key pattern**: Each reviver rebuilds the exact shape a live collector would return. The resolver cannot tell them apart.

### Signal Registry

From `/app/server/import/signals.ts` lines 131–134, only declared signals are revived:
```typescript
const REVIVERS: ReadonlyMap<SignalId, Reviver> = new Map<SignalId, Reviver>([
  ['rest:workspace:preview.workspace-conf', workspaceSettings],
  ['rest:workspace:token.list', tokenInventory],
]);
```

**To support an imported signal**: Write a reviver function (converts JSON → live shape), add it to `REVIVERS` map with the signal ID as key.

### "Collected, Held" vs "Imported"

From `/app/server/import/signals.ts` lines 1–31:

- **Collected**: The app read it live from the platform at scan time
- **Held**: In the file but unrevived (no reviver for that signal ID yet)
- **Imported**: Successfully revived and offered to resolvers

Distinguishing happens via `mayDecideOver()` (not shown but referenced line 26): live readings **never** replaced by imports (live wins).

### Import Store

From `/app/server/store/postgres.ts` lines 299–338:
```typescript
// Evidence an admin collected and somebody uploaded
await sql.query(`
  create table if not exists ${schema}.imported_evidence (
    digest       text        primary key,
    generated_at timestamptz not null,
    imported_at  timestamptz not null,
    imported_by  text        not null,
    body         jsonb       not null,
    cautions     jsonb       not null,
    written_at   timestamptz not null default now()
  )
`);
```

**Provenance tracking**: Each imported reading is stamped with `imported_by` (the user who uploaded it) and `imported_at` (when).

---

## G. Confidence + Provenance

### ConfidenceStanding Model

From `/app/server/resolve/confidence.ts` lines 32–72:

```typescript
export type ConfidenceStanding = 'established' | 'qualified' | 'stated' | 'none';

export interface Confidence {
  readonly standing: ConfidenceStanding;
  readonly because: string;
  readonly limitations: readonly Limitation[];
}

export type LimitationKind =
  | 'sampled'      // Part of the population examined
  | 'reach'        // Reading covers less than the whole account
  | 'imported'     // Read by admin under their authority, not this app's
  | 'attested'     // Somebody's answer about a practice
  | 'expiring'     // That answer expires soon (within 30 days)
  | 'carried';     // Evidence from an earlier run carried forward
```

### Derivation (Never Stored)

From lines 98–106:
```typescript
export function confidenceOf(finding: Finding, circumstances: Circumstances = {}): Confidence {
  if (finding.outcome === 'unmeasurable') {
    return { standing: 'none', because: 'Nothing was established, so there is no confidence to report.', limitations: [] };
  }

  const limitations = limitationsOf(finding, circumstances);
  const standing = standingOf(finding, limitations);
  return { standing, because: because(standing, limitations), limitations };
}
```

**Key invariant**: Confidence is derived from a finding's existing fields every time it is read. No separate storage.

### Standing Rules

From lines 108–111:
- `attested` evidence → standing `'stated'`
- No limitations → standing `'established'`
- One or more limitations → standing `'qualified'`
- `unmeasurable` outcome → standing `'none'` (nothing to qualify)

### Provenance Stamps

From `/app/server/resolve/finding.ts` (implied through Evidence), each piece of evidence carries:
- `evidenceClass: 'observed' | 'admin-collected' | 'attested'`
- `collectedAt: Date` (when it was obtained)
- `source: string` (signal ID or attestation ID)

These fields populate the `limitations` list automatically.

---

## H. Test Framework

### Test Command
From `/app/package.json` lines 24–25:
```json
"test": "vitest run",
"test:live": "node scripts/test-live.mjs",
```

Run the full suite:
```bash
npm run test
```

Check coverage and resources:
```bash
npm run check:coverage -- --write    # Update coverage ledger
npm run check:resources              # Verify all required endpoints used
npm run check:read-only              # Verify no write calls beyond declared scopes
```

### Resolver Test Example

From `/app/server/resolve/resolvers/operational-excellence.test.ts` lines 124–148:

```typescript
import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../../catalogue/catalogue.js';
import { observed, unmeasurable, type SignalId, type SignalResult } from '../../collect/signal.js';
import type { AssetCensus, ClusterRow, JobRow, LineageCoverage, PipelineRow } from '../../collect/sql/shapes.js';
import { resolveControl } from '../resolver.js';
import { buildRegistry } from './index.js';

const CENSUS = 'sql:uc.census' as SignalId;
const catalogue = loadCatalogue();
const registry = buildRegistry();

function census(overrides: Partial<AssetCensus> = {}): AssetCensus {
  return {
    tableCount: 120,
    catalogCount: 4,
    managedTables: 100,
    externalTables: 20,
    // ... defaults
    ...overrides,
  };
}

function signalsOf(entries: readonly [SignalId, unknown][]): Map<SignalId, SignalResult> {
  return new Map(entries.map(([id, value]) => [id, observed(id, value, 1, { mode: 'complete' })]));
}

describe('OE-02-03, Unity Catalog managed tables', () => {
  it('passes an estate whose storage is managed', () => {
    const finding = resolveControl(
      catalogue.controls.find((c) => c.id === 'OE-02-03')!,
      signalsOf([[CENSUS, census({ managedTables: 115, externalTables: 5 })]]),
      registry.get('OE-02-03')
    );
    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.observed).toContain('115 of 120');
  });

  it('excludes views from both halves of the share', () => {
    const finding = resolveControl(
      catalogue.controls.find((c) => c.id === 'OE-02-03')!,
      signalsOf([[CENSUS, census({ tableCount: 40, managedTables: 0, externalTables: 0, views: 40 })]]),
      registry.get('OE-02-03')
    );
    expect(finding.outcome).toBe('not-applicable');
    expect(finding.outcomeReason).toContain('views');
  });
});
```

### Statement Test Pattern
SQL statements are tested through resolver tests that feed observed signals. Direct SQL tests verify edge cases (NULL columns, recency filtering) in `/app/scripts/*.test.ts` files.

---

## I. Add-a-Control Checklist

### Step-by-Step for One New Measured Control

**1. Add control definition to YAML**
   - File: `/app/config/controls/{pillar}.yaml` (e.g., `operational-excellence.yaml`)
   - Fields: `id`, `title`, `provenance`, `measurability: system-table` (or `rest-api`, `cloud-api`)
   - Add `collector: {signal_id}` (either existing or new)
   - Set `evaluator_status: implemented` (live) or `planned` (future)
   - Add `severity`, `criteria`, optionally `remediation` and `thresholds`
   - Validate: `npm run validate:catalogue`

**2. Create or reuse a signal (SQL or REST)**

   **For SQL signals:**
   - File: `/app/config/statements/{signal_name}.sql` (e.g., `jobs_inventory.sql`)
   - Start with header: `-- Signal: sql:pillar.name`, `-- Rows: ...`, `-- Feeds: CONTROL-ID`
   - Use standard parameters: `:workspace_id`, `:live_workspace_ids`, `:lookback_days`
   - Use `system.*` tables, apply lifecycle filters (e.g., `delete_time IS NULL`)
   - Query must return consistent shape across runs

   **For REST signals:**
   - Add to `/app/server/collect/rest/probes.ts`
   - Implement `Probe` interface (lines 25–68)
   - Use existing scopes or add new one to `/app/app.yaml` (with grantability assessment)
   - Add to `PROBES` array (line 204)

**3. Write a resolver**
   - File: `/app/server/resolve/resolvers/{pillar}.ts` (e.g., `operational-excellence.ts`)
   - Use `fromSignal<T>(SIGNAL_ID, [CONTROL_IDS], (data, context) => { ... })` pattern
   - Return `Resolution` with `outcome`, `evidence` array, and optional `outcomeReason`
   - Use helpers: `bandOutcome()`, `notApplicable()`, `unmeasured()`, `evidenceFrom()`
   - Export in a `*_RESOLVERS` array (e.g., `OPERATIONAL_EXCELLENCE_RESOLVERS`)

**4. Register resolver**
   - File: `/app/server/resolve/resolvers/index.ts`
   - Add import: `import { PILLAR_RESOLVERS } from './pillar.js'`
   - Add to `ALL` array (line 28)
   - Registry startup will verify no duplicate control IDs

**5. Write tests**
   - File: `/app/server/resolve/resolvers/{pillar}.test.ts` (e.g., `operational-excellence.test.ts`)
   - Create helper factories for signal data shapes
   - Use `describe()` and `it()` with `vitest`
   - Test boundary cases: empty data, null fields, all-pass, all-fail, partial
   - Test outcome reasons and evidence names
   - Run: `npm run test`

**6. Update coverage ledger**
   - Run: `npm run check:coverage -- --write`
   - This verifies the control appears in the catalogue and a resolver exists for it
   - Commits coverage tracking if the control is correctly configured

**7. Verify resources and scopes**
   - If you added a REST collector: `npm run check:read-only` (verifies scopes match)
   - If you added a SQL statement: `npm run check:resources` (verifies tables are accessible)
   - If you added a new REST scope: Document grantability in `/app/app.yaml` and measure via `scripts/measure-scope-registry.mjs`

**8. Update guidance (optional)**
   - Add guidance text to `/app/config/guidance/{pillar}/` if the control needs contextualized help
   - Tests in `/app/scripts/check-guidance.mjs` verify format

**Example Control Added: SCP-01-99 (fictional)**

1. Add to `security-compliance-and-privacy.yaml`:
```yaml
- id: SCP-01-99
  title: Unused PAT tokens are regularly rotated
  provenance: extension
  measurability: rest-api
  collector: rest:workspace:token.list
  severity: high
  evaluator_status: implemented
  rationale: >-
    Unused tokens accumulate and become security debt. The platform does not record
    when a token was last used, so this control infers stagnation from age alongside
    the token inventory control (SCP-01-03) which reads their expiry.
  criteria: >-
    PAT tokens without activity recorded in the audit log within the lookback window
    and created more than 180 days ago are flagged. Read the audit log to identify
    these and verify them against business processes.
  thresholds: { max_stale_days: 180 }
```

2. Reuse `rest:workspace:token.list` (already exists in `probes.ts`)

3. Write resolver in `security-settings.ts`:
```typescript
const unusedTokens = fromSignal<TokenInventory>('rest:workspace:token.list', ['SCP-01-99'], (inventory, context) => {
  const now = Date.now();
  const maxStaleDays = (context.spec.thresholds?.max_stale_days as number) ?? 180;
  const staleThreshold = now - (maxStaleDays * 86_400_000);

  const stale = inventory.tokens.filter((token) => {
    const createdTime = token.createdAt?.getTime() ?? 0;
    return createdTime < staleThreshold;
  });

  if (stale.length === 0) {
    return { outcome: 'pass', evidence: [evidenceFrom(context, '...', 'No stale tokens found', '...')] };
  }

  return {
    outcome: 'fail',
    evidence: [
      evidenceFrom(context, '...', `${stale.length} tokens are stale`, '...'),
      ...offenders(context, '...', 'Created long ago', stale, (token) => ({...})),
    ],
  };
});
```

4. Export in `SECURITY_SETTINGS_RESOLVERS`

5. Register in `index.ts`

6. Test with `vitest`

7. Run `npm run check:coverage -- --write`

---

## Quick Reference: File Paths

| Task | Files |
|------|-------|
| Define control | `/app/config/controls/{pillar}.yaml` |
| Validate schema | `/app/config/controls/catalogue.schema.json` |
| SQL signal | `/app/config/statements/{signal_name}.sql` |
| REST collector | `/app/server/collect/rest/probes.ts` |
| Declared scopes | `/app/app.yaml` lines 84–126 |
| Resolver | `/app/server/resolve/resolvers/{pillar}.ts` |
| Register resolver | `/app/server/resolve/resolvers/index.ts` |
| Database schema | `/app/server/store/postgres.ts` lines 209–400 |
| Import evidence | `/app/server/import/envelope.ts` (validation) + `/app/server/import/signals.ts` (reviving) |
| Confidence model | `/app/server/resolve/confidence.ts` |
| Tests | `/app/server/resolve/resolvers/{pillar}.test.ts` |
| Coverage ledger | `npm run check:coverage -- --write` |
