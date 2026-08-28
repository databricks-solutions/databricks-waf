# Contributing

Contributions are welcome. Keep changes focused, explain the customer outcome, and include tests that fail
without the change.

The [public contribution guide](https://databricks-solutions.github.io/databricks-waf/contributing/)
explains how to choose an issue type, protect customer information, work from a fork and prepare a
reviewable pull request. Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Local setup

```bash
git clone https://github.com/databricks-solutions/databricks-waf.git
cd databricks-waf/app
npm ci
npm run verify
```

Use Node.js 22 or later. `npm run verify` runs lint, type checking, unit and integration tests, catalogue
validation, security invariants and a clean rebuild comparison against the committed production bundle.

## Pull requests

1. Branch from `main`.
2. Change source and tests together.
3. Run `npm run bundle` after changing client or server source; commit the generated `app/dist/` and
   `app/client/dist/` output.
4. Run `npm run verify` from `app/`.
5. Describe the behavior change, verification performed and any deployment impact in the pull request.

Do not commit workspace profiles, access tokens, OAuth secrets, local bundle overrides, customer data or
Lakebase backups.

## Customer experience changes

Read [the customer design system](docs/design/customer-design-system.md) before changing UI structure or
language. Verify affected screens in current Chrome at representative desktop and laptop widths, in both
themes. Tablet and mobile layouts are outside the supported product scope.

Browser checks require a locally running app:

```bash
npm run dev
# in another terminal
npm run check:viewport
npm run check:a11y
npm run check:drill
```

Pass a short-lived Databricks CLI token and user identity only through environment variables when a screen
needs live workspace data. Never write them to a file or recording.

## Catalogue and SQL changes

- Every control must declare its provenance, measurability, applicability and evidence path.
- AI output may explain or prioritise; it must never determine a finding or score.
- SQL values are parameters. Validate any identifier that cannot be parameterised.
- A query over a history or timeline source must explicitly reduce to the intended grain.
- A result set must declare and enforce a safe bound.
- Update the catalogue or methodology version when a change alters what is scored.

Run the focused checks as well as the full suite:

```bash
npm run validate:catalogue
npm run check:sql-release
npm run check:guidance
```

Guidance content follows [the guidance authoring standard](docs/design/guidance-authoring.md).

## Lakebase changes

Unit tests use a strict fake, but PostgreSQL behavior must be verified against a real disposable schema.
Provide your own profile and Lakebase endpoint:

```bash
DATABRICKS_CONFIG_PROFILE=<profile> \
LAKEBASE_ENDPOINT=projects/<project>/branches/<branch>/endpoints/<endpoint> \
npm run test:live
```

The live suite creates and removes only its own test schema. Review the target before running it.

## DAB changes

Use only the supported lifecycle wrapper and an explicit profile and target:

```bash
npm run lifecycle -- validate --profile <profile> --target customer
```

Do not run a deployment merely to validate UI work. Use the DAB path when the bundle, bindings, scopes,
runtime configuration or served Databricks integration changed.
