/* Larapaper Studio — document state, history, selection, mutation API.
 * Works on the flat LPRecipe document model; layouts may be null (disabled). */
window.LPState = (function () {
  let doc = LPRecipe.createDocument();
  let filePath = null;
  let dirty = false;
  let currentLayout = 'full';
  let selectedId = null;
  let undoStack = [];
  let redoStack = [];
  let lastCoalesce = { key: null, time: 0 };

  const listeners = {};
  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
  function emit(evt, arg) { (listeners[evt] || []).forEach((fn) => { try { fn(arg); } catch (e) { console.error(e); } }); }

  /* ---------------- accessors ---------------- */
  function getDoc() { return doc; }
  function getFilePath() { return filePath; }
  function isDirty() { return dirty; }
  function getLayout() { return currentLayout; }
  function getRoot() { return doc.layouts[currentLayout] || null; }
  function getSelectedId() { return selectedId; }

  function findNode(id, node) {
    node = node === undefined ? getRoot() : node;
    if (!node || !id) return null;
    if (node.id === id) return node;
    for (const c of node.children || []) {
      const hit = findNode(id, c);
      if (hit) return hit;
    }
    return null;
  }

  function findParent(id, node, parent) {
    node = node === undefined ? getRoot() : node;
    parent = parent === undefined ? null : parent;
    if (!node || !id) return null;
    if (node.id === id) return parent;
    for (const c of node.children || []) {
      const hit = findParent(id, c, node);
      if (hit) return hit;
    }
    return null;
  }

  function getSelectedNode() { return selectedId ? findNode(selectedId) : null; }

  /* ---------------- history ---------------- */
  function snapshot() { return JSON.stringify(doc); }
  function selectionValid() {
    return selectedId && (selectedId === 'root' ? !!getRoot() : !!findNode(selectedId));
  }

  function mutate(label, fn, opts) {
    opts = opts || {};
    const now = Date.now();
    const coalescable = opts.coalesceKey && lastCoalesce.key === opts.coalesceKey && now - lastCoalesce.time < 800;
    if (!coalescable) {
      undoStack.push(snapshot());
      if (undoStack.length > 120) undoStack.shift();
    }
    lastCoalesce = { key: opts.coalesceKey || null, time: now };
    redoStack = [];
    fn(doc);
    dirty = true;
    if (selectedId && !selectionValid()) selectedId = null;
    emit('doc', { label });
    emit('dirty');
  }

  function afterRestore() {
    dirty = true;
    lastCoalesce = { key: null, time: 0 };
    if (!doc.layouts[currentLayout]) currentLayout = 'full';
    if (selectedId && !selectionValid()) selectedId = null;
    emit('doc', { label: 'history' });
    emit('layout', currentLayout);
    emit('dirty');
  }

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    doc = JSON.parse(undoStack.pop());
    afterRestore();
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    doc = JSON.parse(redoStack.pop());
    afterRestore();
  }

  /* ---------------- selection & layout ---------------- */
  function select(id) {
    if (selectedId === id) return;
    selectedId = id;
    emit('selection', id);
  }

  function setLayout(layout) {
    if (LPRecipe.LAYOUTS.indexOf(layout) === -1 || currentLayout === layout) return;
    currentLayout = layout;
    selectedId = null;
    emit('layout', layout);
    emit('doc', { label: 'layout' });
    emit('selection', null);
  }

  function enableLayout(layout, copyFrom) {
    if (doc.layouts[layout]) return;
    mutate('enable-layout', (d) => {
      d.layouts[layout] = (copyFrom && d.layouts[copyFrom])
        ? LPWidgets.cloneWithNewIds(d.layouts[copyFrom])
        : LPRecipe.createRootNode(layout);
    });
  }

  function disableLayout(layout) {
    if (layout === 'full') return; /* full is mandatory */
    mutate('disable-layout', (d) => { d.layouts[layout] = null; });
  }

  /* ---------------- node mutations ---------------- */

  /** Root children live on a cell grid: assign the first free 1x1 cell. */
  function autoPlaceInRoot(root, node) {
    if (node.type === 'title_bar') return; /* bars are hoisted, not grid cells */
    const grid = LPRecipe.normalizeGrid(root.grid, currentLayout);
    const occupied = LPRecipe.resolveAreas(root, grid).map((r) => r.area);
    const a = LPRecipe.firstFreeArea(grid, occupied, 1, 1);
    if (a) node.area = a;
  }

  function addNode(parentId, index, node) {
    if (!getRoot()) return;
    mutate('add', () => {
      const parent = parentId === 'root' ? getRoot() : findNode(parentId);
      if (!parent) return;
      if (parent.isRoot && !node.area) autoPlaceInRoot(parent, node);
      if (!parent.isRoot && node.area) delete node.area;
      parent.children = parent.children || [];
      const max = LPWidgets.maxChildren(parent.type);
      while (parent.children.length >= max) parent.children.pop();
      const i = index == null ? parent.children.length : Math.max(0, Math.min(index, parent.children.length));
      parent.children.splice(i, 0, node);
    });
    select(node.id);
  }

  function replaceChildren(id, children) {
    mutate('replace-children', () => {
      const node = id === 'root' ? getRoot() : findNode(id);
      if (node) node.children = children;
    });
  }

  function removeNode(id) {
    if (id === 'root') return;
    mutate('remove', () => {
      const parent = findParent(id);
      if (!parent) return;
      parent.children = (parent.children || []).filter((c) => c.id !== id);
    });
    if (selectedId === id) select(null);
  }

  function moveNode(id, parentId, index) {
    if (id === 'root' || id === parentId) return false;
    const moving = findNode(id);
    if (!moving) return false;
    if (parentId !== 'root' && findNode(parentId, moving)) return false; /* into own subtree */
    let did = false;
    mutate('move', () => {
      const from = findParent(id);
      const node = findNode(id);
      if (!from || !node) return;
      const parent = parentId === 'root' ? getRoot() : findNode(parentId);
      if (!parent) return;
      /* `index` counts the moving node in its old slot (it is measured on the
       * canvas mid-drag), so a later slot in the same parent shifts down by one. */
      const oldIndex = (from.children || []).findIndex((c) => c.id === id);
      from.children = (from.children || []).filter((c) => c.id !== id);
      if (index != null && from === parent && oldIndex !== -1 && oldIndex < index) index--;
      if (parent.isRoot && !node.area) autoPlaceInRoot(parent, node);
      if (!parent.isRoot && node.area) delete node.area;
      parent.children = parent.children || [];
      const max = LPWidgets.maxChildren(parent.type);
      while (parent.children.length >= max) parent.children.pop();
      let i = index == null ? parent.children.length : index;
      i = Math.max(0, Math.min(i, parent.children.length));
      parent.children.splice(i, 0, node);
      did = true;
    });
    if (did) select(id);
    return did;
  }

  function updateProps(id, patch, coalesceKey) {
    mutate('props', () => {
      const node = id === 'root' ? getRoot() : findNode(id);
      if (node) node.props = Object.assign({}, node.props, patch);
    }, { coalesceKey: coalesceKey || null });
  }

  function duplicateNode(id) {
    if (id === 'root') return;
    const node = findNode(id);
    const parent = findParent(id);
    if (!node || !parent) return;
    const copy = LPWidgets.cloneWithNewIds(node);
    mutate('duplicate', () => {
      const p = findParent(id);
      const idx = (p.children || []).findIndex((c) => c.id === id);
      if (p.isRoot) delete copy.area; /* re-place instead of stacking on the original */
      if (p.isRoot) autoPlaceInRoot(p, copy);
      p.children.splice(idx + 1, 0, copy);
    });
    select(copy.id);
  }

  /* ---------------- grid (root placement) ---------------- */
  function getGrid() {
    const root = getRoot();
    return LPRecipe.normalizeGrid(root && root.grid, currentLayout);
  }

  /** Resize the current layout's grid; existing areas are clamped into it. */
  function setGrid(patch) {
    if (!getRoot()) return;
    mutate('grid', (d) => {
      const root = d.layouts[currentLayout];
      if (!root) return;
      root.grid = LPRecipe.normalizeGrid({
        cols: patch.cols !== undefined ? patch.cols : (root.grid || {}).cols,
        rows: patch.rows !== undefined ? patch.rows : (root.grid || {}).rows
      }, currentLayout);
      (root.children || []).forEach((c) => {
        if (c.area) c.area = LPRecipe.normalizeArea(c.area, root.grid);
      });
    }, { coalesceKey: 'grid:' + currentLayout });
  }

  /** Move/resize a direct root child on the cell grid (clamped). */
  function setNodeArea(id, area, coalesceKey) {
    mutate('area', (d) => {
      const root = d.layouts[currentLayout];
      if (!root) return;
      const node = (root.children || []).find((c) => c.id === id);
      if (!node) return;
      const a = LPRecipe.normalizeArea(area, LPRecipe.normalizeGrid(root.grid, currentLayout));
      if (a) node.area = a;
    }, { coalesceKey: coalesceKey || null });
  }

  /* ---------------- document-level mutations ---------------- */
  const META_KEYS = ['name', 'description', 'strategy', 'refreshInterval', 'pollingUrl',
    'pollingVerb', 'pollingHeaders', 'pollingBody', 'frameworkVersion', 'darkMode', 'noScreenPadding'];

  function updateMeta(patch, coalesceKey) {
    mutate('meta', (d) => {
      for (const k of Object.keys(patch)) if (META_KEYS.indexOf(k) !== -1) d[k] = patch[k];
    }, { coalesceKey: coalesceKey || null });
  }

  function updateServer(patch, coalesceKey) {
    mutate('server', (d) => { d.server = Object.assign({}, d.server, patch); },
      { coalesceKey: coalesceKey || null });
  }

  function setStaticData(obj) {
    mutate('static-data', (d) => { d.staticData = obj; });
  }

  /** Merges keys into staticData (e.g. sample data fetched from a source). */
  function mergeStaticData(obj) {
    mutate('static-data-merge', (d) => {
      d.staticData = Object.assign({}, d.staticData, obj);
    });
  }

  /* ---------------- device profile ---------------- */
  function updateDevice(patch, coalesceKey) {
    mutate('device', (d) => {
      d.device = Object.assign(LPRecipe.normalizeDevice(d.device), patch);
    }, { coalesceKey: coalesceKey || null });
  }

  /* ---------------- API data sources ---------------- */
  function addSource(source) {
    mutate('src-add', (d) => {
      d.sources = Array.isArray(d.sources) ? d.sources : [];
      d.sources.push(source);
    });
  }

  function updateSource(id, patch, coalesceKey) {
    mutate('src-update', (d) => {
      const s = (d.sources || []).find((x) => x.id === id);
      if (s) Object.assign(s, patch);
    }, { coalesceKey: coalesceKey || null });
  }

  function removeSource(id) {
    mutate('src-remove', (d) => {
      d.sources = (d.sources || []).filter((x) => x.id !== id);
    });
  }

  function addCustomField() {
    mutate('cf-add', (d) => {
      let n = d.customFields.length + 1;
      while (d.customFields.some((f) => f.keyname === 'field_' + n)) n++;
      d.customFields.push({
        keyname: 'field_' + n, name: 'Field ' + n, fieldType: 'string',
        default: '', placeholder: '', description: '', options: []
      });
    });
  }

  function updateCustomField(index, patch, coalesceKey) {
    mutate('cf-update', (d) => {
      if (d.customFields[index]) d.customFields[index] = Object.assign({}, d.customFields[index], patch);
    }, { coalesceKey: coalesceKey || null });
  }

  function removeCustomField(index) {
    mutate('cf-remove', (d) => { d.customFields.splice(index, 1); });
  }


  /* ---------------- load / save ---------------- */
  function serialize() {
    const out = Object.assign({ app: 'larapaper-studio', formatVersion: 1 }, doc);
    /* strip secret header values unless the source opted into saving them */
    out.sources = LPSources.serializeSources(doc.sources || []);
    return JSON.stringify(out, null, 2);
  }

  function validRoot(node) {
    return node && typeof node === 'object' && node.id === 'root' && node.type &&
      typeof node.props === 'object' && node.props !== null;
  }

  function migrate(raw) {
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
    /* older project files have no device profile / sources — default them */
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

  function load(json, path) {
    const parsed = typeof json === 'string' ? JSON.parse(json) : json;
    doc = migrate(parsed);
    filePath = path || null;
    dirty = false;
    currentLayout = 'full';
    selectedId = null;
    undoStack = []; redoStack = [];
    lastCoalesce = { key: null, time: 0 };
    emit('doc', { label: 'load' });
    emit('layout', currentLayout);
    emit('selection', null);
    emit('dirty');
  }

  function newDocument() {
    load(JSON.stringify(LPRecipe.createDocument()), null);
  }

  function markSaved(path) {
    if (path) filePath = path;
    dirty = false;
    emit('dirty');
  }

  return {
    on, emit,
    getDoc, getFilePath, isDirty, getLayout, getRoot,
    findNode, findParent, getSelectedId, getSelectedNode,
    undo, redo,
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    select, setLayout, enableLayout, disableLayout,
    addNode, replaceChildren, removeNode, moveNode, updateProps, duplicateNode,
    getGrid, setGrid, setNodeArea,
    updateMeta, updateServer, setStaticData, mergeStaticData, updateDevice,
    addSource, updateSource, removeSource,
    addCustomField, updateCustomField, removeCustomField,
    serialize, load, newDocument, markSaved
  };
})();

