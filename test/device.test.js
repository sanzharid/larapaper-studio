'use strict';
const test = require('node:test');
const assert = require('node:assert');
const R = require('../ui/shared/recipe.js');

test('createDocument includes the default device profile', () => {
  const doc = R.createDocument();
  assert.deepStrictEqual(doc.device, { name: 'TRMNL OG', width: 800, height: 480, padding: 10, gap: 10 });
});

test('deviceLayoutSizes with the default device reproduces the old constants (modulo documented rounding)', () => {
  const sizes = R.deviceLayoutSizes(R.DEFAULT_DEVICE);
  assert.deepStrictEqual(sizes.full, { w: 780, h: 460 });
  assert.deepStrictEqual(sizes.half_horizontal, { w: 780, h: 225 });
  /* Rounding note: the legacy LAYOUT_SIZES said 387 for width halves, but no
     single formula yields both 387 (width) and 225 (height) from
     W=800, H=480, p=10, gap=10. We use Math.round((inner - gap) / 2) per
     axis, which gives 385 for width halves. */
  assert.deepStrictEqual(sizes.half_vertical, { w: 385, h: 460 });
  assert.deepStrictEqual(sizes.quadrant, { w: 385, h: 225 });
});

test('deviceLayoutSizes for Kindle PW7 portrait', () => {
  const kindle = R.DEVICE_PRESETS.find((p) => p.name === 'Kindle PW7 (portrait)');
  const sizes = R.deviceLayoutSizes(kindle);
  assert.deepStrictEqual(sizes.full, { w: 1052, h: 1428 });
  assert.deepStrictEqual(sizes.half_horizontal, { w: 1052, h: 709 });
  assert.deepStrictEqual(sizes.half_vertical, { w: 521, h: 1428 });
  assert.deepStrictEqual(sizes.quadrant, { w: 521, h: 709 });
});

test('deviceLayoutSizes for Kindle PW7 landscape', () => {
  const kindle = R.DEVICE_PRESETS.find((p) => p.name === 'Kindle PW7 (landscape)');
  const sizes = R.deviceLayoutSizes(kindle);
  assert.deepStrictEqual(sizes.full, { w: 1428, h: 1052 });
  assert.deepStrictEqual(sizes.half_horizontal, { w: 1428, h: 521 });
  assert.deepStrictEqual(sizes.half_vertical, { w: 709, h: 1052 });
  assert.deepStrictEqual(sizes.quadrant, { w: 709, h: 521 });
});

test('device presets are well-formed', () => {
  assert.strictEqual(R.DEVICE_PRESETS.length, 3);
  for (const p of R.DEVICE_PRESETS) {
    assert.ok(p.name && typeof p.name === 'string', 'name');
    for (const k of ['width', 'height', 'padding', 'gap']) {
      assert.ok(Number.isInteger(p[k]) && p[k] >= 0, p.name + '.' + k);
    }
    const sizes = R.deviceLayoutSizes(p);
    for (const layout of R.LAYOUTS) {
      assert.ok(sizes[layout].w > 0 && sizes[layout].h > 0, p.name + ' ' + layout);
    }
  }
});

test('docs without a device normalize to the defaults', () => {
  assert.deepStrictEqual(R.normalizeDevice(undefined), R.DEFAULT_DEVICE);
  assert.deepStrictEqual(R.normalizeDevice(null), R.DEFAULT_DEVICE);
  assert.deepStrictEqual(R.normalizeDevice({}), R.DEFAULT_DEVICE);
  const partial = R.normalizeDevice({ width: 1448, height: 1072 });
  assert.strictEqual(partial.width, 1448);
  assert.strictEqual(partial.padding, 10);
  assert.strictEqual(partial.gap, 10);
});

test('buildPreviewContext exposes doc device size', () => {
  const doc = R.createDocument();
  doc.device = { name: 'Kindle PW7 (portrait)', width: 1072, height: 1448, padding: 10, gap: 10 };
  const ctx = R.buildPreviewContext(doc, 'full');
  assert.strictEqual(ctx.trmnl.device.width, 1072);
  assert.strictEqual(ctx.trmnl.device.height, 1448);
  /* old doc without device falls back to 800x480 */
  delete doc.device;
  const ctx2 = R.buildPreviewContext(doc, 'full');
  assert.strictEqual(ctx2.trmnl.device.width, 800);
  assert.strictEqual(ctx2.trmnl.device.height, 480);
});

test('legacy LAYOUT_SIZES and SCREEN exports are kept', () => {
  assert.deepStrictEqual(R.SCREEN, { w: 800, h: 480, padding: 10 });
  assert.deepStrictEqual(R.LAYOUT_SIZES.half_vertical, { w: 387, h: 460 });
});
