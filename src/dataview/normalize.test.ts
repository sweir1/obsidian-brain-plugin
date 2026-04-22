import { describe, it, expect } from "vitest";
import {
  normalizeDataviewResult,
  normalizeLiteral,
} from "./normalize";
import type {
  DvCalendarResult,
  DvLink,
  DvListResult,
  DvSListItem,
  DvTableResult,
  DvTaskResult,
  LuxonDateTime,
  LuxonDuration,
} from "./types";

const link = (path: string, display?: string): DvLink => ({
  path,
  ...(display !== undefined ? { display } : {}),
});

const date = (iso: string | null): LuxonDateTime => ({
  toISO: () => iso,
  isValid: iso !== null,
});

const duration = (iso: string | null): LuxonDuration => ({
  toISO: () => iso,
  isValid: iso !== null,
  // Distinguishes Duration from DateTime in the type-guard:
  ...({ values: { days: 1 } } as object),
});

const dataArray = <T>(items: T[]) => ({ array: () => items });

describe("normalizeLiteral", () => {
  it("passes primitives through", () => {
    expect(normalizeLiteral("hello")).toBe("hello");
    expect(normalizeLiteral(42)).toBe(42);
    expect(normalizeLiteral(true)).toBe(true);
    expect(normalizeLiteral(false)).toBe(false);
  });

  it("maps null and undefined to null", () => {
    expect(normalizeLiteral(null)).toBeNull();
    expect(normalizeLiteral(undefined)).toBeNull();
  });

  it("flattens Link to link.path", () => {
    expect(normalizeLiteral(link("Notes/Foo.md"))).toBe("Notes/Foo.md");
  });

  it("flattens DateTime via toISO()", () => {
    expect(normalizeLiteral(date("2026-04-22T10:00:00.000Z"))).toBe(
      "2026-04-22T10:00:00.000Z",
    );
  });

  it("returns null for an invalid DateTime", () => {
    expect(normalizeLiteral(date(null))).toBeNull();
  });

  it("flattens Duration via toISO()", () => {
    expect(normalizeLiteral(duration("P1D"))).toBe("P1D");
  });

  it("unwraps DataArray and recurses", () => {
    const arr = dataArray([link("A.md"), link("B.md"), 7]);
    expect(normalizeLiteral(arr)).toEqual(["A.md", "B.md", 7]);
  });

  it("recurses into plain arrays", () => {
    expect(normalizeLiteral([1, "a", link("C.md"), null])).toEqual([
      1,
      "a",
      "C.md",
      null,
    ]);
  });

  it("recurses into plain objects", () => {
    expect(normalizeLiteral({ a: 1, link: link("D.md"), nested: { b: true } })).toEqual({
      a: 1,
      link: "D.md",
      nested: { b: true },
    });
  });
});

describe("normalizeDataviewResult — table", () => {
  it("normalizes headers and rows, flattening each cell", () => {
    const input: DvTableResult = {
      type: "table",
      headers: ["name", "rating"],
      values: [
        [link("Book A.md"), 5],
        [link("Book B.md"), 3],
      ],
    };
    const out = normalizeDataviewResult(input);
    expect(out).toEqual({
      kind: "table",
      headers: ["name", "rating"],
      rows: [
        ["Book A.md", 5],
        ["Book B.md", 3],
      ],
    });
  });
});

describe("normalizeDataviewResult — list", () => {
  it("flattens each value", () => {
    const input: DvListResult = {
      type: "list",
      values: [link("L1.md"), link("L2.md"), 42],
    };
    const out = normalizeDataviewResult(input);
    expect(out).toEqual({
      kind: "list",
      values: ["L1.md", "L2.md", 42],
    });
  });
});

describe("normalizeDataviewResult — task", () => {
  it("flattens a simple STask with completion date", () => {
    const item: DvSListItem = {
      task: true,
      symbol: "-",
      link: link("Tasks.md"),
      section: link("Tasks.md#Todo"),
      path: "Tasks.md",
      line: 4,
      lineCount: 1,
      position: {},
      list: 0,
      children: [],
      outlinks: [],
      text: "Buy milk",
      tags: ["#errand"],
      status: "x",
      checked: true,
      completed: true,
      fullyCompleted: true,
      completion: date("2026-04-20T12:00:00.000Z"),
    };
    const input: DvTaskResult = { type: "task", values: [item] };
    const out = normalizeDataviewResult(input);
    expect(out).toEqual({
      kind: "task",
      items: [
        {
          task: true,
          text: "Buy milk",
          path: "Tasks.md",
          line: 4,
          tags: ["#errand"],
          section: "Tasks.md#Todo",
          children: [],
          status: "x",
          checked: true,
          completed: true,
          fullyCompleted: true,
          completion: "2026-04-20T12:00:00.000Z",
        },
      ],
    });
  });

  it("flattens nested children and non-task SListEntry alongside STask", () => {
    const child: DvSListItem = {
      task: false,
      symbol: "-",
      link: link("Notes.md"),
      section: link("Notes.md"),
      path: "Notes.md",
      line: 6,
      lineCount: 1,
      position: {},
      list: 0,
      children: [],
      outlinks: [],
      text: "child note",
      tags: [],
    };
    const parent: DvSListItem = {
      task: true,
      symbol: "-",
      link: link("Notes.md"),
      section: link("Notes.md"),
      path: "Notes.md",
      line: 5,
      lineCount: 2,
      position: {},
      list: 0,
      children: [child],
      outlinks: [],
      text: "parent task",
      tags: [],
      status: " ",
      checked: false,
      completed: false,
      fullyCompleted: false,
    };
    const input: DvTaskResult = { type: "task", values: [parent] };
    const out = normalizeDataviewResult(input);
    expect(out.kind).toBe("task");
    if (out.kind !== "task") throw new Error("wrong kind");
    expect(out.items).toHaveLength(1);
    expect(out.items[0].task).toBe(true);
    expect(out.items[0].children).toHaveLength(1);
    expect(out.items[0].children[0].task).toBe(false);
  });

  it("walks a Grouping tree ({key, rows}) and flattens into items", () => {
    const item: DvSListItem = {
      task: true,
      symbol: "-",
      link: link("G.md"),
      section: link("G.md"),
      path: "G.md",
      line: 1,
      lineCount: 1,
      position: {},
      list: 0,
      children: [],
      outlinks: [],
      text: "grouped task",
      tags: [],
      status: " ",
      checked: false,
      completed: false,
      fullyCompleted: false,
    };
    const input = {
      type: "task" as const,
      values: [{ key: "group-A", rows: [item] }],
    };
    const out = normalizeDataviewResult(input);
    expect(out.kind).toBe("task");
    if (out.kind !== "task") throw new Error("wrong kind");
    expect(out.items).toHaveLength(1);
    expect(out.items[0].text).toBe("grouped task");
  });
});

describe("normalizeDataviewResult — calendar", () => {
  it("flattens date/link/value triples", () => {
    const input: DvCalendarResult = {
      type: "calendar",
      values: [
        {
          date: date("2026-04-22T00:00:00.000Z"),
          link: link("Journal/2026-04-22.md"),
          value: [link("Ref1.md")],
        },
        {
          date: date("2026-04-23T00:00:00.000Z"),
          link: link("Journal/2026-04-23.md"),
        },
      ],
    };
    const out = normalizeDataviewResult(input);
    expect(out).toEqual({
      kind: "calendar",
      events: [
        {
          date: "2026-04-22T00:00:00.000Z",
          link: "Journal/2026-04-22.md",
          value: ["Ref1.md"],
        },
        {
          date: "2026-04-23T00:00:00.000Z",
          link: "Journal/2026-04-23.md",
        },
      ],
    });
  });
});
