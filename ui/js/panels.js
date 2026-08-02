/* Larapaper Studio — Data & Config panel + Recipe settings panel. */
window.LPPanels = (function () {
  let dataEl, recipeEl;
  let lastEditAt = 0;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function optionsToText(options) {
    return (options || []).map((o) => (o.label === o.value ? String(o.value) : String(o.label) + ':' + String(o.value))).join('\n');
  }
  function textToOptions(text) {
    const out = [];
    for (const line of String(text || '').split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      const ci = t.indexOf(':');
      if (ci === -1) out.push({ label: t, value: t });
      else out.push({ label: t.slice(0, ci).trim(), value: t.slice(ci + 1).trim() });
    }
    return out;
  }

  /* ================= Data & Config ================= */

  function cfItemHtml(f, i) {
    const typeOpts = LPRecipe.FIELD_TYPES.map((t) =>
      '<option value="' + t + '"' + (f.fieldType === t ? ' selected' : '') + '>' + t + '</option>').join('');
    let html = '<div class="cf-item" data-idx="' + i + '">' +
      '<div class="cf-head"><span class="cf-key">config.' + esc(f.keyname || '…') + '</span>' +
      '<button class="btn small danger" data-cf-del="' + i + '">Delete</button></div>' +
      '<div class="field-row">' +
      '<div class="field"><label>Keyname (snake_case)</label><input type="text" data-cf-key="keyname" value="' + esc(f.keyname) + '"></div>' +
      '<div class="field"><label>Display name</label><input type="text" data-cf-key="name" value="' + esc(f.name) + '"></div>' +
      '</div>' +
      '<div class="field-row">' +
      '<div class="field"><label>Type</label><select data-cf-key="fieldType">' + typeOpts + '</select></div>' +
      '<div class="field"><label>Default value</label><input type="text" data-cf-key="default" value="' + esc(f.default) + '"></div>' +
      '</div>';
    if (f.fieldType === 'select') {
      html += '<div class="field"><label>Options</label><textarea rows="3" data-cf-key="options">' + esc(optionsToText(f.options)) + '</textarea>' +
        '<div class="field-help">One per line: Label:value (or just value)</div></div>';
    }
    html += '<div class="field-row">' +
      '<div class="field"><label>Placeholder</label><input type="text" data-cf-key="placeholder" value="' + esc(f.placeholder) + '"></div>' +
      '</div>' +
      '<div class="field"><label>Description</label><input type="text" data-cf-key="description" value="' + esc(f.description) + '"></div>' +
      '</div>';
    return html;
  }

  function renderData() {
    const doc = LPState.getDoc();
    let jsonText;
    try { jsonText = JSON.stringify(doc.staticData, null, 2); } catch (e) { jsonText = '{}'; }
    dataEl.innerHTML =
      '<div class="section-title">Sample data (JSON)</div>' +
      '<div class="field"><textarea id="static-data-json" rows="12" spellcheck="false">' + esc(jsonText) + '</textarea>' +
      '<div class="field-help">This JSON is available to Liquid as <code>data.*</code> (and spread at the root). ' +
      'Exported as <code>static_data</code> when the strategy is <b>static</b>; used as the preview payload for <b>polling</b>.</div></div>' +
      '<div style="display:flex;gap:6px"><button class="btn" id="btn-apply-data">Apply</button>' +
      '<button class="btn" id="btn-sample-data">Reset to example</button>' +
      '<button class="btn" id="btn-expand-data" title="Edit the JSON in a large window">⤢ Expand</button></div>' +
      '<div class="form-status" id="data-status"></div>' +
      '<div class="section-title">Custom fields (config.*)</div>' +
      '<div class="field-help" style="margin-bottom:10px">Users configure these in Larapaper; templates read them via <code>config.keyname</code>.</div>' +
      '<div id="cf-list">' + doc.customFields.map(cfItemHtml).join('') + '</div>' +
      '<button class="btn" id="btn-add-cf">+ Add custom field</button>';
  }

  function dataStatus(msg, ok) {
    const el = document.getElementById('data-status');
    if (el) { el.textContent = msg || ''; el.className = 'form-status ' + (ok ? 'ok' : (msg ? 'err' : '')); }
  }

  function parseDataJson(text) {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Sample data must be a JSON object { … }');
    }
    return parsed;
  }

  /* ---------------- sample-data expand modal ---------------- */

  let dataEditorEl = null;

  function dataEditorStatus(msg, ok) {
    const st = dataEditorEl && dataEditorEl.querySelector('#lpd-status');
    if (st) { st.textContent = msg || ''; st.className = 'form-status ' + (ok ? 'ok' : (msg ? 'err' : '')); }
  }

  function onDataEditorKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); closeDataEditor(); }
  }

  function onDataEditorClick(e) {
    const t = e.target;
    if (t.classList && t.classList.contains('lpd-backdrop')) { closeDataEditor(); return; }
    if (t.id === 'lpd-close' || t.id === 'lpd-cancel') { closeDataEditor(); return; }
    const ta = dataEditorEl.querySelector('#lpd-text');
    if (t.id === 'lpd-format') {
      try {
        ta.value = JSON.stringify(parseDataJson(ta.value), null, 2);
        dataEditorStatus('', true);
      } catch (err) {
        /* parse errors shown inline — the text is left untouched */
        dataEditorStatus('Invalid JSON: ' + err.message);
      }
      return;
    }
    if (t.id === 'lpd-apply') {
      try {
        LPState.setStaticData(parseDataJson(ta.value));
        closeDataEditor();
        /* the panel textarea already re-synced via the doc event */
        dataStatus('Applied ✓', true);
      } catch (err) {
        dataEditorStatus('Invalid JSON: ' + err.message);
      }
    }
  }

  function openDataEditor() {
    if (dataEditorEl) return;
    const panelTa = document.getElementById('static-data-json');
    const current = panelTa ? panelTa.value : JSON.stringify(LPState.getDoc().staticData, null, 2);
    dataEditorEl = document.createElement('div');
    document.getElementById('modal-root').appendChild(dataEditorEl);
    dataEditorEl.innerHTML =
      '<div class="modal-backdrop lpd-backdrop"><div class="lpd-modal">' +
      '<div class="lpd-head"><span class="lpd-title">Sample data (JSON)</span>' +
      '<button class="btn small" id="lpd-format" title="Pretty-print the JSON">Format</button>' +
      '<button class="btn small" id="lpd-close" title="Close (Esc)">✕</button></div>' +
      '<textarea id="lpd-text" spellcheck="false"></textarea>' +
      '<div class="form-status" id="lpd-status"></div>' +
      '<div class="modal-actions">' +
      '<button class="btn" id="lpd-cancel">Cancel</button>' +
      '<button class="btn tb-primary" id="lpd-apply">Apply</button>' +
      '</div></div></div>';
    dataEditorEl.querySelector('#lpd-text').value = current;
    dataEditorEl.addEventListener('click', onDataEditorClick);
    document.addEventListener('keydown', onDataEditorKey);
    dataEditorEl.querySelector('#lpd-text').focus();
  }

  function closeDataEditor() {
    if (!dataEditorEl) return;
    document.removeEventListener('keydown', onDataEditorKey);
    dataEditorEl.remove();
    dataEditorEl = null;
  }

  function onDataClick(e) {
    const id = e.target.id;
    if (id === 'btn-apply-data') {
      const text = document.getElementById('static-data-json').value;
      try {
        LPState.setStaticData(parseDataJson(text));
        dataStatus('Applied ✓', true);
      } catch (err) {
        dataStatus('Invalid JSON: ' + err.message);
      }
      return;
    }
    if (id === 'btn-expand-data') { openDataEditor(); return; }
    if (id === 'btn-sample-data') {
      LPState.setStaticData(LPRecipe.createDocument().staticData);
      renderData();
      dataStatus('Example data restored ✓', true);
      return;
    }
    if (id === 'btn-add-cf') { LPState.addCustomField(); renderData(); return; }
    const del = e.target.dataset ? e.target.dataset.cfDel : null;
    if (del !== null && del !== undefined) { LPState.removeCustomField(parseInt(del, 10)); renderData(); }
  }

  function onDataInput(e) {
    const key = e.target.dataset ? e.target.dataset.cfKey : null;
    if (!key) return;
    const item = e.target.closest('.cf-item');
    if (!item) return;
    const idx = parseInt(item.dataset.idx, 10);
    lastEditAt = Date.now();
    if (key === 'options') {
      LPState.updateCustomField(idx, { options: textToOptions(e.target.value) }, 'cf:' + idx + ':options');
    } else {
      LPState.updateCustomField(idx, { [key]: e.target.value }, 'cf:' + idx + ':' + key);
    }
    /* keyname/type changes alter the markup structure → re-render on change (blur) */
    if (e.type === 'change' && (key === 'keyname' || key === 'fieldType')) renderData();
  }

  /* ================= Device profile ================= */

  function presetFor(device) {
    const d = LPRecipe.normalizeDevice(device);
    const hit = LPRecipe.DEVICE_PRESETS.find((p) =>
      p.width === d.width && p.height === d.height && p.padding === d.padding && p.gap === d.gap);
    return hit ? hit.name : 'Custom';
  }

  function deviceFieldNum(key, label, value) {
    return '<div class="field"><label>' + esc(label) + '</label>' +
      '<input type="number" min="0" data-device="' + key + '" value="' + esc(value) + '"></div>';
  }

  function renderDeviceHtml(doc) {
    const d = LPRecipe.normalizeDevice(doc.device);
    const cur = presetFor(d);
    const opts = LPRecipe.DEVICE_PRESETS.map((p) => p.name).concat(['Custom']);
    return '<div class="section-title">Device</div>' +
      '<div class="field"><label>Preset</label><select data-device="preset">' +
      opts.map((n) => '<option value="' + esc(n) + '"' + (n === cur ? ' selected' : '') + '>' + esc(n) + '</option>').join('') +
      '</select></div>' +
      '<div class="field-row">' +
      deviceFieldNum('width', 'Width (px)', d.width) +
      deviceFieldNum('height', 'Height (px)', d.height) +
      '</div>' +
      '<div class="field-row">' +
      deviceFieldNum('padding', 'Padding (px)', d.padding) +
      '<div class="field"><label>&nbsp;</label><button class="btn" id="btn-rotate-device" type="button">⇄ Rotate</button></div>' +
      '</div>' +
      '<div class="field-help" style="margin-top:-6px">Sets the preview canvas size and <code>trmnl.device.width/height</code>. Exported recipes are resolution-independent.</div>';
  }

  function onDeviceInput(e) {
    const key = e.target.dataset ? e.target.dataset.device : null;
    if (!key) return;
    lastEditAt = Date.now();
    const doc = LPState.getDoc();
    if (key === 'preset') {
      const p = LPRecipe.DEVICE_PRESETS.find((x) => x.name === e.target.value);
      if (p) LPState.updateDevice({ name: p.name, width: p.width, height: p.height, padding: p.padding, gap: p.gap });
      renderRecipe();
      return;
    }
    const value = e.target.value === '' ? '' : parseInt(e.target.value, 10);
    const patch = { [key]: value };
    /* manual edits switch the preset to Custom */
    patch.name = presetFor(Object.assign(LPRecipe.normalizeDevice(doc.device), patch));
    LPState.updateDevice(patch, 'device:' + key);
  }

  function onDeviceClick(e) {
    if (e.target.id !== 'btn-rotate-device') return;
    const d = LPRecipe.normalizeDevice(LPState.getDoc().device);
    const rotated = Object.assign({}, d, { width: d.height, height: d.width });
    rotated.name = presetFor(rotated);
    LPState.updateDevice({ width: rotated.width, height: rotated.height, name: rotated.name });
    renderRecipe();
  }

  /* ================= Recipe settings ================= */

  function fieldText(key, label, value, hint, type) {
    return '<div class="field"><label>' + esc(label) + '</label>' +
      '<input type="' + (type || 'text') + '" data-meta="' + key + '" value="' + esc(value) + '">' +
      (hint ? '<div class="field-help">' + esc(hint) + '</div>' : '') + '</div>';
  }
  function fieldArea(key, label, value, hint, rows) {
    return '<div class="field"><label>' + esc(label) + '</label>' +
      '<textarea data-meta="' + key + '" rows="' + (rows || 3) + '">' + esc(value) + '</textarea>' +
      (hint ? '<div class="field-help">' + esc(hint) + '</div>' : '') + '</div>';
  }
  function fieldCheck(key, label, checked, hint) {
    return '<div class="check-field"><input type="checkbox" id="rm-' + key + '" data-meta="' + key + '"' + (checked ? ' checked' : '') + '>' +
      '<label for="rm-' + key + '">' + esc(label) + '</label></div>' +
      (hint ? '<div class="field-help" style="margin:-8px 0 12px 24px">' + esc(hint) + '</div>' : '');
  }

  function renderRecipe() {
    const doc = LPState.getDoc();
    const polling = doc.strategy === 'polling';
    let html =
      '<div class="section-title">Recipe</div>' +
      fieldText('name', 'Name', doc.name, 'Shown in Larapaper and as the default title') +
      fieldArea('description', 'Description', doc.description, null, 2) +
      '<div class="field"><label>Strategy</label><select data-meta="strategy">' +
      '<option value="static"' + (!polling ? ' selected' : '') + '>static — sample/fixed JSON data</option>' +
      '<option value="polling"' + (polling ? ' selected' : '') + '>polling — fetch JSON from a URL</option>' +
      '</select><div class="field-help">Polling merges the fetched payload into the template context.</div></div>';

    if (polling) {
      html += fieldText('pollingUrl', 'Polling URL', doc.pollingUrl, 'Must return JSON (object or array)') +
        '<div class="field"><label>HTTP verb</label><select data-meta="pollingVerb">' +
        ['GET', 'POST', 'PUT', 'PATCH'].map((v) => '<option' + (doc.pollingVerb === v ? ' selected' : '') + '>' + v + '</option>').join('') +
        '</select></div>' +
        fieldArea('pollingHeaders', 'Polling headers', doc.pollingHeaders, 'One per line: Header-Name: value', 2) +
        fieldArea('pollingBody', 'Polling body', doc.pollingBody, 'Optional request body (JSON)', 3);
    }

    html += renderDeviceHtml(doc) +
      '<div class="section-title">Publishing</div>' +
      fieldText('refreshInterval', 'Refresh interval (seconds)', doc.refreshInterval, 'How often Larapaper re-renders/fetches', 'number') +
      fieldText('frameworkVersion', 'Framework version', doc.frameworkVersion, 'TRMNL design system version, e.g. 1.0.0') +
      fieldCheck('darkMode', 'Dark mode', doc.darkMode, 'Inverts the device color scheme') +
      fieldCheck('noScreenPadding', 'No screen padding', doc.noScreenPadding, 'Removes the 10px outer screen gap') +
      '<div class="section-title">Larapaper server</div>' +
      '<div class="field-help" id="server-summary" style="margin-bottom:8px">' + esc(serverSummary(doc)) + '</div>' +
      '<button class="btn" id="btn-open-push">Push settings…</button>';

    recipeEl.innerHTML = html;
  }

  function serverSummary(doc) {
    const s = doc.server || {};
    if (!s.baseUrl) return 'No server configured yet.';
    let t = s.baseUrl;
    t += s.trmnlpId ? ' · linked to plugin #' + s.trmnlpId : ' · not linked (push creates a new plugin)';
    return t;
  }

  function onRecipeInput(e) {
    const key = e.target.dataset ? e.target.dataset.meta : null;
    if (!key) return;
    lastEditAt = Date.now();
    let value;
    if (e.target.type === 'checkbox') value = e.target.checked;
    else if (e.target.type === 'number') value = e.target.value === '' ? '' : parseFloat(e.target.value);
    else value = e.target.value;
    LPState.updateMeta({ [key]: value }, 'meta:' + key);
    if (key === 'strategy' && e.type === 'change') renderRecipe();
  }

  function onRecipeClick(e) {
    if (e.target.id === 'btn-open-push' && window.LPPush) window.LPPush.open();
  }

  /* ================= wiring ================= */

  function init() {
    dataEl = document.getElementById('panel-data');
    recipeEl = document.getElementById('panel-recipe');
    dataEl.addEventListener('click', onDataClick);
    dataEl.addEventListener('input', onDataInput);
    dataEl.addEventListener('change', onDataInput);
    recipeEl.addEventListener('input', onRecipeInput);
    recipeEl.addEventListener('change', onRecipeInput);
    recipeEl.addEventListener('click', onRecipeClick);
    recipeEl.addEventListener('input', onDeviceInput);
    recipeEl.addEventListener('change', onDeviceInput);
    recipeEl.addEventListener('click', onDeviceClick);

    LPState.on('doc', () => {
      const editing = (dataEl.contains(document.activeElement) || recipeEl.contains(document.activeElement)) &&
        Date.now() - lastEditAt < 600;
      if (editing) return;
      renderData();
      renderRecipe();
    });
    renderData();
    renderRecipe();
  }

  return { init, renderData, renderRecipe };
})();

