import type { App, CachedMetadata, TFile } from "obsidian";
import { getAllTags, parseYaml } from "obsidian";
import {
  BaseEvaluationError,
  Duration,
  FILE_FIELDS,
  FileRef,
  ResourceLimitError,
  UnsupportedConstructError,
  asDate,
  compareValues,
  equals,
  evaluate,
  fileField,
  formatLocalDate,
  formulaRefs,
  isDateOnly,
  isEmptyValue,
  markDateOnly,
  parseExpression,
  toText,
  truthy,
  type BaseEntry,
  type EvalContext,
  type LinkResolver,
  type Node,
} from "./base-expr";

export { UnsupportedConstructError, BaseEvaluationError, ResourceLimitError } from "./base-expr";
export type { BaseEntry } from "./base-expr";

/**
 * Evaluates an Obsidian Bases `.base` file headlessly.
 *
 * Obsidian has no public API to run a base and read its rows, so the
 * plugin parses the `.base` YAML itself, builds one entry per vault file
 * from the metadata cache, and evaluates the filters / formulas with
 * {@link ./base-expr}. The file format follows help.obsidian.md → Bases
 * syntax (Obsidian 1.9 – 1.14):
 *
 *   filters:   string | {and: [...]} | {or: [...]} | {not: [...]}
 *   formulas:  {name: "expression"}
 *   properties / summaries: display-only, ignored here
 *   views:     a list of {type, name, filters, order, sort, limit,
 *              groupBy, groupOrder, ...}
 *
 * Every view type (table, cards, list, kanban, map, plugin views) selects
 * rows the same way, so the `type` is not interpreted. The legacy shapes an
 * earlier version of this plugin accepted — `views` as a map keyed by name,
 * `columns:` instead of `order:`, `sort: [{column}]`, `frontmatter.x`, and
 * `{property: {op: value}}` filter shorthand — still work.
 *
 * Everything that depends only on the `.base` file (expressions, filter
 * shape, which formulas a filter needs) is checked before any row is
 * evaluated, so an error never depends on the vault's contents.
 */

/** Wall-clock budget for one evaluation. */
export const DEFAULT_TIME_LIMIT_MS = 10_000;
/** Most nodes a `filters:` tree may have, counting YAML aliases each time. */
export const MAX_FILTER_NODES = 10_000;
/** Deepest `and`/`or`/`not` nesting accepted. */
export const MAX_FILTER_DEPTH = 64;
/** Longest chain of formulas built on formulas. */
export const MAX_FORMULA_DEPTH = 64;
const MAX_WARNINGS = 20;

interface ViewDefinition {
  name?: unknown;
  type?: unknown;
  filters?: unknown;
  order?: unknown;
  /** Legacy alias for `order`. */
  columns?: unknown;
  sort?: unknown;
  limit?: unknown;
  groupBy?: unknown;
  groupOrder?: unknown;
}

export interface BaseRow {
  file: { name: string; basename: string; path: string };
  [column: string]: unknown;
}

export interface BaseGroup {
  /** The grouped property's value; null for files without one. */
  value: unknown;
  /** Rows in this group, before `limit`. */
  count: number;
}

export interface EvaluateOptions {
  yaml: string;
  /** View name; the first view when omitted (as Obsidian opens a base). */
  view?: string;
  /** Clock for `now()` / `today()` (tests). */
  now?: Date;
  /** Override the time budget (tests). */
  timeLimitMs?: number;
}

export interface EvaluateResult {
  /** Name of the view that ran (`null` for a base without views). */
  view: string | null;
  rows: BaseRow[];
  /** Matching rows before `limit`. */
  total: number;
  /** Present when the view groups its rows (`groupBy`). */
  groupBy?: string;
  groups?: BaseGroup[];
  /** Things that didn't stop the query but made some values null. */
  warnings?: string[];
}

export function evaluateBase(app: App, opts: EvaluateOptions): EvaluateResult {
  try {
    return run(app, opts);
  } catch (err) {
    // Last line of defence: any recursion we didn't bound is a 400, not a crash.
    if (err instanceof RangeError && /call stack/i.test(err.message)) {
      throw new ResourceLimitError("The base is nested too deeply to evaluate.");
    }
    throw err;
  }
}

function run(app: App, opts: EvaluateOptions): EvaluateResult {
  const doc = parseBaseYaml(opts.yaml);
  const warnings = new Set<string>();
  const warn = (msg: string) => {
    if (warnings.size < MAX_WARNINGS) warnings.add(msg);
  };

  const { name: viewName, def: view } = pickView(doc.views, opts.view);

  // ---- static checks: everything that depends only on the .base file ----
  const globalFilter = compileFilter(doc.filters, "filters", warn);
  const viewFilter = compileFilter(view.filters, "view filters", warn);
  const sortKeys = readSort(view.sort);
  const group = readGroupBy(view.groupBy);
  const columns = readColumns(view.order !== undefined ? view.order : view.columns);
  const formulas = compileFormulas(doc.formulas);

  // Formulas a filter, sort or group needs must work; a broken formula used
  // only as a column becomes null cells and a warning.
  const logicRefs = new Set<string>();
  for (const f of [globalFilter, viewFilter]) filterFormulaRefs(f, logicRefs);
  for (const id of [...sortKeys.map((k) => k.property), ...(group ? [group.property] : [])]) {
    checkPropertyId(id, "sort/groupBy");
    if (id.startsWith("formula.")) logicRefs.add(id.slice(8));
  }
  for (const name of logicRefs) {
    const problem = formulas.problem(name);
    if (problem) throw problem;
  }
  for (const col of columns) {
    if (col.id.startsWith("formula.")) {
      const problem = formulas.problem(col.id.slice(8));
      if (problem) warn(`${col.id}: ${problem.message} (column left empty)`);
    } else if (!isKnownPropertyId(col.id)) {
      warn(`${col.id}: unknown file property (column left empty)`);
    }
  }

  // ---- evaluation ----
  const deadline = Date.now() + (opts.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS);
  let steps = 0;
  const tick = () => {
    if ((++steps & 1023) === 0 && Date.now() > deadline) {
      throw new ResourceLimitError(
        `Evaluating this base took longer than ${Math.round((opts.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS) / 1000)}s. Add a filter or a limit to the view.`,
      );
    }
  };
  const now = opts.now ?? new Date();
  const links = linkResolver(app);
  const entries = collectEntries(app);
  const contexts = entries.map((entry) => makeContext(entry, formulas, links, now, warn, tick));

  let matched = contexts.filter((ctx) => {
    tick();
    return evalFilter(globalFilter, ctx) && evalFilter(viewFilter, ctx);
  });

  let groups: BaseGroup[] | undefined;
  if (group) {
    let ordered: Array<{ value: unknown; items: EvalContext[] }> = [];
    for (const ctx of matched) {
      tick();
      const value = normaliseGroupValue(propertyValue(group.property, ctx));
      let bucket = ordered.find((g) => sameGroup(g.value, value));
      if (!bucket) {
        bucket = { value, items: [] };
        ordered.push(bucket);
      }
      bucket.items.push(ctx);
    }
    if (Array.isArray(view.groupOrder)) {
      // Only the listed groups, in that order. `null` = files with no value.
      const out: typeof ordered = [];
      for (const want of view.groupOrder) {
        const hit = ordered.find((g) => sameGroup(g.value, normaliseGroupValue(want)));
        if (hit && !out.includes(hit)) out.push(hit);
      }
      ordered = out;
    } else {
      ordered.sort((a, b) => compareSortValues(a.value, b.value, group.dir));
    }
    for (const g of ordered) g.items = sortContexts(g.items, sortKeys, tick);
    groups = ordered.map((g) => ({ value: toOutput(g.value), count: g.items.length }));
    matched = ordered.flatMap((g) => g.items);
  } else {
    matched = sortContexts(matched, sortKeys, tick);
  }

  const total = matched.length;
  const limit = readLimit(view.limit);
  if (limit !== null) matched = matched.slice(0, limit);

  const rows = matched.map((ctx) => projectRow(ctx, columns, formulas, warn));

  const result: EvaluateResult = { view: viewName, rows, total };
  if (group) {
    result.groupBy = group.property;
    result.groups = groups;
  }
  if (warnings.size > 0) result.warnings = [...warnings];
  return result;
}

// ---------------------------------------------------------------------------
// YAML and views
// ---------------------------------------------------------------------------

function parseBaseYaml(yaml: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseYaml(yaml.replace(/^﻿/, ""));
  } catch (err) {
    // Only the first line: YAML errors continue with a snippet of the file.
    const first = (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 200);
    throw new BaseEvaluationError(`Invalid .base YAML: ${first}`);
  }
  // An empty file is a valid base: every file, one default view.
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BaseEvaluationError("A `.base` file must be a YAML mapping (filters, formulas, views, ...).");
  }
  return parsed as Record<string, unknown>;
}

function pickView(views: unknown, requested: string | undefined): { name: string | null; def: ViewDefinition } {
  const list: Array<{ name: string; def: ViewDefinition }> = [];
  if (Array.isArray(views)) {
    views.forEach((v, i) => {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const def = v as ViewDefinition;
        const name = typeof def.name === "string" && def.name !== "" ? def.name : `View ${i + 1}`;
        list.push({ name, def });
      }
    });
  } else if (views && typeof views === "object") {
    // Legacy: a map keyed by view name.
    for (const [name, def] of Object.entries(views as Record<string, unknown>)) {
      list.push({ name, def: def && typeof def === "object" ? (def as ViewDefinition) : {} });
    }
  } else if (views !== undefined && views !== null) {
    throw new BaseEvaluationError("`views:` must be a list of views.");
  }

  if (requested === undefined || requested === "") {
    if (list.length === 0) return { name: null, def: {} };
    return list[0]!;
  }
  const exact = list.find((v) => v.name === requested);
  if (exact) return exact;
  const folded = list.filter((v) => v.name.toLowerCase() === requested.toLowerCase());
  if (folded.length === 1) return folded[0]!;
  throw new BaseEvaluationError(
    `View '${requested}' not found in .base file. Available views: ${
      list.map((v) => `'${v.name}'`).join(", ") || "(none)"
    }.`,
  );
}

function readLimit(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

// ---------------------------------------------------------------------------
// Formulas
// ---------------------------------------------------------------------------

interface CompiledFormulas {
  node(name: string): Node | undefined;
  /** The error a use of this formula would raise, or null if it can be evaluated. */
  problem(name: string): Error | null;
}

/**
 * Parse every formula up front and work out, statically, which ones can't be
 * evaluated — because they use an unsupported construct, don't parse, refer
 * to a missing or broken formula, are circular, or chain too deeply.
 */
function compileFormulas(raw: unknown): CompiledFormulas {
  const sources = new Map<string, string>();
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw new BaseEvaluationError("`formulas:` must map formula names to expressions.");
    }
    for (const [name, expr] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof expr === "string") sources.set(name, expr);
      else if (typeof expr === "number" || typeof expr === "boolean") sources.set(name, String(expr));
    }
  }
  const nodes = new Map<string, Node>();
  const own = new Map<string, Error>();
  for (const [name, src] of sources) {
    try {
      nodes.set(name, parseExpression(src));
    } catch (err) {
      if (err instanceof UnsupportedConstructError || err instanceof BaseEvaluationError) {
        own.set(name, prefixError(err, `formula '${name}'`));
      } else throw err;
    }
  }

  // Iterative post-order walk (no recursion, so a 5,000-formula chain can't
  // overflow the stack): each formula's problem and chain height.
  const problems = new Map<string, Error | null>();
  const height = new Map<string, number>();
  const state = new Map<string, "visiting" | "done">();
  const depsOf = (name: string): string[] => {
    const node = nodes.get(name);
    return node ? [...formulaRefs(node)] : [];
  };
  const finish = (name: string): void => {
    let problem: Error | null = own.get(name) ?? null;
    let h = 1;
    for (const dep of depsOf(name)) {
      if (!sources.has(dep)) {
        problem ??= new BaseEvaluationError(`Formula '${name}' uses formula '${dep}', which is not defined in the base's \`formulas:\` section.`);
        continue;
      }
      problem ??= problems.get(dep) ?? null;
      h = Math.max(h, (height.get(dep) ?? 1) + 1);
    }
    if (!problem && h > MAX_FORMULA_DEPTH) {
      problem = new ResourceLimitError(`Formula '${name}' is built on other formulas more than ${MAX_FORMULA_DEPTH} levels deep.`);
    }
    height.set(name, h);
    problems.set(name, problem);
    state.set(name, "done");
  };
  for (const root of sources.keys()) {
    if (state.get(root) === "done") continue;
    const stack: Array<{ name: string; deps: string[]; i: number }> = [{ name: root, deps: depsOf(root), i: 0 }];
    state.set(root, "visiting");
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      if (top.i < top.deps.length) {
        const dep = top.deps[top.i++]!;
        if (!sources.has(dep) || state.get(dep) === "done") continue;
        if (state.get(dep) === "visiting") {
          // A cycle: every formula on it is circular.
          const cycleStart = stack.findIndex((f) => f.name === dep);
          const cycle = stack.slice(cycleStart).map((f) => f.name);
          for (const n of cycle) {
            if (!own.has(n)) own.set(n, new BaseEvaluationError(`Formula '${n}' refers to itself (circular formulas: ${[...cycle, dep].join(" → ")}).`));
          }
          continue;
        }
        state.set(dep, "visiting");
        stack.push({ name: dep, deps: depsOf(dep), i: 0 });
        continue;
      }
      stack.pop();
      finish(top.name);
    }
  }

  return {
    node: (name) => nodes.get(name),
    problem: (name) =>
      sources.has(name)
        ? (problems.get(name) ?? null)
        : new BaseEvaluationError(`Formula '${name}' is not defined in the base's \`formulas:\` section.`),
  };
}

function prefixError(err: Error, where: string): Error {
  const msg = `In ${where}: ${err.message}`;
  if (err instanceof UnsupportedConstructError) return new UnsupportedConstructError(msg);
  if (err instanceof ResourceLimitError) return new ResourceLimitError(msg);
  return new BaseEvaluationError(msg);
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/** Every file in the vault — a base isn't limited to notes. */
function collectEntries(app: App): BaseEntry[] {
  const vault = app.vault as App["vault"] & { getFiles?: () => TFile[] };
  const files = typeof vault.getFiles === "function" ? vault.getFiles() : app.vault.getMarkdownFiles();
  const typeOf = propertyTypes(app);
  return files.map((f) => buildEntry(app, f, typeOf));
}

/**
 * The type Obsidian assigned to a property (Settings → Properties), via the
 * undocumented `app.metadataTypeManager`. Null when unknown.
 */
function propertyTypes(app: App): (name: string) => string | null {
  const mtm = (app as App & {
    metadataTypeManager?: {
      getAssignedType?: (name: string) => unknown;
      types?: Record<string, { type?: unknown } | undefined>;
      properties?: Record<string, { type?: unknown } | undefined>;
    };
  }).metadataTypeManager;
  if (!mtm) return () => null;
  const cache = new Map<string, string | null>();
  return (name) => {
    const key = name.toLowerCase();
    if (cache.has(key)) return cache.get(key)!;
    let type: string | null = null;
    try {
      const assigned = typeof mtm.getAssignedType === "function" ? mtm.getAssignedType(name) : undefined;
      if (typeof assigned === "string") type = assigned;
      else {
        const t = (mtm.types && Object.prototype.hasOwnProperty.call(mtm.types, key) ? mtm.types[key]?.type : undefined) ??
          (mtm.properties && Object.prototype.hasOwnProperty.call(mtm.properties, key) ? mtm.properties[key]?.type : undefined);
        if (typeof t === "string") type = t;
      }
    } catch {
      type = null;
    }
    cache.set(key, type);
    return type;
  };
}

function buildEntry(app: App, file: TFile, typeOf: (name: string) => string | null): BaseEntry {
  const isMd = file.extension === "md";
  const cache = (isMd ? app.metadataCache.getFileCache(file) : null) as
    | (CachedMetadata & { frontmatterLinks?: Array<{ link: string }> })
    | null;
  const note: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cache?.frontmatter ?? {})) {
    note[k] = typedValue(v, typeOf(k));
  }
  const tags = cache ? unique(getAllTags(cache) ?? []) : [];
  const links = unique([...(cache?.links ?? []), ...(cache?.frontmatterLinks ?? [])].map((l) => l.link));
  const embeds = unique((cache?.embeds ?? []).map((l) => l.link));
  const name = (file as TFile & { name?: string }).name ?? `${file.basename}.${file.extension}`;
  return {
    file: {
      name,
      basename: file.basename,
      path: file.path,
      // Obsidian's root folder path is "/".
      folder: file.parent?.path ?? "/",
      ext: file.extension,
      size: file.stat.size,
      mtime: file.stat.mtime,
      ctime: file.stat.ctime,
      tags,
      links,
      embeds,
    },
    note,
  };
}

/** Date / datetime-typed properties become dates, as Bases sees them. */
function typedValue(v: unknown, type: string | null): unknown {
  if ((type === "date" || type === "datetime") && typeof v === "string") {
    const d = asDate(v);
    if (!d) return v;
    if (type === "date") {
      const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      return markDateOnly(day);
    }
    return new Date(d.getTime());
  }
  return v;
}

function unique<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function linkResolver(app: App): LinkResolver {
  const mc = app.metadataCache as App["metadataCache"] & {
    resolvedLinks?: Record<string, Record<string, number>>;
  };
  let reverse: Map<string, string[]> | null = null;
  return {
    resolve(linkpath, sourcePath) {
      const f = typeof mc.getFirstLinkpathDest === "function" ? mc.getFirstLinkpathDest(linkpath, sourcePath) : null;
      return f ? f.path : null;
    },
    linksTo(sourcePath, targetPath) {
      const out = mc.resolvedLinks && Object.prototype.hasOwnProperty.call(mc.resolvedLinks, sourcePath) ? mc.resolvedLinks[sourcePath] : undefined;
      return !!out && Object.prototype.hasOwnProperty.call(out, targetPath) && (out[targetPath] ?? 0) > 0;
    },
    backlinks(targetPath) {
      if (reverse === null) {
        reverse = new Map();
        for (const [src, targets] of Object.entries(mc.resolvedLinks ?? {})) {
          for (const t of Object.keys(targets)) {
            const list = reverse.get(t) ?? [];
            list.push(src);
            reverse.set(t, list);
          }
        }
      }
      return (reverse.get(targetPath) ?? []).slice();
    },
  };
}

// ---------------------------------------------------------------------------
// Per-entry context and property ids
// ---------------------------------------------------------------------------

function makeContext(
  entry: BaseEntry,
  formulas: CompiledFormulas,
  links: LinkResolver,
  now: Date,
  warn: (msg: string) => void,
  tick: () => void,
): EvalContext {
  const memo = new Map<string, unknown>();
  const active = new Set<string>();
  const ctx: EvalContext = {
    entry,
    links,
    now,
    warn,
    tick,
    formula(name) {
      if (memo.has(name)) return memo.get(name);
      const problem = formulas.problem(name);
      if (problem) throw problem;
      if (active.has(name)) throw new BaseEvaluationError(`Formula '${name}' refers to itself (circular formulas).`);
      active.add(name);
      try {
        const value = evaluate(formulas.node(name)!, ctx);
        memo.set(name, value);
        return value;
      } finally {
        active.delete(name);
      }
    },
  };
  return ctx;
}

function isKnownPropertyId(id: string): boolean {
  return !id.startsWith("file.") || FILE_FIELDS.has(id.slice(5));
}

function checkPropertyId(id: string, where: string): void {
  if (!isKnownPropertyId(id)) {
    throw new UnsupportedConstructError(`Unsupported construct: unknown file property '${id}' in ${where}.`);
  }
}

/**
 * Value of a property id as used in `order`, `sort` and `groupBy`:
 * `file.<field>`, `formula.<name>`, `note.<name>`, a bare note property
 * name (which may contain spaces), or legacy `frontmatter.<name>` /
 * `a.b.c` dot paths into nested frontmatter.
 */
export function propertyValue(id: string, ctx: EvalContext): unknown {
  if (id.startsWith("file.")) return fileField(ctx.entry, id.slice(5), ctx);
  if (id.startsWith("formula.")) return ctx.formula(id.slice(8));
  let name = id;
  if (id.startsWith("note.")) name = id.slice(5);
  else if (id.startsWith("frontmatter.")) name = id.slice(12);
  const note = ctx.entry.note;
  if (Object.prototype.hasOwnProperty.call(note, name)) return note[name] ?? null;
  // Nested dot path (`author.name`).
  let cur: unknown = note;
  for (const seg of name.split(".")) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur) || cur instanceof Date) return null;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return null;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur === undefined ? null : cur;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** A filter tree compiled once from YAML; `null` means "no condition". */
type Filter =
  | null
  | { k: "expr"; node: Node }
  | { k: "and" | "or" | "not"; items: Filter[] }
  | { k: "legacy"; path: string; op: string; value: unknown };

const GROUP_KEYS = ["and", "or", "not"] as const;
const LEGACY_OPS = new Set(["==", "!=", ">", ">=", "<", "<="]);

function isScalar(v: unknown): boolean {
  return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/**
 * Compile a `filters:` tree. Rejects cyclic YAML (a recursive anchor), trees
 * too big or deep to evaluate, and keys that aren't `and` / `or` / `not` or
 * the legacy `{property: value}` shorthand.
 *
 * An empty group (`and: []`, `not:` with nothing under it) is "no
 * condition", which holds for every file, in place: inside `and` it changes
 * nothing, inside `or` it makes the `or` hold, inside `not` it excludes
 * nothing, and at the top level it means no filter. `null` stands for it.
 */
function compileFilter(raw: unknown, where: string, warn: (msg: string) => void): Filter {
  let count = 0;
  const onPath = new Set<object>();
  const walk = (node: unknown, depth: number): Filter => {
    if (++count > MAX_FILTER_NODES) {
      throw new ResourceLimitError(`\`${where}\` has more than ${MAX_FILTER_NODES.toLocaleString("en")} conditions (counting YAML aliases).`);
    }
    if (depth > MAX_FILTER_DEPTH) {
      throw new ResourceLimitError(`\`${where}\` nests and/or/not groups more than ${MAX_FILTER_DEPTH} deep.`);
    }
    if (node === null || node === undefined) return null;
    if (typeof node === "boolean") return node ? null : { k: "expr", node: parseExpression("false") };
    if (typeof node === "string") return node.trim() === "" ? null : { k: "expr", node: parseExpression(node) };
    if (typeof node === "number") return { k: "expr", node: parseExpression(String(node)) };
    if (typeof node !== "object") throw new BaseEvaluationError(`Invalid filter in \`${where}\`: ${JSON.stringify(node)}.`);
    if (onPath.has(node)) throw new BaseEvaluationError(`\`${where}\` refers to itself (a recursive YAML anchor).`);
    onPath.add(node);
    try {
      if (Array.isArray(node)) return group("and", node, depth);
      const obj = node as Record<string, unknown>;
      const keys = Object.keys(obj);
      const groupKeys = keys.filter((k) => (GROUP_KEYS as readonly string[]).includes(k));
      if (groupKeys.length > 1) {
        throw new BaseEvaluationError(`A filter group in \`${where}\` can use only one of and / or / not (found ${groupKeys.join(", ")}).`);
      }
      if (groupKeys.length === 1) {
        const key = groupKeys[0] as "and" | "or" | "not";
        for (const extra of keys) if (extra !== key) warn(`Ignored unknown key '${extra}' in a filter group in \`${where}\`.`);
        const v = obj[key];
        const items = v === null || v === undefined ? [] : Array.isArray(v) ? v : [v];
        return group(key, items, depth);
      }
      if (keys.length === 0) return null;
      // Legacy shorthand: `{status: reading}` / `{rating: {">=": 4}}`.
      const legacy: Filter[] = [];
      for (const key of keys) {
        const v = obj[key];
        if (typeof v === "string" && looksLikeExpression(v)) {
          // `nor: 'status == 5'` is a misspelt group, not "nor equals ...".
          throw unknownKey(key, where);
        }
        if (isScalar(v)) {
          legacy.push({ k: "legacy", path: key, op: "==", value: v });
          continue;
        }
        if (v && typeof v === "object" && !Array.isArray(v)) {
          const entries = Object.entries(v as Record<string, unknown>);
          if (entries.length === 1 && LEGACY_OPS.has(entries[0]![0]) && isScalar(entries[0]![1])) {
            legacy.push({ k: "legacy", path: key, op: entries[0]![0], value: entries[0]![1] });
            continue;
          }
        }
        throw unknownKey(key, where);
      }
      return legacy.length === 1 ? legacy[0]! : { k: "and", items: legacy };
    } finally {
      onPath.delete(node);
    }
  };
  const group = (k: "and" | "or" | "not", items: unknown[], depth: number): Filter => {
    const compiled = items.map((n) => walk(n, depth + 1));
    // `or` with a member that holds for every file holds for every file.
    if (k === "or" && compiled.some((f) => f === null)) return null;
    const conditions = compiled.filter((f) => f !== null);
    return conditions.length === 0 ? null : { k, items: conditions };
  };
  return walk(raw, 0);
}

function unknownKey(key: string, where: string): BaseEvaluationError {
  return new BaseEvaluationError(
    `Unknown filter key '${key}' in \`${where}\`. A filter is an expression string or a group using and, or, or not (lower case).`,
  );
}

/** A value that reads as an expression rather than a property value. */
function looksLikeExpression(v: string): boolean {
  return /==|!=|>=|<=|[<>]|&&|\|\||\(/.test(v) || /^\s*!?\s*(file|note|formula|frontmatter)\./.test(v);
}

function filterFormulaRefs(f: Filter, out: Set<string>): void {
  if (f === null) return;
  if (f.k === "expr") formulaRefs(f.node, out);
  else if (f.k === "legacy") {
    if (f.path.startsWith("formula.")) out.add(f.path.slice(8));
  } else f.items.forEach((i) => filterFormulaRefs(i, out));
}

/**
 * `not` excludes a file if ANY listed condition holds ("None of the
 * following are true"); `null` (no condition) keeps every file.
 */
function evalFilter(f: Filter, ctx: EvalContext): boolean {
  if (f === null) return true;
  switch (f.k) {
    case "expr":
      return truthy(evaluate(f.node, ctx));
    case "and":
      return f.items.every((i) => evalFilter(i, ctx));
    case "or":
      return f.items.some((i) => evalFilter(i, ctx));
    case "not":
      return !f.items.some((i) => evalFilter(i, ctx));
    case "legacy": {
      const lhs = propertyValue(f.path, ctx);
      if (f.op === "==") return equals(lhs, f.value);
      if (f.op === "!=") return !equals(lhs, f.value);
      const c = compareValues(lhs, f.value);
      if (c === null) return false;
      return f.op === ">" ? c > 0 : f.op === ">=" ? c >= 0 : f.op === "<" ? c < 0 : c <= 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Sort and group
// ---------------------------------------------------------------------------

interface SortKey {
  property: string;
  dir: 1 | -1;
}

function direction(raw: unknown): 1 | -1 {
  return typeof raw === "string" && /^desc/i.test(raw) ? -1 : 1;
}

function readSort(raw: unknown): SortKey[] {
  if (raw === undefined || raw === null) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  const keys: SortKey[] = [];
  for (const item of items) {
    if (typeof item === "string" && item !== "") keys.push({ property: item, dir: 1 });
    else if (item && typeof item === "object") {
      const o = item as { property?: unknown; column?: unknown; direction?: unknown };
      const property = typeof o.property === "string" ? o.property : typeof o.column === "string" ? o.column : null;
      if (property === null) throw new BaseEvaluationError(`\`sort:\` item ${JSON.stringify(item)} has no \`property\`.`);
      keys.push({ property, dir: direction(o.direction) });
    } else {
      throw new BaseEvaluationError(`Invalid \`sort:\` item: ${JSON.stringify(item)}.`);
    }
  }
  return keys;
}

function readGroupBy(raw: unknown): SortKey | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "string") return { property: raw, dir: 1 };
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as { property?: unknown; direction?: unknown };
    if (typeof o.property !== "string" || o.property === "") {
      throw new BaseEvaluationError("`groupBy:` needs a `property`.");
    }
    return { property: o.property, dir: direction(o.direction) };
  }
  throw new BaseEvaluationError("`groupBy:` must be {property, direction}.");
}

/** Empty values (missing, "", []) all fall in the "no value" group. */
function normaliseGroupValue(v: unknown): unknown {
  return isEmptyValue(v) ? null : v;
}

function kind(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (v instanceof Date) return "date";
  if (Array.isArray(v)) return "list";
  return typeof v;
}

/** Groups match on type and value: `5` and `"5"` are different groups. */
function sameGroup(a: unknown, b: unknown): boolean {
  return kind(a) === kind(b) && (kind(a) === "null" || equals(a, b));
}

/** Missing values sort last in either direction. */
function compareSortValues(a: unknown, b: unknown, dir: 1 | -1): number {
  const aEmpty = isEmptyValue(a);
  const bEmpty = isEmptyValue(b);
  if (aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1;
  let c = compareValues(a, b);
  if (c === null) {
    c = toText(a).localeCompare(toText(b));
  } else if (typeof a === "string" && typeof b === "string" && !asDate(a)) {
    c = a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }) || c;
  }
  return Math.sign(c) * dir;
}

function sortContexts(list: EvalContext[], keys: SortKey[], tick: () => void): EvalContext[] {
  if (keys.length === 0) return list;
  const decorated = list.map((ctx, i) => {
    tick();
    return { ctx, i, values: keys.map((k) => propertyValue(k.property, ctx)) };
  });
  decorated.sort((a, b) => {
    for (let k = 0; k < keys.length; k++) {
      const c = compareSortValues(a.values[k], b.values[k], keys[k]!.dir);
      if (c !== 0) return c;
    }
    return a.i - b.i;
  });
  return decorated.map((d) => d.ctx);
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

interface Column {
  id: string;
  key: string;
}

function readColumns(raw: unknown): Column[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new BaseEvaluationError("`order:` must be a list of property ids.");
  const out: Column[] = [];
  for (const col of raw) {
    if (typeof col === "string") out.push({ id: col, key: columnKey(col) });
    else if (col && typeof col === "object") {
      // Legacy `{column, as}`.
      const o = col as { column?: unknown; property?: unknown; as?: unknown };
      const id = typeof o.property === "string" ? o.property : typeof o.column === "string" ? o.column : null;
      if (id === null) throw new BaseEvaluationError(`Invalid column: ${JSON.stringify(col)}.`);
      out.push({ id, key: typeof o.as === "string" ? o.as : columnKey(id) });
    } else {
      throw new BaseEvaluationError(`Invalid column: ${JSON.stringify(col)}.`);
    }
  }
  return out;
}

/**
 * Row key for a property id: note properties drop their `note.` /
 * `frontmatter.` prefix (`note.status` → `status`); `file.*` and
 * `formula.*` keep theirs. A note property literally named `file` keeps
 * `note.file` so it can't overwrite the row's `file` object.
 */
function columnKey(id: string): string {
  let key = id;
  if (id.startsWith("note.")) key = id.slice(5);
  else if (id.startsWith("frontmatter.")) key = id.slice(12);
  return key === "file" ? "note.file" : key;
}

function projectRow(ctx: EvalContext, columns: Column[], formulas: CompiledFormulas, warn: (msg: string) => void): BaseRow {
  const f = ctx.entry.file;
  const row: BaseRow = { file: { name: f.name, basename: f.basename, path: f.path } };
  for (const col of columns) {
    // Statically broken columns were reported once already.
    if (!isKnownPropertyId(col.id) || (col.id.startsWith("formula.") && formulas.problem(col.id.slice(8)))) {
      row[col.key] = null;
      continue;
    }
    try {
      row[col.key] = toOutput(propertyValue(col.id, ctx));
    } catch (err) {
      if (err instanceof ResourceLimitError) throw err;
      if (!(err instanceof UnsupportedConstructError) && !(err instanceof BaseEvaluationError)) throw err;
      row[col.key] = null;
      warn(`${col.id}: ${err.message}`);
    }
  }
  return row;
}

/**
 * JSON-safe output value. Date-only values → local `YYYY-MM-DD`; dates with
 * a time → ISO 8601; files → paths; durations → milliseconds.
 */
export function toOutput(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return isDateOnly(v) ? formatLocalDate(v) : v.toISOString();
  }
  if (v instanceof FileRef) return v.entry.file.path;
  if (v instanceof Duration) return v.ms;
  if (Array.isArray(v)) return v.map(toOutput);
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = toOutput(val);
    return out;
  }
  return String(v);
}
