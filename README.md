# Larapaper Studio (Tauri edition)

A visual, drag-and-drop desktop designer for **Larapaper / TRMNL recipes** (e-ink dashboard plugins).
Design your screens on a pixel-true canvas with a live Liquid preview, then **export a recipe
ZIP** or **push directly to your Larapaper server**.

Rewrite of the original Electron app on **Tauri 2** (Rust backend + system WebView2): a fraction
of the RAM and disk footprint, same feature set — plus **device profiles** (custom resolutions /
portrait orientation) and **API data sources** (design with real data, e.g. GVB disruptions).

## Run

```bash
npm install          # once: Tauri CLI + yaml (test-only)
npm run dev          # launch the app (cargo + webview)
npm run build        # release exe + MSI/NSIS installers (see below)
npm test             # node:test suites for the shared JS layer
cargo test           # (in src-tauri/) Rust unit tests
```

End-to-end smoke test (headless boot + live GVB fetch + sources flow + widget conditions +
search bindings + synthetic drag & drop, driven by an in-page harness over the Tauri bridge):

```bash
./src-tauri/target/debug/larapaper-studio.exe --smoke-test   # after cargo build
```

Requires (build-time only): Rust toolchain (rustup), MSVC Build Tools, WebView2 Runtime
(preinstalled on Win10/11), Node 18+ (only for the Tauri CLI and tests — the app itself
has no Node runtime).

## Distribution (for non-devs)

`npm run build` produces self-contained artifacts in `src-tauri/target/release/`:

- `larapaper-studio.exe` — portable binary (~13 MB), double-click to run. No npm, Node,
  or Rust needed; WebView2 is preinstalled on Windows 10/11.
- `bundle/nsis/Larapaper Studio_<ver>_x64-setup.exe` — installer for end users
  (auto-installs WebView2 if missing).
- `bundle/msi/Larapaper Studio_<ver>_x64_en-US.msi` — MSI alternative.

Equivalent without npm: `cargo build --release` in `src-tauri/` (produces the exe only).

## Features

Everything from the Electron version:

- **Visual designer** — a configurable cell grid (cols × rows per layout, editable in the
  statusbar). Drag widgets from the palette onto the screen; they snap to cells and can span
  multiple cells (bottom-right resize handle, or the inspector's Grid area x/y/w/h inputs).
  Nested Column/Row/Grid containers compose content inside a cell. Click to select, `Del`
  deletes, `Ctrl+D` duplicates, full undo/redo (`Ctrl+Z/Y`). The grid exports as a real CSS
  grid (`grid-template-columns/rows` + `grid-column/row` cell wrappers), so Larapaper renders
  exactly what you designed.
- **18 widget types** — Column, Row, Grid, Spacer, Divider, Title, Label, Value, Text, Rich text,
  Title bar, Image, QR code, Progress bar, Item, List (repeater), Table, Bar chart.
- **Live Liquid preview** — forgiving Liquid-subset evaluator renders with sample data (`data.*`),
  `config.*` custom-field defaults, `size`, and `trmnl.*` context. QR codes render as real SVG.
  Bindings that resolve to nothing render as a dashed **placeholder chip** (design-time only), so
  widgets never silently vanish.
- **Preview mode** — the toolbar's **Preview** button opens a clean, full-window render of the
  current layout (switchable between enabled layouts), scaled to fit, with no editor chrome —
  what the device will show.
- **4 layouts** — Full, Half Horizontal, Half Vertical, Quadrant. Only enabled layouts are exported.
- **Data & Config editor** — sample-data JSON editor (with a **⤢ Expand** button opening a
  large editor modal: Format / Apply / inline parse errors) + custom fields → `settings.yml → custom_fields`.
- **Recipe settings** — name, description, strategy (`static` / `polling`), refresh interval,
  framework version, dark mode, no-screen-padding.
- **Export** — flat recipe ZIP (`settings.yml` + `<layout>.liquid`) or write files to a folder.
- **Push to Larapaper** — server URL + Sanctum token, test connection, link existing plugin
  setting, push. First push creates (`POST /api/plugin_settings`), later pushes update in place
  (`POST /api/plugin_settings/{id}/archive`).

New in this edition:

- **Device profiles** (Recipe panel → Device) — design at any screen resolution. Presets:
  TRMNL OG 800×480, Kindle PW7 landscape 1448×1072, **Kindle PW7 portrait 1072×1448**, or Custom
  (width/height/padding). **⇄ Rotate** swaps width/height in place. The profile is a design-time
  setting stored in the project; exported recipes stay device-agnostic (the Larapaper server
  renders per device model).
- **API data sources** (Sources panel) — named HTTP sources with custom headers / API keys.
  Fetch real JSON, browse its structure in a collapsible tree (with **text search**: filters to
  matching leaves + ancestors, auto-expands and `<mark>`-highlights, and a **⤢** button that
  opens the same interactive tree in a large modal), **Bind** any leaf to the
  selected widget (`{{ data.<path> }}` — the payload is auto-merged as sample data if it isn't
  yet, so the binding renders immediately), **ƒ Cond** to wrap the selected widget in a
  *mentions* condition pre-filled from that leaf, **Use as sample data** to render the preview
  with real data (this **replaces** the sample data — starter keys are not kept), or
  **Use in recipe** to fill the polling strategy. Header rows flagged
  *secret* are masked and only saved into the project file when "Save secrets in project" is ticked.
  Built-in preset: **GVB Disruptions** (Amsterdam public transport). The GVB endpoint sits behind
  an Azure WAF JS challenge — the backend sends browser-like headers by default, which passes it.
- **MCP server** (`mcp/`) — headless agent access: AI agents can create/edit projects over the
  Model Context Protocol (17 tools: projects, widgets, grid placement, conditions, sources +
  live fetch, validation, recipe build, layout render). See `mcp/README.md`.
- **Widget conditions** (inspector → Condition, every non-root widget) — wrap any widget in a
  standard-Liquid guard: *mentions / doesn't mention* (intelligent text search over an array's
  item fields — "if bus 34 is not mentioned in the GVB disruptions, display OPERATING NORMALLY"),
  *equals / not equals*, *is present / is blank*. The path input auto-completes from the sample
  data; search fields are auto-detected from the array items. Haystack and needle are normalized
  (lowercase, punctuation → space, space-wrapped) so `34` matches "Bus 34" but not "134"/"340" —
  using only bog-standard Liquid (capture/assign/for/if/unless + replace/downcase/map/join), so
  exported recipes render identically in Larapaper's own engine. Conditioned root children show
  a small **ƒ** badge on the canvas; a widget currently hidden by its condition stays visible as
  a dashed **ghost box** in its grid cell (click it to select and edit the condition) — the
  full-window Preview modal always shows device truth instead.
- **Search-and-pick bindings** (inspector → Search binding, every widget with a text prop) —
  display text selected from API data by a search query: pick an array path, the item fields to
  search, a match mode (*begins with* / *contains* / *equals*) and a query ("metro 52"). A live
  **match picker** (computed from the sample data) shows the hits and chooses which one the
  widget displays — ① ② ③…, *All (joined)* or *Last*. Exports as bog-standard Liquid
  (capture/assign/for/if + downcase/truncate/split/join/first/last) so Larapaper renders it
  identically; the binding **overrides** the target prop's value and composes with conditions
  (the guard wraps the searched widget). Sources panel tree leaves get a third **⌕ Search**
  button that drafts a binding on the selected widget from that leaf (path = nearest array
  ancestor, query = the tree's search text).

## Project files

Projects save as `*.lpsproj.json` (recipe meta, device profile, sources, staticData, customFields,
per-layout widget trees, server settings). The server token is only stored with "Remember token";
secret source headers only with "Save secrets in project".

## Architecture

```
src-tauri/
  src/main.rs         Tauri commands: project save/open, export ZIP/folder, generic http_request
                      (browser-UA default), Larapaper API (test/list/push, multipart archive upload),
                      --smoke-test mode (evals test/smoke.js, prints SMOKE_* lines, exits 0/1)
  tauri.conf.json     no bundler: frontendDist ../ui, withGlobalTauri, dragDropEnabled: false
                      (Tauri's default true breaks in-page HTML5 drag & drop on Windows)
ui/
  index.html          App shell
  css/                app.css (editor chrome) + trmnl-preview.css (TRMNL design system, real px)
  vendor/qrcode.js    vendored qrcode-generator (MIT)
  shared/             UMD modules shared with Node tests:
    widgets.js        Widget registry: palette, inspector schemas, Liquid markup generation
    conditions.js     Widget conditions: rule model + standard-Liquid guard generator
    search-binding.js Search-and-pick bindings: spec model + standard-Liquid picker generator
    recipe.js         Document model, device profiles, validation, settings.yml + liquid builders
    liquid-eval.js    Liquid-subset preview evaluator (~50 filters, for/if/unless/assign/…)
    yaml.js           Minimal YAML emitter
    sources.js        API source model, GVB preset, JSON path/binding helpers, secret stripping
  js/
    bridge.js         window.lp → Tauri invoke (the only backend surface)
    state.js          Document state, undo/redo, selection, mutations
    canvas.js         Device canvas: preview render, selection, drag & drop, zoom
    inspector.js      Properties panel (schema-driven)
    panels.js         Data & Config + Recipe settings panels
    panel-sources.js  Sources panel: editor, fetch, JSON tree, bind/sample/recipe actions
    push.js           Push-to-server modal
    app.js            Bootstrap, palette, layout tabs, toolbar, keyboard
test/                 node:test suites (shared layer is plain JS — no app runtime needed)
```

Notes & conventions:

- The `title_bar` widget is hoisted out of `.layout` on export/preview — on the device it is a
  sibling of `.layout` inside `.view` (drives the `.layout:has(+ .title_bar)` height shrink).
- Layout roots are CSS grids (`.layout--grid` + `.lp-cell` wrappers). Root children carry
  `area: {x,y,w,h}` in cell units; children without one (old projects) auto-place row-major
  at render/export time — the doc is not rewritten on load.
- Browser chrome is suppressed (no right-click context menu, no F5/Ctrl+R reload) — it is a
  desktop app, not a page; a stray Refresh would discard unsaved work.
- QR widget exports `{{ expr | qr_code: <module>, '<ec>' }}` where `module = round(size/29)`.
- The preview evaluator is intentionally forgiving; the authoritative render happens server-side.
- Layout boxes are computed per device: `full = (W-2p)×(H-2p)`, halves `round((inner-gap)/2)` per
  axis. For the default 800×480 device this yields 780×460 / 780×225 / 385×460 / 385×225
  (the Electron app hardcoded 387 for width halves; no consistent formula reproduces it).
