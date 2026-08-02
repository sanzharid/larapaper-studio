/**
 * Widget registry: single source of truth for palette, inspector schema,
 * node creation and Liquid (TRMNL design-system) markup generation.
 * UMD: usable from the renderer (preview + inspector) and Node tests.
 *
 * Node model: { id, type, props: {...}, children?: [node] }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./conditions'), require('./search-binding'));
  } else {
    root.LPWidgets = factory(root.LPConditions, root.LPSearch);
  }
})(typeof self !== 'undefined' ? self : this, function (Conditions, Search) {
  'use strict';

  let idCounter = 1;
  function nextId() { return 'w' + (idCounter++) + '_' + Math.random().toString(36).slice(2, 7); }

  /* ---------------- shared option lists ---------------- */
  const GAP_OPTIONS = [
    { v: 'none', l: 'None' }, { v: 'xsmall', l: 'XS (5px)' }, { v: 'small', l: 'S (7px)' },
    { v: 'medium', l: 'M (16px)' }, { v: 'large', l: 'L (20px)' }, { v: 'xlarge', l: 'XL (30px)' },
    { v: 'xxlarge', l: 'XXL (40px)' }
  ];
  const ALIGN_ITEMS = [
    { v: '', l: 'Default' }, { v: 'flex-start', l: 'Start' }, { v: 'center', l: 'Center' },
    { v: 'flex-end', l: 'End' }, { v: 'stretch', l: 'Stretch' }, { v: 'baseline', l: 'Baseline' }
  ];
  const JUSTIFY = [
    { v: '', l: 'Default' }, { v: 'flex-start', l: 'Start' }, { v: 'center', l: 'Center' },
    { v: 'flex-end', l: 'End' }, { v: 'space-between', l: 'Space between' },
    { v: 'space-around', l: 'Space around' }, { v: 'space-evenly', l: 'Space evenly' }
  ];
  const TEXT_ALIGN = [
    { v: '', l: 'Default' }, { v: 'left', l: 'Left' }, { v: 'center', l: 'Center' }, { v: 'right', l: 'Right' }
  ];
  const GRAYS = [
    { v: '', l: 'Black (default)' }, { v: '1', l: 'Gray 1' }, { v: '2', l: 'Gray 2' },
    { v: '3', l: 'Gray 3' }, { v: '4', l: 'Gray 4' }, { v: '5', l: 'Gray 5' }, { v: 'white', l: 'White' }
  ];
  const BIND_HINT = 'Liquid allowed, e.g. {{ data.temp }} or {{ config.api_key }}';
  const EXPR_HINT = 'Liquid expression, e.g. data.temp or items.first.value';

  /* Candidate props a text binding (or search binding) can target, in order. */
  const TEXT_PROPS = ['value', 'text', 'label', 'title', 'content'];

  /** First of TEXT_PROPS present in the widget's inspector schema. */
  function primaryTextProp(node) {
    if (!node || node.isRoot) return null;
    const schema = getSchema(node.type);
    for (const k of TEXT_PROPS) {
      if (schema.some((f) => f.key === k)) return k;
    }
    return null;
  }

  /* ---------------- schema field helpers ---------------- */
  function tf(key, label, hint, group) { return { key, label, type: 'text', hint: hint || BIND_HINT, group }; }
  function af(key, label, hint, rows, group) { return { key, label, type: 'textarea', hint: hint || BIND_HINT, rows: rows || 3, group }; }
  function nf(key, label, hint, group) { return { key, label, type: 'number', hint, group }; }
  function sf(key, label, options, hint, group) { return { key, label, type: 'select', options, hint, group }; }
  function cf(key, label, hint, group) { return { key, label, type: 'checkbox', hint, group }; }
  function colorf(key, label, hint, group) { return { key, label, type: 'color', hint, group }; }

  const ADVANCED_SCHEMA = [
    { key: 'extraClass', label: 'Extra CSS classes', type: 'text', hint: 'Appended to the element class list', group: 'Advanced' },
    { key: 'extraStyle', label: 'Extra inline style', type: 'text', hint: 'e.g. margin-top:4px;letter-spacing:1px', group: 'Advanced' }
  ];

  /** Inspector schema for the layout root node. */
  const ROOT_SCHEMA = [
    sf('gap', 'Gap', GAP_OPTIONS, 'Spacing between top-level widgets', 'Layout'),
    sf('align', 'Align items', [
      { v: 'flex-start', l: 'Start' }, { v: 'center', l: 'Center' },
      { v: 'flex-end', l: 'End' }, { v: 'stretch', l: 'Stretch' }, { v: 'baseline', l: 'Baseline' }
    ], null, 'Layout'),
    sf('justify', 'Justify content', [
      { v: 'flex-start', l: 'Start' }, { v: 'center', l: 'Center' }, { v: 'flex-end', l: 'End' },
      { v: 'space-between', l: 'Space between' }, { v: 'space-around', l: 'Space around' }, { v: 'space-evenly', l: 'Space evenly' }
    ], null, 'Layout')
  ].concat(ADVANCED_SCHEMA);

  /* ---------------- string / markup helpers ---------------- */
  function escAttr(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  /* When enabled (editor preview only), widget root elements carry data-wid. */
  let previewIds = false;
  function setPreviewIds(v) { previewIds = !!v; }
  function wid(node) { return previewIds ? ' data-wid="' + escAttr(node.id) + '"' : ''; }

  /** Builds class/style attribute string, merging advanced overrides. */
  function attrs(node, classes, styles) {
    const cls = (classes || []).filter(Boolean);
    const sty = (styles || []).filter(Boolean);
    const ec = node.props.extraClass && String(node.props.extraClass).trim();
    const es = node.props.extraStyle && String(node.props.extraStyle).trim();
    if (ec) cls.push(ec);
    if (es) sty.push(es.replace(/;+$/, ''));
    let out = wid(node);
    if (cls.length) out += ' class="' + escAttr(cls.join(' ')) + '"';
    if (sty.length) out += ' style="' + escAttr(sty.join(';')) + '"';
    return out;
  }

  function cssDim(v) {
    v = String(v).trim();
    return /^\d+(\.\d+)?$/.test(v) ? v + 'px' : v;
  }
  function dimStyles(props) {
    const s = [];
    if (props.width && String(props.width).trim() !== '') s.push('width:' + cssDim(props.width));
    if (props.height && String(props.height).trim() !== '') s.push('height:' + cssDim(props.height));
    return s;
  }

  /** Quote a raw string as a Liquid string literal. */
  function liquidQuote(s) {
    s = String(s);
    if (s.indexOf("'") === -1) return "'" + s + "'";
    if (s.indexOf('"') === -1) return '"' + s + '"';
    return "'" + s.replace(/'/g, "\\'") + "'";
  }

  /**
   * Normalize a user-typed value into a Liquid output expression.
   * Pass-through if it already contains Liquid; numbers and path-like input
   * become {{ path }}; anything else becomes a quoted string literal.
   */
  function asExpr(s) {
    s = String(s == null ? '' : s).trim();
    if (s === '') return "''";
    if (s.indexOf('{{') !== -1 || s.indexOf('{%') !== -1) return s;
    if (/^-?\d+(\.\d+)?$/.test(s)) return '{{ ' + s + ' }}';
    if (/^[a-zA-Z_][\w-]*(\.[\w-]+|\[[^\]]+])*$/.test(s)) return '{{ ' + s + ' }}';
    return '{{ ' + liquidQuote(s) + ' }}';
  }

  function textAlignCls(p) { return p.align ? 'text--' + p.align : ''; }
  function grayCls(p) { return p.gray ? (p.gray === 'white' ? 'text--white' : 'text--gray-' + p.gray) : ''; }
  function childrenLiquid(node, ctx) {
    return (node.children || []).map((c) => toLiquid(c, ctx)).join('\n');
  }


  /* ================= widget types ================= */
  const TYPES = {};

  function containerSchema(directionLabel) {
    return [
      sf('gap', 'Gap', GAP_OPTIONS, 'Space between children', 'Layout'),
      sf('align', 'Align items', ALIGN_ITEMS, 'Cross axis alignment', 'Layout'),
      sf('justify', 'Justify content', JUSTIFY, 'Main axis distribution', 'Layout'),
      tf('width', 'Width', 'px or %, e.g. 200 or 50%', 'Layout'),
      tf('height', 'Height', 'px or %, e.g. 120 or 100%', 'Layout'),
      cf('grow', 'Grow to fill', 'flex: 1 1 0 — take remaining ' + directionLabel + ' space', 'Layout')
    ];
  }

  function flexStyles(p) {
    const s = [];
    if (p.align) s.push('align-items:' + p.align);
    if (p.justify) s.push('justify-content:' + p.justify);
    if (p.grow) s.push('flex:1 1 0;min-height:0;min-width:0');
    return s.concat(dimStyles(p));
  }

  TYPES.col = {
    name: 'Column', icon: '▤', container: true,
    defaults: () => ({ gap: 'medium', align: '', justify: '', width: '', height: '', grow: false }),
    schema: containerSchema('vertical'),
    toLiquid(node, ctx) {
      const p = node.props;
      return '<div' + attrs(node, ['flex', 'flex--col', p.gap && p.gap !== 'none' ? 'gap--' + p.gap : ''], flexStyles(p)) +
        '>\n' + childrenLiquid(node, ctx) + '\n</div>';
    }
  };

  TYPES.row = {
    name: 'Row', icon: '▥', container: true,
    defaults: () => ({ gap: 'medium', align: '', justify: '', width: '', height: '', grow: false }),
    schema: containerSchema('horizontal'),
    toLiquid(node, ctx) {
      const p = node.props;
      return '<div' + attrs(node, ['flex', p.gap && p.gap !== 'none' ? 'gap--' + p.gap : ''], flexStyles(p)) +
        '>\n' + childrenLiquid(node, ctx) + '\n</div>';
    }
  };

  TYPES.grid = {
    name: 'Grid', icon: '▦', container: true,
    defaults: () => ({ cols: 2, gap: 'small', width: '', height: '' }),
    schema: [
      nf('cols', 'Columns', '1 – 6', 'Layout'),
      sf('gap', 'Gap', GAP_OPTIONS, null, 'Layout'),
      tf('width', 'Width', 'px or %', 'Layout'),
      tf('height', 'Height', 'px or %', 'Layout')
    ],
    toLiquid(node, ctx) {
      const p = node.props;
      const cols = Math.max(1, Math.min(6, parseInt(p.cols, 10) || 2));
      return '<div' + attrs(node,
        ['grid', 'grid--cols-' + cols, p.gap && p.gap !== 'none' ? 'gap--' + p.gap : ''],
        dimStyles(p)) + '>\n' + childrenLiquid(node, ctx) + '\n</div>';
    }
  };

  TYPES.spacer = {
    name: 'Spacer', icon: '⬍',
    defaults: () => ({ mode: 'vertical', size: 16 }),
    schema: [
      sf('mode', 'Mode', [
        { v: 'vertical', l: 'Vertical space' }, { v: 'horizontal', l: 'Horizontal space' },
        { v: 'grow', l: 'Flexible (pushes siblings apart)' }
      ], null, 'Layout'),
      nf('size', 'Size (px)', 'Used for vertical/horizontal modes', 'Layout')
    ],
    toLiquid(node) {
      const p = node.props;
      const n = Math.max(0, parseInt(p.size, 10) || 0);
      if (p.mode === 'grow') return '<div' + attrs(node, [], ['flex:1 1 auto']) + '></div>';
      if (p.mode === 'horizontal') return '<div' + attrs(node, [], ['width:' + n + 'px', 'flex:none', 'align-self:stretch']) + '></div>';
      return '<div' + attrs(node, [], ['height:' + n + 'px', 'flex:none', 'width:100%']) + '></div>';
    }
  };

  TYPES.divider = {
    name: 'Divider', icon: '—',
    defaults: () => ({ vertical: false, color: '#000000', size: 1 }),
    schema: [
      cf('vertical', 'Vertical', 'For use inside rows', 'Style'),
      colorf('color', 'Color', null, 'Style'),
      nf('size', 'Thickness (px)', null, 'Style')
    ],
    toLiquid(node) {
      const p = node.props;
      const n = Math.max(1, parseInt(p.size, 10) || 1);
      const styles = ['background:' + (p.color || '#000000')];
      if (p.vertical) styles.push('width:' + n + 'px', 'align-self:stretch');
      else styles.push('height:' + n + 'px', 'width:100%');
      return '<div' + attrs(node, ['divider', p.vertical ? 'divider--v' : ''], styles) + '></div>';
    }
  };


  TYPES.title = {
    name: 'Title', icon: 'T',
    defaults: () => ({ text: 'Title', size: '', align: '', gray: '' }),
    schema: [
      tf('text', 'Text', BIND_HINT, 'Content'),
      sf('size', 'Size', [
        { v: '', l: 'Default (26px)' }, { v: 'small', l: 'Small (16px)' }, { v: 'large', l: 'Large (30px)' },
        { v: 'xlarge', l: 'XL (35px)' }, { v: 'xxlarge', l: 'XXL (40px)' }
      ], null, 'Style'),
      sf('align', 'Align', TEXT_ALIGN, null, 'Style'),
      sf('gray', 'Color', GRAYS, null, 'Style')
    ],
    toLiquid(node) {
      const p = node.props;
      return '<span' + attrs(node, ['title', p.size ? 'title--' + p.size : '', textAlignCls(p), grayCls(p)], []) +
        '>' + (p.text || '') + '</span>';
    }
  };

  TYPES.label = {
    name: 'Label', icon: 't',
    defaults: () => ({ text: 'Label', size: '', align: '', gray: '3', underline: false, outline: false }),
    schema: [
      tf('text', 'Text', BIND_HINT, 'Content'),
      sf('size', 'Size', [
        { v: '', l: 'Default (15px)' }, { v: 'small', l: 'Small (12.5px)' }, { v: 'large', l: 'Large (18px)' }
      ], null, 'Style'),
      sf('align', 'Align', TEXT_ALIGN, null, 'Style'),
      sf('gray', 'Color', GRAYS, null, 'Style'),
      cf('underline', 'Underline', null, 'Style'),
      cf('outline', 'Outline (boxed)', null, 'Style')
    ],
    toLiquid(node) {
      const p = node.props;
      return '<span' + attrs(node, [
        'label', p.size ? 'label--' + p.size : '', textAlignCls(p), grayCls(p),
        p.underline ? 'label--underline' : '', p.outline ? 'label--outline' : ''
      ], []) + '>' + (p.text || '') + '</span>';
    }
  };

  TYPES.value = {
    name: 'Value', icon: '#',
    defaults: () => ({ value: '{{ value }}', size: '', unit: '', caption: '', align: '', gray: '' }),
    schema: [
      tf('value', 'Value', EXPR_HINT + ' — filters ok, e.g. data.temp | round: 1', 'Content'),
      tf('unit', 'Unit', 'Appended verbatim, e.g. °C or %', 'Content'),
      tf('caption', 'Caption', 'Small label below the value', 'Content'),
      sf('size', 'Size', [
        { v: '', l: 'Default (38px)' }, { v: 'xxsmall', l: 'XXS (16px)' }, { v: 'xsmall', l: 'XS (20px)' },
        { v: 'small', l: 'Small (26px)' }, { v: 'large', l: 'Large (58px)' }, { v: 'xlarge', l: 'XL (74px)' },
        { v: 'xxlarge', l: 'XXL (96px)' }, { v: 'xxxlarge', l: 'XXXL (116px)' }
      ], null, 'Style'),
      sf('align', 'Align', TEXT_ALIGN, null, 'Style'),
      sf('gray', 'Color', GRAYS, null, 'Style')
    ],
    toLiquid(node) {
      const p = node.props;
      const cls = ['value', p.size ? 'value--' + p.size : '', textAlignCls(p), grayCls(p)];
      const inner = asExpr(p.value || '0') + (p.unit || '');
      if (p.caption && String(p.caption).trim() !== '') {
        return '<div' + wid(node) + ' class="flex flex--col gap--xsmall' + (p.align ? ' items--' + p.align : '') + '">' +
          '<span class="' + escAttr(cls.filter(Boolean).join(' ')) + '">' + inner + '</span>' +
          '<span class="label label--small">' + p.caption + '</span></div>';
      }
      return '<span' + attrs(node, cls, []) + '>' + inner + '</span>';
    }
  };

  TYPES.text = {
    name: 'Text', icon: '¶',
    defaults: () => ({ content: 'Some longer text. Liquid works here too.', size: '', align: '', gray: '' }),
    schema: [
      af('content', 'Content', BIND_HINT, 4, 'Content'),
      sf('size', 'Size', [
        { v: '', l: 'Default (15px)' }, { v: 'small', l: 'Small (13px)' }, { v: 'large', l: 'Large (18px)' }
      ], null, 'Style'),
      sf('align', 'Align', TEXT_ALIGN, null, 'Style'),
      sf('gray', 'Color', GRAYS, null, 'Style')
    ],
    toLiquid(node) {
      const p = node.props;
      const styles = [];
      if (p.size === 'small') styles.push('font-size:13px');
      if (p.size === 'large') styles.push('font-size:18px');
      return '<p' + attrs(node, ['description', textAlignCls(p), grayCls(p)], styles) +
        '>' + (p.content || '') + '</p>';
    }
  };

  TYPES.richtext = {
    name: 'Rich text', icon: '❝',
    defaults: () => ({ html: '<b>Bold</b>, <i>italic</i> and <u>underline</u> markup.', align: '' }),
    schema: [
      af('html', 'HTML content', 'Raw HTML (b/i/u/p/br…) + Liquid allowed', 5, 'Content'),
      sf('align', 'Align', [
        { v: '', l: 'Left' }, { v: 'center', l: 'Center' }, { v: 'right', l: 'Right' }
      ], null, 'Style')
    ],
    toLiquid(node) {
      const p = node.props;
      return '<div' + attrs(node, ['richtext', p.align ? 'richtext--' + p.align : ''], []) +
        '><div class="content">' + (p.html || '') + '</div></div>';
    }
  };


  TYPES.image = {
    name: 'Image', icon: '🖼',
    defaults: () => ({
      src: 'https://placehold.co/120x120/png', width: '120', height: '120',
      fit: '', rounded: '', dither: true, pixelated: false, stroke: false
    }),
    schema: [
      tf('src', 'Image URL', EXPR_HINT + ' or a plain https:// URL', 'Content'),
      tf('width', 'Width', 'px or %', 'Layout'),
      tf('height', 'Height', 'px or %', 'Layout'),
      sf('fit', 'Object fit', [
        { v: '', l: 'None (natural size)' }, { v: 'cover', l: 'Cover (fill + crop)' }, { v: 'contain', l: 'Contain (fit inside)' }
      ], 'cover/contain need width and height', 'Style'),
      sf('rounded', 'Corners', [
        { v: '', l: 'Square' }, { v: 'rounded', l: 'Rounded (8px)' }, { v: 'rounded--full', l: 'Circle' }
      ], null, 'Style'),
      cf('dither', 'Dither (grayscale)', 'image-dither — recommended for e-ink', 'Style'),
      cf('pixelated', 'Pixelated scaling', null, 'Style'),
      cf('stroke', 'White outline', 'image-stroke — for dark backgrounds', 'Style')
    ],
    toLiquid(node) {
      const p = node.props;
      const styles = dimStyles(p);
      if (p.rounded === 'rounded--full' && (p.fit === 'cover' || p.fit === 'contain')) styles.push('overflow:hidden');
      return '<img src="' + escAttr(asExpr(p.src)) + '"' +
        attrs(node, [
          'image', p.fit ? 'image--' + p.fit : '', p.rounded || '',
          p.dither ? 'image-dither' : '', p.pixelated ? 'image--pixelated' : '', p.stroke ? 'image-stroke' : ''
        ], styles) + '>';
    }
  };

  TYPES.qr = {
    name: 'QR code', icon: '▦',
    defaults: () => ({ data: "'https://example.com'", size: 116, errorCorrection: 'M' }),
    schema: [
      tf('data', 'Content', EXPR_HINT + ', e.g. config.website_url', 'Content'),
      nf('size', 'Size (px)', 'Snapped to a multiple of 29 (QR module grid)', 'Layout'),
      sf('errorCorrection', 'Error correction', [
        { v: 'L', l: 'L — low (7%)' }, { v: 'M', l: 'M — medium (15%)' },
        { v: 'Q', l: 'Q — quartile (25%)' }, { v: 'H', l: 'H — high (30%)' }
      ], null, 'Style')
    ],
    toLiquid(node) {
      const p = node.props;
      const sizePx = Math.max(29, Math.round((parseInt(p.size, 10) || 116) / 29) * 29);
      const module = Math.max(1, Math.min(11, Math.round(sizePx / 29)));
      const expr = String(p.data || "'https://example.com'").trim();
      const ec = ['L', 'M', 'Q', 'H'].indexOf(p.errorCorrection) !== -1 ? p.errorCorrection : 'M';
      return '<div' + wid(node) + ' class="lp-qr" style="width:' + sizePx + 'px;height:' + sizePx + 'px">' +
        '{{ ' + bareExpr(expr) + ' | qr_code: ' + module + ", '" + ec + "' }}</div>";
    }
  };

  TYPES.progress = {
    name: 'Progress bar', icon: '▰',
    defaults: () => ({ label: 'Progress', value: 'percent', max: '100', size: '', showValue: true }),
    schema: [
      tf('label', 'Label', BIND_HINT, 'Content'),
      tf('value', 'Value', EXPR_HINT, 'Content'),
      tf('max', 'Max value', 'Number or expression, default 100', 'Content'),
      cf('showValue', 'Show value', 'Value label on the right', 'Content'),
      sf('size', 'Bar height', [
        { v: '', l: 'Default (24px)' }, { v: 'xsmall', l: 'XS (6px)' },
        { v: 'small', l: 'Small (12px)' }, { v: 'large', l: 'Large (32px)' }
      ], null, 'Style')
    ],
    toLiquid(node) {
      const p = node.props;
      const valExpr = bareExpr(p.value || '0');
      const maxExpr = bareExpr(p.max == null || p.max === '' ? '100' : p.max);
      const pct = '{{ ' + valExpr + ' | times: 100 | divided_by: ' + maxExpr + ' | round }}';
      let inner = '';
      if ((p.label && String(p.label).trim()) || p.showValue) {
        inner += '<div class="content">';
        if (p.label && String(p.label).trim()) inner += '<span class="label">' + p.label + '</span>';
        if (p.showValue) inner += '<span class="label">' + pct + '%</span>';
        inner += '</div>';
      }
      inner += '<div class="track"><div class="fill" style="width:' + pct + '%"></div></div>';
      return '<div' + attrs(node, ['progress-bar', p.size ? 'progress-bar--' + p.size : ''], []) + '>' + inner + '</div>';
    }
  };

  TYPES.item = {
    name: 'Item', icon: '▸',
    defaults: () => ({ title: '{{ item.label }}', description: '{{ item.value }}', meta: true }),
    schema: [
      tf('title', 'Title', BIND_HINT, 'Content'),
      tf('description', 'Description', BIND_HINT + ' — may be empty', 'Content'),
      cf('meta', 'Meta bar', 'Gray bar on the left edge', 'Style')
    ],
    toLiquid(node) {
      const p = node.props;
      let inner = '';
      if (p.meta) inner += '<div class="meta"></div>';
      inner += '<div class="content"><span class="title">' + (p.title || '') + '</span>';
      if (p.description && String(p.description).trim() !== '') {
        inner += '<span class="description">' + p.description + '</span>';
      }
      inner += '</div>';
      return '<div' + attrs(node, ['item'], []) + '>' + inner + '</div>';
    }
  };


  TYPES.list = {
    name: 'List (repeater)', icon: '☰', container: true, maxChildren: 1,
    defaults: () => ({ collection: 'items', limit: 0 }),
    schema: [
      tf('collection', 'Collection', 'Liquid array path, e.g. data.items or items', 'Data'),
      nf('limit', 'Max items', '0 = no limit', 'Data')
    ],
    createChildren() {
      const item = createNode('item');
      item.props.title = '{{ item.label }}';
      item.props.description = '{{ item.value }}';
      return [item];
    },
    toLiquid(node, ctx) {
      const p = node.props;
      const coll = String(p.collection || 'items').trim();
      const limit = parseInt(p.limit, 10);
      const child = (node.children || [])[0];
      const inner = child ? toLiquid(child, ctx) : '<!-- drop one widget here as the row template -->';
      return '<div' + attrs(node, ['list'], []) + '>\n' +
        '{% for item in ' + coll + (limit > 0 ? ' limit:' + limit : '') + ' %}\n' + inner + '\n{% endfor %}\n</div>';
    }
  };

  function parseColumns(raw) {
    const out = [];
    for (const line of String(raw || '').split(/\r?\n|,/)) {
      const t = line.trim();
      if (!t) continue;
      const ci = t.indexOf(':');
      if (ci === -1) out.push({ label: t, key: t });
      else out.push({ label: t.slice(0, ci).trim() || t.slice(ci + 1).trim(), key: t.slice(ci + 1).trim() });
    }
    return out.length ? out : [{ label: 'Value', key: 'value' }];
  }

  TYPES.table = {
    name: 'Table', icon: '⊞',
    defaults: () => ({ collection: 'rows', columns: 'Name:name\nValue:value', limit: 0, size: '', showHeader: true }),
    schema: [
      tf('collection', 'Collection', 'Liquid array path, e.g. data.rows or rows', 'Data'),
      af('columns', 'Columns', 'One per line: Label:item.key', 3, 'Data'),
      nf('limit', 'Max rows', '0 = no limit', 'Data'),
      sf('size', 'Density', [
        { v: '', l: 'Default' }, { v: 'small', l: 'Small' }, { v: 'condensed', l: 'Condensed' }
      ], null, 'Style'),
      cf('showHeader', 'Show header row', null, 'Style')
    ],
    toLiquid(node) {
      const p = node.props;
      const coll = String(p.collection || 'rows').trim();
      const limit = parseInt(p.limit, 10);
      const cols = parseColumns(p.columns);
      let html = '<table' + attrs(node, ['table', p.size ? 'table--' + p.size : ''], []) + '>';
      if (p.showHeader) {
        html += '\n<thead><tr>' + cols.map((c) => '<th>' + c.label + '</th>').join('') + '</tr></thead>';
      }
      html += '\n<tbody>\n{% for item in ' + coll + (limit > 0 ? ' limit:' + limit : '') + ' %}\n<tr>' +
        cols.map((c) => '<td>{{ item.' + c.key + ' }}</td>').join('') + '</tr>\n{% endfor %}\n</tbody>\n</table>';
      return html;
    }
  };

  TYPES.barchart = {
    name: 'Bar chart', icon: '📊',
    defaults: () => ({
      collection: 'items', valueKey: 'value', labelKey: 'label', max: '100',
      height: 140, limit: 6, showValues: true, showLabels: true, barColor: '#000000'
    }),
    schema: [
      tf('collection', 'Collection', 'Liquid array path, e.g. data.items or items', 'Data'),
      tf('valueKey', 'Value key', 'Key on each item holding the number', 'Data'),
      tf('labelKey', 'Label key', null, 'Data'),
      tf('max', 'Max value', 'Number or expression — bar at 100% height', 'Data'),
      nf('height', 'Chart height (px)', null, 'Layout'),
      nf('limit', 'Max bars', '0 = no limit', 'Data'),
      cf('showValues', 'Show values', null, 'Style'),
      cf('showLabels', 'Show labels', null, 'Style'),
      colorf('barColor', 'Bar color', null, 'Style')
    ],
    toLiquid(node) {
      const p = node.props;
      const coll = String(p.collection || 'items').trim();
      const limit = parseInt(p.limit, 10);
      const h = parseInt(p.height, 10) || 140;
      const vk = String(p.valueKey || 'value').trim();
      const lk = String(p.labelKey || 'label').trim();
      const maxExpr = bareExpr(p.max == null || p.max === '' ? '100' : p.max);
      const color = p.barColor || '#000000';
      let cell = '<div class="flex flex--col" style="flex:1 1 0;height:100%;justify-content:flex-end;align-items:center;min-width:0;gap:2px">';
      if (p.showValues) cell += '<span class="label label--small">{{ item.' + vk + ' }}</span>';
      cell += '<div style="width:100%;background:' + escAttr(color) + ';height:{{ item.' + vk + ' | times: 100 | divided_by: ' + maxExpr + ' | round }}%"></div>';
      if (p.showLabels) cell += '<span class="label label--small" style="max-width:100%;overflow:hidden;white-space:nowrap">{{ item.' + lk + ' }}</span>';
      cell += '</div>';
      return '<div' + attrs(node, ['flex', 'gap--small'], ['align-items:flex-end', 'width:100%', 'height:' + h + 'px']) +
        '>\n{% for item in ' + coll + (limit > 0 ? ' limit:' + limit : '') + ' %}\n' + cell + '\n{% endfor %}\n</div>';
    }
  };

  TYPES.title_bar = {
    name: 'Title bar', icon: '▭',
    defaults: () => ({
      title: '{{ trmnl.plugin_settings.instance_name }}',
      image: '', instance: ''
    }),
    schema: [
      tf('title', 'Title', BIND_HINT, 'Content'),
      tf('image', 'Icon URL', 'Optional small icon (https:// or expression)', 'Content'),
      tf('instance', 'Instance text', 'Right-aligned, e.g. {{ trmnl.device.friendly_id }}', 'Content')
    ],
    toLiquid(node) {
      const p = node.props;
      let inner = '';
      if (p.image && String(p.image).trim() !== '') {
        inner += '<img class="image" src="' + escAttr(asExpr(p.image)) + '">';
      }
      inner += '<span class="title">' + (p.title || '') + '</span>';
      if (p.instance && String(p.instance).trim() !== '') {
        inner += '<span class="label instance">' + p.instance + '</span>';
      }
      return '<div' + attrs(node, ['title_bar'], []) + '>' + inner + '</div>';
    }
  };


  /* ---------------- bare expression helper ---------------- */

  /**
   * Like asExpr but returns the expression WITHOUT the {{ }} wrapper,
   * for embedding in tags/filters. A single existing {{ x }} is unwrapped.
   */
  function bareExpr(s) {
    s = String(s == null ? '' : s).trim();
    if (s === '') return "''";
    const single = s.match(/^\{\{([\s\S]*)\}\}$/);
    if (single) return single[1].trim();
    if (s.indexOf('{{') !== -1 || s.indexOf('{%') !== -1) return liquidQuote(s);
    if (/^-?\d+(\.\d+)?$/.test(s)) return s;
    if (/^[a-zA-Z_][\w-]*(\.[\w-]+|\[[^\]]+])*$/.test(s)) return s;
    return liquidQuote(s);
  }

  /* ---------------- palette & public API ---------------- */

  const PALETTE = [
    { category: 'Layout', types: ['col', 'row', 'grid', 'spacer', 'divider'] },
    { category: 'Text', types: ['title', 'label', 'value', 'text', 'richtext', 'title_bar'] },
    { category: 'Media', types: ['image', 'qr'] },
    { category: 'Data', types: ['progress', 'item', 'list', 'table', 'barchart'] }
  ];

  function createNode(type) {
    const d = TYPES[type];
    if (!d) throw new Error('Unknown widget type: ' + type);
    const node = { id: nextId(), type, props: d.defaults() };
    if (d.container) node.children = d.createChildren ? d.createChildren() : [];
    return node;
  }

  function isContainer(type) { return !!(TYPES[type] && TYPES[type].container); }
  function maxChildren(type) { return TYPES[type] && TYPES[type].maxChildren ? TYPES[type].maxChildren : Infinity; }
  function getSchema(type) {
    const d = TYPES[type];
    return d ? d.schema.concat(ADVANCED_SCHEMA) : [];
  }
  function toLiquid(node, ctx) {
    const d = TYPES[node.type];
    if (!d) return '<!-- unknown widget: ' + escAttr(node.type) + ' -->';
    /* a valid enabled props.search OVERRIDES its target prop with generated
       standard-Liquid that picks display text by query (search-binding.js) —
       the binding wins over any liquid already typed into that prop */
    let eff = node;
    const sb = node.props && node.props.search;
    if (sb && sb.enabled && Search.isValid(sb)) {
      const target = String(sb.targetProp || '').trim() || primaryTextProp(node);
      const picked = target ? Search.generate(sb, ctx && ctx.sampleData) : '';
      if (picked) {
        eff = Object.assign({}, node, { props: Object.assign({}, node.props) });
        eff.props[target] = picked;
      }
    }
    /* a valid enabled props.condition wraps the widget (incl. its whole
       subtree) in a standard-Liquid guard — see shared/conditions.js */
    return Conditions.wrapLiquid(eff, d.toLiquid(eff, ctx || {}), ctx && ctx.sampleData);
  }

  /** Deep clone with fresh ids (duplicate / copy between layouts). */
  function cloneWithNewIds(node) {
    const copy = {
      id: node.isRoot ? node.id : nextId(),
      type: node.type,
      props: JSON.parse(JSON.stringify(node.props || {}))
    };
    if (node.isRoot) {
      copy.isRoot = true;
      if (node.grid) copy.grid = Object.assign({}, node.grid);
    }
    if (node.area) copy.area = Object.assign({}, node.area);
    if (node.children) copy.children = node.children.map(cloneWithNewIds);
    return copy;
  }

  return {
    TYPES,
    PALETTE,
    ROOT_SCHEMA,
    GAP_OPTIONS,
    TEXT_PROPS,
    primaryTextProp,
    createNode,
    isContainer,
    maxChildren,
    getSchema,
    toLiquid,
    cloneWithNewIds,
    setPreviewIds,
    asExpr,
    bareExpr,
    escAttr,
    _nextId: nextId
  };
});

