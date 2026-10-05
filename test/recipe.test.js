'use strict';
const test = require('node:test');
const assert = require('node:assert');
const W = require('../ui/shared/widgets.js');
const R = require('../ui/shared/recipe.js');
const L = require('../ui/shared/liquid-eval.js');

function buildSampleDoc() {
  const doc = R.createDocument();
  doc.name = 'Weather Dash';
  const root = doc.layouts.full;
  const tb = W.createNode('title_bar');
  root.children.push(tb);
  const row = W.createNode('row');
  const val = W.createNode('value');
  val.props.value = 'value';
  val.props.unit = '%';
  val.props.caption = 'Humidity';
  const qr = W.createNode('qr');
  qr.props.data = 'config.site';
  row.children.push(val, qr);
  root.children.push(row);
  const list = W.createNode('list');
  root.children.push(list);
  const chart = W.createNode('barchart');
  root.children.push(chart);
  return doc;
}

test('all 18 widget types registered with schemas', () => {
  const expected = ['col', 'row', 'grid', 'spacer', 'divider', 'title', 'label', 'value', 'text',
    'richtext', 'image', 'qr', 'progress', 'item', 'list', 'table', 'barchart', 'title_bar'];
  assert.deepStrictEqual(Object.keys(W.TYPES).sort(), expected.sort());
  for (const t of expected) {
    const node = W.createNode(t);
    assert.ok(node.id && node.props, t + ' node');
    assert.ok(Array.isArray(W.getSchema(t)) && W.getSchema(t).length > 0, t + ' schema');
    assert.ok(W.toLiquid(node).length > 5, t + ' liquid');
  }
});

test('list starts with one item template child', () => {
  const list = W.createNode('list');
  assert.strictEqual(list.children.length, 1);
  assert.strictEqual(list.children[0].type, 'item');
  assert.strictEqual(W.maxChildren('list'), 1);
});

test('buildRecipeFiles emits settings.yml + full.liquid, title_bar hoisted', () => {
  const doc = buildSampleDoc();
  const files = R.buildRecipeFiles(doc);
  assert.ok(files['settings.yml']);
  assert.ok(files['full.liquid']);
  assert.ok(!files['quadrant.liquid'], 'disabled layouts are skipped');
  const liquid = files['full.liquid'];
  assert.ok(liquid.indexOf('</div>\n<div class="title_bar"') !== -1, 'title_bar is a sibling after .layout');
  assert.ok(liquid.indexOf('qr_code: 4') !== -1, 'qr module derived from size');
  assert.ok(liquid.indexOf('{% for item in items %}') !== -1, 'list loop');
});

test('settings.yml has correct structure', () => {
  const doc = buildSampleDoc();
  doc.customFields.push({
    keyname: 'site', name: 'Website', fieldType: 'string', default: 'https://x.de',
    placeholder: '', description: '', options: []
  });
  const yml = R.buildSettingsYaml(doc);
  assert.ok(yml.indexOf('name: Weather Dash') === 0);
  assert.ok(yml.indexOf('strategy: static') !== -1);
  assert.ok(yml.indexOf('static_data: |') !== -1);
  assert.ok(yml.indexOf('- keyname: site') !== -1);
  assert.ok(yml.indexOf('dark_mode: "no"') !== -1);
});

test('generated liquid renders in preview evaluator', () => {
  const doc = buildSampleDoc();
  const parts = R.buildViewParts(doc, 'full');
  const ctx = R.buildPreviewContext(doc, 'full');
  ctx.config.site = 'https://example.com';
  const html = L.render(parts.layoutHtml + parts.barHtml, ctx);
  assert.ok(html.indexOf('42%') !== -1, 'value + unit rendered');
  assert.ok(html.indexOf('Humidity') !== -1, 'caption rendered');
  assert.ok((html.match(/class="item"/g) || []).length === 5, 'list repeated 5x from sample data');
  assert.ok(html.indexOf('<svg') !== -1, 'qr placeholder svg rendered');
  assert.ok(html.indexOf('Weather Dash') !== -1, 'title bar instance name');
});

test('validateDoc catches problems', () => {
  const doc = R.createDocument();
  doc.name = '';
  doc.layouts.full.children = [];
  const errs = R.validateDoc(doc);
  assert.ok(errs.some((e) => e.indexOf('name') !== -1));
  assert.ok(errs.some((e) => e.indexOf('full') !== -1));
});

test('generated settings.yml parses as valid YAML', () => {
  const YAML = require('yaml');
  const doc = buildSampleDoc();
  doc.customFields.push({
    keyname: 'mode', name: 'Mode', fieldType: 'select', default: 'a',
    placeholder: '', description: 'Pick one',
    options: [{ label: 'Alpha', value: 'a' }, { label: 'Beta', value: 'b' }]
  });
  const parsed = YAML.parse(R.buildSettingsYaml(doc));
  assert.strictEqual(parsed.name, 'Weather Dash');
  assert.strictEqual(parsed.strategy, 'static');
  assert.strictEqual(parsed.dark_mode, 'no');
  assert.strictEqual(typeof parsed.static_data, 'string');
  assert.deepStrictEqual(JSON.parse(parsed.static_data).percent, 64);
  assert.deepStrictEqual(parsed.custom_fields[0].options, [{ label: 'Alpha', value: 'a' }, { label: 'Beta', value: 'b' }]);
  assert.strictEqual(parsed.refresh_interval, 300);
});

test('cloneWithNewIds regenerates ids but keeps root id', () => {
  const doc = buildSampleDoc();
  const clone = W.cloneWithNewIds(doc.layouts.full);
  assert.strictEqual(clone.id, 'root');
  assert.notStrictEqual(clone.children[0].id, doc.layouts.full.children[0].id);
  assert.deepStrictEqual(clone.children[0].props, doc.layouts.full.children[0].props);
});

test('preview ids are injected only in preview mode', () => {
  const node = W.createNode('label');
  W.setPreviewIds(false);
  assert.ok(W.toLiquid(node).indexOf('data-wid') === -1);
  W.setPreviewIds(true);
  const html = W.toLiquid(node);
  assert.ok(html.indexOf('data-wid="' + node.id + '"') !== -1);
  W.setPreviewIds(false);
});

test('filtered expressions pass through; plain text with a pipe stays literal', () => {
  const val = (v) => { const n = W.createNode('value'); n.props.value = v; return W.toLiquid(n); };
  assert.match(val('data.temp | round: 1'), /\{\{ data\.temp \| round: 1 \}\}/);
  assert.match(val('value | round'), /\{\{ value \| round \}\}/);
  assert.match(val('Rain | Wind'), /\{\{ 'Rain \| Wind' \}\}/);
  const out = L.render(val('data.temp | round: 1'), { data: { temp: 21.46 } });
  assert.match(out, />21\.5</);
});

test('image src keeps Liquid code intact, escapes literal text', () => {
  const img = W.createNode('image');
  img.props.src = '{{ data.missing | default: "https://x/f.png" }}';
  assert.match(W.toLiquid(img), /src="\{\{ data\.missing \| default: "https:\/\/x\/f\.png" \}\}"/);
  img.props.src = '{{ data.url }}?a=1&b="2"';
  assert.match(W.toLiquid(img), /src="\{\{ data\.url \}\}\?a=1&amp;b=&quot;2&quot;"/);
});

test('table columns accept the item.key form shown in the hint', () => {
  const t = W.createNode('table');
  t.props.columns = 'Name:item.name\nAge:age';
  const liquid = W.toLiquid(t);
  assert.match(liquid, /\{\{ item\.name \}\}/);
  assert.match(liquid, /\{\{ item\.age \}\}/);
  assert.doesNotMatch(liquid, /item\.item\./);
});
