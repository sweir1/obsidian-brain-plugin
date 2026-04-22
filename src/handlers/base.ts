import type * as http from "http";
import { Plugin, type App } from "obsidian";
import {
  evaluateBase,
  UnsupportedConstructError,
  BaseEvaluationError,
} from "./base-evaluator";

export interface BaseRequestBody {
  file?: unknown;
  yaml?: unknown;
  view?: unknown;
}

interface ObsidianAppWithPlugins extends App {
  plugins?: {
    plugins?: Record<string, unknown>;
    enabledPlugins?: Set<string>;
  };
}

/**
 * Resolve the Bases core plugin into one of three outcomes the caller can
 * discriminate.
 *
 * Bases is a *core* plugin (not a community plugin), shipped with Obsidian
 * 1.10.0+. The core-plugin registry lives under the same `app.plugins.*`
 * shape as community plugins, but the presence-check is subtly different:
 * Bases doesn't expose a public runtime API yet (see `Plugin.registerBasesView`
 * is view-factory only), so we check:
 *   1. The plugin is listed in `app.plugins.enabledPlugins` → user toggled it on.
 *   2. The Obsidian build we're running against exposes `registerBasesView()`
 *      on `Plugin.prototype` → Obsidian ≥ 1.10.0.
 *
 * If both are true, we have a runnable environment for the Path B evaluator
 * (YAML parsing via `parseYaml` + `app.vault.getMarkdownFiles()` +
 * `app.metadataCache.getFileCache()` — all of which pre-date Bases and need
 * no gating of their own).
 */
export type ResolvedBases =
  | { ok: true; app: App }
  | { ok: false; kind: "not_enabled" | "unsupported_obsidian_version" };

export function resolveBases(app: App): ResolvedBases {
  const registry = (app as ObsidianAppWithPlugins).plugins;
  if (!registry?.enabledPlugins?.has("bases")) {
    return { ok: false, kind: "not_enabled" };
  }
  if (
    typeof (Plugin.prototype as { registerBasesView?: unknown })
      .registerBasesView !== "function"
  ) {
    return { ok: false, kind: "unsupported_obsidian_version" };
  }
  return { ok: true, app };
}

export const BASE_UNAVAILABLE_MESSAGES: Record<
  "not_enabled" | "unsupported_obsidian_version",
  { error: string; message: string }
> = {
  not_enabled: {
    error: "bases_not_enabled",
    message:
      "Obsidian's Bases core plugin is not enabled in this vault. Obsidian → Settings → Core plugins → toggle 'Bases' on, then retry.",
  },
  unsupported_obsidian_version: {
    error: "unsupported_obsidian_version",
    message:
      "Obsidian's Bases feature requires Obsidian 1.10.0 or later. Please upgrade Obsidian and retry.",
  },
};

export async function handleBase(
  res: http.ServerResponse,
  app: App,
  body: BaseRequestBody,
): Promise<void> {
  res.setHeader("content-type", "application/json");

  if (typeof body.view !== "string" || body.view.length === 0) {
    res.statusCode = 400;
    res.end(
      JSON.stringify({
        error: "bad_request",
        message: "Request body must include a non-empty `view` string.",
      }),
    );
    return;
  }

  const hasFile = typeof body.file === "string" && body.file.length > 0;
  const hasYaml = typeof body.yaml === "string" && body.yaml.length > 0;
  if (!hasFile && !hasYaml) {
    res.statusCode = 400;
    res.end(
      JSON.stringify({
        error: "bad_request",
        message:
          "Request body must include either a non-empty `file` (vault-relative path to a .base file) or a non-empty `yaml` (inline .base YAML).",
      }),
    );
    return;
  }

  const resolved = resolveBases(app);
  if (!resolved.ok) {
    res.statusCode = 424;
    res.end(JSON.stringify(BASE_UNAVAILABLE_MESSAGES[resolved.kind]));
    return;
  }

  let yaml: string;
  if (hasFile) {
    try {
      yaml = await app.vault.adapter.read(body.file as string);
    } catch (err) {
      res.statusCode = 400;
      res.end(
        JSON.stringify({
          error: "base_file_read_failed",
          message: `Could not read .base file at '${
            body.file as string
          }': ${err instanceof Error ? err.message : String(err)}`,
        }),
      );
      return;
    }
  } else {
    yaml = body.yaml as string;
  }

  let result;
  try {
    result = evaluateBase(app, { yaml, view: body.view });
  } catch (err) {
    if (err instanceof UnsupportedConstructError) {
      res.statusCode = 400;
      res.end(
        JSON.stringify({
          error: "unsupported_construct",
          message: err.message,
        }),
      );
      return;
    }
    if (err instanceof BaseEvaluationError) {
      res.statusCode = 400;
      res.end(
        JSON.stringify({
          error: "base_eval_error",
          message: err.message,
        }),
      );
      return;
    }
    res.statusCode = 500;
    res.end(
      JSON.stringify({
        error: "base_threw",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return;
  }

  res.statusCode = 200;
  res.end(
    JSON.stringify({
      view: body.view,
      rows: result.rows,
      total: result.total,
      executedAt: new Date().toISOString(),
    }),
  );
}
