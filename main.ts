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
  | { kind: "nomatch" };

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
  | { t: "case"; scrut: Expr; alts: Alt[] }
  | { t: "list"; v: Expr[] }
  | { t: "record"; v: Array<[string, Expr]> }
  | { t: "recordAccess"; rec: Expr; field: string }
  | { t: "fromList"; template: Expr; values: Expr }
  | { t: "recordTemplate"; names: string[] }
  | { t: "let"; bindings: { name: string; value: Expr }[]; body: Expr }
  | { t: "pipe"; x: Expr; f: Expr };

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
  | { t: "data"; def: DataDef };

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
  "let", "in", "case", "of", "where",
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
        indentStack.push(indent);
        toks.push({ k: "indent" });
      } else {
        while (indent < indentStack[indentStack.length - 1]) {
          indentStack.pop();
          toks.push({ k: "dedent" });
        }
        if (indent !== indentStack[indentStack.length - 1]) {
          throw new Error(`Lexer: inconsistent indentation at ${pos}`);
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

    // single-char symbols
    if (":()[]{}.,;|".includes(c)) {
      if (c === '(' || c === '[' || c === '{') parenDepth++;
      if (c === ')' || c === ']' || c === '}') parenDepth--;
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
    // An expression may begin on a fresh (possibly indented) line.
    this.skipLayout();
    return this.parsePipe();
  }

  // Skip newlines and indentation (used at statement/definition entry points,
  // NOT mid-application, so application stays on a single logical line).
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
  parseBacktick(): Expr {
    let e = this.parseCompare();
    while (this.peek().k === "opw") {
      const op = (this.next() as { v: string }).v;
      const rhs = this.parseCompare();
      e = { t: "app", f: { t: "app", f: { t: "var", name: op }, a: e }, a: rhs };
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
    // application: f x y  (does NOT cross newline at layout level)
    for (;;) {
      const t = this.peek();
      if (t.k === "newline" || t.k === "dedent" || t.k === "indent" || t.k === "eof") break;
      if (t.k === "ident" || t.k === "int" || t.k === "float" || t.k === "bool" ||
          t.k === "str" || t.k === "char" ||
          (t.k === "sym" && (t.v === "(" || t.v === "["))) {
        const a = this.parsePostfix(this.parsePrimary());
        f = { t: "app", f, a };
      } else break;
    }
    return f;
  }

  // Postfix:  record access  a.b.c   and  list-to-record  template.[1, 2]
  parsePostfix(e: Expr): Expr {
    while (this.isSym(".")) {
      this.next();
      if (this.peek().k === "sym" && (this.peek() as { v: string }).v === "[") {
        // template.[list] — zip a template's field names with a value list.
        const values = this.parseListLiteral();
        e = { t: "fromList", template: this.asRecordTemplate(e), values };
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
    const es = [] as Expr[];
    while (!this.isSym("]")) {
      es.push(this.parseExpr());
      if (this.eatSym(",")) continue;
      break;
    }
    this.expectSym("]");
    return { t: "list", v: es };
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
          case "(": {
            this.next();
            if (this.isSym(")")) { this.next(); return { t: "unit" }; }
            const sec = this.tryOperatorSection();
            if (sec) return sec;
            const e = this.parseExpr();
            if (this.eatSym(",")) {
              throw new Error("Parser: tuples are not supported; use a list [a, b, ...] instead");
            }
            this.expectSym(")");
            return e;
          }
          case "[": {
            this.next();
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
                if (this.eatSym(",")) continue;
                break;
              }
              this.expectSym("]");
              return { t: "record", v: fs };
            }
            // Otherwise it's a list literal: [a, b, ...]
            const es = [] as Expr[];
            while (!this.isSym("]")) {
              es.push(this.parseExpr());
              if (this.eatSym(",")) continue;
              break;
            }
            this.expectSym("]");
            return { t: "list", v: es };
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
      case "let": return this.parseLet();
      case "case": return this.parseCase();
      case "match": return this.parseCase();
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
    // A pattern param desugars to:  \$p -> case $p of { pattern -> \rest -> body }
    if (pattern) {
      const fresh = this.freshName();
      const nested: Expr = params.length
        ? { t: "lambda", params, body }
        : body;
      return {
        t: "lambda",
        params: [fresh],
        body: { t: "case", scrut: { t: "var", name: fresh }, alts: [{ pattern, body: nested }] },
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
  // the parts of a single logical construct like let...in).
  skipAll() {
    while (["newline", "indent", "dedent"].includes(this.peek().k)) this.next();
  }

  parseLet(): Expr {
    this.next(); // let
    const bindings: { name: string; value: Expr }[] = [];
    for (;;) {
      this.skipAll();
      const t = this.peek();
      if (t.k === "kw" && t.v === "in") break;
      if (t.k !== "ident" && t.k !== "kw") break;
      const name = (this.next() as { v: string }).v;
      // Optional TypeScript-style annotation:  x : Int  (parsed, ignored at runtime)
      if (this.isSym(":")) { this.next(); this.parseType(); }
      this.expectSym("=");
      const value = this.parseExpr();
      bindings.push({ name, value });
    }
    this.skipAll();
    if (!this.eatKw("in")) throw new Error("Parser: expected 'in'");
    const body = this.parseExpr();
    return { t: "let", bindings, body };
  }

  parseCase(): Expr {
    this.next(); // case / match
    const scrut = this.parseExpr();
    // optional "of"
    if (this.isKw("of")) this.next();
    this.skipNL();
    // consume indent
    if (this.peek().k === "indent") this.next();
    this.skipNL();

    const alts: Alt[] = [];
    let sawDedent = false;
    for (;;) {
      this.skipNL();
      const t = this.peek();
      if (t.k === "dedent") { sawDedent = true; break; }
      if (t.k === "eof") break;
      // Stop when we hit a top-level def that isn't a pattern (e.g. another ident def)
      const pattern = this.parseConsPattern();
      let guard: Expr | undefined;
      if (this.isSym("|")) { this.next(); guard = this.parseExpr(); }
      this.expectSym("->");
      const body = this.parseExpr();
      alts.push({ pattern, guard, body });
      this.skipNL();
    }
    // consume the dedent that closes this case's alternatives block (we pushed
    // exactly one indent entering it, so consume exactly one dedent leaving it)
    if (sawDedent && this.peek().k === "dedent") this.next();
    return { t: "case", scrut, alts };
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

  // A token that can begin a definition parameter pattern.
  startsParam(t: Token): boolean {
    if (t.k === "ident") return t.v !== "_" ? true : true;
    if (t.k === "int" || t.k === "bool" || t.k === "str") return true;
    if (t.k === "sym" && (t.v === "(" || t.v === "[")) return true;
    if (t.k === "sym" && t.v === "_") return true;
    return false;
  }

  parseTopLevel(): TopLevel[] {
    const out: TopLevel[] = [];
    for (;;) {
      this.skipNL();
      // swallow stray dedents
      while (this.peek().k === "dedent") this.next();
      this.skipNL();

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
          if (!this.eatSym("|")) break;
        }
        out.push({ t: "data", def: { name, variants } });
        continue;
      }

      if (t.k === "kw") {
        // top-level expression starting with a keyword: fn/let/case
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
        if (this.isDef()) {
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
          const body = this.parseExpr();
          out.push({ t: "def", name, clauses: [{ params, body }] });
        } else {
          const e = this.parseExpr();
          out.push({ t: "expr", value: e });
        }
        continue;
      }

      if (t.k === "sym") {
        const e = this.parseExpr();
        out.push({ t: "expr", value: e });
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
      last = this.eval(tl.value);
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
    // Otherwise it's an alias to an evaluated value.
    const v = this.eval(value);
    this.env.setLocal(name, v);
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
        const c = this.eval(e.cond);
        r = (c.kind === "bool" && c.v) ? this.eval(e.then) : this.eval(e.els);
        break;
      }
      case "case": r = this.evalCase(this.force(this.eval(e.scrut)), e.alts); break;
      case "list": r = { kind: "lazyList", exprs: e.v, env: this.env }; break;
      case "record": r = { kind: "record", v: e.v.map(([k, x]) => [k, this.eval(x)] as [string, Value]) }; break;
      case "recordAccess": {
        const rec = this.eval(e.rec);
        if (rec.kind !== "record") throw new Error("Runtime: record access on non-record");
        const f = rec.v.find(([k]) => k === e.field);
        if (!f) throw new Error(`Runtime: record has no field '${e.field}'`);
        r = f[1];
        break;
      }
      case "fromList": {
        const vals = this.force(this.eval(e.values));
        if (vals.kind !== "list") throw new Error("Runtime: right side of '.' must be a list");
        let names: string[];
        if (e.template.t === "recordTemplate") {
          names = e.template.names;
        } else {
          const src = this.eval(e.template);
          if (src.kind === "lazyList") {
            names = [];
            for (const ex of src.exprs) {
              if (ex.t !== "var") throw new Error("Runtime: template must be a list of names or a record");
              names.push(ex.name);
            }
          } else if (src.kind === "record") {
            names = src.v.map(([k]) => k);
          } else {
            throw new Error("Runtime: left side of '.' must be a name template or a record");
          }
        }
        if (names.length !== vals.v.length) {
          throw new Error(`Runtime: field count (${names.length}) does not match list size (${vals.v.length})`);
        }
        r = { kind: "record", v: names.map((k, i) => [k, vals.v[i]] as [string, Value]) };
        break;
      }
      case "pipe": r = this.apply(this.eval(e.f), this.eval(e.x)); break;
      case "recordTemplate":
        throw new Error("Runtime: internal error — record template used as a value");
      case "let": {
        const child = new Env(this.env);
        const old = this.env;
        this.env = child;
        for (const b of e.bindings) {
          const v = this.eval(b.value);
          child.setLocal(b.name, v);
        }
        try {
          r = this.eval(e.body);
        } finally {
          this.env = old;
        }
        break;
      }
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
    if (v.kind === "list") return mkList(v.v.map((x) => this.force(x)));
    if (v.kind === "variant") return { kind: "variant", tag: v.tag, v: v.v.map((x) => this.force(x)) };
    if (v.kind === "record") {
      return { kind: "record", v: v.v.map(([k, x]) => [k, this.force(x)] as [string, Value]) };
    }
    return v;
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

  evalCase(scrut: Value, alts: Alt[]): Value {
    for (const alt of alts) {
      const binds = new Map<string, Value>();
      if (!this.matchPattern(alt.pattern, scrut, binds)) continue;
      if (alt.guard) {
        const g = this.evalWith(binds, alt.guard);
        if (!(g.kind === "bool" && g.v)) continue;
      }
      return this.evalWith(binds, alt.body);
    }
    throw new Error("Runtime: non-exhaustive case");
  }

  evalWith(binds: Map<string, Value>, e: Expr): Value {
    const child = new Env(this.env);
    for (const [k, v] of binds) child.setLocal(k, v);
    const old = this.env;
    this.env = child;
    try { return this.eval(e); } finally { this.env = old; }
  }
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
            `  let x = expr in body`,
            `  x -> expr        (lambdas; first param may be [a, b] or (Ctor ..))`,
            `  cond ? a : b   (ternary)`,
            `  case x of { pat -> expr; ... }`,
            `  data Maybe a = Just a | Nothing`,
            `  [1,2,3]  [name: "x", age: 2]`,
            `  x $ f             pipe: feeds x into f`,
            `  a \`f\` b            infix call == f a b`,
            `  (+ 2)  (2 +)      operator sections   ((-2) stays unary minus)`,
            `  for (x -> print x) [1,2,3]   for fn seq`,
            `  recursion, higher-order fns, records, variants`,
            ``,
            `Builtins: print (string only) toString parse debug`,
            `          head tail length null map filter foldl foldr`,
            `          for pairs format intToString`,
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
        if (/expected 'in'|expected '->'|unexpected 'newline'|unexpected 'EOF'|unexpected 'indent'|unexpected 'dedent'|expected 'then'|expected 'else'/.test(msg)) {
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
    runSource(src, interp);
  } else {
    repl().catch((err) => {
      console.error(err);
      Deno.exit(1);
    });
  }
}
