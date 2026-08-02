/* Larapaper Studio — shared design-time render pipeline.
 * One place that turns (doc, layout) into preview HTML: buildViewParts +
 * buildPreviewContext + LiquidEval, with the QR hook installed and
 * unresolved bindings shown as placeholder chips. Used by the canvas
 * (LPCanvas) and the full-window preview (LPPreview). */
window.LPRender = (function () {
  'use strict';

  /* QR hook for the preview evaluator (qrcode-generator global). */
  function qrSvg(text, moduleSize, ec) {
    try {
      const q = window.qrcode(0, ['L', 'M', 'Q', 'H'].indexOf(ec) !== -1 ? ec : 'M');
      q.addData(String(text));
      q.make();
      const cell = Math.max(1, Math.min(11, parseInt(moduleSize, 10) || 4));
      return q.createSvgTag({ cellSize: cell, margin: 4, scalable: true });
    } catch (e) {
      return '<svg viewBox="0 0 29 29" style="width:100%;height:100%"><rect width="29" height="29" fill="#000"/>' +
        '<text x="14" y="15" fill="#fff" font-size="4" text-anchor="middle">QR err</text></svg>';
    }
  }

  LiquidEval.setHooks({ qrCode: qrSvg });

  /** Preview HTML for one layout; throws when evaluation fails. */
  function html(doc, layout) {
    const parts = LPRecipe.buildViewParts(doc, layout);
    const ctx = LPRecipe.buildPreviewContext(doc, layout);
    return LiquidEval.render(parts.layoutHtml + parts.barHtml, ctx, { placeholderUnknown: true });
  }

  return { qrSvg, html };
})();
