/**
 * Recipe builder: turns a Larapaper Studio document into the files that make
 * up a trmnlp recipe (settings.yml + liquid templates) and builds the Liquid
 * context used for the design-time preview.
 *
 * UMD: usable from renderer, main process and Node tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./widgets'), require('./yaml'));
  } else {
    root.LPRecipe = factory(root.LPWidgets, root.LPYaml);
  }
})(typeof self !== 'undefined' ? self : this, function (Widgets, Yaml) {
  'use strict';

  const LAYOUTS = ['full', 'half_horizontal', 'half_vertical', 'quadrant'];

  /** Pixel sizes of the view boxes on an 800x480 TRMNL screen (gap 10px).
   *  Legacy constants kept for backwards compatibility; new code should use
   *  deviceLayoutSizes(doc.device). NOTE: the historical width halves (387)
   *  do not follow from a clean formula — deviceLayoutSizes computes 385
   *  via Math.round((inner - gap) / 2). */
  const LAYOUT_SIZES = {
    full: { w: 780, h: 460 },
    half_horizontal: { w: 780, h: 225 },
    half_vertical: { w: 387, h: 460 },
    quadrant: { w: 387, h: 225 }
  };
  const SCREEN = { w: 800, h: 480, padding: 10 };

  /* ------------------------------------------------------------------ */
  /* device profiles                                                     */
  /* ------------------------------------------------------------------ */

  const DEFAULT_DEVICE = { name: 'TRMNL OG', width: 800, height: 480, padding: 10, gap: 10 };

  const DEVICE_PRESETS = [
    { name: 'TRMNL OG', width: 800, height: 480, padding: 10, gap: 10 },
    { name: 'Kindle PW7 (landscape)', width: 1448, height: 1072, padding: 10, gap: 10 },
    { name: 'Kindle PW7 (portrait)', width: 1072, height: 1448, padding: 10, gap: 10 }
  ];

  function num(v, fallback) {
    const n = parseInt(v, 10);
    return isNaN(n) ? fallback : n;
  }

  /** Fills missing/invalid device fields with the TRMNL OG defaults. */
  function normalizeDevice(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    return {
      name: typeof raw.name === 'string' && raw.name ? raw.name : DEFAULT_DEVICE.name,
      width: Math.max(1, num(raw.width, DEFAULT_DEVICE.width)),
      height: Math.max(1, num(raw.height, DEFAULT_DEVICE.height)),
      padding: Math.max(0, num(raw.padding, DEFAULT_DEVICE.padding)),
      gap: Math.max(0, num(raw.gap, DEFAULT_DEVICE.gap))
    };
  }

  /**
   * View-box sizes per layout for a device profile.
   * full  = (W-2p) x (H-2p)
   * halves/quadrant split the inner box across the gap, rounding per axis:
   * Math.round((inner - gap) / 2). With the default device this yields
   * 780x460 / 780x225 / 385x460 / 385x225 (the legacy tables said 387 for
   * the width halves; no single formula reproduces both 387 and 225, so we
   * accept the symmetric 385).
   */
  function deviceLayoutSizes(device) {
    const d = normalizeDevice(device);
    const innerW = d.width - 2 * d.padding;
    const innerH = d.height - 2 * d.padding;
    const halfW = Math.round((innerW - d.gap) / 2);
    const halfH = Math.round((innerH - d.gap) / 2);
    return {
      full: { w: innerW, h: innerH },
      half_horizontal: { w: innerW, h: halfH },
      half_vertical: { w: halfW, h: innerH },
      quadrant: { w: halfW, h: halfH }
    };
  }

  /* ------------------------------------------------------------------ */
  /* cell grid (root placement)                                          */
  /* ------------------------------------------------------------------ */

  /** Default root grid (cols x rows) per layout; smaller layouts get fewer cells. */
  const GRID_DEFAULTS = {
    full: { cols: 4, rows: 3 },
    half_horizontal: { cols: 4, rows: 2 },
    half_vertical: { cols: 2, rows: 3 },
    quadrant: { cols: 2, rows: 2 }
  };
  const MAX_GRID = 12;

  /** Pixel values matching the design system's gap--* classes. */
  const GAP_PX = { none: 0, xsmall: 5, small: 7, medium: 16, large: 20, xlarge: 30, xxlarge: 40 };

  function normalizeGrid(raw, layoutKey) {
    const def = GRID_DEFAULTS[layoutKey] || GRID_DEFAULTS.full;
    raw = raw && typeof raw === 'object' ? raw : {};
    return {
      cols: Math.max(1, Math.min(MAX_GRID, num(raw.cols, def.cols))),
      rows: Math.max(1, Math.min(MAX_GRID, num(raw.rows, def.rows)))
    };
  }

  /** Clamps a cell area into the grid; returns null when raw is not an area. */
  function normalizeArea(raw, grid) {
    if (!raw || typeof raw !== 'object') return null;
    const w = Math.max(1, Math.min(grid.cols, num(raw.w, 1)));
    const h = Math.max(1, Math.min(grid.rows, num(raw.h, 1)));
    const x = Math.max(0, Math.min(grid.cols - w, num(raw.x, 0)));
    const y = Math.max(0, Math.min(grid.rows - h, num(raw.y, 0)));
    return { x, y, w, h };
  }

  function areasOverlap(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  }

  /**
   * First free w x h spot, scanning row-major starting at (startX, startY)
   * (wrapping around, so the nearest free cell wins). null when the grid is full.
   */
  function firstFreeArea(grid, areas, w, h, startX, startY) {
    w = Math.max(1, Math.min(grid.cols, w || 1));
    h = Math.max(1, Math.min(grid.rows, h || 1));
    const total = grid.cols * grid.rows;
    const start = startX === undefined ? 0
      : Math.max(0, Math.min(total - 1, (startY || 0) * grid.cols + startX));
    for (let i = 0; i < total; i++) {
      const idx = (start + i) % total;
      const x = idx % grid.cols;
      const y = Math.floor(idx / grid.cols);
      if (x + w > grid.cols || y + h > grid.rows) continue;
      const a = { x, y, w, h };
      if (!areas.some((b) => areasOverlap(a, b))) return a;
    }
    return null;
  }

  /**
   * Concrete cell area for every non-title_bar root child, in document order.
   * Children with a valid `area` keep it; children WITHOUT one are auto-placed
   * row-major (1x1) into the first free cell — computed, never written back.
   * Overflow (full grid) stacks at the bottom-right cell.
   */
  function resolveAreas(rootNode, grid) {
    grid = grid || normalizeGrid(rootNode && rootNode.grid);
    const placed = [];
    const out = [];
    for (const c of (rootNode && rootNode.children) || []) {
      if (c.type === 'title_bar') continue;
      let a = c.area ? normalizeArea(c.area, grid) : null;
      if (!a) a = firstFreeArea(grid, placed, 1, 1) || { x: grid.cols - 1, y: grid.rows - 1, w: 1, h: 1 };
      placed.push(a);
      out.push({ node: c, area: a });
    }
    return out;
  }

  const FIELD_TYPES = ['string', 'password', 'number', 'textarea', 'select', 'checkbox'];

  /* ------------------------------------------------------------------ */
  /* document model                                                      */
  /* ------------------------------------------------------------------ */

  function createRootNode(layoutKey) {
    return {
      id: 'root',
      type: 'col',
      isRoot: true,
      /* stretch: cells fill their grid area (justify is moot with 1fr tracks) */
      props: { gap: 'medium', align: 'stretch', justify: 'flex-start', grow: true },
      grid: Object.assign({}, GRID_DEFAULTS[layoutKey] || GRID_DEFAULTS.full),
      children: []
    };
  }

  function createDocument() {
    return {
      version: 1,
      name: 'My Plugin',
      description: '',
      strategy: 'static',
      refreshInterval: 300,
      pollingUrl: '',
      pollingVerb: 'GET',
      pollingHeaders: '',
      pollingBody: '',
      frameworkVersion: '1.0.0',
      darkMode: false,
      noScreenPadding: false,
      staticData: {
        value: 42,
        percent: 64,
        items: [
          { label: 'Mon', value: 30 },
          { label: 'Tue', value: 55 },
          { label: 'Wed', value: 80 },
          { label: 'Thu', value: 45 },
          { label: 'Fri', value: 95 }
        ],
        rows: [
          { name: 'Row A', value: '12' },
          { name: 'Row B', value: '34' }
        ]
      },
      customFields: [],
      sources: [],
      device: Object.assign({}, DEFAULT_DEVICE),
      layouts: { full: createRootNode('full'), half_horizontal: null, half_vertical: null, quadrant: null },
      server: { baseUrl: '', token: '', trmnlpId: null, rememberToken: false }
    };
  }

  /* ------------------------------------------------------------------ */
  /* validation                                                          */
  /* ------------------------------------------------------------------ */

  function validateDoc(doc) {
    const errors = [];
    if (!doc.name || !String(doc.name).trim()) errors.push('Recipe name is required.');
    if (doc.strategy === 'polling' && !(doc.pollingUrl && String(doc.pollingUrl).trim())) {
      errors.push('Polling strategy requires a polling URL.');
    }
    if (!doc.layouts.full || !doc.layouts.full.children || doc.layouts.full.children.length === 0) {
      errors.push('The "full" layout is empty — add at least one widget.');
    }
    const seen = {};
    (doc.customFields || []).forEach((f, i) => {
      const k = (f.keyname || '').trim();
      if (!k) errors.push('Custom field #' + (i + 1) + ' is missing a keyname.');
      else if (!/^[a-z][a-z0-9_]*$/.test(k)) errors.push('Custom field keyname "' + k + '" must be snake_case (lowercase letters, digits, underscores).');
      else if (seen[k]) errors.push('Duplicate custom field keyname "' + k + '".');
      seen[k] = true;
      if (f.fieldType === 'select' && (!f.options || f.options.length === 0)) {
        errors.push('Select custom field "' + k + '" needs at least one option.');
      }
    });
    if (typeof doc.staticData !== 'object' || doc.staticData === null || Array.isArray(doc.staticData)) {
      errors.push('Sample data must be a JSON object.');
    }
    return errors;
  }


  /* ------------------------------------------------------------------ */
  /* liquid generation                                                   */
  /* ------------------------------------------------------------------ */

  /** One root child wrapped in its grid cell. */
  function cellLiquid(area, childHtml) {
    return '<div class="lp-cell" style="grid-column:' + (area.x + 1) + '/span ' + area.w +
      ';grid-row:' + (area.y + 1) + '/span ' + area.h +
      ';display:flex;flex-direction:column;min-width:0;min-height:0">\n' + childHtml + '\n</div>';
  }

  /**
   * Root container: a real CSS grid (.layout .layout--grid) so the exported
   * Liquid matches the designer's cell grid exactly. Old docs without
   * root.grid/child areas get the layout's default grid + auto-placement.
   */
  function rootLiquid(rootNode, layoutKey, ctx) {
    const p = rootNode.props || {};
    const grid = normalizeGrid(rootNode.grid, layoutKey);
    const styles = [];
    styles.push('display:grid');
    styles.push('grid-template-columns:repeat(' + grid.cols + ',1fr)');
    styles.push('grid-template-rows:repeat(' + grid.rows + ',1fr)');
    styles.push('gap:' + (GAP_PX[p.gap] !== undefined ? GAP_PX[p.gap] : GAP_PX.medium) + 'px');
    styles.push('align-items:' + (p.align || 'center'));
    styles.push('justify-content:' + (p.justify || 'center'));
    const cls = ['layout', 'layout--grid'];
    if (p.extraClass && String(p.extraClass).trim()) cls.push(String(p.extraClass).trim());
    if (p.extraStyle && String(p.extraStyle).trim()) styles.push(String(p.extraStyle).trim().replace(/;+$/, ''));
    const body = resolveAreas(rootNode, grid)
      .map((r) => cellLiquid(r.area, Widgets.toLiquid(r.node, ctx || {})))
      .join('\n');
    return '<div class="' + cls.join(' ') + '" style="' + styles.join(';') + '">\n' + body + '\n</div>\n';
  }

  /**
   * Splits a layout into { layoutHtml, barHtml }. title_bar widgets are
   * hoisted out of .layout: on the device the title bar is a sibling of
   * .layout inside .view (CSS: .layout:has(+ .title_bar)).
   */
  function buildViewParts(doc, layoutKey) {
    const rootNode = doc.layouts[layoutKey];
    if (!rootNode) return null;
    const bars = [];
    const rest = [];
    (rootNode.children || []).forEach((c) => (c.type === 'title_bar' ? bars : rest).push(c));
    /* sampleData lets condition guards pick array/map emission (conditions.js) */
    const ctx = { sampleData: doc.staticData };
    const layoutHtml = rootLiquid(Object.assign({}, rootNode, { children: rest }), layoutKey, ctx);
    const barHtml = bars.map((b) => Widgets.toLiquid(b, ctx)).join('\n');
    return { layoutHtml, barHtml };
  }

  /** Liquid template for one layout size, or null when the layout is disabled. */
  function buildLiquid(doc, layoutKey) {
    const parts = buildViewParts(doc, layoutKey);
    if (!parts) return null;
    return parts.layoutHtml + (parts.barHtml ? parts.barHtml + '\n' : '');
  }

  /* ------------------------------------------------------------------ */
  /* settings.yml                                                        */
  /* ------------------------------------------------------------------ */

  function buildSettingsObject(doc) {
    const s = {};
    s.name = String(doc.name || 'My Plugin');
    if (doc.description && String(doc.description).trim()) s.description = String(doc.description);
    s.no_screen_padding = doc.noScreenPadding ? 'yes' : 'no';
    s.dark_mode = doc.darkMode ? 'yes' : 'no';
    s.strategy = doc.strategy === 'polling' ? 'polling' : 'static';
    if (s.strategy === 'static') {
      s.static_data = JSON.stringify(doc.staticData || {}, null, 2);
    } else {
      s.polling_url = String(doc.pollingUrl || '');
      if (doc.pollingVerb && doc.pollingVerb !== 'GET') s.polling_verb = String(doc.pollingVerb).toLowerCase();
      if (doc.pollingHeaders && String(doc.pollingHeaders).trim()) s.polling_headers = String(doc.pollingHeaders);
      if (doc.pollingBody && String(doc.pollingBody).trim()) s.polling_body = String(doc.pollingBody);
    }
    const refresh = parseInt(doc.refreshInterval, 10);
    s.refresh_interval = isNaN(refresh) ? 300 : refresh;
    s.framework_version = String(doc.frameworkVersion || '1.0.0');
    const fields = (doc.customFields || []).map((f) => {
      const out = {};
      out.keyname = String(f.keyname || '');
      out.name = String(f.name || f.keyname || '');
      out.field_type = FIELD_TYPES.indexOf(f.fieldType) !== -1 ? f.fieldType : 'string';
      if (f.fieldType === 'select') {
        out.options = (f.options || []).map((o) => ({ label: String(o.label), value: String(o.value) }));
      }
      if (f.default !== undefined && f.default !== null && String(f.default) !== '') {
        out.default = f.fieldType === 'number' ? (isNaN(parseFloat(f.default)) ? String(f.default) : parseFloat(f.default)) : String(f.default);
      }
      if (f.placeholder && String(f.placeholder).trim()) out.placeholder = String(f.placeholder);
      if (f.description && String(f.description).trim()) out.description = String(f.description);
      return out;
    });
    s.custom_fields = fields;
    return s;
  }

  function buildSettingsYaml(doc) {
    return Yaml.stringify(buildSettingsObject(doc));
  }

  /* ------------------------------------------------------------------ */
  /* whole recipe                                                        */
  /* ------------------------------------------------------------------ */

  /** Returns { relativePath: content } for every file of the recipe. */
  function buildRecipeFiles(doc) {
    const files = {};
    files['settings.yml'] = buildSettingsYaml(doc);
    for (const key of LAYOUTS) {
      const liquid = buildLiquid(doc, key);
      if (liquid !== null) files[key + '.liquid'] = liquid;
    }
    return files;
  }

  /* ------------------------------------------------------------------ */
  /* preview context                                                     */
  /* ------------------------------------------------------------------ */

  function buildPreviewContext(doc, layoutKey) {
    const data = (typeof doc.staticData === 'object' && doc.staticData !== null) ? doc.staticData : {};
    const device = normalizeDevice(doc.device);
    const config = {};
    (doc.customFields || []).forEach((f) => {
      if (f.keyname) config[f.keyname] = f.default !== undefined && f.default !== '' ? f.default : (f.placeholder || '');
    });
    const ctx = {
      size: layoutKey,
      data,
      config,
      trmnl: {
        plugin_settings: {
          instance_name: doc.name || 'My Plugin',
          custom_fields_values: config
        },
        device: {
          width: device.width,
          height: device.height,
          friendly_id: 'ABC123',
          percent_charged: 87,
          wifi_strength: -42,
          battery_voltage: 4.1,
          rssi: -42
        },
        user: {
          name: 'Preview User',
          first_name: 'Preview',
          time_zone_iana: 'Europe/Berlin',
          utc_offset: '7200',
          locale: 'en'
        },
        system: {
          timestamp_utc: new Date().toISOString()
        }
      }
    };
    // Larapaper also merges the payload into the template root
    for (const k of Object.keys(data)) {
      if (!(k in ctx)) ctx[k] = data[k];
    }
    return ctx;
  }

  return {
    LAYOUTS,
    LAYOUT_SIZES,
    SCREEN,
    FIELD_TYPES,
    DEFAULT_DEVICE,
    DEVICE_PRESETS,
    normalizeDevice,
    deviceLayoutSizes,
    GRID_DEFAULTS,
    GAP_PX,
    normalizeGrid,
    normalizeArea,
    areasOverlap,
    firstFreeArea,
    resolveAreas,
    createDocument,
    createRootNode,
    validateDoc,
    buildLiquid,
    buildViewParts,
    buildSettingsObject,
    buildSettingsYaml,
    buildRecipeFiles,
    buildPreviewContext
  };
});
