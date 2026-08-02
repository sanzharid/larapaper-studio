/**
 * Minimal YAML emitter tailored to Larapaper recipe settings.yml files.
 * UMD: usable from Node (tests, main) and the browser (renderer).
 *
 * Supports: nested maps, arrays of scalars, arrays of maps, null, numbers,
 * booleans, multi-line strings (literal block style) and safe quoting of
 * strings that would otherwise be misparsed by YAML (incl. Liquid `{{ }}`).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LPYaml = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PLAIN_FORBIDDEN_START = /^[!&*?|>@`"'%#,[\]{}\s-]|-\s/;
  const LOOKS_SPECIAL = /^(null|~|true|false|yes|no|on|off)$/i;
  const LOOKS_NUMERIC = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

  function needsQuotes(str) {
    if (str === '') return true;
    if (PLAIN_FORBIDDEN_START.test(str)) return true;
    if (LOOKS_SPECIAL.test(str)) return true;
    if (LOOKS_NUMERIC.test(str)) return true;
    if (/:(\s|$)/.test(str)) return true;       // "key: value" inside scalar
    if (/\s#/.test(str)) return true;            // comment start
    if (/[{}[\],]/.test(str) && /^[{[]/.test(str)) return true;
    if (/\s$/.test(str)) return true;
    return false;
  }

  function quoteString(str) {
    return '"' + str
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\t/g, '\\t')
      .replace(/\r/g, '') + '"';
  }

  function isMultiline(str) {
    return str.indexOf('\n') !== -1;
  }

  function indentLines(text, indent) {
    const pad = ' '.repeat(indent);
    return text.split('\n').map(function (l) { return l === '' ? '' : pad + l; }).join('\n');
  }

  function emitScalar(value, indent, inline) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number' && isFinite(value)) return String(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    const str = String(value);
    if (isMultiline(str)) {
      // Literal block style; caller decides indentation. Not valid inline.
      if (inline) return quoteString(str.replace(/\n/g, '\\n'));
      return null; // signal: use block style
    }
    return needsQuotes(str) ? quoteString(str) : str;
  }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v) &&
      (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
  }

  function emitNode(value, indent) {
    const lines = [];
    if (Array.isArray(value)) {
      if (value.length === 0) { lines.push('[]'); return lines; }
      for (const item of value) {
        if (isPlainObject(item)) {
          const sub = emitMap(item, indent + 2);
          // move first key onto the dash line
          const first = sub[0].trimStart();
          lines.push(' '.repeat(indent) + '- ' + first);
          for (let i = 1; i < sub.length; i++) lines.push(sub[i]);
        } else if (Array.isArray(item)) {
          const sub = emitNode(item, indent + 2);
          lines.push(' '.repeat(indent) + '-');
          lines.push.apply(lines, sub);
        } else {
          lines.push(' '.repeat(indent) + '- ' + emitScalar(item, indent, true));
        }
      }
      return lines;
    }
    if (isPlainObject(value)) {
      return emitMap(value, indent);
    }
    lines.push(' '.repeat(indent) + (emitScalar(value, indent, true) || ''));
    return lines;
  }

  function emitMap(obj, indent) {
    const lines = [];
    const pad = ' '.repeat(indent);
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (value === undefined) continue;
      const safeKey = needsQuotes(key) ? quoteString(key) : key;
      if (isPlainObject(value)) {
        if (Object.keys(value).length === 0) { lines.push(pad + safeKey + ': {}'); continue; }
        lines.push(pad + safeKey + ':');
        lines.push.apply(lines, emitMap(value, indent + 2));
      } else if (Array.isArray(value)) {
        if (value.length === 0) { lines.push(pad + safeKey + ': []'); continue; }
        lines.push(pad + safeKey + ':');
        lines.push.apply(lines, emitNode(value, indent + 2));
      } else {
        const scalar = emitScalar(value, indent, false);
        if (scalar === null) {
          // multi-line literal block
          lines.push(pad + safeKey + ': |');
          lines.push(indentLines(String(value).replace(/\s+$/g, ''), indent + 2));
        } else {
          lines.push(pad + safeKey + ': ' + scalar);
        }
      }
    }
    return lines;
  }

  return {
    /**
     * Serialize a plain object to YAML. Skips undefined values.
     */
    stringify(obj) {
      return emitMap(obj, 0).join('\n') + '\n';
    }
  };
});
