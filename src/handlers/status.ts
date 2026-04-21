import type * as http from "http";
import type { App, PluginManifest } from "obsidian";

export function handleStatus(
  res: http.ServerResponse,
  manifest: PluginManifest,
  app: App,
  readyAt: number,
): void {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      ok: true,
      pluginId: manifest.id,
      pluginVersion: manifest.version,
      vaultName: app.vault.getName(),
      readyAt,
    }),
  );
}
