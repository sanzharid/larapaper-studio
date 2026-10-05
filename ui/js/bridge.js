/* Larapaper Studio — Tauri bridge.
 * Re-implements the old Electron `window.lp` preload API on top of
 * window.__TAURI__.core.invoke. Every method resolves with the Rust
 * command's result: { ok: true, ... } or { ok: false, error, status, canceled? }.
 *
 * NOTE: Tauri v2 does NOT convert JS arg keys to snake_case, so all args
 * are passed with snake_case keys matching the Rust command signatures.
 * Load this script FIRST among the app scripts. */
window.lp = (function () {
  'use strict';

  function invoke(cmd, args) {
    const t = window.__TAURI__;
    if (!t || !t.core || typeof t.core.invoke !== 'function') {
      return Promise.reject(new Error(
        'Tauri bridge unavailable: window.__TAURI__ is missing. ' +
        'This page must be opened inside the Larapaper Studio app, not a plain browser.'));
    }
    return t.core.invoke(cmd, args || {});
  }

  return {
    /* project files */
    saveProject: (p) => invoke('save_project', { json: p.json, suggested_name: p.suggestedName }),
    saveProjectTo: (p) => invoke('save_project_to', { file_path: p.filePath, json: p.json }),
    openProject: () => invoke('open_project'),
    /* export */
    exportZip: (p) => invoke('export_zip', { files: p.files, suggested_name: p.suggestedName }),
    exportFolder: (p) => invoke('export_folder', { files: p.files, suggested_name: p.suggestedName }),
    /* Larapaper server */
    testConnection: (p) => invoke('lp_test_connection', { base_url: p.baseUrl, token: p.token }),
    listPluginSettings: (p) => invoke('lp_list_plugin_settings', { base_url: p.baseUrl, token: p.token }),
    pushRecipe: (p) => invoke('lp_push_recipe', {
      base_url: p.baseUrl, token: p.token, trmnlp_id: p.trmnlpId == null || p.trmnlpId === '' ? null : String(p.trmnlpId), /* Rust takes Option<String>; ids arrive as numbers */
      name: p.name, files: p.files
    }),
    /* close guard: Rust blocks window close while dirty and calls window.lpConfirmClose */
    setDirty: (dirty) => invoke('set_dirty', { dirty: !!dirty }),
    closeWindow: () => invoke('close_window'),
    /* generic HTTP (used by the Sources panel; headers: [{ key, value }]) */
    httpRequest: (p) => invoke('http_request', {
      method: p.method, url: p.url, headers: p.headers || [], body: p.body || null,
      timeout_ms: p.timeout_ms || null
    })
  };
})();
