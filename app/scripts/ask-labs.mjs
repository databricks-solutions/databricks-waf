// Runs one statement against the labs warehouse and prints the rows.
//
// For checking a statement against the real system tables before trusting what a resolver makes of
// it. The alternative is asserting on a fixture that was written from the same assumption the
// statement was, which is how a product list that does not match the billing data survives review.
//
//   DATABRICKS_HOST=... DATABRICKS_TOKEN=... WAREHOUSE=... node scripts/ask-labs.mjs "select 1"

const host = (process.env.DATABRICKS_HOST ?? '').replace(/\/$/, '');
const token = process.env.DATABRICKS_TOKEN ?? '';
const warehouse = process.env.WAREHOUSE ?? '';
const statement = process.argv[2] ?? '';

if (host === '' || token === '' || warehouse === '' || statement === '') {
  console.error('Set DATABRICKS_HOST, DATABRICKS_TOKEN and WAREHOUSE, and pass a statement.');
  process.exit(2);
}

const response = await fetch(`${host}/api/2.0/sql/statements`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    statement,
    warehouse_id: warehouse,
    wait_timeout: '50s',
    on_wait_timeout: 'CANCEL',
    format: 'JSON_ARRAY',
  }),
});

const body = await response.json();
if (!response.ok || body.status?.state !== 'SUCCEEDED') {
  console.error(JSON.stringify(body.status ?? body, null, 2));
  process.exit(1);
}

const columns = (body.manifest?.schema?.columns ?? []).map((column) => column.name);
console.log(columns.join('\t'));
for (const row of body.result?.data_array ?? []) console.log(row.map((cell) => cell ?? 'null').join('\t'));
console.log(`\n${String(body.result?.row_count ?? 0)} rows`);
