import { App, normalizePath } from "obsidian";

export interface DiscoveryRecord {
  port: number;
  token: string;
  pid: number;
  pluginVersion: string;
  startedAt: number;
}

/**
 * Writes a discovery file at
 *   {VAULT}/.obsidian/plugins/obsidian-brain-companion/discovery.json
 * so the obsidian-brain MCP server can locate this plugin given only VAULT_PATH.
 */
export class Discovery {
  constructor(private app: App) {}

  private relPath(): string {
    return normalizePath(
      ".obsidian/plugins/obsidian-brain-companion/discovery.json",
    );
  }

  async write(record: DiscoveryRecord): Promise<void> {
    const adapter = this.app.vault.adapter;
    const p = this.relPath();
    await adapter.write(p, JSON.stringify(record, null, 2));
  }

  async clear(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const p = this.relPath();
    if (await adapter.exists(p)) {
      await adapter.remove(p);
    }
  }
}
