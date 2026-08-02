#!/usr/bin/env node
/**
 * Live end-to-end test of the Larapaper Studio MCP server over real stdio.
 * Drives the full agent workflow: initialize → create project → add GVB source
 * → LIVE fetch → build widgets + condition → validate → build recipe → render.
 *
 * Usage: node mcp/e2e-live.mjs [--save <path.lpsproj.json>]
 * Exit 0 = all steps passed.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const saveIdx = process.argv.indexOf('--save');
const savePath = saveIdx !== -1 ? process.argv[saveIdx + 1] : null;

/* ---------------- minimal JSON-RPC stdio client ---------------- */
const child = spawn(process.execPath, [path.join(here, 'server.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const pending = new Map();
let nextId = 1;
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    }
  }
});
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
function callTool(name, args) {
  return rpc('tools/call', { name, arguments: args }).then((r) => {
    const text = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (r.isError) throw new Error(name + ' → ' + text);
    try { return JSON.parse(text); } catch (e) { return text; }
  });
}

/* ---------------- test driver ---------------- */
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  — ' + String(detail).slice(0, 140) : ''));
};

async function main() {
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'e2e-live', version: '1.0.0' }
  });
  check('initialize handshake', init && init.serverInfo && init.serverInfo.name, init && init.serverInfo && init.serverInfo.name);
  notify('notifications/initialized');

  const tools = await rpc('tools/list');
  check('tools/list exposes 17 tools', tools.tools.length === 17, tools.tools.length + ' tools');

  const proj = await callTool('lp_create_project', { name: 'GVB Bus 34 Monitor', device: 'Kindle PW7 (portrait)' });
  check('create project (Kindle PW7 portrait)', !!proj, JSON.stringify(proj).slice(0, 100));

  const src = await callTool('lp_add_source', { preset: 'gvb' });
  const srcId = src.id || (src.source && src.source.id);
  check('add GVB source', !!srcId, 'id=' + srcId);

  const fetched = await callTool('lp_fetch_source', { id: srcId, useAsSampleData: true });
  check('LIVE fetch GVB disruptions', fetched.status === 200 || fetched.ok === true, JSON.stringify(fetched).slice(0, 120));

  const doc = await callTool('lp_get_document');
  const disruptions = doc.staticDataKeys ? null : null; /* shape-agnostic: check below via render */
  check('sample data merged (disruptions key)', JSON.stringify(doc).includes('disruptions'), 'doc keys: ' + Object.keys(doc).join(','));

  const bar = await callTool('lp_add_widget', { type: 'title_bar', props: { title: 'GVB Bus 34' } });
  const okText = await callTool('lp_add_widget', { type: 'text', area: { x: 0, y: 1, w: 2, h: 1 }, props: { content: 'OPERATING NORMALLY' } });
  const list = await callTool('lp_add_widget', { type: 'list', area: { x: 0, y: 2, w: 2, h: 1 }, props: { source: 'data.disruptions' } });
  check('add 3 widgets (title_bar, text, list)', !!(bar && okText && list), 'ids: ' + [bar, okText, list].map((w) => w && (w.id || (w.node && w.node.id))).join(','));

  const textId = okText.id || (okText.node && okText.node.id);
  const cond = await callTool('lp_set_condition', {
    id: textId,
    condition: { enabled: true, op: 'not_mentions', path: 'data.disruptions', fields: ['title', 'description'], value: '34' }
  });
  check('set not_mentions "34" condition', !!cond, JSON.stringify(cond).slice(0, 120));

  const val = await callTool('lp_validate');
  const errors = val.errors || val;
  check('validate → no errors', Array.isArray(errors) && errors.length === 0, JSON.stringify(val).slice(0, 120));

  const built = await callTool('lp_build_recipe', {});
  const liquid = (built.files && built.files['full.liquid']) || '';
  check('build recipe → condition guard in full.liquid',
    liquid.includes("unless _lp_hay contains ' 34 '"), liquid.split('\n').length + ' lines');

  const rendered = await callTool('lp_render_layout', { layout: 'full' });
  const textOut = rendered.text || JSON.stringify(rendered);
  check('render layout → produces text output', typeof textOut === 'string' && textOut.length > 0, textOut.slice(0, 100));

  if (savePath) {
    await callTool('lp_save_project', { path: savePath });
    check('project saved', true, savePath);
  }
}

main()
  .catch((e) => check('fatal: ' + e.message, false))
  .finally(() => {
    child.kill();
    const failed = results.filter((r) => !r).length;
    console.log('\n' + (results.length - failed) + '/' + results.length + ' steps passed');
    process.exit(failed ? 1 : 0);
  });
