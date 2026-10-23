// CDP driver: launch a Chromium-family browser, load one URL, collect console +
// runtime evidence, evaluate a report expression, print one JSON blob to stdout.
//
// Zero dependencies: uses Node's global fetch + global WebSocket (Node >= 22).
//
// Why it is written this way (measured on Vivaldi 8.1 / Chromium 150):
//   * Connecting to a page WebSocket taken from /json/new and issuing
//     Runtime.enable silently never answers.
//   * `Target.createTarget` returns a target the browser re-homes into the
//     Vivaldi tab UI; commands sent to that id are dropped too.
//   * What does answer: attach (flatten) on the *browser* WebSocket, list
//     targets, pick the page target Vivaldi itself created for the URL.
//
// Usage:
//   node cdp_driver.mjs --chrome=<exe> --url=<url> --wait-ms=8000 \
//        --report-expr="window.HARNESS.getReport()" [--headless] [--port=9345]
//        [--user-data-dir=<dir>] [--window-size=1200,800] [--exec-expr=...]
//
// Exit codes: 0 = driver ran and produced a report, 2 = internal failure
// (browser never came up / no target / report evaluation threw).

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function arg(name, dflt = undefined) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  return process.argv.includes(`--${name}`) ? true : dflt;
}

const CHROME = arg('chrome');
const URL_ = arg('url');
const WAIT_MS = Number(arg('wait-ms', 8000));
const PORT = Number(arg('port', 9345));
const REPORT_EXPR = arg('report-expr', 'undefined');
const HEADLESS = !!arg('headless', false);
const WINDOW_SIZE = arg('window-size', '1280,800');
const EXEC_EXPR = arg('exec-expr', null);
const EXEC_WAIT_MS = Number(arg('exec-wait-ms', 2000));

if (!CHROME || !URL_) {
  console.error('need --chrome= and --url=');
  process.exit(2);
}

const userDataDir = arg('user-data-dir') || mkdtempSync(join(tmpdir(), 'cdp-profile-'));
const fresh = !arg('user-data-dir');

const flags = [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userDataDir}`,
  '--remote-allow-origins=*',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  `--window-size=${WINDOW_SIZE}`,
  '--autoplay-policy=no-user-gesture-required',
  '--enable-unsafe-swiftshader',
];
if (HEADLESS) flags.push('--headless=new', '--use-angle=swiftshader');
flags.push('about:blank');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(CHROME, flags, { stdio: ['ignore', 'pipe', 'pipe'] });
let browserStderr = '';
child.stderr.on('data', (d) => {
  browserStderr += d.toString();
  if (browserStderr.length > 20000) browserStderr = browserStderr.slice(-20000);
});
child.on('error', (e) => {
  console.error('spawn failed:', e.message);
  process.exit(2);
});

async function waitVersion() {
  for (let i = 0; i < 150; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  return null;
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      for (const l of this.listeners) l(msg);
    });
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new Cdp(ws)));
      ws.addEventListener('error', () => reject(new Error(`ws error: ${url}`)));
    });
  }

  on(fn) {
    this.listeners.push(fn);
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = 30000) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, timeoutMs);
    });
  }
}

// Attach and prove the session answers. Vivaldi re-homes a target created via
// CDP; attaching in that window yields a session whose commands are silently
// dropped, so the ping (and a fresh attach) is what makes this reliable.
async function attachReady(cdp, attempts = 20) {
  let lastErr = null;
  // Let Vivaldi finish booting its own tab: a page target that exists but has
  // no live renderer yet accepts the attach and then ignores every command.
  await sleep(2500);
  for (let i = 0; i < attempts; i += 1) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const pages = targetInfos.filter((t) => t.type === 'page');
    // Prefer a tab that has actually navigated somewhere (has a URL).
    pages.sort((a, b) => Number(!!b.url) - Number(!!a.url));
    for (const cand of pages) {
      try {
        const { sessionId } = await cdp.send('Target.attachToTarget', {
          targetId: cand.targetId,
          flatten: true,
        });
        const ping = await cdp.send(
          'Runtime.evaluate',
          { expression: '1+1', returnByValue: true },
          sessionId,
          4000,
        );
        if (ping.result?.value === 2) return { target: cand, sessionId, err: null };
        lastErr = new Error(`ping returned ${JSON.stringify(ping)}`);
      } catch (e) {
        lastErr = e;
      }
    }
    await sleep(700);
  }
  return { target: null, sessionId: null, err: lastErr || new Error('no page target') };
}

async function main() {
  const version = await waitVersion();
  if (!version) {
    console.error('browser never exposed /json/version');
    console.error(browserStderr.slice(-4000));
    process.exit(2);
  }

  // Attach to the tab the browser opened for our URL. The URL may be
  // normalised (trailing slash, percent-encoding), so match origin+path.
  const cdp = await Cdp.connect(version.webSocketDebuggerUrl);

  // Navigation strategy, measured: neither a page WebSocket from /json/new nor
  // Target.createTarget gives a session that answers, and a CDP-created tab can
  // sit at url="" forever. What does work is taking over the tab Vivaldi opened
  // itself (its welcome page) and driving it with Page.navigate.
  const { target, sessionId, err } = await attachReady(cdp);
  if (!target || !sessionId) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    console.error(
      'could not get a live CDP session; err:',
      err?.message,
      'saw:',
      JSON.stringify(targetInfos.filter((t) => t.type === 'page').map((t) => t.url)),
    );
    process.exit(2);
  }

  let navError = null;
  try {
    const nav = await cdp.send('Page.navigate', { url: URL_ }, sessionId, 20000);
    navError = nav?.errorText || null;
  } catch (e) {
    navError = e.message;
  }
  if (navError) {
    console.error('Page.navigate failed:', navError, URL_);
    process.exit(2);
  }

  const consoleMsgs = [];
  const exceptions = [];
  const logEntries = [];
  const failedRequests = [];

  cdp.on((msg) => {
    if (msg.method === 'Runtime.consoleAPICalled') {
      const { type, args = [] } = msg.params;
      consoleMsgs.push({
        type,
        text: args
          .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type))
          .join(' '),
      });
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      exceptions.push({
        text: d.text,
        desc: d.exception?.description || '',
        url: d.url,
        line: d.lineNumber,
      });
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      logEntries.push({ level: e.level, source: e.source, text: e.text, url: e.url });
    } else if (msg.method === 'Network.loadingFailed') {
      failedRequests.push({
        requestId: msg.params.requestId,
        errorText: msg.params.errorText,
        blockedReason: msg.params.blockedReason,
      });
    }
  });

  // Best-effort: a domain that will not enable must not sink the run — the
  // harness keeps its own in-page log buffer (see harness.html) for evidence.
  for (const domain of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) {
    try {
      await cdp.send(domain, {}, sessionId);
    } catch (e) {
      logEntries.push({ level: 'warn', source: 'driver', text: `${domain} failed: ${e.message}` });
    }
  }

  // Target was created with the URL already; wait for the run window.
  await sleep(WAIT_MS);

  if (EXEC_EXPR) {
    try {
      await cdp.send(
        'Runtime.evaluate',
        { expression: EXEC_EXPR, awaitPromise: true, returnByValue: true },
        sessionId,
      );
    } catch (e) {
      exceptions.push({ text: `exec-expr failed: ${e.message}`, desc: '' });
    }
    await sleep(EXEC_WAIT_MS);
  }

  let report;
  try {
    const r = await cdp.send(
      'Runtime.evaluate',
      { expression: REPORT_EXPR, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (r.exceptionDetails) {
      exceptions.push({
        text: `report-expr threw: ${r.exceptionDetails.text}`,
        desc: r.exceptionDetails.exception?.description || '',
      });
    }
    report = r.result?.value;
  } catch (e) {
    exceptions.push({ text: `report-expr failed: ${e.message}`, desc: '' });
  }

  const out = {
    ok: report !== undefined,
    browser: version.Browser,
    protocolVersion: version['Protocol-Version'],
    url: URL_,
    headless: HEADLESS,
    console: consoleMsgs,
    exceptions,
    logEntries,
    failedRequestCount: failedRequests.length,
    report,
    browserStderrTail: browserStderr.slice(-2000),
  };
  process.stdout.write(JSON.stringify(out, null, 2));
}

main()
  .catch((e) => {
    console.error('driver error:', e?.stack || e);
    process.exitCode = 2;
  })
  .finally(async () => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    await sleep(300);
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    if (fresh) {
      try {
        rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
