/**
 * Core session logic for the Larapaper Studio MCP server.
 *
 * Pure functions over an in-memory session ({ doc, filePath }) — no MCP, no
 * stdio. server.js is a thin glue layer over this module, so everything here
 * is directly testable with node --test.
 *
 * The domain model lives in ../ui/shared/*.js (UMD, loaded as CJS default
 * imports). No shared-layer changes were needed: grid auto-placement
 * (resolveAreas / firstFreeArea / normalizeArea) is already exported.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

import LPRecipe from '../ui/shared/recipe.js';
import LPWidgets from '../ui/shared/widgets.js';
import LPConditions from '../ui/shared/conditions.js';
import LPSources from '../ui/shared/sources.js';
import LiquidEval from '../ui/shared/liquid-eval.js';

/** Chrome-on-Windows UA: GVB sits behind an Azure WAF that 403s plain clients. */
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MAX_PATHS = 60; /* cap for jsonPaths summaries */
const MAX_PROP_TEXT = 120; /* truncate bulky text props in lp_get_document */

export function err(message) { return { error: String(message) }; }

/* ------------------------------------------------------------------ */
/* session                                                             */
/* ------------------------------------------------------------------ */

/** opts.fetchImpl lets tests inject a fake fetch (no network). */
export function createSession(opts) {
  opts = opts || {};
  return { doc: null, filePath: null, fetchImpl: opts.fetchImpl || null };
}

function requireDoc(session) {
  return session.doc ? null : err('No project open — call lp_create_project or lp_open_project first.');
}

/* ------------------------------------------------------------------ */
/* document normalization (mirrors ui/js/state.js migrate/serialize)   */
/* ------------------------------------------------------------------ */

function validRoot(node) {
  return node && typeof node === 'object' && node.id === 'root' && node.type &&
    typeof node.props === 'object' && node.props !== null;
}

/** Normalizes a parsed project file into a full document (device/sources defaults). */
export function normalizeProject(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const out = LPRecipe.createDocument();
  for (const k of ['name', 'description', 'strategy', 'refreshInterval', 'pollingUrl',
    'pollingVerb', 'pollingHeaders', 'pollingBody', 'frameworkVersion',
    'darkMode', 'noScreenPadding', 'staticData', 'customFields']) {
    if (raw[k] !== undefined) out[k] = raw[k];
  }
  if (!Array.isArray(out.customFields)) out.customFields = [];
  if (typeof out.staticData !== 'object' || out.staticData === null || Array.isArray(out.staticData)) {
    out.staticData = {};
  }
  out.server = Object.assign({ baseUrl: '', token: '', trmnlpId: null, rememberToken: false }, raw.server);
  out.device = LPRecipe.normalizeDevice(raw.device);
  out.sources = LPSources.deserializeSources(raw.sources);
  out.layouts = { full: null, half_horizontal: null, half_vertical: null, quadrant: null };
  const src = raw.layouts || {};
  for (const key of LPRecipe.LAYOUTS) {
    out.layouts[key] = validRoot(src[key]) ? src[key] : null;
  }
  if (!out.layouts.full) out.layouts.full = LPRecipe.createRootNode('full');
  return out;
}

/** JSON-ready project file object (secret source header values stripped). */
export function serializeProject(doc) {
  const out = Object.assign({ app: 'larapaper-studio', formatVersion: 1 }, doc);
  out.sources = LPSources.serializeSources(doc.sources || []);
  return out;
}

/* ------------------------------------------------------------------ */
/* project lifecycle                                                   */
/* ------------------------------------------------------------------ */

export function createProject(session, args) {
  args = args || {};
  const name = String(args.name || '').trim();
  if (!name) return err('name is required.');
  const doc = LPRecipe.createDocument();
  doc.name = name;
  if (args.device !== undefined) {
    const d = args.device;
    if (typeof d === 'string') {
      const preset = LPRecipe.DEVICE_PRESETS.find((p) => p.name === d);
      if (!preset) {
        return err('Unknown device preset "' + d + '". Available: ' +
          LPRecipe.DEVICE_PRESETS.map((p) => p.name).join(', '));
      }
      doc.device = Object.assign({}, preset);
    } else if (d && typeof d === 'object') {
      doc.device = LPRecipe.normalizeDevice({
        name: d.name || 'Custom ' + d.width + 'x' + d.height,
        width: d.width, height: d.height,
        padding: d.padding, gap: d.gap
      });
    } else {
      return err('device must be a preset name or { width, height, padding? }.');
    }
  }
  session.doc = doc;
  session.filePath = null;
  return summarizeDoc(session);
}

export async function openProject(session, args) {
  args = args || {};
  if (!args.path || typeof args.path !== 'string') return err('path is required.');
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(args.path, 'utf8'));
  } catch (e) {
    return err('Cannot read project file "' + args.path + '": ' + e.message);
  }
  session.doc = normalizeProject(raw);
  session.filePath = path.resolve(args.path);
  return summarizeDoc(session);
}

export async function saveProject(session, args) {
  const noDoc = requireDoc(session);
  if (noDoc) return noDoc;
  args = args || {};
  const target = args.path ? path.resolve(args.path) : session.filePath;
  if (!target) return err('No path given and no previous path — pass path.');
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify(serializeProject(session.doc), null, 2) + '\n', 'utf8');
  } catch (e) {
    return err('Cannot write project file "' + target + '": ' + e.message);
  }
  session.filePath = target;
  return { saved: target };
}

/* ------------------------------------------------------------------ */
/* introspection                                                       */
/* ------------------------------------------------------------------ */

function countWidgets(node) {
  if (!node) return 0;
  return (node.children || []).reduce((n, c) => n + 1 + countWidgets(c), 0);
}

function summarizeDoc(session) {
  const doc = session.doc;
  return {
    name: doc.name,
    device: doc.device,
    filePath: session.filePath,
    layouts: Object.fromEntries(LPRecipe.LAYOUTS.map((k) => [k, !!doc.layouts[k]])),
    widgetCount: LPRecipe.LAYOUTS.reduce((n, k) => n + countWidgets(doc.layouts[k]), 0),
    sources: (doc.sources || []).length,
    staticDataKeys: Object.keys(doc.staticData || {})
  };
}

function trimProps(props) {
  const out = {};
  for (const k of Object.keys(props || {})) {
    let v = props[k];
    if (typeof v === 'string' && v.length > MAX_PROP_TEXT) v = v.slice(0, MAX_PROP_TEXT) + '…';
    out[k] = v;
  }
  return out;
}

function widgetTree(node) {
  const out = { id: node.id, type: node.type, props: trimProps(node.props) };
  if (node.area) out.area = node.area;
  if (node.children && node.children.length) out.children = node.children.map(widgetTree);
  return out;
}

export function getDocument(session) {
  const noDoc = requireDoc(session);
  if (noDoc) return noDoc;
  const doc = session.doc;
  const layouts = {};
  for (const key of LPRecipe.LAYOUTS) {
    const root = doc.layouts[key];
    if (!root) continue;
    layouts[key] = {
      grid: LPRecipe.normalizeGrid(root.grid, key),
      widgets: (root.children || []).map(widgetTree)
    };
  }
  return {
    name: doc.name,
    description: doc.description,
    strategy: doc.strategy,
    refreshInterval: doc.refreshInterval,
    device: doc.device,
    filePath: session.filePath,
    layouts,
    sources: (doc.sources || []).map((s) => ({
      id: s.id, name: s.name, url: s.url, method: s.method, dataKey: s.dataKey,
      headers: (s.headers || []).map((h) => ({ key: h.key, value: h.secret ? '' : h.value, secret: h.secret }))
    })),
    staticDataKeys: Object.keys(doc.staticData || {}),
    customFields: doc.customFields || []
  };
}

export function listWidgetTypes() {
  return {
    palette: LPWidgets.PALETTE.map((cat) => ({ category: cat.category, types: cat.types })),
    types: Object.fromEntries(Object.keys(LPWidgets.TYPES).map((t) => {
      const d = LPWidgets.TYPES[t];
      return [t, {
        name: d.name,
        container: !!d.container,
        maxChildren: d.maxChildren || null,
        defaults: d.defaults(),
        schema: LPWidgets.getSchema(t).map((f) => ({
          key: f.key, type: f.type, label: f.label,
          options: f.options ? f.options.map((o) => o.v) : undefined,
          hint: f.hint, group: f.group
        }))
      }];
    }))
  };
}

export function listLayouts(session) {
  const noDoc = requireDoc(session);
  if (noDoc) return noDoc;
  const doc = session.doc;
  return LPRecipe.LAYOUTS.map((key) => {
    const root = doc.layouts[key];
    if (!root) return { layout: key, enabled: false };
    const grid = LPRecipe.normalizeGrid(root.grid, key);
    return {
      layout: key,
      enabled: true,
      grid: { cols: grid.cols, rows: grid.rows },
      widgetCount: (root.children || []).length
    };
  });
}

/* ------------------------------------------------------------------ */
/* widget mutations                                                    */
/* ------------------------------------------------------------------ */

function walkNodes(doc, fn) {
  for (const key of LPRecipe.LAYOUTS) {
    const root = doc.layouts[key];
    if (!root) continue;
    (function visit(node, parent, layoutKey) {
      if (fn(node, parent, layoutKey) === false) return;
      (node.children || []).forEach((c) => visit(c, node, layoutKey));
    })(root, null, key);
  }
}

function findNode(session, id) {
  let found = null;
  walkNodes(session.doc, (node, parent, layoutKey) => {
    if (node.id === id) { found = { node, parent, layout: layoutKey }; return false; }
  });
  return found;
}

/**
 * Placement for a root child, consistent with the app (ui/js/state.js +
 * canvas.js): explicit areas are clamped via normalizeArea; collisions and
 * missing areas fall back to firstFreeArea scanning from the desired cell.
 */
function placeInRoot(root, layoutKey, node, requestedArea) {
  if (node.type === 'title_bar') return null; /* bars are hoisted, not grid cells */
  const grid = LPRecipe.normalizeGrid(root.grid, layoutKey);
  const occupied = LPRecipe.resolveAreas(root, grid)
    .filter((r) => r.node !== node)
    .map((r) => r.area);
  if (requestedArea) {
    const a = LPRecipe.normalizeArea(requestedArea, grid);
    if (a) {
      const clashes = occupied.some((b) => LPRecipe.areasOverlap(a, b));
      return clashes ? (LPRecipe.firstFreeArea(grid, occupied, a.w, a.h, a.x, a.y) || a) : a;
    }
  }
  return LPRecipe.firstFreeArea(grid, occupied, 1, 1) ||
    { x: grid.cols - 1, y: grid.rows - 1, w: 1, h: 1 }; /* full grid: stack bottom-right, as resolveAreas does */
}

export function addWidget(session, args) {
  const noDoc = requireDoc(session);
  if (noDoc) return noDoc;
  args = args || {};
  const type = String(args.type || '');
  if (!LPWidgets.TYPES[type]) {
    return err('Unknown widget type "' + type + '". Call lp_list_widget_types for valid types.');
  }
  const layoutKey = args.layout ? String(args.layout) : 'full';
  const root = session.doc.layouts[layoutKey];
  if (!root) return err('Layout "' + layoutKey + '" is not enabled. Enabled: ' +
    LPRecipe.LAYOUTS.filter((k) => session.doc.layouts[k]).join(', '));

  let node;
  try {
    node = LPWidgets.createNode(type);
  } catch (e) {
    return err(e.message);
  }
  if (args.props && typeof args.props === 'object') Object.assign(node.props, args.props);

  const parentId = args.parentId ? String(args.parentId) : 'root';
  if (parentId === 'root') {
    node.area = placeInRoot(root, layoutKey, node, args.area);
    root.children.push(node);
  } else {
    const hit = findNode(session, parentId);
    if (!hit) return err('No widget with id "' + parentId + '".');
    const parent = hit.node;
    if (parent.isRoot) {
      node.area = placeInRoot(parent, hit.layout, node, args.area);
    } else {
      if (!LPWidgets.isContainer(parent.type)) {
        return err('Widget "' + parentId + '" of type "' + parent.type + '" cannot have children.');
      }
      delete node.area;
      const max = LPWidgets.maxChildren(parent.type);
      while ((parent.children || []).length >= max) parent.children.pop();
    }
    parent.children = parent.children || [];
    parent.children.push(node);
  }
  return { id: node.id, type: node.type, layout: layoutKey, parentId, area: node.area || null };
}

export function updateWidget(session, args) {
  const noDoc = requireDoc(session);
  if (noDoc) return noDoc;
  args = args || {};
  if (!args.id) return err('id is required.');
  if (!args.props || typeof args.props !== 'object' || Array.isArray(args.props)) {
    return err('props must be an object (shallow-merged).');
  }
  const hit = findNode(session, String(args.id));
  if (!hit) return err('No widget with id "' + args.id + '".');
  hit.node.props = Object.assign({}, hit.node.props, args.props);
  return { id: hit.node.id, props: hit.node.props };
}

export function moveWidget(session, args) {
  const noDoc = requireDoc(session);
  if (noDoc) return noDoc;
  args = args || {};
  if (!args.id) return err('id is required.');
  if (!args.area || typeof args.area !== 'object') return err('area {x,y,w,h} is required.');
  const hit = findNode(session, String(args.id));
  if (!hit) return err('No widget with id "' + args.id + '".');
  if (!hit.parent || !hit.parent.isRoot) {
    return err('Only direct root children have grid areas; "' + args.id + '" is nested.');
  }
  if (hit.node.type === 'title_bar') return err('title_bar widgets are hoisted and have no grid area.');
  const root = hit.parent;
  const a = placeInRoot(root, hit.layout, hit.node, args.area);
  if (a) hit.node.area = a;
  return { id: hit.node.id, area: hit.node.area };
}

export function removeWidget(session, args) {
  const noDoc = requireDoc(session);
  if (noDoc) return noDoc;
  args = args || {};
  if (!args.id) return err('id is required.');
  if (String(args.id) === 'root') return err('The root node cannot be removed.');
  const hit = findNode(session, String(args.id));
  if (!hit || !hit.parent) return err('No widget with id "' + args.id + '".');
  hit.parent.children = hit.parent.children.filter((c) => c.id !== hit.node.id);
  return { removed: hit.node.id, type: hit.node.type };
}

export function setCondition(session, args) {
  const noDoc = requireDoc(session);
  if (noDoc) return noDoc;
  args = args || {};
  if (!args.id) return err('id is required.');
  if (!args.condition || typeof args.condition !== 'object') return err('condition object is required.');
  const hit = findNode(session, String(args.id));
  if (!hit) return err('No widget with id "' + args.id + '".');
  const condition = args.condition;
  if (!LPConditions.isValid(condition)) {
    return err('Invalid condition. Needs { enabled: true, op: one of ' + LPConditions.OPS.join('/') +
      ', path: non-empty' + (LPConditions.VALUE_OPS.includes(condition.op) ? ', value: non-empty' : '') + ' }.');
  }
  hit.node.props.condition = condition;
  const guard = LPConditions.generateGuard(condition, session.doc.staticData);
  return {
    id: hit.node.id,
    summary: LPConditions.conditionSummary(condition),
    guard: { open: guard.open, close: guard.close }
  };
}

export function setSampleData(session, args) {
  const noDoc = requireDoc(session);
  if (noDoc) return noDoc;
  args = args || {};
  if (!args.data || typeof args.data !== 'object' || Array.isArray(args.data)) {
    return err('data must be a JSON object.');
  }
  const mode = args.mode === 'merge' ? 'merge' : 'replace';
  session.doc.staticData = mode === 'merge'
    ? Object.assign({}, session.doc.staticData, args.data)
    : args.data;
  return { mode, staticDataKeys: Object.keys(session.doc.staticData) };
}

/* ------------------------------------------------------------------ */
/* sources                                                             */
/* ------------------------------------------------------------------ */

export function addSource(session, args) {
  const noDoc = requireDoc(session);
  if (noDoc) return noDoc;
  args = args || {};
  let preset = null;
  if (args.preset !== undefined && args.preset !== null && args.preset !== '') {
    if (String(args.preset).toLowerCase() !== 'gvb') return err('Unknown preset "' + args.preset + '". Available: gvb');
    preset = LPSources.GVB_PRESET;
  }
  if (!preset && !(args.name && args.url)) {
    return err('Pass preset: "gvb", or name + url.');
  }
  const source = LPSources.createSource(preset || {
    name: args.name,
    url: args.url,
    method: args.method,
    dataKey: args.dataKey,
    headers: (Array.isArray(args.headers) ? args.headers : []).map((h) => ({
      key: h.key, value: h.value, secret: !!h.secret
    }))
  });
  session.doc.sources = session.doc.sources || [];
  session.doc.sources.push(source);
  return { id: source.id, name: source.name, url: source.url, method: source.method, dataKey: source.dataKey };
}

export async function fetchSource(session, args) {
  const noDoc = requireDoc(session);
  if (noDoc) return noDoc;
  args = args || {};
  if (!args.id) return err('id is required.');
  const source = (session.doc.sources || []).find((s) => s.id === String(args.id));
  if (!source) return err('No source with id "' + args.id + '".');
  if (!source.url) return err('Source "' + source.name + '" has no URL.');

  const headers = {};
  for (const h of source.headers || []) {
    if (h.key && String(h.key).trim()) headers[String(h.key)] = String(h.value || '');
  }
  const hasKey = (k) => Object.keys(headers).some((h) => h.toLowerCase() === k);
  /* WAF-friendly defaults (GVB 403s non-browser clients) */
  if (!hasKey('user-agent')) headers['User-Agent'] = DEFAULT_USER_AGENT;
  if (!hasKey('accept')) headers['Accept'] = 'application/json';

  const fetchImpl = session.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return err('No fetch implementation available (needs Node 18+).');

  let res;
  try {
    res = await fetchImpl(source.url, {
      method: source.method === 'POST' ? 'POST' : 'GET',
      headers,
      body: source.method === 'POST' && source.body ? source.body : undefined
    });
  } catch (e) {
    return err('Fetch failed for "' + source.url + '": ' + e.message);
  }
  const status = res.status;
  let json;
  try {
    json = await res.json();
  } catch (e) {
    return err('HTTP ' + status + ' but response is not JSON: ' + e.message);
  }
  if (!res.ok) return err('HTTP ' + status + ' from ' + source.url);

  const useAsSampleData = args.useAsSampleData !== false;
  if (useAsSampleData) {
    session.doc.staticData = LPSources.wrapSampleData(source, json);
  }
  /* paths describe what agents will bind against: the wrapped sample data */
  const paths = LPSources.jsonPaths(useAsSampleData ? session.doc.staticData : json);
  return {
    status,
    url: source.url,
    sampleDataApplied: useAsSampleData,
    staticDataKeys: useAsSampleData ? Object.keys(session.doc.staticData) : undefined,
    structure: paths.slice(0, MAX_PATHS),
    structureTruncated: paths.length > MAX_PATHS ? paths.length - MAX_PATHS : 0
  };
}

/* ------------------------------------------------------------------ */
/* validation / build / render                                         */
/* ------------------------------------------------------------------ */

export function validate(session) {
  const noDoc = requireDoc(session);
  if (noDoc) return noDoc;
  const doc = session.doc;
  const errors = LPRecipe.validateDoc(doc);
  const conditionErrors = [];
  walkNodes(doc, (node, parent, layoutKey) => {
    const c = node.props && node.props.condition;
    if (c && typeof c === 'object' && c.enabled && !LPConditions.isValid(c)) {
      conditionErrors.push(layoutKey + ' / ' + node.type + ' (' + node.id + '): invalid condition ' +
        JSON.stringify(c));
    }
  });
  return { valid: errors.length === 0 && conditionErrors.length === 0, errors, conditionErrors };
}

export async function buildRecipe(session, args) {
  const noDoc = requireDoc(session);
  if (noDoc) return noDoc;
  args = args || {};
  const files = LPRecipe.buildRecipeFiles(session.doc);
  let written = null;
  if (args.outDir) {
    const dir = path.resolve(String(args.outDir));
    try {
      await fs.mkdir(dir, { recursive: true });
      for (const rel of Object.keys(files)) {
        await fs.writeFile(path.join(dir, rel), files[rel], 'utf8');
      }
      written = dir;
    } catch (e) {
      return err('Cannot write recipe to "' + dir + '": ' + e.message);
    }
  }
  return { files, written };
}

function htmlToText(html) {
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function renderLayout(session, args) {
  const noDoc = requireDoc(session);
  if (noDoc) return noDoc;
  args = args || {};
  const layoutKey = args.layout ? String(args.layout) : 'full';
  if (LPRecipe.LAYOUTS.indexOf(layoutKey) === -1) return err('Unknown layout "' + layoutKey + '".');
  if (!session.doc.layouts[layoutKey]) return err('Layout "' + layoutKey + '" is not enabled.');
  const parts = LPRecipe.buildViewParts(session.doc, layoutKey);
  const ctx = LPRecipe.buildPreviewContext(session.doc, layoutKey);
  const html = LiquidEval.render(parts.layoutHtml + (parts.barHtml || ''), ctx);
  return { layout: layoutKey, html, text: htmlToText(html) };
}

const PREVIEW_CSS_URL = new URL('../ui/css/trmnl-preview.css', import.meta.url);

const execFileAsync = promisify(execFile);

/** Headless Chromium to rasterize with, or null. Reuses the browser the agent already ships. */
function resolveBrowser() {
  const candidates = [
    process.env.LP_BROWSER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  try {
    return execFileSync('which', ['google-chrome'], { encoding: 'utf8' }).trim() || null;
  } catch (e) {
    try {
      return execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim() || null;
    } catch (e2) {
      return null;
    }
  }
}

/**
 * Rasterize one layout to PNG so the agent can *see* what it designed.
 *
 * Reuses the same pipeline as lp_render_layout (buildViewParts +
 * buildPreviewContext + LiquidEval) wrapped in the editor's own `.lp-view`
 * markup and framework CSS, so the image matches the canvas rather than a
 * re-implementation of it. Returns the PNG path (not a base64 blob: the agent
 * reads the file, and a data URL would flood its context).
 */
export async function screenshotLayout(session, args) {
  const noDoc = requireDoc(session);
  if (noDoc) return noDoc;
  args = args || {};
  const layoutKey = args.layout ? String(args.layout) : 'full';

  const rendered = renderLayout(session, args);
  if (rendered.error) return rendered;

  const browser = resolveBrowser();
  if (!browser) {
    return err(
      'No headless Chromium found. Set LP_BROWSER_EXECUTABLE_PATH to a Chrome/Chromium ' +
      'binary, or install google-chrome / chromium.'
    );
  }

  let css;
  try {
    css = await fs.readFile(PREVIEW_CSS_URL, 'utf8');
  } catch (e) {
    return err('Cannot read preview CSS (' + PREVIEW_CSS_URL.pathname + '): ' + e.message);
  }

  const device = LPRecipe.normalizeDevice(session.doc.device);
  const size = LPRecipe.deviceLayoutSizes(device)[layoutKey];
  const scale = Number(args.scale) > 0 ? Number(args.scale) : 2;
  const page =
    '<!doctype html><html><head><meta charset="utf-8"><style>\n' +
    'html,body{margin:0;padding:0;background:#fff}\n' +
    css +
    '\n</style></head><body><div class="view lp-view' +
    (layoutKey !== 'full' ? ' lp-pad lp-smallbar' : '') +
    '" style="width:' + size.w + 'px;height:' + size.h + 'px;background:#fff">' +
    rendered.html +
    '</div></body></html>';

  const outDir = args.outDir
    ? path.resolve(String(args.outDir))
    : await fs.mkdtemp(path.join(os.tmpdir(), 'larapaper-shot-'));
  try {
    await fs.mkdir(outDir, { recursive: true });
  } catch (e) {
    return err('Cannot create output directory "' + outDir + '": ' + e.message);
  }

  const htmlPath = path.join(outDir, 'layout-' + layoutKey + '.html');
  const pngPath = args.out ? path.resolve(String(args.out)) : path.join(outDir, 'layout-' + layoutKey + '.png');
  await fs.writeFile(htmlPath, page, 'utf8');

  const chromeArgs = [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--force-device-scale-factor=' + scale,
    '--window-size=' + size.w + ',' + size.h,
    '--screenshot=' + pngPath,
    'file://' + htmlPath
  ];
  try {
    await execFileAsync(browser, chromeArgs, { timeout: 60000 });
  } catch (e) {
    // Chromium exits non-zero on some headless quirk yet still writes the file,
    // so only a missing/empty output is a real failure.
    if (!existsSync(pngPath)) {
      return err('Headless Chromium failed to write a screenshot: ' + (e.message || e));
    }
  }
  if (!existsSync(pngPath)) return err('Headless Chromium produced no file at "' + pngPath + '".');

  const stat = await fs.stat(pngPath);
  return {
    layout: layoutKey,
    path: pngPath,
    htmlPath,
    width: size.w * scale,
    height: size.h * scale,
    bytes: stat.size,
    text: rendered.text
  };
}

