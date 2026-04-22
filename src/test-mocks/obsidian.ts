/**
 * Minimal runtime shim for the `obsidian` module used by vitest. The real
 * `obsidian` npm package ships types only (`"main": ""`) — at runtime Obsidian
 * injects the implementations. esbuild marks it external for the plugin
 * build. For unit tests we only need the pieces our own code imports at
 * runtime: `Plugin` (prototype gets mutated to simulate registerBasesView
 * presence), `parseYaml` (delegated to the `yaml` devDep), and a few
 * value-level re-exports that our source imports.
 *
 * This shim is ONLY loaded via `vitest.config.ts`'s alias — the production
 * esbuild bundle never sees it.
 */

import { parse as parseYamlImpl } from "yaml";

export function parseYaml(src: string): unknown {
  return parseYamlImpl(src);
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/");
}

export class Plugin {
  // No-op base class — tests that import `Plugin` use it only to mutate the
  // prototype (simulate registerBasesView presence).
}

// Placeholder class re-exports — imported as types elsewhere, but we also
// need them present at runtime so `import { MarkdownView, ... }` doesn't
// break during vitest module loading.
export class MarkdownView {}
export class PluginSettingTab {}
export class Setting {}
export class App {}

export type PluginManifest = { id: string; version: string };
export type TFile = unknown;
