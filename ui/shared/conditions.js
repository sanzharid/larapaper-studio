/**
 * Widget conditions: a small rule model (node.props.condition) plus the
 * generator that wraps a widget's Liquid markup in bog-standard Liquid
 * guards (capture/assign/for/if/unless + basic filters only — the exported
 * recipe must render in Larapaper's own Liquid engine).
 *
 * Model:
 *   { enabled: true,
 *     op: 'mentions'|'not_mentions'|'equals'|'not_equals'|'present'|'blank',
 *     path: 'data.disruptions',          // liquid path (array or value)
 *     fields: ['title', 'description'],  // mentions ops on ARRAYS: item fields to search
 *     value: '34' }                      // needle / comparison literal
 *
 * mentions semantics ("intelligent text search"): haystack and needle are
 * lowercased, punctuation , . ! ? ; : becomes a space, whitespace collapses
 * and both are wrapped in single spaces — so '34' matches "Bus 34" but not
 * "134" or "340" (word-boundary-ish matching with plain `contains`).
 *
 * UMD: usable from renderer and Node tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LPConditions = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const OPS = ['mentions', 'not_mentions', 'equals', 'not_equals', 'present', 'blank'];
  const MENTION_OPS = ['mentions', 'not_mentions'];
  const VALUE_OPS = ['mentions', 'not_mentions', 'equals', 'not_equals'];

  const OP_LABELS = {
    mentions: 'mentions',
    not_mentions: "doesn't mention",
    equals: 'equals',
    not_equals: 'not equals',
    present: 'is present',
    blank: 'is blank'
  };

  /* Punctuation normalized to a space in BOTH haystack and needle. Quotes are
   * stripped from the needle as well (keeps the generated literal safely
   * single-quoted — standard Liquid has no escape sequences). */
  const PUNCT = /[,.!?;:'"]/g;

  /* Filter chain applied to the haystack (and mirrored in the needle at
   * generation time by normalizeNeedle). */
  const HAY_NORM = " | downcase | replace: ',', ' ' | replace: '.', ' ' | replace: '!', ' '" +
    " | replace: '?', ' ' | replace: ';', ' ' | replace: ':', ' ' | prepend: ' ' | append: ' '";

  /* ---------------- path helpers (sample-data introspection) ---------------- */

  /** 'data.disruptions[0].title' → ['disruptions', '0', 'title'] ('data.' prefix stripped). */
  function parsePath(path) {
    const segs = [];
    String(path == null ? '' : path).replace(/[^.[\]]+|\[(\d+)\]/g, (m, idx) => {
      segs.push(idx !== undefined ? idx : m);
      return m;
    });
    if (segs[0] === 'data') segs.shift();
    return segs;
  }

  /** Resolves a liquid-ish path against a plain data object (doc.staticData). */
  function valueAtPath(data, path) {
    if (!data || typeof data !== 'object') return undefined;
    let cur = data;
    for (const seg of parsePath(path)) {
      if (cur === null || cur === undefined) return undefined;
      cur = cur[seg];
    }
    return cur;
  }

  /**
   * Longest ancestor prefix of `path` whose value is an ARRAY, returned as a
   * plain JSON path ('disruptions' / 'disruptions[0].affectedLines'), or null.
   */
  function nearestArrayPath(data, path) {
    if (!data || typeof data !== 'object') return null;
    const segs = parsePath(path);
    let cur = data;
    let curPath = '';
    let found = null;
    for (const seg of segs) {
      if (cur === null || typeof cur !== 'object') break;
      if (Array.isArray(cur)) {
        found = curPath;
        cur = cur[parseInt(seg, 10)];
        curPath += '[' + seg + ']';
      } else {
        cur = cur[seg];
        curPath += (curPath ? '.' : '') + seg;
      }
    }
    if (Array.isArray(cur)) found = curPath; /* the path itself points at an array */
    return found;
  }

  /**
   * String fields of the object items of the array at `path`, e.g.
   * ['title', 'description', 'affectedLines.publicName'] — a middle segment
   * that is itself an array of objects yields dotted entries (these generate
   * `| map: 'key'` expressions).
   */
  function arrayItemFields(data, path) {
    const arr = valueAtPath(data, path);
    if (!Array.isArray(arr)) return [];
    const out = [];
    const items = arr.filter((it) => it && typeof it === 'object' && !Array.isArray(it)).slice(0, 5);
    for (const it of items) {
      for (const k of Object.keys(it)) {
        const v = it[k];
        if (typeof v === 'string') {
          if (out.indexOf(k) === -1) out.push(k);
        } else if (Array.isArray(v)) {
          const sub = v.find((x) => x && typeof x === 'object' && !Array.isArray(x));
          if (sub) {
            for (const sk of Object.keys(sub)) {
              if (typeof sub[sk] === 'string' && out.indexOf(k + '.' + sk) === -1) out.push(k + '.' + sk);
            }
          }
        }
      }
    }
    return out;
  }

  /* ---------------- literals & needle ---------------- */

  /**
   * Generation-time needle normalization: downcase, punctuation → space,
   * collapse whitespace, wrap in single spaces. 'Bus 34!' → ' bus 34 '.
   */
  function normalizeNeedle(value) {
    let s = String(value == null ? '' : value).toLowerCase();
    s = s.replace(PUNCT, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    return s === '' ? '' : ' ' + s + ' ';
  }

  /**
   * Liquid literal for equals/not_equals: real numbers/booleans (and the
   * literals 'true'/'false') pass bare; strings are quoted — '34' stays '34'
   * so string fields (e.g. GVB publicName) compare correctly server-side —
   * unless the sample data holds a number at the path: Liquid's `0 == '0'` is
   * false, so a typed '0' must then be emitted as the number 0.
   */
  function literal(value, sampleValue) {
    if (typeof value === 'number' && isFinite(value)) return String(value);
    if (typeof value === 'boolean') return String(value);
    const s = String(value == null ? '' : value).trim();
    if (s === 'true' || s === 'false') return s;
    if (typeof sampleValue === 'number' && /^-?\d+(\.\d+)?$/.test(s)) return s;
    if (s.indexOf("'") === -1) return "'" + s + "'";
    if (s.indexOf('"') === -1) return '"' + s + '"';
    return "'" + s.replace(/'/g, "\\'") + "'";
  }

  /** Structural validity (no sample data needed): enabled + op + path + value where required. */
  function isValid(condition) {
    if (!condition || typeof condition !== 'object' || !condition.enabled) return false;
    if (OPS.indexOf(condition.op) === -1) return false;
    if (!String(condition.path || '').trim()) return false;
    if (VALUE_OPS.indexOf(condition.op) !== -1 && String(condition.value == null ? '' : condition.value).trim() === '') return false;
    return true;
  }

  /* ---------------- generator ---------------- */

  /**
   * Per-field haystack emission inside the item loop.
   * Simple field → '{{ _lp_i.title }} '. A two-segment field whose middle
   * segment is an ARRAY of objects in the sample items (e.g.
   * affectedLines.publicName) → '{{ _lp_i.affectedLines | map: 'publicName' | join: ' ' }} '.
   * Anything else falls back to plain dotted emission.
   */
  function fieldExpr(field, items) {
    const parts = field.split('.');
    if (parts.length === 2 && items.some((it) => Array.isArray(it[parts[0]]))) {
      return '{{ _lp_i.' + parts[0] + " | map: '" + parts[1] + "' | join: ' ' }} ";
    }
    return '{{ _lp_i.' + field + ' }} ';
  }

  /**
   * Builds the Liquid guard wrapping a widget. Returns { open, close };
   * both empty strings when the condition is disabled or invalid.
   * sampleData (doc.staticData) decides array-vs-value and map emission.
   */
  function generateGuard(condition, sampleData) {
    const none = { open: '', close: '' };
    if (!isValid(condition)) return none;
    const op = condition.op;
    const path = String(condition.path).trim();

    if (MENTION_OPS.indexOf(op) !== -1) {
      const needle = normalizeNeedle(condition.value);
      if (!needle) return none;
      const kw = op === 'mentions' ? 'if' : 'unless';
      const close = op === 'mentions' ? '{% endif %}' : '{% endunless %}';
      const target = valueAtPath(sampleData, path);
      let open;
      if (Array.isArray(target)) {
        const fields = (Array.isArray(condition.fields) ? condition.fields : [])
          .map((f) => String(f).trim()).filter(Boolean);
        let body;
        if (fields.length) {
          const items = target.filter((it) => it && typeof it === 'object' && !Array.isArray(it)).slice(0, 5);
          body = fields.map((f) => fieldExpr(f, items)).join('');
        } else {
          /* no fields selected: search the whole item (shallow — objects
             stringify; prefer picking explicit fields) */
          body = '{{ _lp_i }} ';
        }
        open = '{% capture _lp_hay %}{% for _lp_i in ' + path + ' %}' + body + '{% endfor %}{% endcapture %}' +
          '{% assign _lp_hay = _lp_hay' + HAY_NORM + ' %}' +
          '{% ' + kw + " _lp_hay contains '" + needle + "' %}";
      } else {
        open = '{% assign _lp_hay = ' + path + HAY_NORM + ' %}' +
          '{% ' + kw + " _lp_hay contains '" + needle + "' %}";
      }
      return { open, close };
    }

    if (op === 'equals' || op === 'not_equals') {
      return {
        open: '{% if ' + path + (op === 'equals' ? ' == ' : ' != ') + literal(condition.value, valueAtPath(sampleData, path)) + ' %}',
        close: '{% endif %}'
      };
    }
    if (op === 'present') return { open: '{% if ' + path + ' != blank %}', close: '{% endif %}' };
    return { open: '{% if ' + path + ' == blank %}', close: '{% endif %}' };
  }

  /** Wraps a node's generated Liquid in its condition guard (no-op when invalid). */
  function wrapLiquid(node, liquid, sampleData) {
    const g = generateGuard(node && node.props && node.props.condition, sampleData);
    if (!g.open) return liquid;
    return g.open + '\n' + liquid + '\n' + g.close;
  }

  /** Short human summary, e.g. 'data.disruptions mentions "34"'. '' when inactive. */
  function conditionSummary(condition) {
    if (!isValid(condition)) return '';
    let s = String(condition.path).trim() + ' ' + (OP_LABELS[condition.op] || condition.op);
    if (VALUE_OPS.indexOf(condition.op) !== -1) s += ' "' + String(condition.value) + '"';
    return s;
  }

  return {
    OPS,
    MENTION_OPS,
    VALUE_OPS,
    OP_LABELS,
    parsePath,
    valueAtPath,
    nearestArrayPath,
    arrayItemFields,
    normalizeNeedle,
    literal,
    isValid,
    generateGuard,
    wrapLiquid,
    conditionSummary
  };
});
