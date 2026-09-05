#!/usr/bin/env -S deno run --allow-read

// =====================================================================
//  SLOTH — a lazy, Haskell-like, untyped (JS-like) language interpreter
//  with optional TypeScript-style type annotations and powerful types.
//  Run:  deno run --allow-read main.ts   (REPL)
//        deno run --allow-read main.ts features.txt
// =====================================================================

// ---------------- Types & values ----------------

type Type = string; // lightweight: we represent types as printable strings

// One equation of a Haskell-style function definition:  f p1 p2 ... = body
interface DefClause { params: Pattern[]; body: Expr; }

// Runtime values (dynamically typed, like JS)
type Value =
  | { kind: "int"; v: number }
  | { kind: "float"; v: number }
  | { kind: "bool"; v: boolean }
  | { kind: "string"; v: string }
  | { kind: "char"; v: string }
  | { kind: "unit" }
  | { kind: "list"; v: Value[] }
  | { kind: "lazyList"; exprs: Expr[]; env: Env }
  | { kind: "record"; v: Array<[string, Value]> }
  | { kind: "variant"; tag: string; v: Value[] }
  | { kind: "closure"; params: string[]; body: Expr; env: Env }
  | { kind: "native"; name: string; arity: number; applied: Value[]; tag?: string }
  | { kind: "clauseFn"; clauses: DefClause[]; arity: number; env: Env; applied: Value[] }
  | { kind: "nomatch" }
  | { kind: "thunk"; body: Expr; env: Env; value?: Value };

function mkInt(v: number): Value { return { kind: "int", v }; }
function mkBool(v: boolean): Value { return { kind: "bool", v }; }
function mkStr(v: string): Value { return { kind: "string", v }; }
function mkList(v: Value[]): Value { return { kind: "list", v }; }

// printf-style rendering for `format`: strings appear WITHOUT quotes.
function rawString(v: Value): string {
  return v.kind === "string" ? v.v : valueToString(v);
}

function valueToString(v: Value): string {
  switch (v.kind) {
    case "int": return String(v.v);
    case "float": return String(v.v);
    case "bool": return String(v.v);
    case "string": return `"${v.v}"`;
    case "char": return `'${v.v}'`;
    case "unit": return "()";
    case "list": return `[${v.v.map(valueToString).join(", ")}]`;
    case "lazyList": return "<lazy>";
    case "record":
      return `[${v.v.map(([k, val]) => `${k}: ${valueToString(val)}`).join(", ")}]`;
    case "variant": {
      const args = v.v.length ? " " + v.v.map(valueToString).join(" ") : "";
      return v.tag + args;
    }
    case "closure": return "<function>";
    case "thunk": return "<thunk>";
    case "native": return `<native:${v.name}>`;
    case "clauseFn": return "<function>";
    case "nomatch": return "<nomatch>";
  }
}

// Environment: a chain of hash maps. Shared mutable object per scope.
class Env {
  parent: Env | null;
  map: Map<string, Value>;

  constructor(parent: Env | null = null) {
    this.parent = parent;
    this.map = new Map();
  }

  get(name: string): Value | undefined {
    let e: Env | null = this;
    while (e) {
      if (e.map.has(name)) return e.map.get(name);
      e = e.parent;
    }
    return undefined;
  }

  setLocal(name: string, v: Value) {
    this.map.set(name, v);
  }

  // Set in the scope where the variable already exists, else local scope.
  set(name: string, v: Value) {
    // For simplicity (JS-like), assignment operates on the current scope.
    let e: Env | null = this;
    while (e) {
      if (e.map.has(name)) { e.map.set(name, v); return; }
      e = e.parent;
    }
    this.map.set(name, v);
  }
}

// ---------------- AST ----------------

type BinOp = "+" | "-" | "*" | "/" | "%" | "==" | "!=" | "<" | ">" | "<=" | ">="
  | "&&" | "||" | "++" | ":";

type UnOp = "neg" | "not";

type Expr =
  | { t: "int"; v: number }
  | { t: "float"; v: number }
  | { t: "bool"; v: boolean }
  | { t: "string"; v: string }
  | { t: "char"; v: string }
  | { t: "unit" }
  | { t: "var"; name: string }
  | { t: "binop"; op: BinOp; l: Expr; r: Expr }
  | { t: "unop"; op: UnOp; e: Expr }
  | { t: "app"; f: Expr; a: Expr }
  | { t: "lambda"; params: string[]; body: Expr }
  | { t: "ternary"; cond: Expr; then: Expr; els: Expr }
  | { t: "match"; scrut: Expr; alts: Alt[] }
  | { t: "list"; v: Expr[] }
  | { t: "record"; v: Array<[string, Expr]> }
  | { t: "recordAccess"; rec: Expr; field: string }
  | { t: "fromList"; template: Expr; values: Expr }
  | { t: "recordTemplate"; names: string[] }
  | { t: "pipe"; x: Expr; f: Expr }
  | { t: "block"; stmts: Expr[] }
  | { t: "stmDef"; name: string; clauses: { params: Pattern[]; body: Expr }[] }
  | { t: "patDef"; pattern: Pattern; value: Expr };

interface Alt {
  pattern: Pattern;
  guard?: Expr;
  body: Expr;
}

type Pattern =
  | { p: "wildcard" }
  | { p: "var"; name: string }
  | { p: "int"; v: number }
  | { p: "bool"; v: boolean }
  | { p: "string"; v: string }
  | { p: "list"; v: Pattern[] }
  | { p: "cons"; head: Pattern; tail: Pattern }
  | { p: "constr"; tag: string; args: Pattern[] };

interface DataDef { name: string; variants: { tag: string; arity: number }[]; }

type TopLevel = { t: "def"; name: string; clauses: DefClause[] } | { t: "expr"; value: Expr }
  | { t: "data"; def: DataDef }
  | { t: "patDef"; pattern: Pattern; value: Expr };

// ---------------- Lexer ----------------

type Token =
  | { k: "int"; v: number }
  | { k: "float"; v: number }
  | { k: "bool"; v: boolean }
  | { k: "str"; v: string }
  | { k: "char"; v: string }
  | { k: "ident"; v: string }
  | { k: "kw"; v: string }                       // keywords
  | { k: "opw"; v: string }                      // backtick-infix name: `f`
  | { k: "sym"; v: string }                      // symbols incl. multi-char
  | { k: "newline" } | { k: "indent" } | { k: "dedent" } | { k: "eof" };

const KEYWORDS = new Set([
  "where",
  "do", "fn", "data", "import", "type", "match", "true", "false", "rec",
]);

const SYMBOLS = [
  ">>>", "==>", "$", "<<", "<<=", ">>=", "==", "!=", "<=", ">=", "=>", "->", "<-",
  "&&", "||", "++", "::", ":=",
];

export function lex(src: string): Token[] {
  const toks: Token[] = [];
  const indentStack = [0];
  let pos = 0;
  let atLineStart = true;
  let parenDepth = 0;

  const peek = (off = 0) => src[pos + off];
  const skipWs = () => { while (pos < src.length && " \t\r".includes(src[pos])) pos++; };

  // skip comments (line and block)
  const skipComment = (): boolean => {
    if (src.startsWith("#", pos)) {
      while (pos < src.length && src[pos] !== '\n') pos++;
      return true;
    }
    if (src.startsWith("{-", pos)) {
      let depth = 1;
      pos += 2;
      while (pos < src.length && depth > 0) {
        if (src.startsWith("{-", pos)) { depth++; pos += 2; }
        else if (src.startsWith("-}", pos)) { depth--; pos += 2; }
        else pos++;
      }
      return true;
    }
    return false;
  };

  while (pos < src.length) {
    // indentation detection at start of line (outside parens)
    if (atLineStart && parenDepth === 0) {
      atLineStart = false;
      let indent = 0;
      while (pos < src.length && (src[pos] === ' ' || src[pos] === '\t')) {
        indent += src[pos] === '\t' ? 4 : 1;
        pos++;
      }
      // blank / comment-only line: reset and keep going
      if (pos >= src.length) break;
      if (src[pos] === '\n') { continue; }
      if (src.startsWith("#", pos) || src.startsWith("{-", pos)) {
        skipComment();
        // After a comment, move to next line and re-detect indentation.
        if (pos < src.length && src[pos] === '\n') {
          pos++;
          toks.push({ k: "newline" });
          continue;
        }
        continue;
      }

      const cur = indentStack[indentStack.length - 1];
      if (indent > cur) {
        if (indent === cur + 4) {
          indentStack.push(indent);
          toks.push({ k: "indent" });
        } else {
          throw new Error(`Lexer: indentation must increase by exactly 4 spaces (got +${indent - cur}) at ${pos}`);
        }
      } else {
        while (indent < indentStack[indentStack.length - 1]) {
          indentStack.pop();
          toks.push({ k: "dedent" });
        }
        if (indent !== indentStack[indentStack.length - 1]) {
          throw new Error(`Lexer: indentation must be a multiple of 4 spaces at ${pos}`);
        }
      }
    }

    skipWs();
    if (pos >= src.length) break;

    if (skipComment()) { atLineStart = false; continue; }

    const c = src[pos];

    if (c === '\n') {
      pos++;
      if (parenDepth === 0) {
        toks.push({ k: "newline" });
        atLineStart = true;
      }
      continue;
    }

    // symbols (multi-char first)
    let matchedSym = false;
    for (const s of SYMBOLS) {
      if (src.startsWith(s, pos)) {
        if (s === "<-" || s === "->" || s === "=>") {
          // used contextually as constructor/member token `:` handled separately
        }
        toks.push({ k: "sym", v: s });
        pos += s.length;
        matchedSym = true;
        break;
      }
    }
    if (matchedSym) continue;

    // single-char symbols. `(`/`)` suppress layout inside parens (grouping);
    // `[`/`]` DO NOT: newlines and indentation inside a list literal are
    // significant, so elements can be separated just by being on their own
    // lines. `{`/`}` likewise participate in the global 4-space layout.
    if (":()[]{}.,;|".includes(c)) {
      if (c === '(') parenDepth++;
      if (c === ')') parenDepth--;
      // `:` is cons in this language; `::` handled above as symbol
      toks.push({ k: "sym", v: c === ":" ? ":" : c });
      pos++;
      continue;
    }

    if ("=+-*/%<>!&?".includes(c)) {
      toks.push({ k: "sym", v: c });
      pos++;
      continue;
    }

    if (c === '"') {
      pos++;
      let s = "";
      while (pos < src.length && src[pos] !== '"') {
        if (src[pos] === '\\') {
          pos++;
          s += ({ n: "\n", t: "\t", '\\': "\\", '"': '"' }[src[pos]] ?? src[pos]);
        } else s += src[pos];
        pos++;
      }
      pos++; // closing quote
      toks.push({ k: "str", v: s });
      continue;
    }

    if (c === "'") {
      pos++;
      let ch = src[pos];
      if (ch === '\\') { pos++; ch = ({ n: "\n", t: "\t", '\\': "\\", "'": "'" }[src[pos]] ?? src[pos]); }
      pos += 2; // char + closing quote
      toks.push({ k: "char", v: ch });
      continue;
    }

    if (/\d/.test(c)) {
      let num = "";
      while (pos < src.length && /\d|\./.test(src[pos])) num += src[pos++];
      if (num.includes(".")) toks.push({ k: "float", v: parseFloat(num) });
      else toks.push({ k: "int", v: parseInt(num, 10) });
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      let id = "";
      while (pos < src.length && /[A-Za-z0-9_']/.test(src[pos])) id += src[pos++];
      if (KEYWORDS.has(id)) toks.push({ k: "kw", v: id });
      else toks.push({ k: "ident", v: id });
      continue;
    }

    if (c === '`') {
      pos++;
      let id = "";
      while (pos < src.length && /[A-Za-z0-9_']/.test(src[pos])) id += src[pos++];
      if (id === "" || src[pos] !== '`') {
        throw new Error(`Lexer: malformed backtick operator at ${pos}`);
      }
      pos++; // closing backtick
      toks.push({ k: "opw", v: id });
      continue;
    }

    throw new Error(`Lexer: unexpected character '${c}' at ${pos}`);
  }

  while (indentStack.length > 1) { indentStack.pop(); toks.push({ k: "dedent" }); }
  toks.push({ k: "eof" });
  return toks;
}

// ---------------- Parser ----------------

class Parser {
  toks: Token[];
  i = 0;

  constructor(toks: Token[]) { this.toks = toks; }

  peek(off = 0): Token {
    return this.toks[Math.min(this.i + off, this.toks.length - 1)];
  }
  next(): Token { return this.toks[this.i++]; }
  isSym(v: string) { const t = this.peek(); return t.k === "sym" && t.v === v; }
  isKw(v: string) { const t = this.peek(); return t.k === "kw" && t.v === v; }
  eatSym(v: string): boolean {
    if (this.isSym(v)) { this.i++; return true; }
    return false;
  }
  eatKw(v: string): boolean {
    if (this.isKw(v)) { this.i++; return true; }
    return false;
  }
  expectSym(v: string) {
    if (!this.eatSym(v)) throw new Error(`Parser: expected '${v}', got '${this.tokenStr(this.peek())}'`);
  }
  tokenStr(t: Token): string {
    switch (t.k) {
      case "ident": case "kw": case "str": case "char": return `'${t.v}'`;
      case "int": return String(t.v);
      case "float": return String(t.v);
      case "opw": return `\`${t.v}\``;
      case "sym": return `'${t.v}'`;
      case "newline": return "newline";
      case "indent": return "indent";
      case "dedent": return "dedent";
      case "eof": return "EOF";
      default: return "?";
    }
  }

  skipNL() {
    while (this.peek().k === "newline" || this.peek().k === "indent") this.next();
  }

  // ---- types (parsed but only used for optional annotations; ignored at runtime)

  // Scan-only version of parseType: advances a token index (not the parser)
  // past a single type, for lookahead. Returns the new index.
  skipType(j: number): number {
    const tk = this.toks[j];
    if (tk.k === "ident" || tk.k === "kw") return j + 1;
    if (tk.k === "sym" && tk.v === "(") {
      j++;
      j = this.skipType(j);
      while (this.toks[j].k === "sym" && (this.toks[j] as any).v === ",") {
        j = this.skipType(j + 1);
      }
      return j + 1; // past ')'
    }
    if (tk.k === "sym" && tk.v === "[") {
      return this.skipType(j + 1) + 1;
    }
    return j + 1;
  }

  parseType(): string {
    const t = this.peek();
    if (t.k === "ident" || t.k === "kw") { this.next(); return t.v; }
    if (t.k === "sym" && t.v === "(") {
      this.next();
      const parts = [this.parseType()];
      while (this.eatSym(",")) parts.push(this.parseType());
      this.expectSym(")");
      return "(" + parts.join(", ") + ")";
    }
    if (t.k === "sym" && t.v === "[") {
      this.next();
      const inner = this.parseType();
      this.expectSym("]");
      return `[${inner}]`;
    }
    this.next();
    return "_";
  }

  // Parse a full function/expression type, including arrow types:
  //   Int -> [Bool] -> (Int, String)
  parseFullType(): string {
    this.skipAll();
    const parts: string[] = [];
    for (;;) {
      parts.push(this.parseType());
      this.skipAll();
      if (this.isSym("->")) { this.next(); continue; }
      break;
    }
    return parts.length === 1 ? parts[0] : parts.join(" -> ");
  }

  // ---- patterns

  parsePattern(): Pattern {
    const t = this.peek();
    if (t.k === "sym" && t.v === "_") { this.next(); return { p: "wildcard" }; }
    if (t.k === "int") { this.next(); return { p: "int", v: t.v }; }
    if (t.k === "bool") { this.next(); return { p: "bool", v: t.v }; }
    if (t.k === "str") { this.next(); return { p: "string", v: t.v }; }
    if (t.k === "sym" && t.v === "(") {
      this.next();
      if (this.isSym(")")) { this.next(); return { p: "list", v: [] }; }
      const p = this.parseConsPattern();
      if (this.eatSym(",")) {
        throw new Error("Parser: tuple patterns are not supported; use a list pattern [a, b, ...] instead");
      }
      this.expectSym(")");
      return p;
    }
    if (t.k === "sym" && t.v === "[") {
      this.next();
      const ps = [] as Pattern[];
      while (!this.isSym("]")) {
        ps.push(this.parsePattern());
        if (this.eatSym(",")) continue;
        break;
      }
      this.expectSym("]");
      return { p: "list", v: ps };
    }
    if (t.k === "ident") {
      this.next();
      const name = t.v;
      // constructor application: Just x
      if (name[0] === name[0].toUpperCase() && this.peek().k !== "sym") {
        const args = [] as Pattern[];
        while (this.peek().k === "ident" && !this.isSym("->")) {
          args.push(this.parsePattern());
        }
        return { p: "constr", tag: name, args };
      }
      return { p: "var", name };
    }
    throw new Error(`Parser: bad pattern '${this.tokenStr(t)}'`);
  }

  // cons pattern: x:xs
  parseConsPattern(): Pattern {
    let p = this.parsePattern();
    if (this.isSym(":")) {
      this.next();
      const tail = this.parseConsPattern();
      return { p: "cons", head: p, tail };
    }
    return p;
  }

  // ---- expressions

  parseExpr(): Expr {
    // A newline at the SAME indentation is an implicit semicolon, so it ends
    // the current expression. Only an INDENTED continuation (newlines followed
    // by an indent token) is consumed here to join the next line in.
    this.skipContinuation();
    return this.parsePipe();
  }

  // Consume newlines + ONE indent if the following content is indented deeper
  // (+4), i.e. a continued expression. Leaves same-level newlines in place.
  skipContinuation(): boolean {
    let j = this.i;
    while (this.toks[j] && this.toks[j].k === "newline") j++;
    if (this.toks[j] && this.toks[j].k === "indent") {
      this.i = j + 1;
      return true;
    }
    return false;
  }

  skipLayout() {
    while (this.peek().k === "newline" || this.peek().k === "indent") this.next();
  }

  parsePipe(): Expr {
    let e = this.parseTernary();
    while (this.isSym("$")) {
      this.next();
      const f = this.parseTernary();
      e = { t: "pipe", x: e, f };
    }
    return e;
  }

  // Backtick infix:  a `f` b  =>  f a b   (Haskell-style operator via name).
  // Left-associative. Binds tighter than ternary, looser than comparison.
  // Exception: `for` is inverted so the sequence sits on the left:
  //   seq `for` fn  =>  for fn seq   (synonymous with the pipe  seq $ for fn)
  parseBacktick(): Expr {
    let e = this.parseCompare();
    while (this.peek().k === "opw") {
      const op = (this.next() as { v: string }).v;
      const rhs = this.parseCompare();
      if (op === "for") {
        e = { t: "app", f: { t: "app", f: { t: "var", name: "for" }, a: rhs }, a: e };
      } else {
        e = { t: "app", f: { t: "app", f: { t: "var", name: op }, a: e }, a: rhs };
      }
    }
    return e;
  }

  // Ternary:  cond ? a : b    (right-associative, lower precedence than comparison)
  parseTernary(): Expr {
    let e = this.parseBacktick();
    if (this.isSym("?")) {
      this.next();
      this.skipLayout();
      const then = this.parseTernary();
      this.expectSym(":");
      const els = this.parseTernary();
      e = { t: "ternary", cond: e, then, els };
    }
    return e;
  }

  parseCompare(): Expr {
    let e = this.parseConcat();
    while (["==", "!=", "<", ">", "<=", ">="].some((s) => this.isSym(s))) {
      const op = (this.next() as { v: string }).v as BinOp;
      const r = this.parseConcat();
      e = { t: "binop", op, l: e, r };
    }
    return e;
  }

  parseConcat(): Expr { return this.parseAdd(); }

  parseAdd(): Expr {
    let e = this.parseMul();
    while (this.isSym("+") || this.isSym("-") || this.isSym("++")) {
      const op = (this.next() as { v: string }).v as BinOp;
      const r = this.parseMul();
      e = { t: "binop", op, l: e, r };
    }
    return e;
  }

  parseMul(): Expr {
    let e = this.parseUnary();
    while (this.isSym("*") || this.isSym("/") || this.isSym("%")) {
      const op = (this.next() as { v: string }).v as BinOp;
      const r = this.parseUnary();
      e = { t: "binop", op, l: e, r };
    }
    return e;
  }

  parseUnary(): Expr {
    if (this.isSym("-")) { this.next(); return { t: "unop", op: "neg", e: this.parseApp() }; }
    if (this.isSym("!")) { this.next(); return { t: "unop", op: "not", e: this.parseApp() }; }
    return this.parseApp();
  }

  parseApp(): Expr {
    let f = this.parsePostfix(this.parsePrimary());
    // application: f x y  (does NOT cross newline at layout level, nor a `;`)
    for (;;) {
      const t = this.peek();
      if (t.k === "newline" || t.k === "dedent" || t.k === "indent" || t.k === "eof") break;
      if (t.k === "sym" && t.v === ";") break;
      if (t.k === "ident" || t.k === "int" || t.k === "float" || t.k === "bool" ||
          t.k === "str" || t.k === "char" ||
          (t.k === "sym" && (t.v === "(" || t.v === "[" || t.v === "{"))) {
        const a = this.parsePostfix(this.parsePrimary());
        f = { t: "app", f, a };
      } else break;
    }
    return f;
  }

  // Postfix:  record access  a.b.c   and  prototype clone  tpl.[...]:
//   tpl.[1, 2, 3]            positional — one value per prototype field
//   tpl.[x: 1, y: 2]         named override — clone, replace/add fields
parsePostfix(e: Expr): Expr {
  while (this.isSym(".")) {
    this.next();
    if (this.peek().k === "sym" && (this.peek() as { v: string }).v === "[") {
      // A named-override record? Look at the first content token of `[ ... ]`.
      let j = this.i + 1; // after '['
      while (this.toks[j] && ["newline", "indent", "dedent"].includes(this.toks[j].k)) j++;
      const c0 = this.toks[j];
      const isNamed = c0.k === "ident" && this.toks[j + 1].k === "sym" &&
        (this.toks[j + 1] as { v: string }).v === ":";
      if (isNamed) {
        this.next(); // [
        this.skipListLeading();
        const fs: Array<[string, Expr]> = [];
        for (;;) {
          this.skipListSeparators();
          if (this.isSym("]")) { this.next(); break; }
          const name = this.next();
          if (name.k !== "ident") throw new Error("Parser: expected field name after '.'");
          this.expectSym(":");
          fs.push([name.v, this.parseExpr()]);
        }
        e = { t: "fromList", template: this.asRecordTemplate(e), values: { t: "record", v: fs } };
      } else {
        // positional: zip the prototype's field names with a value list
        const values = this.parseListLiteral();
        e = { t: "fromList", template: this.asRecordTemplate(e), values };
      }
    } else {
      const f = this.next();
      if (f.k !== "ident") throw new Error("Parser: expected field name after '.'");
      e = { t: "recordAccess", rec: e, field: f.v };
    }
  }
  return e;
}

  // A bare-name template is a plain list literal of field-name identifiers,
  // e.g.  [name, value].  Anything else is left as an expression to evaluate
  // (which must produce a record whose keys are the field names).
  asRecordTemplate(e: Expr): Expr {
    if (e.t === "list") {
      const names: string[] = [];
      for (const el of e.v) {
        if (el.t !== "var") return e; // not a pure name template; treat as expr
        names.push(el.name);
      }
      return { t: "recordTemplate", names };
    }
    return e;
  }

  // Parse a list literal  [a, b, ...]  (used as the values on the right side of .)
  parseListLiteral(): Expr {
    this.expectSym("[");
    this.skipListLeading();
    const es = [] as Expr[];
    if (this.isSym("]")) { this.next(); return { t: "list", v: es }; }
    for (;;) {
      es.push(this.parseExpr());
      this.skipListSeparators();
      if (this.isSym("]")) { this.next(); return { t: "list", v: es }; }
      if (this.peek().k === "eof") throw new Error("Parser: unexpected end of file inside list literal");
    }
  }

  // Leading layout of a multi-line list literal: newlines plus the single
  // indent that opens the indented element lines (if any). Dedents are NOT
  // skipped here — they only occur right before the closing `]`.
  skipListLeading() {
    while (this.peek().k === "newline" || this.peek().k === "indent") this.next();
  }

  // Between list elements / record fields: a `,` OR a newline separates them.
  // Any dedent tokens present here close the element block and sit right
  // before the `]`. Indents are left alone — they open nested constructs.
  skipListSeparators() {
    for (;;) {
      if (this.isSym(",")) { this.next(); continue; }
      if (this.peek().k === "newline") { this.next(); continue; }
      if (this.peek().k === "dedent") { this.next(); continue; }
      break;
    }
  }

  parsePrimary(): Expr {
    const t = this.peek();
    // Parenthesized annotated lambda params:  (x: Int, y: Bool) -> body
    if (t.k === "sym" && t.v === "(") {
      let j = this.i + 1;
      let ok = this.toks[j].k === "ident";
      if (ok) {
        for (;;) {
          j++; // param name
          if (this.toks[j].k === "sym" && (this.toks[j] as { v: string }).v === ":") {
            j = this.skipType(j + 1); // skip the annotation type
          }
          if (this.toks[j].k === "sym" && (this.toks[j] as { v: string }).v === ",") { j++; continue; }
          break;
        }
        if (this.toks[j].k === "sym" && (this.toks[j] as { v: string }).v === ")") {
          j++;
          if (this.toks[j].k === "sym" && (this.toks[j] as { v: string }).v === "->") {
            return this.parseLambda();
          }
        }
      }
    } else if (t.k === "ident") {
      let j = this.i;
      let isArrow = false;
      while (this.toks[j].k === "ident") {
        j++;
        // allow optional param type annotations within the param list
        if (this.toks[j].k === "sym" && (this.toks[j] as { v: string }).v === ":") {
          j++;
          j = this.skipType(j);
        }
      }
      if (this.toks[j].k === "sym" && (this.toks[j] as { v: string }).v === "->") {
        isArrow = true;
      }
      if (isArrow) {
        return this.parseLambda();
      }
      // Otherwise fall through to normal ident handling.
    }
    // A pattern-lambda:  [a, b] -> ...,  (Just x) -> ...,  0 -> ...,  _ -> ...
    // Try parsing it; if there's no arrow it falls back to the normal expression.
    if (this.startsLambdaPattern(t)) {
      const save = this.i;
      try {
        return this.parseLambda();
      } catch {
        this.i = save;
      }
    }
    switch (t.k) {
      case "int": this.next(); return { t: "int", v: t.v };
      case "float": this.next(); return { t: "float", v: t.v };
      case "bool": this.next(); return { t: "bool", v: t.v };
      case "str": this.next(); return { t: "string", v: t.v };
      case "char": this.next(); return { t: "char", v: t.v };
      case "ident": {
        this.next();
        return { t: "var", name: t.v };
      }
      case "kw": return this.parseKeyword();
      case "sym":
        switch (t.v) {
          case "(":
          case "{": {
            const close = t.v === "(" ? ")" : "}";
            this.next();
            // () and {} are the same: a group/block. Empty = unit.
            if (this.isSym(close)) { this.next(); return { t: "unit" }; }
            if (t.v === "(") {
              const sec = this.tryOperatorSection();
              if (sec) return sec;
              if (this.isSym(",")) {
                throw new Error("Parser: tuples are not supported; use a list [a, b, ...] instead");
              }
            }
            // A { block body is a statement sequence; value = last statement.
            const stmts: Expr[] = [];
            // A `{` at the end of a line requires its body on the next line to
            // be indented exactly one level (+4):  func = {\n print ... } is
            // rejected,  func = {\n    print ... } is accepted.
            if (t.v === "{" && this.peek().k === "newline") {
              while (this.peek().k === "newline") this.next();
              if (this.peek().k !== "indent") {
                throw new Error("Parser: a { block body must be indented by 4 spaces when { is followed by a newline");
              }
              this.next(); // the one indent that opens the block body
            }
            for (;;) {
              if (this.isSym(";")) { this.next(); continue; }
              while (this.peek().k === "newline") this.next();
              while (this.peek().k === "dedent") this.next();
              if (this.isSym(close)) { this.next(); return { t: "block", stmts }; }
              const tb = this.peek();
              if (tb.k === "eof") throw new Error("Parser: unexpected end of file inside group");
              if (tb.k === "indent") {
                throw new Error("Parser: block statements must stay at one indentation level");
              }
              if (tb.k === "sym" && tb.v === "," && t.v === "(") {
                throw new Error("Parser: tuples are not supported; use a list [a, b, ...] instead");
              }
              if (this.isPatBinding()) {
                stmts.push(this.parsePatBinding());
              } else {
                const sb = this.peek();
                if (sb.k === "ident" && /^[A-Z]/.test(sb.v) && this.isDef()) {
                  throw new Error(
                    `Parser: '${(sb as { v: string }).v}' is capitalized — capital names ` +
                    `are constructors; use a lowercase name here`,
                  );
                }
                stmts.push(this.isDef() ? this.parseBlockDef() : this.parseExpr());
              }
            }
          }
          case "[": {
            this.next();
            // A multi-line literal: leading newlines and (optionally) one indent
            // that puts the elements on their own indented lines.
            this.skipListLeading();
            // Empty list: []
            if (this.isSym("]")) { this.next(); return { t: "list", v: [] }; }
            // A record literal looks like:  [key: value, ...]
            // Detect it by checking that the first element is `ident :`.
            if (this.peek().k === "ident" && this.peek(1).k === "sym" &&
                (this.peek(1) as { v: string }).v === ":") {
              const fs: Array<[string, Expr]> = [];
              for (;;) {
                const f = this.next();
                if (f.k !== "ident") throw new Error("Parser: expected field name");
                this.expectSym(":");
                fs.push([f.v, this.parseExpr()]);
                this.skipListSeparators();
                if (this.isSym("]")) { this.next(); return { t: "record", v: fs }; }
                if (this.peek().k === "eof") throw new Error("Parser: unexpected end of file inside record literal");
              }
            }
            // Otherwise it's a list literal: [a, b, ...] — elements separate on
            // `,` OR a newline (commas are optional when each element is on its
            // own line;  [1 2] on ONE line is still a single element = 1 applied to 2).
            const es = [] as Expr[];
            for (;;) {
              es.push(this.parseExpr());
              this.skipListSeparators();
              if (this.isSym("]")) { this.next(); return { t: "list", v: es }; }
              if (this.peek().k === "eof") throw new Error("Parser: unexpected end of file inside list literal");
            }
          }
          default:
            throw new Error(`Parser: unexpected '${this.tokenStr(t)}'`);
        }
      default:
        throw new Error(`Parser: unexpected '${this.tokenStr(t)}'`);
    }
  }

  parseKeyword(): Expr {
    const t = this.peek() as { v: string };
    switch (t.v) {
      case "match": return this.parseMatch();
      case "true": this.next(); return { t: "bool", v: true };
      case "false": this.next(); return { t: "bool", v: false };
      case "fn":
        throw new Error("`fn` is no longer supported; write `x -> body` (arrow lambda) instead");
      default:
        this.next();
        throw new Error(`Parser: unexpected keyword '${t.v}'`);
    }
  }

  parseLambda(): Expr {
    const params: string[] = [];
    let pattern: Pattern | null = null;
    // A lambda may take a leading PATTERN param (destructuring forms only):
    //   [a, b] -> ...,   (Just x) -> ...
    // A `(` + lowercase/colon form stays the annotation syntax `(x: Int) ->`.
    const t0 = this.peek();
    if (this.startsLambdaPattern(t0)) {
      pattern = this.parseConsPattern();
    } else {
      // Params may be: `a b ->` (bare) or `(a: Int) (b: Bool) ->` (parenthesized+annotated)
      while (this.peek().k === "ident" || (this.isSym("(") && this.peek(1).k === "ident")) {
        if (this.isSym("(")) {
          this.next(); // (
          while (this.peek().k === "ident") {
            params.push((this.next() as { v: string }).v);
            if (this.isSym(":")) { this.next(); this.parseType(); }
            if (this.eatSym(",")) continue;
            break;
          }
          this.expectSym(")");
        } else {
          params.push((this.next() as { v: string }).v);
          // Optional param type annotation:  x: Int -> ...
          if (this.isSym(":")) { this.next(); this.parseType(); }
        }
      }
    }
    this.expectSym("->");
    const body = this.parseExpr();
    // A pattern param desugars to:  \$p -> match $p [ { pattern -> \rest -> body } ]
    if (pattern) {
      const fresh = this.freshName();
      const nested: Expr = params.length
        ? { t: "lambda", params, body }
        : body;
      return {
        t: "lambda",
        params: [fresh],
        body: { t: "match", scrut: { t: "var", name: fresh }, alts: [{ pattern, body: nested }] },
      };
    }
    return { t: "lambda", params, body };
  }

  // A token that unambiguously begins a lambda parameter pattern. Only the
  // destructuring forms are allowed, so that literal/`_` starts can't be
  // mistaken for expressions (e.g. the guard  x | x < 0 -> ...  must not read
  // `0 -> ...` as a lambda):
  //   [a, b] -> ...,   (Just x) -> ...
  startsLambdaPattern(t: Token): boolean {
    if (t.k === "sym" && t.v === "[") return true;
    if (t.k === "sym" && t.v === "(") {
      const n1 = this.toks[this.i + 1];
      return n1.k === "ident" && /^[A-Z]/.test(n1.v);
    }
    return false;
  }

  freshCounter = 0;
  freshName(): string {
    return `$p${this.freshCounter++}`;
  }

  // Destructuring binding:  pattern = value
  //   [name, hello] = [...],  (Just x) = ...,  Just v = ...
  // Only unambiguous pattern starts are tried - `[`, `(` + Uppercase
  // constructor, or a bare Uppercase constructor - so plain statements like
  // `[1, 2, 3] $ head`, `name = 5`, or `Just (f x)` never reach the pattern
  // path.
  startsPatBinding(): boolean {
    const t = this.peek();
    if (t.k === "sym" && t.v === "[") return true;
    if (t.k === "sym" && t.v === "(") {
      const n1 = this.peek(1);
      return n1.k === "ident" && /^[A-Z]/.test(n1.v);
    }
    return t.k === "ident" && /^[A-Z]/.test(t.v);
  }

  // Lookahead: is the statement  pattern = expr ? Restores the token index.
  // A bare name LHS (even Uppercase, e.g. `Template = ...`) is a plain value
  // definition, NOT destructuring — only an actual pattern shape (a list, a
  // parenthesized/constructed pattern, or a DECLARED constructor applied to
  // args) is. An undeclared Uppercase LHS like `Vector3 x y z = ...` is a
  // record-constructor function def, not a pattern.
  isPatBinding(): boolean {
    if (!this.startsPatBinding()) return false;
    const t = this.peek();
    if (t.k === "ident" && !declaredCtors.has(t.v)) return false;
    const save = this.i;
    try {
      const p = this.parseConsPattern();
      if (p.p === "var") return false;
      return this.isSym("=");
    } catch {
      return false;
    } finally {
      this.i = save;
    }
  }

  parsePatBinding(): Expr {
    const pattern = this.parseConsPattern();
    this.expectSym("=");
    const value = this.parseExpr();
    return { t: "patDef", pattern, value };
  }

  // Operator sections:  (+ 2) -> \x -> x + 2    (2 +) -> \x -> 2 + x
  // (- 2) is NOT a section (no whitespace info in the lexer) — it stays unary
  // negation; use a lambda for that. `(+)` alone is unsupported.
  static sectionOps = ["+", "*", "/", "%", "==", "!=", "<", ">", "<=", ">=", "++"];

  tryOperatorSection(): Expr | null {
    const save = this.i;
    const t = this.peek();
    // op-front:  (+ 2)   (op followed by an operand, then ')')
    if (t.k === "sym" && t.v !== "-" && Parser.sectionOps.includes((t as { v: string }).v)) {
      try {
        this.next(); // op
        const operand = this.parseUnary();
        this.expectSym(")");
        const op = t.v as BinOp;
        return { t: "lambda", params: ["$S"], body: { t: "binop", op, l: { t: "var", name: "$S" }, r: operand } };
      } catch {
        this.i = save;
      }
    }
    // operand-front:  (2 +)   (operand, then op, then ')')
    try {
      const operand = this.parseUnary();
      const op = this.peek();
      if (op.k === "sym" && (op as { v: string }).v !== "-" &&
          Parser.sectionOps.includes((op as { v: string }).v) &&
          this.peek(1).k === "sym" && (this.peek(1) as { v: string }).v === ")") {
        this.next(); // op
        this.next(); // )
        return { t: "lambda", params: ["$S"], body: { t: "binop", op: (op as { v: string }).v as BinOp, l: operand, r: { t: "var", name: "$S" } } };
      }
    } catch {
      // fall through to the normal parenthesized-expression parse
    }
    this.i = save;
    return null;
  }

// Skip newlines, indents, AND dedents (used where layout boundaries separate
  // the parts of a single construct, e.g. a type signature).
  skipAll() {
    while (["newline", "indent", "dedent"].includes(this.peek().k)) this.next();
  }

  //  match scrutinee [ pattern -> expr, ... ]
  // The alternatives are delimited by [ ] (separators: `,` or a newline), so
  // all three layouts work:
  //    fact n = match n [0 -> 1, _ -> ...]            single line, commas
  //    fact n = match n [\n  0 -> 1\n  _ -> ...\n]    same-line open, newlines
  //    fact n =\n      match n [\n         0 -> 1\n         _ -> ...\n     ]
  // Each alternative may carry a `|` guard, exactly like the alternatives
  // `evalMatch` handles.
  parseMatch(): Expr {
    this.next(); // match
    const scrut = this.parseMatchScrut();
    const alts: Alt[] = [];
    this.expectSym("[");
    this.skipListLeading();
    for (;;) {
      this.skipListSeparators();
      if (this.isSym("]")) { this.next(); break; }
      if (this.peek().k === "eof") throw new Error("Parser: unexpected end of file inside match alternatives");
      alts.push(this.parseMatchAlt());
    }
    return { t: "match", scrut, alts };
  }

  // Application for a `match` scrutinee: identical to parseApp, but the first
  // `[` after the scrutinee starts the alternative list instead of being an
  // argument. (Nested groups parse normally, so parenthesize a scrutinee that
  // really applies a list:  match (head [1,2]) [0 -> ..., _ -> ...]).
  parseMatchScrut(): Expr {
    let f = this.parsePostfix(this.parsePrimary());
    for (;;) {
      const t = this.peek();
      if (t.k === "newline" || t.k === "dedent" || t.k === "indent" || t.k === "eof") break;
      if (t.k === "sym" && t.v === ";") break;
      if (t.k === "sym" && t.v === "[") break;
      if (t.k === "ident" || t.k === "int" || t.k === "float" || t.k === "bool" ||
          t.k === "str" || t.k === "char" ||
          (t.k === "sym" && (t.v === "(" || t.v === "{"))) {
        const a = this.parsePostfix(this.parsePrimary());
        f = { t: "app", f, a };
      } else break;
    }
    return f;
  }

  // One match alternative:  pattern [ | guard ] -> expr
  parseMatchAlt(): Alt {
    const pattern = this.parseConsPattern();
    let guard: Expr | undefined;
    if (this.isSym("|")) { this.next(); guard = this.parsePipe(); }
    this.expectSym("->");
    const body = this.parseExpr();
    return { pattern, guard, body };
  }

  // ---- top level

  // Lookahead: is the statement starting at the current identifier a binding
  // definition? Recognizes  name = expr,  name : Type = expr,  and the
  // Haskell-style  name p1 p2 p3 = expr  where each pi is a PATTERN
  // (in `[x, y]`, `(x:rest)`, `[]`, `(Just x)`, a literal, a bare var, ...),
  // optionally followed by a `: Type` annotation.
  isDef(): boolean {
    const save = this.i;
    try {
      const t = this.next(); // definition name
      if (t.k !== "ident") return false;
      // collect param patterns; a param must be a self-delimited pattern
      for (;;) {
        if (!this.startsParam(this.peek())) break;
        this.parseConsPattern();
        // optional param type annotation:  p : Type
        if (this.isSym(":")) { this.next(); this.parseType(); }
      }
      if (this.isSym("=")) return true;
      if (this.isSym(":")) {
        this.next();
        this.parseFullType();
        return this.isSym("=");
      }
      return false;
    } catch {
      return false;
    } finally {
      this.i = save;
    }
  }

  // A definition inside a `{ }` block (a statement, not a value expression).
  parseBlockDef(): Expr {
    const d = this.parseDefStatement();
    return { t: "stmDef", name: d.name, clauses: d.clauses };
  }

  // A token that can begin a definition parameter pattern.
  startsParam(t: Token): boolean {
    if (t.k === "ident") return t.v !== "_" ? true : true;
    if (t.k === "int" || t.k === "bool" || t.k === "str") return true;
    if (t.k === "sym" && (t.v === "(" || t.v === "[")) return true;
    if (t.k === "sym" && t.v === "_") return true;
    return false;
  }

  // Parse  name p1 p2 = body  (isDef() must already have returned true).
  parseDefStatement(): { name: string; clauses: { params: Pattern[]; body: Expr }[] } {
    const name = (this.next() as { v: string }).v;
    const params: Pattern[] = [];
    // Haskell-style params are PATTERNS:  f [x, y] = ..., f (x:rest) = ...
    while (this.startsParam(this.peek())) {
      params.push(this.parseConsPattern());
      // optional param type annotation:  p : Type
      if (this.isSym(":")) { this.next(); this.parseType(); }
    }
    // optional single return-type annotation:  name : Type = expr
    if (this.isSym(":")) { this.next(); this.parseType(); }
    this.next(); // =
    const body = this.parseDefBody();
    return { name, clauses: [{ params, body }] };
  }

  // A definition body is an expression. Whitespace is significant: when `=` is
  // followed by a newline, the body must continue on an INDENTED (+4) line.
  // A same-level newline (or explicit `;`) is a semicolon — the body is empty
  // and binds `unit`, so  func =\n{\n ... \n}  is `func = unit` followed by a
  // separate block statement (NOT the def body).
  parseDefBody(): Expr {
    if (this.peek().k === "newline") {
      let j = this.i;
      while (this.toks[j] && this.toks[j].k === "newline") j++;
      if (this.toks[j] && this.toks[j].k === "indent") return this.parseExpr();
      return { t: "unit" };
    }
    if (this.isSym(";")) {
      this.next();
      return { t: "unit" };
    }
    return this.parseExpr();
  }

  parseTopLevel(): TopLevel[] {
    const out: TopLevel[] = [];
    for (;;) {
      this.skipNL();
      // swallow stray dedents
      while (this.peek().k === "dedent") this.next();
      this.skipNL();
      // explicit semicolons are statement separators, like newlines
      while (this.isSym(";")) {
        this.next();
        this.skipNL();
        while (this.peek().k === "dedent") this.next();
        this.skipNL();
      }

      const t = this.peek();
      if (t.k === "eof") break;

      if (t.k === "kw" && t.v === "data") {
        this.next();
        const name = (this.next() as { v: string }).v;
        // optional type params (uppercase following) -> ignore
        while (this.peek().k === "ident") this.next();
        if (this.eatSym("=")) {
        }
        const variants: { tag: string; arity: number }[] = [];
        for (;;) {
          this.skipNL();
          const vt = this.peek();
          if (vt.k !== "ident" && vt.k !== "kw") break;
          const vname = (this.next() as { v: string }).v;
          // count constructor arguments (idents right after, but careful with keywords)
          let arity = 0;
          while (this.peek().k === "ident") {
            // a type like "Int"/"a" bound as arg
            arity++;
            this.next();
          }
variants.push({ tag: vname, arity });
      declaredCtors.add(vname);
      if (!this.eatSym("|")) break;
        }
        out.push({ t: "data", def: { name, variants } });
        continue;
      }

      if (t.k === "kw") {
        // top-level expression starting with a keyword: fn/match
        const e = this.parseKeyword();
        out.push({ t: "expr", value: e });
        continue;
      }

      if (t.k === "ident") {
        // Haskell-style type signature:  f :: Int -> Int   (annotation, discarded)
        if (this.peek(1).k === "sym" && (this.peek(1) as { v: string }).v === "::") {
          this.next(); // name
          this.next(); // ::
          this.parseFullType();
          continue;
        }
        // A binding definition. Supports the Haskell-style param form too:
        //   name = expr            name a b c = expr
        //   name : Type = expr
        // An Uppercase constructor on the LHS is a destructuring BINDING
        // (Just v = ...), not a function definition.
        if (this.isPatBinding()) {
          out.push(this.parsePatBinding() as TopLevel);
          continue;
        }
        // Capital names are CONSTRUCTORS, never value/function names: a plain
        // capital def is an error (declare it in `data`, destructure with it,
        // or use a lowercase name).
        if (/^[A-Z]/.test(t.v)) {
          if (this.isDef()) {
            throw new Error(
              `Parser: '${t.v}' is capitalized — capital names are constructors, ` +
              `so a value/function must use a lowercase name (or '${t.v}' must be ` +
              `declared in a \`data\` block to destructure on the left of =)`,
            );
          }
          const e = this.parseExpr();
          out.push({ t: "expr", value: e });
          continue;
        }
        if (this.isDef()) {
          const d = this.parseDefStatement();
          out.push({ t: "def", name: d.name, clauses: d.clauses });
        } else {
          const e = this.parseExpr();
          out.push({ t: "expr", value: e });
        }
        continue;
      }

      if (t.k === "sym") {
        if (this.isPatBinding()) {
          out.push(this.parsePatBinding() as TopLevel);
        } else {
          const e = this.parseExpr();
          out.push({ t: "expr", value: e });
        }
        continue;
      }

      if (t.k === "int" || t.k === "float" || t.k === "bool" ||
          t.k === "str" || t.k === "char" || t.k === "opw") {
        const e = this.parseExpr();
        out.push({ t: "expr", value: e });
        continue;
      }

      throw new Error(`Parser: unexpected '${this.tokenStr(t)}'`);
    }
    return out;
  }
}

// Constructors declared via `data`. This is what makes an Uppercase LHS with
// args ambiguous: `Just v = ...` destructures only when `Just` was DECLARED a
// constructor; otherwise `Vector3 x y z = [x: x, y: y, z: z]` stays a plain
// (record-constructor) function def. Module-level so declarations persist
// across REPL lines (each line is re-parsed standalone).
let declaredCtors = new Set<string>();

export function parse(src: string): TopLevel[] {
  const toks = lex(src);
  const out = new Parser(toks).parseTopLevel();
  return groupClauses(out);
}

// Merge consecutive Haskell-style clauses of the same function:
//   len [] = 0
//   len (x:rest) = 1 + len rest
// becomes one def with two clauses. Only same-name defs that carry parameters
// (params.length >= 1) with equal arity are grouped; value defs stay separate
// (consecutive re-bindings still behave as last-wins aliases, as before).
function groupClauses(program: TopLevel[]): TopLevel[] {
  const result: TopLevel[] = [];
  for (const tl of program) {
    if (tl.t === "def" && tl.clauses[0] && tl.clauses[0].params.length >= 1) {
      const last = result[result.length - 1];
      if (last && last.t === "def" &&
          last.name === tl.name &&
          last.clauses[0].params.length === tl.clauses[0].params.length) {
        last.clauses.push(...tl.clauses);
        continue;
      }
    }
    result.push(tl);
  }
  return result;
}

// ---------------- Evaluator ----------------

const STACK_LIMIT = 100000;

export class Interpreter {
  env = new Env();
  stack = 0;
  // Directory of the source file currently being evaluated — `load` resolves
  // relative paths against it ("relative to your current file").
  sourceDir: string = ".";

  constructor() {
    this.env.setLocal("print", { kind: "native", name: "print", arity: 1, applied: [] });
    this.env.setLocal("head", { kind: "native", name: "head", arity: 1, applied: [] });
    this.env.setLocal("tail", { kind: "native", name: "tail", arity: 1, applied: [] });
    this.env.setLocal("length", { kind: "native", name: "length", arity: 1, applied: [] });
    this.env.setLocal("null", { kind: "native", name: "null", arity: 1, applied: [] });
    this.env.setLocal("map", { kind: "native", name: "map", arity: 2, applied: [] });
    this.env.setLocal("filter", { kind: "native", name: "filter", arity: 2, applied: [] });
    this.env.setLocal("foldl", { kind: "native", name: "foldl", arity: 3, applied: [] });
    this.env.setLocal("foldr", { kind: "native", name: "foldr", arity: 3, applied: [] });
    this.env.setLocal("intToString", { kind: "native", name: "intToString", arity: 1, applied: [] });
    this.env.setLocal("for", { kind: "native", name: "for", arity: 2, applied: [] });
    this.env.setLocal("pairs", { kind: "native", name: "pairs", arity: 1, applied: [] });
    this.env.setLocal("format", { kind: "native", name: "format", arity: 2, applied: [] });
    this.env.setLocal("toString", { kind: "native", name: "toString", arity: 1, applied: [] });
    this.env.setLocal("parse", { kind: "native", name: "parse", arity: 1, applied: [] });
    this.env.setLocal("debug", { kind: "native", name: "debug", arity: 1, applied: [] });
    this.env.setLocal("exit", { kind: "native", name: "exit", arity: 1, applied: [] });
    this.env.setLocal("load", { kind: "native", name: "load", arity: 1, applied: [] });
  }

  run(program: TopLevel[]): Value {
    let last: Value = { kind: "unit" };
    for (const tl of program) {
      if (tl.t === "data") {
        for (const v of tl.def.variants) {
          if (v.arity === 0) {
            // Nullary constructors are themselves the value.
            this.env.setLocal(v.tag, { kind: "variant", tag: v.tag, v: [] });
          } else {
            this.env.setLocal(v.tag, {
              kind: "native", name: "__constr", arity: v.arity, applied: [], tag: v.tag,
            });
          }
        }
        continue;
      }
      if (tl.t === "def") {
        last = this.evalDef(tl.name, tl.clauses);
        continue;
      }
      if (tl.t === "patDef") {
        last = this.evalPatBinding(tl);
        continue;
      }
      last = this.force(this.eval(tl.value));
    }
    return last;
  }

  evalDef(name: string, clauses: DefClause[]): Value {
    // A def with parameters is a pattern-dispatch function.
    if (clauses[0].params.length >= 1) {
      const arity = clauses[0].params.length;
      // Capture a shared env containing the binding itself, enabling recursion.
      const child = new Env(this.env);
      const fn: Value = {
        kind: "clauseFn", clauses, arity, env: child, applied: [],
      };
      child.setLocal(name, fn);
      this.env.setLocal(name, fn);
      return fn;
    }
    // Value-style def: single clause, no params.
    const value = clauses[0].body;
    // Lambda bodies become closures (with recursion via shared env), like before.
    if (value.t === "lambda") {
      const child = new Env(this.env);
      const clo: Value = { kind: "closure", params: value.params, body: value.body, env: child };
      child.setLocal(name, clo);
      this.env.setLocal(name, clo);
      return clo;
    }
    // Otherwise it's a lazy value binding: a THUNK. The body is not run at
    // definition time — it runs (and is cached) the first time the name is
    // forced. This is what lets core.txt define `halt = exit 0` without the
    // process exiting at load time.
    const thunk: Value = { kind: "thunk", body: value, env: this.env, value: undefined };
    this.env.setLocal(name, thunk);
    return thunk;
  }

  // Destructuring binding:  [name, hello] = value  (or (Just x) = value, ...).
  // Evaluates the RHS, matches the pattern, and binds the destructured names
  // in the CURRENT environment (top level or the enclosing block's env).
  evalPatBinding(b: { pattern: Pattern; value: Expr }): Value {
    const v = this.force(this.eval(b.value));
    const binds = new Map<string, Value>();
    if (!this.matchPattern(b.pattern, v, binds)) {
      throw new Error("Runtime: binding pattern did not match its value");
    }
    for (const [k, bv] of binds) this.env.setLocal(k, bv);
    return v;
  }

  eval(e: Expr): Value {
    if (++this.stack > STACK_LIMIT) throw new Error("Runtime: stack overflow");
    let r: Value;
    switch (e.t) {
      case "int": r = mkInt(e.v); break;
      case "float": r = { kind: "float", v: e.v }; break;
      case "bool": r = mkBool(e.v); break;
      case "string": r = mkStr(e.v); break;
      case "char": r = { kind: "char", v: e.v }; break;
      case "unit": r = { kind: "unit" }; break;
      case "var": {
        const v = this.env.get(e.name);
        if (v === undefined) throw new Error(`Runtime: unbound variable '${e.name}'`);
        r = v;
        break;
      }
      case "binop": r = this.evalBinop(e); break;
      case "unop": {
        const v = this.eval(e.e);
        if (e.op === "neg") {
          r = (v.kind === "int" || v.kind === "float")
            ? { kind: v.kind === "int" ? "int" : "float", v: -v.v } as Value
            : { kind: "unit" };
        } else {
          r = v.kind === "bool" ? mkBool(!v.v) : { kind: "unit" };
        }
        break;
      }
      case "app": r = this.apply(this.eval(e.f), this.eval(e.a)); break;
      case "lambda": r = { kind: "closure", params: e.params, body: e.body, env: this.env }; break;
      case "ternary": {
        const c = this.force(this.eval(e.cond));
        r = (c.kind === "bool" && c.v) ? this.eval(e.then) : this.eval(e.els);
        break;
      }
      case "match": r = this.evalMatch(this.force(this.eval(e.scrut)), e.alts); break;
      case "list": r = { kind: "lazyList", exprs: e.v, env: this.env }; break;
      case "record": r = { kind: "record", v: e.v.map(([k, x]) => [k, this.eval(x)] as [string, Value]) }; break;
      case "recordAccess": {
        let rec = this.eval(e.rec);
        // `core = load "..."` is a thunk; get the module WITHOUT forcing its
        // fields (a module may contain `halt = exit 0`).
        if (rec.kind === "thunk") rec = this.unpackThunk(rec);
        if (rec.kind === "lazyList" && rec.exprs.every((ex) => ex.t === "var")) {
          // A bare-name list used as an OBJECT is its index enum:
          // field -> position, so  [x, y, z] === [x: 0, y: 1, z: 2]
          const names = rec.exprs as { t: "var"; name: string }[];
          const i = names.findIndex((n) => n.name === e.field);
          if (i < 0) throw new Error(`Runtime: record has no field '${e.field}'`);
          r = { kind: "int", v: i };
          break;
        }
        if (rec.kind !== "record") throw new Error("Runtime: record access on non-record");
        const f = rec.v.find(([k]) => k === e.field);
        if (!f) throw new Error(`Runtime: record has no field '${e.field}'`);
        r = f[1];
        break;
      }
      case "fromList": {
        const vals = this.force(this.eval(e.values));
        if (vals.kind !== "list" && vals.kind !== "record") {
          throw new Error("Runtime: right side of '.' must be a list or a record");
        }
        // Resolve the prototype: a record keeps its VALUES (defaults); a
        // name list (or recordTemplate) is names-only, no defaults.
        let protoNames: string[];
        let protoRec: Array<[string, Value]> | undefined;
        if (e.template.t === "recordTemplate") {
          protoNames = e.template.names;
        } else {
          let src = this.eval(e.template);
          if (src.kind === "thunk") src = this.unpackThunk(src);
          if (src.kind === "lazyList") {
            protoNames = [];
            for (const ex of src.exprs) {
              if (ex.t !== "var") throw new Error("Runtime: template must be a list of names or a record");
              protoNames.push(ex.name);
            }
          } else if (src.kind === "record") {
            protoNames = src.v.map(([k]) => k);
            protoRec = src.v.slice();
          } else {
            throw new Error("Runtime: left side of '.' must be a name template or a record");
          }
        }
        if (vals.kind === "list") {
          // Positional clone: one value per prototype field, in order.
          if (protoNames.length !== vals.v.length) {
            throw new Error(`Runtime: field count (${protoNames.length}) does not match list size (${vals.v.length})`);
          }
          r = { kind: "record", v: protoNames.map((k, i) => [k, vals.v[i]] as [string, Value]) };
        } else {
          // Named clone: override existing fields, append new ones.
          if (protoRec !== undefined) {
            const idx = new Map(protoNames.map((n, i) => [n, i]));
            const out = protoRec.slice();
            for (const [k, v] of vals.v as Array<[string, Value]>) {
              const i = idx.get(k);
              if (i !== undefined) out[i] = [k, v]; else out.push([k, v]);
            }
            r = { kind: "record", v: out };
          } else {
            // Names-only prototype — it has INDEX DEFAULTS (an index enum):
            // every omitted field defaults to its position.
            const byName = new Map(vals.v as Array<[string, Value]>);
            r = { kind: "record", v: protoNames.map((k, i) => [k, byName.get(k) ?? { kind: "int", v: i }]) };
          }
        }
        break;
      }
      case "pipe": r = this.apply(this.eval(e.f), this.eval(e.x)); break;
      case "recordTemplate":
        throw new Error("Runtime: internal error — record template used as a value");
      case "block": {
        const child = new Env(this.env);
        const old = this.env;
        this.env = child;
        try {
          r = { kind: "unit" };
          for (const s of e.stmts) {
            if (s.t === "stmDef") r = this.evalDef(s.name, s.clauses);
            else if (s.t === "patDef") r = this.evalPatBinding(s);
            else r = this.eval(s);
          }
          // A block's value is its last statement's value — force it, so a
          // trailing `halt`/`exit` (or any thunk) actually runs.
          r = this.force(r);
        } finally {
          this.env = old;
        }
        break;
      }
      case "stmDef":
        throw new Error("Runtime: internal error — statement definition used as an expression");
      case "patDef":
        r = this.evalPatBinding(e);
        break;
    }
    this.stack--;
    return r;
  }

  evalBinop(e: Extract<Expr, { t: "binop" }>): Value {
    const l = this.force(this.eval(e.l));
    const r = this.force(this.eval(e.r));
    switch (e.op) {
      case "+":
        if (l.kind === "int" && r.kind === "int") return mkInt(l.v + r.v);
        if (l.kind === "float" && r.kind === "float") return { kind: "float", v: l.v + r.v };
        if (l.kind === "string" && r.kind === "string") return mkStr(l.v + r.v);
        throw new Error("Runtime: cannot add these values");
      case "-":
        if (l.kind === "int" && r.kind === "int") return mkInt(l.v - r.v);
        if (l.kind === "float" && r.kind === "float") return { kind: "float", v: l.v - r.v };
        throw new Error("Runtime: cannot subtract");
      case "*":
        if (l.kind === "int" && r.kind === "int") return mkInt(l.v * r.v);
        if (l.kind === "float" && r.kind === "float") return { kind: "float", v: l.v * r.v };
        throw new Error("Runtime: cannot multiply");
      case "/":
        if (r.kind === "int" && r.v === 0) throw new Error("Runtime: division by zero");
        if (r.kind === "float" && r.v === 0) throw new Error("Runtime: division by zero");
        if (l.kind === "int" && r.kind === "int") return mkInt(Math.trunc(l.v / r.v));
        if (l.kind === "float" && r.kind === "float") return { kind: "float", v: l.v / r.v };
        throw new Error("Runtime: cannot divide");
      case "%":
        if (l.kind === "int" && r.kind === "int") return mkInt(l.v % r.v);
        throw new Error("Runtime: cannot modulo");
      case "==": return mkBool(this.equals(l, r));
      case "!=": return mkBool(!this.equals(l, r));
      case "<": return this.compare(l, r) < 0 ? mkBool(true) : mkBool(false);
      case ">": return this.compare(l, r) > 0 ? mkBool(true) : mkBool(false);
      case "<=": return this.compare(l, r) <= 0 ? mkBool(true) : mkBool(false);
      case ">=": return this.compare(l, r) >= 0 ? mkBool(true) : mkBool(false);
      case "&&":
        if (l.kind === "bool" && r.kind === "bool") return mkBool(l.v && r.v);
        throw new Error("Runtime: cannot AND");
      case "||":
        if (l.kind === "bool" && r.kind === "bool") return mkBool(l.v || r.v);
        throw new Error("Runtime: cannot OR");
      case "++":
        if (l.kind === "string" && r.kind === "string") return mkStr(l.v + r.v);
        if (l.kind === "list" && r.kind === "list") return mkList([...l.v, ...r.v]);
        throw new Error("Runtime: cannot concatenate");
      case ":":
        if (r.kind === "list") return mkList([l, ...r.v]);
        throw new Error("Runtime: cannot cons to non-list");
    }
  }

  equals(a: Value, b: Value): boolean {
    if (a.kind !== b.kind) return false;
    switch (a.kind) {
      case "int": return a.v === (b as any).v;
      case "float": return a.v === (b as any).v;
      case "bool": return a.v === (b as any).v;
      case "string": return a.v === (b as any).v;
      case "char": return a.v === (b as any).v;
      case "unit": return true;
      case "list": {
        const bl = b as any;
        if (a.v.length !== bl.v.length) return false;
        return a.v.every((x, i) => this.equals(x, bl.v[i]));
      }
      case "variant": {
        const bv = b as any;
        return a.tag === bv.tag && this.equals({ kind: "list", v: a.v }, { kind: "list", v: bv.v });
      }
      case "nomatch": return true;
      default: return false;
    }
  }

  compare(a: Value, b: Value): number {
    if (a.kind === "int" && b.kind === "int") return a.v - b.v;
    if (a.kind === "float" && b.kind === "float") return a.v - b.v;
    if (a.kind === "string" && b.kind === "string") return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
    if (a.kind === "char" && b.kind === "char") return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
    throw new Error("Runtime: cannot compare these values");
  }

  apply(f: Value, arg: Value): Value {
    // A lazy 0-param def used as a function (`f = g; f 1`) is a thunk — run it.
    if (f.kind === "thunk") f = this.force(f);
    switch (f.kind) {
      case "closure": {
        const child = new Env(f.env);
        child.setLocal(f.params[0], arg);
        if (f.params.length === 1) {
          const old = this.env;
          this.env = child;
          try { return this.eval(f.body); } finally { this.env = old; }
        }
        return { kind: "closure", params: f.params.slice(1), body: f.body, env: child };
      }
      case "native": {
        if (f.arity === 0) {
          return this.callNative(f.name, [], f.tag);
        }
        f.applied.push(arg);
        if (f.applied.length < f.arity) return f;
        const args = f.applied;
        f.applied = [];
        return this.callNative(f.name, args, f.tag);
      }
      case "clauseFn": {
        f.applied.push(arg);
        if (f.applied.length < f.arity) return f;
        const args = f.applied.map((a) => this.force(a));
        f.applied = [];
        // Try each clause in order; a clause matches when ALL its params match.
        for (const clause of f.clauses) {
          const binds = new Map<string, Value>();
          let ok = true;
          for (let i = 0; i < clause.params.length; i++) {
            if (!this.matchPattern(clause.params[i], args[i], binds)) { ok = false; break; }
          }
          if (!ok) continue;
          const child = new Env(f.env);
          for (const [k, v] of binds) child.setLocal(k, v);
          const old = this.env;
          this.env = child;
          try { return this.eval(clause.body); } finally { this.env = old; }
        }
        throw new Error("Runtime: non-exhaustive function definition");
      }
      default:
        throw new Error("Runtime: value is not a function");
    }
  }

  // Lazily evaluate a deferred list (and everything nested inside it) into a
  // concrete value. A deferred list, when used as a list, resolves its elements
  // as ordinary variables; when used as an object/template it is never forced
  // and its bare identifiers are read as field names.
  force(v: Value): Value {
    if (v.kind === "lazyList") {
      const old = this.env;
      this.env = v.env;
      try {
        return mkList(v.exprs.map((x) => this.force(this.eval(x))));
      } finally {
        this.env = old;
      }
    }
    if (v.kind === "thunk") {
      if (v.value) return v.value;
      const old = this.env;
      this.env = v.env;
      try {
        v.value = this.force(this.eval(v.body));
      } finally {
        this.env = old;
      }
      return v.value;
    }
    if (v.kind === "list") return mkList(v.v.map((x) => this.force(x)));
    if (v.kind === "variant") return { kind: "variant", tag: v.tag, v: v.v.map((x) => this.force(x)) };
    if (v.kind === "record") {
      // Keep thunk fields lazy: a `load` module record may contain `halt = exit 0`
      // and forcing it would terminate the process on import.
      return { kind: "record", v: v.v.map(([k, x]) => [k, x.kind === "thunk" ? x : this.force(x)] as [string, Value]) };
    }
    return v;
  }

  // Evaluate a thunk's BODY but keep the result lazy (do NOT recurse/force).
  // Used where the raw value matters — a `load` module record (whose fields must
  // NOT be forced, they may contain `halt`) or a template lazyList (whose bare
  // names must stay unresolved). A non-lazy result is cached like force does.
  unpackThunk(v: Value): Value {
    if (v.kind !== "thunk") return v;
    if (v.value) return v.value;
    const old = this.env;
    this.env = v.env;
    try {
      const r = this.eval(v.body);
      if (r.kind !== "lazyList") v.value = r;
      return r;
    } finally {
      this.env = old;
    }
  }

  callNative(name: string, argsIn: Value[], tag?: string): Value {
    const args = argsIn.map((x) => this.force(x));
    const a = args[0];
    switch (name) {
      case "print": {
        if (a.kind !== "string") throw new Error("Runtime: print expects a string (use toString or debug for other values)");
        console.log(a.v);
        return { kind: "unit" };
      }
      case "debug":
        console.log(valueToString(a));
        return { kind: "unit" };
      case "toString":
        return mkStr(valueToString(a));
      case "parse": {
        if (a.kind !== "string") throw new Error("Runtime: parse expects a string");
        const s = a.v.trim();
        if (s === "true") return mkBool(true);
        if (s === "false") return mkBool(false);
        if (/^-?\d+$/.test(s)) return mkInt(parseInt(s, 10));
        if (/^-?\d+\.\d+$/.test(s)) return { kind: "float", v: parseFloat(s) };
        throw new Error(`Runtime: parse: can't parse '${s}'`);
      }
      case "head":
        if (a.kind !== "list") throw new Error("Runtime: head expects a list");
        if (a.v.length === 0) throw new Error("Runtime: head of empty list");
        return a.v[0];
      case "tail":
        if (a.kind !== "list") throw new Error("Runtime: tail expects a list");
        if (a.v.length === 0) throw new Error("Runtime: tail of empty list");
        return mkList(a.v.slice(1));
      case "length":
        if (a.kind === "list") return mkInt(a.v.length);
        if (a.kind === "string") return mkInt(a.v.length);
        throw new Error("Runtime: length expects list or string");
      case "null":
        if (a.kind === "list") return mkBool(a.v.length === 0);
        if (a.kind === "string") return mkBool(a.v.length === 0);
        throw new Error("Runtime: null expects list or string");
      case "map": {
        const f = args[0];
        if (args[1].kind !== "list") throw new Error("Runtime: map expects a list");
        return mkList(args[1].v.map((x) => this.apply(f, x)));
      }
      case "filter": {
        const p = args[0];
        if (args[1].kind !== "list") throw new Error("Runtime: filter expects a list");
        return mkList(args[1].v.filter((x) => {
          const r = this.apply(p, x);
          return r.kind === "bool" && r.v;
        }));
      }
      case "foldl": {
        const f = args[0];
        let acc = args[1];
        if (args[2].kind !== "list") throw new Error("Runtime: foldl expects a list");
        for (const x of args[2].v) acc = this.apply(this.apply(f, acc), x);
        return acc;
      }
      case "foldr": {
        const f = args[0];
        let acc = args[1];
        if (args[2].kind !== "list") throw new Error("Runtime: foldr expects a list");
        for (let i = args[2].v.length - 1; i >= 0; i--) {
          acc = this.apply(this.apply(f, args[2].v[i]), acc);
        }
        return acc;
      }
      case "intToString":
        if (a.kind !== "int") throw new Error("Runtime: intToString expects int");
        return mkStr(String(a.v));
      case "for": {
        // for : fn -> seq -> unit   (like map, but discards results, runs effects)
        // seq is a list (yields each element) or a record (yields each entry
        // as a [field, value] list).
        const f = args[0];
        const seq = args[1];
        if (seq.kind === "list") {
          for (const x of seq.v) this.apply(f, x);
        } else if (seq.kind === "record") {
          for (const [k, v] of seq.v) {
            this.apply(f, mkList([mkStr(k), v]));
          }
        } else throw new Error("Runtime: for expects a list or a record");
        return { kind: "unit" };
      }
      case "pairs":
        if (a.kind !== "record") throw new Error("Runtime: pairs expects a record");
        return mkList(a.v.map(([k, v]) => mkList([mkStr(k), v])));
      case "format": {
        const fmt = args[0];
        if (fmt.kind !== "string") throw new Error("Runtime: format expects a string");
        const vals = args[1].kind === "list" ? args[1].v : [args[1]];
        let out = "";
        let vi = 0;
        for (let i = 0; i < fmt.v.length; i++) {
          if (fmt.v[i] === "%") {
            if (fmt.v[i + 1] === "%") { out += "%"; i++; continue; }
            out += rawString(vals[vi] ?? { kind: "unit" });
            vi++;
          } else out += fmt.v[i];
        }
        return mkStr(out);
      }
      case "__constr":
        return { kind: "variant", tag: tag!, v: args };
      case "exit":
        // Can be put anywhere in the program: terminates the process instantly.
        if (a.kind !== "int") throw new Error("Runtime: exit expects an int status code");
        return Deno.exit(a.v);
      case "load": {
        // Import a file, resolving the path relative to the CURRENT source file.
        // Two effects: (1) the loaded file's own definitions are merged into the
        // current scope ("include"); (2) it returns a module record of them, so
        //   core = load "core.txt"; core.halt   (or just core.halt) works.
        // Inside a `{ }` block the merge stays scoped to that block.
        if (a.kind !== "string") throw new Error("Runtime: load expects a file path string");
        const p = a.v;
        const path =
          this.sourceDir === "." || p.startsWith("/") ? p : `${this.sourceDir}/${p}`;
        let src: string;
        try {
          src = Deno.readTextFileSync(path);
        } catch (err) {
          throw new Error(`Runtime: load: can't read '${p}' (looked in '${path}'): ${(err as Error).message}`);
        }
        let program: TopLevel[];
        try {
          program = parse(src);
        } catch (err) {
          throw new Error(`Runtime: load: parse error in '${path}': ${(err as Error).message}`);
        }
        const caller = this.env;
        const oldDir = this.sourceDir;
        this.sourceDir = dirname(path);
        const loaded = new Env(caller);
        this.env = loaded;
        try {
          this.run(program);
        } finally {
          this.env = caller;
          this.sourceDir = oldDir;
        }
        // Merge the loaded file's own definitions into the current scope,
        // and return them as a module record (namespaced access: core.halt).
        const fields: Array<[string, Value]> = [];
        for (const [k, val] of loaded.map) {
          caller.setLocal(k, val);
          fields.push([k, val]);
        }
        return { kind: "record", v: fields };
      }
    }
    throw new Error(`Runtime: unknown native '${name}'`);
  }

  // constructor application needs to remember the tag; we use a closure wrapper
  // handled separately in evalDef for data. For simplicity we wrap in apply.

  matchPattern(p: Pattern, v: Value, binds: Map<string, Value>): boolean {
    switch (p.p) {
      case "wildcard": return true;
      case "var":
        binds.set(p.name, v);
        return true;
      case "int": return v.kind === "int" && v.v === p.v;
      case "bool": return v.kind === "bool" && v.v === p.v;
      case "string": return v.kind === "string" && v.v === p.v;
      case "list": {
        if (v.kind === "record") {
          // A var-only list pattern destructures a record by field name:
          //   [x, y]  matches  [x: 1, y: 2]  binding x=1, y=2
          const fields = new Map<string, Value>();
          for (const [k, val] of v.v) fields.set(k, val);
          for (const el of p.v) {
            if (el.p !== "var") return false;
            if (!fields.has(el.name)) return false;
            binds.set(el.name, fields.get(el.name)!);
          }
          return true;
        }
        if (v.kind !== "list" || v.v.length !== p.v.length) return false;
        for (let i = 0; i < p.v.length; i++) {
          if (!this.matchPattern(p.v[i], v.v[i], binds)) return false;
        }
        return true;
      }
      case "cons": {
        if (v.kind !== "list" || v.v.length === 0) return false;
        const nm = new Map(binds);
        if (!this.matchPattern(p.head, v.v[0], nm)) return false;
        return this.matchPattern(p.tail, mkList(v.v.slice(1)), nm) && this.mergeBinds(binds, nm);
      }
      case "constr": {
        if (v.kind !== "variant" || v.tag !== p.tag) return false;
        if (v.v.length !== p.args.length) return false;
        for (let i = 0; i < p.args.length; i++) {
          if (!this.matchPattern(p.args[i], v.v[i], binds)) return false;
        }
        return true;
      }
    }
  }

  mergeBinds(orig: Map<string, Value>, added: Map<string, Value>): boolean {
    for (const [k, v] of added) orig.set(k, v);
    return true;
  }

  evalMatch(scrut: Value, alts: Alt[]): Value {
    for (const alt of alts) {
      const binds = new Map<string, Value>();
      if (!this.matchPattern(alt.pattern, scrut, binds)) continue;
      if (alt.guard) {
        const g = this.evalWith(binds, alt.guard);
        if (!(g.kind === "bool" && g.v)) continue;
      }
      return this.evalWith(binds, alt.body);
    }
    throw new Error("Runtime: non-exhaustive match");
  }

  evalWith(binds: Map<string, Value>, e: Expr): Value {
    const child = new Env(this.env);
    for (const [k, v] of binds) child.setLocal(k, v);
    const old = this.env;
    this.env = child;
    try { return this.eval(e); } finally { this.env = old; }
  }
}

// Directory part of a path (no external deps).
function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  if (i < 0) return ".";
  return i === 0 ? "/" : p.slice(0, i);
}

// ---------------- REPL ----------------

function runSource(src: string, interp: Interpreter, quiet = false): string {
  let program: TopLevel[];
  try {
    program = parse(src);
  } catch (err) {
    throw new Error(
      `Parse error: ${(err as Error).message}\n` +
      `  source:\n${src.split("\n").map((l) => "    " + l).join("\n")}`
    );
  }
  let val: Value;
  try {
    val = interp.run(program);
  } catch (err) {
    throw new Error(`Runtime error: ${(err as Error).message}`);
  }
  if (!quiet) val = interp.force(val);
  if (!quiet && val.kind !== "unit") return valueToString(val);
  return "";
}

async function repl(): Promise<void> {
  console.log("Sloth interpreter v1.0.0");
  console.log("Lazy, Haskell-like, untyped like JS, annotated like TS.");
  console.log("Commands: :help :quit");
  console.log();
  const interp = new Interpreter();

  const decoder = new TextDecoder();
  const buf = new Uint8Array(1024);
  const stdin = Deno.stdin;

  let pending = "";
  const prompt = "> ";

  const processBuffer = (chunk: string): string[] => {
    return chunk.split("\n");
  };

  let leftover = "";

  // We drive input manually; print the initial prompt.
  await Deno.stdout.write(new TextEncoder().encode(prompt));

  while (true) {
    const n = await stdin.read(buf);
    if (n === null) break;
    const chunk = decoder.decode(buf.subarray(0, n));
    leftover += chunk;
    const lines = processBuffer(leftover);
    leftover = lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (line.length === 0) {
        await Deno.stdout.write(new TextEncoder().encode(prompt));
        continue;
      }
      if (line === ":quit" || line === ":q") {
        console.log("bye");
        return;
      }
      if (line === ":help" || line === ":h") {
        console.log(
          [
            `Language:`,
            `  symbol = value   (the ONLY binding form; top level or inside { } blocks)`,
            `  [a, b] = value (destructuring binding; records match by field name)`,
            `  Just v = value (declared constructors destructure; capital defs are errors)`,
            `  bare-name list as OBJECT = index enum ([x, y, z] => [x:0, y:1, z:2]); as list => vars`,
            `  proto.[1,2,3] / proto.[x: 1]  prototype clone: positional or named`,
            `  x -> expr        (lambdas; first param may be [a, b] or (Ctor ..))`,
            `  cond ? a : b   (ternary)`,
            `  match x [ pat -> expr, ... ]   (all patterns, | guards; , or newline)`,
            `  data Maybe a = Just a | Nothing`,
            `  [1,2,3]  [name: "x", age: 2]   (newlines also separate elements)`,
            `  x $ f             pipe: feeds x into f`,
            `  a \`f\` b            infix call == f a b  (only \`for\` inverts)`,
            `  (+ 2)  (2 +)      operator sections   ((-2) stays unary minus)`,
            `  ( ) and { } are groups/blocks: unit when empty, value = last stmt`,
            `  ; or newline       statement separators (blocks & top level)`,
            `  indentation: strict 4-space layout (exactly +4 per level)`,
            `  for (x -> print x) [1,2,3]   for fn seq`,
            `  recursion, higher-order fns, records, variants`,
            ``,
            `Builtins: print (string only) toString parse debug`,
            `          head tail length null map filter foldl foldr`,
            `          for pairs format intToString exit load`,
            ``,
            `load "core.txt"  imports the standard library (core.txt): as a`,
            `               statement it merges into the current scope; as a`,
            `               value it returns a module (core.sq 4). halting is`,
            `               core.txt's  halt = exit 0  (lazy: fires only when used).`,
            `0-arg value defs are LAZY:  x = <expr>  runs <expr> on first use.`,
            ``,
            `Type annotations (TS-style) are accepted & ignored at runtime:`,
            `  let x: Int = 5`,
            `Run: deno run --allow-read main.ts features.txt`,
          ].join("\n")
        );
        await Deno.stdout.write(new TextEncoder().encode(prompt));
        continue;
      }

      pending = pending ? pending + "\n" + line : line;
      // Try to evaluate; if the parse error indicates an incomplete block
      // (missing `in`, `->`, or a structural `newline`), keep accumulating so
      // users can enter multi-line constructs. Otherwise report the error.
      try {
        const out = runSource(pending, interp);
        if (out) console.log(out);
        pending = "";
        await Deno.stdout.write(new TextEncoder().encode(prompt));
        continue;
      } catch (err) {
        const msg = (err as Error).message;
        if (/expected '->'|unexpected 'newline'|unexpected 'EOF'|unexpected 'indent'|unexpected 'dedent'|expected 'then'|expected 'else'/.test(msg)) {
          // Possibly incomplete — keep going.
          await Deno.stdout.write(new TextEncoder().encode("... "));
          continue;
        }
        // Real error: show it, reset pending.
        console.log("Error:", msg);
        pending = "";
        await Deno.stdout.write(new TextEncoder().encode(prompt));
        continue;
      }
    }
    if (leftover !== "") {
      await Deno.stdout.write(new TextEncoder().encode(prompt));
    }
  }
}

// ---------------- main ----------------

if (import.meta.main) {
  const _args = Deno.args;

  if (_args.length >= 1 && !_args[0]?.startsWith(":")) {
    const file = _args[0];
    const src = Deno.readTextFileSync(file);
    const interp = new Interpreter();
    interp.sourceDir = dirname(file);
    runSource(src, interp);
  } else {
    repl().catch((err) => {
      console.error(err);
      Deno.exit(1);
    });
  }
}
