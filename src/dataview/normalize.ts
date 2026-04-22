import {
  type DvGrouping,
  type DvLiteral,
  type DvQueryResult,
  type DvSListItem,
  isDataArray,
  isDateTime,
  isDuration,
  isLink,
} from "./types";

export type Value =
  | string
  | number
  | boolean
  | null
  | Value[]
  | { [k: string]: Value };

export interface NormalizedListItem {
  task: boolean;
  text: string;
  path: string;
  line: number;
  section?: string;
  blockId?: string;
  tags: string[];
  annotated?: boolean;
  children: NormalizedListItem[];
  status?: string;
  checked?: boolean;
  completed?: boolean;
  fullyCompleted?: boolean;
  due?: string | null;
  completion?: string | null;
  scheduled?: string | null;
  start?: string | null;
  created?: string | null;
}

export interface NormalizedEvent {
  date: string | null;
  link: string;
  value?: Value[];
}

export type NormalizedDataviewResult =
  | { kind: "table"; headers: string[]; rows: Value[][] }
  | { kind: "list"; values: Value[] }
  | { kind: "task"; items: NormalizedListItem[] }
  | { kind: "calendar"; events: NormalizedEvent[] };

/**
 * Flattens Dataview's Literal type into JSON-safe values:
 *   Link       -> link.path
 *   DateTime   -> ISO string (or null on invalid)
 *   Duration   -> ISO duration ("P1D", or null on invalid)
 *   DataArray  -> recurse over .array()
 *   undefined  -> null
 *   array/obj  -> recurse
 *   primitives -> passthrough
 */
export function normalizeLiteral(x: DvLiteral | unknown): Value {
  if (x === undefined || x === null) return null;
  const t = typeof x;
  if (t === "string" || t === "number" || t === "boolean") return x as Value;

  if (isLink(x)) return x.path;
  if (isDateTime(x)) return x.toISO();
  if (isDuration(x)) return x.toISO();
  if (isDataArray(x)) return x.array().map(normalizeLiteral);
  if (Array.isArray(x)) return x.map(normalizeLiteral);

  if (t === "object") {
    const out: { [k: string]: Value } = {};
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
      out[k] = normalizeLiteral(v);
    }
    return out;
  }

  // function / symbol / bigint — unexpected; fall back to null.
  return null;
}

function stringOrNull(v: Value): string | null {
  return typeof v === "string" ? v : null;
}

function normalizeListItem(item: DvSListItem): NormalizedListItem {
  const base: NormalizedListItem = {
    task: item.task,
    text: item.text,
    path: item.path,
    line: item.line,
    tags: Array.isArray(item.tags) ? [...item.tags] : [],
    children: (item.children ?? []).map(normalizeListItem),
  };
  if (item.section?.path) base.section = item.section.path;
  if (item.blockId) base.blockId = item.blockId;
  if (typeof item.annotated === "boolean") base.annotated = item.annotated;

  if (item.task) {
    base.status = item.status;
    base.checked = item.checked;
    base.completed = item.completed;
    base.fullyCompleted = item.fullyCompleted;
    if (item.due !== undefined)
      base.due = stringOrNull(normalizeLiteral(item.due));
    if (item.completion !== undefined)
      base.completion = stringOrNull(normalizeLiteral(item.completion));
    if (item.scheduled !== undefined)
      base.scheduled = stringOrNull(normalizeLiteral(item.scheduled));
    if (item.start !== undefined)
      base.start = stringOrNull(normalizeLiteral(item.start));
    if (item.created !== undefined)
      base.created = stringOrNull(normalizeLiteral(item.created));
  }

  return base;
}

/**
 * Flattens Dataview's `Grouping<SListItem>` (nested grouping tree) into a flat
 * list of items. Grouping rows (those with `{key, rows}`) are walked; their
 * `key` is not surfaced — callers who care about grouping should do it
 * client-side from the flat `path` + `line` values.
 */
function flattenGrouping(g: DvGrouping<DvSListItem>): DvSListItem[] {
  const out: DvSListItem[] = [];
  for (const entry of g) {
    if (
      entry &&
      typeof entry === "object" &&
      "rows" in entry &&
      Array.isArray((entry as { rows: unknown }).rows)
    ) {
      out.push(...flattenGrouping((entry as { rows: DvGrouping<DvSListItem> }).rows));
    } else {
      out.push(entry as DvSListItem);
    }
  }
  return out;
}

export function normalizeDataviewResult(
  r: DvQueryResult,
): NormalizedDataviewResult {
  switch (r.type) {
    case "table":
      return {
        kind: "table",
        headers: [...r.headers],
        rows: r.values.map((row) => row.map(normalizeLiteral)),
      };
    case "list":
      return { kind: "list", values: r.values.map(normalizeLiteral) };
    case "task": {
      const flat = flattenGrouping(r.values);
      return { kind: "task", items: flat.map(normalizeListItem) };
    }
    case "calendar":
      return {
        kind: "calendar",
        events: r.values.map((ev) => {
          const e: NormalizedEvent = {
            date: ev.date?.toISO?.() ?? null,
            link: ev.link?.path ?? "",
          };
          if (ev.value !== undefined) {
            const v = normalizeLiteral(ev.value);
            if (Array.isArray(v)) e.value = v;
          }
          return e;
        }),
      };
  }
}
