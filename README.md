# obsidian-brain companion

A small Obsidian plugin that exposes Obsidian's **live runtime state** (active editor, Dataview query results, Bases views) to the [`obsidian-brain`](https://github.com/sweir1/obsidian-brain) MCP server over a **localhost-only HTTP endpoint**.

This plugin is **optional**. `obsidian-brain` works standalone against your vault's files on disk. Install this plugin only if you want the MCP tools that depend on Obsidian being open — `active_note`, `dataview_query`, `base_query`.

## What it is

`obsidian-brain` is a standalone Node MCP server that gives Claude (and any other MCP client) semantic search + knowledge graph + vault editing over an Obsidian vault. It reads `.md` files directly from disk — Obsidian doesn't need to be running.

Three kinds of data, however, **only exist inside a running Obsidian process**:

- **Dataview DQL** — Dataview's index lives in Obsidian's memory.
- **Obsidian Bases** — view rows are computed by Obsidian against its metadata cache.
- **Active editor state** — which note you're currently editing, cursor position.

This plugin publishes those three things on a localhost HTTP endpoint that the `obsidian-brain` server connects to when available.

## How it works

On plugin load:

1. Binds an HTTP server to `127.0.0.1` on a configurable port (default `27125`).
2. Generates a random bearer token (regenerated every startup, never persisted).
3. Writes a discovery file to `{VAULT}/.obsidian/plugins/obsidian-brain-companion/discovery.json` with `{port, token, pid, pluginVersion, startedAt, capabilities}`. The `capabilities` field (new in v0.2.0) is a string array like `["status", "active", "dataview", "base"]` — the server uses it to fail fast on capability-gated tool calls when an older plugin is installed. The `"base"` capability was added in v1.4.0.
4. The `obsidian-brain` server, when started with `VAULT_PATH` pointed at the same vault, reads the discovery file to find the plugin.

Every request is authenticated with `Authorization: Bearer <token>`. Unauthorized requests get a 401. The server binds strictly to `127.0.0.1`, never to a LAN-facing address.

On plugin unload, the HTTP server shuts down and the discovery file is removed.

## Endpoints

| Method | Path | Purpose | Shipped |
|---|---|---|---|
| GET | `/status` | Health check + plugin version + vault name + advertised capabilities. | v0.1.0 |
| GET | `/active` | Active note path + cursor + selection. | v0.1.0 |
| POST | `/dataview` | Run a Dataview DQL query via the installed Dataview community plugin. Returns a normalized `{kind, ...}` shape (table / list / task / calendar). Requires the Dataview plugin installed + enabled; returns `424` otherwise. | v0.2.0 |
| POST | `/base` | Evaluate an Obsidian Bases `.base` file (YAML + view name) and return rows. Requires Obsidian ≥ 1.10.0 with the Bases core plugin enabled; returns `424` otherwise. | v1.4.0 |

All responses are JSON. `POST /dataview` accepts a body of `{query: string, source?: string}` up to 256KB; requests are serialised (one in-flight at a time) since Dataview has no cancellation API. `POST /base` accepts `{file?: string, yaml?: string, view: string}` — either `file` (vault-relative path to a `.base` file) or `yaml` (inline source) is required. Requests to `/base` are serialised on their own queue since the evaluator walks every markdown file to build entries.

## About the "Dataview community plugin"

The name is genuinely confusing because three pieces of software are involved, two of which are ours and one of which isn't:

| # | Name | Who wrote it | What it does |
|---|---|---|---|
| 1 | **`obsidian-brain`** | us — [sweir1/obsidian-brain](https://github.com/sweir1/obsidian-brain) | The MCP server (Node package on npm). Your MCP client spawns it. |
| 2 | **`obsidian-brain-companion`** | us — this repo | The Obsidian plugin you're reading docs for. Exposes `/dataview`. |
| 3 | **Dataview** (`obsidian-dataview`) | [blacksmithgu](https://github.com/blacksmithgu/obsidian-dataview) | A third-party Obsidian community plugin with ~4M+ installs ([community-plugin-stats.json](https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json): 4,008,313 as of April 2025). Implements the Dataview Query Language (DQL) and maintains an in-memory index of the vault. |

**Version landscape** (as of 2026-04-22):

| Channel | Version | Who gets this | When |
|---|---|---|---|
| GitHub release (what Obsidian's Community Plugin browser pulls) | **0.5.70** | End users installing via Obsidian | 2025-04-07 |
| npm `obsidian-dataview` | **0.5.68** | Developers who `npm install -D obsidian-dataview` for type defs | 2025-03-15 |
| Dataview's upstream "Develop Against Dataview" docs page | says `0.5.64` | — (the page is stale) | — |

What actually matters: the runtime behaviour a plugin sees through `getAPI(app)` is whatever the user has installed in their vault — typically 0.5.70. The npm version only affects TypeScript autocomplete during development.

**We do not reimplement DQL.** Our companion plugin calls into Dataview's plugin API from inside the same Obsidian process:

```ts
// Sanctioned path per Dataview's plugin-author guide
// (https://blacksmithgu.github.io/obsidian-dataview/resources/develop-against-dataview/):
import { getAPI } from "obsidian-dataview";
const api = getAPI(app);

// What our companion plugin actually uses (no runtime dep on obsidian-dataview):
const api = app.plugins.plugins.dataview?.api;

// Either way, the same query:
const result = await api.query(userQuery);
```

These aren't just "equivalent" — they're literally the same lookup. `getAPI(app)` is implemented in [`src/index.ts` L49-52](https://github.com/blacksmithgu/obsidian-dataview/blob/master/src/index.ts) as a thin wrapper:

```ts
export const getAPI = (app?: App): DataviewApi | undefined => {
  if (app) return app.plugins.plugins.dataview?.api;
  else return window["DataviewAPI"];
};
```

So our plugin-global call resolves to exactly the same `DataviewApi` object `getAPI()` would return. We use the back-door path because it avoids pulling the `obsidian-dataview` npm package into our runtime closure — saves ~5MB of devDep install that esbuild would otherwise bundle types from.

**Install Dataview in Obsidian** (not via npm) — Settings → Community plugins → Browse → search "Dataview" (by blacksmithgu) → Install → Enable. Then reload Obsidian once so its API registers on the `app.plugins.plugins.dataview` global. Without this, our `/dataview` route returns 424 with an install-prompt message.

**`index-ready` caveat.** Dataview builds its index asynchronously on Obsidian startup and fires `app.metadataCache.on("dataview:index-ready", ...)` when done (trigger site: [`src/data-index/index.ts` L152](https://github.com/blacksmithgu/obsidian-dataview/blob/master/src/data-index/index.ts)). Before that event, `api.query()` may return incomplete results against a partial index. In practice reindexing is fast enough that interactive use rarely notices, but if you run `dataview_query` within the first few seconds of Obsidian startup and get surprisingly few rows, retry once the index has warmed.

Further reading: Dataview's [plugin-author guide](https://blacksmithgu.github.io/obsidian-dataview/resources/develop-against-dataview/), [plugin-api.ts source](https://github.com/blacksmithgu/obsidian-dataview/blob/master/src/api/plugin-api.ts), [DQL query structure](https://blacksmithgu.github.io/obsidian-dataview/queries/structure/).

## About Obsidian Bases

Bases is different from Dataview in two ways that matter here: it is a **core** Obsidian feature (shipped with Obsidian 1.10.0, not a third-party community plugin), and as of Obsidian 1.12.x it has **no public API for headless query execution**. That pair of facts shapes how the `/base` route works.

### The three pieces

| # | Name | Who wrote it | What it does |
|---|---|---|---|
| 1 | **`obsidian-brain`** | us — [sweir1/obsidian-brain](https://github.com/sweir1/obsidian-brain) | The MCP server (Node package on npm). Your MCP client spawns it. |
| 2 | **`obsidian-brain-companion`** | us — this repo | The Obsidian plugin you're reading docs for. Exposes `/base`. |
| 3 | **Bases** | [Obsidian](https://obsidian.md) (first-party, core plugin) | YAML-declared views over the vault's metadata cache. Shipped with Obsidian ≥ 1.10.0. User toggles it on under Settings → Core plugins. |

No runtime dependency on `obsidian-bases` (there is no such npm package — Bases lives inside Obsidian itself).

### Why Path B (own YAML + expression evaluator)

Unlike Dataview — where `app.plugins.plugins.dataview.api.query(...)` is a sanctioned read path — Obsidian 1.12.x exposes Bases with only the view-factory hook, `Plugin.registerBasesView()`. The public type surface in `obsidian.d.ts` includes:

- `BasesQueryResult` (the shape views receive for rendering)
- `BasesEntry` (one row; `file: TFile`, `getValue(propertyId): Value | null`)
- `BasesView` (abstract view base class, constructed with a `QueryController`)
- `QueryController` — empty class body. No public method to execute a query against user-supplied config.
- `Plugin.registerBasesView(viewId, registration): boolean` — registers a custom view type.

What is **missing**: any `app.bases.runQuery(config)`, `app.bases.getViewFiles(path)`, or `new QueryController({filters, views})` wired to produce a `BasesQueryResult` we can read. A [forum request](https://forum.obsidian.md/t/provide-api-access-to-the-results-of-bases-view/110660) opened 2026-01-31 to expose this surface is still unacknowledged as of 2026-04-22.

So our plugin takes **Path B**: parse the `.base` YAML ourselves via Obsidian's bundled `parseYaml`, iterate `app.vault.getMarkdownFiles()` + `app.metadataCache.getFileCache(file)` to build entries, and run a whitelisted expression evaluator against the filter tree.

### What that whitelist covers (v1.4.0)

- Tree ops: `and`, `or`, `not` (nested).
- Comparisons: `==`, `!=`, `>`, `>=`, `<`, `<=`.
- Leaf-string boolean: `&&`, `||`, `!` in expressions like `file.hasTag("book") && status == "reading"`.
- File props: `file.{name, path, folder, ext, size, mtime, ctime, tags}`.
- File methods: `file.hasTag("x")`, `file.inFolder("x")`.
- Frontmatter: `frontmatter.X`, bare `X`, nested `X.sub.leaf`.
- View `sort:`, `limit:`, `columns:`.

### What that whitelist **explicitly rejects** (with clear `unsupported_construct` errors naming the fragment)

Arithmetic (`+ - * / %`), date arithmetic with duration strings, method calls other than `.hasTag` / `.inFolder`, function calls (`today()`, `now()`, `date()`, `list()`, `link()`, `icon()`), regex literals, top-level `formulas:` block, top-level `summaries:` block, `this` context references. These are deferred to v1.4.1 / v1.4.2 / v1.4.3 patches as users hit them.

### Planned: swap to Path A when upstream ships the API

When Obsidian exposes `app.bases.runQuery(...)` (or equivalent), we plan a drop-in swap. The `BasesEntry` / `BasesQueryResult` type surface has been stable since 1.10.0, and our response shape already mirrors it closely (`{view, rows, total, executedAt}` → `{view, data, total, executedAt}` maps cleanly onto `BasesQueryResult.data: BasesEntry[]`). Clients of `base_query` won't need to change.

### Install Bases (it's core, not community)

Bases is toggled under **Settings → Core plugins → Bases** (no Community plugins browser step). If it's off, our `/base` route returns 424 with a "toggle Bases on" message. If you're running Obsidian < 1.10.0, the route returns 424 with an "upgrade Obsidian" message.

## Install

### Via BRAT (recommended while pre-release)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin.
2. `BRAT: Add a beta plugin for testing` → `sweir1/obsidian-brain-plugin`.
3. Enable `obsidian-brain companion` under Settings → Community plugins.

### Manual

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/sweir1/obsidian-brain-plugin/releases/latest).
2. Place both in `{VAULT}/.obsidian/plugins/obsidian-brain-companion/`.
3. Reload Obsidian → enable under Settings → Community plugins.

## Pair with the server

```bash
npm install -g obsidian-brain
```

Then point your MCP client at `obsidian-brain server`. When both are running and the client has `VAULT_PATH` set to the same vault this plugin is installed in, the server discovers the plugin on boot and the capability-gated tools become available:

- `active_note` — server v1.2.0+, plugin v0.1.0+.
- `dataview_query` — server v1.3.0+, plugin v0.2.0+, plus the Dataview community plugin installed and enabled in the vault.
- `base_query` — server v1.4.0+, plugin v1.4.0+, plus Obsidian ≥ 1.10.0 with the Bases core plugin enabled in the vault.

See [`sweir1/obsidian-brain`](https://github.com/sweir1/obsidian-brain) for full setup.

## Security

- Binds only to `127.0.0.1`. Never listens on a LAN interface.
- Bearer token required on every request.
- Token is random (32 bytes hex) and regenerated on every plugin startup — no persistent secret.
- No cookies, no CORS, no write endpoints (Phases 1–3 are read-only).

## License

[MIT](./LICENSE).
