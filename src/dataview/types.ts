/**
 * Minimal structural types matching the Dataview plugin API surface we consume.
 *
 * We do NOT depend on the `obsidian-dataview` npm package — it pulls its entire
 * runtime (luxon, chartjs, etc.) into our devDeps for zero benefit once esbuild
 * strips the types. These structural types cover exactly the fields the
 * normalizer reads.
 *
 * Upstream source of truth:
 *   https://github.com/blacksmithgu/obsidian-dataview/blob/master/src/api/plugin-api.ts
 *   https://github.com/blacksmithgu/obsidian-dataview/blob/master/src/data-model/serialized/markdown.ts
 */

export interface LuxonDateTime {
  toISO(): string | null;
  isValid: boolean;
}

export interface LuxonDuration {
  toISO(): string | null;
  isValid: boolean;
}

export interface DvLink {
  path: string;
  display?: string;
  subpath?: string;
  embed?: boolean;
  type?: "file" | "header" | "block";
}

export interface DvDataArray<T = unknown> {
  array(): T[];
}

export type DvLiteral =
  | null
  | undefined
  | string
  | number
  | boolean
  | DvLink
  | LuxonDateTime
  | LuxonDuration
  | DvDataArray
  | DvLiteral[]
  | { [key: string]: DvLiteral };

export interface DvSListItemBase {
  symbol: string;
  link: DvLink;
  section: DvLink;
  path: string;
  line: number;
  lineCount: number;
  position: unknown;
  list: number;
  blockId?: string;
  parent?: number;
  children: DvSListItem[];
  outlinks: DvLink[];
  text: string;
  visual?: string;
  annotated?: boolean;
  tags: string[];
}

export interface DvSListEntry extends DvSListItemBase {
  task: false;
}

export interface DvSTask extends DvSListItemBase {
  task: true;
  status: string;
  checked: boolean;
  completed: boolean;
  fullyCompleted: boolean;
  created?: DvLiteral;
  due?: DvLiteral;
  completion?: DvLiteral;
  start?: DvLiteral;
  scheduled?: DvLiteral;
}

export type DvSListItem = DvSListEntry | DvSTask;

/** Recursive grouping tree — matches Dataview's Grouping<T>. */
export type DvGrouping<T> = T[] | DvGroupElement<T>[];
export interface DvGroupElement<T> {
  key: DvLiteral;
  rows: DvGrouping<T>;
}

export interface DvTableResult {
  type: "table";
  headers: string[];
  values: DvLiteral[][];
}

export interface DvListResult {
  type: "list";
  values: DvLiteral[];
}

export interface DvTaskResult {
  type: "task";
  values: DvGrouping<DvSListItem>;
}

export interface DvCalendarResult {
  type: "calendar";
  values: { date: LuxonDateTime; link: DvLink; value?: DvLiteral[] }[];
}

export type DvQueryResult =
  | DvTableResult
  | DvListResult
  | DvTaskResult
  | DvCalendarResult;

export interface DvResult<V, E> {
  successful: boolean;
  value?: V;
  error?: E;
}

export interface DataviewApi {
  query(
    source: string,
    originFile?: string,
  ): Promise<DvResult<DvQueryResult, string>>;
}

/** Type-guard helpers used by the normalizer. */
export function isLink(x: unknown): x is DvLink {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as DvLink).path === "string" &&
    // Links always have at least path; keep guard narrow.
    !("array" in (x as object)) &&
    !("toISO" in (x as object))
  );
}

export function isDateTime(x: unknown): x is LuxonDateTime {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as LuxonDateTime).toISO === "function" &&
    // Luxon DateTime has isValid; Duration has it too — distinguish by shape of other keys.
    "isValid" in (x as object) &&
    !("values" in (x as object))
  );
}

export function isDuration(x: unknown): x is LuxonDuration {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as LuxonDuration).toISO === "function" &&
    "values" in (x as object)
  );
}

export function isDataArray(x: unknown): x is DvDataArray {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as DvDataArray).array === "function"
  );
}
