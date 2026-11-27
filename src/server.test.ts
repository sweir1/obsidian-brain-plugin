import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Plugin, type App, type PluginManifest, type TFile } from "obsidian";
import { CompanionServer } from "./server";

/**
 * End to end over real HTTP: the route, auth, JSON body parsing, the /base
 * queue and the handler together — what the obsidian-brain server actually
 * talks to.
 */

const TOKEN = "test-token";
let server: CompanionServer;
let port = 0;
let savedRegister: unknown;

function file(path: string): TFile {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return {
    path,
    name,
    basename: name.slice(0, dot),
    extension: name.slice(dot + 1),
    parent: { path: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/" },
    stat: { size: 10, mtime: 1, ctime: 1 },
  } as unknown as TFile;
}

const files = [file("Projects/A.md"), file("Projects/B.md"), file("Inbox/C.md")];
const frontmatter: Record<string, Record<string, unknown>> = {
  "Projects/A.md": { status: "Planned" },
  "Projects/B.md": { status: "Done" },
  "Inbox/C.md": { status: "Planned" },
};

const app = {
  internalPlugins: {
    plugins: { bases: { enabled: true } },
    getEnabledPluginById: (id: string) => (id === "bases" ? {} : null),
  },
  plugins: { enabledPlugins: new Set<string>() },
  vault: {
    getFiles: () => files,
    getMarkdownFiles: () => files,
    getName: () => "vault",
    getAbstractFileByPath: (p: string) => {
      if (p === "Explode.base") throw new Error("vault exploded");
      return p === "Board.base" ? file("Board.base") : files.find((f) => f.path === p) ?? null;
    },
    cachedRead: async (t: TFile) => {
      if (t.path === "Board.base") {
        return "filters: file.inFolder(\"Projects\")\nviews:\n  - type: kanban\n    name: Board\n    groupBy:\n      property: status\n      direction: ASC\n    order:\n      - file.basename\n      - status\n";
      }
      throw new Error("ENOENT");
    },
  },
  metadataCache: {
    resolvedLinks: {},
    getFirstLinkpathDest: () => null,
    getFileCache: (f: TFile) => ({ frontmatter: frontmatter[f.path] ?? {} }),
  },
} as unknown as App;

beforeAll(async () => {
  savedRegister = (Plugin.prototype as { registerBasesView?: unknown }).registerBasesView;
  (Plugin.prototype as { registerBasesView?: unknown }).registerBasesView = () => true;
  server = new CompanionServer({
    app,
    manifest: { id: "obsidian-brain-companion", version: "test" } as PluginManifest,
    token: TOKEN,
    port: 0,
  });
  port = await server.start();
});

afterAll(async () => {
  await server.stop();
  (Plugin.prototype as { registerBasesView?: unknown }).registerBasesView = savedRegister;
});

async function post(body: unknown, token = TOKEN): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/base`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("POST /base over HTTP", () => {
  it("rejects a wrong token", async () => {
    const { status } = await post({ file: "Board.base" }, "nope");
    expect(status).toBe(401);
  });

  it("evaluates a .base file from the vault with no view named (first view)", async () => {
    const { status, json } = await post({ file: "Board.base" });
    expect(status).toBe(200);
    expect(json.view).toBe("Board");
    expect(json.total).toBe(2);
    expect(json.groups).toEqual([
      { value: "Done", count: 1 },
      { value: "Planned", count: 1 },
    ]);
    expect(json.rows).toEqual([
      { file: { name: "B.md", basename: "B", path: "Projects/B.md" }, "file.basename": "B", status: "Done" },
      { file: { name: "A.md", basename: "A", path: "Projects/A.md" }, "file.basename": "A", status: "Planned" },
    ]);
  });

  it("serves concurrent requests one after another without mixing them up", async () => {
    const results = await Promise.all([
      post({ yaml: "views:\n  - type: table\n    name: All\n" }),
      post({ file: "Board.base" }),
      post({ yaml: "filters: 'status == \"Planned\"'\nviews:\n  - type: table\n    name: P\n" }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(results.map((r) => r.json.total)).toEqual([3, 2, 2]);
  });

  it("answers 500 when a handler throws unexpectedly, instead of leaving the caller waiting", async () => {
    const started = Date.now();
    const { status, json } = await post({ file: "Explode.base" });
    expect(status).toBe(500);
    expect(json).toEqual({ error: "internal", message: "vault exploded" });
    expect(Date.now() - started).toBeLessThan(2000);
    // The queue keeps working afterwards.
    expect((await post({ file: "Board.base" })).status).toBe(200);
  }, 4000);

  it("returns the evaluator's errors as JSON", async () => {
    const { status, json } = await post({ yaml: "filters: this.file.name\n" });
    expect(status).toBe(400);
    expect(json.error).toBe("unsupported_construct");
  });
});
