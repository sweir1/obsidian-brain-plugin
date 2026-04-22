import { Plugin } from "obsidian";
import { randomBytes } from "crypto";
import { CompanionServer } from "./server";
import { Discovery } from "./discovery";
import {
  CompanionSettingTab,
  DEFAULT_SETTINGS,
  type CompanionSettings,
} from "./settings";

export default class ObsidianBrainCompanion extends Plugin {
  settings: CompanionSettings = DEFAULT_SETTINGS;
  private companion: CompanionServer | null = null;
  private discovery: Discovery | null = null;

  async onload(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    this.addSettingTab(new CompanionSettingTab(this.app, this));

    const token = randomBytes(32).toString("hex");

    this.companion = new CompanionServer({
      app: this.app,
      manifest: this.manifest,
      token,
      port: this.settings.port,
    });

    try {
      const actualPort = await this.companion.start();

      this.discovery = new Discovery(this.app);
      await this.discovery.write({
        port: actualPort,
        token,
        pid: process.pid,
        pluginVersion: this.manifest.version,
        startedAt: Date.now(),
        capabilities: ["status", "active", "dataview", "base"],
      });

      console.info(
        `obsidian-brain-companion: listening on 127.0.0.1:${actualPort}`,
      );
    } catch (err) {
      console.error(
        `obsidian-brain-companion: failed to start HTTP server on port ${
          this.settings.port
        }. Change the port under Settings → obsidian-brain companion. (${String(
          err,
        )})`,
      );
      this.companion = null;
    }
  }

  async onunload(): Promise<void> {
    try {
      await this.companion?.stop();
    } catch (err) {
      console.error(
        `obsidian-brain-companion: error stopping HTTP server: ${String(err)}`,
      );
    }
    try {
      await this.discovery?.clear();
    } catch (err) {
      console.error(
        `obsidian-brain-companion: error removing discovery file: ${String(
          err,
        )}`,
      );
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
