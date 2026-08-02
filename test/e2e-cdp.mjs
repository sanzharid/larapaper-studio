#!/usr/bin/env node
/**
 * E2E smoke test for the built Larapaper Studio app.
 *
 * Launches the exe with WebView2 CDP enabled and drives it over the Chrome
 * DevTools Protocol: checks boot health, runs a live GVB fetch through the
 * Tauri backend, exercises the Sources panel flow, and performs a *trusted*
 * mouse drag from the palette onto the canvas (catches the Tauri
 * dragDropEnabled issue that synthetic JS events cannot).
 *
 * Usage:  node test/e2e-cdp.mjs [path-to-exe]
 * Exit code 0 = all checks passed, 1 = at least one failed.
 */
import { spawn } from 'node:child_process';

const EXE = process.argv[2] || 'src-tauri/target/release/larapaper-studio.exe';
const PORT = 9223;
const GVB_URL = 'https://www.gvb.nl/api/gvb-shared-services/travelinformation/api/v1/Disruption/GetDisruptions?language=en';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function report(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  — ' + detail : ''));
}

/* ---------------- CDP plumbing ---------------- */
let msgId = 0;
const pending = new Map();
let ws = null;
const pageErrors = [];

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}

async function evaluate(expr, awaitPromise) {
  const r = await send('Runtime.evaluate', {
    expression: expr, awaitPromise: !!awaitPromise, returnByValue: true
  });
  if (r.exceptionDetails) {
    throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
  }
  return r.result ? r.result.value : undefined;
}

async function waitFor(expr, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await evaluate(expr)) return true; } catch (e) { /* not ready */ }
    await sleep(250);
  }
  throw new Error('timeout waiting for ' + (label || expr));
}

/* ---------------- main ---------------- */
async function main() {
  console.log('Launching ' + EXE + ' (CDP :' + PORT + ')…');
  const child = spawn(EXE, [], {
    env: Object.assign({}, process.env, {
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + PORT
    }),
    stdio: 'ignore'
  });
  const cleanup = () => { try { child.kill(); } catch (e) {} };
  process.on('exit', cleanup);

  try {
    /* wait for the CDP endpoint */
    let targets = null;
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch('http://127.0.0.1:' + PORT + '/json/list');
        targets = await res.json();
        if (targets.some((t) => t.type === 'page')) break;
      } catch (e) { /* not up yet */ }
      await sleep(400);
    }
    const page = (targets || []).find((t) => t.type === 'page');
    if (!page) throw new Error('CDP endpoint never came up');

    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        pageErrors.push(m.params.exceptionDetails.text + ' ' +
          ((m.params.exceptionDetails.exception || {}).description || ''));
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        pageErrors.push('console.error: ' + m.params.args.map((a) => a.value || a.description || '').join(' '));
      }
    };
    await send('Runtime.enable');

    /* 1 — boot */
    await waitFor('!!window.__APP_READY', 15000, 'app boot');
    report('app boots (window.__APP_READY)', true);
    report('tauri bridge present', await evaluate('!!(window.__TAURI__ && window.__TAURI__.core && window.lp && window.lp.httpRequest)'));
    report('palette rendered (18 widgets)', (await evaluate('document.querySelectorAll(".palette-item").length')) === 18);

    /* 2 — live GVB fetch through the Rust backend */
    const gvb = await evaluate(
      'window.lp.httpRequest({ method: "GET", url: ' + JSON.stringify(GVB_URL) + ', headers: [], body: null, timeout_ms: 15000 })' +
      '.then((r) => ({ ok: r.ok, status: r.status, len: (r.body || "").length, err: r.error || null }))' +
      '.catch((e) => ({ invokeError: String(e) }))', true);
    if (gvb.invokeError) {
      report('GVB fetch via http_request', false, 'invoke failed: ' + gvb.invokeError);
    } else {
      let parsed = null;
      try { parsed = gvb.len ? 'parses' : 'empty'; } catch (e) {}
      report('GVB fetch via http_request', gvb.ok && gvb.status === 200 && gvb.len > 100,
        'status=' + gvb.status + ' body=' + gvb.len + 'B' + (gvb.err ? ' err=' + gvb.err : ''));
    }

    /* 3 — Sources panel flow: add GVB preset, fetch, use as sample data */
    await evaluate('document.querySelector(".panel-tab[data-panel=sources]").click(); 1');
    await evaluate('var s = document.getElementById("src-add"); s.value = "gvb"; s.dispatchEvent(new Event("change", { bubbles: true })); 1');
    await waitFor('!!document.querySelector(".src-item")', 5000, 'source item');
    report('add GVB source from preset', true);
    await evaluate('document.querySelector("[data-fetch]").click(); 1');
    await waitFor('!!document.querySelector(".src-badge.ok, .src-badge.err")', 20000, 'fetch badge');
    const badge = await evaluate('(document.querySelector(".src-badge") || {}).textContent || ""');
    report('source fetch succeeds', /OK/.test(badge), 'badge: ' + badge);
    const leafCount = await evaluate('document.querySelectorAll(".jt-leaf").length');
    report('JSON tree rendered', leafCount > 10, leafCount + ' leaves');
    await evaluate('var b = document.querySelector("[data-sample]"); b && b.click(); 1');
    await sleep(400);
    const replaced = await evaluate('(LPState.getDoc().staticData.disruptions || []).length');
    const leftover = await evaluate('["value","percent","items","rows"].filter(function(k){ return LPState.getDoc().staticData[k] !== undefined; }).join(",")');
    report('use as sample data replaces staticData with disruptions', replaced > 0, replaced + ' disruptions in staticData');
    report('starter sample keys are gone (replace, not merge)', leftover === '', leftover ? 'leftover: ' + leftover : 'clean');

    /* 4 — bind a leaf into a selected widget */
    await evaluate('LPState.addNode("root", null, LPWidgets.createNode("label")); 1');
    const labelId = await evaluate('var r = LPState.getRoot(); r.children[r.children.length - 1].id');
    await evaluate('LPState.select(' + JSON.stringify(labelId) + '); 1');
    await evaluate('var b = document.querySelector(".jt-bind"); b && b.click(); 1');
    await sleep(300);
    const bound = await evaluate('(LPState.findNode(' + JSON.stringify(labelId) + ') || { props: {} }).props.label || ""');
    report('bind writes {{ data.* }} into selected widget', /^\{\{ data\./.test(bound), bound);

    /* 5 — trusted-input drag & drop: palette → canvas */
    await evaluate('window.__dndFired = false; document.getElementById("palette").addEventListener("dragstart", () => { window.__dndFired = true; }, { once: true }); 1');
    const before = await evaluate('LPState.getRoot().children.length');
    const geo = await evaluate(
      'var p = document.querySelector(".palette-item").getBoundingClientRect();' +
      'var v = document.getElementById("device-view").getBoundingClientRect();' +
      '({ px: p.left + p.width / 2, py: p.top + p.height / 2, vx: v.left + v.width / 2, vy: v.top + v.height / 2 })');
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geo.px, y: geo.py, button: 'left', buttons: 1, clickCount: 1 });
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', button: 'left', buttons: 1,
        x: geo.px + (geo.vx - geo.px) * i / steps, y: geo.py + (geo.vy - geo.py) * i / steps
      });
      await sleep(40);
    }
    await sleep(300);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geo.vx, y: geo.vy, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(400);
    const dndFired = await evaluate('window.__dndFired');
    const after = await evaluate('LPState.getRoot().children.length');
    report('dragstart fires on real mouse drag', dndFired === true);
    report('drop adds widget to canvas', after === before + 1, 'children ' + before + ' → ' + after);

    /* 6 — page errors collected along the way */
    report('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  } catch (e) {
    report('fatal: ' + (e.message || e), false);
  } finally {
    cleanup();
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log('\n' + (results.length - failed) + '/' + results.length + ' checks passed');
  process.exit(failed ? 1 : 0);
}

main();
