import { describe, expect, it } from "vitest";
import {
  BaseEvaluationError,
  Duration,
  FileRef,
  UnsupportedConstructError,
  asDate,
  durationOf,
  evaluate,
  parseExpression,
  type BaseEntry,
  type EvalContext,
  type LinkResolver,
} from "./base-expr";

const NOW = new Date(2026, 10, 27, 15, 30, 0); // 27 Nov 2026 15:30 local

function entry(partial: Partial<BaseEntry["file"]> = {}, note: Record<string, unknown> = {}): BaseEntry {
  return {
    file: {
      name: "Dune.md",
      basename: "Dune",
      path: "books/Dune.md",
      folder: "books",
      ext: "md",
      size: 1234,
      ctime: new Date(2026, 0, 1).getTime(),
      mtime: new Date(2026, 10, 25).getTime(),
      tags: ["#book", "#sci-fi/classic"],
      links: ["Frank Herbert", "Arrakis"],
      embeds: ["cover.png"],
      ...partial,
    },
    note,
  };
}

const noLinks: LinkResolver = {
  resolve: () => null,
  linksTo: () => false,
  backlinks: () => [],
};

/** Warnings recorded by the last evaluations (reset per test file run). */
const warnings: string[] = [];

function ctxFor(e: BaseEntry, formulas: Record<string, string> = {}, links: LinkResolver = noLinks): EvalContext {
  const ctx: EvalContext = {
    entry: e,
    links,
    now: NOW,
    warn: (m) => warnings.push(m),
    tick: () => {},
    formula(name) {
      const src = formulas[name];
      if (src === undefined) throw new BaseEvaluationError(`Formula '${name}' is not defined`);
      return evaluate(parseExpression(src), ctx);
    },
  };
  return ctx;
}

function run(src: string, e: BaseEntry = entry(), formulas: Record<string, string> = {}, links?: LinkResolver): unknown {
  return evaluate(parseExpression(src), ctxFor(e, formulas, links));
}

describe("literals and operators", () => {
  it("evaluates numbers, strings, booleans, null and lists", () => {
    expect(run("1.5")).toBe(1.5);
    expect(run('"a \\"b\\""')).toBe('a "b"');
    expect(run("'single'")).toBe("single");
    expect(run("true")).toBe(true);
    expect(run("null")).toBe(null);
    expect(run("[1, 'x', [2]]")).toEqual([1, "x", [2]]);
  });

  it("follows arithmetic precedence and parentheses", () => {
    expect(run("1 + 2 * 3")).toBe(7);
    expect(run("(1 + 2) * 3")).toBe(9);
    expect(run("10 - 4 - 3")).toBe(3); // left-associative
    expect(run("7 % 4")).toBe(3);
    expect(run("-2 * 3")).toBe(-6);
    expect(run("1 / 0")).toBe(null); // not Infinity
  });

  it("follows boolean precedence (&& before ||) and comparison before &&", () => {
    expect(run("true || false && false")).toBe(true);
    expect(run("(true || false) && false")).toBe(false);
    expect(run("1 < 2 && 3 > 2")).toBe(true);
    expect(run("!false && !(1 == 2)")).toBe(true);
  });

  it("concatenates strings with +", () => {
    expect(run('"a" + 1')).toBe("a1");
    expect(run('price.toFixed(2) + " dollars"', entry({}, { price: 3 }))).toBe("3.00 dollars");
  });

  it("treats a division slash as division, not a regex", () => {
    expect(run("price / age", entry({}, { price: 10, age: 4 }))).toBe(2.5);
    expect(run("(10) / 2")).toBe(5);
  });
});

describe("property access", () => {
  const e = entry({}, { status: "reading", rating: 4, "due date": "2026-12-01", author: { name: "Frank" }, list: [1, 2, 3] });

  it("reads note properties bare, via note.x and via note[\"x\"]", () => {
    expect(run("status", e)).toBe("reading");
    expect(run("note.status", e)).toBe("reading");
    expect(run('note["due date"]', e)).toBe("2026-12-01");
    expect(run("frontmatter.rating", e)).toBe(4); // legacy alias
  });

  it("returns null for missing properties instead of throwing", () => {
    expect(run("missing", e)).toBe(null);
    expect(run("missing.deeper", e)).toBe(null);
    expect(run("note.missing", e)).toBe(null);
  });

  it("reads nested objects and list indexes", () => {
    expect(run("author.name", e)).toBe("Frank");
    expect(run('author["name"]', e)).toBe("Frank");
    expect(run("list[0]", e)).toBe(1);
    expect(run("list[-1]", e)).toBe(3);
    expect(run("list[9]", e)).toBe(null);
    expect(run("list.length", e)).toBe(3);
    expect(run("status.length", e)).toBe(7);
  });

  it("exposes file fields with Obsidian's meaning (name includes the extension)", () => {
    expect(run("file.name")).toBe("Dune.md");
    expect(run("file.basename")).toBe("Dune");
    expect(run("file.path")).toBe("books/Dune.md");
    expect(run("file.folder")).toBe("books");
    expect(run("file.ext")).toBe("md");
    expect(run("file.size")).toBe(1234);
    expect(run("file.mtime")).toBeInstanceOf(Date);
    expect(run("file.tags")).toEqual(["#book", "#sci-fi/classic"]);
    expect(run("file.embeds")).toEqual(["cover.png"]);
    expect(run("file.properties", e)).toMatchObject({ status: "reading" });
    expect(run("file")).toBeInstanceOf(FileRef);
  });

  it("rejects unknown file fields clearly", () => {
    expect(() => run("file.nope")).toThrow(UnsupportedConstructError);
  });
});

describe("comparisons", () => {
  it("compares numbers, numeric strings and strings", () => {
    expect(run("rating >= 4", entry({}, { rating: 4 }))).toBe(true);
    expect(run("rating > 4", entry({}, { rating: "5" }))).toBe(true);
    expect(run('"b" > "a"')).toBe(true);
    expect(run("status == \"done\"", entry({}, { status: "done" }))).toBe(true);
    expect(run("status != \"done\"", entry({}, { status: "todo" }))).toBe(true);
  });

  it("makes ordering comparisons against a missing value false (both ways)", () => {
    expect(run("price > 2")).toBe(false);
    expect(run("price < 2")).toBe(false);
    expect(run("price == null")).toBe(true);
    expect(run("price != 2")).toBe(true);
  });

  it("compares lists element-wise and never equal to a scalar", () => {
    expect(run("[1, 2] == [1, 2]")).toBe(true);
    expect(run("[1] == 1")).toBe(false);
  });
});

describe("dates and durations", () => {
  it("parses dates in local time", () => {
    const d = asDate("2026-12-01")!;
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 11, 1, 0]);
    expect(asDate("2026-12-01 14:05:09")!.getMinutes()).toBe(5);
    expect(asDate("not a date")).toBe(null);
  });

  it("parses duration strings in every documented unit", () => {
    expect(durationOf("1d")!.ms).toBe(86_400_000);
    expect(durationOf("2 hours")!.ms).toBe(7_200_000);
    expect(durationOf("1w")!.ms).toBe(7 * 86_400_000);
    expect(durationOf("30 minutes")!.ms).toBe(1_800_000);
    expect(durationOf("1M")!.parts.M).toBe(1);
    expect(durationOf("1m")!.parts.m).toBe(1); // month vs minute is case-sensitive
    expect(durationOf("1y 2d")!.parts).toMatchObject({ y: 1, d: 2 });
    expect(durationOf("soon")).toBe(null);
    expect(durationOf("1 fortnight")).toBe(null);
  });

  it("does calendar arithmetic with + and -", () => {
    const d = run('date("2024-12-01") + "1M" + "4h" + "3m"') as Date;
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2025, 0, 1, 4, 3]);
    const back = run('date("2026-01-15") - "1M"') as Date;
    expect([back.getFullYear(), back.getMonth(), back.getDate()]).toEqual([2025, 11, 15]);
  });

  it("subtracts dates into a duration and compares it", () => {
    const d = run('date("2026-12-03") - date("2026-12-01")');
    expect(d).toBeInstanceOf(Duration);
    expect((d as Duration).ms).toBe(2 * 86_400_000);
    expect(run('date("2026-12-03") - date("2026-12-01") > "1d"')).toBe(true);
  });

  it("supports now(), today() and the 'modified within a week' idiom", () => {
    expect((run("today()") as Date).getHours()).toBe(0);
    expect(run("now()")).toEqual(NOW);
    expect(run('file.mtime > now() - "1 week"')).toBe(true); // mtime is 25 Nov
    expect(run('file.mtime > now() - "1 day"')).toBe(false);
  });

  it("compares date-valued frontmatter strings against dates", () => {
    const e = entry({}, { due: "2026-11-20" });
    expect(run("due < today()", e)).toBe(true);
    expect(run('note.due + "10d" > today()', e)).toBe(true);
    expect(run('due == date("2026-11-20")', e)).toBe(true);
  });

  it("formats dates with Moment and exposes fields", () => {
    expect(run('date("2026-12-01 09:05:00").format("YYYY-MM-DD HH:mm")')).toBe("2026-12-01 09:05");
    expect(run('date("2026-12-01").year')).toBe(2026);
    expect(run('date("2026-12-01").month')).toBe(12);
    expect(run('date("2026-12-01 09:05:00").date().hour')).toBe(0);
    expect(run('date("2026-12-01 09:05:07").time()')).toBe("09:05:07");
  });
});

describe("global functions", () => {
  it("if() only evaluates the chosen branch", () => {
    expect(run('if(price, price.toFixed(2) + " dollars")', entry({}, { price: 2 }))).toBe("2.00 dollars");
    expect(run('if(price, price.toFixed(2) + " dollars")')).toBe(null);
    expect(run('if(false, formula.undefined_formula, "safe")')).toBe("safe");
  });

  it("list(), number(), min(), max()", () => {
    expect(run("list(status)", entry({}, { status: "a" }))).toEqual(["a"]);
    expect(run("list(tags)", entry({}, { tags: ["a", "b"] }))).toEqual(["a", "b"]);
    expect(run("list(missing)")).toEqual([]);
    expect(run('number("42")')).toBe(42);
    expect(run("number(true)")).toBe(1);
    expect(run("min(3, 1, 2)")).toBe(1);
    expect(run("max([3, 9], 2)")).toBe(9);
  });
});

describe("methods", () => {
  const e = entry({}, { title: "Hello World", tags: ["a", "b"], n: 3.14159, empty: "", props: { k: 1 } });

  it("string methods", () => {
    expect(run('title.contains("World")', e)).toBe(true);
    expect(run('title.containsAll("Hello", "World")', e)).toBe(true);
    expect(run('title.containsAny("x", "World")', e)).toBe(true);
    expect(run('title.startsWith("He")', e)).toBe(true);
    expect(run('title.endsWith("ld")', e)).toBe(true);
    expect(run("title.lower()", e)).toBe("hello world");
    expect(run('"hello world".title()')).toBe("Hello World");
    expect(run('"  x ".trim()')).toBe("x");
    expect(run('"a:b:c".replace(":", "-")')).toBe("a-b-c");
    expect(run('"123".repeat(2)')).toBe("123123");
    expect(run('"hello".reverse()')).toBe("olleh");
    expect(run('"hello".slice(1, 4)')).toBe("ell");
    expect(run('"a,b,c,d".split(",", 3)')).toEqual(["a", "b", "c"]);
    expect(run("empty.isEmpty()", e)).toBe(true);
  });

  it("number methods", () => {
    expect(run("n.round(2)", e)).toBe(3.14);
    expect(run("n.toFixed(1)", e)).toBe("3.1");
    expect(run("(-2.5).abs()")).toBe(2.5);
    expect(run("n.floor()", e)).toBe(3);
    expect(run("n.ceil()", e)).toBe(4);
  });

  it("list methods", () => {
    expect(run('tags.contains("a")', e)).toBe(true);
    expect(run('tags.containsAll("a", "b")', e)).toBe(true);
    expect(run('tags.containsAny("z", "b")', e)).toBe(true);
    expect(run('tags.join(" | ")', e)).toBe("a | b");
    expect(run("[1, [2, 3]].flat()")).toEqual([1, 2, 3]);
    expect(run("[1, 1, 2].unique()")).toEqual([1, 2]);
    expect(run("[3, 1, 2].sort()")).toEqual([1, 2, 3]);
    expect(run("[1, 2, 3].reverse()")).toEqual([3, 2, 1]);
    expect(run("[].isEmpty()")).toBe(true);
  });

  it("object and any-type methods", () => {
    expect(run("props.keys()", e)).toEqual(["k"]);
    expect(run("props.values()", e)).toEqual([1]);
    expect(run("props.isEmpty()", e)).toBe(false);
    expect(run("missing.isEmpty()")).toBe(true);
    expect(run("missing.isTruthy()")).toBe(false);
    expect(run('missing.contains("x")')).toBe(false);
    expect(run("missing.lower()")).toBe(null);
    expect(run('"x".isType("string")')).toBe(true);
    expect(run("(1).toString()")).toBe("1");
  });
});

describe("file methods", () => {
  it("hasTag matches any argument, nested tags, without # and case-insensitively", () => {
    expect(run('file.hasTag("book")')).toBe(true);
    expect(run('file.hasTag("#BOOK")')).toBe(true);
    expect(run('file.hasTag("sci-fi")')).toBe(true); // nested #sci-fi/classic
    expect(run('file.hasTag("sci")')).toBe(false); // prefix of a name isn't a parent tag
    expect(run('file.hasTag("x", "book")')).toBe(true);
    expect(run('file.hasTag("x", "y")')).toBe(false);
  });

  it("inFolder includes sub-folders but not look-alike siblings", () => {
    const e = entry({ folder: "Reading/2026", path: "Reading/2026/x.md" });
    expect(run('file.inFolder("Reading")', e)).toBe(true);
    expect(run('file.inFolder("Reading/2026")', e)).toBe(true);
    expect(run('file.inFolder("Reading/")', e)).toBe(true);
    expect(run('file.inFolder("Read")', e)).toBe(false);
    expect(run('file.inFolder("Reading 2")', entry({ folder: "Reading" }))).toBe(false);
  });

  it("hasProperty checks for the key, even with an empty value", () => {
    const e = entry({}, { status: null });
    expect(run('file.hasProperty("status")', e)).toBe(true);
    expect(run('file.hasProperty("other")', e)).toBe(false);
  });

  it("hasLink uses resolved links, then falls back to the written link text", () => {
    const links: LinkResolver = {
      resolve: (p) => (p === "Frank Herbert" ? "people/Frank Herbert.md" : null),
      linksTo: (src, target) => src === "books/Dune.md" && target === "people/Frank Herbert.md",
      backlinks: () => ["index.md"],
    };
    expect(run('file.hasLink("Frank Herbert")', entry(), {}, links)).toBe(true);
    expect(run('file.hasLink("[[Frank Herbert|FH]]")', entry(), {}, links)).toBe(true);
    expect(run('file.hasLink("Arrakis")', entry(), {}, links)).toBe(true); // unresolved, by text
    expect(run('file.hasLink("Nowhere")', entry(), {}, links)).toBe(false);
    expect(run("file.backlinks", entry(), {}, links)).toEqual(["index.md"]);
  });
});

describe("formulas", () => {
  it("reads formula.x, including formulas built on other formulas", () => {
    const f = { ppu: "(price / age).toFixed(2)", label: 'formula.ppu + " per unit"' };
    const e = entry({}, { price: 10, age: 4 });
    expect(run("formula.ppu", e, f)).toBe("2.50");
    expect(run("formula.label", e, f)).toBe("2.50 per unit");
    expect(run("formula.ppu > 2", e, f)).toBe(true); // "2.50" vs 2 → numeric
  });
});

describe("unsupported constructs fail loudly, by name", () => {
  const cases: Array<[string, RegExp]> = [
    ["this.file.name", /'this'/],
    ['file.hasLink(this)', /'this'/],
    ['name.matches(/^a/)', /regular expression/],
    ['/x/.matches("y")', /regular expression/],
    ["tags.filter(value > 2)", /lambdas/],
    ['link("Note")', /link\(\)/],
    ['icon("plus")', /icon\(\)/],
    ["random()", /random\(\)/],
    ["values.mean()", /unknown method '\.mean\(\)'/],
    ["nosuchfn(1)", /unknown function 'nosuchfn\(\)'/],
    ['status.nosuchmethod()', /unknown method '\.nosuchmethod\(\)'/],
    ["file.asLink()", /asLink/],
  ];
  for (const [src, msg] of cases) {
    it(`rejects ${src}`, () => {
      expect(() => parseExpression(src)).toThrow(UnsupportedConstructError);
      expect(() => parseExpression(src)).toThrow(msg);
    });
  }

  it("rejects an unsupported method even when the receiver would be null for this row", () => {
    // Static validation: the error can't depend on which rows exist.
    expect(() => parseExpression("missing.filter(value)")).toThrow(UnsupportedConstructError);
  });
});

describe("JavaScript internals never leak through property names", () => {
  it("treats constructor / __proto__ / toString as ordinary missing properties", () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(run(name)).toBe(null);
      expect(run(`note.${name}`)).toBe(null);
      expect(run(`note["${name}"]`)).toBe(null);
      expect(run(`props.${name}`, entry({}, { props: { a: 1 } }))).toBe(null);
    }
  });

  it("still reads a real property that happens to be called constructor", () => {
    expect(run("constructor", entry({}, { constructor: "Ada" }))).toBe("Ada");
  });

  it("rejects calls to inherited names that aren't Bases functions", () => {
    expect(() => parseExpression("constructor(1)")).toThrow(UnsupportedConstructError);
    expect(() => parseExpression("hasOwnProperty(1)")).toThrow(UnsupportedConstructError);
    expect(() => parseExpression('x.valueOf()')).toThrow(UnsupportedConstructError);
  });

  it("does not accept inherited names as duration units", () => {
    expect(durationOf("1 constructor")).toBe(null);
    expect(durationOf("2 toString")).toBe(null);
  });
});

describe("syntax errors", () => {
  for (const src of ["status !!! \"done\"", "foo((((", "1 +", "(1", "a b", "'unterminated", "a = 1", ""]) {
    it(`reports '${src}' as a BaseEvaluationError`, () => {
      expect(() => parseExpression(src)).toThrow(BaseEvaluationError);
    });
  }
});

describe("durationOf runs in linear time (review item 1)", () => {
  it("rejects a 200,000-digit string quickly", () => {
    const t = performance.now();
    expect(durationOf("1".repeat(200_000))).toBe(null);
    expect(durationOf(`${"1".repeat(200_000)}x`)).toBe(null);
    expect(performance.now() - t).toBeLessThan(50);
  });

  it("still parses real durations, including with spaces and commas", () => {
    expect(durationOf("1d, 2h")!.ms).toBe(86_400_000 + 7_200_000);
    expect(durationOf("-3 days")!.parts.d).toBe(-3);
    expect(durationOf("1.5h")!.ms).toBe(5_400_000);
    expect(durationOf("d")).toBe(null);
    expect(durationOf("5")).toBe(null);
  });
});

describe("unique() uses typed equality at every size (follow-up 4)", () => {
  it("keeps 5 and \"5\" distinct in small and large lists alike", () => {
    expect(run('[5, "5", 5, "5", null, null].unique()')).toEqual([5, "5", null]);
    const big = Array.from({ length: 12_000 }, (_, i) => (i % 2 ? 5 : "5"));
    expect(run("xs.unique()", entry({}, { xs: big }))).toEqual(["5", 5]);
  });

  it("is linear for primitives", () => {
    const xs = Array.from({ length: 100_000 }, (_, i) => i % 1000);
    const t = performance.now();
    expect((run("xs.unique()", entry({}, { xs })) as unknown[]).length).toBe(1000);
    expect(performance.now() - t).toBeLessThan(200);
  });

  it("de-duplicates dates by instant, and lists / objects by value", () => {
    expect((run('[date("2024-01-01"), date("2024-01-01"), date("2024-01-02")].unique()') as unknown[]).length).toBe(2);
    expect(run("[[1, 2], [1, 2], [2]].unique()")).toEqual([[1, 2], [2]]);
    expect(run("objs.unique()", entry({}, { objs: [{ a: 1 }, { a: 1 }, { a: 2 }] }))).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("caps the number of lists / objects it compares pairwise", () => {
    const objs = Array.from({ length: 5_001 }, (_, i) => ({ i }));
    expect(() => run("objs.unique()", entry({}, { objs }))).toThrow(/at most 5,000 lists or objects/);
  });
});
