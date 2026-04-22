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
  };
}

function getDataviewApi(app: App): DataviewApi | null {
  const withPlugins = app as ObsidianAppWithPlugins;
  const dv = withPlugins.plugins?.plugins?.["dataview"];
  if (!dv || typeof (dv as { api?: unknown }).api !== "object") return null;
  const api = (dv as { api: unknown }).api;
  if (api && typeof (api as { query?: unknown }).query === "function") {
    return api as DataviewApi;
  }
  return null;
}

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

  const dv = getDataviewApi(app);
  if (!dv) {
    res.statusCode = 424;
    res.end(
      JSON.stringify({
        error: "dataview_not_installed",
        message:
          "The Dataview community plugin is not installed or not enabled in this vault. Install it from Settings → Community plugins and retry.",
      }),
    );
    return;
  }

  const source = typeof body.source === "string" ? body.source : undefined;

  let result;
  try {
    result = await dv.query(body.query, source);
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
