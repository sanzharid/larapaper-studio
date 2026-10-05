#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Larapaper Studio — Tauri 2 backend.
//!
//! Ports the Electron main-process IPC surface (`larapaper-studio/src/main.js`)
//! and the Larapaper API client (`src/shared/larapaper-api.js`) to Tauri
//! commands. The frontend calls these via `window.__TAURI__.core.invoke`.

use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

/// Current-Chrome-on-Windows UA. Required to pass the Azure WAF JS challenge
/// on the GVB API — plain HTTP clients get a 403 there.
const CHROME_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// Mirrors DEFAULT_TIMEOUT_MS in larapaper-api.js.
const API_TIMEOUT_MS: u64 = 20_000;
/// Archive uploads get a longer window (mirrors uploadArchive in larapaper-api.js).
const UPLOAD_TIMEOUT_MS: u64 = 60_000;

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/// lowercase, non-alnum runs -> '-', trim '-', fallback 'recipe'.
fn slugify(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut last_dash = true; // suppresses a leading '-'
    for c in name.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_end_matches('-');
    if trimmed.is_empty() {
        "recipe".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Builds a DEFLATE zip in memory containing exactly `files` (UTF-8 contents).
fn build_zip(files: &HashMap<String, String>) -> std::io::Result<Vec<u8>> {
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buf);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        // Sort for deterministic archives (HashMap iteration order is random).
        let mut names: Vec<&String> = files.keys().collect();
        names.sort();
        for name in names {
            zip.start_file(name.as_str(), opts)?;
            zip.write_all(files[name].as_bytes())?;
        }
        zip.finish()?;
    }
    Ok(buf.into_inner())
}

/* ------------------------------------------------------------------ */
/* Larapaper API client (port of larapaper-api.js)                     */
/* ------------------------------------------------------------------ */

#[derive(Debug)]
struct ApiError {
    message: String,
    status: u16,
}

impl ApiError {
    fn msg(message: impl Into<String>) -> Self {
        ApiError {
            message: message.into(),
            status: 0,
        }
    }
}

/// Accepts "host:8000", "http://host", ".../", ".../api" and normalizes to origin root.
fn normalize_base_url(raw: &str) -> Result<String, ApiError> {
    let mut url = raw.trim().to_string();
    if url.is_empty() {
        return Err(ApiError::msg("Server URL is empty."));
    }
    if !url.to_ascii_lowercase().starts_with("http://")
        && !url.to_ascii_lowercase().starts_with("https://")
    {
        url = format!("http://{url}");
    }
    while url.ends_with('/') {
        url.pop();
    }
    if url.to_ascii_lowercase().ends_with("/api") {
        url.truncate(url.len() - 4);
    }
    let parsed =
        reqwest::Url::parse(&url).map_err(|_| ApiError::msg(format!("Invalid server URL: {raw}")))?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(ApiError::msg("Server URL must start with http:// or https://"));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| ApiError::msg(format!("Invalid server URL: {raw}")))?;
    let mut out = format!("{scheme}://{host}");
    if let Some(port) = parsed.port() {
        out.push_str(&format!(":{port}"));
    }
    let path = parsed.path();
    if path != "/" {
        out.push_str(path);
    }
    Ok(out)
}

/// One HTTP call against the Larapaper API with the JS client's error semantics.
/// `json_body` sends a JSON body; `zip_body` sends multipart `file` = recipe.zip.
async fn api_request(
    method: reqwest::Method,
    url: &str,
    token: &str,
    json_body: Option<Value>,
    zip_body: Option<Vec<u8>>,
    timeout_ms: u64,
) -> Result<Value, ApiError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        // Fail fast on unreachable hosts instead of hanging the UI.
        .connect_timeout(Duration::from_millis(5_000))
        // Never follow redirects: a non-Larapaper server typically 302s
        // /api/* to its HTML login page, which must surface as an error,
        // not as a bogus 200. (http_request keeps the default policy.)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| ApiError::msg(e.to_string()))?;

    let mut req = client
        .request(method, url)
        .bearer_auth(token)
        .header(reqwest::header::ACCEPT, "application/json");
    if let Some(body) = json_body {
        req = req.json(&body);
    }
    if let Some(zip_bytes) = zip_body {
        let part = reqwest::multipart::Part::bytes(zip_bytes)
            .file_name("recipe.zip")
            .mime_str("application/zip")
            .map_err(|e| ApiError::msg(e.to_string()))?;
        req = req.multipart(reqwest::multipart::Form::new().part("file", part));
    }

    let res = req.send().await.map_err(|e| {
        if e.is_timeout() {
            ApiError::msg(format!("Request timed out — server not reachable at {url}"))
        } else {
            ApiError::msg(format!("Cannot connect to {url} — {e}"))
        }
    })?;

    let status = res.status().as_u16();
    let text = res
        .text()
        .await
        .map_err(|e| ApiError::msg(format!("Failed to read response body: {e}")))?;
    classify_api_response(status, url, &text)
}

/// Classifies a Larapaper API response: status + raw body -> Ok(json) | Err.
/// Kept pure (no HTTP) so the error semantics are unit-testable offline.
fn classify_api_response(status: u16, url: &str, text: &str) -> Result<Value, ApiError> {
    // Redirects are never followed (see api_request): a 3xx here means the
    // endpoint bounced us, almost always to an HTML login page.
    if (300..400).contains(&status) {
        return Err(ApiError {
            message: format!(
                "Server redirects to a login page (HTTP {status}) — this doesn't look like a Larapaper API. Check the URL."
            ),
            status,
        });
    }

    if (200..300).contains(&status) {
        // Empty body on success (e.g. archive upload 200/204) is fine.
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        return match serde_json::from_str::<Value>(text) {
            Ok(json) => Ok(json),
            Err(_) => {
                let snippet: String = text.chars().take(120).collect();
                Err(ApiError {
                    message: format!(
                        "Endpoint returned a non-JSON response (HTTP {status}) — is this a Larapaper server? Body starts with: {snippet}"
                    ),
                    status,
                })
            }
        };
    }

    let body_json: Option<Value> = serde_json::from_str(text).ok();
    let detail = body_json
        .as_ref()
        .and_then(|j| j.get("message"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| text.chars().take(300).collect());
    let message = match status {
        401 | 403 => {
            format!("Authentication failed (HTTP {status}) — check your API token.")
        }
        404 => format!("Endpoint not found (404): {url} — is this a Larapaper server?"),
        422 => format!("Validation failed: {detail}"),
        _ => format!("Server error (HTTP {status}): {detail}"),
    };
    Err(ApiError { message, status })
}

/// GET /api/me, falling back to /api/user on 404. Returns the user object.
async fn api_test_connection(base_url: &str, token: &str) -> Result<Value, ApiError> {
    let base = normalize_base_url(base_url)?;
    let me_url = format!("{base}/api/me");
    match api_request(reqwest::Method::GET, &me_url, token, None, None, API_TIMEOUT_MS).await {
        Ok(me) => require_user(me.get("data").cloned().unwrap_or(me)),
        Err(e) if e.status == 404 => {
            let user_url = format!("{base}/api/user");
            let me =
                api_request(reqwest::Method::GET, &user_url, token, None, None, API_TIMEOUT_MS)
                    .await?;
            require_user(me.get("data").cloned().unwrap_or(me))
        }
        Err(e) => Err(e),
    }
}

/// A valid test-connection response must carry an actual user object —
/// `{"data": null}` or `{}` means we hit something that is not Larapaper.
fn require_user(user: Value) -> Result<Value, ApiError> {
    if user.is_null() {
        Err(ApiError::msg(
            "Server did not return a user object — is this a Larapaper server?",
        ))
    } else {
        Ok(user)
    }
}

/* ------------------------------------------------------------------ */
/* commands: project files                                             */
/* ------------------------------------------------------------------ */

#[tauri::command(rename_all = "snake_case")]
async fn save_project(
    app: tauri::AppHandle,
    json: String,
    suggested_name: String,
) -> Value {
    let file = app
        .dialog()
        .file()
        .set_title("Save project")
        .set_file_name(format!("{}.lpsproj.json", slugify(&suggested_name)))
        .add_filter("Larapaper Studio Project", &["lpsproj.json", "json"])
        .blocking_save_file();
    let Some(path) = file else {
        return json!({"ok": false, "canceled": true});
    };
    let path = path.to_string();
    match write_atomic(std::path::Path::new(&path), json.as_bytes()) {
        Ok(()) => json!({"ok": true, "filePath": path}),
        Err(e) => json!({"ok": false, "error": e.to_string()}),
    }
}

/// Writes via a temp file in the same folder + rename, so a crash or full disk
/// mid-save never leaves the only copy of a project truncated.
fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut tmp_name = path.file_name().unwrap_or_default().to_os_string();
    tmp_name.push(".tmp");
    let tmp = path.with_file_name(tmp_name);
    let result = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[tauri::command(rename_all = "snake_case")]
async fn save_project_to(file_path: String, json: String) -> Value {
    match write_atomic(std::path::Path::new(&file_path), json.as_bytes()) {
        Ok(()) => json!({"ok": true, "filePath": file_path}),
        Err(e) => json!({"ok": false, "error": e.to_string()}),
    }
}

#[tauri::command(rename_all = "snake_case")]
async fn open_project(app: tauri::AppHandle) -> Value {
    let file = app
        .dialog()
        .file()
        .set_title("Open project")
        .add_filter("Larapaper Studio Project", &["json"])
        .blocking_pick_file();
    let Some(path) = file else {
        return json!({"ok": false, "canceled": true});
    };
    let path = path.to_string();
    match std::fs::read_to_string(&path) {
        Ok(json) => json!({"ok": true, "filePath": path, "json": json}),
        Err(e) => json!({"ok": false, "error": e.to_string()}),
    }
}

/* ------------------------------------------------------------------ */
/* commands: export                                                    */
/* ------------------------------------------------------------------ */

#[tauri::command(rename_all = "snake_case")]
async fn export_zip(
    app: tauri::AppHandle,
    files: HashMap<String, String>,
    suggested_name: String,
) -> Value {
    let file = app
        .dialog()
        .file()
        .set_title("Export recipe ZIP")
        .set_file_name(format!("{}.zip", slugify(&suggested_name)))
        .add_filter("Recipe archive", &["zip"])
        .blocking_save_file();
    let Some(path) = file else {
        return json!({"ok": false, "canceled": true});
    };
    let path = path.to_string();
    let result = build_zip(&files).and_then(|buf| std::fs::write(&path, buf));
    match result {
        Ok(()) => json!({"ok": true, "filePath": path}),
        Err(e) => json!({"ok": false, "error": e.to_string()}),
    }
}

/// Layout templates a recipe folder can contain (mirrors LPRecipe.LAYOUTS).
const LAYOUT_FILES: &[&str] = &[
    "full.liquid",
    "half_horizontal.liquid",
    "half_vertical.liquid",
    "quadrant.liquid",
];

#[tauri::command(rename_all = "snake_case")]
async fn export_folder(
    app: tauri::AppHandle,
    files: HashMap<String, String>,
    suggested_name: String,
) -> Value {
    let dir = app
        .dialog()
        .file()
        .set_title("Choose export folder")
        .blocking_pick_folder();
    let Some(dir) = dir else {
        return json!({"ok": false, "canceled": true});
    };
    let base = std::path::Path::new(&dir.to_string()).join(slugify(&suggested_name));
    let result = (|| -> std::io::Result<()> {
        std::fs::create_dir_all(&base)?;
        // Re-exporting over an earlier export: drop layouts that are now disabled,
        // or the folder keeps serving a layout the recipe no longer has.
        for layout in LAYOUT_FILES {
            let stale = base.join(layout);
            if !files.contains_key(*layout) && stale.is_file() {
                std::fs::remove_file(stale)?;
            }
        }
        for (name, contents) in &files {
            let path = base.join(name);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(path, contents)?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => json!({"ok": true, "folder": base.to_string_lossy()}),
        Err(e) => json!({"ok": false, "error": e.to_string()}),
    }
}

/* ------------------------------------------------------------------ */
/* commands: generic HTTP (no CORS here, mirrors the old preload fetch) */
/* ------------------------------------------------------------------ */

#[derive(Debug, Deserialize)]
struct Header {
    key: String,
    value: String,
}

#[tauri::command(rename_all = "snake_case")]
async fn http_request(
    method: String,
    url: String,
    headers: Vec<Header>,
    body: Option<String>,
    timeout_ms: Option<u64>,
) -> Value {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms.unwrap_or(30_000)))
        .build()
    {
        Ok(c) => c,
        Err(e) => return json!({"ok": false, "error": e.to_string()}),
    };
    let method = reqwest::Method::from_bytes(method.as_bytes())
        .unwrap_or(reqwest::Method::GET);
    let mut req = client.request(method, &url);
    let mut has_user_agent = false;
    for h in headers {
        if h.key.eq_ignore_ascii_case("user-agent") {
            has_user_agent = true;
        }
        req = req.header(h.key, h.value);
    }
    if !has_user_agent {
        req = req.header(reqwest::header::USER_AGENT, CHROME_UA);
    }
    if let Some(b) = body {
        req = req.body(b);
    }
    match req.send().await {
        Ok(res) => {
            let status = res.status().as_u16();
            let body = res.text().await.unwrap_or_default();
            json!({"ok": true, "status": status, "body": body})
        }
        Err(e) => json!({"ok": false, "error": e.to_string()}),
    }
}

/* ------------------------------------------------------------------ */
/* commands: Larapaper server                                          */
/* ------------------------------------------------------------------ */

fn err_payload(e: &ApiError) -> Value {
    json!({"ok": false, "error": e.message, "status": e.status})
}

#[tauri::command(rename_all = "snake_case")]
async fn lp_test_connection(base_url: String, token: String) -> Value {
    match api_test_connection(&base_url, &token).await {
        Ok(user) => json!({"ok": true, "user": user}),
        Err(e) => err_payload(&e),
    }
}

#[tauri::command(rename_all = "snake_case")]
async fn lp_list_plugin_settings(base_url: String, token: String) -> Value {
    let result = async {
        let base = normalize_base_url(&base_url)?;
        let url = format!("{base}/api/plugin_settings");
        let body =
            api_request(reqwest::Method::GET, &url, &token, None, None, API_TIMEOUT_MS).await?;
        let items = body.get("data").cloned().unwrap_or(body);
        let list = items.as_array().cloned().unwrap_or_default();
        Ok::<_, ApiError>(
            list.iter()
                .map(|it| {
                    let id = it
                        .get("id")
                        .or_else(|| it.get("trmnlp_id"))
                        .cloned()
                        .unwrap_or(Value::Null);
                    let name = it
                        .get("name")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .unwrap_or("(unnamed)");
                    json!({"id": id, "name": name})
                })
                .collect::<Vec<_>>(),
        )
    }
    .await;
    match result {
        Ok(items) => json!({"ok": true, "items": items}),
        Err(e) => err_payload(&e),
    }
}

#[tauri::command(rename_all = "snake_case")]
async fn lp_push_recipe(
    base_url: String,
    token: String,
    trmnlp_id: Option<String>,
    name: String,
    files: HashMap<String, String>,
) -> Value {
    let result = async {
        let base = normalize_base_url(&base_url)?;

        // Create the plugin setting when no id was given.
        let mut created = false;
        let id: Value = match trmnlp_id.as_deref().filter(|s| !s.is_empty()) {
            Some(id) => Value::String(id.to_string()),
            None => {
                let url = format!("{base}/api/plugin_settings");
                let body = api_request(
                    reqwest::Method::POST,
                    &url,
                    &token,
                    Some(json!({"name": name})),
                    None,
                    API_TIMEOUT_MS,
                )
                .await?;
                let id = body
                    .get("data")
                    .and_then(|d| d.get("id").or_else(|| d.get("trmnlp_id")))
                    .cloned();
                created = true;
                id.ok_or_else(|| {
                    let snippet: String =
                        body.to_string().chars().take(300).collect();
                    ApiError::msg(format!("Server did not return a plugin id: {snippet}"))
                })?
            }
        };

        // Upload the recipe archive.
        let zip_bytes = build_zip(&files)
            .map_err(|e| ApiError::msg(format!("Failed to build recipe zip: {e}")))?;
        let id_str = match &id {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        let url = format!(
            "{base}/api/plugin_settings/{}/archive",
            urlencoding_simple(&id_str)
        );
        api_request(
            reqwest::Method::POST,
            &url,
            &token,
            None,
            Some(zip_bytes),
            UPLOAD_TIMEOUT_MS,
        )
        .await?;
        Ok::<_, ApiError>((id, created))
    }
    .await;
    match result {
        Ok((id, created)) => json!({"ok": true, "trmnlpId": id, "created": created}),
        Err(e) => err_payload(&e),
    }
}

/// Percent-encode a path segment (ids are normally numeric, so this is a no-op there).
fn urlencoding_simple(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/* ------------------------------------------------------------------ */
/* smoke test (--smoke-test, mirrors the old Electron app)             */
/* ------------------------------------------------------------------ */

/// Receives the in-page smoke harness result (test/smoke.js) and exits.
#[tauri::command(rename_all = "snake_case")]
fn smoke_report(result: String) {
    let parsed: Value =
        serde_json::from_str(&result).unwrap_or_else(|_| json!({"ok": false}));
    if let Some(checks) = parsed.get("checks").and_then(Value::as_array) {
        for c in checks {
            let ok = c.get("ok").and_then(Value::as_bool).unwrap_or(false);
            let name = c.get("name").and_then(Value::as_str).unwrap_or("?");
            let detail = c
                .get("detail")
                .map(|d| match d {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                })
                .unwrap_or_default();
            println!("SMOKE_CHECK ok={ok} name={name} detail={detail}");
        }
    }
    println!("SMOKE_RESULT {result}");
    let ok = parsed.get("ok").and_then(Value::as_bool).unwrap_or(false);
    std::process::exit(if ok { 0 } else { 1 });
}

/* ------------------------------------------------------------------ */
/* app entry                                                           */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* close guard (unsaved changes)                                       */
/* ------------------------------------------------------------------ */

/// Mirrors LPState.isDirty(); the UI reports every change.
static DIRTY: AtomicBool = AtomicBool::new(false);

#[tauri::command(rename_all = "snake_case")]
fn set_dirty(dirty: bool) {
    DIRTY.store(dirty, Ordering::SeqCst);
}

/// Called by the UI once the user confirmed discarding unsaved changes.
#[tauri::command(rename_all = "snake_case")]
fn close_window(window: tauri::WebviewWindow) {
    DIRTY.store(false, Ordering::SeqCst);
    let _ = window.destroy();
}

fn main() {
    let smoke_test = std::env::args().any(|a| a == "--smoke-test");

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            save_project,
            save_project_to,
            open_project,
            export_zip,
            export_folder,
            http_request,
            lp_test_connection,
            lp_list_plugin_settings,
            lp_push_recipe,
            set_dirty,
            close_window,
            smoke_report,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if !DIRTY.load(Ordering::SeqCst) {
                    return;
                }
                // Let the page ask; it calls close_window if the user agrees
                // (or straight away if the page never booted its handler).
                if let Some(webview) = window.app_handle().get_webview_window(window.label()) {
                    let js = "window.lpConfirmClose ? window.lpConfirmClose() \
                              : window.__TAURI__.core.invoke('close_window')";
                    if webview.eval(js).is_ok() {
                        api.prevent_close();
                    }
                }
            }
        });

    if smoke_test {
        builder = builder.setup(|app| {
            let window = app
                .get_webview_window("main")
                .expect("main window missing");
            let _ = window.hide();

            // Give the page a moment to boot, then eval the in-page harness.
            let w = window.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(3));
                let _ = w.eval(include_str!("../../test/smoke.js"));
            });

            // Watchdog: smoke_report exits the process on report; if no
            // report arrives within 90s of eval, fail loudly.
            std::thread::spawn(|| {
                std::thread::sleep(Duration::from_secs(3 + 90));
                println!("SMOKE_TEST_TIMEOUT");
                std::process::exit(1);
            });
            Ok(())
        });
    }

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/* ------------------------------------------------------------------ */
/* tests                                                               */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_atomic_replaces_and_leaves_no_temp_file() {
        let dir = std::env::temp_dir().join(format!("lps-atomic-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("p.lpsproj.json");
        write_atomic(&path, b"first").unwrap();
        write_atomic(&path, b"second").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");
        assert!(!dir.join("p.lpsproj.json.tmp").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn slugify_basic() {
        assert_eq!(slugify("My Cool Recipe!"), "my-cool-recipe");
        assert_eq!(slugify("GVB Departures v2"), "gvb-departures-v2");
        assert_eq!(slugify(""), "recipe");
        assert_eq!(slugify("---"), "recipe");
        assert_eq!(slugify("  --A--b--  "), "a-b");
        assert_eq!(slugify("café"), "caf"); // non-ascii -> dashes, like the JS regex
    }

    #[test]
    fn normalize_base_url_variants() {
        assert_eq!(normalize_base_url("host:8000").unwrap(), "http://host:8000");
        assert_eq!(normalize_base_url("http://host/").unwrap(), "http://host");
        assert_eq!(
            normalize_base_url("http://host/api").unwrap(),
            "http://host"
        );
        assert_eq!(
            normalize_base_url("https://example.com/api/").unwrap(),
            "https://example.com"
        );
        assert_eq!(
            normalize_base_url("http://host:8000/sub/path/").unwrap(),
            "http://host:8000/sub/path"
        );
        assert!(normalize_base_url("   ").is_err());
    }

    #[test]
    fn classify_redirect_is_login_page_error() {
        let err = classify_api_response(302, "http://x/api/me", "").unwrap_err();
        assert_eq!(err.status, 302);
        assert!(err.message.contains("redirects to a login page"), "{}", err.message);
        assert!(err.message.contains("302"), "{}", err.message);
    }

    #[test]
    fn classify_html_200_is_non_json_error() {
        let html = "<html><body><form action=\"/login\">Please sign in</form></body></html>";
        let err = classify_api_response(200, "http://x/api/me", html).unwrap_err();
        assert_eq!(err.status, 200);
        assert!(err.message.contains("non-JSON response"), "{}", err.message);
        assert!(err.message.contains("200"), "{}", err.message);
        assert!(err.message.contains("<html>"), "{}", err.message); // body snippet
    }

    #[test]
    fn classify_json_200_is_ok() {
        let v = classify_api_response(200, "http://x/api/me", "{\"data\":{\"id\":1}}").unwrap();
        assert_eq!(v["data"]["id"], 1);
    }

    #[test]
    fn classify_401_is_auth_error() {
        let err = classify_api_response(401, "http://x/api/me", "{\"message\":\"Unauthenticated.\"}")
            .unwrap_err();
        assert_eq!(err.status, 401);
        assert!(err.message.contains("Authentication failed (HTTP 401)"), "{}", err.message);
    }

    #[test]
    fn classify_404_is_not_found_error() {
        let err = classify_api_response(404, "http://x/api/me", "").unwrap_err();
        assert_eq!(err.status, 404);
        assert!(err.message.contains("Endpoint not found (404)"), "{}", err.message);
    }

    #[test]
    fn classify_empty_2xx_is_ok_null() {
        assert_eq!(
            classify_api_response(204, "http://x/api/plugin_settings/1/archive", "").unwrap(),
            Value::Null
        );
        assert_eq!(
            classify_api_response(200, "http://x/api/me", "  \n\t ").unwrap(),
            Value::Null
        );
    }

    #[test]
    fn require_user_rejects_null() {
        assert!(require_user(Value::Null).is_err());
        assert!(require_user(json!({"id": 1})).is_ok());
    }

    #[test]
    fn zip_round_trip() {
        let mut files = HashMap::new();
        files.insert("settings.yml".to_string(), "name: Test\n".to_string());
        files.insert(
            "templates/full.liquid".to_string(),
            "<div>{{ value }}</div>".to_string(),
        );
        files.insert("empty.txt".to_string(), String::new());

        let buf = build_zip(&files).expect("build zip");
        let mut archive =
            zip::ZipArchive::new(std::io::Cursor::new(buf)).expect("read zip back");

        assert_eq!(archive.len(), files.len());
        for (name, expected) in &files {
            let mut entry = archive.by_name(name).expect("entry present");
            let mut contents = String::new();
            use std::io::Read;
            entry.read_to_string(&mut contents).expect("read entry");
            assert_eq!(&contents, expected, "contents of {name}");
            assert_eq!(entry.compression(), zip::CompressionMethod::Deflated);
        }
    }
}
