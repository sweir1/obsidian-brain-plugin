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
3. Writes a discovery file to `{VAULT}/.obsidian/plugins/obsidian-brain-companion/discovery.json` with `{port, token, pid, pluginVersion, startedAt}`.
4. The `obsidian-brain` server, when started with `VAULT_PATH` pointed at the same vault, reads the discovery file to find the plugin.

Every request is authenticated with `Authorization: Bearer <token>`. Unauthorized requests get a 401. The server binds strictly to `127.0.0.1`, never to a LAN-facing address.

On plugin unload, the HTTP server shuts down and the discovery file is removed.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/status` | Health check + plugin version + vault name. |
| GET | `/active` | Active note path + cursor + selection. |
| POST | `/dataview` | _(v0.2)_ Run a DQL query via the Dataview plugin. |
| POST | `/base` | _(v0.3)_ Evaluate a `.base` file and return rows. |

All responses are JSON.

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

Then point your MCP client at `obsidian-brain server`. When both are running and the client has `VAULT_PATH` set to the same vault this plugin is installed in, the server discovers the plugin on boot and the `active_note` / `dataview_query` / `base_query` tools become available.

See [`sweir1/obsidian-brain`](https://github.com/sweir1/obsidian-brain) for full setup.

## Security

- Binds only to `127.0.0.1`. Never listens on a LAN interface.
- Bearer token required on every request.
- Token is random (32 bytes hex) and regenerated on every plugin startup — no persistent secret.
- No cookies, no CORS, no write endpoints (Phases 1–3 are read-only).

## License

[MIT](./LICENSE).
