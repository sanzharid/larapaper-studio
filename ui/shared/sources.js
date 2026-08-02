/**
 * API data sources: model + helpers for the Sources panel.
 * A source describes an external JSON endpoint the recipe can poll;
 * fetched payloads can be bound into the sample data or the polling config.
 *
 * UMD: usable from renderer and Node tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LPSources = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Ready-made preset for the GVB (Amsterdam transit) disruptions API. */
  const GVB_PRESET = {
    name: 'GVB Disruptions',
    url: 'https://www.gvb.nl/api/gvb-shared-services/travelinformation/api/v1/Disruption/GetDisruptions?language=en',
    method: 'GET',
    dataKey: 'disruptions',
    headers: [
      {
        key: 'User-Agent',
        value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        secret: false
      },
      { key: 'Accept', value: 'application/json', secret: false },
      { key: 'Referer', value: 'https://www.gvb.nl/en', secret: false }
    ]
  };

  let counter = 0;
  function nextId() {
    counter += 1;
    return 'src_' + Date.now().toString(36) + '_' + counter;
  }

  /** Blank source, or one pre-filled from a preset (e.g. GVB_PRESET). */
  function createSource(preset) {
    const p = preset && typeof preset === 'object' ? preset : {};
    return {
      id: nextId(),
      name: String(p.name || ''),
      url: String(p.url || ''),
      method: p.method === 'POST' ? 'POST' : 'GET',
      headers: (Array.isArray(p.headers) ? p.headers : []).map((h) => ({
        key: String(h.key || ''), value: String(h.value || ''), secret: !!h.secret
      })),
      body: String(p.body || ''),
      dataKey: String(p.dataKey || ''),
      saveSecrets: !!p.saveSecrets
    };
  }

  /**
   * Wraps a fetched payload for use as sample data: arrays are keyed under
   * the source's dataKey (default 'items'), objects pass through as-is.
   */
  function wrapSampleData(source, json) {
    if (Array.isArray(json)) {
      const key = (source && source.dataKey && String(source.dataKey).trim()) || 'items';
      return { [key]: json };
    }
    if (json && typeof json === 'object') return json;
    return {};
  }

  /**
   * Flat list of leaf paths in a JSON value, e.g. 'disruptions[0].title'.
   * Objects and arrays are recursed into (arrays capped per level); empty
   * containers and primitives count as leaves.
   */
  function jsonPaths(json, maxDepth) {
    maxDepth = maxDepth === undefined ? 6 : maxDepth;
    const out = [];
    (function walk(value, path, depth) {
      if (depth >= maxDepth || value === null || typeof value !== 'object') {
        if (path) out.push(path);
        return;
      }
      if (Array.isArray(value)) {
        if (!value.length) { if (path) out.push(path); return; }
        for (let i = 0; i < value.length; i++) walk(value[i], path + '[' + i + ']', depth + 1);
        return;
      }
      const keys = Object.keys(value);
      if (!keys.length) { if (path) out.push(path); return; }
      for (const k of keys) walk(value[k], path ? path + '.' + k : k, depth + 1);
    })(json, '', 0);
    return out;
  }

  /** Liquid binding for a JSON path: 'a[0].b' → '{{ data.a[0].b }}', '[0].b' → '{{ data[0].b }}'. */
  function bindingFor(path) {
    path = String(path || '');
    return path.charAt(0) === '[' ? '{{ data' + path + ' }}' : '{{ data.' + path + ' }}';
  }

  /**
   * Maps a source onto the recipe's polling fields. Headers join as
   * 'Key: Value' lines — the polling_headers format (see buildSettingsObject).
   */
  function toPollingConfig(source) {
    return {
      pollingUrl: String(source.url || ''),
      pollingVerb: source.method === 'POST' ? 'POST' : 'GET',
      pollingHeaders: (source.headers || [])
        .filter((h) => h.key && String(h.key).trim())
        .map((h) => String(h.key) + ': ' + String(h.value || ''))
        .join('\n'),
      pollingBody: String(source.body || '')
    };
  }

  /**
   * Prepares sources for saving into the project file: secret header VALUES
   * are blanked unless the source has saveSecrets enabled (the header entry
   * itself is kept).
   */
  function serializeSources(sources) {
    return (Array.isArray(sources) ? sources : []).map((s) => {
      const out = Object.assign({}, s, {
        headers: (s.headers || []).map((h) => ({
          key: String(h.key || ''),
          value: h.secret && !s.saveSecrets ? '' : String(h.value || ''),
          secret: !!h.secret
        }))
      });
      return out;
    });
  }

  /** Restores sources from a project file; tolerates missing/garbage data. */
  function deserializeSources(list) {
    if (!Array.isArray(list)) return [];
    return list.filter((s) => s && typeof s === 'object').map((s) => {
      const src = createSource(s);
      if (s.id) src.id = String(s.id);
      return src;
    });
  }

  return {
    GVB_PRESET,
    createSource,
    wrapSampleData,
    jsonPaths,
    bindingFor,
    toPollingConfig,
    serializeSources,
    deserializeSources
  };
});
