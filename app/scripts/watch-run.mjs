// Watches a run in the deployed app from outside it, the way a browser does.
//
// Exists because the thing being checked is a trajectory, not a value: whether the count of calls
// rises often enough to read as progress, and whether the status goes back to idle at the end. A
// single curl cannot see either.
//
// Usage: node scripts/watch-run.mjs [--start] [--seconds 300]

const app = process.env.APP_URL;
const token = process.env.APP_TOKEN;
if (app == null || token == null) {
  console.error('Set APP_URL and APP_TOKEN.');
  process.exit(1);
}

const seconds = Number(process.argv[process.argv.indexOf('--seconds') + 1]) || 300;
const start = process.argv.includes('--start');

const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };

async function get(path) {
  const response = await fetch(`${app}${path}`, { headers });
  if (!response.ok) return { error: `${String(response.status)} ${response.statusText}` };
  return { data: await response.json() };
}

if (start) {
  // Not awaited: the POST is held open for the whole run, which is the shape the browser sees too.
  void fetch(`${app}/api/scan`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  }).catch(() => undefined);
  console.log('run requested');
}

const began = Date.now();
let sawRunning = false;
let last = -1;

while ((Date.now() - began) / 1000 < seconds) {
  const { data, error } = await get('/api/scan/status');
  const at = new Date().toISOString().slice(11, 19);

  if (error != null) {
    console.log(`${at} status unreadable: ${error}`);
  } else if (data.running) {
    sawRunning = true;
    // Only when it moves, so the log is the trajectory rather than one line per poll.
    if (data.callsMade !== last) {
      const elapsed = Math.round((Date.now() - new Date(data.startedAt).getTime()) / 1000);
      console.log(`${at} running ${String(elapsed)}s calls=${String(data.callsMade)} by ${data.actor}`);
      last = data.callsMade;
    }
  } else if (sawRunning) {
    console.log(`${at} idle: the run has finished`);
    const latest = await get('/api/scans/latest');
    console.log(`latest scan: ${latest.data?.id ?? latest.error} state=${latest.data?.state ?? '?'}`);
    process.exit(0);
  } else {
    console.log(`${at} idle`);
  }

  await new Promise((resolve) => setTimeout(resolve, 3000));
}

console.log(sawRunning ? 'still running when the watch ended' : 'never saw a run');
