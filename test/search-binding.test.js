'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('../ui/shared/search-binding.js');
const W = require('../ui/shared/widgets.js');
const R = require('../ui/shared/recipe.js');
const LE = require('../ui/shared/liquid-eval.js');

/* GVB-shaped payload: three of four disruptions match "metro 52" (contains). */
const GVB = {
  disruptions: [
    { title: 'Metro 52 towards Zuid cancelled', description: 'Due to a signal failure.', affectedLines: [{ publicName: '52' }] },
    { title: 'Bus 34 is delayed', description: 'Road works near the depot.', affectedLines: [{ publicName: '34' }] },
    { title: 'Metro 52 diverted via Centraal', description: 'Until further notice.', affectedLines: [{ publicName: '52' }] },
    { title: 'Gap in service metro 52', description: 'Replacement buses running.', affectedLines: [{ publicName: '52' }] }
  ]
};

const SPEC = { enabled: true, path: 'data.disruptions', fields: ['title'], match: 'contains', query: 'metro 52', display: 'title', pick: 1 };

/* ---------------- exact generator output ---------------- */

test('contains, single field, pick 1: exact generated liquid', () => {
  assert.strictEqual(S.generate(SPEC, GVB),
    '{% assign _lp_seen = false %}{% capture _lp_hits %}{% for _lp_i in data.disruptions %}' +
    '{% assign _lp_s = _lp_i.title | downcase %}' +
    "{% if _lp_s contains 'metro 52' %}{% if _lp_seen %}||{% endif %}{{ _lp_i.title }}{% assign _lp_seen = true %}{% endif %}" +
    '{% endfor %}{% endcapture %}' +
    "{% assign _lp_hits = _lp_hits | split: '||' %}{{ _lp_hits[0] }}");
});

test('begins uses truncate with an empty ellipsis (slice is unsupported by the evaluator)', () => {
  const liquid = S.generate(Object.assign({}, SPEC, { match: 'begins' }), GVB);
  assert.strictEqual(liquid,
    '{% assign _lp_seen = false %}{% capture _lp_hits %}{% for _lp_i in data.disruptions %}' +
    '{% assign _lp_s = _lp_i.title | downcase %}' +
    "{% assign _lp_p = _lp_s | truncate: 8, '' %}{% if _lp_p == 'metro 52' %}{% if _lp_seen %}||{% endif %}{{ _lp_i.title }}{% assign _lp_seen = true %}{% endif %}" +
    '{% endfor %}{% endcapture %}' +
    "{% assign _lp_hits = _lp_hits | split: '||' %}{{ _lp_hits[0] }}");
  assert.ok(liquid.indexOf('slice:') === -1, 'never emits slice');
});

test('equals compares the joined text directly', () => {
  const liquid = S.generate(Object.assign({}, SPEC, { match: 'equals', query: 'bus 34 is delayed' }), GVB);
  assert.ok(liquid.indexOf("{% if _lp_s == 'bus 34 is delayed' %}{% if _lp_seen %}||{% endif %}{{ _lp_i.title }}{% assign _lp_seen = true %}{% endif %}") !== -1);
  assert.ok(liquid.indexOf('_lp_p') === -1, 'no prefix assign for equals');
});

test('pick: 1-based index / last / all joined', () => {
  const tail = (pick) => S.generate(Object.assign({}, SPEC, { pick }), GVB).slice(-40);
  assert.ok(S.generate(Object.assign({}, SPEC, { pick: 2 }), GVB).indexOf('{{ _lp_hits[1] }}') !== -1);
  assert.ok(S.generate(Object.assign({}, SPEC, { pick: -1 }), GVB).indexOf('{{ _lp_hits | last }}') !== -1);
  assert.ok(S.generate(Object.assign({}, SPEC, { pick: 0 }), GVB).indexOf("{{ _lp_hits | join: ', ' }}") !== -1);
  assert.ok(tail(1).indexOf('{{ _lp_hits[0] }}') !== -1);
});

test('multi-field search captures the joined fields before downcasing', () => {
  const liquid = S.generate(Object.assign({}, SPEC, { fields: ['title', 'description'] }), GVB);
  assert.ok(liquid.indexOf(
    '{% capture _lp_s %}{{ _lp_i.title }} {{ _lp_i.description }}{% endcapture %}' +
    '{% assign _lp_s = _lp_s | downcase %}') !== -1);
});

test('nested-array field emits the map/join form', () => {
  const liquid = S.generate(Object.assign({}, SPEC, {
    fields: ['affectedLines.publicName'], display: 'title', query: '52'
  }), GVB);
  assert.ok(liquid.indexOf("{% assign _lp_s = _lp_i.affectedLines | map: 'publicName' | join: ' ' | downcase %}") !== -1);
});

test('display may differ from the searched fields', () => {
  const liquid = S.generate(Object.assign({}, SPEC, { display: 'description' }), GVB);
  assert.ok(liquid.indexOf("{% if _lp_s contains 'metro 52' %}{% if _lp_seen %}||{% endif %}{{ _lp_i.description }}{% assign _lp_seen = true %}{% endif %}") !== -1);
});

test('disabled or invalid specs generate nothing', () => {
  assert.strictEqual(S.generate(null, GVB), '');
  assert.strictEqual(S.generate(Object.assign({}, SPEC, { enabled: false }), GVB), '');
  assert.strictEqual(S.generate(Object.assign({}, SPEC, { path: ' ' }), GVB), '');
  assert.strictEqual(S.generate(Object.assign({}, SPEC, { match: 'regex' }), GVB), '');
  assert.strictEqual(S.generate(Object.assign({}, SPEC, { query: '  ' }), GVB), '');
  assert.strictEqual(S.generate(Object.assign({}, SPEC, { query: '"\'' }), GVB), '',
    'query that normalizes to nothing is invalid');
});

test('missing match mode defaults to contains', () => {
  const noMode = Object.assign({}, SPEC);
  delete noMode.match;
  assert.strictEqual(S.generate(noMode, GVB), S.generate(SPEC, GVB));
});

/* ---------------- evaluate(): the JS mirror ---------------- */

test('evaluate mirrors contains on the GVB fixture (3 metro hits)', () => {
  const r = S.evaluate(SPEC, GVB);
  assert.strictEqual(r.count, 3);
  assert.deepStrictEqual(r.matches, [
    'Metro 52 towards Zuid cancelled',
    'Metro 52 diverted via Centraal',
    'Gap in service metro 52'
  ]);
});

test('evaluate is case-insensitive and mirrors begins/equals', () => {
  assert.strictEqual(S.evaluate(Object.assign({}, SPEC, { query: 'METRO 52' }), GVB).count, 3);
  assert.deepStrictEqual(
    S.evaluate(Object.assign({}, SPEC, { match: 'begins' }), GVB).matches,
    ['Metro 52 towards Zuid cancelled', 'Metro 52 diverted via Centraal']);
  assert.deepStrictEqual(
    S.evaluate(Object.assign({}, SPEC, { match: 'equals', query: 'bus 34 is delayed' }), GVB).matches,
    ['Bus 34 is delayed']);
});

test('evaluate searches joined multi-fields and nested-array fields', () => {
  const multi = S.evaluate(Object.assign({}, SPEC, { fields: ['title', 'description'], query: 'signal failure' }), GVB);
  assert.deepStrictEqual(multi.matches, ['Metro 52 towards Zuid cancelled']);
  const nested = S.evaluate(Object.assign({}, SPEC, {
    fields: ['affectedLines.publicName'], query: '52', display: 'title'
  }), GVB);
  assert.strictEqual(nested.count, 3);
});

test('evaluate honors a display field different from the searched fields', () => {
  const r = S.evaluate(Object.assign({}, SPEC, { match: 'equals', query: 'bus 34 is delayed', display: 'description' }), GVB);
  assert.deepStrictEqual(r.matches, ['Road works near the depot.']);
});

test('evaluate returns empty for non-array paths and invalid specs', () => {
  assert.deepStrictEqual(S.evaluate(Object.assign({}, SPEC, { path: 'data.status' }), { status: 'ok' }), { matches: [], count: 0 });
  assert.deepStrictEqual(S.evaluate(Object.assign({}, SPEC, { enabled: false }), GVB), { matches: [], count: 0 });
});

test('picked resolves the current pick to the displayed string', () => {
  assert.strictEqual(S.picked(SPEC, GVB), 'Metro 52 towards Zuid cancelled');
  assert.strictEqual(S.picked(Object.assign({}, SPEC, { pick: 2 }), GVB), 'Metro 52 diverted via Centraal');
  assert.strictEqual(S.picked(Object.assign({}, SPEC, { pick: -1 }), GVB), 'Gap in service metro 52');
  assert.strictEqual(S.picked(Object.assign({}, SPEC, { pick: 0 }), GVB),
    'Metro 52 towards Zuid cancelled, Metro 52 diverted via Centraal, Gap in service metro 52');
  assert.strictEqual(S.picked(Object.assign({}, SPEC, { pick: 9 }), GVB), '', 'out of range → empty');
});

test('summary produces short human text', () => {
  assert.strictEqual(
    S.summary({ enabled: true, path: 'data.disruptions', fields: ['title'], match: 'begins', query: 'metro 52', pick: 1 }),
    'data.disruptions: title begins "metro 52" → show #1');
  assert.strictEqual(
    S.summary(Object.assign({}, SPEC, { pick: 0 })),
    'data.disruptions: title contains "metro 52" → show all (joined)');
  assert.strictEqual(S.summary(Object.assign({}, SPEC, { enabled: false })), '');
});

/* ---------------- end-to-end: buildLiquid + LiquidEval ---------------- */

function docWith(props, staticData) {
  const doc = R.createDocument();
  doc.staticData = staticData;
  const label = W.createNode('label');
  label.props.text = 'FALLBACK TEXT';
  Object.assign(label.props, props);
  doc.layouts.full.children.push(label);
  return doc;
}

function renderDoc(doc) {
  return LE.render(R.buildLiquid(doc, 'full'), R.buildPreviewContext(doc, 'full'));
}

test('search binding overrides the target prop and renders the picked hit', () => {
  const doc = docWith({ search: Object.assign({}, SPEC, { targetProp: 'text', pick: 2 }) }, GVB);
  const liquid = R.buildLiquid(doc, 'full');
  assert.ok(liquid.indexOf('{% capture _lp_hits %}') !== -1, 'search liquid in the recipe');
  assert.ok(liquid.indexOf('{{ _lp_hits[1] }}') !== -1);
  const out = renderDoc(doc);
  assert.ok(out.indexOf('Metro 52 diverted via Centraal') !== -1, '2nd hit rendered');
  assert.ok(out.indexOf('FALLBACK TEXT') === -1, 'the binding wins over the typed prop value');
});

test('begins / equals / last / all render correctly end-to-end', () => {
  const begins = docWith({ search: Object.assign({}, SPEC, { targetProp: 'text', match: 'begins', pick: -1 }) }, GVB);
  assert.ok(renderDoc(begins).indexOf('Metro 52 diverted via Centraal') !== -1, 'last begins-hit');
  const eq = docWith({ search: Object.assign({}, SPEC, { targetProp: 'text', match: 'equals', query: 'bus 34 is delayed' }) }, GVB);
  assert.ok(renderDoc(eq).indexOf('Bus 34 is delayed') !== -1);
  const all = docWith({ search: Object.assign({}, SPEC, { targetProp: 'text', pick: 0 }) }, GVB);
  const allOut = renderDoc(all);
  assert.ok(allOut.indexOf('Metro 52 towards Zuid cancelled, Metro 52 diverted via Centraal, Gap in service metro 52') !== -1);
  const none = docWith({ search: Object.assign({}, SPEC, { targetProp: 'text', query: 'tram 99' }) }, GVB);
  assert.ok(renderDoc(none).indexOf('metro 52') === -1 && renderDoc(none).indexOf('Metro 52') === -1, 'no hits → empty text');
});

test('nested-array search field renders via map/join end-to-end', () => {
  const doc = docWith({
    search: Object.assign({}, SPEC, { targetProp: 'text', fields: ['affectedLines.publicName'], query: '34' })
  }, GVB);
  assert.ok(renderDoc(doc).indexOf('Bus 34 is delayed') !== -1);
});

test('composes with a condition guard (condition wraps the searched widget)', () => {
  const props = {
    search: Object.assign({}, SPEC, { targetProp: 'text' }),
    condition: { enabled: true, op: 'mentions', path: 'data.disruptions', fields: ['title'], value: 'metro 52' }
  };
  const shown = renderDoc(docWith(props, GVB));
  assert.ok(shown.indexOf('Metro 52 towards Zuid cancelled') !== -1, 'condition true → hit shown');
  const hidden = renderDoc(docWith(props, { disruptions: [GVB.disruptions[1]] }));
  assert.ok(hidden.indexOf('Bus 34 is delayed') === -1, 'condition false → widget (and its search) hidden');
});

test('widgets.primaryTextProp is shared with the sources panel logic', () => {
  const label = W.createNode('label');
  assert.strictEqual(W.primaryTextProp(label), 'text');
  const value = W.createNode('value');
  assert.strictEqual(W.primaryTextProp(value), 'value');
  const spacer = W.createNode('spacer');
  assert.strictEqual(W.primaryTextProp(spacer), null);
  assert.deepStrictEqual(W.TEXT_PROPS, ['value', 'text', 'label', 'title', 'content']);
});
