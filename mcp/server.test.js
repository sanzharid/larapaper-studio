/**
 * Headless end-to-end tests for the Larapaper Studio MCP server.
 * No network: lp_fetch_source runs against an injected fake fetch.
 * Run from mcp/:  node --test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createSession, DEFAULT_USER_AGENT } from './project.js';
import { TOOLS, dispatch } from './server.js';

const GVB_FIXTURE = [
  {
    title: 'Bus 34 rerouted via Dam square',
    description: 'Due to roadworks bus 34 skips two stops.',
    affectedLines: [{ publicName: '34' }]
  },
  {
    title: 'Tram 5 extra service',
    description: 'Additional trams during the event.',
    affectedLines: [{ publicName: '5' }]
  }
];

const EXPECTED_TOOLS = [
  'lp_create_project', 'lp_open_project', 'lp_save_project', 'lp_get_document',
  'lp_list_widget_types', 'lp_add_widget', 'lp_update_widget', 'lp_move_widget',
  'lp_remove_widget', 'lp_set_condition', 'lp_set_sample_data', 'lp_add_source',
  'lp_fetch_source', 'lp_validate', 'lp_build_recipe', 'lp_render_layout',
  'lp_screenshot_layout', 'lp_list_layouts'
];

test('tool registry exposes all 18 documented tools with schemas', () => {
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), EXPECTED_TOOLS.slice().sort());
  for (const t of TOOLS) {
    assert.ok(t.description && t.description.length > 20, t.name + ' description');
    assert.equal(t.inputSchema.type, 'object', t.name + ' schema');
  }
});

test('end-to-end: create → widgets → move → condition → data → validate → build → render', async () => {
  const s = createSession();

  /* create project on the Kindle PW7 portrait preset */
  let r = await dispatch(s, 'lp_create_project', { name: 'GVB Disruptions', device: 'Kindle PW7 (portrait)' });
  assert.equal(r.name, 'GVB Disruptions');
  assert.equal(r.device.width, 1072);
  assert.equal(r.device.height, 1448);

  /* widgets: title_bar + value + text + list (auto-placed on the grid) */
  const bar = await dispatch(s, 'lp_add_widget', { type: 'title_bar', props: { title: 'GVB Disruptions' } });
  const val = await dispatch(s, 'lp_add_widget', {
    type: 'value',
    props: { value: 'data.disruptions[0].title', size: 'small' }
  });
  const txt = await dispatch(s, 'lp_add_widget', {
    type: 'text',
    props: { content: 'OPERATING NORMALLY' }
  });
  const lst = await dispatch(s, 'lp_add_widget', {
    type: 'list',
    props: { collection: 'disruptions' }
  });
  for (const r2 of [bar, val, txt, lst]) assert.ok(r2.id, 'widget id returned');
  assert.equal(bar.area, null, 'title_bar is hoisted, not a grid cell');
  assert.deepEqual(val.area, { x: 0, y: 0, w: 1, h: 1 });
  assert.deepEqual(txt.area, { x: 1, y: 0, w: 1, h: 1 });
  assert.equal(lst.area.x, 2);

  /* bind the list's item template to the GVB payload shape */
  const docView = await dispatch(s, 'lp_get_document', {});
  const itemTpl = docView.layouts.full.widgets.find((w) => w.id === lst.id).children[0];
  await dispatch(s, 'lp_update_widget', {
    id: itemTpl.id,
    props: { title: '{{ item.title }}', description: '{{ item.description }}' }
  });

  /* move the text onto the list's cell → collision resolves to nearest free */
  r = await dispatch(s, 'lp_move_widget', { id: txt.id, area: { x: 2, y: 0, w: 1, h: 1 } });
  assert.deepEqual(r.area, { x: 3, y: 0, w: 1, h: 1 }, 'nearest free cell after collision');

  /* GVB-shaped sample data (before the condition, so the guard picks array form) */
  r = await dispatch(s, 'lp_set_sample_data', { data: { disruptions: GVB_FIXTURE } });
  assert.deepEqual(r.staticDataKeys, ['disruptions']);

  /* not_mentions '34' condition on the OPERATING NORMALLY text */
  r = await dispatch(s, 'lp_set_condition', {
    id: txt.id,
    condition: {
      enabled: true, op: 'not_mentions', path: 'data.disruptions',
      fields: ['title', 'description'], value: '34'
    }
  });
  assert.match(r.summary, /doesn't mention "34"/);
  assert.match(r.guard.open, /^\{% capture _lp_hay %\}/);
  assert.match(r.guard.open, /\{% unless _lp_hay contains ' 34 ' %\}$/);
  assert.equal(r.guard.close, '{% endunless %}');

  /* validation: clean */
  r = await dispatch(s, 'lp_validate', {});
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.conditionErrors, []);

  /* build: settings.yml + full.liquid with the unless guard */
  r = await dispatch(s, 'lp_build_recipe', {});
  assert.ok(r.files['settings.yml'], 'settings.yml built');
  assert.ok(r.files['full.liquid'], 'full.liquid built');
  assert.match(r.files['settings.yml'], /^name: GVB Disruptions/m);
  assert.match(r.files['settings.yml'], /strategy: static/);
  assert.match(r.files['full.liquid'], /\{% unless _lp_hay contains ' 34 ' %\}/);
  assert.match(r.files['full.liquid'], /\{% endunless %\}/);
  assert.match(r.files['full.liquid'], /\{% for item in disruptions %\}/, 'list loop over sample key');

  /* render: bound sample value visible; conditioned text hidden (34 IS mentioned) */
  r = await dispatch(s, 'lp_render_layout', { layout: 'full' });
  assert.match(r.text, /Bus 34 rerouted via Dam square/, 'bound value rendered');
  assert.match(r.text, /Tram 5 extra service/, 'list item rendered');
  assert.doesNotMatch(r.text, /OPERATING NORMALLY/, 'not_mentions hides the widget');
  assert.match(r.html, /class="title_bar"/);

  /* layouts overview */
  r = await dispatch(s, 'lp_list_layouts', {});
  const full = r.find((l) => l.layout === 'full');
  assert.equal(full.enabled, true);
  assert.deepEqual(full.grid, { cols: 4, rows: 3 });
  assert.equal(full.widgetCount, 4);
  assert.equal(r.find((l) => l.layout === 'quadrant').enabled, false);
});

test('lp_fetch_source with injected fetch: wraps array under dataKey, sends browser UA', async () => {
  const seen = { url: null, headers: null };
  const fakeFetch = async (url, opts) => {
    seen.url = url;
    seen.headers = opts.headers;
    return { ok: true, status: 200, json: async () => GVB_FIXTURE };
  };
  const s = createSession({ fetchImpl: fakeFetch });
  await dispatch(s, 'lp_create_project', { name: 'Fetch Test' });

  const src = await dispatch(s, 'lp_add_source', { preset: 'gvb' });
  assert.ok(src.id);
  assert.equal(src.dataKey, 'disruptions');

  const r = await dispatch(s, 'lp_fetch_source', { id: src.id });
  assert.equal(r.status, 200);
  assert.equal(r.sampleDataApplied, true);
  assert.deepEqual(r.staticDataKeys, ['disruptions'], 'array wrapped under dataKey');
  assert.ok(r.structure.some((p) => p === 'disruptions[0].title'), 'jsonPaths structure summary');
  assert.equal(seen.url, src.url);
  assert.equal(seen.headers['User-Agent'], DEFAULT_USER_AGENT, 'browser UA against the WAF');
  assert.equal(seen.headers['Accept'], 'application/json');

  /* sample data actually landed on the doc */
  const doc = await dispatch(s, 'lp_get_document', {});
  assert.deepEqual(doc.staticDataKeys, ['disruptions']);
});

test('lp_save_project / lp_open_project round-trip', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lpmcp-'));
  const file = path.join(dir, 'demo.lpsproj.json');

  const s = createSession();
  await dispatch(s, 'lp_create_project', { name: 'Round Trip', device: { width: 800, height: 480 } });
  await dispatch(s, 'lp_add_widget', { type: 'label', props: { text: 'hello' } });
  await dispatch(s, 'lp_add_source', {
    name: 'Secret API', url: 'https://example.com/api',
    headers: [{ key: 'Authorization', value: 'Bearer xyz', secret: true }]
  });
  let r = await dispatch(s, 'lp_save_project', { path: file });
  assert.equal(r.saved, file);

  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(raw.app, 'larapaper-studio');
  assert.equal(raw.sources[0].headers[0].value, '', 'secret header value stripped on save');

  const s2 = createSession();
  r = await dispatch(s2, 'lp_open_project', { path: file });
  assert.equal(r.name, 'Round Trip');
  assert.equal(r.widgetCount, 1);
  assert.equal(r.sources, 1, 'source restored');
  assert.deepEqual(r.device.width, 800);

  await fs.rm(dir, { recursive: true, force: true });
});

test('error paths return { error } instead of throwing', async () => {
  const s = createSession();

  /* no project open */
  let r = await dispatch(s, 'lp_validate', {});
  assert.match(r.error, /No project open/);

  await dispatch(s, 'lp_create_project', { name: 'Errors' });

  r = await dispatch(s, 'lp_add_widget', { type: 'nonsense' });
  assert.match(r.error, /Unknown widget type/);

  r = await dispatch(s, 'lp_update_widget', { id: 'w_missing', props: {} });
  assert.match(r.error, /No widget with id/);

  r = await dispatch(s, 'lp_set_condition', {
    id: 'root', condition: { enabled: true, op: 'mentions', path: 'data.x' }
  });
  assert.match(r.error, /Invalid condition/, 'value required for mentions');

  r = await dispatch(s, 'lp_add_widget', { type: 'label', layout: 'quadrant' });
  assert.match(r.error, /not enabled/);

  r = await dispatch(s, 'lp_open_project', { path: 'does/not/exist.lpsproj.json' });
  assert.match(r.error, /Cannot read project file/);

  r = await dispatch(s, 'lp_create_project', { name: 'Bad Device', device: 'NoSuchPreset' });
  assert.match(r.error, /Unknown device preset/);

  r = await dispatch(s, 'no_such_tool', {});
  assert.match(r.error, /Unknown tool/);
});

test('lp_list_widget_types: 18 types with schemas and palette categories', async () => {
  const s = createSession();
  const r = await dispatch(s, 'lp_list_widget_types', {});
  assert.equal(Object.keys(r.types).length, 18);
  assert.ok(r.palette.length >= 4);
  assert.ok(r.types.text.schema.some((f) => f.key === 'content'));
  assert.equal(r.types.list.container, true);
  assert.equal(r.types.list.maxChildren, 1);
});

test('update + remove widget', async () => {
  const s = createSession();
  await dispatch(s, 'lp_create_project', { name: 'Mutations' });
  const a = await dispatch(s, 'lp_add_widget', { type: 'label' });
  let r = await dispatch(s, 'lp_update_widget', { id: a.id, props: { text: 'updated', gray: '3' } });
  assert.equal(r.props.text, 'updated');
  assert.equal(r.props.gray, '3');
  r = await dispatch(s, 'lp_remove_widget', { id: a.id });
  assert.equal(r.removed, a.id);
  const doc = await dispatch(s, 'lp_get_document', {});
  assert.equal(doc.layouts.full.widgets.length, 0);
});

test('sample data merge mode', async () => {
  const s = createSession();
  await dispatch(s, 'lp_create_project', { name: 'Merge' });
  await dispatch(s, 'lp_set_sample_data', { data: { a: 1 } });
  const r = await dispatch(s, 'lp_set_sample_data', { data: { b: 2 }, mode: 'merge' });
  assert.deepEqual(r.staticDataKeys.sort(), ['a', 'b']);
});

test('lp_screenshot_layout writes a real PNG of the rendered layout', async () => {
  const s = createSession();
  await dispatch(s, 'lp_create_project', { name: 'Shot', device: 'TRMNL OG' });
  await dispatch(s, 'lp_add_widget', { type: 'title', props: { text: 'GVB STATUS' } });

  const r = await dispatch(s, 'lp_screenshot_layout', { layout: 'full' });
  if (r.error && /No headless Chromium/.test(r.error)) {
    /* No browser on this host: the tool must fail cleanly, not crash. */
    assert.match(r.error, /LP_BROWSER_EXECUTABLE_PATH/);
    return;
  }
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.layout, 'full');
  assert.equal(r.width, 1560, 'default scale 2 doubles the 780px view box');
  assert.equal(r.height, 920);
  /* A real rasterized PNG: non-trivial size and the PNG magic number on disk. */
  assert.ok(r.bytes > 1000, 'expected a non-trivial PNG, got ' + r.bytes + ' bytes');
  const head = readFileSync(r.path).subarray(0, 8);
  assert.deepEqual([...head], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test('lp_screenshot_layout rejects an unknown layout instead of writing a blank image', async () => {
  const s = createSession();
  await dispatch(s, 'lp_create_project', { name: 'Shot2' });
  const r = await dispatch(s, 'lp_screenshot_layout', { layout: 'nope' });
  assert.match(r.error, /Unknown layout/);
});
