#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env=HOME

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
  | { t: "recordAccess"; rec: Expr; field: string | Expr }
  | { t: "pluck"; rec: Expr; entries: Array<string | [string, string]> }
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
  | { p: "constr"; tag: string; args: Pattern[] }
  | { p: "recPat"; v: Array<[string, string]> };

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
      const keyed = [] as Array<[string, string]>;
      let mode: "bare" | "keyed" | undefined;
      while (!this.isSym("]")) {
        const k = this.peek();
        const keyStart = k.k === "ident" || k.k === "str" || k.k === "int" || k.k === "float";
        const nextSym = this.toks[this.i + 1];
        if (keyStart && nextSym && nextSym.k === "sym" && (nextSym as { v: string }).v === ":") {
          if (mode === "bare") throw new Error("Parser: pattern cannot mix bare names and 'key: name' entries");
          mode = "keyed";
          this.next();
          const key = this.keyTok(k);
          this.next(); // :
          const nm = this.next();
          if (nm.k !== "ident") throw new Error("Parser: expected a binding name after ':' in record pattern");
          keyed.push([key, nm.v]);
        } else {
          if (mode === "keyed") throw new Error("Parser: pattern cannot mix bare names and 'key: name' entries");
          mode = "bare";
          ps.push(this.parsePattern());
        }
        if (this.eatSym(",")) continue;
        break;
      }
      this.expectSym("]");
      return mode === "keyed" ? { p: "recPat", v: keyed } : { p: "list", v: ps };
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

  // Postfix:  quoted OBJECT access  a.b, a."b", a.123, a.(expr)  and the
  // quoted PLUCK
  //   a.[x, y]            -> list of those fields' values
  //   a.[x: v1, y: v2]    -> smaller object: field x kept under the key v1
  parsePostfix(e: Expr): Expr {
    while (this.isSym(".")) {
      this.next();
      const t = this.peek();
      if (t.k === "sym" && (t as { v: string }).v === "[") {
        this.next(); // [
        this.skipListLeading();
        const entries: Array<string | [string, string]> = [];
        while (!this.isSym("]")) {
          const k = this.next();
          const key = this.keyTok(k);
          if (this.isSym(":")) {
            this.next();
            const dst = this.next();
            if (dst.k !== "ident") throw new Error("Parser: expected a name after ':' in pluck");
            entries.push([key, dst.v]);
          } else {
            entries.push(key);
          }
          this.skipListSeparators();
          if (this.isSym("]")) break;
          if (this.peek().k === "eof") throw new Error("Parser: unexpected end of file inside pluck");
        }
        this.next(); // ]
        const mixed = new Set(entries.map((x) => typeof x));
        if (mixed.size > 1) throw new Error("Parser: pluck cannot mix bare names and 'key: name' pairs");
        e = { t: "pluck", rec: e, entries };
      } else if (t.k === "sym" && (t as { v: string }).v === "(") {
        this.next(); // (
        const dyn = this.parseExpr();
        this.expectSym(")");
        e = { t: "recordAccess", rec: e, field: dyn };
      } else {
        this.next();
        e = { t: "recordAccess", rec: e, field: this.keyTok(t) };
      }
    }
    return e;
  }

  // Normalize a field/key token (ident, string, or number) to its string form.
  keyTok(t: Token): string {
    if (t.k === "ident" || t.k === "str") return t.v;
    if (t.k === "int" || t.k === "float") return String(t.v);
    throw new Error(`Parser: expected a field name after '.' (got '${this.tokenStr(t)}')`);
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
            // Detect it: the first element is a key token (ident/string/number)
            // followed by `:`.
            const k0 = this.peek();
            const kv = k0.k === "ident" || k0.k === "str" || k0.k === "int" || k0.k === "float";
            if (kv && this.peek(1).k === "sym" &&
                (this.peek(1) as { v: string }).v === ":") {
              const fs: Array<[string, Expr]> = [];
              for (;;) {
                const f = this.next();
                this.expectSym(":");
                fs.push([this.keyTok(f), this.parseExpr()]);
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

// Native registry: name -> arity. One source of truth for env registration
// and for REPL tab completion.
const NATIVES: Array<[string, number]> = [
  ["print", 1], ["head", 1], ["tail", 1], ["length", 1], ["null", 1],
  ["enumerate", 1], ["map", 2], ["filter", 2], ["foldl", 3], ["foldr", 3],
  ["intToString", 1], ["for", 2], ["pairs", 1], ["format", 2],
  ["toString", 1], ["parse", 1], ["debug", 1], ["exit", 1], ["load", 1],
];

export class Interpreter {
  env = new Env();
  stack = 0;
  // Directory of the source file currently being evaluated — `load` resolves
  // relative paths against it ("relative to your current file").
  sourceDir: string = ".";

  constructor() {
    for (const [name, arity] of NATIVES) {
      this.env.setLocal(name, { kind: "native", name, arity, applied: [] });
    }
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
        let field: string;
        if (typeof e.field === "string") {
          field = e.field;
        } else {
          const kv = this.force(this.eval(e.field));
          if (kv.kind !== "string" && kv.kind !== "int" && kv.kind !== "float") {
            throw new Error("Runtime: dynamic field (parenthesized key) must be a string or number");
          }
          field = kv.kind === "string" ? kv.v : String(kv.v);
        }
        if (rec.kind !== "record") throw new Error("Runtime: record access on non-record");
        const f = rec.v.find(([k]) => k === field);
        if (!f) throw new Error(`Runtime: record has no field '${field}'`);
        r = f[1];
        break;
      }
      case "pluck": {
        let rec = this.eval(e.rec);
        if (rec.kind === "thunk") rec = this.unpackThunk(rec);
        if (rec.kind !== "record") throw new Error("Runtime: pluck on non-record");
        const byKey = new Map(rec.v);
        if (e.entries.every((x) => typeof x === "string")) {
          const out: Value[] = [];
          for (const n of e.entries as string[]) {
            const v = byKey.get(n);
            if (v === undefined) throw new Error(`Runtime: record has no field '${n}'`);
            out.push(v);
          }
          r = { kind: "list", v: out };
        } else {
          const out: Array<[string, Value]> = [];
          for (const [src, dst] of e.entries as Array<[string, string]>) {
            const v = byKey.get(src);
            if (v === undefined) throw new Error(`Runtime: record has no field '${src}'`);
            out.push([dst, v]);
          }
          r = { kind: "record", v: out };
        }
        break;
      }
      case "pipe": r = this.apply(this.eval(e.f), this.eval(e.x)); break;
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
      case "list":
      case "lazyList": {
        // Indexing:  arr 0 -> element,  arr (-1) -> last,  arr [0, 2] -> picks
        const arr = f.kind === "lazyList" ? this.force(f) : f;
        if (arr.kind !== "list") throw new Error("Runtime: value is not a list");
        const carg = this.force(arg);
        if (carg.kind === "int") {
          let i = carg.v;
          if (i < 0) i += arr.v.length;
          if (i < 0 || i >= arr.v.length) {
            throw new Error(`Runtime: index ${carg.v} out of range (len ${arr.v.length})`);
          }
          return arr.v[i];
        }
        if (carg.kind === "list") {
          const picks = carg.v.map((ix) => {
            if (ix.kind !== "int") throw new Error("Runtime: index must be an int");
            let i = ix.v;
            if (i < 0) i += arr.v.length;
            if (i < 0 || i >= arr.v.length) {
              throw new Error(`Runtime: index ${ix.v} out of range (len ${arr.v.length})`);
            }
            return arr.v[i];
          });
          return picks.length === 1 ? picks[0] : mkList(picks);
        }
        throw new Error("Runtime: indexing a list needs an int or a list of ints");
      }
      case "record": {
        // Applying an OBJECT clones it (list = positional, record = named),
        // or an int argument indexes it positionally -> [field, value].
        const carg = this.force(arg);
        if (carg.kind === "list") {
          if (f.v.length !== carg.v.length) {
            throw new Error(`Runtime: field count (${f.v.length}) does not match list size (${carg.v.length})`);
          }
          return { kind: "record", v: f.v.map(([k], i) => [k, carg.v[i]] as [string, Value]) };
        }
        if (carg.kind === "record") {
          const idx = new Map(f.v.map(([k], i) => [k, i]));
          const out = f.v.slice();
          for (const [k, v] of carg.v) {
            const i = idx.get(k);
            if (i !== undefined) out[i] = [k, v]; else out.push([k, v]);
          }
          return { kind: "record", v: out };
        }
        if (carg.kind === "int") {
          let i = carg.v;
          if (i < 0) i += f.v.length;
          if (i < 0 || i >= f.v.length) {
            throw new Error(`Runtime: index ${carg.v} out of range (len ${f.v.length})`);
          }
          return mkList([mkStr(f.v[i][0]), f.v[i][1]]);
        }
        throw new Error("Runtime: applying an object needs a list, a record, or an int index");
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
      case "enumerate":
        if (a.kind !== "list") throw new Error("Runtime: enumerate expects a list");
        return { kind: "record", v: a.v.map((x, i) => [String(i), x] as [string, Value]) };
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
      case "recPat": {
        // Keyed record pattern (Rust-style):  [x: a, y: b]  extracts fields x, y
        // from a record and binds a, b to their values.
        if (v.kind !== "record") return false;
        const fields = new Map<string, Value>();
        for (const [k, val] of v.v) fields.set(k, val);
        for (const [key, name] of p.v) {
          if (!fields.has(key)) return false;
          binds.set(name, fields.get(key)!);
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

// Run a source chunk; returns the forced value, or null for unit/void.
// REPL echo uses this (it needs the Value for colored printing).
function runSourceValue(src: string, interp: Interpreter): Value | null {
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
  val = interp.force(val);
  return val.kind === "unit" ? null : val;
}

function runSource(src: string, interp: Interpreter): string {
  const val = runSourceValue(src, interp);
  return val === null ? "" : valueToString(val);
}

// Does this parse error mean "input is still incomplete, keep reading"?
function isIncompleteError(msg: string): boolean {
  return /'EOF'|end of file|expected '->'|unexpected 'newline'|unexpected 'indent'|unexpected 'dedent'/.test(msg);
}

function unbalancedBrackets(src: string): boolean {
  try {
    let d = 0;
    for (const t of lex(src)) {
      if (t.k !== "sym") continue;
      if (t.v === "(" || t.v === "[" || t.v === "{") d++;
      else if (t.v === ")" || t.v === "]" || t.v === "}") d--;
    }
    return d > 0;
  } catch {
    return false;
  }
}

// A chunk is complete when it parses cleanly. An EOF-shaped parse error or
// an unclosed bracket means "keep reading" (multi-line input).
function chunkComplete(src: string): boolean {
  try {
    parse(src);
    return true;
  } catch (err) {
    return !(isIncompleteError((err as Error).message) || unbalancedBrackets(src));
  }
}

// ---- ANSI colors (TTY REPL only; piped output stays plain) ----

const A = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m", gray: "\x1b[90m",
};
const paint = (code: string, s: string) => code + s + A.reset;

// node-style typed echo: numbers yellow, strings/chars green, bools magenta,
// lists/records/variants cyan, unit/functions gray.
function showValue(v: Value): string {
  switch (v.kind) {
    case "int": case "float": return paint(A.yellow, String(v.v));
    case "string": return paint(A.green, `"${v.v}"`);
    case "char": return paint(A.green, `'${v.v}'`);
    case "bool": return paint(A.magenta, String(v.v));
    case "unit": return paint(A.gray, "()");
    case "list":
      return paint(A.cyan, "[") + v.v.map(showValue).join(paint(A.cyan, ", ")) +
        paint(A.cyan, "]");
    case "lazyList": return paint(A.gray, "<lazy>");
    case "record":
      return paint(A.cyan, "[") +
        v.v.map(([k, x]) => `${paint(A.cyan, k)}: ${showValue(x)}`).join(paint(A.cyan, ", ")) +
        paint(A.cyan, "]");
    case "variant":
      return paint(A.cyan, v.tag) + (v.v.length ? " " + v.v.map(showValue).join(" ") : "");
    default: return paint(A.gray, valueToString(v));
  }
}

const REPL_KEYWORDS = new Set(["match", "data"]);
const NATIVE_NAMES = new Set(NATIVES.map(([n]) => n));

// Syntax-highlight one buffer line (best-effort, purely cosmetic).
function highlightLine(s: string): string {
  let out = "", i = 0;
  const word = (c: string) => /[A-Za-z0-9_]/.test(c);
  while (i < s.length) {
    const c = s[i];
    if (c === "#") { out += paint(A.dim, s.slice(i)); break; }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j++;
      j = Math.min(j + 1, s.length);
      out += paint(A.green, s.slice(i, j)); i = j; continue;
    }
    if (c === "'") {
      const j = s[i + 1] === "\\" ? Math.min(i + 4, s.length) : Math.min(i + 3, s.length);
      out += paint(A.green, s.slice(i, j)); i = j; continue;
    }
    if (/\d/.test(c)) {
      let j = i;
      while (j < s.length && /[\d.]/.test(s[j])) j++;
      out += paint(A.yellow, s.slice(i, j)); i = j; continue;
    }
    if (word(c)) {
      let j = i;
      while (j < s.length && word(s[j])) j++;
      const w = s.slice(i, j);
      out += REPL_KEYWORDS.has(w) || w === "true" || w === "false" ? paint(A.magenta, w)
        : NATIVE_NAMES.has(w) ? paint(A.blue, w)
        : /^[A-Z]/.test(w) ? paint(A.cyan, w)
        : w;
      i = j; continue;
    }
    out += c; i++;
  }
  return out;
}

function envNames(env: Env): string[] {
  const s = new Set<string>();
  for (let e: Env | null = env; e; e = e.parent) {
    for (const k of e.map.keys()) s.add(k);
  }
  return [...s];
}

// ---- history persistence (~/.sloth_history, one JSON entry per line) ----

const HIST_CAP = 500;
let histWriteHinted = false;

function histFile(): string | null {
  try {
    const home = Deno.env.get("HOME");
    return home ? `${home}/.sloth_history` : null;
  } catch {
    return null; // no --allow-env / no HOME: skip persistence, keep session history
  }
}

function loadHistory(): string[] {
  const f = histFile();
  if (!f) return [];
  try {
    const out: string[] = [];
    for (const line of Deno.readTextFileSync(f).split("\n")) {
      if (!line) continue;
      try { out.push(JSON.parse(line) as string); } catch { /* corrupt line: skip */ }
    }
    return out.slice(-HIST_CAP);
  } catch {
    return [];
  }
}

function appendHistory(entry: string): boolean {
  const f = histFile();
  if (!f) return true;
  try {
    Deno.writeTextFileSync(f, JSON.stringify(entry) + "\n", { append: true });
    return true;
  } catch {
    return false;
  }
}

function helpText(): string {
  return [
    `Language:`,
    `  symbol = value   (the ONLY binding form; top level or inside { } blocks)`,
    `  [a, b] = value (destructuring binding; records match by field name)`,
    `  Just v = value (declared constructors destructure; capital defs are errors)`,
    `  [x: a, y: b] = value  (rename destructure: pull fields out of a record)`,
    `  nums 0 / nums (-1) / nums [0, 2]   (apply a list = index)`,
    `  vec [1,2,3] / vec [z: 3, x: 1]   (apply a record = clone)`,
    `  rec.field / rec."key" / rec.(dyn) / rec.[x, y]  (quoted access + pluck)`,
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
    `          head tail length null enumerate map filter foldl foldr`,
    `          for pairs format intToString exit load`,
    ``,
    `load "core.txt"  imports the standard library (core.txt): as a`,
    `               statement it merges into the current scope; as a`,
    `               value it returns a module (core.sq 4). halting is`,
    `               core.txt's  halt = exit 0  (lazy: fires only when used).`,
    `0-arg value defs are LAZY:  x = <expr>  runs <expr> on first use.`,
    ``,
    `Type annotations (TS-style) are accepted & ignored at runtime:`,
    `  x: Int = 5`,
    `Run: deno run --allow-read main.ts features.txt`,
    ``,
    `REPL:`,
    `  Up/Down    history (kept in ~/.sloth_history)`,
    `  Tab        complete names/builtins/:commands; with nothing to`,
    `             complete, insert 4 spaces (the indent unit)`,
    `  Backspace  behind a full indent level deletes all 4 spaces`,
    `  Enter      runs when the chunk is complete; incomplete input continues`,
    `             on the next line ("... " prompt, auto-indent);`,
    `             a blank line is just spacing, Ctrl+C clears the input`,
    `  paste      multi-line text is inserted, not run; Enter then runs it`,
    `  Ctrl+C     clear input (empty: quit)  Ctrl+D quit  Ctrl+L clear screen`,
    `  Ctrl+A/E   line start/end  Ctrl+U/K kill to line start/end  Ctrl+W delete word`,
  ].join("\n");
}

// ---- raw-mode line editor (TTY only) ----

type KeyAction = "cont" | "submit" | "quit";
const ENC = new TextEncoder();

class ReplEditor {
  lines: string[] = [""];
  row = 0;
  col = 0;
  hist: string[];
  histIdx: number | null = null;
  draft = "";
  tabPrefix = "";
  esc = "";
  visRow = 0; // visual rows between the render home and the cursor
  interp: Interpreter;
  isComplete: (src: string) => boolean;

  constructor(interp: Interpreter, isComplete: (src: string) => boolean, hist: string[]) {
    this.interp = interp;
    this.isComplete = isComplete;
    this.hist = hist;
  }

  src(): string { return this.lines.join("\n"); }

  width(): number {
    try { return Deno.consoleSize().columns || 80; } catch { return 80; }
  }

  // Python-style prompts: ">>> " opens a chunk, "... " marks continuation
  // lines. Uniform 4-char width keeps the cursor math trivial.
  promptW(_i: number): number { return 4; }

  emit(s: string): void {
    Deno.stdout.writeSync(ENC.encode(s));
  }

  // Print a line of output below the input (raw mode: emit CRLF ourselves).
  print(s: string): void {
    this.emit(s.replace(/\n/g, "\r\n") + "\r\n");
  }

  // Visual rows a logical line occupies (terminal wrap assumed).
  rowsOf(i: number, w: number): number {
    return Math.max(1, Math.ceil((this.promptW(i) + this.lines[i].length) / w));
  }

  // Repaint the whole chunk from its home row; the home is where the cursor
  // sat when the chunk started, so only relative cursor moves are needed.
  render(): void {
    const w = this.width();
    if (this.visRow > 0) this.emit(`\x1b[${this.visRow}A`);
    this.emit("\r\x1b[J");
    let total = 0;
    for (let i = 0; i < this.lines.length; i++) {
      const p = i === 0 ? paint(A.bold + A.cyan, ">>> ") : paint(A.cyan, "... ");
      this.emit(p + highlightLine(this.lines[i]) + "\r\n");
      total += this.rowsOf(i, w);
    }
    let curRow = 0;
    for (let i = 0; i < this.row; i++) curRow += this.rowsOf(i, w);
    const x = this.promptW(this.row) + this.col;
    curRow += Math.floor(x / w);
    if (total - curRow > 0) this.emit(`\x1b[${total - curRow}A`);
    this.emit("\r");
    const xc = x % w;
    if (xc > 0) this.emit(`\x1b[${xc}C`);
    this.visRow = curRow;
  }

  insertText(t: string): void {
    for (const ch of t) {
      if (ch === "\n") { this.splitLine(); continue; }
      const line = this.lines[this.row];
      // dedent assist: typing } or ] on an indent-only line drops one level
      if ((ch === "}" || ch === "]") && this.col === line.length && /^\s+$/.test(line) && line.length >= 4) {
        this.lines[this.row] = line.slice(4);
        this.col -= 4;
      }
      this.lines[this.row] = this.lines[this.row].slice(0, this.col) + ch +
        this.lines[this.row].slice(this.col);
      this.col++;
    }
  }

  // Break the line at the cursor; auto-indent like the 4-space layout (copy
  // the line's indent, +4 when it ends with an opening bracket).
  splitLine(): void {
    const line = this.lines[this.row];
    const indent = (/^ */.exec(line) ?? [""])[0];
    const deeper = /[{[]\s*$/.test(line) ? "    " : "";
    this.lines[this.row] = line.slice(0, this.col);
    this.lines.splice(this.row + 1, 0, indent + deeper + line.slice(this.col));
    this.row++;
    this.col = indent.length + deeper.length;
  }

  backspace(): void {
    if (this.col > 0) {
      const line = this.lines[this.row];
      // the "opposite of Tab": a Backspace behind a full indent level
      // deletes all 4 spaces at once
      const n = this.col % 4 === 0 && this.col >= 4 &&
          line.slice(this.col - 4, this.col) === "    " ? 4 : 1;
      this.lines[this.row] = line.slice(0, this.col - n) + line.slice(this.col);
      this.col -= n;
      return;
    }
    if (this.row > 0) {
      const prev = this.lines[this.row - 1];
      this.lines[this.row - 1] = prev + this.lines[this.row];
      this.lines.splice(this.row, 1);
      this.row--;
      this.col = prev.length;
    }
  }

  deleteFwd(): void {
    const line = this.lines[this.row];
    if (this.col < line.length) {
      this.lines[this.row] = line.slice(0, this.col) + line.slice(this.col + 1);
      return;
    }
    if (this.row < this.lines.length - 1) {
      this.lines[this.row] = line + this.lines[this.row + 1];
      this.lines.splice(this.row + 1, 1);
    }
  }

  left(): void {
    if (this.col > 0) this.col--;
    else if (this.row > 0) { this.row--; this.col = this.lines[this.row].length; }
  }

  // Ctrl+W: delete back to the start of the previous word (whitespace-
  // delimited); at column 0 it falls back to joining with the line above.
  deleteWordBack(): void {
    if (this.col === 0) { this.backspace(); return; }
    const line = this.lines[this.row];
    let i = this.col;
    while (i > 0 && line[i - 1] === " ") i--;
    while (i > 0 && line[i - 1] !== " ") i--;
    this.lines[this.row] = line.slice(0, i) + line.slice(this.col);
    this.col = i;
  }

  right(): void {
    if (this.col < this.lines[this.row].length) this.col++;
    else if (this.row < this.lines.length - 1) { this.row++; this.col = 0; }
  }

  // Trailing whitespace-only lines never reach the parser.
  trimmedSrc(): string {
    return this.src().replace(/(?:\n[ \t]*)+$/, "");
  }

  enter(): KeyAction {
    const atEnd = this.row === this.lines.length - 1 &&
      this.col === this.lines[this.row].length;
    if (!atEnd) { this.splitLine(); return "cont"; }
    const line = this.lines[this.row];
    // whitespace-only single line: like Python, just show a fresh prompt
    if (this.lines.length === 1 && line.trim() === "") return "submit";
    if (this.isComplete(this.trimmedSrc())) return "submit";
    this.splitLine();
    return "cont";
  }

  // Single-line buffer: Up/Down walk history. Multi-line buffer (continuation
  // or a recalled multi-line entry): Up/Down move between lines instead.
  up(): KeyAction {
    if (this.lines.length > 1) {
      if (this.row > 0) { this.row--; this.col = Math.min(this.col, this.lines[this.row].length); }
      return "cont";
    }
    if (this.hist.length === 0) return "cont";
    if (this.histIdx === null) {
      this.draft = this.src();
      this.histIdx = this.hist.length - 1;
    } else if (this.histIdx > 0) this.histIdx--;
    this.recall(this.hist[this.histIdx]);
    return "cont";
  }

  down(): KeyAction {
    if (this.lines.length > 1) {
      if (this.row < this.lines.length - 1) { this.row++; this.col = Math.min(this.col, this.lines[this.row].length); }
      return "cont";
    }
    if (this.histIdx === null) return "cont";
    this.histIdx++;
    if (this.histIdx >= this.hist.length) {
      this.histIdx = null;
      this.recall(this.draft);
    } else this.recall(this.hist[this.histIdx]);
    return "cont";
  }

  recall(entry: string): void {
    this.lines = entry.split("\n");
    this.row = this.lines.length - 1;
    this.col = this.lines[this.row].length;
  }

  completionCands(): string[] {
    const s = new Set<string>(["match", "data"]);
    for (const [n] of NATIVES) s.add(n);
    for (const n of envNames(this.interp.env)) s.add(n);
    return [...s].sort();
  }

  // Tab: complete the word before the cursor (builtins, bound names,
  // :commands). With no word (or no completion) on an empty spot it inserts
  // 4 spaces — the language's indent unit.
  tab(): KeyAction {
    const line = this.lines[this.row];
    const before = line.slice(0, this.col);
    if (/^:[a-z]*$/.test(before)) {
      const cmds = [":help", ":h", ":quit", ":q"].filter((c) => c.startsWith(before) && c !== before);
      if (cmds.length === 1) this.insertText(cmds[0].slice(before.length));
      else if (cmds.length > 1) this.listMatches(cmds);
      return "cont";
    }
    const word = (/[A-Za-z0-9_]*$/.exec(before) ?? [""])[0];
    if (word === "") {
      this.insertText("    ");
      this.tabPrefix = "";
      return "cont";
    }
    const cands = this.completionCands().filter((c) => c.startsWith(word) && c !== word);
    if (cands.length === 0) { this.tabPrefix = ""; return "cont"; }
    if (cands.length === 1) {
      this.insertText(cands[0].slice(word.length));
      this.tabPrefix = "";
      return "cont";
    }
    let common = cands[0];
    for (const c of cands) while (!c.startsWith(common)) common = common.slice(0, -1);
    if (common.length > word.length) {
      this.insertText(common.slice(word.length));
      this.tabPrefix = common;
      return "cont";
    }
    if (this.tabPrefix === word) this.listMatches(cands); // Tab again: list them
    else this.tabPrefix = word;
    return "cont";
  }

  listMatches(items: string[]): void {
    this.emit("\r\n" + items.join("  ") + "\r\n");
    this.visRow = 0;
    this.render();
  }

  ctrlC(): KeyAction {
    // quit only on a literally empty buffer; indent-only input CLEARS
    // (the indent may be auto-inserted, invisible to the eye)
    if (this.lines.length === 1 && this.lines[0] === "") return "quit";
    this.lines = [""]; this.row = 0; this.col = 0; this.histIdx = null;
    return "cont";
  }

  ctrlD(): KeyAction {
    if (this.src() === "") return "quit";
    this.deleteFwd();
    return "cont";
  }

  ctrlL(): KeyAction {
    this.emit("\x1b[2J\x1b[H");
    this.visRow = 0;
    return "cont";
  }

  // Feed one decoded input character; escape sequences assemble in this.esc.
  feed(ch: string): KeyAction {
    if (this.esc !== "") {
      this.esc += ch;
      const e = this.esc;
      if (e.length === 2 && e[1] !== "[" && e[1] !== "O") {
        this.esc = ""; // stray ESC followed by a normal char: ignore both
        return "cont";
      }
      const last = e[e.length - 1];
      const done = (e[1] === "O" && e.length >= 3) ||
        (e[1] === "[" && e.length >= 3 && (last === "~" || /[A-Za-z]/.test(last)));
      if (!done) return "cont";
      this.esc = "";
      const rest = e[1] === "O" ? e[2] : e.slice(2);
      if (rest === "A") return this.up();
      if (rest === "B") return this.down();
      if (rest === "C") { this.right(); return "cont"; }
      if (rest === "D") { this.left(); return "cont"; }
      if (rest === "H" || rest === "1~" || rest === "7~") { this.col = 0; return "cont"; }
      if (rest === "F" || rest === "4~" || rest === "8~") {
        this.col = this.lines[this.row].length;
        return "cont";
      }
      if (rest === "3~") { this.deleteFwd(); return "cont"; }
      if (rest === "200~") { this.pastePending = true; } // bracketed paste start
      return "cont";
    }
    switch (ch) {
      case "\x1b": this.esc = "\x1b"; return "cont";
      case "\r": case "\n": return this.enter();
      case "\t": return this.tab();
      case "\x7f": this.backspace(); return "cont";
      case "\x03": return this.ctrlC();
      case "\x04": return this.ctrlD();
      case "\x0c": return this.ctrlL();
      case "\x01": this.col = 0; return "cont";
      case "\x05": this.col = this.lines[this.row].length; return "cont";
      case "\x15":
        this.lines[this.row] = this.lines[this.row].slice(this.col);
        this.col = 0;
        return "cont";
      case "\x17": this.deleteWordBack(); return "cont";
      case "\x0b":
        this.lines[this.row] = this.lines[this.row].slice(0, this.col);
        return "cont";
      default:
        if (ch >= " " && ch !== "\x7f") this.insertText(ch);
        return "cont";
    }
  }

  // Read one chunk (Enter on complete input). null = user quit.
  // Keys typed ahead (a read batch extending past the Enter that submits)
  // are kept in pendingKeys and replayed into the NEXT chunk.
  // Bracketed paste (the terminal wraps pastes in ESC[200~ ... ESC[201~)
  // inserts its text verbatim without running it.
  pendingKeys = "";
  pastePending = false;

  async readChunk(): Promise<string | null> {
    this.lines = [""]; this.row = 0; this.col = 0;
    this.histIdx = null; this.esc = ""; this.tabPrefix = ""; this.visRow = 0;
    this.render();
    const buf = new Uint8Array(4096);
    const dec = new TextDecoder();
    let queue = this.pendingKeys;
    this.pendingKeys = "";
    let stash = ""; // a paste whose end marker has not arrived yet
    while (true) {
      if (queue === "") {
        const n = await Deno.stdin.read(buf);
        if (n === null) return null;
        queue = (stash + dec.decode(buf.subarray(0, n), { stream: true })).replace(/\r\n?/g, "\n");
        stash = "";
      }
      if (queue.startsWith("\x1b[200~")) {
        const e = queue.indexOf("\x1b[201~", 6);
        if (e === -1) {
          stash = queue; // wait for the rest of the paste
          queue = "";
          continue;
        }
        this.insertText(queue.slice(6, e));
        queue = queue.slice(e + 6);
        this.render();
        continue;
      }
      let action: KeyAction = "cont";
      let i = 0;
      for (; i < queue.length; i++) {
        if (queue[i] === "\x1b" && queue.startsWith("\x1b[200~", i)) break;
        action = this.feed(queue[i]);
        if (action !== "cont") break;
        this.render(); // per keystroke, like a real terminal shows them
      }
      if (this.pastePending) { // marker assembled char-by-char in feed()
        this.pastePending = false;
        queue = "\x1b[200~" + queue.slice(i + 1);
        continue;
      }
      if (action === "submit" || action === "quit") {
        this.pendingKeys = queue.slice(i + 1);
        this.emit("\r\n");
        return action === "submit" ? this.trimmedSrc() || "" : null;
      }
      if (i < queue.length) { // stopped at a paste marker
        queue = queue.slice(i);
        continue;
      }
      queue = "";
    }
  }
}

// ---- TTY REPL: raw-mode editor, colors, persistent history ----

async function replTTY(): Promise<void> {
  const interp = new Interpreter();
  const hist = loadHistory();
  const ed = new ReplEditor(interp, chunkComplete, hist);

  // Route console.log (used by the print/debug natives) through the editor
  // so output is newline-correct while the terminal is raw.
  const origLog = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    ed.print(args.map((x) => typeof x === "string" ? x : String(x)).join(" "));
  };

  Deno.stdin.setRaw(true);
  ed.emit("\x1b[?2004h"); // ask the terminal to wrap pastes in ESC[200~..ESC[201~
  try {
    while (true) {
      const src = await ed.readChunk();
      if (src === null) { ed.print("bye"); return; }
      const cmd = src.trim();
      if (cmd === ":quit" || cmd === ":q") { ed.print("bye"); return; }
      if (cmd === ":help" || cmd === ":h") { ed.print(helpText()); continue; }
      if (cmd === "") continue;
      if (src !== hist[hist.length - 1]) {
        hist.push(src);
        if (!appendHistory(src) && !histWriteHinted) {
          histWriteHinted = true;
          ed.print(paint(A.dim, "(history not saved: run with --allow-write)"));
        }
      }
      try {
        const val = runSourceValue(src, interp);
        if (val !== null) ed.print(showValue(val));
      } catch (err) {
        ed.print(paint(A.red, (err as Error).message));
      }
    }
  } finally {
    ed.emit("\x1b[?2004l");
    console.log = origLog;
    Deno.stdin.setRaw(false);
  }
}

// ---- piped REPL (stdin not a TTY): plain line loop, no editor/colors ----

async function replPiped(): Promise<void> {
  const interp = new Interpreter();

  const decoder = new TextDecoder();
  const buf = new Uint8Array(1024);
  const stdin = Deno.stdin;

  let pending = "";
  const prompt = ">>> ";

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
        console.log(helpText());
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
        if (isIncompleteError(msg)) {
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

async function repl(): Promise<void> {
  console.log("Sloth interpreter v1.1.0");
  console.log("Lazy, Haskell-like, untyped like JS, annotated like TS.");
  if (Deno.stdin.isTerminal()) {
    console.log(":help :quit  |  Up/Down history  |  Tab complete/indent  |  Ctrl+C/D quit");
    await replTTY();
    return;
  }
  console.log("Commands: :help :quit");
  console.log();
  await replPiped();
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
