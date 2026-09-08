import { type Real, type Numeric, numericNative, complex, arithmetic, negate, compareNumbers, integer, asFloat, numberText } from "./numbers.ts";
function rangeNum(e: Expr): Real {
    if (e.t === "int" || e.t === "float") return { kind: e.t, v: e.v } as Real;
    if (e.t === "unop" && e.op === "neg") return negate(rangeNum(e.e)) as Real;
    if (e.t === "binop" && ["+", "-", "*", "/"].includes(e.op)) return arithmetic(e.op, rangeNum(e.l), rangeNum(e.r)) as Real;
    throw new Error("Parser: range bounds must be numeric constants");
}
function rangeExpr(lo: Real, second: Real | null, hi: Real | null): Expr {
    const step = second === null ? integer(hi !== null && compareNumbers(hi, lo) < 0 ? -1n : 1n) : arithmetic("-", second, lo) as Real;
    if ([lo, second, hi].some((x) => x?.kind === "float")) {
        const start = asFloat(lo), delta = asFloat(step), end = hi === null ? null : asFloat(hi);
        if (!Number.isFinite(start) || !Number.isFinite(delta) || (end !== null && !Number.isFinite(end))) throw new Error("Parser: float range bounds and step must be finite");
        return { t: "floatRange", lo: start, step: delta, hi: end };
    }
    if (lo.kind === "int" && step.kind === "int" && (hi === null || hi.kind === "int")) return { t: "range", lo: lo.v, step: step.v, hi: hi?.v ?? null };
    return { t: "rationalRange", lo, step, hi };
}
import { lex } from "./lexer.ts";
import { APNError, tokLen } from "./errors.ts";
import type { Expr, Pattern, TopLevel, BinOp, Alt } from "./ast.ts";
import type { Type, Value, Env } from "./types.ts";
import type { Token } from "./lexer.ts";

// ---------------- Parser ----------------

class Parser {
    toks: Token[];
    i = 0;
    seen: Token | null = null; // last token peeked/consumed — where a failure points

    constructor(toks: Token[], private source: string) { this.toks = toks; }

    lineIndent(token: Token): number {
        const start = this.source.lastIndexOf("\n", token.pos - 1) + 1;
        const whitespace = this.source.slice(start).match(/^[ \t]*/)![0];
        return [...whitespace].reduce((n, c) => n + (c === "\t" ? 4 : 1), 0);
    }

    peek(off = 0): Token {
        const t = this.toks[Math.min(this.i + off, this.toks.length - 1)];
        if (off === 0) this.seen = t;
        return t;
    }
    next(): Token {
        const t = this.toks[this.i++];
        this.seen = t;
        return t;
    }
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
    // Bare text of a token for error messages — templates add the quotes.
    tokenStr(t: Token): string {
        switch (t.k) {
            case "ident": case "kw": case "str": case "char": return t.v;
            case "int": return String(t.v);
            case "float": return String(t.v);
            case "opw": return t.v;
            case "sym": return t.v;
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
        if (this.isSym("-") && this.peek(1).k === "int") {
            this.next();
            const value = this.next() as Extract<Token, { k: "int" }>;
            return { p: "int", v: -value.v };
        }
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
            // RANGE PATTERN: [0..10] matches any int in the range (inclusive)
            {
                const a = this.peek();
                const neg = a.k === "sym" && (a as { v: string }).v === "-";
                const n0 = (neg ? this.peek(1) : a) as Token;
                const dots = this.peek(neg ? 2 : 1);
                if ((n0.k === "int" || n0.k === "float") && dots.k === "sym" &&
                    (dots as { v: string }).v === "..") {
                    if (neg) this.next();
                    const loToken = this.next();
                    if (loToken.k !== "int") throw new Error("Parser: range pattern bounds must be integers");
                    const lo = loToken.v;
                    this.next(); // ..
                    const neg2 = this.isSym("-");
                    if (neg2) this.next();
                    const hiToken = this.next();
                    if (hiToken.k !== "int") throw new Error("Parser: range pattern bounds must be integers");
                    const hi = hiToken.v;
                    this.expectSym("]");
                    return { p: "range", lo: neg ? -lo : lo, hi: neg2 ? -hi : hi };
                }
            }
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
            {
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
            const saved = this.noCons;
            this.noCons = 1;
            const then = this.parseTernary();
            this.noCons = saved;
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

    noCons = 0; // >0 while parsing a ternary branch (`:` belongs to the ternary)

    parseConcat(): Expr {
        let e = this.parseAdd();
        while (this.isSym(":") && this.noCons === 0) {
            this.next();
            const r = this.parseConcat(); // right-associative:  0 : 1 : xs
            e = { t: "binop", op: ":", l: e, r };
        }
        return e;
    }

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
                    (t.k === "kw" && (t.v === "true" || t.v === "false")) ||
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
            case "int":
            case "float": {
                this.next();
                if (this.eatSym("@")) {
                    const negative = this.eatSym("-");
                    if (!negative) this.eatSym("+");
                    const angle = this.next();
                    if (angle.k !== "int" && angle.k !== "float") throw new Error("Parser: polar angle must be a numeric literal");
                    const radius = { kind: t.k, v: t.v } as Real;
                    const value = { kind: angle.k, v: angle.v } as Real;
                    return { t: "numeric", v: numericNative("makePolar", [radius, negative ? negate(value) : value]) as Numeric };
                }
                const suffix = this.peek();
                if (suffix.k === "ident" && suffix.v === "i" &&
                    !/\s/.test(this.source.slice(t.pos, suffix.pos))) {
                    this.next();
                    const imaginary = { kind: t.k, v: t.v } as Real;
                    return { t: "numeric", v: complex(integer(0n), imaginary) };
                }
                return t.k === "int" ? { t: "int", v: t.v } : { t: "float", v: t.v };
            }
            case "bool": this.next(); return { t: "bool", v: t.v };
            case "str": this.next(); return { t: "string", v: t.v };
            case "char": this.next(); return { t: "char", v: t.v };
            case "ident": {
                this.next();
                if (t.v === "_") return { t: "placeholder" };
                return { t: "var", name: t.v };
            }
            case "kw": return this.parseKeyword();
            case "sym":
                switch (t.v) {
                    case "=": throw new Error("Parser: expected a binding before '='");
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
                        const multilineBrace = t.v === "{" && this.peek().k === "newline";
                        if (multilineBrace) {
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
                            if (this.isSym(close)) {
                                if (multilineBrace && this.lineIndent(this.peek()) !== this.lineIndent(t)) {
                                    throw new Error("Parser: closing } must align with the line containing {");
                                }
                                this.next(); return { t: "block", stmts, style: close === ")" ? "(" : "{" };
                            }
                            const tb = this.peek();
                            if (tb.k === "eof") throw new Error("Parser: unexpected end of file inside group");
                            if (multilineBrace && this.lineIndent(tb) !== this.lineIndent(t) + 4) {
                                throw new Error("Parser: block statements must be indented exactly 4 spaces from the opening line");
                            }
                            if (tb.k === "indent") {
                                throw new Error("Parser: block statements must stay at one indentation level");
                            }
                            if (tb.k === "sym" && tb.v === "," && t.v === "(") {
                                throw new Error("Parser: tuples are not supported; use a list [a, b, ...] instead");
                            }
                            if (this.isFieldAssignStart()) {
                                stmts.push(this.parseFieldAssign());
                            } else if (this.isPatBinding()) {
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
                        // RANGE (speculative): [a..b] [a..] [a,b..c] [a,b..] — Haskell-style; the
                        // first two elements give the STEP; bounds are constant arithmetic;
                        // no upper bound = INFINITE. Falls back to a normal list literal.
                        {
                            const save = this.i;
                            const loE = this.parseAdd();
                            if (this.isSym("..")) {
                                this.next();
                                if (this.isSym("]")) {
                                    this.next();
                                    return rangeExpr(rangeNum(loE), null, null);
                                }
                                const hi = this.parseAdd();
                                this.expectSym("]");
                                if (loE.t === "char" && hi.t === "char") {
                                    const start = loE.v.codePointAt(0)!, end = hi.v.codePointAt(0)!;
                                    const step = start <= end ? 1 : -1;
                                    const chars: string[] = [];
                                    for (let cp = start; step > 0 ? cp <= end : cp >= end; cp += step) {
                                        // Surrogates are not Unicode scalar values.
                                        if (cp < 0xD800 || cp > 0xDFFF) chars.push(String.fromCodePoint(cp));
                                    }
                                    return { t: "string", v: chars.join("") };
                                }
                                const lo = rangeNum(loE), hiN = rangeNum(hi);
                                // implicit step ADAPTS to direction: [0..-100] descends;
                                // an EXPLICIT step pointing the wrong way stays empty
                                return rangeExpr(lo, null, hiN);
                            }
                            if (this.isSym(",")) {
                                const save2 = this.i;
                                this.next();
                                const sE = this.parseAdd();
                                if (this.isSym("..")) {
                                    this.next();
                                    const lo = rangeNum(loE);
                                    const second = rangeNum(sE);
                                    if (this.isSym("]")) {
                                        this.next();
                                        return rangeExpr(lo, second, null);
                                    }
                                    const hi = this.parseAdd();
                                    this.expectSym("]");
                                    return rangeExpr(lo, second, rangeNum(hi));
                                }
                                this.i = save2; // [1, 2] — a plain list
                            }
                            this.i = save; // not a range at all
                        }
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
        this.skipContinuation();
        // An explicit brace body ends at its closing brace; following operators
        // belong to the surrounding expression, allowing chained maps.
        const body = this.isSym("{") ? this.parsePrimary() : this.parseExpr();
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
    // Field/pluck ASSIGNMENT statement:  name.field = expr   name.[fs] = expr
    // Desugars to an EAGER pattern binding  name = setFields(name, ...)  so the
    // rebinding is scoped like any def (block statements shadow the outer name).
    isFieldAssignStart(): boolean {
        const t0 = this.peek();
        if (t0.k !== "ident") return false;
        const t1 = this.peek(1);
        if (!(t1.k === "sym" && t1.v === ".")) return false;
        const t2 = this.peek(2);
        if (t2.k === "ident" || t2.k === "str" || t2.k === "int" || t2.k === "float") {
            const t3 = this.peek(3);
            return t3.k === "sym" && t3.v === "=";
        }
        if (t2.k === "sym" && t2.v === "[") {
            let j = this.i + 3;
            while (this.toks[j] && !(this.toks[j].k === "sym" && (this.toks[j] as { v: string }).v === "]")) {
                j++;
            }
            const after = this.toks[j + 1];
            return after !== undefined && after.k === "sym" && (after as { v: string }).v === "=";
        }
        return false;
    }

    parseFieldAssign(): Expr {
        const nt = this.next();
        if (nt.k !== "ident") throw new Error("Parser: expected a name before '.'");
        const name = nt.v;
        this.next(); // "."
        const entries: string[] = [];
        if (this.isSym("[")) {
            this.next();
            this.skipListLeading();
            while (!this.isSym("]")) {
                const k = this.next();
                entries.push(this.keyTok(k));
                this.skipListSeparators();
                if (this.isSym("]")) break;
                if (this.peek().k === "eof") {
                    throw new Error("Parser: unexpected end of file inside field-assignment entries");
                }
            }
            this.next(); // ]
        } else {
            const t = this.next();
            entries.push(this.keyTok(t));
        }
        this.expectSym("=");
        const rhs = this.parseExpr();
        // one field takes its value directly; several fields take a LIST of
        // values — normalize the single form into the list form
        const value = entries.length === 1 ? { t: "list", v: [rhs] } as Expr : rhs;
        return {
            t: "patDef",
            pattern: { p: "var", name },
            value: { t: "setFields", rec: { t: "var", name }, entries, value },
        };
    }

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
                // lone (op): a 2-arg lambda —  add = (+)
                if (this.peek(1).k === "sym" && (this.peek(1) as { v: string }).v === ")") {
                    const op = t.v as BinOp;
                    this.next(); // op
                    this.next(); // )
                    return {
                        t: "lambda",
                        params: ["$L", "$R"],
                        body: { t: "binop", op, l: { t: "var", name: "$L" }, r: { t: "var", name: "$R" } },
                    };
                }
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
                    (t.k === "kw" && (t.v === "true" || t.v === "false")) ||
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

    // A body is required; only an indented continuation can cross a newline.
    parseDefBody(): Expr {
        if (this.peek().k === "newline") {
            let j = this.i;
            while (this.toks[j] && this.toks[j].k === "newline") j++;
            if (this.toks[j] && this.toks[j].k === "indent") {
                const first = this.toks[j + 1];
                if (first?.k === "sym" && first.v === "{") {
                    this.i = j + 1;
                    throw new Error("Parser: a definition's opening { must be on the same line as '='");
                }
                return this.parseExpr();
            }
            throw new Error("Parser: expected an expression after '='; use '_' for an unfinished definition");
        }
        if (this.peek().k === "eof" || this.peek().k === "dedent" ||
            this.isSym(";") || this.isSym("}") || this.isSym(")") || this.isSym("]")) {
            throw new Error("Parser: expected an expression after '='; use '_' for an unfinished definition");
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
                // Keyword-led expressions still include trailing operators and pipes.
                const e = this.parseExpr();
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
                // Field/pluck assignment:  vec.x = 10   vec.[x, y] = ...
                if (this.isFieldAssignStart()) {
                    out.push(this.parseFieldAssign() as TopLevel);
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
    let toks: Token[];
    try {
        toks = lex(src);
    } catch (err) {
        if (err instanceof APNError) err.src = src;
        throw err;
    }
    const p = new Parser(toks, src);
    try {
        const out = p.parseTopLevel();
        return groupClauses(out);
    } catch (err) {
        if (err instanceof APNError) {
            err.src = src;
            throw err;
        }
        // a plain parser failure: point the caret at the offending token
        const t = p.seen;
        const e = new APNError("parse", (err as Error).message.replace(/^Parser: /, ""), {
            pos: t ? t.pos : src.length,
            len: t ? tokLen(t) : 1,
        });
        e.src = src;
        throw e;
    }
}

// Merge consecutive Haskell-style clauses of the same function:
//   len [] = 0
//   len (x:rest) = 1 + len rest
// becomes one def with two clauses. Only same-name defs that carry parameters
// (params.length >= 1) with equal arity are grouped; value defs stay separate
// (consecutive re-bindings still behave as last-wins aliases, as before).
export function groupClauses(program: TopLevel[]): TopLevel[] {
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



// Render an expression back to source text (for debug / quote inspection).
export function exprToSource(e: Expr): string {
    switch (e.t) {
        case "numeric": return numberText(e.v);
        case "rationalRange": return `[${numberText(e.lo)}, ${numberText(arithmetic("+", e.lo, e.step))}..${e.hi === null ? "" : numberText(e.hi)}]`;
        case "int": return String(e.v);
        case "float": return numberText({ kind: "float", v: e.v });
        case "bool": return e.v ? "true" : "false";
        case "string": return `"${e.v}"`;
        case "char": return `'${e.v}'`;
        case "unit": return "()";
        case "placeholder": return "_";
        case "var": return e.name;
        case "binop": return `${exprToSource(e.l)} ${e.op} ${exprToSource(e.r)}`;
        case "unop": return `${e.op === "neg" ? "-" : "!"}${exprToSource(e.e)}`;
        case "app": return `${exprToSource(e.f)} ${exprToSource(e.a)}`;
        case "lambda": return `${e.params.join(" ")} -> ${exprToSource(e.body)}`;
        case "list": return `[${e.v.map(exprToSource).join(", ")}]`;
        case "record": return `[${e.v.map(([k, x]) => `${k}: ${exprToSource(x)}`).join(", ")}]`;
    case "floatRange": {
        const decimal = (v: number) => Number.isInteger(v) ? `${v}.0` : String(v);
        return `[${decimal(e.lo)}${e.step !== 1 ? `, ${decimal(e.lo + e.step)}` : ""}..${e.hi === null ? "" : decimal(e.hi)}]`;
    }
    case "range":
      return e.hi === null
        ? `[${e.lo}${e.step !== 1n ? `, ${e.lo + e.step}` : ""}..]`
        : `[${e.lo}${e.step !== 1n ? `, ${e.lo + e.step}` : ""}..${e.hi}]`;
        case "ternary": return `${exprToSource(e.cond)} ? ${exprToSource(e.then)} : ${exprToSource(e.els)}`;
        case "pipe": return `${exprToSource(e.x)} $ ${exprToSource(e.f)}`;
        case "recordAccess":
            return typeof e.field === "string"
                ? `${exprToSource(e.rec)}.${e.field}`
                : `${exprToSource(e.rec)}.(${exprToSource(e.field)})`;
        case "pluck":
            return `${exprToSource(e.rec)}.[${e.entries.map((x) => typeof x === "string" ? x : `${x[0]}: ${x[1]}`).join(", ")}]`;
        case "setFields":
            return `${exprToSource(e.rec)}.${e.entries.length === 1 ? e.entries[0] : `[${e.entries.join(", ")}]`} = ${exprToSource(e.value)}`;
        case "block": {
            const one = e.stmts.length === 1 && e.stmts[0].t !== "stmDef" && e.stmts[0].t !== "patDef";
            if (one && e.style === "(") return exprToSource(e.stmts[0]);
            const body = e.stmts.map((st) => {
                if (st.t === "stmDef") return `${st.name} = ${exprToSource(st.clauses[0].body)}`;
                if (st.t === "patDef") return `${exprToSource(st.value)}`;
                return exprToSource(st);
            }).join("; ");
            return `${e.style === "(" ? "(" : "{"} ${body} ${e.style === "(" ? ")" : "}"}`;
        }
        case "match":
            return `match ${exprToSource(e.scrut)} [...]`;
        default: return "<expr>";
    }
}