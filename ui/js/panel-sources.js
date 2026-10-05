/* Larapaper Studio — Sources panel: API data sources, fetch & bind. */
window.LPPanelSources = (function () {
  let el = null;
  let lastEditAt = 0;
  /* fetched payloads live in memory only — never in the saved document */
  const fetchState = {}; /* sourceId -> { busy, ok, status, error, json } */
  /* tree expand modal: while open it owns the source's .src-fetched block */
  let treeModalEl = null;
  let treeModalSid = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function toast(msg, kind) { if (window.LPToast) window.LPToast(msg, kind); }

  function findSource(id) {
    return (LPState.getDoc().sources || []).find((s) => s.id === id) || null;
  }

  /** First text-ish prop of the widget (shared logic lives in LPWidgets). */
  function primaryTextProp(node) {
    return LPWidgets.primaryTextProp(node);
  }

  /* ================= rendering ================= */

  function statusBadge(id) {
    const st = fetchState[id];
    if (!st) return '';
    if (st.busy) return '<span class="src-badge busy">Fetching…</span>';
    if (st.ok) return '<span class="src-badge ok">' + esc(st.status) + ' OK</span>';
    return '<span class="src-badge err">✗ ' + esc(st.error || 'Request failed') + '</span>';
  }

  function headersTableHtml(s) {
    let rows = (s.headers || []).map((h, i) =>
      '<tr data-hdr-idx="' + i + '">' +
      '<td><input type="text" data-hdr="key" placeholder="Header-Name" value="' + esc(h.key) + '"></td>' +
      '<td><input type="' + (h.secret ? 'password' : 'text') + '" data-hdr="value" placeholder="value" value="' + esc(h.value) + '"></td>' +
      '<td class="hdr-secret" title="Secret: masked, and not saved into the project file unless enabled below">' +
      '<input type="checkbox" data-hdr="secret"' + (h.secret ? ' checked' : '') + '></td>' +
      '<td><button class="btn small danger" data-hdr-del="' + i + '" title="Remove header">×</button></td>' +
      '</tr>').join('');
    return '<table class="hdr-table"><thead><tr><th>Key</th><th>Value</th><th>Secret</th><th></th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '<button class="btn small" data-hdr-add>+ Add header</button>';
  }

  /* ================= JSON tree (search + bind + condition) ================= */

  /** Highlights every occurrence of q in text with <mark> (escapes both). */
  function hi(text, q) {
    const s = String(text);
    if (!q) return esc(s);
    const i = s.toLowerCase().indexOf(String(q).toLowerCase());
    if (i === -1) return esc(s);
    return esc(s.slice(0, i)) + '<mark>' + esc(s.slice(i, i + q.length)) + '</mark>' + hi(s.slice(i + q.length), q);
  }

  function leafMatches(key, value, q) {
    if (String(key).toLowerCase().indexOf(q) !== -1) return true;
    let v;
    try { v = JSON.stringify(value); } catch (e) { v = String(value); }
    if (v === undefined) v = String(value);
    return String(v).toLowerCase().indexOf(q) !== -1;
  }

  function leafHtml(path, key, value, q) {
    let v;
    try { v = JSON.stringify(value); } catch (e) { v = String(value); }
    if (v === undefined) v = String(value);
    if (v.length > 60) v = v.slice(0, 57) + '…';
    const canCond = !!LPState.getSelectedNode();
    const canSearch = !!primaryTextProp(LPState.getSelectedNode());
    return '<div class="jt-leaf"><span class="jt-key">' + hi(key, q) + '</span>: <span class="jt-val">' + hi(v, q) + '</span>' +
      '<button class="jt-bind" data-bind-path="' + esc(path) + '" title="Bind ' + esc(LPSources.bindingFor(path)) + '">Bind</button>' +
      '<button class="jt-bind jt-cond" data-cond-path="' + esc(path) + '"' + (canCond ? '' : ' disabled') +
      ' title="Set a mentions condition on the selected widget">ƒ Cond</button>' +
      '<button class="jt-bind jt-search" data-search-path="' + esc(path) + '"' + (canSearch ? '' : ' disabled') +
      ' title="Draft a search binding on the selected widget from this leaf">⌕ Search</button></div>';
  }

  /**
   * Tree HTML; with a query, only matching leaves plus their ancestor chain
   * are kept, matches auto-expand and the matched substring is <mark>-ed.
   */
  function treeHtml(value, path, key, depth, q) {
    const query = (q || '').trim().toLowerCase();
    if (value !== null && typeof value === 'object') {
      const isArr = Array.isArray(value);
      const entries = isArr ? value.map((v, i) => [i, v]) : Object.keys(value).map((k) => [k, value[k]]);
      if (!entries.length) {
        if (query && !leafMatches(key, value, query)) return '';
        return leafHtml(path, key, isArr ? [] : {}, query);
      }
      const inner = entries.map(([k, v]) => {
        const childPath = isArr ? path + '[' + k + ']' : (path ? path + '.' + k : String(k));
        return treeHtml(v, childPath, isArr ? '[' + k + ']' : k, depth + 1, query);
      }).join('');
      if (query && inner === '') return '';
      const label = esc(key) + ' <span class="jt-meta">' + (isArr ? '[' + entries.length + ']' : '{' + entries.length + '}') + '</span>';
      const open = query || depth < 2 ? ' open' : '';
      return '<details class="jt-node"' + open + '><summary>' + label + '</summary>' + inner + '</details>';
    }
    if (query && !leafMatches(key, value, query)) return '';
    return leafHtml(path, key, value, query);
  }

  function treeHtmlFor(sid) {
    const s = findSource(sid);
    const st = fetchState[sid];
    if (!s || !st || !st.ok || st.json === undefined) return '';
    /* render the WRAPPED payload so tree paths match the sample-data shape:
       root arrays nest under dataKey → leaves bind as {{ data.key[i].x }} */
    const wrapped = LPSources.wrapSampleData(s, st.json);
    return '<div class="json-tree">' + treeHtml(wrapped, '', '(root)', 0, st.query) + '</div>';
  }

  function fetchedHtml(s) {
    const st = fetchState[s.id];
    if (!st || st.busy || !st.ok || st.json === undefined) return '';
    /* while the expand modal owns the fetched block, the panel keeps an empty
       slot — the block moves back (via render) when the modal closes */
    if (treeModalSid === s.id) return '<div class="fetched-slot" data-src-id="' + esc(s.id) + '"></div>';
    return '<div class="src-fetched" data-src-id="' + esc(s.id) + '">' +
      '<div class="section-title src-fetched-head">Fetched payload' +
      '<button class="btn small jt-expand" data-tree-expand title="Open the tree in a large window">⤢</button></div>' +
      '<div class="field-help" style="margin-bottom:6px">Expand the tree; <b>Bind</b> inserts <code>{{ data.… }}</code> into the selected widget (or copies it). ' +
      '<b>ƒ Cond</b> wraps it in a mentions condition instead.</div>' +
      '<div class="field" style="margin-bottom:6px"><input type="text" data-tree-search placeholder="Search keys &amp; values…" spellcheck="false" value="' + esc(st.query || '') + '"></div>' +
      treeHtmlFor(s.id) +
      '</div>';
  }

  function sourceHtml(s) {
    const post = s.method === 'POST';
    return '<div class="src-item" data-src-id="' + esc(s.id) + '">' +
      '<div class="src-head"><span class="src-name">' + esc(s.name || '(unnamed source)') + '</span>' +
      statusBadge(s.id) +
      '<span style="flex:1"></span>' +
      '<button class="btn small danger" data-src-del>Delete</button></div>' +
      '<div class="field"><label>Name</label><input type="text" data-src-key="name" value="' + esc(s.name) + '"></div>' +
      '<div class="field"><label>URL</label><input type="text" data-src-key="url" spellcheck="false" value="' + esc(s.url) + '"></div>' +
      '<div class="field"><label>Method</label><select data-src-key="method">' +
      '<option value="GET"' + (!post ? ' selected' : '') + '>GET</option>' +
      '<option value="POST"' + (post ? ' selected' : '') + '>POST</option></select></div>' +
      '<div class="field"><label>Headers</label>' + headersTableHtml(s) + '</div>' +
      (post ? '<div class="field"><label>Body (JSON)</label><textarea rows="3" data-src-key="body" spellcheck="false">' + esc(s.body) + '</textarea></div>' : '') +
      '<div class="field"><label>Data key</label><input type="text" data-src-key="dataKey" value="' + esc(s.dataKey) + '">' +
      '<div class="field-help">When the API returns a bare array, it is wrapped under this key for <code>data.*</code> (default <code>items</code>).</div></div>' +
      '<div class="check-field"><input type="checkbox" id="ss-' + esc(s.id) + '" data-src-key="saveSecrets"' + (s.saveSecrets ? ' checked' : '') + '>' +
      '<label for="ss-' + esc(s.id) + '">Save secrets in project (secret header values stored as plain text)</label></div>' +
      '<div class="src-actions">' +
      '<button class="btn" data-fetch>Fetch now</button>' +
      '<button class="btn small" data-sample' + (fetchState[s.id] && fetchState[s.id].ok ? '' : ' disabled') + '>Use as sample data</button>' +
      '<button class="btn small" data-use-recipe>Use in recipe</button>' +
      '</div>' +
      fetchedHtml(s) +
      '</div>';
  }

  function render() {
    const sources = LPState.getDoc().sources || [];
    el.innerHTML =
      '<div class="section-title">API data sources</div>' +
      '<div class="field-help" style="margin-bottom:10px">Fetch JSON from an API, inspect the payload, bind values into widgets, ' +
      'use it as sample data, or apply it as the recipe\'s polling endpoint.</div>' +
      '<div class="field"><select id="src-add"><option value="">+ Add source…</option>' +
      '<option value="gvb">GVB Disruptions (preset)</option>' +
      '<option value="blank">Blank source</option></select></div>' +
      (sources.length ? sources.map(sourceHtml).join('') :
        '<div class="field-help">No sources yet.</div>');
    /* tree interactions are bound on the .src-fetched block itself (not
       delegated to the panel) so the block keeps working when the expand
       modal moves it out of the panel */
    Array.prototype.forEach.call(el.querySelectorAll('.src-fetched'), attachFetched);
  }

  /* ================= events ================= */

  function onAddChange(e) {
    if (e.target.id !== 'src-add') return;
    const v = e.target.value;
    if (!v) return;
    lastEditAt = Date.now();
    LPState.addSource(v === 'gvb' ? LPSources.createSource(LPSources.GVB_PRESET) : LPSources.createSource());
    render();
  }

  function onFieldInput(e) {
    const key = e.target.dataset ? e.target.dataset.srcKey : null;
    if (!key) return;
    const item = e.target.closest('.src-item');
    if (!item) return;
    lastEditAt = Date.now();
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    LPState.updateSource(item.dataset.srcId, { [key]: value }, 'src:' + item.dataset.srcId + ':' + key);
    if (key === 'method' && e.type === 'change') render();
  }

  function onHeaderInput(e) {
    const key = e.target.dataset ? e.target.dataset.hdr : null;
    if (!key) return;
    const item = e.target.closest('.src-item');
    const row = e.target.closest('tr[data-hdr-idx]');
    if (!item || !row) return;
    const s = findSource(item.dataset.srcId);
    if (!s) return;
    lastEditAt = Date.now();
    const idx = parseInt(row.dataset.hdrIdx, 10);
    const headers = (s.headers || []).map((h) => Object.assign({}, h));
    if (!headers[idx]) return;
    headers[idx][key] = key === 'secret' ? e.target.checked : e.target.value;
    LPState.updateSource(s.id, { headers }, 'src:' + s.id + ':hdr:' + idx + ':' + key);
    if (key === 'secret') render(); /* switch value input masking */
  }

  async function doFetch(id) {
    const s = findSource(id);
    if (!s) return;
    if (!s.url || !String(s.url).trim()) { toast('Enter a URL first.', 'err'); return; }
    fetchState[id] = { busy: true };
    render();
    try {
      const r = await window.lp.httpRequest({
        method: s.method || 'GET',
        url: s.url,
        headers: (s.headers || []).filter((h) => h.key && String(h.key).trim())
          .map((h) => ({ key: String(h.key), value: String(h.value || '') })),
        body: s.method === 'POST' ? (s.body || null) : null,
        timeout_ms: 15000
      });
      if (!r || !r.ok) {
        fetchState[id] = { ok: false, status: r && r.status, error: (r && r.error) || 'Request failed' };
      } else if (r.status !== undefined && (r.status < 200 || r.status > 299)) {
        /* e.g. a 401 for a wrong API key — don't offer the error body as sample data */
        const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.json !== undefined ? r.json : '');
        fetchState[id] = { ok: false, status: r.status, error: 'HTTP ' + r.status + (body ? ': ' + body.slice(0, 200) : '') };
      } else {
        let payload = r.json !== undefined ? r.json : r.body;
        if (typeof payload === 'string') payload = JSON.parse(payload);
        fetchState[id] = { ok: true, status: r.status === undefined ? 200 : r.status, json: payload };
      }
    } catch (err) {
      fetchState[id] = { ok: false, error: String(err.message || err) };
    }
    render();
  }

  /* bindings resolve against staticData — make sure the fetched payload is
     actually merged, otherwise the widget renders blank */
  function ensureSampleMerged(srcId) {
    const s = srcId ? findSource(srcId) : null;
    const st = srcId ? fetchState[srcId] : null;
    if (!s || !st || !st.ok || st.json === undefined) return false;
    const wrapped = LPSources.wrapSampleData(s, st.json);
    const wrappedKey = Object.keys(wrapped)[0];
    const sd = LPState.getDoc().staticData || {};
    if (wrappedKey && !(wrappedKey in sd)) {
      LPState.mergeStaticData(wrapped);
      return true;
    }
    return false;
  }

  function bindPath(path, srcId) {
    const binding = LPSources.bindingFor(path);
    const node = LPState.getSelectedNode();
    const key = primaryTextProp(node);
    if (node && key) {
      const merged = ensureSampleMerged(srcId);
      LPState.updateProps(node.id, { [key]: binding });
      toast('Bound ' + binding + ' → ' + node.type + '.' + key + (merged ? ' (sample data merged)' : ''), 'ok');
      return;
    }
    const done = () => toast('No text widget selected — binding copied to clipboard', 'ok');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(binding).then(done, () => toast(binding, 'ok'));
    } else {
      toast(binding, 'ok');
    }
  }

  /* live-filter the tree without re-rendering the panel (keeps input focus).
     Works wherever the .src-fetched block currently lives (panel or modal). */
  function refreshTree(sid) {
    const container = document.querySelector('.src-fetched[data-src-id="' + sid + '"]');
    const old = container ? container.querySelector('.json-tree') : null;
    if (!old) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = treeHtmlFor(sid);
    old.replaceWith(tmp.firstChild);
  }

  /** Delegated handlers on the fetched block itself: Bind / ƒ Cond / ⤢ / search. */
  function attachFetched(container) {
    const sid = container.dataset.srcId;
    container.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      const expandBtn = t.closest('[data-tree-expand]');
      if (expandBtn) { if (!treeModalEl) openTreeModal(sid); return; }
      const bindBtn = t.closest('[data-bind-path]');
      if (bindBtn) { bindPath(bindBtn.getAttribute('data-bind-path'), sid); return; }
      const condBtn = t.closest('[data-cond-path]');
      if (condBtn) condFromLeaf(condBtn, sid);
      const searchBtn = t.closest('[data-search-path]');
      if (searchBtn) searchFromLeaf(searchBtn, sid);
    });
    const search = container.querySelector('[data-tree-search]');
    if (search) search.addEventListener('input', () => {
      const st = fetchState[sid];
      if (!st) return;
      st.query = search.value;
      refreshTree(sid);
    });
  }

  /* ---------------- tree expand modal ---------------- */

  function onTreeModalKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); closeTreeModal(); }
  }

  function openTreeModal(sid) {
    if (treeModalEl) return;
    const container = document.querySelector('#panel-sources .src-fetched[data-src-id="' + sid + '"]');
    if (!container) return;
    treeModalSid = sid;
    treeModalEl = document.createElement('div');
    document.getElementById('modal-root').appendChild(treeModalEl);
    treeModalEl.innerHTML =
      '<div class="modal-backdrop lpt-backdrop"><div class="lpt-modal">' +
      '<div class="lpt-head"><span class="lpt-title">Fetched payload — ' +
      esc((findSource(sid) || {}).name || 'source') + '</span>' +
      '<button class="btn small" data-lpt-close title="Close (Esc)">✕</button></div>' +
      '<div class="lpt-body"></div>' +
      '</div></div>';
    /* move the live block (search + tree + its handlers) into the modal */
    treeModalEl.querySelector('.lpt-body').appendChild(container);
    treeModalEl.addEventListener('click', (e) => {
      if (e.target.classList && e.target.classList.contains('lpt-backdrop')) { closeTreeModal(); return; }
      if (e.target.closest && e.target.closest('[data-lpt-close]')) closeTreeModal();
    });
    document.addEventListener('keydown', onTreeModalKey);
  }

  function closeTreeModal() {
    if (!treeModalEl) return;
    document.removeEventListener('keydown', onTreeModalKey);
    treeModalSid = null;
    treeModalEl.remove();
    treeModalEl = null;
    render(); /* re-creates the fetched block back inside the panel */
  }

  /** ƒ Cond: pre-fill a mentions condition on the selected widget from a leaf. */
  function condFromLeaf(btn, sid) {
    const node = LPState.getSelectedNode();
    if (!node || node.isRoot) { toast('Select a widget first.', 'err'); return; }
    const s = sid ? findSource(sid) : null;
    const st = sid ? fetchState[sid] : null;
    if (!s || !st || !st.ok || st.json === undefined) return;
    const wrapped = LPSources.wrapSampleData(s, st.json);
    const leafPath = btn.getAttribute('data-cond-path');
    const arrPath = LPConditions.nearestArrayPath(wrapped, leafPath);
    const jsonPath = arrPath || leafPath;
    const liqPath = jsonPath.charAt(0) === '[' ? 'data' + jsonPath : 'data.' + jsonPath;
    const fields = arrPath ? LPConditions.arrayItemFields(wrapped, arrPath) : [];
    let value = String(st.query || '').trim();
    if (!value) {
      const leafVal = LPConditions.valueAtPath(wrapped, leafPath);
      value = leafVal === undefined || leafVal === null ? ''
        : (typeof leafVal === 'object' ? JSON.stringify(leafVal) : String(leafVal));
    }
    LPState.updateProps(node.id, {
      condition: { enabled: true, op: 'mentions', path: liqPath, fields: fields, value: value }
    });
    toast('Condition set on ' + node.type + ' — check the inspector', 'ok');
  }

  /** ⌕ Search: draft a search binding on the selected widget from a leaf. */
  function searchFromLeaf(btn, sid) {
    const node = LPState.getSelectedNode();
    const targetProp = primaryTextProp(node);
    if (!node || node.isRoot || !targetProp) { toast('Select a text widget first.', 'err'); return; }
    const s = sid ? findSource(sid) : null;
    const st = sid ? fetchState[sid] : null;
    if (!s || !st || !st.ok || st.json === undefined) return;
    const wrapped = LPSources.wrapSampleData(s, st.json);
    const leafPath = btn.getAttribute('data-search-path');
    const arrPath = LPConditions.nearestArrayPath(wrapped, leafPath);
    if (!arrPath) { toast('No array ancestor — search bindings need an array of items.', 'err'); return; }
    const liqPath = arrPath.charAt(0) === '[' ? 'data' + arrPath : 'data.' + arrPath;
    const fields = LPConditions.arrayItemFields(wrapped, arrPath);
    /* the leaf's key within the array item (indices dropped):
       'disruptions[2].title' vs 'disruptions' → 'title' */
    const rel = LPConditions.parsePath(leafPath).slice(LPConditions.parsePath(arrPath).length)
      .filter((seg) => !/^\d+$/.test(seg));
    const display = rel.join('.');
    let query = String(st.query || '').trim();
    if (!query) {
      const leafVal = LPConditions.valueAtPath(wrapped, leafPath);
      query = leafVal === undefined || leafVal === null ? ''
        : (typeof leafVal === 'object' ? JSON.stringify(leafVal) : String(leafVal));
    }
    ensureSampleMerged(sid);
    LPState.updateProps(node.id, {
      search: {
        enabled: true, targetProp: targetProp, path: liqPath, fields: fields,
        match: 'contains', query: query, display: display || fields[0] || '', pick: 1
      }
    });
    toast('Search binding set on ' + node.type + ' — check the inspector', 'ok');
  }

  function onClick(e) {
    const t = e.target;
    /* Bind / ƒ Cond / ⤢ inside the fetched block are handled by its own
       delegated listener (attachFetched) — it also fires inside the modal */
    const item = t.closest ? t.closest('.src-item') : null;
    if (!item || !t.dataset) return;
    const id = item.dataset.srcId;
    const s = findSource(id);
    if (t.dataset.srcDel !== undefined) {
      if (window.confirm('Delete source "' + (s ? s.name : '') + '"?')) {
        delete fetchState[id];
        LPState.removeSource(id);
      }
      return;
    }
    if (!s) return;
    if (t.dataset.hdrAdd !== undefined) {
      LPState.updateSource(id, { headers: (s.headers || []).concat([{ key: '', value: '', secret: false }]) });
      render();
      return;
    }
    if (t.dataset.hdrDel !== undefined) {
      const idx = parseInt(t.dataset.hdrDel, 10);
      LPState.updateSource(id, { headers: (s.headers || []).filter((_, i) => i !== idx) });
      render();
      return;
    }
    if (t.dataset.fetch !== undefined) { doFetch(id); return; }
    if (t.dataset.sample !== undefined) {
      const st = fetchState[id];
      if (!st || !st.ok || st.json === undefined) { toast('Fetch the source first.', 'err'); return; }
      /* REPLACE the sample data — merging leaves noisy starter keys behind */
      LPState.setStaticData(LPSources.wrapSampleData(s, st.json));
      toast('Sample data replaced ✓ — preview now renders the fetched payload', 'ok');
      return;
    }
    if (t.dataset.useRecipe !== undefined) {
      LPState.updateMeta(Object.assign({ strategy: 'polling' }, LPSources.toPollingConfig(s)));
      toast('Recipe now polls ' + (s.url || '(no url)'), 'ok');
    }
  }

  function init() {
    el = document.getElementById('panel-sources');
    el.addEventListener('change', onAddChange);
    el.addEventListener('input', onFieldInput);
    el.addEventListener('change', onFieldInput);
    el.addEventListener('input', onHeaderInput);
    el.addEventListener('change', onHeaderInput);
    el.addEventListener('click', onClick);
    LPState.on('doc', () => {
      const typing = el.contains(document.activeElement) && Date.now() - lastEditAt < 600;
      if (!typing) render();
    });
    /* ƒ Cond buttons enable/disable with the selection */
    LPState.on('selection', () => {
      const typing = el.contains(document.activeElement) && Date.now() - lastEditAt < 600;
      if (!typing) render();
    });
    render();
  }

  return { init, render };
})();
