import type * as http from "http";
import type { App } from "obsidian";
import type { DataviewApi } from "../dataview/types";
import { normalizeDataviewResult } from "../dataview/normalize";

export interface DataviewRequestBody {
  query?: unknown;
  source?: unknown;
}

interface ObsidianAppWithPlugins extends App {
  plugins?: {
    plugins?: Record<string, { api?: unknown } | undefined>;
    enabledPlugins?: Set<string>;
  };
}

/**
 * Resolve Dataview into one of four outcomes the caller can discriminate.
 *
 * We use the raw `app.plugins` surface rather than importing `obsidian-dataview`'s
 * `getAPI()` / `isPluginEnabled()` helpers. Looking at the upstream source
 * (reference/obsidian-dataview/src/index.ts:54 + :60) the helpers are literally:
 *   getAPI(app)         === app.plugins.plugins.dataview?.api
 *   isPluginEnabled(app) === app.plugins.enabledPlugins.has("dataview")
 * Using the plugin-global fields directly avoids pulling obsidian-dataview as a
 * runtime dependency while producing identical behaviour.
 */
export type ResolvedDataview =
  | { ok: true; api: DataviewApi }
  | { ok: false; kind: "not_installed" | "not_enabled" | "api_not_ready" };

export function resolveDataview(app: App): ResolvedDataview {
  const withPlugins = app as ObsidianAppWithPlugins;
  const registry = withPlugins.plugins;
  const dv = registry?.plugins?.["dataview"];

  if (!dv) return { ok: false, kind: "not_installed" };
  if (!registry?.enabledPlugins?.has("dataview")) {
    return { ok: false, kind: "not_enabled" };
  }

  const api = (dv as { api?: unknown }).api;
  if (
    !api ||
    typeof api !== "object" ||
    typeof (api as { query?: unknown }).query !== "function"
  ) {
    return { ok: false, kind: "api_not_ready" };
  }
  return { ok: true, api: api as DataviewApi };
}

export const UNAVAILABLE_MESSAGES: Record<
  "not_installed" | "not_enabled" | "api_not_ready",
  { error: string; message: string }
> = {
  not_installed: {
    error: "dataview_not_installed",
    message:
      "The Dataview community plugin is not installed in this vault. Install it: Obsidian → Settings → Community plugins → Browse → search 'Dataview' (by blacksmithgu) → Install → Enable.",
  },
  not_enabled: {
    error: "dataview_not_enabled",
    message:
      "The Dataview community plugin is installed but not enabled in this vault. Obsidian → Settings → Community plugins → toggle 'Dataview' on, then retry.",
  },
  api_not_ready: {
    error: "dataview_api_not_ready",
    message:
      "The Dataview community plugin is enabled but its API isn't registered on app.plugins.plugins.dataview yet. Reload Obsidian (Command palette → 'Reload app without saving', or ⌘R / Ctrl+R) and retry — this usually clears within a few seconds of enabling the plugin.",
  },
};

export async function handleDataview(
  res: http.ServerResponse,
  app: App,
  body: DataviewRequestBody,
): Promise<void> {
  res.setHeader("content-type", "application/json");

  if (typeof body.query !== "string" || body.query.length === 0) {
    res.statusCode = 400;
    res.end(
      JSON.stringify({
        error: "bad_request",
        message: "Request body must include a non-empty `query` string.",
      }),
    );
    return;
  }

  const resolved = resolveDataview(app);
  if (!resolved.ok) {
    res.statusCode = 424;
    res.end(JSON.stringify(UNAVAILABLE_MESSAGES[resolved.kind]));
    return;
  }

  const source = typeof body.source === "string" ? body.source : undefined;

  let result;
  try {
    result = await resolved.api.query(body.query, source);
  } catch (err) {
    res.statusCode = 500;
    res.end(
      JSON.stringify({
        error: "dataview_threw",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return;
  }

  if (!result.successful || !result.value) {
    res.statusCode = 400;
    res.end(
      JSON.stringify({
        error: "dql_error",
        message: result.error ?? "Dataview reported an unsuccessful query.",
      }),
    );
    return;
  }

  let normalized;
  try {
    normalized = normalizeDataviewResult(result.value);
  } catch (err) {
    res.statusCode = 500;
    res.end(
      JSON.stringify({
        error: "normalize_failed",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return;
  }

  res.statusCode = 200;
  res.end(JSON.stringify(normalized));
}
