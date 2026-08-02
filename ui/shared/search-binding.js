/**
 * Search-and-pick bindings: a small spec model (node.props.search) plus the
 * generator that turns it into bog-standard Liquid picking display text out
 * of API data by a search query (capture/assign/for/if + basic filters only —
 * the exported recipe must render in Larapaper's own Liquid engine).
 *
 * Model:
 *   { enabled: true,
 *     targetProp: 'text',                  // widget prop the generated liquid overrides
 *     path: 'data.disruptions',            // liquid path to an ARRAY of items
 *     fields: ['title'],                   // item fields searched (joined per item)
 *     match: 'begins'|'contains'|'equals', // match mode on the joined field text
 *     query: 'metro 52',
 *     display: 'title',                    // item field to display (may differ from fields)
 *     pick: 1 }                            // 1-based hit index; 0 = all (joined), -1 = last
 *
 * Generated shape (contains, single field, pick 1):
 *   {% assign _lp_seen = false %}{% capture _lp_hits %}{% for _lp_i in data.disruptions %}{% assign _lp_s = _lp_i.title | downcase %}{% if _lp_s contains 'metro 52' %}{% if _lp_seen %}||{% endif %}{{ _lp_i.title }}{% assign _lp_seen = true %}{% endif %}{% endfor %}{% endcapture %}{% assign _lp_hits = _lp_hits | split: '||' %}{{ _lp_hits[0] }}
 *
 * The `||` delimiter is emitted BETWEEN hits only (the `_lp_seen` flag tracks
 * "a hit was already emitted"): a trailing delimiter would split into an
 * empty tail element and break `| last` / `| join: ', '`, and a leading one
 * would break `_lp_hits[0]`. Caveat: an item containing a literal '||' would
 * still split into phantom hits — acceptable for e-ink dashboard text; pick a
 * different delimiter here if it ever bites. `_lp_seen` is reset before every
 * binding so several search bindings can coexist in one layout.
 *
 * begins-with is prefix equality via `truncate: <len>, ''` (slice is NOT
 * supported by the preview evaluator — truncate with an empty ellipsis is,
 * and exists in standard Liquid, so preview == export).
 *
 * UMD: usable from renderer and Node tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./conditions'));
  } else {
    root.LPSearch = factory(root.LPConditions);
  }
})(typeof self !== 'undefined' ? self : this, function (Conditions) {
  'use strict';

  const MATCH_MODES = ['begins', 'contains', 'equals'];
  const MATCH_LABELS = { begins: 'begins', contains: 'contains', equals: 'equals' };

  function cleanFields(fields) {
    return (Array.isArray(fields) ? fields : []).map((f) => String(f).trim()).filter(Boolean);
  }

  function modeOf(spec) {
    const m = spec.match === undefined ? 'contains' : spec.match;
    return MATCH_MODES.indexOf(m) !== -1 ? m : null;
  }

  /**
   * Generation-time query normalization: downcase, strip quotes (keeps the
   * generated literal safely single-quoted — standard Liquid has no escape
   * sequences), collapse whitespace. evaluate() mirrors this exactly.
   */
  function normalizeQuery(query) {
    return String(query == null ? '' : query)
      .toLowerCase()
      .replace(/['"]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Structural validity (no sample data needed): enabled + array path + mode + query. */
  function isValid(spec) {
    if (!spec || typeof spec !== 'object' || !spec.enabled) return false;
    if (!String(spec.path || '').trim()) return false;
    if (!modeOf(spec)) return false;
    if (!normalizeQuery(spec.query)) return false;
    return true;
  }

  function pickOf(spec) {
    const n = parseInt(spec.pick, 10);
    return isNaN(n) ? 1 : n;
  }

  /* ---------------- field expressions (Liquid side) ---------------- */

  /**
   * Filter-chain expression reading a field off _lp_i. A two-segment field
   * whose middle segment is an ARRAY of objects in the sample items (e.g.
   * affectedLines.publicName) emits the map/join form, like conditions.js.
   */
  function searchChain(field, items) {
    const parts = field.split('.');
    if (parts.length === 2 && items.some((it) => Array.isArray(it[parts[0]]))) {
      return '_lp_i.' + parts[0] + " | map: '" + parts[1] + "' | join: ' '";
    }
    return '_lp_i.' + field;
  }

  function fieldOutput(field, items) {
    return '{{ ' + searchChain(field, items) + ' }}';
  }

  /** Output expression for the display field (', '-joined for nested arrays). */
  function displayOutput(spec, fields, items) {
    const d = String(spec.display || '').trim() || fields[0] || '';
    if (!d) return '{{ _lp_i }}';
    const parts = d.split('.');
    if (parts.length === 2 && items.some((it) => Array.isArray(it[parts[0]]))) {
      return '{{ _lp_i.' + parts[0] + " | map: '" + parts[1] + "' | join: ', ' }}";
    }
    return '{{ _lp_i.' + d + ' }}';
  }

  /* ---------------- generator ---------------- */

  /**
   * Builds the standard-Liquid string for a valid spec. sampleData
   * (doc.staticData) only decides map/join emission for nested-array fields.
   * Returns '' for disabled/invalid specs.
   */
  function generate(spec, sampleData) {
    if (!isValid(spec)) return '';
    const path = String(spec.path).trim();
    const mode = modeOf(spec);
    const fields = cleanFields(spec.fields);
    const needle = normalizeQuery(spec.query);
    const arr = Conditions.valueAtPath(sampleData, path);
    const items = Array.isArray(arr)
      ? arr.filter((it) => it && typeof it === 'object' && !Array.isArray(it)).slice(0, 5)
      : [];

    /* per-item searched text _lp_s (downcased) */
    let setup;
    if (fields.length === 0) {
      setup = '{% assign _lp_s = _lp_i | downcase %}';
    } else if (fields.length === 1) {
      setup = '{% assign _lp_s = ' + searchChain(fields[0], items) + ' | downcase %}';
    } else {
      setup = '{% capture _lp_s %}' + fields.map((f) => fieldOutput(f, items)).join(' ') + '{% endcapture %}' +
        '{% assign _lp_s = _lp_s | downcase %}';
    }

    const lit = "'" + needle + "'";
    /* delimiter BETWEEN hits only (see header) */
    const hit = '{% if _lp_seen %}||{% endif %}' + displayOutput(spec, fields, items) + '{% assign _lp_seen = true %}';
    let match;
    if (mode === 'contains') {
      /* `contains` is a condition operator, not assignable — inline if */
      match = '{% if _lp_s contains ' + lit + ' %}' + hit + '{% endif %}';
    } else if (mode === 'begins') {
      match = '{% assign _lp_p = _lp_s | truncate: ' + needle.length + ", '' %}" +
        '{% if _lp_p == ' + lit + ' %}' + hit + '{% endif %}';
    } else { /* equals */
      match = '{% if _lp_s == ' + lit + ' %}' + hit + '{% endif %}';
    }

    const pick = pickOf(spec);
    let pickOut;
    if (pick === 0) pickOut = "{{ _lp_hits | join: ', ' }}";
    else if (pick === -1) pickOut = '{{ _lp_hits | last }}';
    else pickOut = '{{ _lp_hits[' + Math.max(0, pick - 1) + '] }}';

    return '{% assign _lp_seen = false %}{% capture _lp_hits %}{% for _lp_i in ' + path + ' %}' + setup + match + '{% endfor %}{% endcapture %}' +
      "{% assign _lp_hits = _lp_hits | split: '||' %}" + pickOut;
  }

  /* ---------------- JS mirror (UI picker + tests) ---------------- */

  /** Text of one item field; nested-array fields join with `sep` (mirrors the Liquid). */
  function fieldText(item, field, sep) {
    if (!item || typeof item !== 'object') return '';
    const parts = field.split('.');
    if (parts.length === 2 && Array.isArray(item[parts[0]])) {
      return item[parts[0]]
        .map((x) => (x && typeof x === 'object' ? x[parts[1]] : x))
        .filter((v) => v !== null && v !== undefined)
        .map(String)
        .join(sep);
    }
    const v = Conditions.valueAtPath(item, field);
    return v === null || v === undefined ? '' : String(v);
  }

  /** Downcased joined search text for one item — mirrors _lp_s exactly. */
  function haystack(item, fields) {
    if (!fields.length) {
      try { return JSON.stringify(item).toLowerCase(); } catch (e) { return String(item).toLowerCase(); }
    }
    return fields.map((f) => fieldText(item, f, ' ')).join(' ').toLowerCase();
  }

  function isMatch(hay, needle, mode) {
    if (mode === 'begins') return hay.slice(0, needle.length) === needle;
    if (mode === 'equals') return hay === needle;
    return hay.indexOf(needle) !== -1;
  }

  /** Display text for one item — mirrors displayOutput. */
  function displayText(item, spec, fields) {
    const d = String(spec.display || '').trim() || fields[0] || '';
    if (!d) {
      try { return JSON.stringify(item); } catch (e) { return String(item); }
    }
    return fieldText(item, d, ', ');
  }

  /**
   * JS mirror of the generated Liquid: same normalization, same modes.
   * Returns { matches: [...display-field values in array order...], count }.
   */
  function evaluate(spec, sampleData) {
    const none = { matches: [], count: 0 };
    if (!isValid(spec)) return none;
    const arr = Conditions.valueAtPath(sampleData, String(spec.path).trim());
    if (!Array.isArray(arr)) return none;
    const fields = cleanFields(spec.fields);
    const needle = normalizeQuery(spec.query);
    const mode = modeOf(spec);
    const matches = [];
    for (const item of arr) {
      if (isMatch(haystack(item, fields), needle, mode)) matches.push(displayText(item, spec, fields));
    }
    return { matches, count: matches.length };
  }

  /** The string the widget displays right now under the current pick. */
  function picked(spec, sampleData) {
    const r = evaluate(spec, sampleData);
    if (!r.count) return '';
    const pick = pickOf(spec);
    if (pick === 0) return r.matches.join(', ');
    if (pick === -1) return r.matches[r.count - 1];
    return pick >= 1 && pick <= r.count ? r.matches[pick - 1] : '';
  }

  /** Short human summary: 'data.disruptions: title begins "metro 52" → show #1'. '' when inactive. */
  function summary(spec) {
    if (!isValid(spec)) return '';
    const fields = cleanFields(spec.fields);
    const pick = pickOf(spec);
    const pickText = pick === 0 ? 'all (joined)' : (pick === -1 ? 'the last hit' : '#' + pick);
    return String(spec.path).trim() + ': ' + (fields.join(' + ') || 'whole item') + ' ' +
      MATCH_LABELS[modeOf(spec)] + ' "' + String(spec.query) + '" → show ' + pickText;
  }

  return {
    MATCH_MODES,
    MATCH_LABELS,
    normalizeQuery,
    isValid,
    generate,
    evaluate,
    picked,
    summary
  };
});
