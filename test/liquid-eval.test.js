'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('../ui/shared/liquid-eval.js');

const ctx = {
  percent: 64,
  value: 42,
  items: [{ label: 'Mon', value: 30 }, { label: 'Tue', value: 55 }, { label: 'Wed', value: 80 }],
  data: { nested: { x: 5 } },
  config: { unit: '°C' }
};

test('output + arithmetic filters', () => {
  assert.strictEqual(L.render('{{ percent | times: 100 | divided_by: 100 | round }}', ctx), '64');
  assert.strictEqual(L.render('{{ 5 | plus: 3 | minus: 1 }}', ctx), '7');
  assert.strictEqual(L.render('{{ 10 | divided_by: 4 }}', ctx), '2.5');
  assert.strictEqual(L.render('{{ 3.14159 | round: 2 }}', ctx), '3.14');
});

test('string filters', () => {
  assert.strictEqual(L.render("{{ 'hello' | upcase | append: '!' }}", ctx), 'HELLO!');
  assert.strictEqual(L.render("{{ 'a b c' | replace: ' ', '-' }}", ctx), 'a-b-c');
  assert.strictEqual(L.render("{{ missing | default: 'FB' }}", ctx), 'FB');
  assert.strictEqual(L.render("{{ 'one two three four' | truncatewords: 2 }}", ctx), 'one two...');
});

test('date filter with strftime', () => {
  assert.strictEqual(L.render("{{ '2026-07-30T10:20:30' | date: '%Y-%m-%d %H:%M' }}", ctx), '2026-07-30 10:20');
  assert.strictEqual(L.render("{{ 'now' | date: '%Y' }}", ctx).length, 4);
});

test('paths: nested, bracket, array helpers', () => {
  assert.strictEqual(L.render('{{ data.nested.x }}', ctx), '5');
  assert.strictEqual(L.render('{{ items.first.label }}', ctx), 'Mon');
  assert.strictEqual(L.render('{{ items.last.value }}', ctx), '80');
  assert.strictEqual(L.render('{{ items.size }}', ctx), '3');
  assert.strictEqual(L.render('{{ items[1].label }}', ctx), 'Tue');
});

test('for loop with forloop vars, limit/offset/reversed', () => {
  assert.strictEqual(
    L.render('{% for i in items %}{{ i.label }}{% unless forloop.last %},{% endunless %}{% endfor %}', ctx),
    'Mon,Tue,Wed');
  assert.strictEqual(
    L.render('{% for i in items limit:2 offset:1 %}{{ i.label }}{% endfor %}', ctx), 'TueWed');
  assert.strictEqual(
    L.render('{% for i in items reversed %}{{ i.label }} {% endfor %}', ctx), 'Wed Tue Mon ');
  assert.strictEqual(L.render('{% for n in (1..4) %}{{ n }}{% endfor %}', ctx), '1234');
});

test('conditions: and/or/contains/empty/blank, right-assoc', () => {
  assert.strictEqual(L.render("{% if percent > 50 and value == 42 %}YES{% else %}NO{% endif %}", ctx), 'YES');
  assert.strictEqual(L.render("{% if percent contains '6' %}C{% endif %}", ctx), 'C');
  assert.strictEqual(L.render("{% if missing == blank %}B{% endif %}", ctx), 'B');
  assert.strictEqual(L.render("{% if items == empty %}E{% else %}NE{% endif %}", ctx), 'NE');
  /* right-assoc: true or false and false  ==  true or (false and false) == true */
  assert.strictEqual(L.render('{% if true or false and false %}R{% endif %}', ctx), 'R');
  assert.strictEqual(L.render("{% if false %}A{% elsif percent == 64 %}B{% else %}C{% endif %}", ctx), 'B');
});

test('quoted string containing operator word', () => {
  assert.strictEqual(L.render("{% if 'it contains x' == 'it contains x' %}OK{% endif %}", ctx), 'OK');
});

test('assign / capture / comment / raw', () => {
  assert.strictEqual(L.render('{% assign t = 3 %}{{ t | times: 2 }}', ctx), '6');
  assert.strictEqual(L.render('{% capture c %}cap{{ value }}{% endcapture %}{{ c }}', ctx), 'cap42');
  assert.strictEqual(L.render('a{% comment %}hidden{% endcomment %}b', ctx), 'ab');
  assert.strictEqual(L.render('{% raw %}{{ not_evaluated }}{% endraw %}', ctx), '{{ not_evaluated }}');
});

test('array filters', () => {
  assert.strictEqual(L.render("{{ 'a,b,c' | split: ',' | join: '+' }}", ctx), 'a+b+c');
  assert.strictEqual(L.render("{{ items | map: 'value' | sum }}", ctx), '165');
  assert.strictEqual(L.render("{% for i in items | where: 'label', 'Tue' %}{{ i.value }}{% endfor %}", ctx), '55');
});

test('qr_code hook', () => {
  L.setHooks({ qrCode: (text, module, ec) => 'QR(' + text + ',' + module + ',' + ec + ')' });
  assert.strictEqual(L.render("{{ 'https://x.de' | qr_code: 3, 'M' }}", ctx), 'QR(https://x.de,3,M)');
  L.setHooks({});
  assert.ok(L.render("{{ 'x' | qr_code: 2 }}", ctx).indexOf('<svg') === 0);
});

test('unknown tags/filters are forgiving', () => {
  assert.strictEqual(L.render("a{% include 'x' %}b{{ 'y' | nosuchfilter: 1 }}", ctx), 'aby');
});

test('escape vs escape_once', () => {
  assert.strictEqual(L.render("{{ 'a<b' | escape }}", ctx), 'a&lt;b');
  assert.strictEqual(L.render("{{ 'a&lt;b' | escape_once }}", ctx), 'a&lt;b');
  assert.strictEqual(L.render("{{ 'a<b' | escape_once }}", ctx), 'a&lt;b');
});


test('placeholderUnknown: undefined var renders a chip with the tag text', () => {
  const opts = { placeholderUnknown: true };
  assert.strictEqual(
    L.render('{{ nosuch }}', ctx, opts),
    '<span class="lp-unresolved">{{ nosuch }}</span>');
  assert.strictEqual(
    L.render('{{ data.nope.deeper }}', ctx, opts),
    '<span class="lp-unresolved">{{ data.nope.deeper }}</span>');
  /* special chars in the tag are escaped */
  assert.strictEqual(
    L.render("{{ nosuch | replace: '<', '>' }}", ctx, opts),
    '<span class="lp-unresolved">{{ nosuch | replace: &#39;&lt;&#39;, &#39;&gt;&#39; }}</span>');
});

test('placeholderUnknown: filters on undefined still produce the chip', () => {
  const opts = { placeholderUnknown: true };
  assert.strictEqual(
    L.render('{{ nosuch | upcase }}', ctx, opts),
    '<span class="lp-unresolved">{{ nosuch | upcase }}</span>');
  assert.strictEqual(
    L.render('{{ nosuch | plus: 1 }}', ctx, opts),
    '<span class="lp-unresolved">{{ nosuch | plus: 1 }}</span>');
  /* a default: filter is a real fallback — no chip */
  assert.strictEqual(L.render("{{ nosuch | default: 'x' }}", ctx, opts), 'x');
});

test('placeholderUnknown: defined-but-falsy values render normally', () => {
  const opts = { placeholderUnknown: true };
  const c = { emptyStr: '', zero: 0, no: false, items: [] };
  assert.strictEqual(L.render('{{ emptyStr }}', c, opts), '');
  assert.strictEqual(L.render('{{ zero }}', c, opts), '0');
  assert.strictEqual(L.render('{{ no }}', c, opts), 'false');
  assert.strictEqual(L.render('{{ items.size }}', c, opts), '0');
  assert.strictEqual(L.render('{{ percent }}', ctx, opts), '64');
});

test('placeholderUnknown: output tags inside HTML attributes are untouched', () => {
  const opts = { placeholderUnknown: true };
  assert.strictEqual(L.render('<img src="{{ nosuch }}">', ctx, opts), '<img src="">');
  /* chip appears again once the tag is closed */
  assert.strictEqual(L.render('<i a="{{ nosuch }}"></i>{{ nosuch }}', ctx, opts),
    '<i a=""></i><span class="lp-unresolved">{{ nosuch }}</span>');
});

test('placeholderUnknown: logic tags keep forgiving behavior; flag off = old behavior', () => {
  const opts = { placeholderUnknown: true };
  assert.strictEqual(L.render('{% for i in nosuch %}x{% endfor %}', ctx, opts), '');
  assert.strictEqual(L.render('{% if nosuch %}x{% endif %}', ctx, opts), '');
  /* default (no opts) is unchanged */
  assert.strictEqual(L.render('{{ nosuch }}', ctx), '');
  assert.strictEqual(L.render('{{ nosuch | upcase }}', ctx), '');
  assert.strictEqual(L.render('{{ nosuch }}', ctx, { placeholderUnknown: false }), '');
});
