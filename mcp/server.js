/**
 * Larapaper Studio MCP server (stdio transport).
 *
 * Lets AI agents create and edit Larapaper/TRMNL recipe projects headlessly.
 * All domain logic lives in project.js; this file is thin MCP glue: a tool
 * registry (name + JSON schema + description) mapped onto session functions.
 *
 * Run:  node server.js        (speaks MCP over stdin/stdout)
 * Test: node --test           (uses the exported TOOLS registry + dispatch)
 */
import { fileURLToPath } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import * as P from './project.js';

/* ------------------------------------------------------------------ */
/* shared schema fragments                                             */
/* ------------------------------------------------------------------ */

const AREA = {
  type: 'object',
  description: 'Grid cell area; x/y are 0-based, w/h in cells.',
  properties: {
    x: { type: 'integer', minimum: 0 },
    y: { type: 'integer', minimum: 0 },
    w: { type: 'integer', minimum: 1 },
    h: { type: 'integer', minimum: 1 }
  }
};

const CONDITION = {
  type: 'object',
  description:
    'Visibility condition (see ui/shared/conditions.js). ' +
    '{ enabled: true, op, path, fields?, value? }. ' +
    "op: 'mentions'|'not_mentions'|'equals'|'not_equals'|'present'|'blank'. " +
    "path: Liquid path into the sample data, e.g. 'data.disruptions'. " +
    "value: needle/comparison literal (required for mentions/not_mentions/equals/not_equals). " +
    'fields: for mentions ops on arrays, the item fields to search.',
  properties: {
    enabled: { type: 'boolean' },
    op: { type: 'string', enum: ['mentions', 'not_mentions', 'equals', 'not_equals', 'present', 'blank'] },
    path: { type: 'string' },
    fields: { type: 'array', items: { type: 'string' } },
    value: { type: ['string', 'number', 'boolean'] }
  },
  required: ['enabled', 'op', 'path']
};

/* ------------------------------------------------------------------ */
/* tool registry                                                       */
/* ------------------------------------------------------------------ */

/**
 * Every entry: { name, description, inputSchema (JSON Schema), run(session, args) }.
 * run returns a plain object; { error: '...' } results are reported as tool
 * errors (isError) instead of throwing.
 */
export const TOOLS = [
  {
    name: 'lp_create_project',
    description:
      'Create a new Larapaper recipe project in memory (one open project per session). ' +
      'device: a preset name from LPRecipe.DEVICE_PRESETS (e.g. "Kindle PW7 (portrait)", ' +
      '"TRMNL OG") or a custom { width, height, padding? } profile.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Recipe name (shown on the device).' },
        device: {
          oneOf: [
            { type: 'string', description: 'Device preset name, e.g. "Kindle PW7 (portrait)".' },
            {
              type: 'object',
              properties: {
                width: { type: 'integer' },
                height: { type: 'integer' },
                padding: { type: 'integer' }
              },
              required: ['width', 'height']
            }
          ]
        }
      },
      required: ['name']
    },
    run: (s, a) => P.createProject(s, a)
  },
  {
    name: 'lp_open_project',
    description: 'Open an existing .lpsproj.json project file; device and sources are normalized to defaults where missing.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to the .lpsproj.json file.' } },
      required: ['path']
    },
    run: (s, a) => P.openProject(s, a)
  },
  {
    name: 'lp_save_project',
    description: 'Save the open project as .lpsproj.json (secret source header values are stripped). Defaults to the last opened/saved path.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Target path; omit to reuse the last path.' } }
    },
    run: (s, a) => P.saveProject(s, a)
  },
  {
    name: 'lp_get_document',
    description:
      'Compact snapshot of the open project: device, per-layout grid + widget trees ' +
      '(id/type/area/props with long text truncated), sources (secret values hidden) and staticData keys.',
    inputSchema: { type: 'object', properties: {} },
    run: (s) => P.getDocument(s)
  },
  {
    name: 'lp_list_widget_types',
    description:
      'List all 18 widget types grouped by palette category, each with its prop schema ' +
      '(keys, types, options, defaults). Call this before lp_add_widget if unsure about props.',
    inputSchema: { type: 'object', properties: {} },
    run: () => P.listWidgetTypes()
  },
  {
    name: 'lp_add_widget',
    description:
      'Add a widget. Defaults: layout "full", parent = layout root with automatic grid placement ' +
      '(first free cell). Pass area to request a cell — on collision the nearest free cell is used. ' +
      'parentId may name a container widget (col/row/grid/list) instead of the root. Returns the new node id.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Widget type, e.g. "title_bar", "value", "text", "list".' },
        layout: { type: 'string', enum: ['full', 'half_horizontal', 'half_vertical', 'quadrant'] },
        parentId: { type: 'string', description: 'Container widget id; default is the layout root.' },
        area: AREA,
        props: { type: 'object', description: 'Initial prop values (merged over the type defaults).' }
      },
      required: ['type']
    },
    run: (s, a) => P.addWidget(s, a)
  },
  {
    name: 'lp_update_widget',
    description: 'Shallow-merge props into an existing widget (by id).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        props: { type: 'object' }
      },
      required: ['id', 'props']
    },
    run: (s, a) => P.updateWidget(s, a)
  },
  {
    name: 'lp_move_widget',
    description:
      'Move a direct root child to a new grid area. The area is clamped into the grid; ' +
      'on collision the nearest free cell wins (same behavior as dragging in the app).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        area: AREA
      },
      required: ['id', 'area']
    },
    run: (s, a) => P.moveWidget(s, a)
  },
  {
    name: 'lp_remove_widget',
    description: 'Remove a widget (and its subtree) by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    },
    run: (s, a) => P.removeWidget(s, a)
  },
  {
    name: 'lp_set_condition',
    description:
      'Attach a visibility condition to a widget. The widget (incl. subtree) is wrapped in a ' +
      'standard Liquid guard at build time. Returns the human summary plus the generated guard ' +
      'for transparency.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        condition: CONDITION
      },
      required: ['id', 'condition']
    },
    run: (s, a) => P.setCondition(s, a)
  },
  {
    name: 'lp_set_sample_data',
    description:
      'Set the design-time sample data (doc.staticData) used by bindings ({{ data.* }}), ' +
      'conditions and the preview render. mode "replace" (default) swaps the whole object, "merge" merges keys.',
    inputSchema: {
      type: 'object',
      properties: {
        data: { type: 'object', description: 'Sample data JSON object.' },
        mode: { type: 'string', enum: ['replace', 'merge'] }
      },
      required: ['data']
    },
    run: (s, a) => P.setSampleData(s, a)
  },
  {
    name: 'lp_add_source',
    description:
      'Add an API data source. preset "gvb" pre-fills the GVB (Amsterdam transit) disruptions ' +
      'endpoint incl. WAF-friendly headers; otherwise pass name + url (+ method/headers/dataKey).',
    inputSchema: {
      type: 'object',
      properties: {
        preset: { type: 'string', enum: ['gvb'] },
        name: { type: 'string' },
        url: { type: 'string' },
        method: { type: 'string', enum: ['GET', 'POST'] },
        headers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              value: { type: 'string' },
              secret: { type: 'boolean', description: 'Secret values are not saved into the project file.' }
            },
            required: ['key', 'value']
          }
        },
        dataKey: { type: 'string', description: 'Key under which an array payload is wrapped as sample data.' }
      }
    },
    run: (s, a) => P.addSource(s, a)
  },
  {
    name: 'lp_fetch_source',
    description:
      'Fetch a source URL now and parse the JSON. A browser User-Agent is sent by default ' +
      '(GVB is behind an Azure WAF that 403s plain clients). With useAsSampleData (default true) ' +
      'the payload replaces the sample data via wrapSampleData. Returns HTTP status plus a capped ' +
      'list of JSON leaf paths describing the payload structure.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Source id from lp_add_source.' },
        useAsSampleData: { type: 'boolean', default: true }
      },
      required: ['id']
    },
    run: (s, a) => P.fetchSource(s, a)
  },
  {
    name: 'lp_validate',
    description:
      'Validate the open project: document rules (name, non-empty full layout, custom fields, ' +
      'sample data shape) plus per-widget condition validity.',
    inputSchema: { type: 'object', properties: {} },
    run: (s) => P.validate(s)
  },
  {
    name: 'lp_build_recipe',
    description:
      'Build the deployable recipe: settings.yml + one .liquid per enabled layout. ' +
      'With outDir the files are written to disk (directories created); the file map is always returned.',
    inputSchema: {
      type: 'object',
      properties: { outDir: { type: 'string', description: 'Optional output directory for the recipe files.' } }
    },
    run: (s, a) => P.buildRecipe(s, a)
  },
  {
    name: 'lp_render_layout',
    description:
      'Render a layout with the preview Liquid evaluator and sample data. Returns the HTML plus ' +
      'a plain-text extraction (tags stripped) for quick content verification.',
    inputSchema: {
      type: 'object',
      properties: { layout: { type: 'string', enum: ['full', 'half_horizontal', 'half_vertical', 'quadrant'], default: 'full' } }
    },
    run: (s, a) => P.renderLayout(s, a)
  },
  {
    name: 'lp_screenshot_layout',
    description:
      'Rasterize one layout to a PNG via headless Chromium so you can SEE the design ' +
      '(font sizes, wrapping, overflow, alignment) instead of guessing from HTML. Uses the ' +
      'same render pipeline and framework CSS as the studio canvas. Returns the image path — ' +
      'view it with a vision tool; do not inline the bytes.',
    inputSchema: {
      type: 'object',
      properties: {
        layout: { type: 'string', enum: ['full', 'half_horizontal', 'half_vertical', 'quadrant'], default: 'full' },
        scale: { type: 'number', description: 'Device pixel ratio for the raster (default 2).', default: 2 },
        out: { type: 'string', description: 'Optional PNG output path.' },
        outDir: { type: 'string', description: 'Optional directory for the PNG + the debug HTML.' }
      }
    },
    run: (s, a) => P.screenshotLayout(s, a)
  },
  {
    name: 'lp_list_layouts',
    description: 'List the four layouts: enabled flag, grid cols×rows and widget count.',
    inputSchema: { type: 'object', properties: {} },
    run: (s) => P.listLayouts(s)
  }
];

/* ------------------------------------------------------------------ */
/* dispatch + transport glue                                           */
/* ------------------------------------------------------------------ */

/** Execute one tool call against a session. Returns the plain result object. */
export async function dispatch(session, name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { error: 'Unknown tool "' + name + '".' };
  try {
    return await tool.run(session, args || {});
  } catch (e) {
    return { error: e && e.message ? e.message : String(e) };
  }
}

function toolResult(result) {
  const isError = result && typeof result === 'object' && typeof result.error === 'string';
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    ...(isError ? { isError: true } : {})
  };
}

export async function main() {
  const session = P.createSession();
  const server = new Server(
    { name: 'larapaper-studio-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    toolResult(await dispatch(session, req.params.name, req.params.arguments)));
  await server.connect(new StdioServerTransport());
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((e) => {
    console.error('MCP server failed:', e);
    process.exit(1);
  });
}
