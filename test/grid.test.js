'use strict';
const test = require('node:test');
const assert = require('node:assert');
const W = require('../ui/shared/widgets.js');
const R = require('../ui/shared/recipe.js');

/* state.js is a browser module — load it with a minimal window harness */
global.window = global;
global.LPWidgets = W;
global.LPYaml = require('../ui/shared/yaml.js');
global.LPRecipe = R;
global.LPSources = require('../ui/shared/sources.js');
require('../ui/js/state.js');
const S = global.LPState;

function rootWith(types, layoutKey) {
  const root = R.createRootNode(layoutKey || 'full');
  for (const t of types) root.children.push(W.createNode(t));
  return root;
}

test('grid defaults per layout', () => {
  assert.deepStrictEqual(R.GRID_DEFAULTS.full, { cols: 4, rows: 3 });
  assert.deepStrictEqual(R.GRID_DEFAULTS.half_horizontal, { cols: 4, rows: 2 });
  assert.deepStrictEqual(R.GRID_DEFAULTS.half_vertical, { cols: 2, rows: 3 });
  assert.deepStrictEqual(R.GRID_DEFAULTS.quadrant, { cols: 2, rows: 2 });
  for (const key of R.LAYOUTS) {
    const root = R.createRootNode(key);
    assert.deepStrictEqual(root.grid, R.GRID_DEFAULTS[key], key);
  }
});

test('normalizeGrid clamps and defaults', () => {
  assert.deepStrictEqual(R.normalizeGrid(undefined, 'full'), { cols: 4, rows: 3 });
  assert.deepStrictEqual(R.normalizeGrid({ cols: 99, rows: 0 }, 'quadrant'), { cols: 12, rows: 1 });
});

test('normalizeArea clamps x/y/w/h into the grid', () => {
  const g = { cols: 4, rows: 3 };
  assert.deepStrictEqual(R.normalizeArea({ x: 1, y: 1, w: 2, h: 2 }, g), { x: 1, y: 1, w: 2, h: 2 });
  assert.deepStrictEqual(R.normalizeArea({ x: 5, y: 9, w: 7, h: 2 }, g), { x: 0, y: 1, w: 4, h: 2 });
  assert.deepStrictEqual(R.normalizeArea({ x: -3, y: -1, w: 0, h: 0 }, g), { x: 0, y: 0, w: 1, h: 1 });
  assert.strictEqual(R.normalizeArea(null, g), null);
  assert.strictEqual(R.normalizeArea('junk', g), null);
});

test('auto-place: children without area fill row-major 1x1 in document order', () => {
  const root = rootWith(['label', 'label', 'label', 'label', 'label', 'label']);
  const areas = R.resolveAreas(root).map((r) => r.area);
  assert.deepStrictEqual(areas, [
    { x: 0, y: 0, w: 1, h: 1 }, { x: 1, y: 0, w: 1, h: 1 },
    { x: 2, y: 0, w: 1, h: 1 }, { x: 3, y: 0, w: 1, h: 1 },
    { x: 0, y: 1, w: 1, h: 1 }, { x: 1, y: 1, w: 1, h: 1 }
  ]);
  /* auto-placement is computed, not written back */
  assert.ok(root.children.every((c) => c.area === undefined));
});

test('auto-place skips cells taken by explicit areas', () => {
  const root = rootWith(['label', 'label', 'label']);
  root.children[1].area = { x: 1, y: 0, w: 1, h: 1 };
  const areas = R.resolveAreas(root).map((r) => r.area);
  assert.deepStrictEqual(areas[0], { x: 0, y: 0, w: 1, h: 1 }, 'first free cell');
  assert.deepStrictEqual(areas[1], { x: 1, y: 0, w: 1, h: 1 }, 'explicit kept');
  assert.deepStrictEqual(areas[2], { x: 2, y: 0, w: 1, h: 1 }, 'skips occupied');
});

test('title_bar children are not grid cells', () => {
  const root = rootWith(['title_bar', 'label']);
  const resolved = R.resolveAreas(root);
  assert.strictEqual(resolved.length, 1);
  assert.strictEqual(resolved[0].node.type, 'label');
});

test('firstFreeArea: collision fallback scans from the desired cell, wraps, null when full', () => {
  const g = { cols: 2, rows: 2 };
  const taken = [{ x: 0, y: 0, w: 1, h: 1 }, { x: 1, y: 0, w: 1, h: 1 }];
  assert.deepStrictEqual(R.firstFreeArea(g, taken, 1, 1, 0, 0), { x: 0, y: 1, w: 1, h: 1 });
  /* wrap-around: from (1,1) with only (0,1) free, scanning wraps to it */
  const taken3 = taken.concat([{ x: 1, y: 1, w: 1, h: 1 }]);
  assert.deepStrictEqual(R.firstFreeArea(g, taken3, 1, 1, 1, 1), { x: 0, y: 1, w: 1, h: 1 });
  /* 2x1 does not fit next to taken cells on row 0, fits row 1 */
  assert.deepStrictEqual(R.firstFreeArea(g, taken, 2, 1), { x: 0, y: 1, w: 2, h: 1 });
  /* full grid → null */
  const full = [
    { x: 0, y: 0, w: 1, h: 1 }, { x: 1, y: 0, w: 1, h: 1 },
    { x: 0, y: 1, w: 1, h: 1 }, { x: 1, y: 1, w: 1, h: 1 }
  ];
  assert.strictEqual(R.firstFreeArea(g, full, 1, 1), null);
});

test('grid root liquid: tracks, cell wrappers, gap mapping', () => {
  const root = rootWith(['label']);
  root.children[0].area = { x: 1, y: 2, w: 2, h: 1 };
  root.props.gap = 'large';
  const doc = R.createDocument();
  doc.layouts.full = root;
  const liquid = R.buildLiquid(doc, 'full');
  assert.ok(liquid.indexOf('layout layout--grid') !== -1, 'grid class');
  assert.ok(liquid.indexOf('display:grid') !== -1);
  assert.ok(liquid.indexOf('grid-template-columns:repeat(4,1fr)') !== -1, 'columns track');
  assert.ok(liquid.indexOf('grid-template-rows:repeat(3,1fr)') !== -1, 'rows track');
  assert.ok(liquid.indexOf('gap:20px') !== -1, 'gap large → 20px');
  assert.ok(liquid.indexOf('class="lp-cell"') !== -1, 'cell wrapper');
  assert.ok(liquid.indexOf('grid-column:2/span 2') !== -1, 'column placement (x+1)/span w');
  assert.ok(liquid.indexOf('grid-row:3/span 1') !== -1, 'row placement (y+1)/span h');
  assert.ok(liquid.indexOf('display:flex;flex-direction:column') !== -1, 'cell is a flex column');
});

test('old doc without grid/area still exports (default grid + auto-place)', () => {
  const root = rootWith(['label', 'label']);
  delete root.grid;
  root.props = { gap: 'medium', align: 'center', justify: 'center', grow: true };
  const doc = R.createDocument();
  doc.layouts.full = root;
  const liquid = R.buildLiquid(doc, 'full');
  assert.ok(liquid.indexOf('grid-template-columns:repeat(4,1fr)') !== -1, 'default grid');
  assert.ok(liquid.indexOf('grid-column:1/span 1') !== -1, 'auto-placed first child');
  assert.ok(liquid.indexOf('grid-column:2/span 1') !== -1, 'auto-placed second child');
});

test('grid markup renders in the preview evaluator', () => {
  const doc = R.createDocument();
  const root = doc.layouts.full;
  const v = W.createNode('value');
  v.props.value = 'value';
  v.props.unit = '%';
  root.children.push(v);
  const parts = R.buildViewParts(doc, 'full');
  const html = require('../ui/shared/liquid-eval.js').render(parts.layoutHtml + parts.barHtml, R.buildPreviewContext(doc, 'full'));
  assert.ok(html.indexOf('lp-cell') !== -1);
  assert.ok(html.indexOf('42%') !== -1);
});

/* ---------------- state-level grid behavior ---------------- */

test('addNode auto-places root children into free cells', () => {
  S.newDocument();
  const root = S.getRoot();
  S.addNode('root', null, W.createNode('label'));
  S.addNode('root', null, W.createNode('label'));
  assert.deepStrictEqual(root.children[0].area, { x: 0, y: 0, w: 1, h: 1 });
  assert.deepStrictEqual(root.children[1].area, { x: 1, y: 0, w: 1, h: 1 });
});

test('setNodeArea clamps and is undoable', () => {
  S.newDocument();
  S.addNode('root', null, W.createNode('label'));
  const id = S.getRoot().children[0].id;
  S.setNodeArea(id, { x: 99, y: 99, w: 99, h: 99 });
  assert.deepStrictEqual(S.getRoot().children[0].area, { x: 0, y: 0, w: 4, h: 3 });
  S.undo();
  assert.deepStrictEqual(S.getRoot().children[0].area, { x: 0, y: 0, w: 1, h: 1 });
});

test('setGrid shrink clamps occupied areas', () => {
  S.newDocument();
  S.addNode('root', null, W.createNode('label'));
  const id = S.getRoot().children[0].id;
  S.setNodeArea(id, { x: 3, y: 2, w: 1, h: 1 });
  assert.deepStrictEqual(S.getRoot().children[0].area, { x: 3, y: 2, w: 1, h: 1 });
  S.setGrid({ cols: 2, rows: 2 });
  assert.deepStrictEqual(S.getRoot().grid, { cols: 2, rows: 2 });
  assert.deepStrictEqual(S.getRoot().children[0].area, { x: 1, y: 1, w: 1, h: 1 }, 'clamped into 2x2');
  S.setGrid({ cols: 4, rows: 3 });
  assert.deepStrictEqual(S.getRoot().children[0].area, { x: 1, y: 1, w: 1, h: 1 }, 'growing keeps areas');
});

test('duplicate of a root child lands on a free cell, not stacked', () => {
  S.newDocument();
  S.addNode('root', null, W.createNode('label'));
  const id = S.getRoot().children[0].id;
  S.duplicateNode(id);
  const kids = S.getRoot().children;
  assert.strictEqual(kids.length, 2);
  assert.deepStrictEqual(kids[0].area, { x: 0, y: 0, w: 1, h: 1 });
  assert.deepStrictEqual(kids[1].area, { x: 1, y: 0, w: 1, h: 1 }, 'copy moved to next free cell');
});

test('grid + areas persist through serialize/load; old files load clean', () => {
  S.newDocument();
  S.addNode('root', null, W.createNode('label'));
  S.setGrid({ cols: 6, rows: 4 });
  S.setNodeArea(S.getRoot().children[0].id, { x: 2, y: 1, w: 2, h: 2 });
  const json = S.serialize();
  S.load(json, null);
  assert.deepStrictEqual(S.getRoot().grid, { cols: 6, rows: 4 });
  assert.deepStrictEqual(S.getRoot().children[0].area, { x: 2, y: 1, w: 2, h: 2 });

  /* legacy project file: no grid, no areas */
  const legacy = {
    app: 'larapaper-studio', formatVersion: 1, name: 'Legacy',
    layouts: {
      full: {
        id: 'root', type: 'col', isRoot: true,
        props: { gap: 'medium', align: 'center', justify: 'center', grow: true },
        children: [{ id: 'w1', type: 'label', props: { text: 'hi' } }]
      }
    }
  };
  S.load(JSON.stringify(legacy), null);
  const root = S.getRoot();
  assert.strictEqual(root.grid, undefined, 'doc not rewritten on load');
  assert.strictEqual(root.children[0].area, undefined);
  const resolved = R.resolveAreas(root, R.normalizeGrid(root.grid, 'full'));
  assert.deepStrictEqual(resolved[0].area, { x: 0, y: 0, w: 1, h: 1 }, 'auto-placed at render');
});
