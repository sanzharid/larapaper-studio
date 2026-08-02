'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../ui/shared/conditions.js');
const W = require('../ui/shared/widgets.js');
const R = require('../ui/shared/recipe.js');
const LE = require('../ui/shared/liquid-eval.js');

/* GVB-shaped sample payload: disruptions with a nested lines array. */
const GVB = {
  disruptions: [
    { title: 'Bus 34 is delayed', description: 'Due to road works.', affectedLines: [{ publicName: '34' }] },
    { title: 'Tram 5 diverted', description: 'Until further notice.', affectedLines: [{ publicName: '5' }] }
  ]
};
const NO34 = { disruptions: [GVB.disruptions[1]] };

const HAY_NORM = " | downcase | replace: ',', ' ' | replace: '.', ' ' | replace: '!', ' '" +
  " | replace: '?', ' ' | replace: ';', ' ' | replace: ':', ' ' | prepend: ' ' | append: ' '";

/* ---------------- exact generator output ---------------- */

test('mentions on an array path with fields: exact guard output', () => {
  const g = C.generateGuard(
    { enabled: true, op: 'mentions', path: 'data.disruptions', fields: ['title', 'description'], value: '34' },
    GVB);
  assert.strictEqual(g.open,
    '{% capture _lp_hay %}{% for _lp_i in data.disruptions %}{{ _lp_i.title }} {{ _lp_i.description }} ' +
    '{% endfor %}{% endcapture %}{% assign _lp_hay = _lp_hay' + HAY_NORM + ' %}' +
    "{% if _lp_hay contains ' 34 ' %}");
  assert.strictEqual(g.close, '{% endif %}');
});

test('not_mentions uses unless/endunless', () => {
  const g = C.generateGuard(
    { enabled: true, op: 'not_mentions', path: 'data.disruptions', fields: ['title'], value: '34' },
    GVB);
  assert.ok(g.open.indexOf("{% unless _lp_hay contains ' 34 ' %}") !== -1);
  assert.strictEqual(g.close, '{% endunless %}');
});

test('mentions on a non-array path searches the value itself (no capture/for)', () => {
  const g = C.generateGuard(
    { enabled: true, op: 'mentions', path: 'data.status', fields: [], value: 'ok' },
    { status: 'all ok' });
  assert.strictEqual(g.open,
    '{% assign _lp_hay = data.status' + HAY_NORM + ' %}{% if _lp_hay contains \' ok \' %}');
  assert.strictEqual(g.close, '{% endif %}');
});

test('mentions with empty fields on an array path emits the whole item', () => {
  const g = C.generateGuard(
    { enabled: true, op: 'mentions', path: 'data.disruptions', fields: [], value: '34' }, GVB);
  assert.ok(g.open.indexOf('{% for _lp_i in data.disruptions %}{{ _lp_i }} {% endfor %}') !== -1);
});

test('nested-array field emits map emission when samples show it', () => {
  const g = C.generateGuard(
    { enabled: true, op: 'mentions', path: 'data.disruptions', fields: ['affectedLines.publicName'], value: '34' },
    GVB);
  assert.ok(g.open.indexOf("{{ _lp_i.affectedLines | map: 'publicName' | join: ' ' }} ") !== -1);
});

test('dotted field falls back to plain dotted emission without array samples', () => {
  const g = C.generateGuard(
    { enabled: true, op: 'mentions', path: 'data.disruptions', fields: ['affectedLines.publicName'], value: '34' },
    { disruptions: [{ affectedLines: { publicName: '34' } }] });
  assert.ok(g.open.indexOf('{{ _lp_i.affectedLines.publicName }} ') !== -1);
  assert.ok(g.open.indexOf('map:') === -1);
});

test('equals / not_equals quote strings, pass numbers and booleans bare', () => {
  const eq = (value) => C.generateGuard({ enabled: true, op: 'equals', path: 'data.status', value }).open;
  assert.strictEqual(eq('34'), "{% if data.status == '34' %}");
  assert.strictEqual(eq(42), '{% if data.status == 42 %}', 'JS numbers pass bare');
  assert.strictEqual(eq('true'), '{% if data.status == true %}');
  assert.strictEqual(eq(false), '{% if data.status == false %}');
  assert.strictEqual(C.generateGuard({ enabled: true, op: 'not_equals', path: 'data.status', value: 'ok' }).open,
    "{% if data.status != 'ok' %}");
  assert.strictEqual(C.generateGuard({ enabled: true, op: 'equals', path: 'data.status', value: 'ok' }).close,
    '{% endif %}');
});

test('present / blank guards', () => {
  assert.deepStrictEqual(
    C.generateGuard({ enabled: true, op: 'present', path: 'data.disruptions' }),
    { open: '{% if data.disruptions != blank %}', close: '{% endif %}' });
  assert.deepStrictEqual(
    C.generateGuard({ enabled: true, op: 'blank', path: 'data.disruptions' }),
    { open: '{% if data.disruptions == blank %}', close: '{% endif %}' });
});

test('disabled or invalid conditions generate nothing', () => {
  const empty = { open: '', close: '' };
  assert.deepStrictEqual(C.generateGuard(null, GVB), empty);
  assert.deepStrictEqual(C.generateGuard({ enabled: false, op: 'present', path: 'data.x' }, GVB), empty);
  assert.deepStrictEqual(C.generateGuard({ enabled: true, op: 'nope', path: 'data.x' }, GVB), empty);
  assert.deepStrictEqual(C.generateGuard({ enabled: true, op: 'present', path: ' ' }, GVB), empty);
  assert.deepStrictEqual(C.generateGuard({ enabled: true, op: 'mentions', path: 'data.x', value: '' }, GVB), empty);
  assert.deepStrictEqual(C.generateGuard({ enabled: true, op: 'mentions', path: 'data.x', value: '!!!' }, GVB), empty,
    'needle that normalizes to nothing is invalid');
});

/* ---------------- helpers ---------------- */

test('normalizeNeedle downcases, maps punctuation to space, wraps in spaces', () => {
  assert.strictEqual(C.normalizeNeedle('Bus 34!'), ' bus 34 ');
  assert.strictEqual(C.normalizeNeedle('34'), ' 34 ');
  assert.strictEqual(C.normalizeNeedle('  Hello,  WORLD. '), ' hello world ');
  assert.strictEqual(C.normalizeNeedle('!?'), '');
});

test('conditionSummary produces short human text', () => {
  assert.strictEqual(
    C.conditionSummary({ enabled: true, op: 'mentions', path: 'data.disruptions', value: '34' }),
    'data.disruptions mentions "34"');
  assert.strictEqual(
    C.conditionSummary({ enabled: true, op: 'not_mentions', path: 'data.disruptions', value: '34' }),
    'data.disruptions doesn\'t mention "34"');
  assert.strictEqual(
    C.conditionSummary({ enabled: true, op: 'blank', path: 'data.disruptions' }),
    'data.disruptions is blank');
  assert.strictEqual(C.conditionSummary({ enabled: false, op: 'blank', path: 'data.x' }), '');
});

test('path helpers: valueAtPath / nearestArrayPath / arrayItemFields', () => {
  assert.strictEqual(C.valueAtPath(GVB, 'data.disruptions'), GVB.disruptions);
  assert.strictEqual(C.valueAtPath(GVB, 'data.disruptions[0].title'), 'Bus 34 is delayed');
  assert.strictEqual(C.nearestArrayPath(GVB, 'disruptions[0].title'), 'disruptions');
  assert.strictEqual(C.nearestArrayPath(GVB, 'disruptions[0].affectedLines[0].publicName'),
    'disruptions[0].affectedLines');
  assert.strictEqual(C.nearestArrayPath(GVB, 'disruptions'), 'disruptions', 'path itself is an array');
  assert.deepStrictEqual(C.arrayItemFields(GVB, 'data.disruptions'),
    ['title', 'description', 'affectedLines.publicName']);
  assert.deepStrictEqual(C.arrayItemFields(GVB, 'data.disruptions[0].title'), [], 'not an array');
});

/* ---------------- end-to-end: buildLiquid + LiquidEval ---------------- */

function docWith(condition, staticData) {
  const doc = R.createDocument();
  doc.staticData = staticData;
  const label = W.createNode('label');
  label.props.text = 'OPERATING NORMALLY';
  if (condition) label.props.condition = condition;
  doc.layouts.full.children.push(label);
  return doc;
}

function renderDoc(doc) {
  return LE.render(R.buildLiquid(doc, 'full'), R.buildPreviewContext(doc, 'full'));
}

test('not_mentions hides the widget when the needle is present (GVB payload)', () => {
  const cond = { enabled: true, op: 'not_mentions', path: 'data.disruptions', fields: ['title', 'description'], value: '34' };
  assert.ok(renderDoc(docWith(cond, GVB)).indexOf('OPERATING NORMALLY') === -1, '34 mentioned → hidden');
  assert.ok(renderDoc(docWith(cond, NO34)).indexOf('OPERATING NORMALLY') !== -1, '34 absent → shown');
});

test('mentions shows the widget only when the needle is present', () => {
  const cond = { enabled: true, op: 'mentions', path: 'data.disruptions', fields: ['title', 'description'], value: '34' };
  assert.ok(renderDoc(docWith(cond, GVB)).indexOf('OPERATING NORMALLY') !== -1);
  assert.ok(renderDoc(docWith(cond, NO34)).indexOf('OPERATING NORMALLY') === -1);
});

test('word-boundary-ish matching: 34 does not match 340 or 134', () => {
  const cond = { enabled: true, op: 'mentions', path: 'data.disruptions', fields: ['title'], value: '34' };
  const d340 = { disruptions: [{ title: 'Bus 340 delayed' }] };
  const d134 = { disruptions: [{ title: 'Bus 134 delayed' }] };
  assert.ok(renderDoc(docWith(cond, d340)).indexOf('OPERATING NORMALLY') === -1);
  assert.ok(renderDoc(docWith(cond, d134)).indexOf('OPERATING NORMALLY') === -1);
});

test('nested-array field (map emission) matches against GVB affectedLines', () => {
  const cond = { enabled: true, op: 'mentions', path: 'data.disruptions', fields: ['affectedLines.publicName'], value: '34' };
  const liquid = R.buildLiquid(docWith(cond, GVB), 'full');
  assert.ok(liquid.indexOf("map: 'publicName'") !== -1, 'generated liquid uses map');
  assert.ok(LE.render(liquid, R.buildPreviewContext(docWith(cond, GVB), 'full')).indexOf('OPERATING NORMALLY') !== -1);
  assert.ok(renderDoc(docWith(cond, NO34)).indexOf('OPERATING NORMALLY') === -1);
});

test('equals / present / blank guards evaluate end-to-end', () => {
  const sd = { status: 'ok', note: '' };
  const eq = { enabled: true, op: 'equals', path: 'data.status', value: 'ok' };
  assert.ok(renderDoc(docWith(eq, sd)).indexOf('OPERATING NORMALLY') !== -1);
  const eqNo = { enabled: true, op: 'equals', path: 'data.status', value: 'down' };
  assert.ok(renderDoc(docWith(eqNo, sd)).indexOf('OPERATING NORMALLY') === -1);
  const present = { enabled: true, op: 'present', path: 'data.missing' };
  assert.ok(renderDoc(docWith(present, sd)).indexOf('OPERATING NORMALLY') === -1, 'missing path is not present');
  const blank = { enabled: true, op: 'blank', path: 'data.note' };
  assert.ok(renderDoc(docWith(blank, sd)).indexOf('OPERATING NORMALLY') !== -1, 'empty string is blank');
});

test('condition wraps the whole subtree of a container', () => {
  const doc = R.createDocument();
  doc.staticData = GVB;
  const col = W.createNode('col');
  col.props.condition = { enabled: true, op: 'not_mentions', path: 'data.disruptions', fields: ['title'], value: '34' };
  const inner = W.createNode('label');
  inner.props.text = 'INNER TEXT';
  col.children.push(inner);
  doc.layouts.full.children.push(col);
  const liquid = R.buildLiquid(doc, 'full');
  assert.ok(liquid.indexOf('{% unless _lp_hay') !== -1);
  const out = LE.render(liquid, R.buildPreviewContext(doc, 'full'));
  assert.ok(out.indexOf('INNER TEXT') === -1, 'conditioned container hides its children');
});

test('wrapLiquid is a no-op for widgets without a valid condition', () => {
  const node = W.createNode('label');
  assert.strictEqual(C.wrapLiquid(node, '<span>x</span>', GVB), '<span>x</span>');
  node.props.condition = { enabled: true, op: 'blank', path: 'data.nothing' };
  assert.strictEqual(C.wrapLiquid(node, '<span>x</span>', GVB),
    '{% if data.nothing == blank %}\n<span>x</span>\n{% endif %}');
});
