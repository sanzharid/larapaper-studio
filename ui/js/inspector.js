/* Larapaper Studio — properties panel (schema-driven). */
window.LPInspector = (function () {
  let panelEl = null;
  let lastEditAt = 0;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fieldHtml(f, value) {
    const v = value === undefined || value === null ? '' : value;
    let control = '';
    if (f.type === 'textarea') {
      control = '<textarea data-key="' + f.key + '" rows="' + (f.rows || 3) + '">' + esc(v) + '</textarea>';
    } else if (f.type === 'select') {
      control = '<select data-key="' + f.key + '">' +
        (f.options || []).map((o) => '<option value="' + esc(o.v) + '"' + (String(v) === String(o.v) ? ' selected' : '') + '>' + esc(o.l) + '</option>').join('') +
        '</select>';
    } else if (f.type === 'checkbox') {
      return '<div class="check-field"><input type="checkbox" id="pf-' + f.key + '" data-key="' + f.key + '"' + (v ? ' checked' : '') + '>' +
        '<label for="pf-' + f.key + '">' + esc(f.label) + '</label></div>' +
        (f.hint ? '<div class="field-help" style="margin:-8px 0 12px 24px">' + esc(f.hint) + '</div>' : '');
    } else if (f.type === 'color') {
      control = '<input type="color" data-key="' + f.key + '" value="' + esc(v || '#000000') + '" style="width:100%;height:28px;border:1px solid var(--border);border-radius:6px;background:var(--bg-2);padding:2px">';
    } else {
      control = '<input type="' + (f.type === 'number' ? 'number' : 'text') + '" data-key="' + f.key + '" value="' + esc(v) + '">';
    }
    return '<div class="field"><label>' + esc(f.label) + '</label>' + control +
      (f.hint ? '<div class="field-help">' + esc(f.hint) + '</div>' : '') + '</div>';
  }

  function render() {
    const node = LPState.getSelectedNode();
    const isRootSel = LPState.getSelectedId() === 'root';
    if (!node && !isRootSel) {
      panelEl.innerHTML = '<div class="insp-empty">Select a widget on the canvas to edit its properties.<br><br>' +
        'Click the empty screen area to edit the <b>layout root</b> (alignment &amp; gap).</div>';
      return;
    }

    let title, sub, schema, props, targetId, actions = '';
    if (isRootSel) {
      const root = LPState.getRoot();
      title = 'Layout root';
      sub = 'Top-level column container · ' + LPState.getLayout();
      schema = LPWidgets.ROOT_SCHEMA;
      props = root.props;
      targetId = 'root';
    } else {
      const def = LPWidgets.TYPES[node.type];
      title = def ? def.name : node.type;
      sub = node.type + ' · ' + node.id;
      schema = LPWidgets.getSchema(node.type);
      props = node.props;
      targetId = node.id;
      actions = '<div style="display:flex;gap:6px;margin-bottom:12px">' +
        '<button class="btn small" data-act="dup">Duplicate</button>' +
        '<button class="btn small danger" data-act="del">Delete</button></div>';
      if (node.type === 'list') {
        actions += '<div class="field-help" style="margin-bottom:12px">The single child of a list is the <b>row template</b> — it repeats for every collection item.' +
          (node.children && node.children[0] ? ' <a href="#" data-act="selchild" style="color:var(--accent)">Select row template →</a>' : '') + '</div>';
      }
    }

    let html = '<h3 class="insp-title">' + esc(title) + '</h3><p class="insp-sub">' + esc(sub) + '</p>' + actions;
    if (!isRootSel) {
      const area = rootChildArea(node);
      if (area) html += gridAreaHtml(area);
    }
    const plain = schema.filter((f) => !f.group);
    const groups = {};
    schema.filter((f) => f.group).forEach((f) => { (groups[f.group] = groups[f.group] || []).push(f); });
    html += plain.map((f) => fieldHtml(f, props[f.key])).join('');
    for (const g of Object.keys(groups)) {
      html += '<div class="section-title">' + esc(g) + '</div>' + groups[g].map((f) => fieldHtml(f, props[f.key])).join('');
    }
    if (!isRootSel) html += conditionHtml(node) + searchHtml(node);
    panelEl.innerHTML = html;
    panelEl.dataset.target = targetId;
  }

  function onInput(e) {
    const key = e.target && e.target.dataset ? e.target.dataset.key : null;
    if (!key) return;
    const targetId = panelEl.dataset.target;
    if (!targetId) return;
    let value;
    if (e.target.type === 'checkbox') value = e.target.checked;
    else if (e.target.type === 'number') value = e.target.value === '' ? '' : parseFloat(e.target.value);
    else value = e.target.value;
    lastEditAt = Date.now();
    LPState.updateProps(targetId, { [key]: value }, 'insp:' + targetId + ':' + key);
  }

  function onClick(e) {
    const act = e.target.dataset ? e.target.dataset.act : null;
    if (!act) return;
    e.preventDefault();
    const targetId = panelEl.dataset.target;
    if (act === 'del') LPState.removeNode(targetId);
    else if (act === 'dup') LPState.duplicateNode(targetId);
    else if (act === 'selchild') {
      const node = LPState.getSelectedNode();
      if (node && node.children && node.children[0]) LPState.select(node.children[0].id);
    }
  }

  /* ================= widget conditions (LPConditions) ================= */

  const COND_OPS = [
    { v: 'mentions', l: 'mentions (text search)' },
    { v: 'not_mentions', l: "doesn't mention" },
    { v: 'equals', l: 'equals' },
    { v: 'not_equals', l: 'not equals' },
    { v: 'present', l: 'is present' },
    { v: 'blank', l: 'is blank' }
  ];

  /** Sample-data leaf paths as liquid paths, for the path input's datalist. */
  function condPathSuggestions() {
    const sd = LPState.getDoc().staticData;
    if (!sd || typeof sd !== 'object') return [];
    return LPSources.jsonPaths(sd).map((p) => (p.charAt(0) === '[' ? 'data' + p : 'data.' + p));
  }

  function conditionHtml(node) {
    const c = (node.props && node.props.condition) || {};
    const enabled = !!c.enabled;
    const op = c.op || 'mentions';
    const sd = LPState.getDoc().staticData || {};
    const isMention = op === 'mentions' || op === 'not_mentions';
    let html = '<details class="cond-section"' + (enabled ? ' open' : '') + '>' +
      '<summary class="section-title">Condition</summary>' +
      '<div class="check-field"><input type="checkbox" id="cond-enabled" data-cond="enabled"' + (enabled ? ' checked' : '') + '>' +
      '<label for="cond-enabled">Show this widget only when…</label></div>';
    if (enabled) {
      html += '<div class="field"><label>Operator</label><select data-cond="op">' +
        COND_OPS.map((o) => '<option value="' + o.v + '"' + (op === o.v ? ' selected' : '') + '>' + esc(o.l) + '</option>').join('') +
        '</select></div>';
      html += '<div class="field"><label>Data path</label>' +
        '<input type="text" data-cond="path" list="cond-path-list" spellcheck="false" placeholder="data.disruptions" value="' + esc(c.path || '') + '">' +
        '<datalist id="cond-path-list">' +
        condPathSuggestions().map((p) => '<option value="' + esc(p) + '">').join('') +
        '</datalist></div>';
      if (op !== 'present' && op !== 'blank') {
        html += '<div class="field"><label>' + (isMention ? 'Search text' : 'Compare to') + '</label>' +
          '<input type="text" data-cond="value" value="' + esc(c.value == null ? '' : c.value) + '"></div>';
      }
      if (isMention) {
        const fields = LPConditions.arrayItemFields(sd, c.path);
        if (fields.length) {
          const sel = Array.isArray(c.fields) ? c.fields : fields;
          html += '<div class="field"><label>Search fields</label>' +
            fields.map((f) =>
              '<div class="check-field" style="margin-bottom:4px">' +
              '<input type="checkbox" id="condf-' + esc(f) + '" data-cond-field="' + esc(f) + '"' +
              (sel.indexOf(f) !== -1 ? ' checked' : '') + '>' +
              '<label for="condf-' + esc(f) + '">' + esc(f) + '</label></div>').join('') +
            '<div class="field-help">Item fields searched at that path (detected from sample data). Uncheck all to search the whole item.</div></div>';
        } else if (c.path && String(c.path).trim()) {
          html += '<div class="field-help" style="margin-bottom:12px">Path is not an array in the sample data — its value itself is searched.</div>';
        }
      }
      const sum = LPConditions.conditionSummary(c);
      if (sum) html += '<div class="field-help" style="margin-bottom:12px">➜ ' + esc(sum) + '</div>';
    }
    return html + '</details>';
  }

  function onCondInput(e) {
    const d = e.target && e.target.dataset ? e.target.dataset : null;
    if (!d) return;
    const isField = d.condField !== undefined;
    const key = d.cond;
    if (!isField && !key) return;
    const targetId = panelEl.dataset.target;
    if (!targetId || targetId === 'root') return;
    const node = LPState.findNode(targetId);
    if (!node) return;
    const cur = Object.assign({ enabled: false, op: 'mentions', path: '', value: '' }, node.props.condition);
    if (isField) {
      const boxes = panelEl.querySelectorAll('[data-cond-field]');
      cur.fields = Array.prototype.filter.call(boxes, (b) => b.checked)
        .map((b) => b.getAttribute('data-cond-field'));
    } else if (key === 'enabled') {
      cur.enabled = e.target.checked;
    } else if (key === 'op') {
      cur.op = e.target.value;
    } else if (key === 'path') {
      cur.path = e.target.value;
      /* default the search fields to everything detected at the new path */
      if (!Array.isArray(cur.fields)) {
        cur.fields = LPConditions.arrayItemFields(LPState.getDoc().staticData || {}, cur.path);
      }
    } else if (key === 'value') {
      cur.value = e.target.value;
    }
    lastEditAt = Date.now();
    LPState.updateProps(targetId, { condition: cur }, 'cond:' + targetId + ':' + (isField ? 'fields' : key));
    /* structural changes re-render immediately (the doc-event guard would
       skip it while focus is inside the panel) */
    if (e.type === 'change' && key !== 'value') render();
  }

  /* ================= search bindings (LPSearch) ================= */

  const SBIND_MODES = [
    { v: 'begins', l: 'begins with' },
    { v: 'contains', l: 'contains' },
    { v: 'equals', l: 'equals (exact)' }
  ];

  /** Live match picker rows (radios), computed from the sample data. */
  function pickerHtml(spec, sd) {
    const res = LPSearch.evaluate(spec, sd);
    const pick = spec.pick === undefined || spec.pick === null ? 1 : parseInt(spec.pick, 10);
    let inner;
    if (!res.count) {
      inner = '<div class="field-help">No matches' +
        (spec.query ? ' for &quot;' + esc(spec.query) + '&quot;' : '') + '.</div>';
    } else {
      const radio = (value, checked, labelHtml) =>
        '<div class="check-field" style="margin-bottom:4px">' +
        '<input type="radio" name="sbind-pick" id="sbind-pick-' + value + '" data-sbind-pick="' + value + '"' + (checked ? ' checked' : '') + '>' +
        '<label for="sbind-pick-' + value + '">' + labelHtml + '</label></div>';
      inner = res.matches.slice(0, 20).map((m, i) => {
        const label = String(m).length > 60 ? String(m).slice(0, 57) + '…' : String(m);
        return radio(i + 1, pick === i + 1, String.fromCharCode(0x2460 + i) + ' ' + esc(label));
      }).join('');
      if (res.count > 20) inner += '<div class="field-help">…and ' + (res.count - 20) + ' more (pick by number in the spec).</div>';
      inner += radio(0, pick === 0, 'All (joined with &quot;, &quot;)');
      inner += radio(-1, pick === -1, 'Last');
    }
    const shown = LPSearch.picked(spec, sd);
    return '<div class="field sbind-picker"><label>' + res.count + ' match' + (res.count === 1 ? '' : 'es') +
      (spec.query ? ' for &quot;' + esc(spec.query) + '&quot;' : '') + '</label>' + inner +
      (res.count ? '<div class="field-help">Now shows: &quot;' + esc(shown.length > 80 ? shown.slice(0, 77) + '…' : shown) + '&quot;</div>' : '') +
      '</div>';
  }

  /** Replace only the picker (keeps focus while typing in the query input). */
  function refreshPicker(spec) {
    const box = panelEl.querySelector('.sbind-picker');
    if (!box) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = pickerHtml(spec, LPState.getDoc().staticData || {});
    box.replaceWith(tmp.firstElementChild);
  }

  function searchHtml(node) {
    const textProps = LPWidgets.getSchema(node.type)
      .filter((f) => LPWidgets.TEXT_PROPS.indexOf(f.key) !== -1)
      .map((f) => f.key);
    if (!textProps.length) return '';
    const s = (node.props && node.props.search) || {};
    const enabled = !!s.enabled;
    const sd = LPState.getDoc().staticData || {};
    let html = '<details class="cond-section sbind-section"' + (enabled ? ' open' : '') + '>' +
      '<summary class="section-title">Search binding</summary>' +
      '<div class="check-field"><input type="checkbox" id="sbind-enabled" data-sbind="enabled"' + (enabled ? ' checked' : '') + '>' +
      '<label for="sbind-enabled">Pick text from API data by search</label></div>';
    if (enabled) {
      const target = String(s.targetProp || '').trim() || textProps[0];
      if (textProps.length > 1) {
        html += '<div class="field"><label>Target prop</label><select data-sbind="targetProp">' +
          textProps.map((k) => '<option value="' + esc(k) + '"' + (target === k ? ' selected' : '') + '>' + esc(k) + '</option>').join('') +
          '</select><div class="field-help">The generated search liquid overrides this prop\'s value.</div></div>';
      }
      html += '<div class="field"><label>Array path</label>' +
        '<input type="text" data-sbind="path" list="sbind-path-list" spellcheck="false" placeholder="data.disruptions" value="' + esc(s.path || '') + '">' +
        '<datalist id="sbind-path-list">' +
        condPathSuggestions().map((p) => '<option value="' + esc(p) + '">').join('') +
        '</datalist></div>';
      const fields = LPConditions.arrayItemFields(sd, s.path);
      if (fields.length) {
        const sel = Array.isArray(s.fields) ? s.fields : fields;
        html += '<div class="field"><label>Search fields</label>' +
          fields.map((f) =>
            '<div class="check-field" style="margin-bottom:4px">' +
            '<input type="checkbox" id="sbindf-' + esc(f) + '" data-sbind-field="' + esc(f) + '"' +
            (sel.indexOf(f) !== -1 ? ' checked' : '') + '>' +
            '<label for="sbindf-' + esc(f) + '">' + esc(f) + '</label></div>').join('') +
          '<div class="field-help">Item fields searched at that path (detected from sample data).</div></div>';
        const display = String(s.display || '').trim() || sel[0] || fields[0];
        const dOpts = fields.indexOf(display) === -1 ? [display].concat(fields) : fields;
        html += '<div class="field"><label>Display field</label><select data-sbind="display">' +
          dOpts.map((f) => '<option value="' + esc(f) + '"' + (display === f ? ' selected' : '') + '>' + esc(f) + '</option>').join('') +
          '</select></div>';
      } else if (s.path && String(s.path).trim()) {
        html += '<div class="field-help" style="margin-bottom:12px">Path is not an array in the sample data — the whole item is searched.</div>';
      }
      const mode = LPSearch.MATCH_MODES.indexOf(s.match) !== -1 ? s.match : 'contains';
      html += '<div class="field"><label>Match mode</label><select data-sbind="match">' +
        SBIND_MODES.map((o) => '<option value="' + o.v + '"' + (mode === o.v ? ' selected' : '') + '>' + esc(o.l) + '</option>').join('') +
        '</select></div>';
      html += '<div class="field"><label>Search query</label>' +
        '<input type="text" data-sbind="query" placeholder="metro 52" value="' + esc(s.query == null ? '' : s.query) + '"></div>';
      html += pickerHtml(s, sd);
      const sum = LPSearch.summary(s);
      if (sum) html += '<div class="field-help" style="margin-bottom:12px">➜ ' + esc(sum) + '</div>';
    }
    return html + '</details>';
  }

  function onSbindInput(e) {
    const d = e.target && e.target.dataset ? e.target.dataset : null;
    if (!d) return;
    const isField = d.sbindField !== undefined;
    const isPick = d.sbindPick !== undefined;
    const key = d.sbind;
    if (!isField && !isPick && !key) return;
    const targetId = panelEl.dataset.target;
    if (!targetId || targetId === 'root') return;
    const node = LPState.findNode(targetId);
    if (!node) return;
    const cur = Object.assign({
      enabled: false, targetProp: LPWidgets.primaryTextProp(node) || 'text',
      path: '', fields: null, match: 'contains', query: '', display: '', pick: 1
    }, node.props.search);
    if (isField) {
      const boxes = panelEl.querySelectorAll('[data-sbind-field]');
      cur.fields = Array.prototype.filter.call(boxes, (b) => b.checked)
        .map((b) => b.getAttribute('data-sbind-field'));
    } else if (isPick) {
      cur.pick = parseInt(d.sbindPick, 10);
    } else if (key === 'enabled') {
      cur.enabled = e.target.checked;
    } else if (key === 'targetProp') {
      cur.targetProp = e.target.value;
    } else if (key === 'match') {
      cur.match = e.target.value;
    } else if (key === 'display') {
      cur.display = e.target.value;
    } else if (key === 'query') {
      cur.query = e.target.value;
    } else if (key === 'path') {
      cur.path = e.target.value;
      /* default the search/display fields to everything detected at the new path */
      if (!Array.isArray(cur.fields)) {
        cur.fields = LPConditions.arrayItemFields(LPState.getDoc().staticData || {}, cur.path);
        cur.display = String(cur.display || '').trim() || cur.fields[0] || '';
      }
    }
    lastEditAt = Date.now();
    LPState.updateProps(targetId, { search: cur },
      'sbind:' + targetId + ':' + (isField ? 'fields' : isPick ? 'pick' : key));
    /* query typing updates only the picker (keeps focus); structural changes
       re-render the section (the doc-event guard would skip it while typing) */
    if (key === 'query' && e.type === 'input') refreshPicker(cur);
    else if (e.type === 'change') render();
  }



  function rootChildArea(node) {
    const parent = LPState.findParent(node.id);
    if (!parent || !parent.isRoot) return null;
    const root = LPState.getRoot();
    const grid = LPRecipe.normalizeGrid(root.grid, LPState.getLayout());
    const resolved = LPRecipe.resolveAreas(root, grid).find((r) => r.node.id === node.id);
    return resolved ? resolved.area : null;
  }

  function gridAreaHtml(area) {
    const f = (key, label, v) =>
      '<div class="field"><label>' + label + '</label>' +
      '<input type="number" min="0" data-area="' + key + '" value="' + esc(v) + '"></div>';
    return '<div class="section-title">Grid area</div>' +
      '<div class="field-row">' + f('x', 'X (col)', area.x) + f('y', 'Y (row)', area.y) + '</div>' +
      '<div class="field-row">' + f('w', 'W (cells)', area.w) + f('h', 'H (cells)', area.h) + '</div>';
  }

  function onAreaInput(e) {
    const key = e.target && e.target.dataset ? e.target.dataset.area : null;
    if (!key) return;
    const targetId = panelEl.dataset.target;
    const node = LPState.findNode(targetId);
    if (!node) return;
    const area = rootChildArea(node);
    if (!area) return;
    lastEditAt = Date.now();
    const patch = Object.assign({}, area);
    patch[key] = e.target.value === '' ? area[key] : parseInt(e.target.value, 10);
    LPState.setNodeArea(targetId, patch, 'area:' + targetId);
  }

  function init() {
    panelEl = document.getElementById('panel-properties');
    panelEl.addEventListener('input', onInput);
    panelEl.addEventListener('change', onInput);
    panelEl.addEventListener('input', onAreaInput);
    panelEl.addEventListener('change', onAreaInput);
    panelEl.addEventListener('input', onCondInput);
    panelEl.addEventListener('change', onCondInput);
    panelEl.addEventListener('input', onSbindInput);
    panelEl.addEventListener('change', onSbindInput);
    panelEl.addEventListener('click', onClick);
    LPState.on('selection', render);
    LPState.on('doc', () => {
      /* don't steal focus while the user is typing in this panel */
      const typingInside = panelEl.contains(document.activeElement) && Date.now() - lastEditAt < 600;
      if (!typingInside) render();
    });
    render();
  }

  return { init, render };
})();
