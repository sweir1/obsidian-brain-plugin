import type { App, TFile } from "obsidian";
import { parseYaml } from "obsidian";

/**
 * Path B evaluator for Obsidian Bases `.base` YAML files.
 *
 * Obsidian 1.12.x exposes `BasesEntry` / `BasesQueryResult` / `BasesView` types
 * and `Plugin.registerBasesView()` — a view-factory hook only. There is NO
 * public API to execute a bases query headlessly (no `app.bases.runQuery(...)`).
 * The forum request to expose `app.bases.getViewFiles()` opened 2026-01-31 is
 * still unacknowledged as of 2026-04-22. So until upstream exposes a read path,
 * we own YAML parsing + a whitelisted expression subset.
 *
 * The v1.4.0 subset is INTENTIONALLY NARROW — it's the common case (tree ops
 * + comparisons + file props + frontmatter access). Arithmetic, functions,
 * method calls other than hasTag/inFolder, regex, formulas/summaries are all
 * rejected with a clear `UnsupportedConstructError` so callers see exactly
 * what needs to ship in v1.4.1+.
 */

export class UnsupportedConstructError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedConstructError";
  }
}

export class BaseEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BaseEvaluationError";
  }
}

export interface BaseEntry {
  file: {
    name: string;
    path: string;
    folder: string;
    ext: string;
    size: number;
    mtime: number;
    ctime: number;
    tags: string[];
  };
  frontmatter: Record<string, unknown>;
}

interface BaseDocument {
  filters?: unknown;
  views?: Record<string, ViewDefinition>;
  formulas?: unknown;
  summaries?: unknown;
}

interface ViewDefinition {
  filters?: unknown;
  sort?: unknown;
  limit?: unknown;
  columns?: unknown;
  type?: unknown;
}

export interface BaseRow {
  [column: string]: unknown;
}

export interface EvaluateOptions {
  yaml: string;
  view: string;
}

export interface EvaluateResult {
  rows: BaseRow[];
  total: number;
}

const SUPPORTED_CONSTRUCTS =
  "[and/or/not, ==/!=/>/>=/</<=, &&/||/!, file.{name,path,folder,ext,size,mtime,ctime,tags}, file.hasTag(\"x\"), file.inFolder(\"x\"), frontmatter.X, bare X, nested X.sub.leaf]";

const COMPARISON_OPS = new Set(["==", "!=", ">", ">=", "<", "<="]);

/**
 * Top-level entry point: parse `.base` YAML, build entries from the vault,
 * filter + sort + limit + project, return rows + total (pre-limit count).
 */
export function evaluateBase(
  app: App,
  opts: EvaluateOptions,
): EvaluateResult {
  const parsed = parseYaml(opts.yaml) as BaseDocument | null | undefined;
  if (!parsed || typeof parsed !== "object") {
    throw new BaseEvaluationError(
      "Parsed `.base` YAML is empty or not an object.",
    );
  }

  if ("formulas" in parsed && parsed.formulas !== undefined) {
    throw new UnsupportedConstructError(
      `Unsupported construct: 'formulas:' block at top level. Supported v1.4.0 constructs: ${SUPPORTED_CONSTRUCTS}. Formulas ship in v1.4.2.`,
    );
  }
  if ("summaries" in parsed && parsed.summaries !== undefined) {
    throw new UnsupportedConstructError(
      `Unsupported construct: 'summaries:' block at top level. Supported v1.4.0 constructs: ${SUPPORTED_CONSTRUCTS}. Summaries ship in v1.4.3.`,
    );
  }

  const views = parsed.views;
  if (!views || typeof views !== "object") {
    throw new BaseEvaluationError(
      "`.base` must contain a `views:` map with at least one named view.",
    );
  }
  const viewDef = (views as Record<string, ViewDefinition>)[opts.view];
  if (!viewDef || typeof viewDef !== "object") {
    throw new BaseEvaluationError(
      `View '${opts.view}' not found in .base file. Available views: ${Object.keys(
        views,
      ).join(", ") || "(none)"}.`,
    );
  }

  const entries = collectEntries(app);

  const topFilter = parsed.filters;
  const viewFilter = viewDef.filters;
  let filtered = entries;
  if (topFilter !== undefined) {
    filtered = filtered.filter((e) => evalFilter(topFilter, e));
  }
  if (viewFilter !== undefined) {
    filtered = filtered.filter((e) => evalFilter(viewFilter, e));
  }

  if (viewDef.sort !== undefined) {
    filtered = applySort(filtered, viewDef.sort);
  }

  const total = filtered.length;

  if (viewDef.limit !== undefined) {
    const n = Number(viewDef.limit);
    if (Number.isFinite(n) && n >= 0) {
      filtered = filtered.slice(0, Math.floor(n));
    }
  }

  const columns = viewDef.columns;
  const rows = filtered.map((entry) => projectRow(entry, columns));
  return { rows, total };
}

function collectEntries(app: App): BaseEntry[] {
  const files = app.vault.getMarkdownFiles();
  const entries: BaseEntry[] = [];
  for (const f of files) {
    entries.push(buildEntry(app, f));
  }
  return entries;
}

function buildEntry(app: App, file: TFile): BaseEntry {
  const cache = app.metadataCache.getFileCache(file);
  const frontmatter = cache?.frontmatter
    ? stripPosition(cache.frontmatter)
    : {};
  const cacheTags = cache?.tags?.map((t) => t.tag) ?? [];
  const fmTags = extractFmTags(frontmatter);
  const tags = unique([...cacheTags, ...fmTags]);
  const parentPath = file.parent?.path ?? "";
  return {
    file: {
      name: file.basename,
      path: file.path,
      folder: parentPath === "/" ? "" : parentPath,
      ext: file.extension,
      size: file.stat.size,
      mtime: file.stat.mtime,
      ctime: file.stat.ctime,
      tags,
    },
    frontmatter,
  };
}

function stripPosition(fm: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (k === "position") continue;
    out[k] = v;
  }
  return out;
}

function extractFmTags(fm: Record<string, unknown>): string[] {
  const raw = (fm as { tags?: unknown; tag?: unknown }).tags ??
    (fm as { tag?: unknown }).tag;
  if (raw === undefined || raw === null) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const t of arr) {
    if (typeof t !== "string") continue;
    out.push(t.startsWith("#") ? t : `#${t}`);
  }
  return out;
}

function unique<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

/**
 * Evaluate a filter node against one entry.
 *
 * Supported filter shapes:
 *   - Tree op object: `{and: [...]}`, `{or: [...]}`, `{not: {...}}`.
 *   - Comparison object on a path: `{fm.rating: {">=": 4}}` — the single key
 *     is the left-hand path (file.name, frontmatter.x, bare x). The value is
 *     a single-key comparison map.
 *   - Leaf expression string: `file.hasTag("book")`, `file.inFolder("x")`,
 *     `foo && bar`, `!foo`, `a == "x"`, `a.b != null`.
 */
function evalFilter(node: unknown, entry: BaseEntry): boolean {
  if (node === null || node === undefined) return true;
  if (typeof node === "boolean") return node;
  if (typeof node === "string") return Boolean(evalLeafExpr(node, entry));

  if (Array.isArray(node)) {
    // A bare array at this level is ambiguous — Bases uses object keys for
    // tree ops. Reject to keep the contract clean.
    throw new UnsupportedConstructError(
      `Unsupported construct: raw array in filter context. Use '{and: [...]}' or '{or: [...]}' explicitly. Supported v1.4.0 constructs: ${SUPPORTED_CONSTRUCTS}.`,
    );
  }

  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return true;

    // Tree-op keys may coexist with siblings? Bases' own schema treats a
    // filter object with an `and` key as the tree op — we do the same.
    if ("and" in obj) {
      const list = obj["and"];
      if (!Array.isArray(list)) {
        throw new BaseEvaluationError(
          "`and:` must be a list of filter nodes.",
        );
      }
      for (const item of list) {
        if (!evalFilter(item, entry)) return false;
      }
      return true;
    }
    if ("or" in obj) {
      const list = obj["or"];
      if (!Array.isArray(list)) {
        throw new BaseEvaluationError(
          "`or:` must be a list of filter nodes.",
        );
      }
      for (const item of list) {
        if (evalFilter(item, entry)) return true;
      }
      return false;
    }
    if ("not" in obj) {
      return !evalFilter(obj["not"], entry);
    }

    // Otherwise treat each key as a path → comparison map (AND them).
    for (const path of keys) {
      const rhs = obj[path];
      if (!evalPathComparison(path, rhs, entry)) return false;
    }
    return true;
  }

  throw new UnsupportedConstructError(
    `Unsupported construct: filter value of type '${typeof node}'. Supported v1.4.0 constructs: ${SUPPORTED_CONSTRUCTS}.`,
  );
}

function evalPathComparison(
  path: string,
  rhs: unknown,
  entry: BaseEntry,
): boolean {
  if (rhs !== null && typeof rhs === "object" && !Array.isArray(rhs)) {
    const cmpObj = rhs as Record<string, unknown>;
    const cmpKeys = Object.keys(cmpObj);
    if (cmpKeys.length !== 1 || !COMPARISON_OPS.has(cmpKeys[0]!)) {
      throw new UnsupportedConstructError(
        `Unsupported construct: comparison value '${JSON.stringify(rhs)}' on path '${path}'. Supported v1.4.0 constructs: ${SUPPORTED_CONSTRUCTS}.`,
      );
    }
    const op = cmpKeys[0]!;
    const lhs = resolvePath(path, entry);
    return compare(lhs, op, cmpObj[op]);
  }
  // Shorthand: `status: reading` is `status == reading`.
  const lhs = resolvePath(path, entry);
  return compare(lhs, "==", rhs);
}

function compare(lhs: unknown, op: string, rhs: unknown): boolean {
  switch (op) {
    case "==":
      return equals(lhs, rhs);
    case "!=":
      return !equals(lhs, rhs);
    case ">":
      return cmpOrder(lhs, rhs) > 0;
    case ">=":
      return cmpOrder(lhs, rhs) >= 0;
    case "<":
      return cmpOrder(lhs, rhs) < 0;
    case "<=":
      return cmpOrder(lhs, rhs) <= 0;
    default:
      throw new UnsupportedConstructError(
        `Unsupported construct: comparison operator '${op}'. Supported v1.4.0 constructs: ${SUPPORTED_CONSTRUCTS}.`,
      );
  }
}

function equals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number")
    return Number.isNaN(a) && Number.isNaN(b) ? false : a === b;
  if (
    (typeof a === "string" || typeof a === "number" || typeof a === "boolean") &&
    (typeof b === "string" || typeof b === "number" || typeof b === "boolean")
  ) {
    return String(a) === String(b);
  }
  return false;
}

function cmpOrder(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  const as = String(a ?? "");
  const bs = String(b ?? "");
  if (as < bs) return -1;
  if (as > bs) return 1;
  return 0;
}

/**
 * Resolve a dot-path against an entry. Supports:
 *   - file.name, file.path, file.folder, file.ext, file.size, file.mtime, file.ctime, file.tags
 *   - frontmatter.key, frontmatter.key.nested
 *   - bare key (defaults to frontmatter.key)
 */
export function resolvePath(path: string, entry: BaseEntry): unknown {
  if (!path || typeof path !== "string") return undefined;
  const segments = path.split(".");
  let base: unknown;
  if (segments[0] === "file") {
    base = entry.file;
    segments.shift();
  } else if (segments[0] === "frontmatter") {
    base = entry.frontmatter;
    segments.shift();
  } else {
    base = entry.frontmatter;
  }
  let cur: unknown = base;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * Evaluate a leaf expression string. Whitelist grammar:
 *
 *   expr     := or
 *   or       := and ("||" and)*
 *   and      := not ("&&" not)*
 *   not      := "!" atom | atom
 *   atom     := comparison | call | path
 *   call     := "file.hasTag" "(" STRING ")" | "file.inFolder" "(" STRING ")"
 *   comparison := path OP literal    // OP ∈ ==, !=, >, >=, <, <=
 *   path     := IDENT ("." IDENT)*
 *   literal  := STRING | NUMBER | "true" | "false" | "null"
 *
 * Anything outside this grammar — arithmetic, other method calls, function
 * calls, regex — throws `UnsupportedConstructError` naming the fragment.
 */
export function evalLeafExpr(src: string, entry: BaseEntry): unknown {
  rejectForbiddenFragments(src);
  const tokens = tokenize(src);
  const parser = { tokens, pos: 0 };
  const value = parseOr(parser, src, entry);
  if (parser.pos < parser.tokens.length) {
    const tok = parser.tokens[parser.pos]!;
    throw new UnsupportedConstructError(
      `Unsupported construct: trailing token '${tok.raw}' in '${src}'. Supported v1.4.0 constructs: ${SUPPORTED_CONSTRUCTS}.`,
    );
  }
  return value;
}

function rejectForbiddenFragments(src: string): void {
  // Arithmetic operators — catch before tokenising so the message has context.
  const arithMatch = src.match(/(?:^|[^=!<>])([+\-*/%])(?!=)/);
  if (arithMatch) {
    const op = arithMatch[1]!;
    throw new UnsupportedConstructError(
      `Unsupported construct: arithmetic '${op}' in '${src}'. Supported v1.4.0 constructs: ${SUPPORTED_CONSTRUCTS}. Arithmetic ships in v1.4.1.`,
    );
  }
  // Regex literal — /.../flags with .matches(...) tail etc.
  if (/\/[^/\n]*\/[gimsy]*\b/.test(src)) {
    throw new UnsupportedConstructError(
      `Unsupported construct: regex literal in '${src}'. Supported v1.4.0 constructs: ${SUPPORTED_CONSTRUCTS}. Regex ships in a later v1.4.x patch.`,
    );
  }
  // `this` context.
  if (/\bthis\b/.test(src)) {
    throw new UnsupportedConstructError(
      `Unsupported construct: 'this' context reference in '${src}'. Supported v1.4.0 constructs: ${SUPPORTED_CONSTRUCTS}.`,
    );
  }
  // Unsupported method calls: any `.foo(` except the two whitelisted ones.
  // We match `.IDENT(` tail patterns and reject unknowns.
  const methodRe = /\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = methodRe.exec(src)) !== null) {
    const name = m[1]!;
    if (name === "hasTag" || name === "inFolder") {
      // Further-restrict: only allowed as `file.hasTag(...)` / `file.inFolder(...)`.
      const before = src.slice(0, m.index);
      if (!/\bfile$/.test(before)) {
        throw new UnsupportedConstructError(
          `Unsupported construct: method call '.${name}(' on a non-'file' receiver in '${src}'. Only 'file.hasTag(...)' and 'file.inFolder(...)' are supported in v1.4.0. Supported v1.4.0 constructs: ${SUPPORTED_CONSTRUCTS}.`,
        );
      }
      continue;
    }
    throw new UnsupportedConstructError(
      `Unsupported construct: method call '.${name}(' in '${src}'. Only 'file.hasTag(...)' and 'file.inFolder(...)' are supported in v1.4.0. Supported v1.4.0 constructs: ${SUPPORTED_CONSTRUCTS}.`,
    );
  }
  // Bare function calls at line start (no `.` before) — today(), now(), etc.
  const callRe = /(?:^|[^.\w])([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let c: RegExpExecArray | null;
  while ((c = callRe.exec(src)) !== null) {
    const name = c[1]!;
    if (name === "file") continue; // part of `file.hasTag(...)`.
    throw new UnsupportedConstructError(
      `Unsupported construct: function call '${name}(' in '${src}'. Supported v1.4.0 constructs: ${SUPPORTED_CONSTRUCTS}. Functions ship in later v1.4.x patches.`,
    );
  }
}

interface Token {
  kind:
    | "ident"
    | "dot"
    | "string"
    | "number"
    | "lparen"
    | "rparen"
    | "op"
    | "and"
    | "or"
    | "not"
    | "keyword";
  raw: string;
  value?: string | number | boolean | null;
}

function tokenize(src: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(") {
      toks.push({ kind: "lparen", raw: ch });
      i++;
      continue;
    }
    if (ch === ")") {
      toks.push({ kind: "rparen", raw: ch });
      i++;
      continue;
    }
    if (ch === "." && /[A-Za-z_]/.test(src[i + 1] ?? "")) {
      toks.push({ kind: "dot", raw: "." });
      i++;
      continue;
    }
    if (ch === "&" && src[i + 1] === "&") {
      toks.push({ kind: "and", raw: "&&" });
      i += 2;
      continue;
    }
    if (ch === "|" && src[i + 1] === "|") {
      toks.push({ kind: "or", raw: "||" });
      i += 2;
      continue;
    }
    if (ch === "!") {
      if (src[i + 1] === "=") {
        toks.push({ kind: "op", raw: "!=" });
        i += 2;
        continue;
      }
      toks.push({ kind: "not", raw: "!" });
      i++;
      continue;
    }
    if (ch === "=" && src[i + 1] === "=") {
      toks.push({ kind: "op", raw: "==" });
      i += 2;
      continue;
    }
    if (ch === ">" || ch === "<") {
      if (src[i + 1] === "=") {
        toks.push({ kind: "op", raw: ch + "=" });
        i += 2;
        continue;
      }
      toks.push({ kind: "op", raw: ch });
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let buf = "";
      while (j < n && src[j] !== quote) {
        if (src[j] === "\\" && j + 1 < n) {
          buf += src[j + 1];
          j += 2;
          continue;
        }
        buf += src[j];
        j++;
      }
      if (j >= n) {
        throw new BaseEvaluationError(
          `Unterminated string literal in expression '${src}'.`,
        );
      }
      toks.push({ kind: "string", raw: src.slice(i, j + 1), value: buf });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "-" && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < n && /[0-9.]/.test(src[j]!)) j++;
      const raw = src.slice(i, j);
      toks.push({ kind: "number", raw, value: Number(raw) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      const raw = src.slice(i, j);
      if (raw === "true" || raw === "false") {
        toks.push({ kind: "keyword", raw, value: raw === "true" });
      } else if (raw === "null") {
        toks.push({ kind: "keyword", raw, value: null });
      } else {
        toks.push({ kind: "ident", raw });
      }
      i = j;
      continue;
    }
    throw new UnsupportedConstructError(
      `Unsupported construct: unexpected character '${ch}' in '${src}'. Supported v1.4.0 constructs: ${SUPPORTED_CONSTRUCTS}.`,
    );
  }
  return toks;
}

interface Parser {
  tokens: Token[];
  pos: number;
}

function peek(p: Parser): Token | undefined {
  return p.tokens[p.pos];
}

function consume(p: Parser): Token | undefined {
  return p.tokens[p.pos++];
}

function parseOr(p: Parser, src: string, entry: BaseEntry): unknown {
  let left = parseAnd(p, src, entry);
  while (peek(p)?.kind === "or") {
    consume(p);
    const right = parseAnd(p, src, entry);
    left = Boolean(left) || Boolean(right);
  }
  return left;
}

function parseAnd(p: Parser, src: string, entry: BaseEntry): unknown {
  let left = parseNot(p, src, entry);
  while (peek(p)?.kind === "and") {
    consume(p);
    const right = parseNot(p, src, entry);
    left = Boolean(left) && Boolean(right);
  }
  return left;
}

function parseNot(p: Parser, src: string, entry: BaseEntry): unknown {
  if (peek(p)?.kind === "not") {
    consume(p);
    return !Boolean(parseNot(p, src, entry));
  }
  return parseAtom(p, src, entry);
}

function parseAtom(p: Parser, src: string, entry: BaseEntry): unknown {
  const tok = peek(p);
  if (!tok) {
    throw new BaseEvaluationError(
      `Unexpected end of expression '${src}'.`,
    );
  }
  if (tok.kind === "lparen") {
    consume(p);
    const v = parseOr(p, src, entry);
    const close = consume(p);
    if (close?.kind !== "rparen") {
      throw new BaseEvaluationError(
        `Expected ')' in expression '${src}'.`,
      );
    }
    return v;
  }
  if (
    tok.kind === "string" ||
    tok.kind === "number" ||
    tok.kind === "keyword"
  ) {
    consume(p);
    return tok.value;
  }
  if (tok.kind === "ident") {
    // Build a path: ident ("." ident)*
    const parts: string[] = [consume(p)!.raw];
    while (peek(p)?.kind === "dot") {
      consume(p);
      const next = consume(p);
      if (next?.kind !== "ident") {
        throw new BaseEvaluationError(
          `Expected identifier after '.' in '${src}'.`,
        );
      }
      parts.push(next.raw);
    }
    // Method call?
    if (peek(p)?.kind === "lparen") {
      consume(p);
      const methodPath = parts.join(".");
      if (methodPath !== "file.hasTag" && methodPath !== "file.inFolder") {
        throw new UnsupportedConstructError(
          `Unsupported construct: method call '${methodPath}(' in '${src}'. Only 'file.hasTag(...)' and 'file.inFolder(...)' are supported in v1.4.0. Supported v1.4.0 constructs: ${SUPPORTED_CONSTRUCTS}.`,
        );
      }
      const argTok = consume(p);
      if (argTok?.kind !== "string") {
        throw new BaseEvaluationError(
          `'${methodPath}' requires a single string argument in '${src}'.`,
        );
      }
      const close = consume(p);
      if (close?.kind !== "rparen") {
        throw new BaseEvaluationError(
          `Expected ')' after '${methodPath}(' in '${src}'.`,
        );
      }
      const arg = String(argTok.value ?? "");
      if (methodPath === "file.hasTag") {
        return hasTag(entry, arg);
      }
      return inFolder(entry, arg);
    }
    // Bare path — could be followed by a comparison op.
    const lhsPath = parts.join(".");
    const opTok = peek(p);
    if (opTok?.kind === "op") {
      consume(p);
      const rhsTok = consume(p);
      let rhs: unknown;
      if (rhsTok?.kind === "string" || rhsTok?.kind === "number" || rhsTok?.kind === "keyword") {
        rhs = rhsTok.value;
      } else if (rhsTok?.kind === "ident") {
        // allow `a == b` where b is treated as a path too
        const rparts = [rhsTok.raw];
        while (peek(p)?.kind === "dot") {
          consume(p);
          const next = consume(p);
          if (next?.kind !== "ident") {
            throw new BaseEvaluationError(
              `Expected identifier after '.' in '${src}'.`,
            );
          }
          rparts.push(next.raw);
        }
        rhs = resolvePath(rparts.join("."), entry);
      } else {
        throw new BaseEvaluationError(
          `Expected literal or path on right side of '${opTok.raw}' in '${src}'.`,
        );
      }
      return compare(resolvePath(lhsPath, entry), opTok.raw, rhs);
    }
    return resolvePath(lhsPath, entry);
  }
  throw new UnsupportedConstructError(
    `Unsupported construct: token '${tok.raw}' in '${src}'. Supported v1.4.0 constructs: ${SUPPORTED_CONSTRUCTS}.`,
  );
}

function hasTag(entry: BaseEntry, tag: string): boolean {
  const normalized = tag.startsWith("#") ? tag : `#${tag}`;
  return entry.file.tags.some((t) => t === normalized || t === tag);
}

function inFolder(entry: BaseEntry, folder: string): boolean {
  const f = folder.replace(/\/$/, "");
  if (f === "") return true;
  return entry.file.folder === f || entry.file.folder.startsWith(f + "/");
}

function applySort(entries: BaseEntry[], sort: unknown): BaseEntry[] {
  if (!Array.isArray(sort)) {
    throw new BaseEvaluationError(
      "`sort:` must be a list of {column, direction} or bare column strings.",
    );
  }
  const keys: Array<{ path: string; dir: 1 | -1 }> = [];
  for (const item of sort) {
    if (typeof item === "string") {
      keys.push({ path: item, dir: 1 });
    } else if (item && typeof item === "object") {
      const o = item as { column?: unknown; direction?: unknown };
      if (typeof o.column !== "string") {
        throw new BaseEvaluationError(
          "`sort:` item is missing a string 'column'.",
        );
      }
      const dir =
        typeof o.direction === "string" && /^desc/i.test(o.direction)
          ? -1
          : 1;
      keys.push({ path: o.column, dir });
    } else {
      throw new BaseEvaluationError(
        `Invalid sort item: ${JSON.stringify(item)}.`,
      );
    }
  }
  const copy = entries.slice();
  copy.sort((a, b) => {
    for (const k of keys) {
      const av = resolvePath(k.path, a);
      const bv = resolvePath(k.path, b);
      const c = cmpOrder(av, bv);
      if (c !== 0) return c * k.dir;
    }
    return 0;
  });
  return copy;
}

function projectRow(entry: BaseEntry, columns: unknown): BaseRow {
  if (columns === undefined || columns === null) {
    // Default projection: basic file fields.
    return {
      file: { name: entry.file.name, path: entry.file.path },
    };
  }
  if (!Array.isArray(columns)) {
    throw new BaseEvaluationError(
      "`columns:` must be a list of column paths or {column, as} objects.",
    );
  }
  const row: BaseRow = {
    file: { name: entry.file.name, path: entry.file.path },
  };
  for (const col of columns) {
    if (typeof col === "string") {
      const key = col.startsWith("frontmatter.") ? col.slice("frontmatter.".length) : col;
      row[key] = toPrimitive(resolvePath(col, entry));
    } else if (col && typeof col === "object") {
      const o = col as { column?: unknown; as?: unknown };
      if (typeof o.column !== "string") {
        throw new BaseEvaluationError(
          "`columns:` item is missing a string 'column'.",
        );
      }
      const alias = typeof o.as === "string" ? o.as : o.column;
      row[alias] = toPrimitive(resolvePath(o.column, entry));
    } else {
      throw new BaseEvaluationError(
        `Invalid column item: ${JSON.stringify(col)}.`,
      );
    }
  }
  return row;
}

function toPrimitive(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  ) {
    return v;
  }
  if (Array.isArray(v)) {
    return v.map((x) => toPrimitive(x));
  }
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = toPrimitive(val);
    }
    return out;
  }
  return String(v);
}
