/* Larapaper Studio — full-window device preview modal.
 * Clean render of the current design (same LPRender pipeline as the canvas),
 * no editor chrome: no grid overlay, selection box, drop marker or handles. */
window.LPPreview = (function () {
  let rootEl = null;
  let current = null;

  const LAYOUT_LABELS = {
    full: 'Full', half_horizontal: 'Half H', half_vertical: 'Half V', quadrant: 'Quadrant'
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function enabledLayouts(doc) {
    return LPRecipe.LAYOUTS.filter((k) => doc.layouts[k]);
  }

  function render() {
    const doc = LPState.getDoc();
    const enabled = enabledLayouts(doc);
    if (!enabled.length) return;
    if (enabled.indexOf(current) === -1) {
      current = enabled.indexOf(LPState.getLayout()) !== -1 ? LPState.getLayout() : enabled[0];
    }
    const device = LPRecipe.normalizeDevice(doc.device);
    const size = LPRecipe.deviceLayoutSizes(device)[current];

    let inner;
    try {
      inner = LPRender.html(doc, current);
    } catch (e) {
      inner = '<div class="lp-preview-error">Preview error: ' + esc(e.message || e) + '</div>';
    }

    rootEl.innerHTML =
      '<div class="modal-backdrop lpv-backdrop"><div class="lpv-modal">' +
      '<div class="lpv-head">' +
      '<div class="lpv-tabs">' + enabled.map((k) =>
        '<button class="layout-tab' + (k === current ? ' active' : '') + '" data-lpv="' + k + '" role="tab">' +
        LAYOUT_LABELS[k] + '</button>').join('') + '</div>' +
      '<span class="lpv-label">' + esc(device.name) + ' ' + device.width + '×' + device.height +
      ' · ' + current + ' ' + size.w + '×' + size.h + '</span>' +
      '<button class="btn small" id="lpv-close" title="Close (Esc)">✕</button>' +
      '</div>' +
      '<div class="lpv-stage"><div class="lpv-scale" id="lpv-scale">' +
      '<div class="lpv-screen"><div class="view lp-view' + (current !== 'full' ? ' lp-pad lp-smallbar' : '') + '"' +
      ' style="width:' + size.w + 'px;height:' + size.h + 'px">' + inner + '</div></div>' +
      '</div></div>' +
      '</div></div>';
    fit();
  }

  /* scale-to-fit: big portrait devices must fit the window */
  function fit() {
    const stage = rootEl && rootEl.querySelector('.lpv-stage');
    const scale = rootEl && rootEl.querySelector('#lpv-scale');
    if (!stage || !scale) return;
    const pad = 48;
    const w = scale.scrollWidth || scale.offsetWidth;
    const h = scale.scrollHeight || scale.offsetHeight;
    if (!w || !h) return;
    const s = Math.max(0.1, Math.min(2, Math.min(
      (stage.clientWidth - pad) / w,
      (stage.clientHeight - pad) / h)));
    scale.style.transform = 'scale(' + s + ')';
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  }

  function onResize() { fit(); }

  function onClick(e) {
    if (e.target.classList && e.target.classList.contains('lpv-backdrop')) { close(); return; }
    if (e.target.id === 'lpv-close') { close(); return; }
    const tab = e.target.closest ? e.target.closest('[data-lpv]') : null;
    if (tab) { current = tab.getAttribute('data-lpv'); render(); }
  }

  function open() {
    if (rootEl) return;
    current = LPState.getLayout();
    rootEl = document.createElement('div');
    document.getElementById('modal-root').appendChild(rootEl);
    render();
    rootEl.addEventListener('click', onClick);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onResize);
  }

  function close() {
    if (!rootEl) return;
    document.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('resize', onResize);
    rootEl.remove();
    rootEl = null;
  }

  return { open, close };
})();
