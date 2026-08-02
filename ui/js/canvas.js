/* Larapaper Studio — device canvas: live Liquid preview, selection, drag&drop. */
window.LPCanvas = (function () {
  let viewEl, stageEl, screenEl, markerEl, selBoxEl, scrollEl, statusLayoutEl;
  let gridOverlayEl, resizeHandleEl, gridColsEl, gridRowsEl;
  let currentGrid = { cols: 4, rows: 3 };
  let draggingId = null;
  let zoom = 1;

  /* ---------------- render ---------------- */
  function render() {
    const layout = LPState.getLayout();
    const doc = LPState.getDoc();
    const device = LPRecipe.normalizeDevice(doc.device || LPRecipe.DEFAULT_DEVICE);
    const size = LPRecipe.deviceLayoutSizes(device)[layout];

    viewEl.style.width = size.w + 'px';
    viewEl.style.height = size.h + 'px';
    viewEl.classList.toggle('lp-pad', layout !== 'full');
    viewEl.classList.toggle('lp-smallbar', layout !== 'full');
    if (statusLayoutEl) {
      statusLayoutEl.textContent = layout + ' · view ' + size.w + '×' + size.h + ' px · screen ' +
        device.width + '×' + device.height + ' ' + device.name;
    }

    const root = LPState.getRoot();
    if (!root) {
      viewEl.innerHTML =
        '<div class="lp-empty-layout">' +
        '<p>Layout <b>' + layout + '</b> is disabled.<br>It will not be included in the exported recipe.</p>' +
        '<div class="lp-empty-actions">' +
        '<button class="btn small" data-enable="empty">Start empty</button>' +
        '<button class="btn small" data-enable="copy">Copy from Full</button>' +
        '</div></div>';
      hideSelectionBox();
      return;
    }

    currentGrid = LPRecipe.normalizeGrid(root.grid, layout);
    syncGridInputs();

    let html;
    try {
      html = LPRender.html(doc, layout);
    } catch (e) {
      html = '<div class="lp-preview-error">Preview error: ' + String(e.message || e) + '</div>';
    }
    viewEl.innerHTML = html;
    viewEl.appendChild(gridOverlayEl);
    const cw = size.w / currentGrid.cols;
    const ch = size.h / currentGrid.rows;
    gridOverlayEl.style.backgroundSize = cw + 'px ' + ch + 'px';

    const layoutDiv = viewEl.querySelector('.layout');
    if (layoutDiv) layoutDiv.setAttribute('data-wid', 'root');
    const draggables = viewEl.querySelectorAll('[data-wid]');
    for (const el of draggables) {
      if (el.getAttribute('data-wid') !== 'root') el.setAttribute('draggable', 'true');
    }
    /* Condition affordances on root children (design-time only). A VISIBLE
       conditioned widget gets a ƒ corner badge (pointer-events:none, so drag
       & drop / selection are unaffected). A widget HIDDEN by its condition
       leaves its .lp-cell empty (the guard wraps the markup inside the cell,
       see recipe.js rootLiquid) — render a clickable ghost into the cell so
       the widget doesn't seem to vanish; the ghost carries data-wid so
       click-to-select opens the inspector. title_bar nodes are skipped:
       they're hoisted out of the grid (no cell to ghost into). */
    if (layoutDiv) {
      const cells = Array.prototype.filter.call(layoutDiv.children,
        (el) => el.classList && el.classList.contains('lp-cell'));
      LPRecipe.resolveAreas(root, currentGrid).forEach((r, i) => {
        const c = r.node.props && r.node.props.condition;
        if (!LPConditions.isValid(c)) return;
        const el = elForId(r.node.id);
        if (el) {
          if (!el.style.position) el.style.position = 'relative';
          const badge = document.createElement('span');
          badge.className = 'lp-cond-badge';
          badge.textContent = 'ƒ';
          badge.title = LPConditions.conditionSummary(c) || 'condition';
          el.appendChild(badge);
        } else {
          const cell = cells[i];
          if (!cell) return;
          const name = (LPWidgets.TYPES[r.node.type] || {}).name || r.node.type;
          const ghost = document.createElement('div');
          ghost.className = 'lp-ghost';
          ghost.setAttribute('data-wid', r.node.id); /* selection target; added after the draggables pass → non-draggable */
          ghost.textContent = 'ƒ ' + name + ' — hidden';
          ghost.title = 'ƒ ' + name + ' — hidden: ' + (LPConditions.conditionSummary(c) || 'condition');
          cell.appendChild(ghost);
        }
      });
    }
    updateSelectionBox();
  }

  /* ---------------- selection ---------------- */
  function elForId(id) {
    if (!id) return null;
    if (id === 'root') return viewEl.querySelector('.layout');
    return viewEl.querySelector('[data-wid="' + CSS.escape(id) + '"]');
  }

  function stageRect() { return stageEl.getBoundingClientRect(); }

  function placeBox(boxEl, rect) {
    const s = stageRect();
    boxEl.style.left = (rect.left - s.left) + 'px';
    boxEl.style.top = (rect.top - s.top) + 'px';
    boxEl.style.width = rect.width + 'px';
    boxEl.style.height = rect.height + 'px';
    boxEl.hidden = false;
  }

  function updateSelectionBox() {
    const el = elForId(LPState.getSelectedId());
    if (!el) { hideSelectionBox(); return; }
    placeBox(selBoxEl, el.getBoundingClientRect());
    updateResizeHandle();
  }
  function hideSelectionBox() { selBoxEl.hidden = true; resizeHandleEl.hidden = true; }

  /* ---------------- grid helpers ---------------- */
  function toast(msg, kind) { if (window.LPToast) window.LPToast(msg, kind); }

  function isRootChildId(id) {
    if (!id || id === 'root') return false;
    const p = LPState.findParent(id);
    return !!(p && p.isRoot);
  }

  /** Absolute px rect of a cell area on the (zoomed) view. */
  function cellRectPx(area) {
    const vr = viewEl.getBoundingClientRect();
    const cw = vr.width / currentGrid.cols;
    const ch = vr.height / currentGrid.rows;
    return {
      left: vr.left + area.x * cw,
      top: vr.top + area.y * ch,
      width: area.w * cw,
      height: area.h * ch
    };
  }

  /** Cell under the event, clamped so a w x h area still fits the grid. */
  function cellFromEvent(e, w, h) {
    const vr = viewEl.getBoundingClientRect();
    const cw = vr.width / currentGrid.cols;
    const ch = vr.height / currentGrid.rows;
    w = w || 1; h = h || 1;
    return {
      x: Math.max(0, Math.min(currentGrid.cols - w, Math.floor((e.clientX - vr.left) / cw))),
      y: Math.max(0, Math.min(currentGrid.rows - h, Math.floor((e.clientY - vr.top) / ch)))
    };
  }

  function syncGridInputs() {
    if (!gridColsEl || !gridRowsEl) return;
    if (document.activeElement !== gridColsEl) gridColsEl.value = currentGrid.cols;
    if (document.activeElement !== gridRowsEl) gridRowsEl.value = currentGrid.rows;
  }

  /* ---------------- resize handle (root children) ---------------- */
  function updateResizeHandle() {
    const id = LPState.getSelectedId();
    if (!isRootChildId(id) || selBoxEl.hidden) { resizeHandleEl.hidden = true; return; }
    resizeHandleEl.style.left = (parseFloat(selBoxEl.style.left) + parseFloat(selBoxEl.style.width) - 5) + 'px';
    resizeHandleEl.style.top = (parseFloat(selBoxEl.style.top) + parseFloat(selBoxEl.style.height) - 5) + 'px';
    resizeHandleEl.hidden = false;
  }

  function startResize(e) {
    const id = LPState.getSelectedId();
    if (!isRootChildId(id)) return;
    e.preventDefault();
    e.stopPropagation();
    const root = LPState.getRoot();
    const resolved = LPRecipe.resolveAreas(root, currentGrid).find((r) => r.node.id === id);
    if (!resolved) return;
    const startArea = resolved.area;
    const startX = e.clientX;
    const startY = e.clientY;
    const vr = viewEl.getBoundingClientRect();
    const cw = vr.width / currentGrid.cols; /* zoom already included */
    const ch = vr.height / currentGrid.rows;
    let cand = startArea;

    function onMove(ev) {
      const dw = Math.round((ev.clientX - startX) / cw);
      const dh = Math.round((ev.clientY - startY) / ch);
      cand = {
        x: startArea.x, y: startArea.y,
        w: Math.max(1, Math.min(currentGrid.cols - startArea.x, startArea.w + dw)),
        h: Math.max(1, Math.min(currentGrid.rows - startArea.y, startArea.h + dh))
      };
      placeBox(selBoxEl, cellRectPx(cand)); /* live preview */
      updateResizeHandle();
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (cand.w !== startArea.w || cand.h !== startArea.h) {
        LPState.setNodeArea(id, cand); /* single undo step */
      } else {
        updateSelectionBox();
      }
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  /* ---------------- zoom ---------------- */
  function setZoom(z) {
    zoom = Math.max(0.2, Math.min(2.5, z));
    screenEl.style.zoom = zoom;
    document.getElementById('zoom-label').textContent = Math.round(zoom * 100) + '%';
    updateSelectionBox();
  }
  function zoomIn() { setZoom(zoom + 0.1); }
  function zoomOut() { setZoom(zoom - 0.1); }
  function zoomFit() {
    const availW = scrollEl.clientWidth - 80;
    const availH = scrollEl.clientHeight - 80;
    setZoom(Math.max(0.2, Math.min(availW / 820, availH / 520)));
  }
  function getZoom() { return zoom; }

  /* ---------------- drag & drop ---------------- */

  function axisOf(node) {
    if (!node) return 'v';
    if (node.type === 'row') return 'h';
    if (node.type === 'grid') return 'g';
    return 'v'; /* col, list, root */
  }

  /** Direct element children that carry data-wid (in document order). */
  function directChildEls(el) {
    const out = [];
    (function walk(n) {
      for (const c of n.children) {
        if (c.hasAttribute && c.hasAttribute('data-wid')) out.push(c);
        else walk(c);
      }
    })(el);
    return out;
  }

  function insertionIndex(childEls, e, axis) {
    for (let i = 0; i < childEls.length; i++) {
      const r = childEls[i].getBoundingClientRect();
      if (axis === 'h') {
        if (e.clientX < r.left + r.width / 2) return i;
      } else if (axis === 'v') {
        if (e.clientY < r.top + r.height / 2) return i;
      } else { /* grid: reading order */
        if (e.clientY < r.top) return i;
        if (e.clientY < r.bottom && e.clientX < r.left + r.width / 2) return i;
      }
    }
    return childEls.length;
  }

  /**
   * Computes where a drop at the event position would land.
   * Root level → { grid:true, cell:{x,y}, w, h } (cell snap); inside nested
   * containers → legacy { parentId, index, containerEl, childEls, axis }.
   */
  function computeDrop(e) {
    const root = LPState.getRoot();
    if (!root) return null;
    let el = e.target && e.target.closest ? e.target.closest('[data-wid]') : null;
    if (!el || !viewEl.contains(el)) el = null;
    const id = el ? el.getAttribute('data-wid') : null;
    let node = !id || id === 'root' ? root : LPState.findNode(id);
    if (!node) node = root; /* stale element mid-drag → treat as root drop */
    const parent = node && !node.isRoot ? LPState.findParent(node.id) : null;
    const movingIsRootChild = draggingId && isRootChildId(draggingId);
    const insideDragged = draggingId && node && !node.isRoot &&
      !!LPState.findNode(node.id, LPState.findNode(draggingId) || undefined);

    /* root-level drop → snap to cell */
    if (!el || node.isRoot || insideDragged || (parent && parent.isRoot && (!LPWidgets.isContainer(node.type) || movingIsRootChild))) {
      let w = 1, h = 1;
      if (movingIsRootChild) {
        const a = LPRecipe.normalizeArea(LPState.findNode(draggingId).area, currentGrid);
        if (a) { w = a.w; h = a.h; }
      }
      return { grid: true, cell: cellFromEvent(e, w, h), w, h };
    }

    /* nested: container → insert among its children */
    const containerish = node.isRoot || LPWidgets.isContainer(node.type);
    if (containerish) {
      const childEls = directChildEls(el);
      const axis = axisOf(node);
      const index = insertionIndex(childEls, e, axis);
      return { parentId: node.id, index, containerEl: el, childEls, axis };
    }

    /* nested leaf widget: redirect to its parent container, before/after by midpoint */
    const parentEl = elForId(parent.id) || viewEl.querySelector('.layout');
    const childEls = directChildEls(parentEl);
    const axis = axisOf(parent);
    const pos = childEls.indexOf(el);
    const r = el.getBoundingClientRect();
    let after;
    if (axis === 'h') after = e.clientX > r.left + r.width / 2;
    else if (axis === 'v') after = e.clientY > r.top + r.height / 2;
    else after = (e.clientY > r.top + r.height / 2) || (e.clientY > r.top && e.clientX > r.left + r.width / 2);
    return { parentId: parent.id, index: pos === -1 ? childEls.length : pos + (after ? 1 : 0), containerEl: parentEl, childEls, axis };
  }

  function showMarker(drop) {
    if (!drop) { hideMarker(); return; }
    if (drop.grid) {
      /* root level: highlight the whole target cell rectangle */
      markerEl.classList.add('cell');
      placeBox(markerEl, cellRectPx({ x: drop.cell.x, y: drop.cell.y, w: drop.w, h: drop.h }));
      return;
    }
    markerEl.classList.remove('cell');
    const s = stageRect();
    const cr = drop.containerEl.getBoundingClientRect();
    let rect;
    if (drop.axis === 'h') {
      let x;
      if (drop.childEls.length === 0) x = cr.left + 6;
      else if (drop.index >= drop.childEls.length) x = drop.childEls[drop.childEls.length - 1].getBoundingClientRect().right + 3;
      else x = drop.childEls[drop.index].getBoundingClientRect().left - 3;
      rect = { left: x - 1.5, top: cr.top + 4, width: 3, height: Math.max(12, cr.height - 8) };
    } else {
      let y;
      if (drop.childEls.length === 0) y = cr.top + Math.min(8, cr.height / 2);
      else if (drop.index >= drop.childEls.length) y = drop.childEls[drop.childEls.length - 1].getBoundingClientRect().bottom + 3;
      else y = drop.childEls[drop.index].getBoundingClientRect().top - 3;
      rect = { left: cr.left + 4, top: y - 1.5, width: Math.max(12, cr.width - 8), height: 3 };
    }
    markerEl.style.left = (rect.left - s.left) + 'px';
    markerEl.style.top = (rect.top - s.top) + 'px';
    markerEl.style.width = rect.width + 'px';
    markerEl.style.height = rect.height + 'px';
    markerEl.hidden = false;
  }
  function hideMarker() { markerEl.hidden = true; }


  /* ---------------- event wiring ---------------- */

  let currentDrop = null;

  function onClick(e) {
    const enableBtn = e.target.closest ? e.target.closest('[data-enable]') : null;
    if (enableBtn) {
      LPState.enableLayout(LPState.getLayout(), enableBtn.getAttribute('data-enable') === 'copy' ? 'full' : null);
      return;
    }
    const el = e.target.closest ? e.target.closest('[data-wid]') : null;
    if (el && viewEl.contains(el)) {
      LPState.select(el.getAttribute('data-wid'));
    } else if (LPState.getRoot()) {
      LPState.select('root');
    }
  }

  function onDragStart(e) {
    const el = e.target.closest ? e.target.closest('[data-wid]') : null;
    if (!el) return;
    const id = el.getAttribute('data-wid');
    if (id === 'root') { e.preventDefault(); return; }
    draggingId = id;
    e.dataTransfer.setData('text/lp-move', id);
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('lp-dragging');
    try { e.dataTransfer.setDragImage(el, 10, 10); } catch (err) { /* ok */ }
  }

  function hasPayload(e) {
    const t = e.dataTransfer && e.dataTransfer.types;
    return t && (Array.from(t).indexOf('text/lp-type') !== -1 || Array.from(t).indexOf('text/lp-move') !== -1);
  }

  function onDragOver(e) {
    if (!hasPayload(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.dataTransfer.types && Array.from(e.dataTransfer.types).indexOf('text/lp-move') !== -1 ? 'move' : 'copy';
    currentDrop = computeDrop(e);
    showMarker(currentDrop);
  }

  function onDragLeave(e) {
    if (!viewEl.contains(e.relatedTarget)) { hideMarker(); currentDrop = null; }
  }

  /** Root-level drop: snap a new widget / moved child onto the cell grid. */
  function onGridDrop(drop, type, moveId) {
    const root = LPState.getRoot();
    if (!root) return;
    if (type) {
      const occupied = LPRecipe.resolveAreas(root, currentGrid).map((r) => r.area);
      const area = LPRecipe.firstFreeArea(currentGrid, occupied, 1, 1, drop.cell.x, drop.cell.y);
      if (!area) { toast('Grid is full — enlarge it or free a cell.', 'err'); return; }
      const node = LPWidgets.createNode(type);
      node.area = area;
      LPState.addNode('root', null, node);
      return;
    }
    if (!moveId) return;
    const occupied = LPRecipe.resolveAreas(root, currentGrid)
      .filter((r) => r.node.id !== moveId)
      .map((r) => r.area);
    const area = LPRecipe.firstFreeArea(currentGrid, occupied, drop.w, drop.h, drop.cell.x, drop.cell.y);
    if (!area) { toast('No free ' + drop.w + '×' + drop.h + ' cell fits here.', 'err'); return; }
    const parent = LPState.findParent(moveId);
    if (parent && parent.isRoot) {
      LPState.setNodeArea(moveId, area);
    } else {
      /* nested widget dragged out onto the root grid */
      LPState.moveNode(moveId, 'root', null);
      LPState.setNodeArea(moveId, area);
    }
  }

  function onDrop(e) {
    if (!hasPayload(e)) return;
    e.preventDefault();
    const drop = currentDrop || computeDrop(e);
    hideMarker();
    currentDrop = null;
    if (!drop) return;
    const type = e.dataTransfer.getData('text/lp-type');
    const moveId = e.dataTransfer.getData('text/lp-move');
    if (drop.grid) { onGridDrop(drop, type, moveId); return; }
    if (type) {
      LPState.addNode(drop.parentId, drop.index, LPWidgets.createNode(type));
      return;
    }
    if (moveId) {
      LPState.moveNode(moveId, drop.parentId, drop.index);
    }
  }

  function onDragEnd() {
    hideMarker();
    currentDrop = null;
    draggingId = null;
    const els = viewEl.querySelectorAll('.lp-dragging');
    for (const el of els) el.classList.remove('lp-dragging');
  }

  function init() {
    viewEl = document.getElementById('device-view');
    stageEl = document.getElementById('canvas-stage');
    screenEl = document.getElementById('device-screen');
    markerEl = document.getElementById('drop-marker');
    selBoxEl = document.getElementById('selection-box');
    scrollEl = document.getElementById('canvas-scroll');
    statusLayoutEl = document.getElementById('status-layout');

    /* cell grid overlay (re-appended into the view on every render) */
    gridOverlayEl = document.createElement('div');
    gridOverlayEl.id = 'grid-overlay';

    /* resize handle for selected root children */
    resizeHandleEl = document.createElement('div');
    resizeHandleEl.id = 'resize-handle';
    resizeHandleEl.hidden = true;
    resizeHandleEl.title = 'Drag to resize in cells';
    stageEl.appendChild(resizeHandleEl);
    resizeHandleEl.addEventListener('mousedown', startResize);

    /* grid cols × rows inputs in the statusbar */
    gridColsEl = document.getElementById('grid-cols');
    gridRowsEl = document.getElementById('grid-rows');
    function onGridInput() {
      LPState.setGrid({
        cols: parseInt(gridColsEl.value, 10),
        rows: parseInt(gridRowsEl.value, 10)
      });
    }
    if (gridColsEl && gridRowsEl) {
      gridColsEl.addEventListener('change', onGridInput);
      gridRowsEl.addEventListener('change', onGridInput);
    }

    LPWidgets.setPreviewIds(true);
    /* QR hook + placeholder chips are installed by LPRender (render.js) */

    viewEl.addEventListener('click', onClick);
    viewEl.addEventListener('dragstart', onDragStart);
    viewEl.addEventListener('dragover', onDragOver);
    viewEl.addEventListener('dragleave', onDragLeave);
    viewEl.addEventListener('drop', onDrop);
    viewEl.addEventListener('dragend', onDragEnd);
    window.addEventListener('resize', () => updateSelectionBox());
    scrollEl.addEventListener('scroll', () => { hideMarker(); updateSelectionBox(); });

    LPState.on('doc', render);
    LPState.on('selection', updateSelectionBox);
    render();
    setZoom(1);
  }

  return { init, render, zoomIn, zoomOut, zoomFit, getZoom, updateSelectionBox };
})();

