/**
 * Tiny Liquid-subset evaluator used ONLY for the design-time preview.
 * The real render happens server-side in Larapaper (keepsuit/liquid), so this
 * evaluator is intentionally forgiving: unknown tags are dropped, unknown
 * filters act as identity, and nil never throws.
 *
 * Supported:
 *   {{ expr | filter: arg, ... }}
 *   {% for item in collection limit:n offset:n reversed %} (+ ranges (1..5), forloop.*)
 *   {% if cond %} {% elsif cond %} {% else %} {% endif %}
 *   {% unless cond %} ... {% else %} ... {% endunless %}
 *   {% assign name = expr %} {% capture name %} {% comment %} {% raw %}
 * Conditions: ==, !=, >, <, >=, <=, contains, and, or, empty, blank
 *   (right-associative boolean fold, matching Liquid)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LiquidEval = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NIL = undefined;

  /* ---------------- paths ---------------- */

  function resolvePath(path, scope) {
    path = String(path).trim();
    if (path === '' || path === 'nil' || path === 'null') return NIL;
    if (path === 'true') return true;
    if (path === 'false') return false;
    if (path === 'empty' || path === 'blank') return path;
    if (/^-?\d+(\.\d+)?$/.test(path)) return parseFloat(path);
    const strMatch = path.match(/^'([^']*)'$/) || path.match(/^"([^"]*)"$/);
    if (strMatch) return strMatch[1];

    const segments = [];
    const re = /[^.[\]]+|\[(?:([^"'\]]+)|["']([^"']+)["'])\]/g;
    let m;
    while ((m = re.exec(path)) !== null) {
      segments.push(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[0]));
    }
    let cur = scope;
    for (const seg of segments) {
      if (cur === null || cur === undefined) return NIL;
      const key = seg.trim();
      if (Array.isArray(cur)) {
        if (key === 'first') { cur = cur[0]; continue; }
        if (key === 'last') { cur = cur[cur.length - 1]; continue; }
        if (key === 'size') return cur.length;
        const idx = parseInt(key, 10);
        cur = isNaN(idx) ? NIL : cur[idx];
      } else if (typeof cur === 'object') {
        cur = cur[key];
      } else if (typeof cur === 'string') {
        if (key === 'size') return cur.length;
        const idx = parseInt(key, 10);
        cur = isNaN(idx) ? NIL : cur.charAt(idx);
      } else {
        return NIL;
      }
    }
    return cur;
  }

  /* ---------------- coercions ---------------- */

  function toStr(v) {
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) return v.map(toStr).join('');
    if (typeof v === 'object') { try { return JSON.stringify(v); } catch (e) { return String(v); } }
    if (v === true) return 'true';
    if (v === false) return 'false';
    return String(v);
  }

  function toNum(v) {
    if (typeof v === 'number') return v;
    const n = parseFloat(String(v).replace(/,/g, ''));
    return isNaN(n) ? 0 : n;
  }

  /** Liquid truthiness: only false and nil are falsy. 0 and "" are truthy! */
  function liquidTruthy(v) {
    return !(v === NIL || v === null || v === false);
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------------- dates ---------------- */

  function strftime(fmt, d) {
    const pad = (n, w) => String(n).padStart(w || 2, '0');
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const startOfYear = new Date(d.getFullYear(), 0, 0);
    const dayOfYear = Math.floor((d - startOfYear) / 86400000);
    const map = {
      '%Y': () => String(d.getFullYear()),
      '%y': () => pad(d.getFullYear() % 100),
      '%m': () => pad(d.getMonth() + 1),
      '%d': () => pad(d.getDate()),
      '%e': () => String(d.getDate()),
      '%j': () => pad(dayOfYear, 3),
      '%H': () => pad(d.getHours()),
      '%I': () => pad(((d.getHours() + 11) % 12) + 1),
      '%M': () => pad(d.getMinutes()),
      '%S': () => pad(d.getSeconds()),
      '%p': () => (d.getHours() < 12 ? 'AM' : 'PM'),
      '%A': () => days[d.getDay()],
      '%a': () => days[d.getDay()].slice(0, 3),
      '%B': () => months[d.getMonth()],
      '%b': () => months[d.getMonth()].slice(0, 3),
      '%s': () => String(Math.floor(d.getTime() / 1000)),
      '%%': () => '%'
    };
    return fmt.replace(/%[YymdeHIMSpAabBjs%]/g, (tok) => (map[tok] ? map[tok]() : tok));
  }

  function parseDate(v) {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return v;
    if (typeof v === 'number') return new Date(v > 1e12 ? v : v * 1000);
    const s = String(v).trim();
    if (s === 'now' || s === 'today') return new Date();
    if (/^\d{9,13}$/.test(s)) return new Date(s.length === 13 ? parseInt(s, 10) : parseInt(s, 10) * 1000);
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  /* ---------------- hooks (qr_code needs an app-provided SVG generator) ---------------- */

  let hooks = { qrCode: null };
  function setHooks(h) { hooks = Object.assign({ qrCode: null }, h || {}); }

  /* ---------------- filters ---------------- */

  function asArray(v) {
    if (Array.isArray(v)) return v;
    if (v === NIL || v === null || v === '') return [];
    return [v];
  }

  function numberWithDelimiter(n, sep) {
    const parts = String(n).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, sep || ',');
    return parts.join('.');
  }

  const filters = {
    /* strings */
    default: (v, arg) => (v === NIL || v === null || v === false || v === '' || (Array.isArray(v) && v.length === 0) ? arg : v),
    upcase: (v) => toStr(v).toUpperCase(),
    downcase: (v) => toStr(v).toLowerCase(),
    capitalize: (v) => { const s = toStr(v); return s.charAt(0).toUpperCase() + s.slice(1); },
    append: (v, a) => toStr(v) + toStr(a),
    prepend: (v, a) => toStr(a) + toStr(v),
    replace: (v, a, b) => toStr(v).split(toStr(a)).join(toStr(b)),
    replace_first: (v, a, b) => toStr(v).replace(toStr(a), toStr(b)),
    remove: (v, a) => toStr(v).split(toStr(a)).join(''),
    remove_first: (v, a) => toStr(v).replace(toStr(a), ''),
    strip: (v) => toStr(v).trim(),
    lstrip: (v) => toStr(v).replace(/^\s+/, ''),
    rstrip: (v) => toStr(v).replace(/\s+$/, ''),
    strip_newlines: (v) => toStr(v).replace(/[\r\n]+/g, ''),
    newline_to_br: (v) => toStr(v).replace(/\r?\n/g, '<br />'),
    strip_html: (v) => toStr(v).replace(/<[^>]*>/g, ''),
    truncate: (v, len, ellipsis) => {
      const s = toStr(v); const n = len === NIL ? 50 : toNum(len);
      const e = ellipsis === NIL ? '...' : toStr(ellipsis);
      return s.length > n ? s.slice(0, Math.max(0, n - e.length)) + e : s;
    },
    truncatewords: (v, words, ellipsis) => {
      const s = toStr(v); const n = words === NIL ? 15 : toNum(words);
      const e = ellipsis === NIL ? '...' : toStr(ellipsis);
      const ws = s.split(/\s+/);
      return ws.length > n ? ws.slice(0, n).join(' ') + e : s;
    },
    escape: (v) => escapeHtml(toStr(v)),
    escape_once: (v) => {
      const s = toStr(v).replace(/&([a-zA-Z]+|#\d+);/g, '$1;');
      return escapeHtml(s).replace(//g, '&');
    },
    url_encode: (v) => encodeURIComponent(toStr(v)),
    url_decode: (v) => { try { return decodeURIComponent(toStr(v)); } catch (e) { return toStr(v); } },
    base64_encode: (v) => (typeof btoa !== 'undefined' ? btoa(unescape(encodeURIComponent(toStr(v)))) : Buffer.from(toStr(v), 'utf8').toString('base64')),
    base64_decode: (v) => (typeof atob !== 'undefined' ? decodeURIComponent(escape(atob(toStr(v)))) : Buffer.from(toStr(v), 'base64').toString('utf8')),


    /* arrays */
    split: (v, a) => toStr(v).split(toStr(a)),
    join: (v, a) => asArray(v).map(toStr).join(a === NIL ? ' ' : toStr(a)),
    first: (v) => (Array.isArray(v) ? v[0] : (typeof v === 'string' ? v.charAt(0) : NIL)),
    last: (v) => (Array.isArray(v) ? v[v.length - 1] : (typeof v === 'string' ? v.charAt(v.length - 1) : NIL)),
    size: (v) => (Array.isArray(v) || typeof v === 'string' ? v.length : (v && typeof v === 'object' ? Object.keys(v).length : 0)),
    map: (v, key) => asArray(v).map((it) => resolvePath(toStr(key), it)),
    where: (v, key, expected) => asArray(v).filter((it) => {
      const val = resolvePath(toStr(key), it);
      return expected === NIL ? liquidTruthy(val) : val === expected;
    }),
    uniq: (v) => { const seen = {}; return asArray(v).filter((it) => { const k = toStr(it); if (seen[k]) return false; seen[k] = true; return true; }); },
    compact: (v) => asArray(v).filter((it) => it !== NIL && it !== null),
    concat: (v, a) => asArray(v).concat(asArray(a)),
    sort: (v, key) => asArray(v).slice().sort((a, b) => {
      const va = key === NIL ? a : resolvePath(toStr(key), a);
      const vb = key === NIL ? b : resolvePath(toStr(key), b);
      if (typeof va === 'number' && typeof vb === 'number') return va - vb;
      return toStr(va) < toStr(vb) ? -1 : (toStr(va) > toStr(vb) ? 1 : 0);
    }),
    reverse: (v) => asArray(v).slice().reverse(),
    sum: (v, key) => asArray(v).reduce((acc, it) => acc + toNum(key === NIL ? it : resolvePath(toStr(key), it)), 0),

    /* numbers / math */
    plus: (v, a) => toNum(v) + toNum(a),
    minus: (v, a) => toNum(v) - toNum(a),
    times: (v, a) => toNum(v) * toNum(a),
    divided_by: (v, a) => { const d = toNum(a); return d === 0 ? 0 : toNum(v) / d; },
    modulo: (v, a) => { const d = toNum(a); return d === 0 ? 0 : toNum(v) % d; },
    round: (v, places) => { const f = Math.pow(10, places === NIL ? 0 : toNum(places)); return Math.round(toNum(v) * f) / f; },
    ceil: (v) => Math.ceil(toNum(v)),
    floor: (v) => Math.floor(toNum(v)),
    abs: (v) => Math.abs(toNum(v)),
    at_least: (v, a) => Math.max(toNum(v), toNum(a)),
    at_most: (v, a) => Math.min(toNum(v), toNum(a)),
    number_with_delimiter: (v, sep) => numberWithDelimiter(toStr(v), sep === NIL ? ',' : toStr(sep)),

    /* dates */
    date: (v, fmt) => {
      const d = parseDate(v);
      if (!d) return toStr(v);
      return strftime(fmt === NIL || fmt === '' ? '%Y-%m-%d %H:%M:%S' : toStr(fmt), d);
    },

    /* misc */
    json: (v) => { try { return JSON.stringify(v === NIL ? null : v); } catch (e) { return 'null'; } },
    qr_code: (v, module, ec) => {
      if (hooks.qrCode) {
        try { return hooks.qrCode(toStr(v), module === NIL ? 4 : toNum(module), ec === NIL ? 'M' : toStr(ec)); }
        catch (e) { /* fall through to placeholder */ }
      }
      const m = module === NIL ? 4 : Math.max(1, Math.min(11, toNum(module)));
      const px = m * 29;
      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29" width="' + px + '" height="' + px + '"><rect width="29" height="29" fill="#000"/><rect x="2" y="2" width="7" height="7" fill="#fff"/><rect x="20" y="2" width="7" height="7" fill="#fff"/><rect x="2" y="20" width="7" height="7" fill="#fff"/></svg>';
    }
  };


  /* ---------------- expressions ---------------- */

  /** Split on a delimiter, honoring single/double quotes and () [] nesting. */
  function splitTopLevel(s, delim) {
    const out = [];
    let depth = 0; let quote = null; let cur = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
      if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
      if (ch === '(' || ch === '[') { depth++; cur += ch; continue; }
      if (ch === ')' || ch === ']') { depth--; cur += ch; continue; }
      if (depth === 0 && s.startsWith(delim, i)) { out.push(cur); cur = ''; i += delim.length - 1; continue; }
      cur += ch;
    }
    out.push(cur);
    return out;
  }

  function evalOutput(expr, scope) {
    const parts = splitTopLevel(String(expr), '|');
    let value = resolvePath(parts[0], scope);
    for (let i = 1; i < parts.length; i++) {
      const seg = parts[i].trim();
      if (!seg) continue;
      const colonIdx = seg.indexOf(':');
      const name = (colonIdx === -1 ? seg : seg.slice(0, colonIdx)).trim();
      const argStr = colonIdx === -1 ? '' : seg.slice(colonIdx + 1);
      const args = argStr === '' ? [] : splitTopLevel(argStr, ',').map((a) => resolvePath(a.trim(), scope));
      const fn = filters[name];
      if (fn) {
        try { value = fn(value, args[0], args[1], args[2]); } catch (e) { value = NIL; }
      }
      /* unknown filter: identity (forgiving preview) */
    }
    return value;
  }

  /**
   * True when an output tag's BASE path is undefined — even if filters would
   * coerce it to '' / 0 (used by the placeholderUnknown design-time option).
   * A `default` filter rescues the tag (it has a fallback by definition).
   */
  function isUnknownOutput(expr, scope) {
    const parts = splitTopLevel(String(expr), '|');
    if (resolvePath(parts[0], scope) !== NIL) return false;
    for (let i = 1; i < parts.length; i++) {
      const seg = parts[i].trim();
      const colonIdx = seg.indexOf(':');
      if ((colonIdx === -1 ? seg : seg.slice(0, colonIdx)).trim() === 'default') return false;
    }
    return true;
  }

  /* ---------------- conditions ---------------- */

  function splitComparison(cond) {
    const ops = ['==', '!=', '>=', '<=', 'contains', '>', '<'];
    let quote = null;
    for (let i = 0; i < cond.length; i++) {
      const ch = cond[i];
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      for (const op of ops) {
        if (!cond.startsWith(op, i)) continue;
        if (op === 'contains') {
          const before = i > 0 ? cond[i - 1] : ' ';
          const after = cond[i + op.length] || ' ';
          if (/[\w'"\])]/.test(before) || /[\w]/.test(after)) continue;
        }
        return { left: cond.slice(0, i), op, right: cond.slice(i + op.length) };
      }
    }
    return null;
  }

  function compareAtom(cond, scope) {
    const parts = splitComparison(String(cond));
    if (!parts) return liquidTruthy(evalOutput(cond, scope));
    const left = evalOutput(parts.left.trim(), scope);
    const op = parts.op;
    const rightRaw = parts.right.trim();

    if (rightRaw === 'empty') {
      const isEmpty = left === NIL || left === null || left === '' ||
        (Array.isArray(left) && left.length === 0) ||
        (left && typeof left === 'object' && Object.keys(left).length === 0);
      return op === '==' ? isEmpty : (op === '!=' ? !isEmpty : false);
    }
    if (rightRaw === 'blank') {
      const isBlank = left === NIL || left === null || left === false || toStr(left).trim() === '' ||
        (Array.isArray(left) && left.length === 0);
      return op === '==' ? isBlank : (op === '!=' ? !isBlank : false);
    }

    const right = evalOutput(rightRaw, scope);
    switch (op) {
      case '==': return left === right || toStr(left) === toStr(right);
      case '!=': return !(left === right || toStr(left) === toStr(right));
      case '>': return toNum(left) > toNum(right);
      case '<': return toNum(left) < toNum(right);
      case '>=': return toNum(left) >= toNum(right);
      case '<=': return toNum(left) <= toNum(right);
      case 'contains':
        if (Array.isArray(left)) return left.some((it) => it === right || toStr(it) === toStr(right));
        return toStr(left).indexOf(toStr(right)) !== -1;
      default: return false;
    }
  }

  /** Right-associative and/or fold, like real Liquid. */
  function evalCondition(cond, scope) {
    const tokens = [];
    for (const part of splitTopLevel(String(cond), ' ')) {
      const t = part.trim();
      if (t) tokens.push(t);
    }
    /* regroup: atoms are everything between and/or operators */
    const atoms = [];
    const ops = [];
    let cur = '';
    for (const t of tokens) {
      if (t === 'and' || t === 'or') { atoms.push(cur.trim()); ops.push(t); cur = ''; }
      else cur += (cur ? ' ' : '') + t;
    }
    atoms.push(cur.trim());
    if (atoms.length === 0) return false;
    let result = compareAtom(atoms[atoms.length - 1], scope);
    for (let i = ops.length - 1; i >= 0; i--) {
      const l = compareAtom(atoms[i], scope);
      result = ops[i] === 'and' ? (l && result) : (l || result);
    }
    return result;
  }


  /* ---------------- tokenizer & renderer ---------------- */

  /** Splits a template into text / {{output}} / {%tag%} tokens (objects). */
  function tokenize(template) {
    const tokens = [];
    const re = /({{-?[\s\S]*?-?}}|{%-?[\s\S]*?-?%})/g;
    let last = 0;
    let m;
    let trimNextLeading = false;
    while ((m = re.exec(template)) !== null) {
      let text = template.slice(last, m.index);
      if (trimNextLeading) { text = text.replace(/^\s+/, ''); trimNextLeading = false; }
      const raw = m[0];
      const isOutput = raw.startsWith('{{');
      const inner = raw.slice(2, -2).replace(/^-/, '').replace(/-$/, '');
      if (raw[2] === '-' || raw.startsWith('{{-') || raw.startsWith('{%-')) {
        /* left whitespace control: trim trailing space of previous text */
        if (tokens.length && tokens[tokens.length - 1].type === 'text') {
          tokens[tokens.length - 1].value = tokens[tokens.length - 1].value.replace(/\s+$/, '');
        } else text = text.replace(/\s+$/, '');
      }
      if (text) tokens.push({ type: 'text', value: text });
      if (/-%}$/.test(raw) || /-}}$/.test(raw)) trimNextLeading = true;
      tokens.push({ type: isOutput ? 'output' : 'tag', value: inner.trim() });
      last = m.index + raw.length;
    }
    let tail = template.slice(last);
    if (trimNextLeading) tail = tail.replace(/^\s+/, '');
    if (tail) tokens.push({ type: 'text', value: tail });
    return tokens;
  }

  function parseForArgs(tag) {
    const m = tag.match(/^for\s+(\w+)\s+in\s+(.+)$/);
    if (!m) return null;
    const varName = m[1];
    let rest = m[2].trim();
    const opts = { limit: null, offset: null, reversed: false };
    rest = rest.replace(/\blimit\s*:\s*(\S+)/, (s, v) => { opts.limit = v; return ''; });
    rest = rest.replace(/\boffset\s*:\s*(\S+)/, (s, v) => { opts.offset = v; return ''; });
    if (/\breversed\b/.test(rest)) { opts.reversed = true; rest = rest.replace(/\breversed\b/, ''); }
    opts.collection = rest.trim();
    return { varName, opts };
  }

  function resolveCollection(expr, scope) {
    const range = String(expr).trim().match(/^\(\s*(.+?)\s*\.\.\s*(.+?)\s*\)$/);
    if (range) {
      const a = toNum(resolvePath(range[1], scope));
      const b = toNum(resolvePath(range[2], scope));
      const out = [];
      for (let i = a; i <= b; i++) out.push(i);
      return out;
    }
    const v = evalOutput(expr, scope);
    if (Array.isArray(v)) return v.slice();
    if (v && typeof v === 'object') return Object.keys(v).map((k) => ({ key: k, value: v[k] }));
    if (v === NIL || v === null) return [];
    return [v];
  }

  /**
   * Design-time option (render's third arg, opts.placeholderUnknown): when
   * truthy, plain output tags whose value is UNDEFINED render as a visible
   * <span class="lp-unresolved"> chip instead of ''. Tags inside HTML
   * attributes and logic tags are unaffected. Module-level because
   * renderTokens recurses; render() is synchronous so save/restore is safe.
   */
  let placeholderUnknown = false;

  function unresolvedChip(tagText) {
    return '<span class="lp-unresolved">' + escapeHtml('{{ ' + tagText + ' }}') + '</span>';
  }

  /**
   * Renders tokens[start..] until one of stopTags is hit.
   * Returns { out, next, stopTag, stopTagText } — next is the index of the
   * stop token (or tokens.length).
   */
  function renderTokens(tokens, scope, start, stopTags) {
    let out = '';
    let i = start;
    while (i < tokens.length) {
      const tok = tokens[i];
      if (tok.type === 'text') { out += tok.value; i++; continue; }
      if (tok.type === 'output') {
        const v = evalOutput(tok.value, scope);
        if (v === NIL) {
          /* don't inject markup inside an HTML attribute (e.g. src="{{ x }}") */
          const insideTag = out.lastIndexOf('<') > out.lastIndexOf('>');
          out += (placeholderUnknown && !insideTag) ? unresolvedChip(tok.value) : '';
        } else if (placeholderUnknown && isUnknownOutput(tok.value, scope) &&
          out.lastIndexOf('<') <= out.lastIndexOf('>')) {
          out += unresolvedChip(tok.value);
        } else {
          out += toStr(v);
        }
        i++; continue;
      }
      /* tag */
      const name = (tok.value.match(/^(\w+)/) || [''])[1];
      if (stopTags.indexOf(name) !== -1) return { out, next: i, stopTag: name, stopTagText: tok.value };

      if (name === 'for') {
        const parsed = parseForArgs(tok.value);
        /* pre-scan on a cloned scope: the body is re-rendered for every real
           iteration below, so assign/capture side effects of this locating
           pass must not leak into the loop scope */
        const body = renderTokens(tokens, Object.assign({}, scope), i + 1, ['endfor']);
        if (parsed) {
          let items = resolveCollection(parsed.opts.collection, scope);
          if (parsed.opts.offset !== null) items = items.slice(toNum(evalOutput(parsed.opts.offset, scope)));
          if (parsed.opts.limit !== null) items = items.slice(0, toNum(evalOutput(parsed.opts.limit, scope)));
          if (parsed.opts.reversed) items = items.reverse();
          const len = items.length;
          const prevLoop = scope.forloop;
          for (let idx = 0; idx < len; idx++) {
            scope[parsed.varName] = items[idx];
            scope.forloop = {
              index: idx + 1, index0: idx, rindex: len - idx, rindex0: len - idx - 1,
              first: idx === 0, last: idx === len - 1, length: len
            };
            out += renderTokens(tokens, scope, i + 1, ['endfor']).out;
          }
          if (prevLoop === undefined) delete scope.forloop; else scope.forloop = prevLoop;
          delete scope[parsed.varName];
        }
        i = body.next + 1;
        continue;
      }


      if (name === 'if' || name === 'unless') {
        let cond = evalCondition(tok.value.slice(name.length), scope);
        if (name === 'unless') cond = !cond;
        const endTags = ['elsif', 'else', 'endif', 'endunless'];
        const endStop = name === 'if' ? ['endif'] : ['endunless'];
        let rendered = false;
        while (true) {
          /* locating pass on a cloned scope: assign/capture side effects of a
             branch must only happen when the branch is actually taken */
          const scan = renderTokens(tokens, Object.assign({}, scope), i + 1, endTags);
          if (cond && !rendered) { out += renderTokens(tokens, scope, i + 1, endTags).out; rendered = true; }
          if (scan.stopTag === 'elsif') {
            cond = name === 'unless' ? false : evalCondition(scan.stopTagText.slice(5), scope);
            i = scan.next;
            continue;
          }
          if (scan.stopTag === 'else') {
            const elseScan = renderTokens(tokens, Object.assign({}, scope), scan.next + 1, endStop);
            if (!rendered && !cond) { out += renderTokens(tokens, scope, scan.next + 1, endStop).out; rendered = true; }
            i = elseScan.next + 1;
            break;
          }
          i = scan.next + 1;
          break;
        }
        continue;
      }

      if (name === 'assign') {
        const m = tok.value.match(/^assign\s+(\w+)\s*=\s*([\s\S]+)$/);
        if (m) scope[m[1]] = evalOutput(m[2], scope);
        i++;
        continue;
      }

      if (name === 'capture') {
        const m = tok.value.match(/^capture\s+(\w+)$/);
        const body = renderTokens(tokens, scope, i + 1, ['endcapture']);
        if (m) scope[m[1]] = body.out;
        i = body.next + 1;
        continue;
      }

      if (name === 'comment') {
        const body = renderTokens(tokens, scope, i + 1, ['endcomment']);
        i = body.next + 1;
        continue;
      }

      if (name === 'raw') {
        /* emit inner source verbatim */
        let j = i + 1;
        let raw = '';
        while (j < tokens.length) {
          const t = tokens[j];
          if (t.type === 'tag' && /^endraw/.test(t.value)) break;
          raw += t.type === 'text' ? t.value : (t.type === 'output' ? '{{ ' + t.value + ' }}' : '{% ' + t.value + ' %}');
          j++;
        }
        out += raw;
        i = j + 1;
        continue;
      }

      if (name === 'break' || name === 'continue') { i++; continue; }

      /* unknown / unhandled tag: drop it */
      i++;
    }
    return { out, next: i, stopTag: null, stopTagText: null };
  }

  function render(template, context, opts) {
    const prev = placeholderUnknown;
    placeholderUnknown = !!(opts && opts.placeholderUnknown);
    try {
      const scope = Object.assign({}, context || {});
      return renderTokens(tokenize(String(template == null ? '' : template)), scope, 0, []).out;
    } finally {
      placeholderUnknown = prev;
    }
  }

  return {
    render,
    evalOutput,
    evalCondition,
    resolvePath,
    setHooks,
    filters
  };
});

