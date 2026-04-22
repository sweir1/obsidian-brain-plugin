import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Plugin, type App, type TFile } from "obsidian";
import {
  resolveBases,
  BASE_UNAVAILABLE_MESSAGES,
  handleBase,
} from "./base";

interface MockRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  setHeader: (k: string, v: string) => void;
  end: (chunk?: string) => void;
}

function mockRes(): MockRes {
  const r: MockRes = {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(k, v) {
      this.headers[k] = v;
    },
    end(chunk?: string) {
      if (chunk !== undefined) this.body = chunk;
    },
  };
  return r;
}

/**
 * A minimal markdown-file fixture. Mirrors the Bases entry fields the
 * evaluator reads (TFile.basename / path / extension / parent.path / stat,
 * plus app.metadataCache.getFileCache(file).frontmatter/tags).
 */
interface FixtureFile {
  basename: string;
  path: string;
  parentPath: string;
  extension: string;
  stat: { size: number; mtime: number; ctime: number };
  frontmatter?: Record<string, unknown>;
  tagCache?: string[];
}

/**
 * Build a minimal fake `app` object shaped the way the Bases handler + the
 * evaluator read it.
 */
function fakeApp(opts: {
  basesEnabled?: boolean;
  files?: FixtureFile[];
}): App {
  const basesEnabled = opts.basesEnabled ?? false;
  const files = opts.files ?? [];

  const enabled = new Set<string>();
  if (basesEnabled) enabled.add("bases");

  const tfiles: TFile[] = files.map((f) => {
    const parent =
      f.parentPath === "" || f.parentPath === "/"
        ? null
        : ({ path: f.parentPath } as unknown as { path: string });
    return {
      basename: f.basename,
      path: f.path,
      extension: f.extension,
      parent,
      stat: f.stat,
    } as unknown as TFile;
  });

  const cacheLookup = new Map<string, FixtureFile>();
  for (const f of files) cacheLookup.set(f.path, f);

  return {
    plugins: { plugins: {}, enabledPlugins: enabled },
    vault: {
      getMarkdownFiles: () => tfiles,
      adapter: {
        read: async (_p: string) => "",
      },
      getName: () => "test",
    },
    metadataCache: {
      getFileCache: (file: TFile) => {
        const entry = cacheLookup.get(file.path);
        if (!entry) return null;
        return {
          frontmatter: entry.frontmatter ?? {},
          tags: (entry.tagCache ?? []).map((t) => ({ tag: t })),
        };
      },
    },
  } as unknown as App;
}

/**
 * `registerBasesView` lives on `Plugin.prototype` in the shipped Obsidian
 * runtime. We mutate the prototype per-test and restore it after to simulate
 * an old-Obsidian build without the method.
 */
let originalRegisterBasesView: unknown;
beforeEach(() => {
  originalRegisterBasesView = (
    Plugin.prototype as { registerBasesView?: unknown }
  ).registerBasesView;
  // Ensure the default is "present" for happy paths.
  (Plugin.prototype as { registerBasesView?: unknown }).registerBasesView =
    function registerBasesViewStub(): boolean {
      return true;
    };
});
afterEach(() => {
  (Plugin.prototype as { registerBasesView?: unknown }).registerBasesView =
    originalRegisterBasesView;
});

describe("resolveBases", () => {
  it("returns not_enabled when bases is missing from enabledPlugins", () => {
    const r = resolveBases(fakeApp({ basesEnabled: false }));
    expect(r).toEqual({ ok: false, kind: "not_enabled" });
  });

  it("returns unsupported_obsidian_version when Plugin.prototype.registerBasesView is absent", () => {
    (Plugin.prototype as { registerBasesView?: unknown }).registerBasesView =
      undefined;
    const r = resolveBases(fakeApp({ basesEnabled: true }));
    expect(r).toEqual({ ok: false, kind: "unsupported_obsidian_version" });
  });

  it("returns ok:true with the app when bases is enabled and registerBasesView exists", () => {
    const app = fakeApp({ basesEnabled: true });
    const r = resolveBases(app);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.app).toBe(app);
  });
});

describe("handleBase — request validation", () => {
  it("rejects missing view field with 400 bad_request", async () => {
    const res = mockRes();
    await handleBase(
      res as unknown as import("http").ServerResponse,
      fakeApp({ basesEnabled: true }),
      { yaml: "views: {a: {}}" },
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("bad_request");
    expect(JSON.parse(res.body).message).toMatch(/non-empty `view`/);
  });

  it("rejects missing both file and yaml with 400 bad_request", async () => {
    const res = mockRes();
    await handleBase(
      res as unknown as import("http").ServerResponse,
      fakeApp({ basesEnabled: true }),
      { view: "default" },
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("bad_request");
    expect(JSON.parse(res.body).message).toMatch(/either.*`file`.*`yaml`/);
  });

  it("returns 424 bases_not_enabled when bases core plugin is off", async () => {
    const res = mockRes();
    await handleBase(
      res as unknown as import("http").ServerResponse,
      fakeApp({ basesEnabled: false }),
      { view: "default", yaml: "views:\n  default: {}" },
    );
    expect(res.statusCode).toBe(424);
    const parsed = JSON.parse(res.body);
    expect(parsed.error).toBe("bases_not_enabled");
    expect(parsed.message).toBe(BASE_UNAVAILABLE_MESSAGES.not_enabled.message);
    expect(parsed.message).toMatch(/Settings → Core plugins → toggle 'Bases'/);
  });
});

describe("handleBase — happy paths", () => {
  const bookYaml = `
views:
  active-books:
    filters:
      and:
        - "file.hasTag(\\"book\\")"
        - status:
            "==": reading
    columns:
      - status
      - rating
`;

  const files: FixtureFile[] = [
    {
      basename: "Dune",
      path: "books/Dune.md",
      parentPath: "books",
      extension: "md",
      stat: { size: 1000, mtime: 100, ctime: 50 },
      frontmatter: { status: "reading", rating: 5 },
      tagCache: ["#book"],
    },
    {
      basename: "Foundation",
      path: "books/Foundation.md",
      parentPath: "books",
      extension: "md",
      stat: { size: 2000, mtime: 200, ctime: 80 },
      frontmatter: { status: "done", rating: 4 },
      tagCache: ["#book"],
    },
    {
      basename: "Notes",
      path: "notes/Notes.md",
      parentPath: "notes",
      extension: "md",
      stat: { size: 500, mtime: 150, ctime: 60 },
      frontmatter: { status: "reading" },
      tagCache: [],
    },
  ];

  it("filters via file.hasTag + frontmatter comparison and projects columns", async () => {
    const res = mockRes();
    await handleBase(
      res as unknown as import("http").ServerResponse,
      fakeApp({ basesEnabled: true, files }),
      { view: "active-books", yaml: bookYaml },
    );
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.view).toBe("active-books");
    expect(parsed.total).toBe(1);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].file.name).toBe("Dune");
    expect(parsed.rows[0].status).toBe("reading");
    expect(parsed.rows[0].rating).toBe(5);
    expect(typeof parsed.executedAt).toBe("string");
  });

  it("evaluates nested and/or/not with frontmatter + file.size comparisons", async () => {
    const yaml = `
views:
  mixed:
    filters:
      or:
        - and:
            - "file.hasTag(\\"book\\")"
            - "file.size":
                ">": 1500
        - not:
            "file.hasTag(\\"book\\")"
    columns:
      - status
`;
    const res = mockRes();
    await handleBase(
      res as unknown as import("http").ServerResponse,
      fakeApp({ basesEnabled: true, files }),
      { view: "mixed", yaml },
    );
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    // Foundation (book, size=2000 > 1500) matches the AND branch.
    // Notes (not a book) matches the NOT branch.
    // Dune (book, size=1000) matches neither.
    const paths = parsed.rows.map((r: { file: { path: string } }) => r.file.path).sort();
    expect(paths).toEqual(["books/Foundation.md", "notes/Notes.md"]);
    expect(parsed.total).toBe(2);
  });
});

describe("handleBase — error paths", () => {
  it("rejects arithmetic in a filter expression with 400 unsupported_construct", async () => {
    const yaml = `
views:
  buggy:
    filters:
      and:
        - "rating + 1 > 3"
`;
    const oneFile = [
      {
        basename: "X",
        path: "X.md",
        parentPath: "",
        extension: "md",
        stat: { size: 1, mtime: 1, ctime: 1 },
        frontmatter: { rating: 5 },
      },
    ];
    const res = mockRes();
    await handleBase(
      res as unknown as import("http").ServerResponse,
      fakeApp({ basesEnabled: true, files: oneFile }),
      { view: "buggy", yaml },
    );
    expect(res.statusCode).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.error).toBe("unsupported_construct");
    expect(parsed.message).toMatch(/arithmetic '\+'/);
    expect(parsed.message).toMatch(/'rating \+ 1 > 3'/);
    expect(parsed.message).toMatch(/v1\.4\.1/);
  });

  it("rejects a top-level formulas: block with 400 unsupported_construct", async () => {
    const yaml = `
formulas:
  doubled: "rating * 2"
views:
  default:
    filters: []
`;
    const res = mockRes();
    await handleBase(
      res as unknown as import("http").ServerResponse,
      fakeApp({ basesEnabled: true, files: [] }),
      { view: "default", yaml },
    );
    expect(res.statusCode).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.error).toBe("unsupported_construct");
    expect(parsed.message).toMatch(/'formulas:' block/);
    expect(parsed.message).toMatch(/v1\.4\.2/);
  });
});
