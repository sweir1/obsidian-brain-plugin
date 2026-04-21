import { App, PluginSettingTab, Setting } from "obsidian";
import type ObsidianBrainCompanion from "./main";

export interface CompanionSettings {
  /** TCP port to bind. `0` picks a random free port on each plugin load. */
  port: number;
}

export const DEFAULT_SETTINGS: CompanionSettings = {
  port: 27125,
};

export class CompanionSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: ObsidianBrainCompanion,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "obsidian-brain companion" });

    const desc = containerEl.createEl("p");
    desc.appendText(
      "Exposes Obsidian's live runtime state to the obsidian-brain MCP server over a localhost-only HTTP endpoint. ",
    );
    desc.appendText(
      "Reload the plugin (disable + re-enable) after changing the port.",
    );

    new Setting(containerEl)
      .setName("HTTP port")
      .setDesc(
        "Port to bind on 127.0.0.1. Default 27125. Set to 0 to pick a random free port each start.",
      )
      .addText((text) =>
        text
          .setPlaceholder("27125")
          .setValue(String(this.plugin.settings.port))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!Number.isNaN(n) && n >= 0 && n < 65536) {
              this.plugin.settings.port = n;
              await this.plugin.saveSettings();
            }
          }),
      );
  }
}
