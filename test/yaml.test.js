'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Y = require('../ui/shared/yaml.js');
const YAML = require('yaml');

// Larapaper parses settings.yml with a YAML 1.1 parser, so every emitted
// value must survive both the 1.1 and 1.2 schemas unchanged.
function roundTrip(obj) {
  const out = Y.stringify(obj);
  for (const version of ['1.1', '1.2']) {
    assert.deepStrictEqual(YAML.parse(out, { version }), obj, 'YAML ' + version + ':\n' + out);
  }
  return out;
}

test('strings that YAML 1.1 would retype stay strings', () => {
  roundTrip({
    hex: '0x1F', oct: '0o17', bin: '0b101', underscored: '1_000', inf: '.inf', nan: '.NaN',
    time: '12:30', date: '2024-01-01', datetime: '2024-01-01T10:00:00Z',
    y: 'y', n: 'N', eq: '=', merge: '<<', on: 'on', version: '1.0.0', phrase: '3 days'
  });
});

test('multi-line strings round-trip exactly (leading indent, trailing newlines)', () => {
  roundTrip({
    noTrailing: 'a\nb',
    oneTrailing: 'a\nb\n',
    manyTrailing: 'a\n\n\n',
    leadingIndent: '  {\n    "a": 1\n  }',
    leadingBlank: '\n\nx',
    onlyNewline: '\n',
    tabbed: '\tx\ny',
    nested: { list: [{ body: '  lead\nx\n\n', at: '12:30' }] }
  });
});

test('CRLF is normalized and control characters are escaped', () => {
  const out = Y.stringify({ crlf: 'a\r\nb', ctl: 'a\u0001b', ctlMulti: 'a\u0001\nb' });
  const parsed = YAML.parse(out);
  assert.deepStrictEqual(parsed, { crlf: 'a\nb', ctl: 'a\u0001b', ctlMulti: 'a\u0001\nb' });
});

test('multi-line strings inside arrays are escaped once, not twice', () => {
  roundTrip({ list: ['line1\nline2', 'x'] });
});
