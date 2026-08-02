# larapaper-studio-mcp

An [MCP](https://modelcontextprotocol.io) server (stdio transport) that lets AI
agents create and edit [Larapaper Studio](../README.md) recipe projects
headlessly — no GUI running. It reuses the app's entire domain layer
(`../ui/shared/*.js`, UMD modules loaded via CJS interop): document model,
device presets, cell-grid placement, widget registry, Liquid generation,
conditions, sources, validation and the preview renderer.

Session state: **one open project in memory** (document + file path).

## Install & run

Requires Node ≥ 22 (global `fetch`). Dependencies are intentionally separate
from the app (the app itself stays dependency-free):

```sh
cd mcp
npm install
npm start          # speaks MCP over stdin/stdout
npm test           # node --test (headless, no network)
```

### Self-serve setup (for agents, e.g. Hermes)

An agent can install and verify everything on its own:

```sh
git clone https://github.com/sanzharid/larapaper-studio.git
cd larapaper-studio/mcp
./install.sh --print-config
```

The script checks Node ≥ 18, installs dependencies, runs the test suite, and
prints the exact MCP registration snippet with the correct absolute path.
Layout note: `mcp/` imports `../ui/shared/`, so always keep the two directories
side by side (clone the whole repo, don't copy `mcp/` alone).

## Client configuration

Generic MCP stdio config — point `node` at `server.js` with an absolute path:

```json
{
  "mcpServers": {
    "larapaper-studio": {
      "command": "node",
      "args": ["C:/Users/User/copilot-agent/larapaper-studio-tauri/mcp/server.js"]
    }
  }
}
```

## Tools

All tool results are JSON. Invalid input (unknown type/id, bad path, …) returns
`{ "error": "..." }` as a tool error instead of throwing.

| Tool | Purpose |
| --- | --- |
| `lp_create_project` | New project in memory. `device`: preset name (`'TRMNL OG'`, `'Kindle PW7 (landscape)'`, `'Kindle PW7 (portrait)'`) or `{width, height, padding?}`. |
| `lp_open_project` | Load a `.lpsproj.json` file (device/sources normalized to defaults). |
| `lp_save_project` | Write the project file (secret source header values stripped); defaults to the last path. |
| `lp_get_document` | Compact snapshot: device, per-layout grid + widget trees (long text truncated), sources (secrets hidden), staticData keys. |
| `lp_list_widget_types` | Palette categories + all 18 widget types with prop schemas (keys/types/options/defaults). |
| `lp_add_widget` | Add a widget. Default layout `full`, default parent = root with grid auto-place; optional `area` → nearest-free placement on collision. Returns the node id. |
| `lp_update_widget` | Shallow-merge props into a widget. |
| `lp_move_widget` | Change a root child's grid area (clamped; collision → nearest free, same as dragging in the app). |
| `lp_remove_widget` | Remove a widget and its subtree. |
| `lp_set_condition` | Attach a visibility condition (`mentions`/`not_mentions`/`equals`/`not_equals`/`present`/`blank`); returns summary + generated Liquid guard. |
| `lp_set_sample_data` | Replace (default) or merge design-time sample data. |
| `lp_add_source` | Add an API source; `preset: "gvb"` pre-fills the GVB disruptions endpoint incl. headers. |
| `lp_fetch_source` | Fetch + parse a source now (browser User-Agent by default — GVB's Azure WAF 403s plain clients). Optionally replaces sample data; returns status + capped JSON-path summary. |
| `lp_validate` | Document validation + per-widget condition validity. |
| `lp_build_recipe` | Build `settings.yml` + per-layout `.liquid`; optional `outDir` writes files; file map always returned. |
| `lp_render_layout` | Render a layout with the preview evaluator; returns HTML + plain-text extraction. |
| `lp_list_layouts` | Per layout: enabled, grid cols×rows, widget count. |

## Example session

Build a GVB disruptions recipe for a Kindle PW7 in portrait: fetch live
disruptions, list them, and show an "OPERATING NORMALLY" banner only while
line 34 is *not* mentioned.

```jsonc
// 1. Create the project on the Kindle PW7 portrait preset
{ "name": "lp_create_project", "arguments": {
  "name": "GVB Disruptions",
  "device": "Kindle PW7 (portrait)"
}}
// → { "name": "GVB Disruptions", "device": { "width": 1072, "height": 1448, ... }, ... }

// 2. Add the GVB source from the preset (URL + WAF-friendly headers included)
{ "name": "lp_add_source", "arguments": { "preset": "gvb" } }
// → { "id": "src_...", "name": "GVB Disruptions", "dataKey": "disruptions", ... }

// 3. Fetch it — the payload replaces the sample data ({ disruptions: [...] })
{ "name": "lp_fetch_source", "arguments": { "id": "src_..." } }
// → { "status": 200, "sampleDataApplied": true, "staticDataKeys": ["disruptions"],
//     "structure": ["disruptions[0].title", "disruptions[0].description", ...] }

// 4. Widgets: title bar + headline value + banner text + disruptions list
{ "name": "lp_add_widget", "arguments": {
  "type": "title_bar", "props": { "title": "GVB Disruptions" }
}}
{ "name": "lp_add_widget", "arguments": {
  "type": "value",
  "props": { "value": "data.disruptions[0].title", "size": "small", "caption": "Latest disruption" }
}}
// → { "id": "w12_ab3cd", "area": { "x": 0, "y": 0, "w": 1, "h": 1 }, ... }
{ "name": "lp_add_widget", "arguments": {
  "type": "text", "props": { "content": "OPERATING NORMALLY" }
}}
// → { "id": "w13_x7y8z", "area": { "x": 1, "y": 0, ... }, ... }
{ "name": "lp_add_widget", "arguments": {
  "type": "list", "props": { "collection": "disruptions" }
}}
// → { "id": "w14_q2w3e", ... }  (starts with one item-template child)

// 5. Bind the list's item template to the payload shape
//    (find the child id via lp_get_document, then:)
{ "name": "lp_update_widget", "arguments": {
  "id": "<item-template-id>",
  "props": { "title": "{{ item.title }}", "description": "{{ item.description }}" }
}}

// 6. Show the banner only while no disruption mentions line 34
{ "name": "lp_set_condition", "arguments": {
  "id": "w13_x7y8z",
  "condition": {
    "enabled": true, "op": "not_mentions", "path": "data.disruptions",
    "fields": ["title", "description"], "value": "34"
  }
}}
// → { "summary": "data.disruptions doesn't mention \"34\"",
//     "guard": { "open": "{% capture _lp_hay %}...{% unless _lp_hay contains ' 34 ' %}",
//                "close": "{% endunless %}" } }

// 7. Validate + render a proof
{ "name": "lp_validate", "arguments": {} }
// → { "valid": true, "errors": [], "conditionErrors": [] }
{ "name": "lp_render_layout", "arguments": { "layout": "full" } }
// → { "html": "...", "text": "Bus 34 rerouted … GVB Disruptions" }

// 8. Save the project and export the deployable recipe
{ "name": "lp_save_project", "arguments": { "path": "C:/recipes/gvb.lpsproj.json" } }
{ "name": "lp_build_recipe", "arguments": { "outDir": "C:/recipes/gvb" } }
// → { "files": { "settings.yml": "...", "full.liquid": "... {% unless _lp_hay contains ' 34 ' %} ..." },
//     "written": "C:/recipes/gvb" }
```

## Layout

- `project.js` — core: pure session functions (create/open/save, widget
  mutations with grid placement, conditions, sample data, sources + fetch,
  validate/build/render). No MCP imports; directly testable.
- `server.js` — thin MCP glue: the tool registry (names, JSON schemas,
  descriptions) mapped onto `project.js`, served over `StdioServerTransport`.
  Exports `TOOLS` + `dispatch()` for tests; only connects stdio when run
  directly.
- `server.test.js` — headless end-to-end (no network; `lp_fetch_source` runs
  against an injected fake fetch).

No changes to the app were needed: grid auto-placement
(`resolveAreas`/`firstFreeArea`/`normalizeArea`) was already exported from
`ui/shared/recipe.js`.
