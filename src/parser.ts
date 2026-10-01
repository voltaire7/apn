import { sourceLocations } from "./ast.ts";
import { stringKey, keySource } from "./record-keys.ts";
import { TYPE_NAMES } from "./type-system.ts";
import { type Real, type Numeric, numericNative, complex, arithmetic, negate, compareNumbers, integer, asFloat, numberText } from "./numbers.ts";
function rangeNum(e: Expr): Real {
    if (e.t === "int" || e.t === "float") return { kind: e.t, v: e.v } as Real;
    if (e.t === "unop" && e.op === "neg") return negate(rangeNum(e.e)) as Real;
    if (e.t === "binop" && ["+", "-", "*", "/"].includes(e.op)) return arithmetic(e.op, rangeNum(e.l), rangeNum(e.r)) as Real;
    throw new Error("Parser: range bounds must be numeric constants");
}
export function rangeExpr(lo: Real, second: Real | null, hi: Real | null): Expr {
    const step = second === null ? integer(hi !== null && compareNumbers(hi, lo) < 0 ? -1n : 1n) : arithmetic("-", second, lo) as Real;
    if ([lo, second, hi].some((x) => x?.kind === "float")) {
        const start = asFloat(lo), delta = asFloat(step), end = hi === null ? null : asFloat(hi);
        if (!Number.isFinite(start) || !Number.isFinite(delta) || (end !== null && !Number.isFinite(end))) throw new Error("Parser: float range bounds and step must be finite");
        return { t: "floatRange", lo: start, step: delta, hi: end };
    }
    if (lo.kind === "int" && step.kind === "int" && (hi === null || hi.kind === "int")) return { t: "range", lo: lo.v, step: step.v, hi: hi?.v ?? null };
    return { t: "rationalRange", lo, step, hi };
}
function rangeSyntax(lo: Expr, second: Expr | null, hi: Expr | null): Expr {
    try { return rangeExpr(rangeNum(lo), second === null ? null : rangeNum(second), hi === null ? null : rangeNum(hi)); }
    catch { return { t: "computedRange", lo, second, hi }; }
}
import { lex } from "./lexer.ts";
import { APNError, tokLen } from "./errors.ts";
import type { Expr, Pattern, TopLevel, BinOp, FunctionSpec } from "./ast.ts";
import type { Type, Value, Env } from "./types.ts";
import type { Token } from "./lexer.ts";

// ---------------- Parser ----------------

class Parser {
    toks: Token[];
    i = 0;
    seen: Token | null = null; // last token peeked/consumed — where a failure points

    constructor(toks: Token[], private source: string, private file = "<repl>") { this.toks = toks; }

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
            const signatureStart = this.i;
            if (this.isSym("[") || this.isSym("(")) {
                try {
                    this.noLambda++;
                    let type: Expr;
                    try { type = this.parsePrimary(); } finally { this.noLambda--; }
                    if (this.startsParam(this.peek())) {
                        const value = this.parsePattern();
                        this.expectSym(")");
                        return { p: "schema", type, value };
                    }
                } catch { /* ordinary grouped pattern */ }
                this.i = signatureStart;
            }
            try {
                const spec = this.parseFunctionSpec();
                if (!("name" in spec) && this.peek().k !== "eof" && !this.isSym(")")) {
                    const value = this.parsePattern();
                    this.expectSym(")");
                    return { p: "contract", spec, value };
                }
            } catch { /* ordinary grouping or constructor pattern */ }
            this.i = signatureStart;
            const typeName = this.peek(), valueName = this.peek(1), closing = this.peek(2);
            if (typeName.k === "ident" && /^[a-z]/.test(typeName.v) &&
                valueName.k === "ident" && closing.k === "sym" && closing.v === ")") {
                this.next();
                const value = this.parsePattern();
                this.expectSym(")");
                return { p: "typeBind", name: typeName.v, value };
            }
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
                if (this.isKeyedEntry()) {
                    if (mode === "bare") throw new Error("Parser: pattern cannot mix bare names and 'key: name' entries");
                    mode = "keyed";
                    const key = this.parseKey();
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
            if (nullaryCtors.has(name)) return { p: "constr", tag: name, args: [] };
            // constructor application: Just x
            if (/^[A-Z]/.test(name)) {
                const args = [] as Pattern[];
                while (this.startsParam(this.peek())) {
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
        const start = this.peek().pos;
        const expression = this.parsePipe();
        sourceLocations.set(expression, { source: this.source, file: this.file, start, end: this.peek().pos });
        return expression;
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
        const start = this.peek().pos;
        const f = this.parseTernary();
        sourceLocations.set(f, { source: this.source, file: this.file, start, end: this.peek().pos });
        if (!this.isSym("$")) return f;
        this.next();
        const argumentStart = this.peek().pos;
        const x = this.parsePipe();
        sourceLocations.set(x, { source: this.source, file: this.file, start: argumentStart, end: this.peek().pos });
        return { t: "pipe", f, x };
    }

    // Ternary:  cond ? a : b    (right-associative, lower precedence than comparison)
    parseTernary(): Expr {
        let e = this.parseLogicalOr();
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

    parseLogicalOr(): Expr {
        let e = this.parseLogicalAnd();
        while (this.isSym("||")) {
            this.next();
            e = { t: "binop", op: "||", l: e, r: this.parseLogicalAnd() };
        }
        return e;
    }

    parseLogicalAnd(): Expr {
        let e = this.parseCompare();
        while (this.isSym("&&")) {
            this.next();
            e = { t: "binop", op: "&&", l: e, r: this.parseCompare() };
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
        if (this.isSym("-")) { this.next(); return { t: "unop", op: "neg", e: this.parsePower() }; }
        if (this.isSym("!")) { this.next(); return { t: "unop", op: "not", e: this.parsePower() }; }
        return this.parsePower();
    }

    parsePower(): Expr {
        const left = this.parseComposition();
        // Leave a trailing ^ for the operand-front operator section (2 ^).
        if (this.isSym("^") && !(this.peek(1).k === "sym" && (this.peek(1) as { v: string }).v === ")")) {
            this.next();
            return { t: "binop", op: "^", l: left, r: this.parseUnary() };
        }
        return left;
    }

    // Application binds tighter than composition; composition binds tighter than *.
    parseComposition(): Expr {
        const left = this.parseApp();
        if (this.isSym("\\") && !(this.peek(1).k === "sym" && (this.peek(1) as { v: string }).v === ")")) {
            this.next();
            this.skipContinuation();
            return { t: "binop", op: "\\", l: left, r: this.parseComposition() };
        }
        return left;
    }

    parseApp(): Expr {
        const start = this.peek().pos;
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
                sourceLocations.set(a, { source: this.source, file: this.file, start: t.pos, end: this.peek().pos });
                f = { t: "app", f, a };
                sourceLocations.set(f, { source: this.source, file: this.file, start, end: this.peek().pos });
            } else break;
        }
        return f;
    }

    // Postfix:  quoted OBJECT access  a.b, a."b", a.123  and the
    // quoted record PLUCK, or evaluated list-template inputs
    //   a.[x, y]            -> list of those fields' values
    //   a.[x: v1, y: v2]    -> smaller object: field x kept under the key v1
    parsePostfix(e: Expr): Expr {
        while (this.isSym(".")) {
            this.next();
            const t = this.peek();
            if (t.k === "sym" && (t as { v: string }).v === "[") {
                const bracketStart = this.i;
                const values = this.parsePrimary();
                const bracketEnd = this.i;
                this.i = bracketStart;
                let quoted = true;
                this.next(); // [
                this.skipListLeading();
                const entries: Array<string | [string, string]> = [];
                try {
                    while (!this.isSym("]")) {
                        const key = this.parseKey();
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
                } catch { quoted = false; entries.length = 0; }
                this.i = bracketEnd;
                e = { t: "pluck", rec: e, entries, values, quoted };
            } else {
                const keyStart = this.i;
                const field = this.parseKey();
                const keyEnd = this.i;
                let argument: Expr | undefined;
                if (t.k === "ident" || t.k === "str" || (t.k === "sym" && t.v === "(")) {
                    this.i = keyStart;
                    try { argument = this.parsePrimary(); } catch { /* record keys need not be expressions */ }
                    this.i = keyEnd;
                }
                e = { t: "recordAccess", rec: e, field, ...(argument ? { argument } : {}) };
            }
        }
        return e;
    }

    // Parentheses quote their complete spelling, rather than evaluating an expression.
    parseKey(): string {
        const t = this.next();
        if (t.k === "sym" && t.v === "-") {
            const number = this.next();
            if (number.k !== "int" && number.k !== "float") throw new Error("Parser: expected a numeric field name after '-'");
            return "-" + this.keyTok(number);
        }
        if (t.k === "sym" && t.v === "(") {
            const closes = [")"];
            const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
            while (closes.length) {
                const token = this.next();
                if (token.k === "eof") throw new Error("Parser: unclosed parenthesized field name");
                if (token.k !== "sym") continue;
                if (pairs[token.v]) closes.push(pairs[token.v]);
                else if ([")", "]", "}"].includes(token.v)) {
                    if (token.v !== closes.pop()) throw new Error("Parser: mismatched delimiter in field name");
                    if (!closes.length) return this.source.slice(t.pos, token.pos + 1);
                }
            }
        }
        return this.keyTok(t);
    }

    isKeyedEntry(): boolean {
        const saved = this.i;
        try { this.parseKey(); return this.isSym(":"); }
        catch { return false; }
        finally { this.i = saved; }
    }

    // Preserve identifier versus string-key identity; numeric fields retain their spelling.
    keyTok(t: Token): string {
        if (t.k === "ident") return t.v;
        if (t.k === "str") return stringKey(t.v);
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
        if (t.k === "ident" && (TYPE_NAMES.includes(t.v) || functionTypeNames.has(t.v))) {
            const save = this.i;
            try {
                const spec = this.parseFunctionSpec();
                if (!("name" in spec)) return { t: "functionType", spec };
            } catch { /* ordinary expression */ }
            this.i = save;
        }
        if (!this.noLambda && this.startsParam(t)) {
            const save = this.i;
            let header: { params: Pattern[]; guard?: Expr } | undefined;
            try { header = this.lambdaHeader(); } catch { this.i = save; }
            if (header) {
                this.skipContinuation();
                const body = this.isSym("{") ? this.parsePrimary() : this.parseExpr();
                if (!header.guard && header.params.every(p => p.p === "var")) {
                    return { t: "lambda", params: header.params.map(p => (p as Extract<Pattern, { p: "var" }>).name), body };
                }
                return { t: "patternLambda", ...header, body };
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
                        // () and {} are the same: a group/block. Empty blocks return an empty list.
                        if (this.isSym(close)) { this.next(); return { t: "block", stmts: [], style: t.v }; }
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
                            if (this.isEagerBinding()) {
                                stmts.push(this.parseEagerBinding());
                            } else if (this.isFieldAssignStart()) {
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
                                stmts.push(this.isDef() ? this.parseBlockDef() : this.tryItemAssign() ?? this.parseDelimitedExpr());
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
                        if (this.isKeyedEntry()) {
                            const fs: Array<[string, Expr]> = [];
                            for (;;) {
                                const key = this.parseKey();
                                this.expectSym(":");
                                fs.push([key, this.parseDelimitedExpr()]);
                                this.skipListSeparators();
                                if (this.isSym("]")) { this.next(); return { t: "record", v: fs }; }
                                if (this.peek().k === "eof") throw new Error("Parser: unexpected end of file inside record literal");
                            }
                        }
                        // Otherwise it's a list literal: [a, b, ...] — elements separate on
                        // `,` OR a newline (commas are optional when each element is on its
                        // own line;  [1 2] on ONE line is still a single element = 1 applied to 2).
                        // RANGE (speculative): [a..b] [a..] [a,b..c] [a,b..] — Haskell-style; the
                        // first two elements give the STEP; bounds may be runtime expressions;
                        // no upper bound = INFINITE. Falls back to a normal list literal.
                        {
                            const save = this.i;
                            const loE = this.parseAdd();
                            if (this.isSym("..")) {
                                this.next();
                                if (this.isSym("]")) {
                                    this.next();
                                    return rangeSyntax(loE, null, null);
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

                                // implicit step ADAPTS to direction: [0..-100] descends;
                                // an EXPLICIT step pointing the wrong way stays empty
                                return rangeSyntax(loE, null, hi);
                            }
                            if (this.isSym(",") && this.peek(1).k !== "newline" &&
                                    this.peek(1).k !== "dedent" &&
                                    !(this.peek(1).k === "sym" && (this.peek(1) as { v: string }).v === "]")) {
                                const save2 = this.i;
                                this.next();
                                const sE = this.parseAdd();
                                if (this.isSym("..")) {
                                    this.next();

                                    if (this.isSym("]")) {
                                        this.next();
                                        return rangeSyntax(loE, sE, null);
                                    }
                                    const hi = this.parseAdd();
                                    this.expectSym("]");
                                    return rangeSyntax(loE, sE, hi);
                                }
                                this.i = save2; // [1, 2] — a plain list
                            }
                            this.i = save; // not a range at all
                        }
                        const es = [] as Expr[];
                        for (;;) {
                            es.push(this.parseDelimitedExpr());
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
            case "import": {
                this.next();
                if (this.eatSym("[")) {
                    const modules: string[] = [];
                    this.skipListLeading();
                    while (!this.isSym("]")) {
                        const module = this.next();
                        if (module.k !== "str") throw new Error("Parser: import expects module name strings");
                        modules.push(module.v);
                        if (!this.isSym("]") && !this.isSym(",") && this.peek().k !== "newline" && this.peek().k !== "dedent") {
                            throw new Error("Parser: separate import module names with commas or newlines");
                        }
                        this.skipListSeparators();
                    }
                    this.next();
                    return { t: "import", module: modules };
                }
                const module = this.next();
                if (module.k !== "str") throw new Error("Parser: import expects a module name string or a list of strings");
                return { t: "import", module: module.v };
            }
            case "true": this.next(); return { t: "bool", v: true };
            case "false": this.next(); return { t: "bool", v: false };
            default:
                this.next();
                throw new Error(`Parser: unexpected keyword '${t.v}'`);
        }
    }

    parseFunctionSpec(): FunctionSpec {
        let left: FunctionSpec;
        if (this.eatSym("(")) {
            left = this.parseFunctionSpec();
            this.expectSym(")");
        } else {
            const token = this.next();
            if (token.k !== "ident" || !(TYPE_NAMES.includes(token.v) || functionTypeNames.has(token.v))) throw new Error("Parser: expected a type constructor");
            left = { name: token.v };
        }
        return this.eatSym("->") ? { from: left, to: this.parseFunctionSpec() } : left;
    }

    parseDelimitedExpr(): Expr {
        const saved = this.noLambda;
        this.noLambda = 0;
        try { return this.parseExpr(); } finally { this.noLambda = saved; }
    }

    noLambda = 0;
    lambdaHeader(): { params: Pattern[]; guard?: Expr } {
        const params: Pattern[] = [];
        while (this.startsParam(this.peek())) {
            // Preserve the legacy parenthesized annotation form.
            const first = this.peek(1), colon = this.peek(2);
            if (this.isSym("(") && first.k === "ident" && /^[a-z]/.test(first.v) && colon.k === "sym" && colon.v === ":") {
                this.next();
                do {
                    const name = this.next();
                    if (name.k !== "ident") throw new Error("Parser: expected parameter");
                    params.push({ p: "var", name: name.v });
                    if (this.eatSym(":")) this.parseType();
                } while (this.eatSym(","));
                this.expectSym(")");
            } else params.push(this.parseConsPattern());
            if (this.eatSym(":")) this.parseType();
        }
        if (!params.length) throw new Error("Parser: expected lambda parameters");
        let guard: Expr | undefined;
        if (this.eatSym("|")) {
            this.noLambda++;
            try { guard = this.parsePipe(); } finally { this.noLambda--; }
        }
        this.expectSym("->");
        return { params, guard };
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
        if (this.peek().k !== "ident") return false;
        const saved = this.i;
        try {
            this.next();
            if (!this.eatSym(".")) return false;
            if (this.eatSym("[")) {
                this.skipListLeading();
                while (!this.isSym("]")) {
                    this.parseKey();
                    this.skipListSeparators();
                }
                this.next();
            } else {
                this.parseKey();
                while (this.eatSym(".")) {
                    if (this.eatSym("[")) {
                        this.skipListLeading();
                        while (!this.isSym("]")) { this.parseKey(); this.skipListSeparators(); }
                        this.next();
                        break;
                    }
                    this.parseKey();
                }
            }
            return this.isSym("=");
        } catch { return false; }
        finally { this.i = saved; }
    }

    parseFieldAssign(): Expr {
        const nt = this.next();
        if (nt.k !== "ident") throw new Error("Parser: expected a name before '.'");
        const name = nt.v;
        this.next(); // "."
        const entries: string[] = [];
        const path: string[] = [];
        while (!this.isSym("[")) {
            const saved = this.i;
            const key = this.parseKey();
            if (!this.eatSym(".")) { this.i = saved; break; }
            path.push(key);
        }
        const bracketed = this.isSym("[");
        if (bracketed) {
            this.next();
            this.skipListLeading();
            while (!this.isSym("]")) {
                entries.push(this.parseKey());
                this.skipListSeparators();
                if (this.isSym("]")) break;
                if (this.peek().k === "eof") {
                    throw new Error("Parser: unexpected end of file inside field-assignment entries");
                }
            }
            this.next(); // ]
        } else {
            entries.push(this.parseKey());
        }
        this.expectSym("=");
        const rhs = this.parseExpr();
        // Bracketed selection always takes a list, including one or zero fields.
        // Only direct field assignment wraps its scalar RHS.
        const value = bracketed ? rhs : { t: "list", v: [rhs] } as Expr;
        return {
            t: "patDef",
            pattern: { p: "var", name },
            value: { t: "setFields", rec: { t: "var", name }, entries, value, ...(path.length ? { path } : {}) },
        };
    }

    isEagerBinding(): boolean {
        const saved = this.i;
        try {
            this.parseConsPattern();
            return this.isSym("<-");
        } catch { return false; }
        finally { this.i = saved; }
    }

    parseEagerBinding(): Expr {
        const pattern = this.parseConsPattern();
        this.expectSym("<-");
        return { t: "patDef", pattern, value: this.parseDefBody("<-"), eager: true };
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
    static sectionOps = ["&&", "||", "\\", "^", "+", "*", "/", "%", "==", "!=", "<", ">", "<=", ">=", "++"];

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

    // Expression-only indices (e.g. arr (i + 1) = value) cannot be function
    // patterns. Pattern-compatible forms use normal definitions and dispatch
    // against the existing binding at evaluation time.
    tryItemAssign(): Expr | null {
        const first = this.peek();
        if (first.k !== "ident" || !/^[a-z]/.test(first.v)) return null;
        // Avoid parsing every ordinary expression twice merely to look for '='.
        let depth = 0, assignment = false;
        for (let j = this.i; j < this.toks.length; j++) {
            const token = this.toks[j];
            if (!depth && ["newline", "dedent", "eof"].includes(token.k)) break;
            if (token.k !== "sym") continue;
            if (!depth && token.v === "=") { assignment = true; break; }
            if (!depth && [";", ")", "]", "}"].includes(token.v)) break;
            if (["(", "[", "{"].includes(token.v)) depth++;
            else if ([")", "]", "}"].includes(token.v)) depth--;
        }
        if (!assignment) return null;
        const saved = this.i;
        let left: Expr;
        try {
            left = this.parseApp();
            if (!this.isSym("=") || left.t !== "app" || left.f.t !== "var" || !/^[a-z]/.test(left.f.name)) {
                this.i = saved; return null;
            }
        } catch { this.i = saved; return null; }
        this.expectSym("=");
        const value = this.parseDefBody();
        return { t: "patDef", pattern: { p: "var", name: left.f.name },
            value: { t: "setItem", rec: left.f, index: left.a, value } };
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
    parseDefBody(operator = "="): Expr {
        if (this.peek().k === "newline") {
            let j = this.i;
            while (this.toks[j] && this.toks[j].k === "newline") j++;
            if (this.toks[j] && this.toks[j].k === "indent") {
                const first = this.toks[j + 1];
                if (first?.k === "sym" && first.v === "{") {
                    this.i = j + 1;
                    throw new Error(`Parser: a definition's opening { must be on the same line as '${operator}'`);
                }
                return this.parseExpr();
            }
            throw new Error(`Parser: expected an expression after '${operator}'; use '_' for an unfinished definition`);
        }
        if (this.peek().k === "eof" || this.peek().k === "dedent" ||
            this.isSym(";") || this.isSym("}") || this.isSym(")") || this.isSym("]")) {
            throw new Error(`Parser: expected an expression after '${operator}'; use '_' for an unfinished definition`);
        }
        return this.parseExpr();
    }

    // A top-level pipe marks constructor declarations, including a leading pipe
    // for a single constructor. Without it, fresh capitals are type aliases
    // and existing constructors on the left remain destructuring patterns.
    isTypeDeclaration(): boolean {
        const name = this.peek();
        if (name.k !== "ident" || !/^[A-Z]/.test(name.v)) return false;
        let j = 1;
        while (this.peek(j).k === "ident") j++;
        const equal = this.peek(j++);
        if (equal.k !== "sym" || equal.v !== "=") return false;
        while (["newline", "indent"].includes(this.peek(j).k)) j++;
        const leading = this.peek(j);
        if (leading.k === "sym" && leading.v === "|") return true;
        const ctor = this.peek(j);
        if (ctor.k !== "ident" || !/^[A-Z]/.test(ctor.v)) return false;
        let depth = 0;
        for (;;) {
            const token = this.peek(j++);
            if (token.k === "eof" || token.k === "dedent") return false;
            if (token.k === "sym") {
                if (!depth && token.v === "|") return true;
                if (!depth && token.v === ";") return false;
                if (["(", "[", "{"].includes(token.v)) depth++;
                if ([")", "]", "}"].includes(token.v)) depth--;
            }
            if (!depth && token.k === "newline") {
                while (["newline", "indent"].includes(this.peek(j).k)) j++;
                const next = this.peek(j);
                return next.k === "sym" && next.v === "|";
            }
        }
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
            if (this.lineIndent(t) !== 0) {
                throw new Error("Parser: top-level statements must not be indented");
            }

            if (this.isEagerBinding()) {
                out.push(this.parseEagerBinding() as TopLevel);
                continue;
            }

            if (this.isTypeDeclaration()) {
                const name = (this.next() as { v: string }).v;
                const parameters: string[] = [];
                while (this.peek().k === "ident") parameters.push((this.next() as { v: string }).v);
                if (parameters.some(p => !/^[a-z]/.test(p)) || new Set(parameters).size !== parameters.length) throw new Error("Parser: type parameters must be distinct lowercase names");
                this.expectSym("=");
                this.skipNL();
                this.eatSym("|");
                const variants: { tag: string; arity: number; fields: Expr[] }[] = [];
                for (;;) {
                    this.skipNL();
                    const vt = this.next();
                    if (vt.k !== "ident" || !/^[A-Z]/.test(vt.v)) {
                        throw new Error("Parser: expected a capitalized constructor name");
                    }
                    const fields: Expr[] = [];
                    while (this.peek().k === "ident" || this.isSym("(") || this.isSym("[")) {
                        this.noLambda++;
                        try { fields.push(this.parsePrimary()); } finally { this.noLambda--; }
                    }
                    variants.push({ tag: vt.v, arity: fields.length, fields });
                    if (this.eatSym("|")) continue;
                    let ahead = 0;
                    while (["newline", "indent"].includes(this.peek(ahead).k)) ahead++;
                    const separator = this.peek(ahead);
                    if (separator.k === "sym" && separator.v === "|") {
                        this.i += ahead + 1;
                        continue;
                    }
                    break;
                }
                if (new Set(variants.map(v => v.tag)).size !== variants.length) throw new Error("Parser: duplicate value constructor");
                if (variants.some(v => TYPE_NAMES.includes(v.tag))) throw new Error("Parser: a value constructor cannot replace a built-in type");
                // Register only after the entire declaration has parsed successfully.
                for (const { tag, arity } of variants) {
                    declaredCtors.add(tag);
                    if (arity === 0) nullaryCtors.add(tag); else nullaryCtors.delete(tag);
                }
                functionTypeNames.add(name);
                out.push({ t: "type", def: { name, parameters, variants } });
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
                // Fresh capitalized definitions are type aliases. Existing
                // constructors were handled as destructuring bindings above.
                if (/^[A-Z]/.test(t.v)) {
                    if (this.isDef()) {
                        const declaration = this.parseDefStatement();
                        if (TYPE_NAMES.includes(declaration.name)) throw new Error("Parser: built-in type names cannot be reassigned");
                        functionTypeNames.add(declaration.name);
                        out.push({ t: "def", ...declaration });
                        continue;
                    }
                    const e = this.parseExpr();
                    out.push({ t: "expr", value: e });
                    continue;
                }
                if (this.isDef()) {
                    const d = this.parseDefStatement();
                    out.push({ t: "def", name: d.name, clauses: d.clauses });
                } else {
                    const assignment = this.tryItemAssign();
                    if (assignment) out.push(assignment as TopLevel);
                    else out.push({ t: "expr", value: this.parseExpr() });
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
                    t.k === "str" || t.k === "char") {
                const e = this.parseExpr();
                out.push({ t: "expr", value: e });
                continue;
            }

            throw new Error(`Parser: unexpected '${this.tokenStr(t)}'`);
        }
        return out;
    }
}

// Constructors declared via capitalized bindings. This is what makes an Uppercase LHS with
// args ambiguous: `Just v = ...` destructures only when `Just` was DECLARED a
// constructor; otherwise `Vector3 x y z = [x: x, y: y, z: z]` stays a plain
// (record-constructor) function def. Module-level so declarations persist
// across REPL lines (each line is re-parsed standalone).
let declaredCtors = new Set<string>();
const functionTypeNames = new Set<string>();
const nullaryCtors = new Set<string>();

// Tooling parses each document independently, without leaking REPL declarations.
export function parseDocument(src: string): TopLevel[] {
    const sets = [declaredCtors, functionTypeNames, nullaryCtors];
    const saved = sets.map((set) => [...set]);
    sets.forEach((set) => set.clear());
    try { return parse(src); }
    finally {
        sets.forEach((set, i) => {
            set.clear();
            saved[i].forEach((name) => set.add(name));
        });
    }
}

export function parse(src: string, file = "<repl>"): TopLevel[] {
    let toks: Token[];
    try {
        toks = lex(src);
    } catch (err) {
        if (err instanceof APNError) err.src = src;
        throw err;
    }
    const p = new Parser(toks, src, file);
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
        case "computedRange": return `[${exprToSource(e.lo)}${e.second === null ? "" : ", " + exprToSource(e.second)}..${e.hi === null ? "" : exprToSource(e.hi)}]`;
        case "import": return `import ${JSON.stringify(e.module)}`;
        case "numeric": return numberText(e.v);
        case "rationalRange": return `[${numberText(e.lo)}, ${numberText(arithmetic("+", e.lo, e.step))}..${e.hi === null ? "" : numberText(e.hi)}]`;
        case "int": return String(e.v);
        case "float": return numberText({ kind: "float", v: e.v });
        case "bool": return e.v ? "true" : "false";
        case "string": return `"${e.v}"`;
        case "char": return `'${e.v}'`;
        case "placeholder": return "_";
        case "var": return e.name;
        case "binop": return `${exprToSource(e.l)} ${e.op} ${exprToSource(e.r)}`;
        case "unop": return `${e.op === "neg" ? "-" : "!"}${exprToSource(e.e)}`;
        case "app": return `${exprToSource(e.f)} ${exprToSource(e.a)}`;
        case "functionType": return functionSpecSource(e.spec);
        case "patternLambda": return `${e.params.map(patternSource).join(" ")}${e.guard ? " | " + exprToSource(e.guard) : ""} -> ${exprToSource(e.body)}`;
        case "lambda": return `${e.params.join(" ")} -> ${exprToSource(e.body)}`;
        case "list": return `[${e.v.map(exprToSource).join(", ")}]`;
        case "record": return `[${e.v.map(([k, x]) => `${keySource(k)}: ${exprToSource(x)}`).join(", ")}]`;
    case "floatRange": {
        const decimal = (v: number) => Number.isInteger(v) ? `${v}.0` : String(v);
        return `[${decimal(e.lo)}${e.step !== 1 ? `, ${decimal(e.lo + e.step)}` : ""}..${e.hi === null ? "" : decimal(e.hi)}]`;
    }
    case "range":
      return e.hi === null
        ? `[${e.lo}${e.step !== 1n ? `, ${e.lo + e.step}` : ""}..]`
        : `[${e.lo}${e.step !== 1n ? `, ${e.lo + e.step}` : ""}..${e.hi}]`;
        case "ternary": return `${exprToSource(e.cond)} ? ${exprToSource(e.then)} : ${exprToSource(e.els)}`;
        case "pipe": return `${exprToSource(e.f)} $ ${exprToSource(e.x)}`;
        case "recordAccess":
            return `${exprToSource(e.rec)}.${keySource(e.field)}`;
        case "pluck":
            if (e.values) return `${exprToSource(e.rec)}.${exprToSource(e.values)}`;
            return `${exprToSource(e.rec)}.[${e.entries.map((x) => typeof x === "string" ? keySource(x) : `${keySource(x[0])}: ${x[1]}`).join(", ")}]`;
        case "setItem": return `${exprToSource(e.rec)} (${exprToSource(e.index)}) = ${exprToSource(e.value)}`;
        case "setFields":
            return `${exprToSource(e.rec)}.${(e.path ?? []).map(keySource).map(key => key + ".").join("")}[${e.entries.map(keySource).join(", ")}] = ${exprToSource(e.value)}`;
        case "block": {
            const one = e.stmts.length === 1 && e.stmts[0].t !== "stmDef" && e.stmts[0].t !== "patDef";
            if (one && e.style === "(") return exprToSource(e.stmts[0]);
            const body = e.stmts.map((st) => {
                if (st.t === "stmDef") return `${st.name} = ${exprToSource(st.clauses[0].body)}`;
                if (st.t === "patDef" && (st.value.t === "setItem" || st.value.t === "setFields")) return exprToSource(st.value);
                if (st.t === "patDef") return `${patternSource(st.pattern)} ${st.eager ? "<-" : "="} ${exprToSource(st.value)}`;
                return exprToSource(st);
            }).join("; ");
            return `${e.style === "(" ? "(" : "{"} ${body} ${e.style === "(" ? ")" : "}"}`;
        }
        default: return "<expr>";
    }
}
export function functionSpecSource(spec: FunctionSpec): string {
    return "name" in spec ? spec.name : `${"name" in spec.from ? functionSpecSource(spec.from) : "(" + functionSpecSource(spec.from) + ")"} -> ${functionSpecSource(spec.to)}`;
}
export function patternSource(p: Pattern): string {
    switch (p.p) {
        case "schema": return `(${exprToSource(p.type)} ${patternSource(p.value)})`;
        case "contract": return `((${functionSpecSource(p.spec)}) ${patternSource(p.value)})`;
        case "wildcard": return "_";
        case "var": return p.name;
        case "int": return String(p.v);
        case "bool": return String(p.v);
        case "string": return JSON.stringify(p.v);
        case "list": return `[${p.v.map(patternSource).join(", ")}]`;
        case "cons": return `(${patternSource(p.head)} : ${patternSource(p.tail)})`;
        case "constr": return p.args.length ? `(${p.tag} ${p.args.map(patternSource).join(" ")})` : p.tag;
        case "typeBind": return `(${p.name} ${patternSource(p.value)})`;
        case "recPat": return `[${p.v.map(([k, v]) => `${keySource(k)}: ${v}`).join(", ")}]`;
        case "range": return `[${p.lo}..${p.hi}]`;
    }
}
