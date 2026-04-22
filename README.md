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
3. Writes a discovery file to `{VAULT}/.obsidian/plugins/obsidian-brain-companion/discovery.json` with `{port, token, pid, pluginVersion, startedAt, capabilities}`. The `capabilities` field (new in v0.2.0) is a string array like `["status", "active", "dataview"]` — the server uses it to fail fast on capability-gated tool calls when an older plugin is installed.
4. The `obsidian-brain` server, when started with `VAULT_PATH` pointed at the same vault, reads the discovery file to find the plugin.

Every request is authenticated with `Authorization: Bearer <token>`. Unauthorized requests get a 401. The server binds strictly to `127.0.0.1`, never to a LAN-facing address.

On plugin unload, the HTTP server shuts down and the discovery file is removed.

## Endpoints

| Method | Path | Purpose | Shipped |
|---|---|---|---|
| GET | `/status` | Health check + plugin version + vault name + advertised capabilities. | v0.1.0 |
| GET | `/active` | Active note path + cursor + selection. | v0.1.0 |
| POST | `/dataview` | Run a Dataview DQL query via the installed Dataview community plugin. Returns a normalized `{kind, ...}` shape (table / list / task / calendar). Requires the Dataview plugin installed + enabled; returns `424` otherwise. | v0.2.0 |
| POST | `/base` | Evaluate a `.base` file and return rows. | v0.3.0 (planned) |

All responses are JSON. `POST /dataview` accepts a body of `{query: string, source?: string}` up to 256KB; requests are serialised (one in-flight at a time) since Dataview has no cancellation API.

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

The npm → GitHub lag is ~3 weeks. Practically irrelevant: the runtime behaviour a plugin sees through `getAPI(app)` is whatever the user actually has installed — typically 0.5.70. The npm version only affects slightly older TypeScript types in developer IDE autocomplete.

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
- `base_query` — planned for server v1.4.0 + plugin v0.3.0.

See [`sweir1/obsidian-brain`](https://github.com/sweir1/obsidian-brain) for full setup.

## Security

- Binds only to `127.0.0.1`. Never listens on a LAN interface.
- Bearer token required on every request.
- Token is random (32 bytes hex) and regenerated on every plugin startup — no persistent secret.
- No cookies, no CORS, no write endpoints (Phases 1–3 are read-only).

## License

[MIT](./LICENSE).
