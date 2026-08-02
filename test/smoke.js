/* Larapaper Studio — in-page smoke harness.
 * Evaluated by the Rust backend when the app runs with `--smoke-test`.
 * Runs the checks below, then reports via invoke('smoke_report').
 * Self-guarding: safe to eval multiple times. */
(function () {
  if (window.__SMOKE_STARTED) return;
  window.__SMOKE_STARTED = true;

  const checks = [];
  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.message || e)));
  window.addEventListener('unhandledrejection', (e) =>
    errors.push('rejection: ' + String((e.reason && e.reason.message) || e.reason)));

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const check = (name, ok, detail) =>
    checks.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });

  async function waitFor(fn, ms, label) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      try { if (fn()) return; } catch (e) { /* not ready */ }
      await sleep(200);
    }
    throw new Error('timeout waiting for ' + label);
  }

  function report(okOverride) {
    const failed = checks.filter((c) => !c.ok).length;
    const result = { ok: failed === 0, checks, errors };
    window.__SMOKE_RESULT = result;
    try {
      window.__TAURI__.core.invoke('smoke_report', { result: JSON.stringify(result) });
    } catch (e) { /* bridge gone — nothing else we can do */ }
  }

  async function run() {
    /* the harness may be eval'd before boot finishes — wait for the app */
    await waitFor(() => window.__APP_READY, 15000, 'app boot');

    check('app boots (window.__APP_READY)', true);
    check('tauri bridge present', !!(window.__TAURI__ && window.__TAURI__.core && window.lp && window.lp.httpRequest));
    check('palette rendered (18 widgets)', document.querySelectorAll('.palette-item').length === 18,
      document.querySelectorAll('.palette-item').length + ' items');

    /* live GVB fetch through the Rust backend */
    const GVB = 'https://www.gvb.nl/api/gvb-shared-services/travelinformation/api/v1/Disruption/GetDisruptions?language=en';
    let gvb;
    try {
      gvb = await window.lp.httpRequest({ method: 'GET', url: GVB, headers: [], body: null, timeout_ms: 15000 });
    } catch (e) { gvb = { invokeError: String((e && e.message) || e) }; }
    check('GVB fetch via http_request → 200 JSON',
      gvb && gvb.ok && gvb.status === 200 && (gvb.body || '').length > 100,
      JSON.stringify(gvb).slice(0, 220));

    /* Sources panel flow */
    document.querySelector('.panel-tab[data-panel="sources"]').click();
    const sel = document.getElementById('src-add');
    sel.value = 'gvb';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(200);
    check('GVB preset source added', (LPState.getDoc().sources || []).length === 1);

    document.querySelector('[data-fetch]').click();
    await waitFor(() => document.querySelector('.src-badge.ok, .src-badge.err'), 20000, 'fetch badge');
    const badge = (document.querySelector('.src-badge') || {}).textContent || '';
    check('source fetch badge OK', /OK/.test(badge), badge);
    check('JSON tree rendered', document.querySelectorAll('.jt-leaf').length > 10,
      document.querySelectorAll('.jt-leaf').length + ' leaves');

    document.querySelector('[data-sample]').click();
    await sleep(300);
    const sd = LPState.getDoc().staticData;
    const n = (sd.disruptions || []).length;
    check('use as sample data replaces staticData with disruptions', n > 0, n + ' disruptions in staticData');
    const leftovers = ['value', 'percent', 'items', 'rows'].filter((k) => sd[k] !== undefined);
    check('starter sample keys are gone (replace, not merge)',
      sd.value === undefined && sd.items === undefined && leftovers.length === 0,
      leftovers.length ? 'leftover keys: ' + leftovers.join(',') : 'clean');

    /* bind a leaf into a selected widget */
    LPState.addNode('root', null, LPWidgets.createNode('label'));
    const root = LPState.getRoot();
    const labelId = root.children[root.children.length - 1].id;
    LPState.select(labelId);
    document.querySelector('.jt-bind').click();
    await sleep(200);
    const boundNode = LPState.findNode(labelId) || { props: {} };
    const bound = Object.keys(boundNode.props || {})
      .filter((k) => /^\{\{ data\./.test(String(boundNode.props[k])))
      .map((k) => k + '=' + boundNode.props[k])
      .join(',');
    check('bind writes {{ data.* }} into selected widget', bound !== '', bound);

    /* widget conditions: not_mentions keeps the widget, mentions hides it */
    const deviceView = document.getElementById('device-view');
    const labelText = ((deviceView.querySelector('[data-wid="' + labelId + '"]') || {}).textContent || '').trim();
    check('bound label rendered some text', labelText !== '', labelText.slice(0, 60));
    LPState.updateProps(labelId, { condition: { enabled: true, op: 'not_mentions', path: 'data.disruptions', fields: [], value: 'zzz-no-such-line' } });
    await sleep(300);
    check('not_mentions condition keeps the widget rendered',
      deviceView.textContent.indexOf(labelText) !== -1 &&
      !!deviceView.querySelector('[data-wid="' + labelId + '"]'), 'needle absent → shown');
    check('conditioned root child gets a ƒ badge',
      !!deviceView.querySelector('[data-wid="' + labelId + '"] .lp-cond-badge'));
    LPState.updateProps(labelId, { condition: { enabled: true, op: 'mentions', path: 'data.disruptions', fields: [], value: 'zzz-no-such-line' } });
    await sleep(300);
    check('mentions condition hides the widget markup when the needle is absent',
      deviceView.textContent.indexOf(labelText) === -1 &&
      !deviceView.querySelector('[data-wid="' + labelId + '"]:not(.lp-ghost)'), 'needle absent → hidden');
    const ghost = deviceView.querySelector('.lp-ghost');
    check('hidden conditioned widget leaves a ghost in its cell',
      !!ghost && ghost.getAttribute('data-wid') === labelId && ghost.textContent.indexOf('Label') !== -1,
      ghost ? ghost.textContent.trim() : 'no .lp-ghost');
    check('ghost is not draggable', ghost && ghost.getAttribute('draggable') !== 'true');
    if (ghost) ghost.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(200);
    check('clicking the ghost selects the widget', LPState.getSelectedId() === labelId,
      String(LPState.getSelectedId()));
    LPState.updateProps(labelId, { condition: { enabled: false, op: 'mentions', path: '', fields: [], value: '' } });
    await sleep(300);
    check('disabled condition restores the widget and removes the ghost',
      !!deviceView.querySelector('[data-wid="' + labelId + '"]:not(.lp-ghost)') &&
      !deviceView.querySelector('.lp-ghost'));

    /* search-and-pick binding: display text picked by query from the API data */
    const firstTitle = String((sd.disruptions[0] || {}).title || '');
    const firstWord = (firstTitle.split(/\s+/).filter(Boolean)[0]) || 'metro';
    LPState.updateProps(labelId, { search: { enabled: true, targetProp: 'text', path: 'data.disruptions', fields: ['title'], match: 'contains', query: firstWord, display: 'title', pick: 1 } });
    await sleep(300);
    check('search binding renders the picked hit in #device-view',
      firstTitle !== '' && deviceView.textContent.indexOf(firstTitle) !== -1, firstTitle.slice(0, 60));
    check('inspector shows the Search binding section for the selected widget',
      !!document.querySelector('#panel-properties .sbind-section [data-sbind="enabled"]'));
    LPState.updateProps(labelId, { search: { enabled: false, targetProp: 'text', path: '', fields: [], match: 'contains', query: '', display: '', pick: 1 } });
    await sleep(300);

    /* full-window preview modal: clean render, no editor chrome */
    document.getElementById('btn-preview').click();
    await sleep(300);
    const modalView = document.querySelector('#modal-root .view');
    check('preview modal shows a clean .view',
      !!(modalView && modalView.innerHTML.length > 50 && !document.querySelector('#modal-root #grid-overlay') &&
        !document.querySelector('#modal-root [data-wid][draggable="true"]')),
      modalView ? modalView.innerHTML.length + ' chars' : 'no .view in modal');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await sleep(200);
    check('preview modal closes on Esc', document.getElementById('modal-root').children.length === 0);

    /* synthetic drag & drop: palette → canvas (validates JS wiring) */
    const before = LPState.getRoot().children.length;
    const item = document.querySelector('.palette-item');
    const view = document.getElementById('device-view');
    const dt = new DataTransfer();
    item.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const r = view.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + 60 };
    view.dispatchEvent(new DragEvent('dragover', opts));
    view.dispatchEvent(new DragEvent('drop', opts));
    await sleep(250);
    check('synthetic drop adds widget', LPState.getRoot().children.length === before + 1,
      before + ' → ' + LPState.getRoot().children.length);
    const dropped = LPState.getRoot().children[LPState.getRoot().children.length - 1] || {};
    const a = dropped.area;
    check('dropped widget snapped to a grid cell',
      !!(a && a.x >= 0 && a.y >= 0 && a.w >= 1 && a.h >= 1), JSON.stringify(a || null));

    /* sample-data expand modal (Data & Config panel) */
    document.querySelector('.panel-tab[data-panel="data"]').click();
    await sleep(200);
    document.getElementById('btn-expand-data').click();
    await sleep(200);
    const lpdTa = document.querySelector('#modal-root textarea');
    check('sample-data expand modal opens a large editor with the current JSON',
      !!(lpdTa && lpdTa.value.indexOf('"disruptions"') !== -1),
      lpdTa ? lpdTa.value.length + ' chars' : 'no textarea in modal');
    const edited = Object.assign({}, LPState.getDoc().staticData, { modalEdit: true });
    lpdTa.value = JSON.stringify(edited);
    document.getElementById('lpd-apply').click();
    await sleep(300);
    check('modal Apply replaces the sample data', LPState.getDoc().staticData.modalEdit === true);
    const panelTa = document.getElementById('static-data-json');
    check('panel textarea re-synced via doc event and modal closed',
      !!(panelTa && panelTa.value.indexOf('modalEdit') !== -1 &&
        document.getElementById('modal-root').children.length === 0));

    /* sources tree expand modal: same interactive tree at comfortable size */
    document.querySelector('.panel-tab[data-panel="sources"]').click();
    await sleep(200);
    document.querySelector('[data-tree-expand]').click();
    await sleep(200);
    const modalLeaves = document.querySelectorAll('#modal-root .jt-leaf').length;
    check('tree expand modal renders the JSON tree', modalLeaves > 0, modalLeaves + ' leaves in modal');
    const firstKey = (document.querySelector('#modal-root .jt-key') || {}).textContent || '';
    const mSearch = document.querySelector('#modal-root [data-tree-search]');
    mSearch.value = firstKey;
    mSearch.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(200);
    const filtered = document.querySelectorAll('#modal-root .jt-leaf').length;
    check('tree search works inside the modal', filtered > 0 && filtered <= modalLeaves,
      filtered + ' leaves after searching "' + firstKey + '"');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await sleep(200);
    check('tree modal closes on Esc and the panel tree is restored',
      document.getElementById('modal-root').children.length === 0 &&
      document.querySelectorAll('#panel-sources .jt-leaf').length > 0);

    /* push modal: paste-friendly form fields + guarded async actions */
    window.LPPush.open();
    await sleep(200);
    const srvUrl = document.getElementById('srv-url');
    check('push modal opens with server fields', !!(srvUrl && document.getElementById('srv-token')));
    const ctxField = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    srvUrl.dispatchEvent(ctxField);
    check('context menu kept in form fields (paste works)', !ctxField.defaultPrevented);
    const ctxCanvas = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    document.getElementById('device-view').dispatchEvent(ctxCanvas);
    check('context menu still suppressed outside form fields', ctxCanvas.defaultPrevented);
    srvUrl.value = '';
    srvUrl.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-test').click();
    await waitFor(() => (document.getElementById('test-result') || {}).textContent.indexOf('✗') !== -1,
      8000, 'test connection error');
    check('test connection with empty URL shows an error (not stuck on Testing…)', true,
      document.getElementById('test-result').textContent);
    document.getElementById('btn-choose').click();
    await waitFor(() => {
      const t = (document.getElementById('pick-area') || {}).textContent || '';
      return t.length > 3 && t.indexOf('Loading') === -1;
    }, 8000, 'choose existing error');
    check('choose existing with empty URL shows an error (not stuck on Loading…)', true,
      document.getElementById('pick-area').textContent.trim().slice(0, 60));
    window.LPPush.close();
    await sleep(100);

    check('no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  }

  run().catch((e) => check('fatal', false, String((e && e.message) || e)))
    .then(report);
})();
