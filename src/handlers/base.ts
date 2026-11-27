import type * as http from "http";
import { Plugin, normalizePath, type App, type TFile } from "obsidian";
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
  /** Community plugins. */
  plugins?: {
    plugins?: Record<string, unknown>;
    enabledPlugins?: Set<string>;
  };
  /** Core plugins (undocumented, stable since Obsidian 0.x). */
  internalPlugins?: {
    plugins?: Record<string, { enabled?: boolean } | undefined>;
    getEnabledPluginById?: (id: string) => unknown;
  };
}

/** True if Obsidian's Bases core plugin is switched on in this vault. */
export function isBasesEnabled(app: App): boolean {
  const a = app as ObsidianAppWithPlugins;
  const internal = a.internalPlugins;
  if (internal) {
    // `getEnabledPluginById` returns the instance only while enabled
    // (`getPluginById` would return the wrapper even when it's off).
    if (typeof internal.getEnabledPluginById === "function") {
      if (internal.getEnabledPluginById("bases") != null) return true;
    }
    if (internal.plugins?.bases?.enabled === true) return true;
  }
  // Harmless fallback for a hypothetical community "bases" plugin.
  return a.plugins?.enabledPlugins?.has("bases") === true;
}

/**
 * Resolve the Bases core plugin into one of three outcomes the caller can
 * discriminate.
 *
 * Bases is a *core* plugin: its on/off state lives in the core-plugin
 * registry (`app.internalPlugins`), not the community one
 * (`app.plugins.enabledPlugins`). We check:
 *   1. Bases is enabled (see {@link isBasesEnabled}).
 *   2. The Obsidian build exposes `registerBasesView()` on
 *      `Plugin.prototype` → Obsidian ≥ 1.10.0, the first release with a
 *      stable `.base` format and Bases API surface.
 *
 * Evaluation itself only needs `parseYaml`, the vault's file list and the
 * metadata cache, which all pre-date Bases.
 */
export type ResolvedBases =
  | { ok: true; app: App }
  | { ok: false; kind: "not_enabled" | "unsupported_obsidian_version" };

export function resolveBases(app: App): ResolvedBases {
  if (!isBasesEnabled(app)) {
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

type ResolvedFile =
  | { ok: true; file: TFile }
  | { ok: false; error: "bad_request" | "base_file_not_found"; message: string };

/**
 * Resolve the requested `.base` file through the vault, never the raw
 * filesystem: vault-relative only (no absolute paths, no `..`), `.base`
 * extension required, and it must be a file the vault knows about.
 */
export function resolveBaseFile(app: App, requested: string): ResolvedFile {
  const trimmed = requested.trim();
  const reject: ResolvedFile = {
    ok: false,
    error: "bad_request",
    message: "`file` must be a path inside the vault (no drive letters, network paths or '..').",
  };
  // Real absolute paths: `C:\…`, `C:/…`, `\\server\…`, `//server/…`.
  if (/^[A-Za-z]:/.test(trimmed) || /^[\\/]{2}/.test(trimmed)) return reject;
  let raw = trimmed.replace(/\\/g, "/");
  if (raw.split("/").some((seg) => seg === "..")) return reject;
  // A leading `/` or `./` is the vault root.
  raw = raw.replace(/^(?:\.?\/)+/, "");
  const path = normalizePath(raw);
  if (!/\.base$/i.test(path)) {
    return { ok: false, error: "bad_request", message: "`file` must be a `.base` file." };
  }
  const file = app.vault.getAbstractFileByPath(path);
  if (!file || !("extension" in file) || "children" in file) {
    return { ok: false, error: "base_file_not_found", message: `No .base file at '${path}' in this vault.` };
  }
  return { ok: true, file: file as TFile };
}

export async function handleBase(
  res: http.ServerResponse,
  app: App,
  body: BaseRequestBody,
): Promise<void> {
  res.setHeader("content-type", "application/json");

  if (body.view !== undefined && body.view !== null && typeof body.view !== "string") {
    res.statusCode = 400;
    res.end(
      JSON.stringify({
        error: "bad_request",
        message: "`view` must be a string (the view's name). Omit it to run the first view.",
      }),
    );
    return;
  }
  const view = typeof body.view === "string" && body.view !== "" ? body.view : undefined;

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
    const found = resolveBaseFile(app, body.file as string);
    if (!found.ok) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: found.error, message: found.message }));
      return;
    }
    try {
      yaml = await app.vault.cachedRead(found.file);
    } catch (err) {
      res.statusCode = 400;
      res.end(
        JSON.stringify({
          error: "base_file_read_failed",
          message: `Could not read '${found.file.path}': ${err instanceof Error ? err.message : String(err)}`,
        }),
      );
      return;
    }
  } else {
    yaml = body.yaml as string;
  }

  let result;
  try {
    result = evaluateBase(app, { yaml, view });
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
      view: result.view,
      rows: result.rows,
      total: result.total,
      ...(result.groupBy !== undefined ? { groupBy: result.groupBy, groups: result.groups } : {}),
      ...(result.warnings ? { warnings: result.warnings } : {}),
      executedAt: new Date().toISOString(),
    }),
  );
}
