// A headless browser, over the DevTools protocol, with no dependency to install.
//
// The two checks that use this — `check:viewport` and `check:drill` — assert things no static check
// can: that a page fits the window it is rendered in, and that a link a reader clicks lands on a list
// holding the number the link promised. Both are properties of the rendered page, so both need a
// renderer.
//
// Puppeteer would be the reflex. It is 60MB of dependency and a second Chrome download to send four
// protocol messages, and Node has had a global WebSocket since 22, so the protocol is spoken directly.
// The whole client is `send`, `evaluate` and `goto`.
//
// Chrome itself is found rather than bundled: whatever the machine already has, in the order a
// developer would expect. The checks are not in `npm run verify` for that reason — they need a browser
// and a server with a scan in it, which is a different kind of prerequisite from every other check.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RENDERED_SURFACE_SELECTOR } from './served-page.mjs';

/**
 * Removes what runs that did not close left behind, before starting one more.
 *
 * `close` covers the runs that finish. It does not cover the ones that matter: a check that fails and
 * exits, a script interrupted at a breakpoint, a browser killed by hand. Those are most of them, and
 * each used to leave two things behind — a profile directory and the browser still holding it.
 *
 * This swept only the directory for a while, which is the cheaper half. A stale profile costs disk; a
 * stale browser costs whatever is measured next, and this file blames orphaned browsers for two other
 * symptoms in its own comments. So the processes go too.
 *
 * An hour old, so a browser belonging to another check running right now is never touched. Silent and
 * best-effort throughout: this is tidying up, and a script's own work must not fail because of it.
 */
function sweepStaleProfiles() {
  const hourAgo = Date.now() - 60 * 60 * 1000;
  try {
    for (const entry of readdirSync(tmpdir(), { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('waf-check-')) continue;
      const path = join(tmpdir(), entry.name);
      try {
        if (statSync(path).mtimeMs >= hourAgo) continue;
        killHolders(path);
        rmSync(path, { recursive: true, force: true });
      } catch {
        // Gone already, or not ours to remove. Either way there is nothing to do about it.
      }
    }
  } catch {
    // No temporary directory to read is not this module's problem to report.
  }
}

/**
 * Kills the browsers still running on one of our throwaway profiles.
 *
 * Scoped to the profile rather than to the binary, and that is the whole design. `pkill -f 'Google
 * Chrome for Testing'` would be one line and would also kill the browser a developer has open on
 * purpose, or another repository's harness — a sweep that is a worse neighbour than the leak it cleans
 * up. A `--user-data-dir` under `waf-check-` is ours by construction and nothing else's.
 *
 * `ps -ww` because the default truncates: the path to a cached Chrome build is around 140 characters
 * before any flag, so the profile this matches on is past the cut. Measuring the leak with a truncated
 * `ps` is how the flag was first thought to be absent.
 */
function killHolders(profile) {
  let listing;
  try {
    listing = execFileSync('ps', ['-eww', '-o', 'pid=,command='], { encoding: 'utf8' });
  } catch {
    return; // No ps, or it refused. The profile removal below is still worth doing.
  }

  for (const line of listing.split('\n')) {
    if (!line.includes(`--user-data-dir=${profile}`)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone, or not ours to signal.
    }
  }
}

/** Where Chrome tends to be, most specific first. `CHROME` in the environment wins. */
function chromePath() {
  const declared = process.env.CHROME;
  if (declared != null && declared !== '') {
    if (!existsSync(declared)) throw new Error(`CHROME is set to ${declared}, which does not exist`);
    return declared;
  }

  // The installed stable browser is the release target. A cached Chrome for Testing is the fallback
  // for CI and machines without Chrome, not a reason to silently test a different patch release.
  const installed = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  for (const candidate of installed) if (existsSync(candidate)) return candidate;

  // Whatever `npx puppeteer browsers install chrome` last put down, newest first.
  const cache = join(homedir(), '.cache/puppeteer/chrome');
  if (existsSync(cache)) {
    const versions = readdirSync(cache).sort().reverse();
    for (const version of versions) {
      const candidate = join(
        cache,
        version,
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
      );
      if (existsSync(candidate)) return candidate;
      const linux = join(cache, version, 'chrome-linux64/chrome');
      if (existsSync(linux)) return linux;
    }
  }

  throw new Error(
    'No Chrome found. Install one, or set CHROME to its binary:\n' +
      '  npx puppeteer browsers install chrome\n' +
      '  CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run check:viewport'
  );
}

/**
 * A page to drive, and the means to close it.
 *
 * The debugging port is chosen by Chrome rather than by us, and read back out of the profile it
 * writes it to. A fixed port looks simpler and cost half a night: a run that is interrupted leaves
 * its Chrome behind, the next run's Chrome fails to bind the port and exits, and the client attaches
 * to the abandoned browser instead — which still answers, still renders, and still has the previous
 * session's localStorage in it. The symptom was an accessibility sweep reporting the dark theme's
 * contrast under the light theme's name, because the stale profile had a theme preference stored in
 * it. Ten of those browsers were found running. With port 0 there is nothing to collide over.
 *
 * @param {{ width?: number, height?: number }} options
 */
export async function open({ width = 1512, height = 845 } = {}) {
  sweepStaleProfiles();
  const profile = mkdtempSync(join(tmpdir(), 'waf-check-'));
  const chrome = spawn(chromePath(), [
    '--headless=new',
    '--remote-debugging-port=0',
    // A throwaway profile, so a developer's own Chrome session is neither read nor disturbed.
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    `--window-size=${String(width)},${String(height)}`,
    'about:blank',
  ]);
  // Chrome writes a good deal to stderr that is not an error. Read and discard it, or the pipe fills
  // and the process stalls.
  chrome.stderr.resume();
  chrome.stdout.resume();

  /*
   * A browser spawned but never handed over is this function's to kill.
   *
   * Everything between the spawn above and the return below can throw — the port file, the page target,
   * `Page.enable`, `requirePainting`, `forwardIdentity`, the first resize — and until that return,
   * `close` is the only thing that kills Chrome and no caller holds it yet. So each of those throws left
   * a headless browser running for as long as the machine stayed up. Measured three times before this
   * was added, one browser per throw, and the one that was watched was still there 70 seconds later.
   *
   * `requirePainting` is the throw to expect, because it has fired twice for reasons nobody has
   * established and its own advice is to try again in a fresh shell — advice that cost a browser every
   * time it was taken.
   */
  /*
   * The browser is disposed of when this process ends, however it ends.
   *
   * Three of the four scripts here close their page in a `finally` and one did not, so the one that
   * threw twice on a bad afternoon leaked twice. Fixing that script would have fixed that script. This
   * is registered here instead, because the leak is a property of spawning a browser and not of any
   * caller's diligence, and because there are two ways out that no `finally` covers: an uncaught
   * exception, which is how a failing check exits, and Ctrl-C, which is what a developer does to a sweep
   * that is taking six minutes.
   *
   * `exit` fires for the first and for a normal return. The signals are re-raised rather than swallowed
   * so the shell still sees a script that was interrupted.
   */
  let socket;
  const dispose = () => close(chrome, profile, socket);
  const onExit = () => dispose();
  const onSignal = (signal) => () => {
    dispose();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  const onInterrupt = onSignal('SIGINT');
  const onTerminate = onSignal('SIGTERM');
  process.once('exit', onExit);
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  const stopWatchdog = watchdog(dispose);
  const forget = () => {
    stopWatchdog();
    process.off('exit', onExit);
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  };

  try {
    socket = new WebSocket(await endpoint(await chosenPort(profile)));
    const page = await attach(socket, width, height);
    return {
      ...page,
      close: () => {
        forget();
        dispose();
      },
    };
  } catch (error) {
    forget();
    dispose();
    throw error;
  }
}

/**
 * Applies one Chrome network event to the requests that belong to the page being measured.
 *
 * A fetch from the previous document can outlive a navigation. Measured on the local labs-backed
 * accessibility sweep on 2026-08-23: one topology request survived every route after `/investigate`,
 * then a second and third accumulated on the next two width/theme cycles. Counting those requests
 * made unrelated pages report that they never came to rest and exhausted the run's 30-minute
 * watchdog. A main-frame document request is the boundary between the pages the sweep claims to
 * measure, so requests from the preceding document leave the set at that boundary. Requests in an
 * iframe do not establish that boundary.
 *
 * @param {{ outstanding: Map<string, any>, lastAnswered: number }} state
 * @param {{ method?: string, params?: Record<string, any> }} frame
 * @param {{ mainFrameId?: string, now?: number }} [options]
 */
export function applyNetworkEvent(state, frame, { mainFrameId, now = Date.now() } = {}) {
  if (frame.method === 'Network.requestWillBeSent') {
    const params = frame.params ?? {};
    if (params.type === 'Document' && params.frameId === mainFrameId) {
      state.outstanding.clear();
      state.lastAnswered = 0;
    }
    const url = params.request?.url;
    /*
     * React's development strict-effect cycle may cancel a GET after Chrome announced it but before
     * Chrome emits a matching `loadingFailed`. The replacement request has the same URL and is the
     * only response the mounted hook can publish. Keeping the orphan beside its replacement made a
     * settled Audit trail report `/api/audit?limit=9` as outstanding for the full 25-second ceiling.
     */
    if (url != null) {
      for (const [requestId, request] of state.outstanding) {
        if (requestId !== params.requestId && request?.url === url) state.outstanding.delete(requestId);
      }
    }
    state.outstanding.set(params.requestId, { at: now, url });
  } else if (frame.method === 'Network.loadingFinished' || frame.method === 'Network.loadingFailed') {
    if (state.outstanding.delete(frame.params?.requestId)) state.lastAnswered = now;
  }
}

/**
 * Everything that can fail between a connected socket and a page worth measuring in.
 *
 * Split from `open` for one reason: `open` holds the child process and the socket, so it is the only
 * place a `catch` can dispose of both. That is also why the socket is handed in rather than made here —
 * a socket left open on the way out keeps the event loop alive, and a failure that does not exit is the
 * hang this whole file is trying not to be.
 */
async function attach(socket, width, height) {
  await new Promise((done, fail) => {
    socket.addEventListener('open', done, { once: true });
    socket.addEventListener('error', fail, { once: true });
  });

  let nextId = 0;
  const pending = new Map();

  /*
   * What the page has asked the network for and not yet been given.
   *
   * `quiesce` needs this because a stable layout is not the same fact as a finished page: measured
   * across all 27 static routes, 17 of them moved after the old rule let go and every one of those 17
   * had a request outstanding at that moment. See `restVerdict` for what is done with it.
   *
   * Counted here rather than in the page, which is the difference between watching the network and
   * watching one API for calling it. A patched `window.fetch` sees `fetch` and not `XMLHttpRequest`,
   * not an image, and not a request made before the patch was installed; the protocol sees all of them
   * and needs nothing of the app.
   *
   * Redirects reuse their request id, so a `Map` keyed on it counts a redirect chain once.
   */
  const network = { outstanding: new Map(), lastAnswered: 0 };
  let mainFrameId;

  socket.addEventListener('message', (message) => {
    const frame = JSON.parse(message.data);
    if (frame.id == null) {
      applyNetworkEvent(network, frame, { mainFrameId });
      return;
    }
    const settle = pending.get(frame.id);
    pending.delete(frame.id);
    if (frame.error != null) settle.fail(new Error(`${frame.method ?? 'command'}: ${frame.error.message}`));
    else settle.done(frame.result);
  });

  /*
   * Every command carries a deadline, because the alternative is a script that hangs rather than fails.
   *
   * A command Chrome never answers leaves its promise pending for ever: no timer fires, the socket stays
   * open and the process sits there. It happened often enough to matter — `Page.captureScreenshot`
   * against a long page, after enough runs had left orphaned browsers behind — and each time the symptom
   * was a check that had printed one line an hour ago and looked like slow progress. A failure names the
   * command and the caller decides; a hang tells nobody anything and blocks whatever is waiting on it.
   *
   * Sixty seconds is far longer than any command here legitimately takes, so a breach is a fault and
   * not a slow page.
   */
  const DEADLINE_MS = 60_000;

  /**
   * How long each command may take. A capture gets less, because it does not degrade: it answers in
   * tens of milliseconds or it does not answer at all — measured across both Chrome builds here, three
   * viewport sizes and a page with a spinner on it, never above 75ms. Ten seconds is therefore already
   * two orders of magnitude of headroom, and sixty of them turned a fifteen-page sweep whose captures
   * had stopped answering into a fifteen-minute one.
   */
  const deadlineFor = (method) => (method === 'Page.captureScreenshot' ? 10_000 : DEADLINE_MS);

  function send(method, params = {}) {
    const id = (nextId += 1);
    const deadline = deadlineFor(method);
    return new Promise((done, fail) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        fail(new Error(`${method} did not answer within ${String(deadline / 1000)}s`));
      }, deadline);
      timer.unref?.();
      pending.set(id, {
        done: (result) => {
          clearTimeout(timer);
          done(result);
        },
        fail: (error) => {
          clearTimeout(timer);
          fail(error);
        },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Runs an expression in the page and returns its value. Throws what the page threw. */
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails != null) {
      throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails));
    }
    return result.result.value;
  }

  await send('Page.enable');
  mainFrameId = (await send('Page.getFrameTree')).frameTree.frame.id;
  await send('Runtime.enable');
  await send('Network.enable');
  await requirePainting(evaluate, chromePath());
  await forwardIdentity(send);
  await seedOriented(send);
  await resize(width, height);

  async function resize(nextWidth, nextHeight) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: nextWidth,
      height: nextHeight,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  /**
   * Navigates and waits for the assessment to be on screen and to have stopped moving.
   *
   * Waiting for load is not enough: every page here fetches its scan after mounting, so load fires
   * against a shell with nothing in it and a measurement taken then measures the shell.
   *
   * Waiting for the first panel is not enough either, and that took a while to find. The history page
   * mounts its durability notice and a loading strip immediately, so a panel exists within a frame, while
   * the schedule it is reading takes the Jobs API 1.5 to 2.5s to answer. Measured at 400ms the page's
   * panel was the 88px skeleton rather than the 224px panel, so the runs table under it appeared to have
   * 218px more room than it ends up with — which is the difference between a fit that passes and a table
   * that scrolls. Every number a caller takes from a page in that state is a number about a page no
   * reader sees.
   *
   * So the arrival waits for a panel and then for `quiesce`, and returns what `quiesce` concluded — a
   * caller that measures a page is entitled to know whether the page was finished.
   */
  async function goto(url, { ceiling = REST_CEILING_MS } = {}) {
    await send('Page.navigate', { url });
    await evaluate(`new Promise((done) => {
      const ready = () => document.querySelector(${JSON.stringify(RENDERED_SURFACE_SELECTOR + ', .wa-empty')}) != null;
      if (ready()) return done(true);
      const started = Date.now();
      const timer = setInterval(() => {
        if (ready() || Date.now() - started > 10000) { clearInterval(timer); done(true); }
      }, 60);
    })`);
    const verdict = await quiesce({ ceiling });
    // And a beat beyond that for fonts, responsive composition and deep-link reveal effects.
    await settle(400);
    return verdict;
  }

  /**
   * Waits until the page has stopped moving, for a caller that has just changed it.
   *
   * Shared with `goto` because it is the same question after a navigation and after a click, and
   * separate from either because it is what a caller needs before taking any measurement at all.
   *
   * What it watches is the customer document: canvas size, surface and record counts, tables and open
   * disclosures. The canvas alone is not enough because fetched data can replace records without
   * changing the outer height.
   *
   * Measured on the ten disclosure openings the sweep drives across both windows — Chrome for Testing
   * 150.0.7871.24, one scan in the store, the shape below sampled every 8ms for three seconds after the
   * click — only the two on `/checks` move the shape at all. Those settle at 10ms and at 21ms, the
   * second in two steps of 11ms then 21ms because the list renders at a row count it then corrects, and
   * neither moves again inside three seconds. Two agreeing samples 150ms apart clears that by a factor
   * of seven and costs the eight that never move 300ms each.
   *
   * The two steps are the reason this watches rather than waits. The number is not a constant: it is
   * however long a re-render takes on whatever the page is holding.
   *
   * A fixed wait has to be picked against the slowest page anybody has met and is silently wrong on the
   * next one. Earlier drivers used fixed waits that happened to be long enough on one estate; nothing
   * about those numbers would have said when they stopped being enough.
   *
   * A stable shape was the whole rule for months and it is not enough either, which is `97`. Three
   * hundred milliseconds of stillness is what it asked for, and the app's pages have a second query
   * landing one to two seconds later: measured across all 27 static routes, 17 moved after this returned.
   * So the shape is now half of the question and `restVerdict` is the rest of it — nothing outstanding
   * on the network, and a beat since the last answer arrived for the render it causes.
   *
   * The verdict is returned rather than swallowed. This used to answer `true` whether the page settled
   * or the ceiling expired, so a caller could not tell a measured page from a moving one; a sweep that
   * reports a page it never saw at rest is the defect `97` is about, one level up.
   */
  async function quiesce({ ceiling = REST_CEILING_MS } = {}) {
    const started = Date.now();
    const readings = [];

    for (;;) {
      const page = await evaluate(SHAPE);
      if (page == null) return { settled: true, waited: Date.now() - started, reason: 'no canvas to watch' };

      readings.push({
        at: Date.now() - started,
        shape: page.shape,
        working: network.outstanding.size,
        sinceAnswer:
          network.lastAnswered === 0 ? Number.POSITIVE_INFINITY : Date.now() - network.lastAnswered,
      });

      const verdict = restVerdict(readings, { ceiling });
      if (verdict != null) {
        if (!verdict.settled && network.outstanding.size > 0) {
          const urls = [...new Set([...network.outstanding.values()].map((request) => request.url).filter(Boolean))];
          if (urls.length > 0) return { ...verdict, reason: `${verdict.reason}: ${urls.join(', ')}` };
        }
        return verdict;
      }
      await settle(SAMPLE_MS);
    }
  }

  /*
   * The theme under test, stated two ways because the app decides it two ways.
   *
   * The emulated media query covers a reader who follows their system, and the stored preference
   * covers the case where anything has ever written one — which is what made a sweep report the dark
   * theme's contrast under the light theme's name. Seeding the key the app reads makes the theme a
   * fact of the run rather than a property of the profile. The script runs before the page's own
   * boot script, which is the only moment it can be set from.
   */
  let seeded = null;
  async function prefer(scheme) {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    if (seeded != null) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: seeded });
    const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('wa-theme', '${scheme}'); } catch (error) { /* denied */ }`,
    });
    seeded = identifier;
  }

  /*
   * A picture of the viewport, or of the region asked for.
   *
   * Plain, and the plainness is the point. This carried `captureBeyondViewport: true`, and with it
   * three paragraphs concluding that a viewport capture "never answers on a page that is animating":
   * a spinner in the header wedging the compositor, the surface size deciding whether a frame ever
   * arrived, and this setting as the way around it.
   *
   * Captures do stop answering, and it is real and unexplained. What is known, from an evening of
   * measuring it against the deployed app:
   *
   *   - It is all or nothing within a run. Fifteen pages driven, and either every capture answers in
   *     30ms to 75ms or every one of them times out. Never a mixture.
   *   - The three variants are indistinguishable. On one page in one browser: beyond=true 52ms,
   *     beyond=false 38ms, an explicit viewport clip 31ms, at both 1200x700 and 1512x945, with a
   *     spinner on screen. Sweeps have failed entirely with the flag on and passed entirely with it on.
   *   - It is not the browser build, the animation, `--disable-gpu`, or browsers left running by an
   *     earlier run. Each of those was measured and cleared: two Chrome builds capture a page of
   *     spinners at every size, and a sweep fails with none of ours alive and none of theirs.
   *   - Waiting does not clear it: five, twenty and sixty seconds of quiet, then the same timeout.
   *
   * A later change deleted the third of those and put the browser build back as the cause, on the
   * strength of two builds reading zero animation frames. That reading did not survive being taken
   * again with the binary alternated instead of held to the end of the run — all three builds paint at
   * 60fps — so the line stands as it was measured, and the deletion is undone. `requirePainting` is
   * still there, as a check that this browser is live rather than as an accusation against a build.
   *
   * So what this setting does is nothing, for the problem it was added for.
   *
   * So the flag goes, because it was buying nothing and costing every screenshot its bounds: beyond
   * the viewport means the page's scroll height, so a picture meant to be a window was the whole
   * document instead. A capture that does not answer is left to fail, which every caller here already
   * handles — a lost picture is a diagnostic, and stepping over it is what keeps a sweep's fifteen
   * verdicts from being lost to one missing image of a page that passed.
   */
  async function screenshot(clip) {
    const shot = await send('Page.captureScreenshot', { format: 'png', ...(clip != null && { clip }) });
    return Buffer.from(shot.data, 'base64');
  }

  // No `close` here: `open` adds it, because `open` is what registered the disposal this must undo.
  return { send, evaluate, goto, quiesce, resize, prefer, screenshot };
}

/*
 * Closing takes the throwaway profile with it, which it did not before.
 *
 * Each browser gets a fresh profile directory so a developer's own Chrome session is untouched, and
 * every one of them was left behind — a night of driving the app left 261 of them holding a Chrome
 * profile each.
 *
 * Nothing here may throw. Chrome is still shutting down as this runs, so a file it writes between the
 * directory being read and being unlinked raises `ENOTEMPTY` — which `force` does not cover, since
 * force is about things that are already absent. The first version of this cleanup threw exactly that
 * and took down a script that had already finished its work and printed its result. Retries handle the
 * ordinary race and the catch handles the rest; whatever survives is swept by the next run.
 *
 * The socket is optional because `open` calls this on the path where there is not one yet: a browser
 * that never reached a page target still has to be killed.
 */
function close(chrome, profile, socket) {
  socket?.close();
  chrome.kill();
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // Left for sweepStaleProfiles. A browser that has answered every question is not a failure.
  }
}

/**
 * Refuses to measure in a browser that does not paint. Responsive composition, font settlement,
 * screenshot evidence and reveal effects all require frames; a browser that produced none would give
 * a clean, repeatable number about a page no customer can use.
 *
 * No browser is known to fail this, and an earlier version of this comment named two that did. That
 * was wrong and is retracted. It read: the two Chrome for Testing builds in the puppeteer cache on
 * this machine produce zero frames while Google Chrome 151 produces 61. Re-measured with the binary
 * alternated rather than taken in sequence — three rounds, `about:blank`, the flags `open` passes —
 * 149.0.7827.22, 150.0.7871.24 and Google Chrome 151.0.7922.109 all produce 59 to 61 frames per second
 * and all deliver a `ResizeObserver` callback on a height change. The reading that named the build was
 * taken with every stable-Chrome run before every Chrome-for-Testing run, so the build was confounded
 * with the time and with which throwaway driver took the reading, and the confounded term was reported
 * as the cause. What produced the zero readings is not established.
 *
 * So this guard is kept on its own merit and not on a browser it is known to catch: everything the
 * sweep asserts is a question about a laid-out box, `fit.ts` re-measures from a frame, and two frames
 * on `about:blank` is a cheap way to find out that the thing about to be measured is live. If it
 * fires, the honest first move is to distrust this check, not the reader's browser.
 *
 * It has fired twice, and what is recorded here is the observation and not a cause. On 2026-08-13 a
 * full `check:a11y` sweep completed on 150.0.7871.24, and every run in that shell afterwards — four of
 * them, two of them after killing every `Google Chrome for Testing` process — reported zero frames from
 * the same binary, while `/Applications/Google Chrome.app` in the same shell reported enough and swept
 * `/review` cleanly. So it is repeatable within a session and it is not the build alone: the same
 * binary produced 60fps earlier in that session. That is as far as it was taken, deliberately, because
 * the alternating re-measurement above is what it would take to say more and the retraction above is
 * what happens when a confounded reading is written down as a finding. Do not infer from this that the
 * cache's build is at fault; the one thing established is that a passing run and a failing run of the
 * same binary sat minutes apart.
 *
 * On 2026-08-14, during `59a`, it went the same way twice more in one shell: a clean 148-render
 * `check:viewport` on 150.0.7871.24, then zero frames on the next three invocations across two
 * different checks, then a clean sweep from `/Applications/Google Chrome.app` in that same shell — and
 * the second occurrence began the same way, on the run straight after a full sweep had passed. Two
 * sightings is not a pattern, but "the run after a completed sweep" is the only thing they share and it
 * is the thing to watch on the third.
 *
 * `94` found one thing that made both of those worse and is now fixed: this throw leaked the browser it
 * fired in, so every retry in that shell added an orphan and every reading after it was taken on a
 * busier machine. That is not offered as the cause — the zero readings above were seen straight after a
 * clean sweep, and the run that first found them killed every Chrome for Testing on the machine and got
 * zero frames anyway. It does mean the sequences recorded above were measured on a machine this file was
 * degrading as it went, so their ordering is worth less than it looks.
 *
 * Two frames within two seconds, before any navigation, because a browser that cannot manage that
 * cannot be measured against at any speed. It does not check the frame *rate*, which is a different
 * question and not one any check here asks.
 */
async function requirePainting(evaluate, binary) {
  const frames = await evaluate(`new Promise((done) => {
    let seen = 0;
    const tick = () => { seen += 1; if (seen < 2) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    setTimeout(() => done(seen), 2000);
  })`);

  if (frames >= 2) return;

  throw new Error(
    `${binary}\nproduced ${String(frames)} animation frames in two seconds on about:blank. Responsive ` +
      'composition, fonts and reveal effects need frames, so a layout measured here would be frozen ' +
      'rather than representative.\n\nWhy that happens is not known. It has been ' +
      'seen twice, both times repeatably within one shell and both times on the run after a sweep that ' +
      'had just passed on the same binary. So a fresh shell is the cheapest thing to try, and it no ' +
      'longer costs a browser to try it: this throw used to leave the one it was spawned in running.\n\n' +
      'Treat it as a fault in this check until you have ruled that out, and if you find the cause write ' +
      'it beside requirePainting.\n\nA second browser is the quickest way to tell the two apart:\n' +
      '  CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run check:viewport'
  );
}

/**
 * The identity the platform would forward, when the shell has one to give.
 *
 * Databricks Apps put the reader's token and address in front of the app as headers, and the routes
 * that write — or that read one author's own work — are gated on them. A browser check without them
 * measures the page's refusal instead of the page: the setup wizard renders "the setup could not be
 * opened", which fits any window and passes every contrast rule, so the sweep would report a page it
 * never saw. Absent leaves the browser as it was, because most routes here need nothing.
 *
 *   TOKEN=$(databricks auth token -p labs | jq -r .access_token) \
 *   EMAIL=$(databricks current-user me -p labs | jq -r .userName) npm run check:a11y
 */
async function forwardIdentity(send) {
  const token = process.env.TOKEN;
  const email = process.env.EMAIL;
  if ((token == null || token === '') && (email == null || email === '')) return;

  await send('Network.enable');
  await send('Network.setExtraHTTPHeaders', {
    headers: {
      ...(token != null && token !== '' ? { 'x-forwarded-access-token': token } : {}),
      ...(email != null && email !== '' ? { 'x-forwarded-email': email } : {}),
    },
  });
}

/**
 * The welcome, already read.
 *
 * `/` sends a reader who has not seen the welcome to `/start`, and every browser here starts on a
 * throwaway profile — so without this, the sweeps would measure the welcome under the overview's name
 * and the drill check would find none of the overview's links. Seeded rather than worked around,
 * because the alternatives are both worse: exempting `/` from the sweeps loses the most-read page in
 * the app, and having the checks click through the welcome first makes every route's measurement
 * depend on a button on another page.
 *
 * The welcome is still swept — as `/start`, which renders it whatever this key says. See
 * client/src/components/shell/oriented.ts for the key, and check-a11y.mjs for the route.
 */
function seedOriented(send) {
  return send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('wa-oriented', 'true'); } catch (error) { /* denied */ }`,
  });
}

export function settle(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Kills a run that has stopped making progress, whatever it is waiting on.
 *
 * Every wait in this file has a bound — commands have a 60s deadline, the arrival poll gives up at 10s,
 * `quiesce` at its ceiling — and a run still hung with all three in place cost a night: the dev server
 * behind it went away, a probe was left in the foreground, and it sat there for three hours. Bounding
 * each step does not bound the whole, because a step that keeps succeeding never trips any of them.
 *
 * So there is one clock over the run, and it is set to catch a hang rather than to police slowness. The
 * sweeps take about four minutes each with the rest rule in place — `check:a11y` 3.9, `check:viewport`
 * 4.4, `check:drill` under two — so half an hour is several times the slowest thing measured here and
 * still bounded. `BROWSER_DEADLINE_MS` moves it for a caller that knows its own run.
 *
 * Do not tighten it towards those four minutes. A run that is slow because a page will not settle is the
 * failure `restVerdict` reports per route, with the route named; a deadline that fires first replaces
 * twenty-seven specific answers with one unhelpful one.
 *
 * The exit is loud and non-zero: a sweep that dies at its deadline has to look like a failure, because a
 * silent one looks like slow progress, which is exactly how three hours go.
 *
 * Unreferenced, so a run that finishes early is not held open by its own watchdog.
 */
function watchdog(dispose) {
  const budget = Number(process.env.BROWSER_DEADLINE_MS ?? 30 * 60 * 1000);
  if (!Number.isFinite(budget) || budget <= 0) return () => {};

  const timer = setTimeout(() => {
    process.stderr.write(`\nbrowser: no result within ${String(Math.round(budget / 1000))}s, giving up.\n`);
    try {
      dispose();
    } finally {
      process.exit(1);
    }
  }, budget);
  timer.unref?.();
  return () => clearTimeout(timer);
}

/** How often the page is read while waiting for it to come to rest. */
const SAMPLE_MS = 150;

/**
 * How long a page may take to arrive before the wait gives up and says so.
 *
 * Six seconds while the rule was a stable shape alone, and the pages that breached it were the ones
 * whose skeleton held still. With the network in the rule the ceiling has to cover a page that is
 * genuinely still fetching, and the worst one here is `/report`: 183 requests, two per control, 15.4s
 * to drain on the dev server, which is `98`. Twenty-five seconds leaves that room to finish and still
 * fails inside a minute on a page whose spinner is never going to stop.
 */
const REST_CEILING_MS = 25_000;

/**
 * The seven exact-join topology statements run sequentially so a shared warehouse is not flooded.
 * Measured against labs on 2026-08-20, one complete response was 31.00s for 155 nodes and 303 edges.
 * Assume a cold warehouse can take up to twice that reading. One minute keeps the progressive read
 * inside the rendered-route gates without moving the default that still catches an ordinary page
 * whose request has hung.
 */
export const INVESTIGATE_REST_CEILING_MS = 60_000;

/** Routes whose first useful render waits on the measured seven-statement topology read. */
export function routeRestCeiling(path) {
  return ['/investigate', '/topology'].includes(path) ? INVESTIGATE_REST_CEILING_MS : undefined;
}

/**
 * What the page looks like right now, in one string, plus whether it says it is working.
 *
 * The shape includes the customer document, surfaced regions, record rows, table rows and disclosures.
 * Canvas height alone cannot distinguish a loading placeholder from equally tall customer content.
 *
 * There is deliberately no signal here for "the page says it is working", and the reason is measured.
 * `role="status"` was that signal, and it does not mean that: it marks a live region, so this app carries
 * it on an empty state that is filtered to nothing, on a warning that a scan is partial, and on the
 * confirmation left behind after a save. All three are steady content. With that in the rule, `/serverless`,
 * `/definitions` and `/months` never settled — 25 seconds each, in both themes, on a page that had
 * finished. `aria-busy` would be the right annotation and nothing in this app sets it.
 *
 * What the signal was covering is covered better by the network: the schedule panel's loading strip is a
 * fixed 88px, so the canvas measured the same twice while the panel it stood in for was two seconds from
 * arriving — and that panel's query was outstanding for those two seconds. An annotation every future
 * loading state has to remember is a rule that is wrong the first time one forgets; a request nobody has
 * answered yet cannot be forgotten.
 */
const SHAPE = `(() => {
  const canvas = document.querySelector('main#content');
  if (canvas == null) return null;
  return {
    shape: [
      canvas.scrollHeight,
      canvas.clientHeight,
      Math.round(document.querySelector('.wa-customer-page')?.getBoundingClientRect().height ?? 0),
      document.querySelectorAll('.wa-customer-surface').length,
      document.querySelectorAll('.wa-record-list > .wa-record-item').length,
      document.querySelectorAll('tbody > tr').length,
      document.querySelectorAll('details[open]').length,
    ].join('/'),
  };
})()`;

/**
 * Whether a page has come to rest, from everything observed of it so far.
 *
 * Returns null while the answer is "keep watching", so the caller's loop has one condition in it and
 * the decision is here. Pure, and separately exported, because it is the part of `quiesce` that can be
 * held by a test: the readings a browser produces are the hard thing to arrange and the easy thing to
 * write down.
 *
 * A page is at rest when nothing is outstanding on the network and its shape has agreed with itself
 * `agree` times over **since the last response arrived** — not merely `agree` times, one of which
 * happened to be after it. A response is followed by a render and responsive composition, so a reading
 * taken anywhere in that sequence is of a page mid-change.
 *
 * The distinction is measured. With agreement allowed to span the last answer, `check:viewport` reported
 * 17 layout failures, then 16, then 6, then none, over the same routes on the same data — a stable set of
 * failures, caught in varying part depending on where the samples landed. Requiring the agreement to sit
 * entirely after the last answer is what makes the gate say the same thing twice.
 *
 * @typedef {{ at: number, shape: string, working: number, sinceAnswer: number }} Reading
 * @typedef {{ settled: boolean, waited: number, reason: string }} Verdict
 *
 * @param {Reading[]} readings
 * @param {{ agree?: number, afterAnswer?: number, ceiling?: number }} [options]
 * @returns {Verdict | null}
 */
export function restVerdict(readings, { agree = 3, afterAnswer = SAMPLE_MS, ceiling = REST_CEILING_MS } = {}) {
  let same = 0;
  let was = null;

  for (const reading of readings) {
    const settledEnough = reading.working === 0 && reading.sinceAnswer >= afterAnswer;
    // A reading taken while a response is landing counts for nothing, however still the page looks.
    same = settledEnough && reading.shape === was ? same + 1 : settledEnough ? 1 : 0;
    was = reading.shape;

    if (same >= agree) {
      return { settled: true, waited: reading.at, reason: 'at rest' };
    }

    if (reading.at > ceiling) {
      const why =
        reading.working > 0
          ? `${String(reading.working)} request${reading.working === 1 ? '' : 's'} still outstanding`
          : 'the layout is still changing';
      return { settled: false, waited: reading.at, reason: why };
    }
  }

  return null;
}

/**
 * The port Chrome settled on, from the file it writes into its profile.
 *
 * The first line is the port and the second is the browser's own WebSocket path, which is not the one
 * we want — a page target is, and /json/list names it.
 */
async function chosenPort(profile) {
  const file = join(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (existsSync(file)) {
      const port = Number(readFileSync(file, 'utf8').split('\n')[0]);
      if (Number.isInteger(port) && port > 0) return port;
    }
    await settle(250);
  }
  throw new Error(`Chrome did not report a debugging port in ${profile} within 20 seconds`);
}

async function endpoint(port) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json();
      const page = targets.find((target) => target.type === 'page');
      if (page?.webSocketDebuggerUrl != null) return page.webSocketDebuggerUrl;
    } catch {
      /* not listening yet */
    }
    await settle(250);
  }
  throw new Error(`Chrome did not expose a page target on port ${String(port)}`);
}

/**
 * Refuses to run against a server with no scan in it.
 *
 * Every page renders an empty state without one, empty states fit any window, and the check would
 * pass by measuring nothing. This has happened: a full run reported "36 measured, 0 failing" against
 * a server restarted a minute earlier, and the numbers were all nulls.
 */
export async function requireScan(origin) {
  let response;
  try {
    response = await fetch(`${origin}/api/scans/latest`);
  } catch {
    throw new Error(`Nothing is serving ${origin}. Start it with \`npm run dev\`.`);
  }

  if (response.status === 404) {
    throw new Error(
      `${origin} has no scan in it, so every page would render an empty state and this check would ` +
        'measure nothing. Run one first — from the header in the app, or:\n' +
        '  TOKEN=$(databricks auth token -p <profile> | jq -r .access_token)\n' +
        `  curl -X POST ${origin}/api/scan -H "x-forwarded-access-token: $TOKEN" -H 'content-type: application/json' -d '{}'`
    );
  }
  if (!response.ok) throw new Error(`${origin}/api/scans/latest answered ${String(response.status)}`);
}

/**
 * Refuse a sweep that has no identity to forward, for `requireScan`'s reason.
 *
 * `forwardIdentity` above explains what the headers are for and says a sweep without them measures the
 * page's refusal. It was a comment, and a comment is not a check: `63` ran all three sweeps without
 * them and every one passed, because `/foundation` renders "Could not read how ready the serving data
 * is" in 215 characters, and that card fits any window, skips no heading level and has contrast to
 * spare. Four renders reported clean on a page nobody had seen.
 *
 * A scan does not fix it and is not what is missing. `/foundation` reads the estate per request as the
 * caller rather than from a stored run, so it needs the token whether or not a scan exists — which is
 * `63`'s answer to whether that route needs an estate behind it: it needs a credential, and the two
 * are not the same requirement.
 *
 * Held here rather than in each sweep so a new one inherits it, and asserted by browser-preconditions
 * .test.ts against the routes that read live.
 */
export function requireIdentity() {
  const token = process.env.TOKEN;
  if (token != null && token !== '') return;

  throw new Error(
    'This shell has no TOKEN, so the browser forwards no identity and the routes that read the estate ' +
      'per request would render their refusal instead of themselves. A sweep of those measures a card ' +
      'that fits every window and passes every rule, and reports it as the page.\n\n' +
      'A scan is not the missing part — those routes read live, so they need the credential either way:\n' +
      '  export TOKEN=$(databricks auth token -p labs | jq -r .access_token)\n' +
      '  export EMAIL=$(databricks current-user me -p labs | jq -r .userName)\n\n' +
      "EMAIL is what the routes that read one author's own work are gated on; TOKEN is what the live " +
      'reads use. Set both.'
  );
}
