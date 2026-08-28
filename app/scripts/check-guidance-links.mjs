/*
 * Fetches every URL this repository's configuration cites and reports the ones that have moved.
 *
 * Two files, for the same reason. The answering guidance cites a page per reference, and the
 * serverless ruleset cites one per rule — and the ruleset's citations are load-bearing in a way the
 * guidance's are not. Its own header says why: "a rule with no doc_url is rejected at load: an
 * assertion about what serverless cannot do, with no source, is how a tool ends up confidently
 * repeating a limitation that was lifted a year ago." The app shows those sentences to a customer as
 * the reason a job cannot move. For three months nothing fetched them; the job that was supposed to
 * watch them watched a vendored copy of the skills that was never taken, which is
 * ADR 0087 and row 66.
 *
 * A reference is the one part of an entry a reader is invited to leave the app for, so a dead one
 * costs more than a missing one: it says the guidance was written against a product that has since
 * changed, about a control the reader is being asked to attest to. Five of these had 404'd by the
 * time the content was first reviewed, which is roughly the rate a documentation site renames things
 * and not a sign anybody was careless.
 *
 * Not in `npm run verify`. It needs the network, and a check that fails because a proxy is down
 * teaches contributors to ignore it. Run it before a content change lands, and on the schedule in
 * `.github/workflows/guidance-links.yml`, beside the docs-drift job.
 *
 * A redirect is reported rather than passed. The destination is the current name for the thing, and
 * citing the old one leaves the entry a rename behind — which is exactly the staleness this looks for.
 *
 * On a schedule this fails for two completely different reasons and they need completely different
 * responses: the documentation site renamed a page while nobody here touched anything, or somebody
 * here wrote the citation wrong. A report that cannot tell them apart is a weekly red tick that a
 * reader learns to close, so each failure carries the date its URL entered this repository — a
 * citation that has sat unchanged for months is the site moving, and one added last week is ours.
 *
 * That attribution needs real history. The workflow checks out with `fetch-depth: 0`; without it the
 * dates come back unknown and the report says so rather than guessing.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { argv } from 'node:process';
import { GUIDANCE_DIR, RULES_FILE, guidanceCitations, rulesetCitations } from './guidance-citations.mjs';
import { OURS_WITHIN_DAYS, attributeCitation } from './guidance-review.mjs';

const DIR = GUIDANCE_DIR;
const RULES = RULES_FILE;
const TIMEOUT = 20_000;

const cited = new Map();
const absolute = new Set();
for (const one of [...guidanceCitations(), ...rulesetCitations()]) {
  cited.set(one.url, [...(cited.get(one.url) ?? []), one.where]);
  if (one.absolute === true) absolute.add(one.url);
}

if (cited.size === 0) throw new Error('No references were found, so this checked nothing.');

/*
 * Both sources have to contribute, because the failure this row was written for is a file that is
 * cited-but-unwatched, and adding a second source that silently reads nothing would reproduce it
 * exactly. `cited.size === 0` above cannot see that: the guidance alone is 82 of the 89.
 */
for (const [what, from] of [
  ['the answering guidance', guidanceCitations()],
  ['the serverless ruleset', rulesetCitations()],
]) {
  if (from.length === 0) throw new Error(`No citations were found in ${what}, so this checked less than it reports.`);
}

async function status(url) {
  const stop = AbortSignal.timeout(TIMEOUT);
  try {
    // Without following, so a redirect is visible rather than silently passing as its destination.
    // HEAD first: these are large pages and the status is all that is wanted.
    const head = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: stop });
    if (head.status === 405 || head.status === 501) {
      const get = await fetch(url, { redirect: 'manual', signal: stop });
      return { code: get.status, to: get.headers.get('location') };
    }
    return { code: head.status, to: head.headers.get('location') };
  } catch (error) {
    return { code: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * What history can establish about when this URL entered the guidance.
 *
 * Three answers rather than a date, because "git could not tell me" and "git told me it is not there
 * yet" are opposite findings and only one of them says anything about whose fault the failure is.
 *
 * `git log -S` lists every commit that changed how many times the string occurs, newest first, so the
 * last line is the one that introduced it. Run only for URLs that failed, which is normally a handful:
 * doing it for all of them would be a hundred git invocations to answer a question nobody asked.
 *
 * @returns {{ known: boolean, uncommitted?: boolean, since?: string }}
 */
function citedSince(url) {
  let out;
  try {
    out = execFileSync('git', ['log', '--format=%as', `-S${url}`, '--', DIR, RULES], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // No git, or not a repository. Not a failure of the link check, but it cannot attribute either.
    return { known: false };
  }
  const dates = out.trim().split('\n').filter(Boolean);
  // Nothing in history and git answered, so the URL is in the working tree and has never been
  // committed. That is the strongest signal there is that the citation is ours, and reporting it as an
  // unknown date would throw away the one case the reader can act on immediately.
  return dates.length === 0 ? { known: true, uncommitted: true } : { known: true, since: dates.at(-1) };
}

/** Whether the citation or the world is the likelier fault, as a sentence rather than a flag. */
const blame = (url, today) => attributeCitation(citedSince(url), today);

const urls = [...cited.keys()].sort();
const dead = [];
const moved = [];
const unreachable = [];

const today = new Date();

// Ten at a time: enough to keep this under a minute, few enough not to look like a scrape.
for (let at = 0; at < urls.length; at += 10) {
  const batch = urls.slice(at, at + 10);
  const results = await Promise.all(batch.map(async (url) => [url, await status(url)]));
  for (const [url, result] of results) {
    const cites = (cited.get(url) ?? []).join(', ');
    if (result.code === 0) unreachable.push(`${url} — ${result.error ?? 'no response'} (${cites})`);
    else if (result.code >= 400) dead.push({ url, cites, line: `${String(result.code)} ${url}` });
    else if (result.code >= 300) moved.push({ url, cites, line: `${String(result.code)} ${url} -> ${result.to ?? '?'}` });
  }
}

const lines = ['# Guidance reference report', ''];

if (dead.length === 0 && moved.length === 0) {
  lines.push(
    unreachable.length === 0
      ? `All ${String(urls.length)} references resolve, none redirected.`
      : `${String(urls.length - unreachable.length)} of ${String(urls.length)} references resolve. ` +
          `${String(unreachable.length)} could not be reached, which is a network rather than a citation.`
  );
} else {
  lines.push(
    `${String(dead.length + moved.length)} of ${String(urls.length)} references no longer resolve to what the entry cites.`,
    '',
    'Each carries the date its URL entered this repository, because the two causes need different',
    'fixes: a citation unchanged for months means the documentation site renamed a page, and one added',
    `within ${String(OURS_WITHIN_DAYS)} days means the citation is probably wrong here.`
  );
}

const section = (label, entries) => {
  if (entries.length === 0) return;
  lines.push('', `## ${label}`, '');
  for (const entry of entries) {
    lines.push(`- \`${entry.line}\``, `  - ${blame(entry.url, today)}`, `  - cited by ${entry.cites}`);
    /*
     * The one thing a status code cannot tell you, said where it is actionable. Re-pointing a moved
     * citation makes this report green while leaving the rule asserting something the page it now
     * cites may no longer support — and for a blocker that assertion is the reason a customer is
     * told their job cannot move. The first run of this check found exactly that case.
     */
    if (absolute.has(entry.url)) {
      lines.push(
        '  - this citation is behind a rule that says the work cannot move, so re-read the page rather',
        '    than only re-pointing the link: a moved page is where a lifted limitation shows up first.'
      );
    }
  }
};

section('Dead', dead);
section('Moved, so the entry cites a name the product has changed', moved);

if (unreachable.length > 0) {
  lines.push('', '## Could not be reached, which may be this machine rather than the page', '');
  for (const line of unreachable) lines.push(`- ${line}`);
}

const report = lines.join('\n');
const at = argv.indexOf('--report');
if (at >= 0 && argv[at + 1]) writeFileSync(argv[at + 1], `${report}\n`);

if (dead.length > 0 || moved.length > 0) {
  console.error(report);
  console.error('');
  process.exitCode = 1;
} else {
  console.log(report);
  console.log('');
}
