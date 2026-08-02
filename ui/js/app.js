/* Larapaper Studio — bootstrap: palette, layout tabs, toolbar, keyboard. */
(function () {
  'use strict';

  /* ---------------- toast ---------------- */
  window.LPToast = function (msg, kind) {
    const root = document.getElementById('toast-root');
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 3200);
    setTimeout(() => el.remove(), 3600);
  };
  const toast = window.LPToast;

  /* ---------------- palette ---------------- */
  function buildPalette() {
    const pal = document.getElementById('palette');
    let html = '<div class="palette-hint">Drag widgets onto the screen, or drag widgets on the canvas to move them.</div>';
    for (const group of LPWidgets.PALETTE) {
      html += '<div class="palette-group"><div class="palette-group-title">' + group.category + '</div>';
      for (const type of group.types) {
        const def = LPWidgets.TYPES[type];
        html += '<div class="palette-item" draggable="true" data-type="' + type + '">' +
          '<span class="pi-icon">' + (def.icon || '▫') + '</span><span class="pi-name">' + def.name + '</span></div>';
      }
      html += '</div>';
    }
    pal.innerHTML = html;
    pal.addEventListener('dragstart', (e) => {
      const item = e.target.closest('[data-type]');
      if (!item) return;
      e.dataTransfer.setData('text/lp-type', item.getAttribute('data-type'));
      e.dataTransfer.effectAllowed = 'copy';
    });
    /* double-click adds to the end of the root container */
    pal.addEventListener('dblclick', (e) => {
      const item = e.target.closest('[data-type]');
      if (!item || !LPState.getRoot()) return;
      LPState.addNode('root', null, LPWidgets.createNode(item.getAttribute('data-type')));
    });
  }

  /* ---------------- layout tabs ---------------- */
  const LAYOUT_LABELS = {
    full: 'Full', half_horizontal: 'Half H', half_vertical: 'Half V', quadrant: 'Quadrant'
  };

  function buildLayoutTabs() {
    const wrap = document.getElementById('layout-tabs');
    const doc = LPState.getDoc();
    const cur = LPState.getLayout();
    const sizes = LPRecipe.deviceLayoutSizes(doc.device || LPRecipe.DEFAULT_DEVICE);
    let html = '';
    for (const key of LPRecipe.LAYOUTS) {
      const size = sizes[key];
      const enabled = !!doc.layouts[key];
      html += '<button class="layout-tab' + (cur === key ? ' active' : '') + '" data-layout="' + key + '" role="tab">' +
        LAYOUT_LABELS[key] + '<span class="lt-dims">' + size.w + '×' + size.h + (enabled ? '' : ' · off') + '</span></button>';
    }
    html += '<div class="layout-actions">';
    if (cur !== 'full' && doc.layouts[cur]) {
      html += '<button class="tb-btn" id="btn-disable-layout">Disable this layout</button>';
    }
    html += '</div>';
    wrap.innerHTML = html;
    wrap.querySelectorAll('[data-layout]').forEach((btn) => {
      btn.addEventListener('click', () => LPState.setLayout(btn.getAttribute('data-layout')));
    });
    const dis = document.getElementById('btn-disable-layout');
    if (dis) dis.addEventListener('click', () => LPState.disableLayout(LPState.getLayout()));
  }

  /* ---------------- dirty / title ---------------- */
  function updateDirty() {
    const dirty = LPState.isDirty();
    document.getElementById('dirty-indicator').hidden = !dirty;
    const fp = LPState.getFilePath();
    const base = fp ? fp.split(/[\\/]/).pop() : 'Untitled';
    document.title = 'Larapaper Studio — ' + base + (dirty ? ' •' : '');
    document.getElementById('btn-undo').disabled = !LPState.canUndo();
    document.getElementById('btn-redo').disabled = !LPState.canRedo();
  }

  /* ---------------- project actions ---------------- */
  async function saveProject() {
    const json = LPState.serialize();
    const fp = LPState.getFilePath();
    const r = fp
      ? await window.lp.saveProjectTo({ filePath: fp, json })
      : await window.lp.saveProject({ json, suggestedName: LPState.getDoc().name });
    if (r.ok) { LPState.markSaved(r.filePath); toast('Saved ✓', 'ok'); }
    else if (!r.canceled) toast('Save failed: ' + r.error, 'err');
  }

  async function openProject() {
    if (LPState.isDirty() && !window.confirm('Discard unsaved changes?')) return;
    const r = await window.lp.openProject();
    if (!r.ok) { if (!r.canceled) toast('Open failed: ' + r.error, 'err'); return; }
    try {
      LPState.load(r.json, r.filePath);
      toast('Opened ✓', 'ok');
    } catch (e) {
      toast('Invalid project file: ' + e.message, 'err');
    }
  }

  function newProject() {
    if (LPState.isDirty() && !window.confirm('Discard unsaved changes?')) return;
    LPState.newDocument();
    seedStarter();
  }

  async function exportFiles(via) {
    const doc = LPState.getDoc();
    const errors = LPRecipe.validateDoc(doc);
    if (errors.length) { toast(errors.join(' '), 'err'); return; }
    const files = LPRecipe.buildRecipeFiles(doc);
    const r = via === 'zip'
      ? await window.lp.exportZip({ files, suggestedName: doc.name })
      : await window.lp.exportFolder({ files, suggestedName: doc.name });
    if (r.ok) toast(via === 'zip' ? 'ZIP exported ✓' : 'Exported to ' + r.folder, 'ok');
    else if (!r.canceled) toast('Export failed: ' + r.error, 'err');
  }

  /* ---------------- starter template (first run) ---------------- */
  function seedStarter() {
    const doc = LPState.getDoc();
    const root = doc.layouts.full;
    if (root.children && root.children.length) return;
    const bar = LPWidgets.createNode('title_bar');
    const value = LPWidgets.createNode('value');
    value.props.value = 'value';
    value.props.unit = '%';
    value.props.size = 'xlarge';
    value.props.caption = 'Sample value';
    const progress = LPWidgets.createNode('progress');
    const chart = LPWidgets.createNode('barchart');
    root.children.push(bar, value, progress, chart);
    LPState.emit('doc', { label: 'seed' });
  }

  /* ---------------- keyboard ---------------- */
  function isFormTarget(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }

  function onKeyDown(e) {
    const mod = e.ctrlKey || e.metaKey;
    /* desktop app: block browser reload shortcuts (would lose unsaved state) */
    if (e.key === 'F5' || (mod && e.key.toLowerCase() === 'r')) { e.preventDefault(); return; }
    /* modal open (push / preview): app shortcuts suspended — the modal handles its own keys */
    const mr = document.getElementById('modal-root');
    if (mr && mr.firstChild) return;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(); return; }
    if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); openProject(); return; }
    if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); newProject(); return; }
    if (isFormTarget(e)) return;
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); LPState.undo(); return; }
    if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); LPState.redo(); return; }
    if (mod && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      const id = LPState.getSelectedId();
      if (id && id !== 'root') LPState.duplicateNode(id);
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const id = LPState.getSelectedId();
      if (id && id !== 'root') { e.preventDefault(); LPState.removeNode(id); }
      return;
    }
    if (e.key === 'Escape') { LPState.select(null); return; }
    if (mod && (e.key === '+' || e.key === '=')) { e.preventDefault(); LPCanvas.zoomIn(); return; }
    if (mod && e.key === '-') { e.preventDefault(); LPCanvas.zoomOut(); return; }
  }

  /* ---------------- panel tabs ---------------- */
  function wirePanelTabs() {
    document.getElementById('panel-tabs').addEventListener('click', (e) => {
      const tab = e.target.closest('.panel-tab');
      if (!tab) return;
      document.querySelectorAll('.panel-tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.panel-page').forEach((p) => p.classList.remove('active'));
      document.getElementById('panel-' + tab.getAttribute('data-panel')).classList.add('active');
    });
  }

  /* ---------------- boot ---------------- */
  function wireToolbar() {
    document.getElementById('btn-new').addEventListener('click', newProject);
    document.getElementById('btn-open').addEventListener('click', openProject);
    document.getElementById('btn-save').addEventListener('click', saveProject);
    document.getElementById('btn-undo').addEventListener('click', () => LPState.undo());
    document.getElementById('btn-redo').addEventListener('click', () => LPState.redo());
    document.getElementById('btn-zoom-in').addEventListener('click', () => LPCanvas.zoomIn());
    document.getElementById('btn-zoom-out').addEventListener('click', () => LPCanvas.zoomOut());
    document.getElementById('btn-zoom-fit').addEventListener('click', () => LPCanvas.zoomFit());
    document.getElementById('btn-export-zip').addEventListener('click', () => exportFiles('zip'));
    document.getElementById('btn-export-folder').addEventListener('click', () => exportFiles('folder'));
    document.getElementById('btn-preview').addEventListener('click', () => window.LPPreview.open());
    document.getElementById('btn-push').addEventListener('click', () => window.LPPush.open());
  }

  function boot() {
    seedStarter();
    buildPalette();
    buildLayoutTabs();
    LPInspector.init();
    LPPanels.init();
    LPPanelSources.init();
    LPCanvas.init();
    wireToolbar();
    wirePanelTabs();
    /* desktop app: no browser context menu (Refresh would lose unsaved state) —
       but keep the native editing menu in form fields (right-click → Paste) */
    document.addEventListener('contextmenu', (e) => { if (!isFormTarget(e)) e.preventDefault(); });
    document.addEventListener('keydown', onKeyDown);
    LPState.on('doc', () => { buildLayoutTabs(); updateDirty(); });
    LPState.on('layout', buildLayoutTabs);
    LPState.on('dirty', updateDirty);
    updateDirty();
    window.__APP_READY = true;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

