'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('../ui/shared/sources.js');

test('wrapSampleData wraps arrays under dataKey (default "items")', () => {
  const arr = [{ a: 1 }, { a: 2 }];
  assert.deepStrictEqual(S.wrapSampleData({ dataKey: 'disruptions' }, arr), { disruptions: arr });
  assert.deepStrictEqual(S.wrapSampleData({ dataKey: '' }, arr), { items: arr });
  assert.deepStrictEqual(S.wrapSampleData({}, arr), { items: arr });
});

test('wrapSampleData passes objects through as-is', () => {
  const obj = { disruptions: [{ title: 'x' }], count: 1 };
  assert.strictEqual(S.wrapSampleData({ dataKey: 'disruptions' }, obj), obj);
});

test('jsonPaths flattens nested objects and arrays', () => {
  const json = {
    disruptions: [
      { title: 'A', meta: { lines: [1, 2] } },
      { title: 'B', meta: { lines: [] } }
    ],
    count: 2,
    empty: {}
  };
  const paths = S.jsonPaths(json);
  assert.ok(paths.indexOf('disruptions[0].title') !== -1);
  assert.ok(paths.indexOf('disruptions[0].meta.lines[0]') !== -1);
  assert.ok(paths.indexOf('disruptions[1].meta.lines') !== -1, 'empty array is a leaf');
  assert.ok(paths.indexOf('count') !== -1);
  assert.ok(paths.indexOf('empty') !== -1, 'empty object is a leaf');
  assert.ok(paths.indexOf('disruptions') === -1, 'containers are not leaves');
});

test('jsonPaths respects maxDepth', () => {
  let deep = { a: 1 };
  for (let i = 0; i < 10; i++) deep = { nest: deep };
  const paths = S.jsonPaths(deep, 3);
  assert.ok(paths.length > 0);
  assert.ok(paths.every((p) => p.split('.').length <= 3));
});

test('bindingFor produces a Liquid output tag', () => {
  assert.strictEqual(S.bindingFor('disruptions[0].title'), '{{ data.disruptions[0].title }}');
  assert.strictEqual(S.bindingFor('count'), '{{ data.count }}');
  /* root-level arrays (e.g. GVB): no stray dot before the bracket — real Liquid rejects data.[0] */
  assert.strictEqual(S.bindingFor('[0].title'), '{{ data[0].title }}');
});

test('GVB preset is well-formed', () => {
  const p = S.GVB_PRESET;
  assert.ok(p.url.indexOf('https://') === 0, 'https URL');
  assert.ok(p.url.indexOf('gvb.nl') !== -1);
  assert.strictEqual(p.method, 'GET');
  assert.ok(p.dataKey && typeof p.dataKey === 'string', 'has dataKey');
  assert.ok(p.headers.some((h) => h.key === 'User-Agent'));
  assert.ok(p.headers.some((h) => h.key === 'Accept' && h.value === 'application/json'));
  assert.ok(p.headers.some((h) => h.key === 'Referer'));
  const src = S.createSource(p);
  assert.ok(src.id, 'createSource assigns an id');
  assert.strictEqual(src.name, 'GVB Disruptions');
  assert.strictEqual(src.saveSecrets, false);
});

test('createSource without preset yields a blank source', () => {
  const src = S.createSource();
  assert.deepStrictEqual(src.headers, []);
  assert.strictEqual(src.method, 'GET');
  assert.strictEqual(src.url, '');
});

test('toPollingConfig formats headers as Key: Value lines', () => {
  const src = S.createSource({
    url: 'https://example.com/api',
    method: 'POST',
    body: '{"q":1}',
    headers: [
      { key: 'Accept', value: 'application/json', secret: false },
      { key: 'Authorization', value: 'Bearer x', secret: true },
      { key: '', value: 'ignored', secret: false }
    ]
  });
  const cfg = S.toPollingConfig(src);
  assert.strictEqual(cfg.pollingUrl, 'https://example.com/api');
  assert.strictEqual(cfg.pollingVerb, 'POST');
  assert.strictEqual(cfg.pollingHeaders, 'Accept: application/json\nAuthorization: Bearer x');
  assert.strictEqual(cfg.pollingBody, '{"q":1}');
});

test('serializeSources strips secret header values unless saveSecrets', () => {
  const mk = (saveSecrets) => S.createSource({
    name: 's', saveSecrets,
    headers: [
      { key: 'Authorization', value: 'Bearer secret-token', secret: true },
      { key: 'Accept', value: 'application/json', secret: false }
    ]
  });
  const stripped = S.serializeSources([mk(false)])[0];
  assert.strictEqual(stripped.headers[0].key, 'Authorization', 'header entry is kept');
  assert.strictEqual(stripped.headers[0].value, '', 'secret value blanked');
  assert.strictEqual(stripped.headers[0].secret, true);
  assert.strictEqual(stripped.headers[1].value, 'application/json', 'non-secret untouched');

  const kept = S.serializeSources([mk(true)])[0];
  assert.strictEqual(kept.headers[0].value, 'Bearer secret-token', 'saveSecrets keeps the value');
});

test('deserializeSources round-trips and tolerates garbage', () => {
  assert.deepStrictEqual(S.deserializeSources(undefined), []);
  assert.deepStrictEqual(S.deserializeSources('nope'), []);
  const src = S.createSource(S.GVB_PRESET);
  const back = S.deserializeSources(S.serializeSources([src]));
  assert.strictEqual(back.length, 1);
  assert.strictEqual(back[0].id, src.id, 'id preserved');
  assert.strictEqual(back[0].dataKey, 'disruptions');
});
