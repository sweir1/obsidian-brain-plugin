import { moment } from "obsidian";

/**
 * The Obsidian Bases expression language — the strings inside `filters:`
 * and `formulas:` — parsed into an AST and evaluated against one entry.
 *
 * Covers the documented syntax (help.obsidian.md → Bases syntax, Functions):
 * literals, `[a, b]` lists, `note.x` / `note["x"]` / bare `x`, `file.*`,
 * `formula.*`, indexing, arithmetic (incl. date ± duration), comparisons,
 * `&&` `||` `!`, parentheses, the global functions that don't depend on
 * the UI, and the common String / Number / List / Date / File / Object
 * methods.
 *
 * Constructs that can't be evaluated headlessly — `this`, regular
 * expressions, lambdas (`filter`/`map`/`reduce`), links, icons, HTML — are
 * rejected when the expression is parsed, with an
 * {@link UnsupportedConstructError} naming the construct, so the outcome
 * never depends on which files the vault happens to contain. A value of the
 * wrong type for one row (`status.lower()` where one note has `status: 5`)
 * is not a construct problem: that row gets `null` and a warning.
 *
 * Everything runs inside the Obsidian renderer, where a runaway query can't
 * be interrupted and running out of memory kills the app. So expressions
 * have size and nesting limits, results have size caps, and each
 * evaluation has a time budget; all of them fail with a
 * {@link BaseEvaluationError} instead.
 */

/**
 * Obsidian types its bundled Moment as a namespace import, which isn't
 * callable under `esModuleInterop` (forced on since TypeScript 7). At
 * runtime it is the Moment function.
 */
type MomentLike = { format(fmt: string): string; from(other: MomentLike): string };
const callMoment = moment as unknown as (d: Date) => MomentLike;

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

/** A size, nesting or time limit was hit. Always fails the request. */
export class ResourceLimitError extends BaseEvaluationError {
  constructor(message: string) {
    super(message);
    this.name = "ResourceLimitError";
  }
}

// ---- limits ---------------------------------------------------------------

/** Longest expression accepted (characters). */
export const MAX_EXPRESSION_LENGTH = 20_000;
/** Deepest expression tree accepted (nesting, or a long `a + b + c …` chain). */
export const MAX_EXPRESSION_DEPTH = 200;
/** Largest string a function may produce. */
export const MAX_STRING_LENGTH = 1_000_000;
/** Largest list a function may produce. */
export const MAX_LIST_LENGTH = 100_000;
/** Duration strings are short; anything longer isn't one. */
const MAX_DURATION_LENGTH = 100;

/** Throw unless a string of `length` characters is within the cap. */
function checkStringLength(length: number, what: string): void {
  if (length > MAX_STRING_LENGTH) {
    throw new ResourceLimitError(`${what} would produce a string longer than ${MAX_STRING_LENGTH.toLocaleString("en")} characters.`);
  }
}

function checkListLength(n: number, what: string): void {
  if (n > MAX_LIST_LENGTH) {
    throw new ResourceLimitError(`${what} would produce a list longer than ${MAX_LIST_LENGTH.toLocaleString("en")} items.`);
  }
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** The `file` object of one entry. */
export interface FileInfo {
  /** Full file name, e.g. `Dune.md`. */
  name: string;
  /** File name without extension, e.g. `Dune`. */
  basename: string;
  path: string;
  /** Parent folder path; `"/"` for the vault root, as Obsidian reports it. */
  folder: string;
  ext: string;
  size: number;
  ctime: number;
  mtime: number;
  /** Tags as `#tag`, from the body and frontmatter. */
  tags: string[];
  /** Link targets as written (`[[X]]` → `X`), body + frontmatter. */
  links: string[];
  /** Embed targets as written. */
  embeds: string[];
}

export interface BaseEntry {
  file: FileInfo;
  /** Frontmatter (note properties); `{}` for non-markdown files. */
  note: Record<string, unknown>;
}

/** Marker wrapping an entry's `file` object. */
export class FileRef {
  constructor(readonly entry: BaseEntry) {}
}

interface DurationParts {
  y: number;
  M: number;
  w: number;
  d: number;
  h: number;
  m: number;
  s: number;
  ms: number;
}

const DAY = 86_400_000;

/** A length of time, from `date - date` or a duration string. */
export class Duration {
  constructor(readonly parts: DurationParts) {}
  get ms(): number {
    const p = this.parts;
    return p.y * 365 * DAY + p.M * 30 * DAY + p.w * 7 * DAY + p.d * DAY + p.h * 3_600_000 + p.m * 60_000 + p.s * 1_000 + p.ms;
  }
}

/** Dates that carry no time of day (`date("2024-03-01")`, `today()`, date-typed properties). */
const DATE_ONLY = new WeakSet<Date>();

export function markDateOnly(d: Date): Date {
  DATE_ONLY.add(d);
  return d;
}

export function isDateOnly(d: Date): boolean {
  return DATE_ONLY.has(d);
}

/** Own-property lookup, so names like `toString` or `__proto__` never hit Object.prototype. */
function own<T>(obj: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/** Services the evaluator needs from Obsidian for link-aware functions. */
export interface LinkResolver {
  /** Resolve a link path to a vault path, or null. */
  resolve(linkpath: string, sourcePath: string): string | null;
  /** True if `sourcePath` has a resolved link to `targetPath`. */
  linksTo(sourcePath: string, targetPath: string): boolean;
  /** Vault paths of files that link to `targetPath`. */
  backlinks(targetPath: string): string[];
}

export interface EvalContext {
  entry: BaseEntry;
  /** Evaluate `formula.<name>` for this entry. */
  formula(name: string): unknown;
  links: LinkResolver;
  /** Fixed clock for one evaluation, so `now()` is stable across rows. */
  now: Date;
  /** Record a per-row problem (wrong value type); the value becomes null. */
  warn(message: string): void;
  /** Called once per evaluated node; throws when the time budget is spent. */
  tick(): void;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokKind = "num" | "str" | "ident" | "op" | "punc";
interface Token {
  kind: TokKind;
  value: string;
  num?: number;
  pos: number;
}

const OPERATORS = ["==", "!=", ">=", "<=", "&&", "||", ">", "<", "+", "-", "*", "/", "%", "!"];

function tokenize(src: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  const n = src.length;
  const prevEndsOperand = (): boolean => {
    const t = toks[toks.length - 1];
    if (!t) return false;
    return t.kind === "num" || t.kind === "str" || t.kind === "ident" || (t.kind === "punc" && (t.value === ")" || t.value === "]"));
  };
  while (i < n) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let buf = "";
      while (j < n && src[j] !== ch) {
        if (src[j] === "\\" && j + 1 < n) {
          const nx = src[j + 1]!;
          buf += nx === "n" ? "\n" : nx === "t" ? "\t" : nx;
          j += 2;
          continue;
        }
        buf += src[j];
        j++;
      }
      if (j >= n) throw new BaseEvaluationError(`Unterminated string in '${clip(src)}'.`);
      toks.push({ kind: "str", value: buf, pos: i });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i;
      while (j < n && /[0-9_]/.test(src[j]!)) j++;
      if (src[j] === "." && /[0-9]/.test(src[j + 1] ?? "")) {
        j++;
        while (j < n && /[0-9]/.test(src[j]!)) j++;
      }
      const raw = src.slice(i, j).replace(/_/g, "");
      toks.push({ kind: "num", value: raw, num: Number(raw), pos: i });
      i = j;
      continue;
    }
    if (/[\p{L}_$]/u.test(ch)) {
      let j = i + 1;
      while (j < n && /[\p{L}\p{N}_$]/u.test(src[j]!)) j++;
      toks.push({ kind: "ident", value: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if ("()[],.".includes(ch)) {
      toks.push({ kind: "punc", value: ch, pos: i });
      i++;
      continue;
    }
    if (ch === "/" && !prevEndsOperand()) {
      throw new UnsupportedConstructError(
        `Unsupported construct: regular expression in '${clip(src)}'. Regular expressions (and .matches()) can't be evaluated by the companion plugin yet.`,
      );
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op) {
      toks.push({ kind: "op", value: op, pos: i });
      i += op.length;
      continue;
    }
    throw new BaseEvaluationError(`Unexpected character '${ch}' in '${clip(src)}'.`);
  }
  return toks;
}

/** Shorten an expression for an error message. */
function clip(src: string): string {
  return src.length > 200 ? `${src.slice(0, 200)}…` : src;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export type Node =
  | { t: "lit"; v: unknown }
  | { t: "list"; items: Node[] }
  | { t: "ident"; name: string }
  | { t: "member"; obj: Node; name: string }
  | { t: "index"; obj: Node; index: Node }
  | { t: "call"; callee: Node; args: Node[] }
  | { t: "unary"; op: string; arg: Node }
  | { t: "binary"; op: string; left: Node; right: Node };

const BINARY_PRECEDENCE: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  ">": 4,
  ">=": 4,
  "<": 4,
  "<=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
};

class Parser {
  private pos = 0;
  /** Current recursion depth (parentheses, unary chains, nested calls). */
  private depth = 0;
  /** Depth of each node's subtree, so long operator chains are caught too. */
  private readonly heights = new WeakMap<Node, number>();

  constructor(
    private readonly toks: Token[],
    private readonly src: string,
  ) {}

  parse(): Node {
    if (this.toks.length === 0) throw new BaseEvaluationError("Empty expression.");
    const node = this.expr(0);
    const extra = this.toks[this.pos];
    if (extra) throw new BaseEvaluationError(`Unexpected '${extra.value}' in '${clip(this.src)}'.`);
    return node;
  }

  private tooDeep(): ResourceLimitError {
    return new ResourceLimitError(
      `Expression is nested too deeply (more than ${MAX_EXPRESSION_DEPTH} levels): '${clip(this.src)}'.`,
    );
  }

  private enter(): void {
    if (++this.depth > MAX_EXPRESSION_DEPTH) throw this.tooDeep();
  }

  private leave(): void {
    this.depth--;
  }

  /** Record a node's height; reject trees deeper than the limit. */
  private make(node: Node, ...children: Node[]): Node {
    let h = 0;
    for (const c of children) h = Math.max(h, this.heights.get(c) ?? 0);
    if (h + 1 > MAX_EXPRESSION_DEPTH) throw this.tooDeep();
    this.heights.set(node, h + 1);
    return node;
  }

  private peek(): Token | undefined {
    return this.toks[this.pos];
  }

  private next(): Token {
    const t = this.toks[this.pos++];
    if (!t) throw new BaseEvaluationError(`Unexpected end of expression '${clip(this.src)}'.`);
    return t;
  }

  private expect(value: string): void {
    const t = this.next();
    if (t.value !== value || (t.kind !== "punc" && t.kind !== "op")) {
      throw new BaseEvaluationError(`Expected '${value}' but found '${t.value}' in '${clip(this.src)}'.`);
    }
  }

  private expr(minPrec: number): Node {
    this.enter();
    try {
      let left = this.unary();
      for (;;) {
        const t = this.peek();
        if (!t || t.kind !== "op") break;
        const prec = own(BINARY_PRECEDENCE, t.value);
        if (prec === undefined || prec < minPrec) break;
        this.pos++;
        const right = this.expr(prec + 1);
        left = this.make({ t: "binary", op: t.value, left, right }, left, right);
      }
      return left;
    } finally {
      this.leave();
    }
  }

  private unary(): Node {
    const t = this.peek();
    if (t && t.kind === "op" && (t.value === "!" || t.value === "-")) {
      this.pos++;
      this.enter();
      try {
        const arg = this.unary();
        return this.make({ t: "unary", op: t.value, arg }, arg);
      } finally {
        this.leave();
      }
    }
    return this.postfix(this.primary());
  }

  private postfix(node: Node): Node {
    for (;;) {
      const t = this.peek();
      if (!t || t.kind !== "punc") return node;
      if (t.value === ".") {
        this.pos++;
        const name = this.next();
        if (name.kind !== "ident") {
          throw new BaseEvaluationError(`Expected a name after '.' in '${clip(this.src)}'.`);
        }
        node = this.make({ t: "member", obj: node, name: name.value }, node);
      } else if (t.value === "[") {
        this.pos++;
        const index = this.expr(0);
        this.expect("]");
        node = this.make({ t: "index", obj: node, index }, node, index);
      } else if (t.value === "(") {
        this.pos++;
        const args = this.args(")");
        node = this.make({ t: "call", callee: node, args }, node, ...args);
      } else {
        return node;
      }
    }
  }

  private args(close: string): Node[] {
    const out: Node[] = [];
    const t = this.peek();
    if (t && t.kind === "punc" && t.value === close) {
      this.pos++;
      return out;
    }
    for (;;) {
      out.push(this.expr(0));
      const sep = this.next();
      if (sep.kind === "punc" && sep.value === close) return out;
      if (sep.kind !== "punc" || sep.value !== ",") {
        throw new BaseEvaluationError(`Expected ',' or '${close}' in '${clip(this.src)}'.`);
      }
    }
  }

  private primary(): Node {
    const t = this.next();
    if (t.kind === "num") return this.make({ t: "lit", v: t.num });
    if (t.kind === "str") return this.make({ t: "lit", v: t.value });
    if (t.kind === "ident") {
      if (t.value === "true") return this.make({ t: "lit", v: true });
      if (t.value === "false") return this.make({ t: "lit", v: false });
      if (t.value === "null") return this.make({ t: "lit", v: null });
      return this.make({ t: "ident", name: t.value });
    }
    if (t.kind === "punc" && t.value === "(") {
      const inner = this.expr(0);
      this.expect(")");
      return inner;
    }
    if (t.kind === "punc" && t.value === "[") {
      const items = this.args("]");
      return this.make({ t: "list", items }, ...items);
    }
    throw new BaseEvaluationError(`Unexpected '${t.value}' in '${clip(this.src)}'.`);
  }
}

const parseCache = new Map<string, Node>();

/** Parse (and cache) one expression. Also validates function/method names. */
export function parseExpression(src: string): Node {
  const hit = parseCache.get(src);
  if (hit) return hit;
  if (src.length > MAX_EXPRESSION_LENGTH) {
    throw new ResourceLimitError(`Expression is longer than ${MAX_EXPRESSION_LENGTH.toLocaleString("en")} characters.`);
  }
  const node = new Parser(tokenize(src), src).parse();
  validate(node, src);
  if (parseCache.size > 2000) parseCache.clear();
  parseCache.set(src, node);
  return node;
}

// ---------------------------------------------------------------------------
// Static validation: reject unsupported names up front, so a construct that
// only some rows would reach can't make results depend on the vault.
// ---------------------------------------------------------------------------

const GLOBAL_FUNCTIONS = new Set(["if", "list", "number", "min", "max", "date", "now", "today", "duration"]);
const UNSUPPORTED_GLOBALS: Record<string, string> = {
  link: "link() builds a Link object for display",
  file: "file() looks up another file object",
  image: "image() is display-only",
  icon: "icon() is display-only",
  html: "html() is display-only",
  escapeHTML: "escapeHTML() is display-only",
  random: "random() makes results non-deterministic",
};

const METHODS = new Set([
  // any
  "toString", "isTruthy", "isType", "isEmpty",
  // string
  "contains", "containsAll", "containsAny", "startsWith", "endsWith", "lower", "title", "trim",
  "replace", "repeat", "reverse", "slice", "split",
  // number
  "abs", "ceil", "floor", "round", "toFixed",
  // list
  "join", "flat", "unique", "sort",
  // date
  "date", "time", "format", "relative",
  // file
  "hasTag", "inFolder", "hasLink", "hasProperty",
  // object
  "keys", "values",
]);
const UNSUPPORTED_METHODS: Record<string, string> = {
  matches: "regular expressions aren't supported",
  filter: "list lambdas (filter/map/reduce) aren't supported",
  map: "list lambdas (filter/map/reduce) aren't supported",
  reduce: "list lambdas (filter/map/reduce) aren't supported",
  asLink: "Link objects are display-only",
  asFile: "Link objects are display-only",
  linksTo: "Link objects are display-only",
};

/** The `file.<field>` names Bases defines. */
export const FILE_FIELDS = new Set([
  "name", "basename", "path", "folder", "ext", "size", "ctime", "mtime",
  "tags", "links", "embeds", "backlinks", "properties", "file",
]);
const FILE_METHODS = new Set(["hasTag", "inFolder", "hasLink", "hasProperty", "isEmpty", "isTruthy", "isType", "toString"]);

function validate(node: Node, src: string): void {
  switch (node.t) {
    case "lit":
      return;
    case "ident":
      if (node.name === "this") {
        throw new UnsupportedConstructError(
          `Unsupported construct: 'this' in '${clip(src)}'. 'this' depends on where the base is displayed in Obsidian, which doesn't exist for a headless query.`,
        );
      }
      return;
    case "list":
      node.items.forEach((n) => validate(n, src));
      return;
    case "member":
      if (node.obj.t === "ident" && node.obj.name === "file" && !FILE_FIELDS.has(node.name)) {
        throw new UnsupportedConstructError(`Unsupported construct: unknown file property 'file.${node.name}' in '${clip(src)}'.`);
      }
      validate(node.obj, src);
      return;
    case "index":
      validate(node.obj, src);
      validate(node.index, src);
      return;
    case "unary":
      validate(node.arg, src);
      return;
    case "binary":
      validate(node.left, src);
      validate(node.right, src);
      return;
    case "call": {
      node.args.forEach((n) => validate(n, src));
      if (node.callee.t === "ident") {
        const name = node.callee.name;
        const why = own(UNSUPPORTED_GLOBALS, name);
        if (why) {
          throw new UnsupportedConstructError(`Unsupported construct: function '${name}()' in '${clip(src)}' — ${why}.`);
        }
        if (!GLOBAL_FUNCTIONS.has(name)) {
          throw new UnsupportedConstructError(`Unsupported construct: unknown function '${name}()' in '${clip(src)}'.`);
        }
        return;
      }
      if (node.callee.t === "member") {
        const name = node.callee.name;
        const why = own(UNSUPPORTED_METHODS, name);
        if (why) {
          throw new UnsupportedConstructError(`Unsupported construct: method '.${name}()' in '${clip(src)}' — ${why}.`);
        }
        if (!METHODS.has(name)) {
          throw new UnsupportedConstructError(`Unsupported construct: unknown method '.${name}()' in '${clip(src)}'.`);
        }
        const recv = node.callee.obj;
        if (recv.t === "ident" && recv.name === "file") {
          if (!FILE_METHODS.has(name)) {
            throw new UnsupportedConstructError(`Unsupported construct: 'file.${name}()' isn't a file method, in '${clip(src)}'.`);
          }
        } else {
          validate(recv, src);
        }
        return;
      }
      throw new BaseEvaluationError(`Only functions and methods can be called, in '${clip(src)}'.`);
    }
  }
}

/** Names of the formulas an expression reads (`formula.x`, `formula["x"]`). */
export function formulaRefs(node: Node, out: Set<string> = new Set()): Set<string> {
  switch (node.t) {
    case "member":
      if (node.obj.t === "ident" && node.obj.name === "formula") out.add(node.name);
      else formulaRefs(node.obj, out);
      break;
    case "index":
      if (node.obj.t === "ident" && node.obj.name === "formula" && node.index.t === "lit" && typeof node.index.v === "string") {
        out.add(node.index.v);
      } else {
        formulaRefs(node.obj, out);
      }
      formulaRefs(node.index, out);
      break;
    case "list":
      node.items.forEach((n) => formulaRefs(n, out));
      break;
    case "call":
      formulaRefs(node.callee, out);
      node.args.forEach((n) => formulaRefs(n, out));
      break;
    case "unary":
      formulaRefs(node.arg, out);
      break;
    case "binary":
      formulaRefs(node.left, out);
      formulaRefs(node.right, out);
      break;
    default:
      break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Marker objects for the `note` and `formula` namespaces. */
const NOTE_NS = Symbol("note");
const FORMULA_NS = Symbol("formula");

export function evaluate(node: Node, ctx: EvalContext): unknown {
  ctx.tick();
  switch (node.t) {
    case "lit":
      return node.v;
    case "list":
      return node.items.map((n) => evaluate(n, ctx));
    case "ident":
      return identValue(node.name, ctx);
    case "member":
      return member(evaluate(node.obj, ctx), node.name, ctx);
    case "index": {
      const obj = evaluate(node.obj, ctx);
      const idx = evaluate(node.index, ctx);
      if (typeof idx === "string") return member(obj, idx, ctx);
      if (typeof idx === "number" && Array.isArray(obj)) {
        const i = idx < 0 ? obj.length + idx : idx;
        return obj[i] ?? null;
      }
      return null;
    }
    case "unary": {
      const v = evaluate(node.arg, ctx);
      if (node.op === "!") return !truthy(v);
      const num = toNumber(v);
      return num === null ? null : -num;
    }
    case "binary":
      return binary(node, ctx);
    case "call":
      return call(node, ctx);
  }
}

function identValue(name: string, ctx: EvalContext): unknown {
  switch (name) {
    case "file":
      return new FileRef(ctx.entry);
    case "note":
    case "frontmatter":
      return NOTE_NS;
    case "formula":
      return FORMULA_NS;
    default:
      // A bare name is a note property.
      return noteProperty(ctx.entry, name);
  }
}

function noteProperty(entry: BaseEntry, name: string): unknown {
  const v = own(entry.note, name);
  return v === undefined ? null : v;
}

const DATE_FIELDS = new Set(["year", "month", "day", "hour", "minute", "second", "millisecond"]);

function member(obj: unknown, name: string, ctx: EvalContext): unknown {
  if (obj === NOTE_NS) return noteProperty(ctx.entry, name);
  if (obj === FORMULA_NS) return ctx.formula(name);
  if (obj instanceof FileRef) return fileField(obj.entry, name, ctx);
  if (obj === null || obj === undefined) return null;
  if (obj instanceof Date) return dateField(obj, name);
  if (typeof obj === "string") {
    // An untyped date-like property (`due: 2024-03-01`) still has date fields.
    if (DATE_FIELDS.has(name) && isDateString(obj)) return dateField(asDate(obj)!, name);
    return name === "length" ? obj.length : null;
  }
  if (Array.isArray(obj)) return name === "length" ? obj.length : null;
  if (typeof obj === "object" && !(obj instanceof Duration)) {
    const v = own(obj as Record<string, unknown>, name);
    return v === undefined ? null : v;
  }
  return null;
}

export function fileField(entry: BaseEntry, name: string, ctx: Pick<EvalContext, "links">): unknown {
  const f = entry.file;
  switch (name) {
    case "name":
      return f.name;
    case "basename":
      return f.basename;
    case "path":
      return f.path;
    case "folder":
      return f.folder;
    case "ext":
      return f.ext;
    case "size":
      return f.size;
    case "ctime":
      return new Date(f.ctime);
    case "mtime":
      return new Date(f.mtime);
    case "tags":
      return f.tags.slice();
    case "links":
      return f.links.slice();
    case "embeds":
      return f.embeds.slice();
    case "backlinks":
      return ctx.links.backlinks(f.path);
    case "properties":
      return { ...entry.note };
    case "file":
      return new FileRef(entry);
    default:
      throw new UnsupportedConstructError(`Unsupported construct: unknown file property 'file.${name}'.`);
  }
}

function dateField(d: Date, name: string): unknown {
  switch (name) {
    case "year":
      return d.getFullYear();
    case "month":
      return d.getMonth() + 1;
    case "day":
      return d.getDate();
    case "hour":
      return d.getHours();
    case "minute":
      return d.getMinutes();
    case "second":
      return d.getSeconds();
    case "millisecond":
      return d.getMilliseconds();
    default:
      return null;
  }
}

function binary(node: Extract<Node, { t: "binary" }>, ctx: EvalContext): unknown {
  if (node.op === "&&") return truthy(evaluate(node.left, ctx)) && truthy(evaluate(node.right, ctx));
  if (node.op === "||") return truthy(evaluate(node.left, ctx)) || truthy(evaluate(node.right, ctx));
  const a = evaluate(node.left, ctx);
  const b = evaluate(node.right, ctx);
  switch (node.op) {
    case "==":
      return equals(a, b);
    case "!=":
      return !equals(a, b);
    case ">":
    case ">=":
    case "<":
    case "<=": {
      const c = compareValues(a, b);
      if (c === null) return false;
      return node.op === ">" ? c > 0 : node.op === ">=" ? c >= 0 : node.op === "<" ? c < 0 : c <= 0;
    }
    case "+":
      return add(a, b, ctx);
    case "-":
      if (node.left.t === "ident" && node.right.t === "ident") hyphenHint(node.left.name, node.right.name, ctx);
      return subtract(a, b);
    default: {
      const x = toNumber(a);
      const y = toNumber(b);
      if (x === null || y === null) return null;
      const r = node.op === "*" ? x * y : node.op === "/" ? x / y : x % y;
      return Number.isFinite(r) ? r : null;
    }
  }
}

/**
 * `due-date` is `due` minus `date` in Bases syntax. When the note actually
 * has a property called `due-date`, say how to read it instead.
 */
function hyphenHint(left: string, right: string, ctx: EvalContext): void {
  const joined = `${left}-${right}`;
  if (Object.prototype.hasOwnProperty.call(ctx.entry.note, joined)) {
    ctx.warn(`'${joined}' is read as '${left}' minus '${right}'. To read the property '${joined}', write note["${joined}"].`);
  }
}

function add(a: unknown, b: unknown, ctx: EvalContext): unknown {
  if (a === null || b === null) return null;
  const da = asDate(a);
  if (da) {
    const dur = durationOf(b);
    if (dur) return shiftDate(da, dur, 1);
    if (a instanceof Date && typeof b === "number") {
      ctx.warn(`Adding a number to a date is ambiguous; add a duration string such as "${b}d" instead.`);
      return null;
    }
  }
  if (typeof a === "number" && typeof b === "number") return a + b;
  if (typeof a === "string" || typeof b === "string") {
    const x = toText(a);
    const y = toText(b);
    checkStringLength(x.length + y.length, "Joining strings with +");
    return x + y;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    checkListLength(a.length + b.length, "Joining lists with +");
    return [...a, ...b];
  }
  const x = toNumber(a);
  const y = toNumber(b);
  return x === null || y === null ? null : x + y;
}

function subtract(a: unknown, b: unknown): unknown {
  if (a === null || b === null) return null;
  const da = asDate(a);
  if (da) {
    const db = asDate(b);
    if (db) return new Duration({ ...ZERO, ms: da.getTime() - db.getTime() });
    const dur = durationOf(b);
    if (dur) return shiftDate(da, dur, -1);
  }
  const x = toNumber(a);
  const y = toNumber(b);
  return x === null || y === null ? null : x - y;
}

const ZERO: DurationParts = { y: 0, M: 0, w: 0, d: 0, h: 0, m: 0, s: 0, ms: 0 };

const UNIT_ALIASES: Record<string, keyof DurationParts> = {
  y: "y", year: "y", years: "y",
  M: "M", month: "M", months: "M",
  w: "w", week: "w", weeks: "w",
  d: "d", day: "d", days: "d",
  h: "h", hour: "h", hours: "h",
  m: "m", minute: "m", minutes: "m",
  s: "s", second: "s", seconds: "s",
};

/**
 * Parse a duration string (`"1M"`, `"2 days"`, `"1w 3d"`), or pass a
 * Duration through. Scans the string once; strings longer than any real
 * duration are rejected up front.
 */
export function durationOf(v: unknown): Duration | null {
  if (v instanceof Duration) return v;
  if (typeof v !== "string") return null;
  const src = v.trim();
  if (src === "" || src.length > MAX_DURATION_LENGTH) return null;
  const parts: DurationParts = { ...ZERO };
  let i = 0;
  let any = false;
  const n = src.length;
  while (i < n) {
    while (i < n && (src[i] === " " || src[i] === ",")) i++;
    if (i >= n) break;
    // number
    let j = i;
    if (src[j] === "-") j++;
    const numStart = j;
    while (j < n && src[j]! >= "0" && src[j]! <= "9") j++;
    if (src[j] === ".") {
      j++;
      while (j < n && src[j]! >= "0" && src[j]! <= "9") j++;
    }
    if (j === numStart) return null;
    const value = Number(src.slice(i, j));
    while (j < n && src[j] === " ") j++;
    // unit
    const unitStart = j;
    while (j < n && /[A-Za-z]/.test(src[j]!)) j++;
    const unitRaw = src.slice(unitStart, j);
    if (unitRaw === "" || !Number.isFinite(value)) return null;
    const unit = own(UNIT_ALIASES, unitRaw) ?? (unitRaw.length > 1 ? own(UNIT_ALIASES, unitRaw.toLowerCase()) : undefined);
    if (!unit) return null;
    parts[unit] += value;
    any = true;
    i = j;
  }
  return any ? new Duration(parts) : null;
}

function shiftDate(d: Date, dur: Duration, sign: 1 | -1): Date {
  const p = dur.parts;
  const out = new Date(d.getTime());
  if (p.y || p.M) out.setMonth(out.getMonth() + sign * (p.y * 12 + p.M));
  const timeMs = p.h * 3_600_000 + p.m * 60_000 + p.s * 1_000 + p.ms;
  out.setTime(out.getTime() + sign * (p.w * 7 * DAY + p.d * DAY + timeMs));
  if (isDateOnly(d) && timeMs === 0) markDateOnly(out);
  return out;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export function isDateString(s: string): boolean {
  return s.length <= 40 && asDate(s) !== null;
}

/**
 * A Date for a Date, or for a `YYYY-MM-DD[ HH:mm[:ss[.SSS]]][zone]` string
 * (local time unless zoned). Impossible dates (`2024-02-30`) are not dates.
 * Date-only strings give date-only values.
 */
export function asDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== "string" || v.length > 40) return null;
  const s = v.trim();
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  const h = Number(m[4] ?? 0);
  const mi = Number(m[5] ?? 0);
  const sec = Number(m[6] ?? 0);
  if (mo < 1 || mo > 12 || day < 1 || day > 31 || h > 23 || mi > 59 || sec > 59) return null;
  if (m[8]) {
    const d = new Date(s.replace(" ", "T"));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(y, mo - 1, day, h, mi, sec, Number((m[7] ?? "0").padEnd(3, "0")));
  // Reject rollovers such as Feb 30 → Mar 1.
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== day) return null;
  return m[4] === undefined ? markDateOnly(d) : d;
}

export function truthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

export function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.length === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (v instanceof Date || v instanceof FileRef || v instanceof Duration) return false;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isNaN(v) ? null : v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.getTime();
  if (v instanceof Duration) return v.ms;
  if (typeof v === "string" && v.trim() !== "" && v.length < 400 && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** Local `YYYY-MM-DD`. */
export function formatLocalDate(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Plain-text form of a value, as `toString()` and string concatenation see it. */
export function toText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (v instanceof Date) return isDateOnly(v) ? formatLocalDate(v) : formatDate(v, "YYYY-MM-DD HH:mm:ss");
  if (v instanceof FileRef) return v.entry.file.path;
  if (v instanceof Duration) return `${v.ms}ms`;
  if (Array.isArray(v)) return v.map(toText).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Strip `[[...]]` / `[[...|alias]]` / `#heading` to the link path. */
function linkPath(s: string): string {
  const inner = s.trim().replace(/^!?\[\[/, "").replace(/\]\]$/, "");
  return inner.split("|")[0]!.split("#")[0]!.trim();
}

/** True if link text (`X`, `folder/X`, `X.md`, `[[X|alias]]`) points at this entry's file. */
function linkMatchesFile(text: string, entry: BaseEntry): boolean {
  const want = linkPath(text).replace(/\.md$/i, "").toLowerCase();
  if (want === "") return false;
  const path = entry.file.path.replace(/\.md$/i, "").toLowerCase();
  return want === path || (!want.includes("/") && entry.file.basename.toLowerCase() === want);
}

export function equals(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (a instanceof FileRef || b instanceof FileRef) {
    if (a instanceof FileRef && b instanceof FileRef) return a.entry.file.path === b.entry.file.path;
    const file = (a instanceof FileRef ? a : b) as FileRef;
    const other = a instanceof FileRef ? b : a;
    return typeof other === "string" && linkMatchesFile(other, file.entry);
  }
  if (a instanceof Date || b instanceof Date) {
    const da = asDate(a);
    const db = asDate(b);
    return da !== null && db !== null && da.getTime() === db.getTime();
  }
  if (a instanceof Duration || b instanceof Duration) {
    const x = durationMs(a);
    const y = durationMs(b);
    return x !== null && y !== null && x === y;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => equals(x, b[i]));
  }
  if (typeof a === "object" || typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  if (typeof a === "number" || typeof b === "number") {
    const x = toNumber(a);
    const y = toNumber(b);
    if (x !== null && y !== null) return x === y;
  }
  return String(a) === String(b);
}

/** Milliseconds of a Duration, a duration string, or a number (taken as ms). */
function durationMs(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const d = durationOf(v);
  return d ? d.ms : null;
}

/**
 * Order two values: negative, zero, positive, or null when they can't be
 * ordered (missing value, or incompatible types). Comparisons against null
 * are false, as in Obsidian.
 */
export function compareValues(a: unknown, b: unknown): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (a instanceof Date || b instanceof Date) {
    const da = a instanceof Date ? a : typeof a === "number" ? new Date(a) : asDate(a);
    const db = b instanceof Date ? b : typeof b === "number" ? new Date(b) : asDate(b);
    if (!da || !db) return null;
    return Math.sign(da.getTime() - db.getTime());
  }
  if (a instanceof Duration || b instanceof Duration) {
    const x = durationMs(a);
    const y = durationMs(b);
    if (x === null || y === null) return null;
    return Math.sign(x - y);
  }
  if (typeof a === "string" && typeof b === "string") {
    const da = asDate(a);
    const db = da ? asDate(b) : null;
    if (da && db) return Math.sign(da.getTime() - db.getTime());
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const x = toNumber(a);
  const y = toNumber(b);
  if (x === null || y === null) return null;
  return Math.sign(x - y);
}

// ---- calls -----------------------------------------------------------------

function call(node: Extract<Node, { t: "call" }>, ctx: EvalContext): unknown {
  if (node.callee.t === "ident") return globalCall(node.callee.name, node.args, ctx);
  if (node.callee.t !== "member") throw new BaseEvaluationError("Invalid call.");
  const receiver = evaluate(node.callee.obj, ctx);
  const args = node.args.map((a) => evaluate(a, ctx));
  return method(receiver, node.callee.name, args, ctx);
}

function globalCall(name: string, argNodes: Node[], ctx: EvalContext): unknown {
  if (name === "if") {
    if (argNodes.length < 2) throw new BaseEvaluationError("if() needs a condition and a result.");
    return truthy(evaluate(argNodes[0]!, ctx))
      ? evaluate(argNodes[1]!, ctx)
      : argNodes[2]
        ? evaluate(argNodes[2], ctx)
        : null;
  }
  const args = argNodes.map((a) => evaluate(a, ctx));
  switch (name) {
    case "list":
      return args[0] === null || args[0] === undefined ? [] : Array.isArray(args[0]) ? args[0] : [args[0]];
    case "number": {
      const v = args[0];
      const d = typeof v === "string" ? asDate(v) : null;
      if (d) return d.getTime();
      return toNumber(v);
    }
    case "min":
    case "max": {
      const nums = args.flat().map(toNumber).filter((x): x is number => x !== null);
      if (nums.length === 0) return null;
      return nums.reduce((p, q) => (name === "min" ? Math.min(p, q) : Math.max(p, q)));
    }
    case "date":
      return asDate(args[0]);
    case "now":
      return new Date(ctx.now.getTime());
    case "today": {
      const d = new Date(ctx.now.getTime());
      d.setHours(0, 0, 0, 0);
      return markDateOnly(d);
    }
    case "duration":
      return durationOf(args[0]);
    default:
      throw new UnsupportedConstructError(`Unsupported construct: function '${name}()'.`);
  }
}

/** Methods every value has. */
const ANY_METHODS = new Set(["isTruthy", "isEmpty", "toString", "isType"]);
const DATE_STRING_METHODS = new Set(["date", "time", "format", "relative"]);

function method(recv: unknown, name: string, args: unknown[], ctx: EvalContext): unknown {
  if (ANY_METHODS.has(name)) {
    switch (name) {
      case "isTruthy":
        return truthy(recv);
      case "isEmpty":
        return isEmptyValue(recv);
      case "toString":
        return toText(recv);
      default: {
        const want = toText(args[0]).toLowerCase();
        if (want === "date" && typeof recv === "string" && isDateString(recv)) return true;
        return typeName(recv) === want;
      }
    }
  }

  if (recv instanceof FileRef) return fileMethod(recv.entry, name, args, ctx);
  if (recv === null || recv === undefined) {
    // contains/containsAny/... on a missing property: nothing to find.
    if (name.startsWith("contains") || name === "startsWith" || name === "endsWith") return false;
    return null;
  }
  // Untyped date-like strings (`due: 2024-03-01`) still have date methods.
  if (typeof recv === "string" && DATE_STRING_METHODS.has(name) && isDateString(recv)) {
    return dateMethod(asDate(recv)!, name, args, ctx);
  }
  let out: unknown = NO_METHOD;
  if (typeof recv === "string") out = stringMethod(recv, name, args);
  else if (typeof recv === "number") out = numberMethod(recv, name, args);
  else if (Array.isArray(recv)) out = listMethod(recv, name, args);
  else if (recv instanceof Date) out = dateMethod(recv, name, args, ctx);
  else if (typeof recv === "object" && !(recv instanceof Duration)) {
    if (name === "keys") out = Object.keys(recv as object);
    else if (name === "values") out = Object.values(recv as object);
  }
  if (out === NO_METHOD) {
    ctx.warn(`'.${name}()' doesn't apply to a ${typeName(recv)} value; those rows got null.`);
    return null;
  }
  return out;
}

/** Sentinel: the receiver's type has no such method. */
const NO_METHOD = Symbol("no-method");

function typeName(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (v instanceof Date) return "date";
  if (v instanceof FileRef) return "file";
  if (v instanceof Duration) return "duration";
  if (Array.isArray(v)) return "list";
  if (typeof v === "object") return "object";
  return typeof v;
}

function str(v: unknown): string {
  return toText(v);
}

function stringMethod(s: string, name: string, args: unknown[]): unknown {
  switch (name) {
    case "contains":
      return s.includes(str(args[0]));
    case "containsAll":
      return args.every((a) => s.includes(str(a)));
    case "containsAny":
      return args.some((a) => s.includes(str(a)));
    case "startsWith":
      return s.startsWith(str(args[0]));
    case "endsWith":
      return s.endsWith(str(args[0]));
    case "lower":
      return s.toLowerCase();
    case "title":
      return s.replace(/(^|\s)(\p{L})/gu, (_m, sp: string, c: string) => sp + c.toUpperCase());
    case "trim":
      return s.trim();
    case "replace": {
      const pattern = str(args[0]);
      const replacement = str(args[1]);
      if (pattern === "") return s;
      const parts = s.split(pattern);
      checkStringLength(s.length + (parts.length - 1) * (replacement.length - pattern.length), "replace()");
      return parts.join(replacement);
    }
    case "repeat": {
      const n = toNumber(args[0]);
      if (n === null || n < 0 || !Number.isFinite(n)) return null;
      const count = Math.floor(n);
      checkStringLength(s.length * count, "repeat()");
      return s.repeat(count);
    }
    case "reverse":
      return Array.from(s).reverse().join("");
    case "slice": {
      const a = toNumber(args[0]) ?? 0;
      const b = args.length > 1 ? toNumber(args[1]) : null;
      return b === null ? s.slice(a) : s.slice(a, b);
    }
    case "split": {
      const sep = str(args[0]);
      // The limit argument stops split() from building more than we'd keep.
      checkListLength(s.split(sep, MAX_LIST_LENGTH + 1).length, "split()");
      const parts = s.split(sep);
      const n = args.length > 1 ? toNumber(args[1]) : null;
      return n === null ? parts : parts.slice(0, n);
    }
  }
  return NO_METHOD;
}

function numberMethod(x: number, name: string, args: unknown[]): unknown {
  switch (name) {
    case "abs":
      return Math.abs(x);
    case "ceil":
      return Math.ceil(x);
    case "floor":
      return Math.floor(x);
    case "round": {
      const digits = toNumber(args[0]) ?? 0;
      const f = 10 ** Math.min(15, Math.max(0, Math.floor(digits)));
      return Math.round(x * f) / f;
    }
    case "toFixed": {
      const digits = toNumber(args[0]) ?? 0;
      return x.toFixed(Math.min(100, Math.max(0, Math.floor(digits))));
    }
  }
  return NO_METHOD;
}

function listMethod(list: unknown[], name: string, args: unknown[]): unknown {
  const has = (v: unknown) => list.some((x) => equals(x, v));
  switch (name) {
    case "contains":
      return has(args[0]);
    case "containsAll":
      return args.every(has);
    case "containsAny":
      return args.some(has);
    case "join": {
      const sep = args.length ? str(args[0]) : ",";
      let size = 0;
      const texts = list.map((v) => {
        const t = toText(v);
        size += t.length + sep.length;
        checkStringLength(size, "join()");
        return t;
      });
      return texts.join(sep);
    }
    case "flat": {
      const out = list.flat(Infinity);
      checkListLength(out.length, "flat()");
      return out;
    }
    case "unique":
      return uniqueValues(list);
    case "reverse":
      return list.slice().reverse();
    case "slice": {
      const a = toNumber(args[0]) ?? 0;
      const b = args.length > 1 ? toNumber(args[1]) : null;
      return b === null ? list.slice(a) : list.slice(a, b);
    }
    case "sort":
      return list.slice().sort((p, q) => compareValues(p, q) ?? 0);
  }
  return NO_METHOD;
}

/** Most non-primitive items `unique()` compares pairwise. */
const MAX_UNIQUE_OBJECTS = 5_000;

/**
 * `unique()` with typed equality, as for groups: `5` and `"5"` stay
 * distinct. Primitives and dates are keyed (linear at any size); lists and
 * objects are compared pairwise, so their number is capped.
 */
function uniqueValues(list: unknown[]): unknown[] {
  const seen = new Set<string>();
  const objects: unknown[] = [];
  const out: unknown[] = [];
  for (const v of list) {
    let key: string | null = null;
    if (v === null || v === undefined) key = "null";
    else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") key = `${typeof v}:${String(v)}`;
    else if (v instanceof Date) key = `date:${v.getTime()}`;
    if (key !== null) {
      if (!seen.has(key)) {
        seen.add(key);
        out.push(v);
      }
      continue;
    }
    if (objects.length >= MAX_UNIQUE_OBJECTS) {
      throw new ResourceLimitError(`unique() compares at most ${MAX_UNIQUE_OBJECTS.toLocaleString("en")} lists or objects.`);
    }
    if (!objects.some((o) => Array.isArray(o) === Array.isArray(v) && equals(o, v))) {
      objects.push(v);
      out.push(v);
    }
  }
  return out;
}

function dateMethod(d: Date, name: string, args: unknown[], ctx: EvalContext): unknown {
  switch (name) {
    case "date": {
      const out = new Date(d.getTime());
      out.setHours(0, 0, 0, 0);
      return markDateOnly(out);
    }
    case "time":
      return formatDate(d, "HH:mm:ss");
    case "format":
      return formatDate(d, args.length ? str(args[0]).slice(0, 200) : "YYYY-MM-DD");
    case "relative":
      return callMoment(d).from(callMoment(ctx.now));
  }
  return NO_METHOD;
}

/** Format with Moment, which Obsidian bundles and Bases' own format() uses. */
function formatDate(d: Date, fmt: string): string {
  return callMoment(d).format(fmt);
}

// ---- file methods ----------------------------------------------------------

function fileMethod(entry: BaseEntry, name: string, args: unknown[], ctx: EvalContext): unknown {
  switch (name) {
    case "hasTag":
      return args.some((a) => hasTag(entry, str(a)));
    case "inFolder":
      return inFolder(entry, str(args[0]));
    case "hasProperty":
      return Object.prototype.hasOwnProperty.call(entry.note, str(args[0]));
    case "hasLink":
      return hasLink(entry, args[0], ctx);
  }
  throw new UnsupportedConstructError(`Unsupported construct: 'file.${name}()'.`);
}

/** `#a/b` matches `a` and `a/b`; tags compare case-insensitively, as in Obsidian. */
export function hasTag(entry: BaseEntry, tag: string): boolean {
  const want = tag.replace(/^#/, "").toLowerCase();
  if (want === "") return false;
  return entry.file.tags.some((t) => {
    const have = t.replace(/^#/, "").toLowerCase();
    return have === want || have.startsWith(want + "/");
  });
}

/** True if the entry is in `folder` or any of its sub-folders. `"/"` or `""` is the whole vault. */
export function inFolder(entry: BaseEntry, folder: string): boolean {
  const f = folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (f === "") return true;
  const own = entry.file.folder;
  return own === f || own.startsWith(f + "/");
}

function hasLink(entry: BaseEntry, target: unknown, ctx: EvalContext): boolean {
  let targetPath: string | null = null;
  let text: string | null = null;
  if (target instanceof FileRef) targetPath = target.entry.file.path;
  else if (typeof target === "string") {
    text = linkPath(target);
    if (text === "") return false;
    targetPath = ctx.links.resolve(text, entry.file.path);
  } else return false;
  if (targetPath !== null && ctx.links.linksTo(entry.file.path, targetPath)) return true;
  // Unresolved link: compare the written link text.
  if (text !== null) {
    const want = text.replace(/\.md$/i, "").toLowerCase();
    return entry.file.links.some((l) => linkPath(l).replace(/\.md$/i, "").toLowerCase() === want);
  }
  return false;
}
