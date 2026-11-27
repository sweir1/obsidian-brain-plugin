import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Plugin, type App, type TFile } from "obsidian";
import {
  resolveBases,
  isBasesEnabled,
  BASE_UNAVAILABLE_MESSAGES,
  handleBase,
  type BaseRequestBody,
} from "./base";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface MockRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  setHeader: (k: string, v: string) => void;
  end: (chunk?: string) => void;
}

function mockRes(): MockRes {
  return {
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
}

interface FixtureFile {
  path: string;
  frontmatter?: Record<string, unknown>;
  /** Inline tags as the metadata cache reports them (`#tag`). */
  tags?: string[];
  links?: string[];
  frontmatterLinks?: string[];
  embeds?: string[];
  size?: number;
  mtime?: number;
  ctime?: number;
}

/**
 * Where Obsidian keeps Bases' on/off state. Real Obsidian: the core-plugin
 * registry (`app.internalPlugins`). The old test fake put it in the
 * community registry, which is why the not-enabled bug was never caught.
 */
type BasesState =
  | "core-enabled" // internalPlugins.getEnabledPluginById('bases') → instance; plugins.bases.enabled = true
  | "core-disabled" // getEnabledPluginById → null; plugins.bases.enabled = false; getPluginById still returns a wrapper
  | "core-flag-only" // only internalPlugins.plugins.bases.enabled = true (no getEnabledPluginById)
  | "community-only" // legacy fallback: app.plugins.enabledPlugins has "bases"
  | "absent"; // no registry knows about bases

function tfile(f: FixtureFile): TFile {
  const slash = f.path.lastIndexOf("/");
  const name = f.path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const folder = slash === -1 ? "/" : f.path.slice(0, slash);
  return {
    path: f.path,
    name,
    basename: dot === -1 ? name : name.slice(0, dot),
    extension: dot === -1 ? "" : name.slice(dot + 1),
    parent: { path: folder },
    stat: { size: f.size ?? 100, mtime: f.mtime ?? 1_000, ctime: f.ctime ?? 500 },
  } as unknown as TFile;
}

function fakeApp(opts: {
  bases?: BasesState;
  files?: FixtureFile[];
  /** `.base` files (and any other readable files) by vault path. */
  fileContents?: Record<string, string>;
  /** Property types from Settings → Properties (`app.metadataTypeManager`). */
  propertyTypes?: Record<string, string>;
}): App {
  const state = opts.bases ?? "core-enabled";
  const files = opts.files ?? [];
  const tfiles = files.map(tfile);
  const contentFiles = Object.keys(opts.fileContents ?? {}).map((path) => tfile({ path }));
  const byPath = new Map(files.map((f) => [f.path, f]));

  const resolve = (linkpath: string): TFile | null => {
    const want = linkpath.replace(/\.md$/i, "").toLowerCase();
    return (
      tfiles.find((t) => t.path.replace(/\.md$/i, "").toLowerCase() === want) ??
      tfiles.find((t) => t.basename.toLowerCase() === want) ??
      null
    );
  };
  const resolvedLinks: Record<string, Record<string, number>> = {};
  for (const f of files) {
    const out: Record<string, number> = {};
    for (const l of [...(f.links ?? []), ...(f.frontmatterLinks ?? [])]) {
      const t = resolve(l);
      if (t) out[t.path] = (out[t.path] ?? 0) + 1;
    }
    resolvedLinks[f.path] = out;
  }

  const basesInstance = { id: "bases" };
  const internalPlugins: Record<string, unknown> = {};
  if (state === "core-enabled") {
    internalPlugins.plugins = { bases: { enabled: true, instance: basesInstance } };
    internalPlugins.getEnabledPluginById = (id: string) => (id === "bases" ? basesInstance : null);
    internalPlugins.getPluginById = (id: string) => (id === "bases" ? { enabled: true } : null);
  } else if (state === "core-disabled") {
    internalPlugins.plugins = { bases: { enabled: false, instance: basesInstance } };
    internalPlugins.getEnabledPluginById = () => null;
    // The trap: the wrapper exists even when the plugin is off.
    internalPlugins.getPluginById = (id: string) => (id === "bases" ? { enabled: false } : null);
  } else if (state === "core-flag-only") {
    internalPlugins.plugins = { bases: { enabled: true } };
  } else {
    internalPlugins.plugins = {};
    internalPlugins.getEnabledPluginById = () => null;
  }

  return {
    internalPlugins,
    plugins: {
      plugins: {},
      enabledPlugins: new Set<string>(state === "community-only" ? ["bases"] : ["dataview"]),
    },
    ...(opts.propertyTypes
      ? {
          metadataTypeManager: {
            getAssignedType: (name: string) => opts.propertyTypes![name.toLowerCase()] ?? null,
            types: Object.fromEntries(Object.entries(opts.propertyTypes).map(([k, type]) => [k.toLowerCase(), { name: k, type }])),
          },
        }
      : {}),
    vault: {
      getFiles: () => tfiles,
      getMarkdownFiles: () => tfiles.filter((t) => t.extension === "md"),
      getAbstractFileByPath: (p: string) =>
        [...tfiles, ...contentFiles].find((t) => t.path === p) ??
        // A folder: has children, no extension.
        (files.some((f) => f.path.startsWith(`${p}/`)) ? { path: p, children: [] } : null),
      cachedRead: async (t: TFile) => {
        const c = opts.fileContents?.[t.path];
        if (c === undefined) throw new Error(`ENOENT: no such file '${t.path}'`);
        return c;
      },
      adapter: {
        read: async () => {
          throw new Error("the handler must read through the vault, not the adapter");
        },
      },
      getName: () => "test",
    },
    metadataCache: {
      resolvedLinks,
      getFirstLinkpathDest: (linkpath: string) => resolve(linkpath),
      getFileCache: (file: TFile) => {
        const f = byPath.get(file.path);
        if (!f || file.extension !== "md") return null;
        return {
          ...(f.frontmatter ? { frontmatter: { ...f.frontmatter } } : {}),
          tags: (f.tags ?? []).map((tag) => ({ tag })),
          links: (f.links ?? []).map((link) => ({ link })),
          frontmatterLinks: (f.frontmatterLinks ?? []).map((link) => ({ link })),
          embeds: (f.embeds ?? []).map((link) => ({ link })),
        };
      },
    },
  } as unknown as App;
}

let originalRegisterBasesView: unknown;
beforeEach(() => {
  originalRegisterBasesView = (Plugin.prototype as { registerBasesView?: unknown }).registerBasesView;
  (Plugin.prototype as { registerBasesView?: unknown }).registerBasesView = function registerBasesViewStub() {
    return true;
  };
});
afterEach(() => {
  (Plugin.prototype as { registerBasesView?: unknown }).registerBasesView = originalRegisterBasesView;
});

interface BaseResponse {
  view: string | null;
  rows: Array<Record<string, unknown> & { file: { name: string; basename: string; path: string } }>;
  total: number;
  groupBy?: string;
  groups?: Array<{ value: unknown; count: number }>;
  warnings?: string[];
  executedAt: string;
  error?: string;
  message?: string;
}

async function query(app: App, body: BaseRequestBody): Promise<{ status: number; json: BaseResponse }> {
  const res = mockRes();
  await handleBase(res as unknown as import("http").ServerResponse, app, body);
  return { status: res.statusCode, json: JSON.parse(res.body) as BaseResponse };
}

const paths = (r: BaseResponse) => r.rows.map((row) => row.file.path);

// ---------------------------------------------------------------------------
// A small vault used by most tests
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const T0 = new Date(2026, 10, 1).getTime();

const VAULT: FixtureFile[] = [
  { path: "books/Dune.md", frontmatter: { status: "reading", rating: 5, price: 12, age: 4, tags: ["book"] }, tags: ["#scifi"], links: ["Textbook"], mtime: T0 + 20 * DAY },
  { path: "books/Foundation.md", frontmatter: { status: "done", rating: 4, price: 8, age: 2 }, tags: ["#book"], mtime: T0 + 2 * DAY },
  { path: "books/Neuromancer.md", frontmatter: { status: "todo", rating: 3, price: 2, age: 1 }, tags: ["#book"], mtime: T0 + 5 * DAY },
  { path: "Required Reading/Primer.md", frontmatter: { status: "todo", price: 30, age: 3 }, tags: ["#book"], mtime: T0 },
  { path: "notes/Idea.md", frontmatter: {}, tags: ["#tag"], mtime: T0 + DAY },
  { path: "notes/Plain.md", mtime: T0 + 3 * DAY },
  { path: "Textbook.md", frontmatter: { kind: "reference" }, mtime: T0 + 4 * DAY },
  { path: "assets/cover.png", size: 5_000, mtime: T0 + 6 * DAY },
];

// ---------------------------------------------------------------------------
// Detecting Bases (issue #1, bug 1)
// ---------------------------------------------------------------------------

describe("isBasesEnabled / resolveBases", () => {
  it("is enabled when the core-plugin registry says so — even though the community registry doesn't list it (the reported bug)", () => {
    const app = fakeApp({ bases: "core-enabled" });
    expect((app as unknown as { plugins: { enabledPlugins: Set<string> } }).plugins.enabledPlugins.has("bases")).toBe(false);
    expect(isBasesEnabled(app)).toBe(true);
    const r = resolveBases(app);
    expect(r.ok).toBe(true);
  });

  it("is enabled via internalPlugins.plugins.bases.enabled when getEnabledPluginById is missing", () => {
    expect(isBasesEnabled(fakeApp({ bases: "core-flag-only" }))).toBe(true);
  });

  it("is disabled when the core plugin is switched off, even though getPluginById still returns a wrapper", () => {
    const app = fakeApp({ bases: "core-disabled" });
    expect(isBasesEnabled(app)).toBe(false);
    expect(resolveBases(app)).toEqual({ ok: false, kind: "not_enabled" });
  });

  it("keeps the community-registry check as a fallback", () => {
    expect(isBasesEnabled(fakeApp({ bases: "community-only" }))).toBe(true);
  });

  it("is disabled when no registry knows about Bases", () => {
    expect(resolveBases(fakeApp({ bases: "absent" }))).toEqual({ ok: false, kind: "not_enabled" });
  });

  it("is disabled on an app object with no plugin registries at all", () => {
    expect(isBasesEnabled({} as App)).toBe(false);
  });

  it("reports unsupported_obsidian_version when registerBasesView is absent", () => {
    (Plugin.prototype as { registerBasesView?: unknown }).registerBasesView = undefined;
    expect(resolveBases(fakeApp({ bases: "core-enabled" }))).toEqual({ ok: false, kind: "unsupported_obsidian_version" });
  });
});

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

describe("handleBase — request validation", () => {
  it("rejects a non-string view", async () => {
    const { status, json } = await query(fakeApp({}), { yaml: "views: []", view: 3 });
    expect(status).toBe(400);
    expect(json.error).toBe("bad_request");
  });

  it("rejects a request with neither file nor yaml", async () => {
    const { status, json } = await query(fakeApp({}), { view: "x" });
    expect(status).toBe(400);
    expect(json.message).toMatch(/either.*`file`.*`yaml`/);
  });

  it("returns 424 bases_not_enabled when the core plugin is off", async () => {
    const { status, json } = await query(fakeApp({ bases: "core-disabled" }), { yaml: "views: []" });
    expect(status).toBe(424);
    expect(json.error).toBe("bases_not_enabled");
    expect(json.message).toBe(BASE_UNAVAILABLE_MESSAGES.not_enabled.message);
  });

  it("returns 400 base_file_not_found for a missing .base file", async () => {
    const { status, json } = await query(fakeApp({}), { file: "Nope.base" });
    expect(status).toBe(400);
    expect(json.error).toBe("base_file_not_found");
  });

  it("returns 400 base_eval_error for invalid YAML", async () => {
    const yaml = "filters:\n  and:\n    - 'a == 1'\n  bad: [unclosed\nviews:\n  - type: table\n";
    const { status, json } = await query(fakeApp({ files: VAULT }), { yaml });
    expect(status).toBe(400);
    expect(json.error).toBe("base_eval_error");
  });

  it("returns 400 base_eval_error when the YAML isn't a mapping", async () => {
    const { status, json } = await query(fakeApp({ files: VAULT }), { yaml: "- a\n- b\n" });
    expect(status).toBe(400);
    expect(json.error).toBe("base_eval_error");
  });
});

// ---------------------------------------------------------------------------
// The reporter's base (issue #1, bug 2)
// ---------------------------------------------------------------------------

describe("the .base file from issue #1 (Obsidian 1.14.4)", () => {
  const TABELA = "views:\n  - type: table\n    name: Tabela\n";

  it("finds view 'Tabela' in the `views:` list and returns every file in the vault", async () => {
    const app = fakeApp({ files: VAULT, fileContents: { "Sem título.base": TABELA } });
    const { status, json } = await query(app, { file: "Sem título.base", view: "Tabela" });
    expect(status).toBe(200);
    expect(json.view).toBe("Tabela");
    expect(json.total).toBe(VAULT.length); // notes AND attachments, as in Obsidian
    expect(paths(json)).toContain("assets/cover.png");
  });

  it("runs the first view when no view is named", async () => {
    const app = fakeApp({ files: VAULT, fileContents: { "Sem título.base": TABELA } });
    const { status, json } = await query(app, { file: "Sem título.base" });
    expect(status).toBe(200);
    expect(json.view).toBe("Tabela");
  });

  it("matches a view name case-insensitively when unambiguous", async () => {
    const { json } = await query(fakeApp({ files: VAULT }), { yaml: TABELA, view: "tabela" });
    expect(json.view).toBe("Tabela");
  });

  it("lists the available views when the requested one doesn't exist", async () => {
    const { status, json } = await query(fakeApp({ files: VAULT }), { yaml: TABELA, view: "Board" });
    expect(status).toBe(400);
    expect(json.error).toBe("base_eval_error");
    expect(json.message).toMatch(/View 'Board' not found.*'Tabela'/);
  });

  it("applies the reporter's verification query: inFolder filter, limit 5, order [file.name, file.mtime]", async () => {
    const cloud: FixtureFile[] = Array.from({ length: 7 }, (_, i) => ({
      path: `cloud/n${i}.md`,
      frontmatter: {},
      mtime: T0 + i * DAY,
    }));
    const yaml = [
      "views:",
      "  - type: table",
      "    name: Tabela",
      "    filters:",
      "      and:",
      '        - file.inFolder("cloud")',
      "    limit: 5",
      "    order:",
      "      - file.name",
      "      - file.mtime",
    ].join("\n");
    const { status, json } = await query(fakeApp({ files: [...VAULT, ...cloud] }), { yaml });
    expect(status).toBe(200);
    expect(json.total).toBe(7);
    expect(json.rows).toHaveLength(5);
    expect(json.rows[0]).toEqual({
      file: { name: "n0.md", basename: "n0", path: "cloud/n0.md" },
      "file.name": "n0.md",
      "file.mtime": new Date(T0).toISOString(),
    });
  });
});

// ---------------------------------------------------------------------------
// The example from Obsidian's own "Bases syntax" page, verbatim
// ---------------------------------------------------------------------------

describe("the official Bases syntax example (help.obsidian.md/bases/syntax)", () => {
  const OFFICIAL = `filters:
  or:
    - file.hasTag("tag")
    - and:
        - file.hasTag("book")
        - file.hasLink("Textbook")
    - not:
        - file.hasTag("book")
        - file.inFolder("Required Reading")
formulas:
  formatted_price: 'if(price, price.toFixed(2) + " dollars")'
  ppu: "(price / age).toFixed(2)"
properties:
  status:
    displayName: Status
  formula.formatted_price:
    displayName: "Price"
  file.ext:
    displayName: Extension
summaries:
  customAverage: 'values.mean().round(3)'
views:
  - type: table
    name: "My table"
    limit: 10
    groupBy:
      property: note.age
      direction: DESC
    filters:
      and:
        - 'status != "done"'
        - or:
            - "formula.ppu > 5"
            - "price > 2.1"
    order:
      - file.name
      - file.ext
      - note.age
      - formula.ppu
      - formula.formatted_price
    summaries:
      formula.ppu: Average
`;

  it("evaluates it end to end (formulas, not-as-NOR, groupBy, order) — formulas/summaries/properties no longer rejected", async () => {
    const { status, json } = await query(fakeApp({ files: VAULT }), { yaml: OFFICIAL });
    expect(status).toBe(200);
    // Global filter keeps: Idea (#tag), Dune (#book + links Textbook),
    // and everything that is neither #book nor in Required Reading
    // (Idea, Plain, Textbook, cover.png). The view filter then needs
    // status != done AND (ppu > 5 OR price > 2.1): only Dune has a price.
    expect(json.view).toBe("My table");
    expect(json.total).toBe(1);
    expect(json.rows[0]).toEqual({
      file: { name: "Dune.md", basename: "Dune", path: "books/Dune.md" },
      "file.name": "Dune.md",
      "file.ext": "md",
      age: 4,
      "formula.ppu": "3.00",
      "formula.formatted_price": "12.00 dollars",
    });
    expect(json.groupBy).toBe("note.age");
    expect(json.groups).toEqual([{ value: 4, count: 1 }]);
    expect(json.warnings).toBeUndefined();
  });

  it("negative control: dropping the view filter brings back the other globally-matched files", async () => {
    const noViewFilter = OFFICIAL.replace(/    filters:\n      and:\n        - 'status != "done"'\n        - or:\n            - "formula.ppu > 5"\n            - "price > 2.1"\n/, "");
    expect(noViewFilter).not.toBe(OFFICIAL);
    const { json } = await query(fakeApp({ files: VAULT }), { yaml: noViewFilter });
    expect(paths(json).sort()).toEqual(["Textbook.md", "assets/cover.png", "books/Dune.md", "notes/Idea.md", "notes/Plain.md"]);
  });
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

describe("filters", () => {
  const run = (yaml: string) => query(fakeApp({ files: VAULT }), { yaml });

  it("`not:` with a list excludes a file if ANY condition holds", async () => {
    const { json } = await run(`filters:
  not:
    - file.hasTag("book")
    - file.ext == "png"
views:
  - type: table
    name: T
`);
    expect(paths(json).sort()).toEqual(["Textbook.md", "notes/Idea.md", "notes/Plain.md"]);
  });

  it("`not:` with a single condition negates it", async () => {
    const { json } = await run('filters:\n  not: file.ext == "md"\nviews:\n  - type: table\n    name: T\n');
    expect(paths(json)).toEqual(["assets/cover.png"]);
  });

  it("global and view filters are ANDed", async () => {
    const { json } = await run(`filters: file.inFolder("books")
views:
  - type: table
    name: T
    filters: 'rating >= 4'
`);
    expect(paths(json).sort()).toEqual(["books/Dune.md", "books/Foundation.md"]);
  });

  it("a single string filter works at the top level", async () => {
    const { json } = await run("filters: 'status == \"todo\"'\nviews:\n  - type: table\n    name: T\n");
    expect(paths(json).sort()).toEqual(["Required Reading/Primer.md", "books/Neuromancer.md"]);
  });

  it("ignores an unknown key next to and/or/not, with a warning", async () => {
    const { status, json } = await run("filters:\n  and:\n    - 'status != \"done\"'\n  weirdFilterKey: 1\nviews:\n  - type: table\n    name: X\n");
    expect(status).toBe(200);
    expect(paths(json)).not.toContain("books/Foundation.md");
    expect(json.warnings).toEqual(["Ignored unknown key 'weirdFilterKey' in a filter group in `filters`."]);
  });

  it("tags from frontmatter and from the body both count, with nested-tag matching", async () => {
    const files: FixtureFile[] = [
      { path: "a.md", frontmatter: { tags: ["project/alpha"] } },
      { path: "b.md", frontmatter: { tags: "project" } },
      { path: "c.md", tags: ["#projects"] },
    ];
    const { json } = await query(fakeApp({ files }), { yaml: 'filters: file.hasTag("project")\nviews:\n  - type: table\n    name: T\n' });
    expect(paths(json).sort()).toEqual(["a.md", "b.md"]);
  });

  it("file.hasLink resolves links through the metadata cache", async () => {
    const { json } = await run('filters: file.hasLink("Textbook")\nviews:\n  - type: table\n    name: T\n');
    expect(paths(json)).toEqual(["books/Dune.md"]);
  });

  it("file.backlinks lists linking files", async () => {
    const { json } = await run('filters: file.backlinks.contains("books/Dune.md")\nviews:\n  - type: table\n    name: T\n');
    expect(paths(json)).toEqual(["Textbook.md"]);
  });

  it("keeps the legacy `{property: {op: value}}` shorthand working", async () => {
    const { json } = await run(`views:
  - type: table
    name: T
    filters:
      and:
        - file.inFolder("books")
        - rating:
            ">=": 4
        - status: reading
`);
    expect(paths(json)).toEqual(["books/Dune.md"]);
  });

  it("rejects 'this' in a filter with unsupported_construct, whatever the vault holds", async () => {
    for (const files of [VAULT, []]) {
      const { status, json } = await query(fakeApp({ files }), { yaml: "filters: file.hasLink(this.file)\nviews:\n  - type: table\n    name: T\n" });
      expect(status).toBe(400);
      expect(json.error).toBe("unsupported_construct");
      expect(json.message).toMatch(/'this'/);
    }
  });

  it("reports a syntax error in a filter as base_eval_error", async () => {
    const { status, json } = await run("filters:\n  and:\n    - 'status !!! \"done\"'\nviews:\n  - type: table\n    name: BF\n");
    expect(status).toBe(400);
    expect(json.error).toBe("base_eval_error");
  });
});

// ---------------------------------------------------------------------------
// Sort, order, limit, formulas
// ---------------------------------------------------------------------------

describe("sort, order and formulas", () => {
  const PROJECTS: FixtureFile[] = [
    { path: "Projects/A.md", frontmatter: { status: "Planned", priority: 2, due: "2026-12-10" } },
    { path: "Projects/B.md", frontmatter: { status: "In progress", priority: 1, due: "2026-12-01" } },
    { path: "Projects/C.md", frontmatter: { status: "Done", priority: 3, due: "2026-11-01" } },
    { path: "Projects/D.md", frontmatter: { priority: 5 } },
    { path: "Projects/E.md", frontmatter: { status: "Planned", priority: 1, due: "2026-11-30" } },
    { path: "Elsewhere/F.md", frontmatter: { status: "Planned", priority: 1 } },
  ];

  it("a project-tracker base: unprefixed sort property, display keys ignored, missing values last", async () => {
    const yaml = `filters:
  and:
    - file.inFolder("Projects")
    - 'status != "Done"'
properties:
  note.priority:
    displayName: Priority
views:
  - type: table
    name: Active
    order:
      - file.name
      - status
      - due
    sort:
      - property: due
        direction: ASC
    columnSize:
      file.name: 300
`;
    const { status, json } = await query(fakeApp({ files: PROJECTS }), { yaml });
    expect(status).toBe(200);
    expect(paths(json)).toEqual(["Projects/E.md", "Projects/B.md", "Projects/A.md", "Projects/D.md"]);
    expect(json.rows[0]).toMatchObject({ "file.name": "E.md", status: "Planned", due: "2026-11-30" });
    expect(json.rows[3]).toMatchObject({ status: null, due: null });
  });

  it("sorts DESC with multiple keys and a stable tie-break", async () => {
    const yaml = `filters: file.inFolder("Projects")
views:
  - type: table
    name: T
    sort:
      - property: note.priority
        direction: DESC
      - property: file.name
        direction: ASC
`;
    const { json } = await query(fakeApp({ files: PROJECTS }), { yaml });
    expect(paths(json)).toEqual(["Projects/D.md", "Projects/C.md", "Projects/A.md", "Projects/B.md", "Projects/E.md"]);
  });

  it("sorts by a formula", async () => {
    const yaml = `formulas:
  urgency: "priority * -1"
filters: file.inFolder("Projects")
views:
  - type: table
    name: T
    sort:
      - property: formula.urgency
        direction: ASC
    order: [file.basename, formula.urgency]
`;
    const { json } = await query(fakeApp({ files: PROJECTS }), { yaml });
    expect(json.rows[0]).toMatchObject({ "file.basename": "D", "formula.urgency": -5 });
  });

  it("limit applies after sorting; total is the count before the limit", async () => {
    const yaml = "filters: file.inFolder(\"Projects\")\nviews:\n  - type: table\n    name: T\n    limit: 2\n    sort:\n      - property: priority\n        direction: ASC\n";
    const { json } = await query(fakeApp({ files: PROJECTS }), { yaml });
    expect(json.total).toBe(5);
    expect(json.rows).toHaveLength(2);
  });

  it("projects nested and spaced property ids, and keeps a property named `file` from clobbering the row's file", async () => {
    const files: FixtureFile[] = [{ path: "x.md", frontmatter: { "due date": "2026-12-01", author: { name: "Ada" }, file: "attachment.pdf" } }];
    const yaml = "views:\n  - type: table\n    name: T\n    order:\n      - note.due date\n      - author.name\n      - note.file\n";
    const { json } = await query(fakeApp({ files }), { yaml });
    expect(json.rows[0]).toEqual({
      file: { name: "x.md", basename: "x", path: "x.md" },
      "due date": "2026-12-01",
      "author.name": "Ada",
      "note.file": "attachment.pdf",
    });
  });

  it("a column whose formula can't be evaluated is null with a warning, instead of failing the query", async () => {
    const yaml = `formulas:
  fancy: 'tags.map(value.lower())'
views:
  - type: table
    name: T
    filters: file.inFolder("Projects")
    order: [file.name, formula.fancy]
`;
    const { status, json } = await query(fakeApp({ files: PROJECTS }), { yaml });
    expect(status).toBe(200);
    expect(json.rows[0]!["formula.fancy"]).toBe(null);
    expect(json.warnings).toHaveLength(1);
    expect(json.warnings![0]).toMatch(/formula\.fancy.*lambdas/);
  });

  it("but a FILTER that needs an unsupported formula fails with unsupported_construct", async () => {
    const yaml = "formulas:\n  fancy: 'tags.map(value)'\nfilters: 'formula.fancy.isEmpty()'\nviews:\n  - type: table\n    name: T\n";
    const { status, json } = await query(fakeApp({ files: PROJECTS }), { yaml });
    expect(status).toBe(400);
    expect(json.error).toBe("unsupported_construct");
  });

  it("an unused unsupported formula doesn't matter", async () => {
    const yaml = "formulas:\n  fancy: 'tags.map(value)'\nviews:\n  - type: table\n    name: T\n";
    const { status } = await query(fakeApp({ files: PROJECTS }), { yaml });
    expect(status).toBe(200);
  });

  it("circular formulas are a clear error", async () => {
    const yaml = "formulas:\n  a: formula.b + 1\n  b: formula.a + 1\nfilters: 'formula.a > 0'\nviews:\n  - type: table\n    name: T\n";
    const { status, json } = await query(fakeApp({ files: PROJECTS }), { yaml });
    expect(status).toBe(400);
    expect(json.message).toMatch(/circular/);
  });

  it("an undefined formula is a clear error", async () => {
    const { status, json } = await query(fakeApp({ files: PROJECTS }), { yaml: "filters: 'formula.nope > 0'\nviews:\n  - type: table\n    name: T\n" });
    expect(status).toBe(400);
    expect(json.message).toMatch(/Formula 'nope' is not defined/);
  });
});

// ---------------------------------------------------------------------------
// Grouping (kanban and friends)
// ---------------------------------------------------------------------------

describe("groupBy and groupOrder", () => {
  const BOARD: FixtureFile[] = [
    { path: "Projects/A.md", frontmatter: { status: "Planned", priority: 2 } },
    { path: "Projects/B.md", frontmatter: { status: "In progress", priority: 1 } },
    { path: "Projects/C.md", frontmatter: { status: "Done", priority: 3 } },
    { path: "Projects/D.md", frontmatter: { priority: 5 } },
    { path: "Projects/E.md", frontmatter: { status: "Planned", priority: 1 } },
    { path: "Projects/F.md", frontmatter: { status: "", priority: 4 } },
  ];

  it("a kanban view with groupOrder shows only the listed groups, in that order, with null = no value", async () => {
    const yaml = `filters:
  and:
    - file.inFolder("Projects")
views:
  - type: kanban
    name: Board
    groupBy:
      property: note.status
      direction: ASC
    groupOrder:
      - Planned
      - In progress
      - null
    sort:
      - property: priority
        direction: ASC
    order:
      - file.basename
      - priority
`;
    const { status, json } = await query(fakeApp({ files: BOARD }), { yaml });
    expect(status).toBe(200);
    expect(json.groupBy).toBe("note.status");
    expect(json.groups).toEqual([
      { value: "Planned", count: 2 },
      { value: "In progress", count: 1 },
      { value: null, count: 2 }, // D (missing) and F (empty string)
    ]);
    expect(paths(json)).toEqual(["Projects/E.md", "Projects/A.md", "Projects/B.md", "Projects/F.md", "Projects/D.md"]);
    expect(json.total).toBe(5); // Done is hidden
  });

  it("an empty groupOrder hides every group", async () => {
    const yaml = "views:\n  - type: kanban\n    name: Board\n    groupBy:\n      property: status\n      direction: ASC\n    groupOrder: []\n";
    const { json } = await query(fakeApp({ files: BOARD }), { yaml });
    expect(json.total).toBe(0);
    expect(json.groups).toEqual([]);
  });

  it("without groupOrder, groups follow the groupBy direction and the no-value group comes last", async () => {
    const yaml = "views:\n  - type: table\n    name: T\n    groupBy:\n      property: note.status\n      direction: DESC\n";
    const { json } = await query(fakeApp({ files: BOARD }), { yaml });
    expect(json.groups!.map((g) => g.value)).toEqual(["Planned", "In progress", "Done", null]);
  });

  it("accepts the flow-style groupBy Obsidian sometimes writes", async () => {
    const yaml = "views:\n  - type: table\n    name: My table\n    order: [file.name, status]\n    groupBy: {property: status, direction: ASC}\n    limit: 10\n    unknownViewKey: kept\n";
    const { status, json } = await query(fakeApp({ files: BOARD }), { yaml });
    expect(status).toBe(200);
    expect(json.groups!.map((g) => g.value)).toEqual(["Done", "In progress", "Planned", null]);
  });
});

// ---------------------------------------------------------------------------
// Odd but valid files, and the legacy format
// ---------------------------------------------------------------------------

describe("unusual .base files", () => {
  it("an empty file is every file in the vault", async () => {
    const { status, json } = await query(fakeApp({ files: VAULT }), { yaml: "\n" });
    expect(status).toBe(200);
    expect(json.view).toBe(null);
    expect(json.total).toBe(VAULT.length);
  });

  it("`{}` is every file too", async () => {
    const { json } = await query(fakeApp({ files: VAULT }), { yaml: "{}\n" });
    expect(json.total).toBe(VAULT.length);
  });

  it("handles a BOM and CRLF line endings", async () => {
    const yaml = "﻿filters:\r\n  and:\r\n    - 'status == \"done\"'\r\nviews:\r\n  - type: table\r\n    name: X\r\n";
    const { status, json } = await query(fakeApp({ files: VAULT }), { yaml });
    expect(status).toBe(200);
    expect(paths(json)).toEqual(["books/Foundation.md"]);
  });

  it("names unnamed views 'View N' so they can still be selected", async () => {
    const yaml = "views:\n  - type: list\n  - type: table\n    name: ''\n";
    const first = await query(fakeApp({ files: VAULT }), { yaml });
    expect(first.json.view).toBe("View 1");
    const second = await query(fakeApp({ files: VAULT }), { yaml, view: "View 2" });
    expect(second.status).toBe(200);
  });

  it("evaluates rows the same for any view type, including plugin-defined ones", async () => {
    for (const type of ["table", "cards", "list", "map", "kanban", "some-plugin-view"]) {
      const { status, json } = await query(fakeApp({ files: VAULT }), { yaml: `views:\n  - type: ${type}\n    name: V\n    filters: file.inFolder("books")\n` });
      expect(status).toBe(200);
      expect(json.total).toBe(3);
    }
  });
});

describe("legacy format (map of views, columns, sort {column})", () => {
  const LEGACY = `
views:
  active-books:
    filters:
      and:
        - "file.hasTag(\\"book\\")"
        - status:
            "==": reading
    columns:
      - status
      - frontmatter.rating
      - column: file.size
        as: bytes
    sort:
      - column: rating
        direction: desc
`;

  it("still evaluates", async () => {
    const { status, json } = await query(fakeApp({ files: VAULT }), { yaml: LEGACY, view: "active-books" });
    expect(status).toBe(200);
    expect(json.rows).toEqual([
      { file: { name: "Dune.md", basename: "Dune", path: "books/Dune.md" }, status: "reading", rating: 5, bytes: 100 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Hardening (independent review). Each test fails without its fix.
// ---------------------------------------------------------------------------

const ONE: FixtureFile[] = [{ path: "n.md", frontmatter: { a: 1 } }];
const yamlWith = (filter: string) => `filters: '${filter}'\nviews:\n  - type: table\n    name: T\n`;

describe("resource limits (review items 1–3)", () => {
  it("rejects a string result over 1M characters instead of exhausting memory", async () => {
    for (const expr of [
      '"x".repeat(100000000).length > 0',
      '"x".repeat(900000).replace("x", "yy").length > 0',
      '"x".repeat(600000) + "x".repeat(600000) != ""',
    ]) {
      const { status, json } = await query(fakeApp({ files: ONE }), { yaml: yamlWith(expr) });
      expect(status, expr).toBe(400);
      expect(json.error).toBe("base_eval_error");
      expect(json.message).toMatch(/longer than 1,000,000 characters/);
    }
  });

  it("rejects a list result over 100k items", async () => {
    const { status, json } = await query(fakeApp({ files: ONE }), { yaml: yamlWith('"x,".repeat(400000).split(",").length > 0') });
    expect(status).toBe(400);
    expect(json.message).toMatch(/longer than 100,000 items/);
  });

  it("stops an evaluation that runs past the time budget", async () => {
    const many: FixtureFile[] = Array.from({ length: 3000 }, (_, i) => ({ path: `n${i}.md`, frontmatter: { v: i } }));
    const { evaluateBase } = await import("./base-evaluator");
    expect(() =>
      evaluateBase(fakeApp({ files: many }), { yaml: yamlWith('v.toString().contains("1")'), timeLimitMs: -1 }),
    ).toThrow(/took longer than/);
  });

  it("rejects 5,000 nested parentheses and a 20,000-term chain with 400, not a crash", async () => {
    for (const expr of [`${"(".repeat(5000)}1${")".repeat(5000)}`, `${Array(20000).fill("1").join("+")} > 0`]) {
      const { status, json } = await query(fakeApp({ files: ONE }), { yaml: yamlWith(expr) });
      expect(status).toBe(400);
      expect(json.message).toMatch(/nested too deeply|longer than/);
    }
  });

  it("rejects a 5,000-formula chain with 400, not a crash", async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `  f${i}: 'formula.f${i + 1} + 1'`);
    lines.push("  f5000: '1'");
    const yaml = `formulas:\n${lines.join("\n")}\nfilters: 'formula.f0 > 0'\nviews:\n  - type: table\n    name: T\n`;
    const { status, json } = await query(fakeApp({ files: ONE }), { yaml });
    expect(status).toBe(400);
    expect(json.message).toMatch(/more than 64 levels deep/);
  });

  it("a recursive YAML anchor in filters is a 400, not a stack overflow", async () => {
    const { status, json } = await query(fakeApp({ files: ONE }), { yaml: "filters: &f\n  and:\n    - *f\n" });
    expect(status).toBe(400);
    expect(json.message).toMatch(/recursive YAML anchor/);
  });

  it("an exponential YAML alias fan is a 400", async () => {
    let y = "x0: &a0 ['true', 'true']\n";
    for (let i = 1; i < 18; i++) y += `x${i}: &a${i} [*a${i - 1}, *a${i - 1}]\n`;
    y += "filters:\n  and: [*a17]\n";
    const { status } = await query(fakeApp({ files: ONE }), { yaml: y });
    expect(status).toBe(400);
  });

  it("caps the number of filter conditions", async () => {
    const yaml = `filters:\n  and:\n${Array.from({ length: 10001 }, () => "    - 'true'").join("\n")}\n`;
    const { status, json } = await query(fakeApp({ files: ONE }), { yaml });
    expect(status).toBe(400);
    expect(json.message).toMatch(/more than 10,000 conditions/);
  });
});

describe("dates (review items 4, 12, 16)", () => {
  const DATED: FixtureFile[] = [
    { path: "a.md", frontmatter: { due: "2024-03-01", at: "2024-03-01T10:30:00" } },
    { path: "b.md", frontmatter: { due: "2025-06-01", at: "2025-06-01T08:00:00" } },
  ];

  it("untyped date-like strings still work as dates (fields, methods, isType, comparisons)", async () => {
    const app = fakeApp({ files: DATED });
    for (const expr of ['due.year == 2024', 'due.format("YYYY") == "2024"', 'due.isType("date")', 'due.date() < date("2025-01-01")', 'due.relative() != null', 'due < "2025-01-01"']) {
      const { status, json } = await query(app, { yaml: yamlWith(expr) });
      expect(status, expr).toBe(200);
      expect(paths(json), expr).toEqual(expr.includes("relative") || expr.includes("isType") ? ["a.md", "b.md"] : ["a.md"]);
    }
  });

  it("uses Obsidian's property types: date/datetime-typed properties become dates", async () => {
    const yaml = "views:\n  - type: table\n    name: T\n    order: [due, at]\n";
    const typed = await query(fakeApp({ files: DATED, propertyTypes: { due: "date", at: "datetime" } }), { yaml });
    expect(typed.json.rows[0]).toMatchObject({ due: "2024-03-01", at: new Date(2024, 2, 1, 10, 30).toISOString() });
    const isString = await query(fakeApp({ files: DATED, propertyTypes: { due: "date" } }), { yaml: yamlWith('due.isType("string")') });
    expect(isString.json.total).toBe(0);
    // Negative control: without types the raw strings come back.
    const untyped = await query(fakeApp({ files: DATED }), { yaml });
    expect(untyped.json.rows[0]).toMatchObject({ due: "2024-03-01", at: "2024-03-01T10:30:00" });
    const stillString = await query(fakeApp({ files: DATED }), { yaml: yamlWith('due.isType("string")') });
    expect(stillString.json.total).toBe(2);
  });

  it("outputs date-only values as local YYYY-MM-DD, not a UTC timestamp a day early", async () => {
    const saved = process.env.TZ;
    process.env.TZ = "Europe/Berlin";
    try {
      const { evaluateBase } = await import("./base-evaluator");
      const r = evaluateBase(fakeApp({ files: ONE }), {
        yaml: "formulas:\n  t: 'today()'\n  d: 'date(\"2025-01-15\")'\nviews:\n  - type: table\n    name: T\n    order: [formula.t, formula.d]\n",
        now: new Date(2025, 0, 15, 12),
      });
      expect(r.rows[0]).toMatchObject({ "formula.t": "2025-01-15", "formula.d": "2025-01-15" });
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  it("an impossible date is not a date", async () => {
    const { json } = await query(fakeApp({ files: ONE }), { yaml: yamlWith('date("2024-02-30") == date("2024-03-01")') });
    expect(json.total).toBe(0);
    const ok = await query(fakeApp({ files: ONE }), { yaml: yamlWith('date("2024-02-29") < date("2024-03-01")') });
    expect(ok.json.total).toBe(1);
  });
});

describe("properties and tags (review items 5, 6, 13, 17)", () => {
  it("keeps a real frontmatter property called `position`", async () => {
    const files: FixtureFile[] = [{ path: "a.md", frontmatter: { position: 3 } }, { path: "b.md", frontmatter: { position: 1 } }];
    const { json } = await query(fakeApp({ files }), { yaml: "filters: 'position > 2'\nviews:\n  - type: table\n    name: T\n    order: [position]\n" });
    expect(json.rows).toEqual([{ file: { name: "a.md", basename: "a", path: "a.md" }, position: 3 }]);
  });

  it("reads frontmatter tags under any case of `tags` / `tag`, including both at once", async () => {
    const files: FixtureFile[] = [
      { path: "a.md", frontmatter: { Tags: ["book"] } },
      { path: "b.md", frontmatter: { TAG: "book, other" } },
      { path: "c.md", frontmatter: { tag: "x", tags: ["book"] } },
      { path: "d.md", frontmatter: { tagged: ["book"] } },
    ];
    const { json } = await query(fakeApp({ files }), { yaml: yamlWith('file.hasTag("book")') });
    expect(paths(json)).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("gives root files the folder '/' (Obsidian's root folder path); inFolder('/') is the whole vault", async () => {
    const { json } = await query(fakeApp({ files: VAULT }), { yaml: yamlWith('file.folder == "/"') });
    expect(paths(json)).toEqual(["Textbook.md"]);
    const all = await query(fakeApp({ files: VAULT }), { yaml: yamlWith('file.inFolder("/")') });
    expect(all.json.total).toBe(VAULT.length);
  });

  it("groups by type and value: 5 and \"5\" are different groups", async () => {
    const files: FixtureFile[] = [{ path: "a.md", frontmatter: { s: 5 } }, { path: "b.md", frontmatter: { s: "5" } }];
    const { json } = await query(fakeApp({ files }), { yaml: "views:\n  - type: table\n    name: T\n    groupBy: {property: s}\n" });
    expect(json.groups).toEqual([{ value: 5, count: 1 }, { value: "5", count: 1 }]);
    const ordered = await query(fakeApp({ files }), { yaml: "views:\n  - type: table\n    name: T\n    groupBy: {property: s}\n    groupOrder: [\"5\"]\n" });
    expect(paths(ordered.json)).toEqual(["b.md"]);
  });
});

describe("filter shapes (review items 7, 8)", () => {
  const run = (yaml: string) => query(fakeApp({ files: VAULT }), { yaml });

  it("an empty group imposes no condition — including `not:` with nothing under it", async () => {
    for (const filters of ["filters:\n  not:\n", "filters:\n  not: []\n", "filters:\n  not:\n    - and: []\n", "filters:\n  and: []\n", "filters:\n  or: []\n", "filters:\n  or:\n    - not: []\n"]) {
      const { status, json } = await run(`${filters}views:\n  - type: table\n    name: T\n`);
      expect(status, filters).toBe(200);
      expect(json.total, filters).toBe(VAULT.length);
    }
  });

  it("rejects a mistyped group key instead of silently returning nothing", async () => {
    for (const [filters, key] of [["filters:\n  And:\n    - 'true'\n", "And"], ["filters:\n  nor:\n    - 'true'\n", "nor"]] as const) {
      const { status, json } = await run(`${filters}views:\n  - type: table\n    name: T\n`);
      expect(status).toBe(400);
      expect(json.message).toMatch(new RegExp(`Unknown filter key '${key}'.*and, or, or not`));
    }
  });

  it("rejects two group keys in one group", async () => {
    const { status, json } = await run("filters:\n  and:\n    - 'true'\n  or:\n    - 'true'\nviews:\n  - type: table\n    name: T\n");
    expect(status).toBe(400);
    expect(json.message).toMatch(/only one of and \/ or \/ not \(found and, or\)/);
  });
});

describe("formulas and per-row values (review items 9, 10)", () => {
  const BROKEN = "formulas:\n  bad: 'link(file.name)'\n";

  it("a formula with an unsupported construct is a 400 when sorting by it — even in an empty vault", async () => {
    for (const files of [VAULT, []]) {
      const { status, json } = await query(fakeApp({ files }), { yaml: `${BROKEN}views:\n  - type: table\n    name: T\n    sort: [{property: formula.bad, direction: ASC}]\n` });
      expect(status).toBe(400);
      expect(json.error).toBe("unsupported_construct");
      expect(json.message).toMatch(/formula 'bad'.*link\(\)/);
    }
  });

  it("…and a warning with null cells when it's only a column — even in an empty vault", async () => {
    for (const files of [VAULT, []]) {
      const { status, json } = await query(fakeApp({ files }), { yaml: `${BROKEN}views:\n  - type: table\n    name: T\n    order: [formula.bad]\n` });
      expect(status).toBe(200);
      expect(json.warnings).toEqual([expect.stringMatching(/formula\.bad: .*link\(\).*column left empty/)]);
      for (const row of json.rows) expect(row["formula.bad"]).toBe(null);
    }
  });

  it("a formula that uses a broken or missing formula is broken too", async () => {
    const yaml = "formulas:\n  bad: 'link(file.name)'\n  uses: 'formula.bad + 1'\n  missing: 'formula.nope'\nfilters: 'formula.uses > 0'\nviews:\n  - type: table\n    name: T\n";
    const r1 = await query(fakeApp({ files: VAULT }), { yaml });
    expect(r1.status).toBe(400);
    const r2 = await query(fakeApp({ files: VAULT }), { yaml: yaml.replace("formula.uses > 0", "formula.missing > 0") });
    expect(r2.status).toBe(400);
    expect(r2.json.message).toMatch(/'nope', which is not defined/);
  });

  it("a value of the wrong type in one row makes that row null with a warning, not the whole query fail", async () => {
    const files: FixtureFile[] = [{ path: "a.md", frontmatter: { status: "Done" } }, { path: "b.md", frontmatter: { status: 5 } }];
    const { status, json } = await query(fakeApp({ files }), { yaml: yamlWith('status.lower() == "done"') });
    expect(status).toBe(200);
    expect(paths(json)).toEqual(["a.md"]);
    expect(json.warnings).toEqual(["'.lower()' doesn't apply to a number value; those rows got null."]);
  });
});

describe("reading the .base file (review item 11)", () => {
  const SECRET = "filters:\n  and:\n    - 'a == 1'\n  bad: [TOP-SECRET-CONTENT\n";
  const app = () => fakeApp({ files: VAULT, fileContents: { "Bases/Real.base": "views:\n  - type: table\n    name: T\n", "Bases/Broken.base": SECRET, "notes/x.md": "# x" } });

  it("rejects paths outside the vault", async () => {
    for (const file of ["../../.ssh/config", "../outside.base", "Bases/../../x.base", "/etc/passwd", "C:/Users/me/x.base", "..\\x.base"]) {
      const { status, json } = await query(app(), { file });
      expect(status, file).toBe(400);
      expect(json.error, file).toBe("bad_request");
    }
  });

  it("only reads .base files", async () => {
    const { status, json } = await query(app(), { file: "notes/x.md" });
    expect(status).toBe(400);
    expect(json.message).toMatch(/must be a `\.base` file/);
  });

  it("reads through the vault (normalising the path) and reports a missing file or a folder as not found", async () => {
    expect((await query(app(), { file: "Bases//Real.base" })).status).toBe(200);
    expect((await query(app(), { file: "Bases/Missing.base" })).json.error).toBe("base_file_not_found");
    const folderApp = fakeApp({ files: [{ path: "Dir.base/inside.md" }] });
    expect((await query(folderApp, { file: "Dir.base" })).json.error).toBe("base_file_not_found");
  });

  it("doesn't echo the file's content in a YAML error", async () => {
    const { status, json } = await query(app(), { file: "Bases/Broken.base" });
    expect(status).toBe(400);
    expect(json.message).toMatch(/^Invalid \.base YAML: /);
    expect(json.message).not.toContain("TOP-SECRET-CONTENT");
  });
});

describe("decisions on ambiguous syntax (review items 14, 15, 18)", () => {
  it("`due-date` is due minus date, as in Bases — with a warning pointing at note[\"due-date\"]", async () => {
    const files: FixtureFile[] = [{ path: "c.md", frontmatter: { "due-date": "2020-01-01" } }];
    const minus = await query(fakeApp({ files }), { yaml: yamlWith("due-date < today()") });
    expect(minus.json.total).toBe(0);
    expect(minus.json.warnings).toEqual([expect.stringContaining('note["due-date"]')]);
    const bracket = await query(fakeApp({ files }), { yaml: yamlWith('note["due-date"] < today()') });
    expect(bracket.json.total).toBe(1);
  });

  it("compares a duration with a number as milliseconds", async () => {
    const { evaluateBase } = await import("./base-evaluator");
    const r = evaluateBase(fakeApp({ files: ONE }), { yaml: yamlWith('(today() - date("2025-01-01")) > 86400000'), now: new Date(2025, 0, 15, 12) });
    expect(r.total).toBe(1);
  });

  it("adding a bare number to a date is null with a warning, not a timestamp", async () => {
    const { json } = await query(fakeApp({ files: ONE }), { yaml: "views:\n  - type: table\n    name: T\n    order: [formula.x]\nformulas:\n  x: 'today() + 7'\n" });
    expect(json.rows[0]!["formula.x"]).toBe(null);
    expect(json.warnings).toEqual([expect.stringContaining('"7d"')]);
  });

  it("a bare `values` is an ordinary note property outside summaries", async () => {
    const files: FixtureFile[] = [{ path: "a.md", frontmatter: { values: ["x"] } }, { path: "b.md" }];
    const { status, json } = await query(fakeApp({ files }), { yaml: yamlWith('values.contains("x")') });
    expect(status).toBe(200);
    expect(paths(json)).toEqual(["a.md"]);
  });
});

// ---------------------------------------------------------------------------
// Follow-ups from the second review round
// ---------------------------------------------------------------------------

describe("empty groups hold in place (follow-up 1)", () => {
  const run = (filters: string) => query(fakeApp({ files: VAULT }), { yaml: `${filters}views:\n  - type: table\n    name: T\n` });

  it("an empty group inside `or` makes the `or` hold for every file", async () => {
    const { json } = await run("filters:\n  or:\n    - and: []\n    - 'false'\n");
    expect(json.total).toBe(VAULT.length);
  });

  it("an empty group inside `and` changes nothing", async () => {
    expect((await run("filters:\n  and:\n    - or: []\n    - 'false'\n")).json.total).toBe(0);
    expect((await run("filters:\n  and:\n    - or: []\n    - 'file.ext == \"png\"'\n")).json.total).toBe(1);
  });

  it("`not` of an empty group, and an empty `not`, exclude nothing; top-level empty groups are no filter", async () => {
    for (const f of ["filters:\n  not:\n    - and: []\n", "filters:\n  not: []\n", "filters:\n  and: []\n", "filters:\n  or: []\n", "filters:\n  not:\n"]) {
      expect((await run(f)).json.total, f).toBe(VAULT.length);
    }
  });
});

describe("misspelt group keys with a string value (follow-up 2)", () => {
  const run = (filters: string) => query(fakeApp({ files: VAULT }), { yaml: `${filters}views:\n  - type: table\n    name: T\n` });

  it("rejects `nor: '<expression>'` instead of treating it as a property", async () => {
    for (const f of ["filters:\n  nor: 'status == 5'\n", "filters:\n  AND: 'file.hasTag(\"book\")'\n", "filters:\n  Not: 'rating > 3 && price < 5'\n", "filters:\n  any: 'note.status'\n"]) {
      const { status, json } = await run(f);
      expect(status, f).toBe(400);
      expect(json.message, f).toMatch(/Unknown filter key '.*'.*and, or, or not/);
    }
  });

  it("still accepts plain legacy values, including ones with spaces", async () => {
    const files: FixtureFile[] = [
      { path: "a.md", frontmatter: { status: "in progress", rating: 5 } },
      { path: "b.md", frontmatter: { status: "reading", rating: 4 } },
    ];
    const q = (filters: string) => query(fakeApp({ files }), { yaml: `${filters}views:\n  - type: table\n    name: T\n` });
    expect(paths((await q('filters:\n  status: "in progress"\n')).json)).toEqual(["a.md"]);
    expect(paths((await q("filters:\n  status: reading\n")).json)).toEqual(["b.md"]);
    expect(paths((await q("filters:\n  rating: 5\n")).json)).toEqual(["a.md"]);
  });
});

describe("vault-relative paths with a leading / or ./ (follow-up 3)", () => {
  const app = () => fakeApp({ files: VAULT, fileContents: { "Bases/My Böoks.base": "views:\n  - type: table\n    name: T\n" } });

  it("treats a leading / or ./ as the vault root", async () => {
    for (const file of ["/Bases/My Böoks.base", "./Bases/My Böoks.base", "Bases/My Böoks.base", "\\Bases\\My Böoks.base"]) {
      const { status } = await query(app(), { file });
      expect(status, file).toBe(200);
    }
  });

  it("still rejects drive letters, network paths and ..", async () => {
    for (const file of ["C:\\Bases\\x.base", "c:/Bases/x.base", "\\\\server\\share\\x.base", "//server/share/x.base", "/../x.base", "./../x.base", "Bases/../../x.base"]) {
      const { status, json } = await query(app(), { file });
      expect(status, file).toBe(400);
      expect(json.error, file).toBe("bad_request");
    }
  });
});
