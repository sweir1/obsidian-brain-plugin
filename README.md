# obsidian-brain companion

> **Companion to [`sweir1/obsidian-brain`](https://github.com/sweir1/obsidian-brain)** — see the [docs site](https://sweir1.github.io/obsidian-brain/plugin/) for setup walkthrough, the Dataview integration story, and security model.

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
| POST | `/base` | Evaluate an Obsidian Bases `.base` file (one of its views) and return rows. Requires Obsidian ≥ 1.10.0 with the Bases core plugin enabled; returns `424` otherwise. | v1.4.0 |

All responses are JSON. `POST /dataview` accepts a body of `{query: string, source?: string}` up to 256KB; requests are serialised (one in-flight at a time) since Dataview has no cancellation API. `POST /base` accepts `{file?: string, yaml?: string, view?: string}` — either `file` (vault-relative path to a `.base` file) or `yaml` (inline source) is required; `view` names the view to run and defaults to the first one, as when Obsidian opens a base. It returns `{view, rows, total, groupBy?, groups?, warnings?, executedAt}`. Requests to `/base` are serialised on their own queue since the evaluator walks every file in the vault.

## About the "Dataview community plugin"

> **Install first:** Dataview is a separate third-party community plugin (not shipped with Obsidian, not built by us). Install in Obsidian → Settings → Community plugins → Browse → search "Dataview" (by blacksmithgu) → Install → Enable, then reload Obsidian once so its API registers on `app.plugins.plugins.dataview.api`. Without Dataview installed and enabled, our `/dataview` route returns 424. DQL syntax reference: <https://blacksmithgu.github.io/obsidian-dataview/>.

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

Bases is different from Dataview in two ways that matter here: it is a **core** Obsidian feature (not a third-party community plugin), and Obsidian has **no public API for running a base headlessly** and reading its rows. That pair of facts shapes how the `/base` route works.

### The three pieces

| # | Name | Who wrote it | What it does |
|---|---|---|---|
| 1 | **`obsidian-brain`** | us — [sweir1/obsidian-brain](https://github.com/sweir1/obsidian-brain) | The MCP server (Node package on npm). Your MCP client spawns it. |
| 2 | **`obsidian-brain-companion`** | us — this repo | The Obsidian plugin you're reading docs for. Exposes `/base`. |
| 3 | **Bases** | [Obsidian](https://obsidian.md) (first-party, core plugin) | YAML-declared views over the vault. User toggles it on under Settings → Core plugins. |

No runtime dependency on `obsidian-bases` (there is no such npm package — Bases lives inside Obsidian itself). Because Bases is a core plugin, the companion checks Obsidian's core-plugin registry to see whether it's on.

### How a base is evaluated

Obsidian exposes Bases to plugins only through view hooks (`Plugin.registerBasesView()`, `BasesView`, `BasesQueryResult`); there is no `runQuery(config)` that returns rows. So the companion reads the `.base` YAML itself and evaluates it against the vault, following the [Bases syntax](https://help.obsidian.md/bases/syntax):

- **Rows:** every file in the vault, as in Obsidian — notes and attachments. Note properties come from the metadata cache; properties typed as Date or Date & time in Settings → Properties are dates, and untyped `YYYY-MM-DD` values still work as dates. Tags come from Obsidian's own `getAllTags`. Files at the vault root have `file.folder` `"/"`.
- **Views:** the `views:` list; the requested view by name (or the first one). Every view type — table, cards, list, kanban, map, or a plugin's — selects rows the same way.
- **Filters:** global and view `filters:`, combined with AND. `and` / `or` / `not` groups nest; `not` excludes a file if **any** listed condition holds ("None of the following are true"). An empty group imposes no condition. A group may use only one of `and` / `or` / `not`, and a misspelt key (`And:`, `nor:`) is an error rather than a filter that silently matches nothing.
- **Expressions:** literals and `[lists]`; note properties as `note.x`, `note["x"]` or bare `x`; `file.name` (with extension), `file.basename`, `path`, `folder`, `ext`, `size`, `ctime`, `mtime`, `tags`, `links`, `embeds`, `backlinks`, `properties`; `formula.x`; indexing; arithmetic `+ - * / %`, including date ± duration (`now() - "1 week"`) and date − date; comparisons; `&&` `||` `!`.
- **Functions:** `if`, `list`, `number`, `min`, `max`, `date`, `now`, `today`, `duration`; `file.hasTag` (any of several, nested tags included), `file.inFolder`, `file.hasLink`, `file.hasProperty`; string `contains` / `containsAll` / `containsAny` / `startsWith` / `endsWith` / `lower` / `title` / `trim` / `replace` (plain text) / `repeat` / `reverse` / `slice` / `split`; number `abs` / `ceil` / `floor` / `round` / `toFixed`; list `contains*` / `join` / `flat` / `unique` / `reverse` / `slice` / `sort`; date fields (`year` … `millisecond`), `date()`, `time()`, `format()`, `relative()`; object `keys` / `values`; `isEmpty`, `isTruthy`, `isType`, `toString` on anything.
- **Formulas:** `formulas:` entries are computed per row and can build on each other; circular formulas are an error.
- **Columns:** `order:` lists the columns. Each row has `file: {name, basename, path}` plus one key per column — note properties without the `note.` prefix (`status`), others as written (`file.mtime`, `formula.ppu`). Dates without a time are `YYYY-MM-DD`; dates with a time are ISO 8601.
- **Sort, group, limit:** `sort:` (`{property, direction}` list), `groupBy:` with `groupOrder:` (only listed groups, in that order; `null` = files with no value), and `limit:`. `total` counts rows before the limit; grouped views also return `groups: [{value, count}]`.
- **Ignored:** `properties:` (display names), `summaries:`, `columnSize:` and any other display-only keys.

### What it can't evaluate

These return `400 unsupported_construct` naming the construct, rather than wrong rows: `this` (it depends on where Obsidian displays the base), regular expressions and `.matches()`, list lambdas (`filter` / `map` / `reduce`), and display-only functions (`link`, `image`, `icon`, `html`, `escapeHTML`, `random`, `file()`, `asLink`). Everything is checked before any row is evaluated, so the result never depends on which files happen to be in the vault. A formula that can't be computed fails the query when a filter, sort or group needs it; when it's only a **column**, that column is `null` with a note in `warnings`, so one display-only formula doesn't fail the whole query. A value of the wrong type in one note (`status.lower()` where one note has `status: 5`) makes that note's value `null`, with a warning.

`due-date` means `due` minus `date`, as in Obsidian; write `note["due-date"]` for a property with a hyphen (you get a warning when that's probably what you meant). Adding a bare number to a date (`today() + 7`) gives `null` with a warning; add a duration such as `"7d"`.

### Limits

The evaluator runs inside Obsidian, where a runaway query can't be interrupted, so it fails with `400 base_eval_error` instead of hanging or running out of memory: expressions up to 20,000 characters and 200 levels of nesting, filters up to 10,000 conditions and 64 levels, formula chains up to 64 deep, function results up to 1,000,000 characters or 100,000 list items, and 10 seconds per query. A recursive YAML anchor in `filters:` is an error.

`file` must be a vault-relative path to a `.base` file; absolute paths and `..` are rejected, and the file is read through the vault.

Files written by earlier companion versions — `views:` as a map keyed by name, `columns:` instead of `order:`, `sort: [{column}]`, `frontmatter.x`, and the `{property: {">=": 4}}` filter shorthand — still work.

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

### Version compatibility

**Rule of thumb:** install the **same major.minor** on both sides. Server `1.5.x` pairs with plugin `1.5.x` — that's the tested, supported combo. Patch-version drift (e.g. server `1.5.4` + plugin `1.5.2`) is fine; patch releases don't change the protocol surface.

Other combinations (e.g. older plugin + newer server) often work thanks to capability gating — the plugin advertises its supported routes in `discovery.json` and the server fails loudly with a clean "upgrade plugin vX.Y+" error if a required capability is missing — but aren't explicitly tested and aren't guaranteed. If you mix and something breaks, upgrade the lagging side.

See [`sweir1/obsidian-brain`](https://github.com/sweir1/obsidian-brain) for full setup.

## Security

- Binds only to `127.0.0.1`. Never listens on a LAN interface.
- Bearer token required on every request.
- Token is random (32 bytes hex) and regenerated on every plugin startup — no persistent secret.
- No cookies, no CORS, no write endpoints (Phases 1–3 are read-only).

## License

[MIT](./LICENSE).
