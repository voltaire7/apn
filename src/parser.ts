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
import { lex, OPERATOR_CHARS } from "./lexer.ts";
import preludeSource from "../lib/prelude.apn" with { type: "text" };
import { APNError, tokLen } from "./errors.ts";
import type { Expr, Pattern, TopLevel, BinOp } from "./ast.ts";
import type { Type, Value, Env } from "./types.ts";
import type { Token } from "./lexer.ts";

// ---------------- Fixity ----------------

// An operator's precedence (0 loosest .. 9) and associativity, from fixity
// declarations: the prelude's, and any a program makes (infixl 6 +, infixr 5
// ++ +++, infix 4 ==). An undeclared operator is infixl 9.
export interface Fixity { prec: number; assoc: "left" | "right" | "none" }
const fixities = new Map<string, Fixity>();
export function fixityOf(op: string): Fixity {
    return fixities.get(op) ?? { prec: 9, assoc: "left" };
}
// Tokens that are syntax, not operators, though made of operator characters.
const RESERVED_OPERATORS = new Set(["=", "|", "->", "<-", "!"]);
// The intrinsics behind the prelude's operators (lib/prelude.apn binds
// each symbol to one), keyed by name.
export const PRIMITIVE_OPERATORS = new Map<string, string>([
    ["primApply", "$"], ["primOr", "||"], ["primAnd", "&&"], ["primEq", "=="], ["primNe", "!="],
    ["primLt", "<"], ["primGt", ">"], ["primLe", "<="], ["primGe", ">="], ["primCons", ":"],
    ["primAdd", "+"], ["primSub", "-"], ["primAppend", "++"], ["primMul", "*"], ["primDiv", "/"],
    ["primMod", "%"], ["primPow", "^"], ["primCompose", "\\"],
]);

export function isOperatorName(text: string): boolean {
    return text.length > 0 && [...text].every((c) => OPERATOR_CHARS.includes(c)) && !RESERVED_OPERATORS.has(text);
}
function isFixityStart(toks: Token[], i: number): boolean {
    const t = toks[i], previous = toks[i - 1], next = toks[i + 1];
    return t.k === "ident" && ["infixl", "infixr", "infix"].includes(t.v) && next?.k === "int" &&
        (!previous || ["newline", "indent", "dedent"].includes(previous.k) || previous.k === "sym" && previous.v === ";");
}
// Record a source's fixity declarations, wherever they stand in it, before
// it is parsed; they then hold for every later parse too (REPL inputs, and
// files parsed after the module that declares them).
function declareFixities(toks: Token[]): void {
    for (let i = 0; i < toks.length; i++) {
        if (!isFixityStart(toks, i)) continue;
        const kind = (toks[i] as { v: string }).v, level = Number((toks[i + 1] as { v: bigint }).v);
        let j = i + 2;
        for (; toks[j]?.k === "sym" && isOperatorName((toks[j] as { v: string }).v); j++) {
            if (level > 9) throw new APNError("parse", "a precedence is 0 to 9", { pos: toks[i + 1].pos });
            fixities.set((toks[j] as { v: string }).v, { prec: level, assoc: kind === "infixl" ? "left" : kind === "infixr" ? "right" : "none" });
        }
        if (j === i + 2) throw new APNError("parse", `${kind} needs the operators it declares (write ${kind} 6 +)`, { pos: toks[i].pos });
    }
}
declareFixities(lex(preludeSource));

// ---------------- Parser ----------------

class Parser {
    toks: Token[];
    i = 0;
    seen: Token | null = null; // last token peeked/consumed — where a failure points

    constructor(toks: Token[], private source: string, private file = "<repl>") { this.toks = toks; }

    // Spacing: around a binding's = and at ',' (see checkEqualsSpacing and
    // checkCommaSpacing), and inside brackets on one line: a { } block keeps exactly one space
    // inside each brace ({ 123 }), while ( ) and [ ] keep none ((123), [1,2]);
    // empty ones are {}, () and []. A bracket ending its line (before an
    // optional comment) or a closing one starting its line is laid out instead.
    checkBracketSpacing(): void {
        const pairs: Record<string, string> = { "{": "}", "(": ")", "[": "]", "}": "{", ")": "(", "]": "[" };
        // What each open bracket holds: record fields, or list items (and groups).
        const holds: boolean[] = [];
        for (const [index, t] of this.toks.entries()) {
            if (t.k === "sym" && t.v === "=") this.checkEqualsSpacing(t);
            if (t.k === "sym" && t.v === ",") {
                this.checkTrailingComma(index);
                this.checkCommaSpacing(t, holds[holds.length - 1] ?? false);
            }
            if (t.k === "sym" && t.v === ";") this.checkSemicolon(index);
            if (t.k === "sym" && "([{".includes(t.v)) holds.push(t.v === "[" && this.opensRecord(index));
            if (t.k === "sym" && ")]}".includes(t.v)) holds.pop();
            if (t.k !== "sym" || !(t.v in pairs)) continue;
            // Application is juxtaposition with a space: Vector3 [1,2,3],
            // func (123) and run { x }, not Vector3[1,2,3], func(123) or run{ x }.
            if ("([{".includes(t.v) && /[A-Za-z0-9_'")\]}]/.test(this.source[t.pos - 1] ?? "")) {
                this.seen = t;
                const example = { "[": "f [1,2], not f[1,2]", "(": "f (x), not f(x)", "{": "f { x }, not f{ x }" }[t.v];
                throw new Error(`Parser: put a space before '${t.v}' to apply to it (write ${example})`);
            }
            const open = "{([".includes(t.v), brace = t.v === "{" || t.v === "}";
            const neighbour = this.toks[index + (open ? 1 : -1)];
            let gap: string;
            if (neighbour?.k === "sym" && neighbour.v === pairs[t.v]) {
                gap = this.source.slice(Math.min(t.pos, neighbour.pos) + 1, Math.max(t.pos, neighbour.pos));
                if (gap === "" || /\n/.test(gap)) continue;
                this.seen = t;
                throw new Error(`Parser: write an empty ${brace ? "block" : "group"} as ${open ? t.v + pairs[t.v] : pairs[t.v] + t.v}`);
            } else if (open) {
                const rest = this.source.slice(t.pos + 1).split("\n", 1)[0];
                if (/^\s*(#.*)?$/.test(rest)) continue;
                gap = rest.match(/^\s*/)![0];
                if (brace ? gap === " " : gap === "") continue;
            } else {
                const before = this.source.slice(this.source.lastIndexOf("\n", t.pos - 1) + 1, t.pos);
                if (/^\s*$/.test(before)) continue;
                gap = before.match(/\s*$/)![0];
                if (brace ? gap === " " : gap === "") continue;
            }
            this.seen = t;
            const side = open ? `after '${t.v}'` : `before '${t.v}'`;
            throw new Error(brace ? `Parser: put exactly one space ${side} (write { x }, or {} when empty)` : `Parser: remove the space ${side} (write ${open ? t.v : pairs[t.v]}x${open ? pairs[t.v] : t.v})`);
        }
    }

    // A binding's = has exactly one space on each side (x = 1), or ends its line.
    checkEqualsSpacing(t: Token): void {
        const before = this.source.slice(this.source.lastIndexOf("\n", t.pos - 1) + 1, t.pos);
        const after = this.source.slice(t.pos + 1).split("\n", 1)[0];
        if (/\S $/.test(before) && (/^ \S/.test(after) || /^\s*(#.*)?$/.test(after))) return;
        this.seen = t;
        throw new Error("Parser: put exactly one space on each side of '=' (write x = 1)");
    }

    // A ';' separates two statements on one line (print 1; print 2): it
    // follows the first directly and takes one space before the second. A
    // newline already ends a statement, so a ';' ending its line, starting
    // one, doubled, or next to a bracket's inside is redundant.
    checkSemicolon(index: number): void {
        const t = this.toks[index], previous = this.toks[index - 1], next = this.toks[index + 1];
        const before = this.source.slice(this.source.lastIndexOf("\n", t.pos - 1) + 1, t.pos);
        const after = this.source.slice(t.pos + 1).split("\n", 1)[0];
        const opens = (x?: Token) => x?.k === "sym" && ["{", "(", "[", ";"].includes(x.v);
        const closes = (x?: Token) => x?.k === "sym" && ["}", ")", "]", ";"].includes(x.v);
        this.seen = t;
        if (/^\s*(#.*)?$/.test(after)) throw new Error("Parser: a newline already ends a statement; remove the ';' at the end of the line");
        if (/^\s*$/.test(before) || opens(previous) || closes(next)) throw new Error("Parser: ';' separates two statements on one line; remove this one");
        if (/\s$/.test(before) || !/^ \S/.test(after)) throw new Error("Parser: separate statements on one line with '; ' (write print 1; print 2)");
    }

    // Whether the [ at index opens record fields ([x: 1], [.x], keyed patterns
    // and selections) rather than list items.
    opensRecord(index: number): boolean {
        let i = index + 1;
        while (["newline", "indent", "dedent"].includes(this.toks[i]?.k)) i++;
        const first = this.toks[i], second = this.toks[i + 1];
        if (first?.k === "sym" && first.v === "." && second?.k === "ident") return true;
        const saved = this.i;
        this.i = i;
        try { return this.isKeyedEntry(); } finally { this.i = saved; }
    }

    // A ',' separates two items; one before a closing bracket (even on the
    // next line) separates nothing ([1,2,] is written [1,2]).
    checkTrailingComma(index: number): void {
        let next = index + 1;
        while (["newline", "indent", "dedent"].includes(this.toks[next]?.k)) next++;
        const close = this.toks[next];
        if (close?.k !== "sym" || !["]", ")", "}"].includes(close.v)) return;
        this.seen = this.toks[index];
        throw new Error(`Parser: remove the trailing ',' before '${close.v}'`);
    }

    // A ',' follows its item directly. List items take nothing after it
    // ([1,2,3]); record fields take one space ([x: 1, y: 2]). A newline
    // already separates items, so a ',' ending its line is redundant.
    checkCommaSpacing(t: Token, record: boolean): void {
        const after = this.source.slice(t.pos + 1).split("\n", 1)[0];
        this.seen = t;
        if (/^\s*(#.*)?$/.test(after)) throw new Error("Parser: a newline already separates items; remove the ',' at the end of the line");
        if (!/\s/.test(this.source[t.pos - 1] ?? " ") && (record ? /^ \S/ : /^\S/).test(after)) return;
        throw new Error(record ? "Parser: separate record fields with ', ' (write [x: 1, y: 2])" : "Parser: separate list items with ',' alone (write [1,2,3])");
    }

    // A record key's ':' follows the key directly, with one space after it
    // (x: 1); a ':' ending its line leaves the value to the next.
    keyColon(): void {
        if (looseSpacing) return;
        const t = this.peek();
        const after = this.source.slice(t.pos + 1).split("\n", 1)[0];
        if (!/\s/.test(this.source[t.pos - 1] ?? " ") && (/^ \S/.test(after) || /^\s*(#.*)?$/.test(after))) return;
        this.seen = t;
        throw new Error("Parser: write a record field as key: value (no space before ':', one after)");
    }

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

    // ---- patterns

    parsePattern(): Pattern {
        const left = this.parsePatternAtom();
        return this.eatSym(".") ? { p: "as", left, right: this.parsePattern() } : left;
    }

    parsePatternAtom(): Pattern {
        const t = this.peek();
        if (t.k === "sym" && t.v === "_") { this.next(); return { p: "wildcard" }; }
        if (t.k === "int") { this.next(); return { p: "int", v: t.v }; }
        if (this.isSym("-") && this.peek(1).k === "int") {
            this.next();
            const value = this.next() as Extract<Token, { k: "int" }>;
            return { p: "int", v: -value.v };
        }
        if (t.k === "float") { this.next(); return { p: "float", v: t.v }; }
        if (this.isSym("-") && this.peek(1).k === "float") {
            this.next();
            const value = this.next() as Extract<Token, { k: "float" }>;
            return { p: "float", v: -value.v };
        }
        if (t.k === "char") { this.next(); return { p: "char", v: t.v }; }
        if (t.k === "bool") { this.next(); return { p: "bool", v: t.v }; }
        // The lexer reads true and false as keywords.
        if (t.k === "kw" && (t.v === "true" || t.v === "false")) { this.next(); return { p: "bool", v: t.v === "true" }; }
        if (t.k === "str") { this.next(); return { p: "string", v: t.v }; }
        if (t.k === "sym" && (t.v === "(" || t.v === "{")) {
            const close = t.v === "(" ? ")" : "}";
            this.next();
            if (this.isSym(close)) { this.next(); return { p: "list", v: [] }; }
            const signatureStart = this.i;
            // A typed pattern: ((Int -> Int) f), ([Int] xs). Its type is any
            // expression read as a type, a lambda included.
            if (this.isSym("[") || this.isSym("(") || this.isSym("{")) {
                try {
                    this.noLambda++;
                    let type: Expr;
                    try { type = this.parsePrimary(); } finally { this.noLambda--; }
                    if (this.startsParam(this.peek())) {
                        const value = this.parsePattern();
                        this.expectSym(close);
                        return { p: "schema", type, value };
                    }
                } catch { /* ordinary grouped pattern */ }
                this.i = signatureStart;
            }
            // A function type with no name, (a -> b), matches a function of
            // that type without binding it, as Int matches an Int.
            if (this.arrowBefore(close)) {
                const noLambda = this.noLambda;
                this.noLambda = 0;
                try {
                    const type = this.parseExpr();
                    if ((type.t === "lambda" || type.t === "patternLambda") && this.isSym(close)) {
                        this.next();
                        return { p: "schema", type, value: { p: "wildcard" } };
                    }
                } catch { /* an ordinary grouped pattern */ } finally { this.noLambda = noLambda; }
                this.i = signatureStart;
            }
            const typeName = this.peek(), valueName = this.peek(1), closing = this.peek(2);
            if (typeName.k === "ident" && /^[a-z]/.test(typeName.v) &&
                valueName.k === "ident" && closing.k === "sym" && closing.v === close) {
                this.next();
                const value = this.parsePattern();
                this.expectSym(close);
                return { p: "typeBind", name: typeName.v, value };
            }
            const p = this.parseConsPattern();
            if (this.eatSym(",")) {
                throw new Error("Parser: tuple patterns are not supported; use a list pattern [a, b, ...] instead");
            }
            this.expectSym(close);
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
                    const key = this.parseEntryKey();
                    this.keyColon();
                    this.next(); // :
                    const nm = this.next();
                    if (nm.k !== "ident") throw new Error("Parser: expected a binding name after ':' in record pattern");
                    if (key === "_" && keyed.some(([k]) => k === "_")) throw new Error("Parser: record pattern permits only one remainder");
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
            if (name === "_") return { p: "wildcard" };
            // Z, the built-in zero, takes no fields unless the program redeclares it.
            if (nullaryCtors.has(name) || name === "Z" && !declaredCtors.has(name)) return { p: "constr", tag: name, args: [] };
            // Vect exposes length, element type, and payload in one pattern.
            if (name === "Vect" && this.startsParam(this.peek())) {
                const size = this.parsePattern();
                const token = this.peek();
                let element: Pattern;
                if (token.k === "ident" && /^[A-Z]/.test(token.v)) {
                    this.next(); element = { p: "constr", tag: token.v, args: [] };
                } else element = this.parsePattern();
                const value = this.parsePattern();
                return { p: "constr", tag: name, args: [size, element, value] };
            }
            // constructor application: Some x
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

    // ':' only builds lists and record entries; there are no type annotations.
    // A list tail can never be a type, so `: Int` written where an annotation
    // would go is reported as one instead of parsing as a meaningless cons.
    annotationError(type: number): never {
        this.i = type;
        const name = (this.peek() as { v: string }).v;
        throw new Error(`Parser: ':' builds a list (x:rest), not a type annotation; type with the constructor instead: (${name} x) in a pattern, ${name} value in an expression`);
    }

    // Index of the type after a ':' annotation, scanning tokens [from, to).
    // Colons directly inside [ ] are record entries and never count.
    annotationIn(from: number, to: number): number | undefined {
        const open: string[] = [];
        for (let j = from; j < to; j++) {
            const t = this.toks[j];
            if (t.k !== "sym") continue;
            if (["(", "{", "["].includes(t.v)) open.push(t.v);
            else if ([")", "}", "]"].includes(t.v)) open.pop();
            else if (t.v === ":" && open[open.length - 1] !== "[") {
                const type = this.toks[j + 1];
                if (type?.k === "ident" && /^[A-Z]/.test(type.v)) return j + 1;
            }
        }
        return undefined;
    }

    // Statement level:  x: Int = 5,  f x: Int = x,  f (x: Int) = x
    rejectDefinitionAnnotation(): void {
        let depth = 0;
        for (let j = this.i; j < this.toks.length; j++) {
            const t = this.toks[j];
            if (t.k === "eof" || (depth === 0 && ["newline", "indent", "dedent"].includes(t.k))) return;
            if (t.k !== "sym") continue;
            if (["(", "{", "["].includes(t.v)) depth++;
            else if ([")", "}", "]"].includes(t.v)) { if (--depth < 0) return; }
            else if (depth === 0 && (t.v === ";" || t.v === "?" || t.v === "->")) return;
            else if (depth === 0 && (t.v === "=" || t.v === "<-")) {
                const type = this.annotationIn(this.i, j);
                if (type !== undefined) this.annotationError(type);
                return;
            }
        }
    }

    // Lambda level:  (x: Int) -> x
    rejectLambdaAnnotation(): void {
        if (!this.isSym("(")) return;
        let depth = 0;
        for (let j = this.i; j < this.toks.length; j++) {
            const t = this.toks[j];
            if (t.k === "eof") return;
            if (t.k !== "sym") continue;
            if (["(", "{", "["].includes(t.v)) depth++;
            else if ([")", "}", "]"].includes(t.v) && --depth === 0) {
                const after = this.toks[j + 1];
                if (after?.k !== "sym" || (after.v !== "->" && after.v !== "|")) return;
                const type = this.annotationIn(this.i + 1, j);
                if (type !== undefined) this.annotationError(type);
                return;
            }
        }
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

    // Operators by precedence climbing over their fixities (see fixityOf).
    // Below every operator but $ sits the ternary c ? a : b (level 1, right);
    // prefix - and ! take an operand of level 8 (so -2 ^ 2 is -(2 ^ 2), and
    // 2 ^ -3 works). f $ x is a pipe node, x : xs and the rest binops.
    parsePipe(): Expr { return this.parseOperators(0); }
    parseTernary(): Expr { return this.parseOperators(1); }
    parseUnary(): Expr { return this.parseOperators(8); }

    noCons = 0; // >0 while parsing a ternary branch (`:` belongs to the ternary)

    parseOperators(minPrec: number): Expr {
        const start = this.peek().pos;
        let left = this.parseOperand();
        for (;;) {
            const t = this.peek();
            if (t.k !== "sym") break;
            if (t.v === "?") {
                if (minPrec > 1) break;
                this.next();
                this.skipLayout();
                const saved = this.noCons;
                this.noCons = 1;
                const then = this.parseOperators(1);
                this.noCons = saved;
                this.expectSym(":");
                const els = this.parseOperators(1);
                left = { t: "ternary", cond: left, then, els };
                continue;
            }
            if (!isOperatorName(t.v) || t.v === ":" && this.noCons) break;
            // Leave a trailing operator for the operand-front section (2 ^).
            const after = this.peek(1);
            if (after.k === "sym" && (after.v === ")" || after.v === "}")) break;
            const fixity = fixityOf(t.v);
            if (fixity.prec < minPrec) break;
            this.next();
            this.skipContinuation();
            const rightStart = this.peek().pos;
            const right = this.parseOperators(fixity.assoc === "right" ? fixity.prec : fixity.prec + 1);
            if (t.v === "$") {
                sourceLocations.set(left, { source: this.source, file: this.file, start, end: t.pos });
                sourceLocations.set(right, { source: this.source, file: this.file, start: rightStart, end: this.peek().pos });
                left = { t: "pipe", f: left, x: right };
            } else {
                // The right operand's place, for diagnostics such as x / 0.
                if (!sourceLocations.has(right)) sourceLocations.set(right, { source: this.source, file: this.file, start: rightStart, end: this.peek().pos });
                left = { t: "binop", op: t.v, l: left, r: right };
            }
            const following = this.peek();
            if (fixity.assoc === "none" && following.k === "sym" && isOperatorName(following.v) && fixityOf(following.v).prec === fixity.prec) {
                throw new Error(`Parser: '${t.v}' is non-associative (infix ${fixity.prec}); add parentheses`);
            }
        }
        return left;
    }

    parseOperand(): Expr {
        if (this.isSym("-")) { this.next(); return { t: "unop", op: "neg", e: this.parseOperators(8) }; }
        if (this.isSym("!")) { this.next(); return { t: "unop", op: "not", e: this.parseOperators(8) }; }
        return this.parseApp();
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
            if (t.k === "sym" && (t.v === "{" || t.v === "(")) {
                const argument = this.parsePrimary();
                e = { t: "recordAccess", rec: e, field: this.source.slice(t.pos, this.peek().pos).trimEnd(), argument, scoped: true };
            } else if (t.k === "sym" && (t as { v: string }).v === "[") {
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
                    argument = this.parsePrimary();
                    this.i = keyEnd;
                }
                e = { t: "recordAccess", rec: e, field, ...(argument ? { argument } : {}), ...(t.k === "sym" && t.v === "(" ? { scoped: true } : {}) };
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

    // A record entry's key: one key as after '.' (x, "x", 1, -1, (expr)), or a
    // bare key of several names, numbers and '-'s on one line, up to its ':'
    // ([my value: 1], [Content-Type: "json"]), keeping its source spelling.
    // A bare key is not a quoted one: Content-Type and "Content-Type" differ.
    parseEntryKey(): string {
        const first = this.peek();
        if (first.k === "ident" || first.k === "int" || first.k === "float") {
            let j = this.i;
            for (;;) {
                const t = this.toks[j];
                if (t.k === "sym" && t.v === ":") break;
                if (!(t.k === "ident" || t.k === "int" || t.k === "float" || t.k === "sym" && t.v === "-")) { j = -1; break; }
                j++;
            }
            if (j > this.i + 1) {
                const key = this.source.slice(first.pos, this.toks[j].pos).trimEnd();
                this.i = j;
                this.seen = this.toks[j - 1];
                return key;
            }
        }
        return this.parseKey();
    }

    isKeyedEntry(): boolean {
        const saved = this.i;
        try { this.parseEntryKey(); return this.isSym(":"); }
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

    // Whether a -> comes before the bracket closing the current group, at
    // its own level (a cheap look before trying to parse a lambda).
    arrowBefore(close: string): boolean {
        for (let j = this.i, depth = 0; j < this.toks.length; j++) {
            const t = this.toks[j];
            if (t.k === "eof") return false;
            if (t.k !== "sym") continue;
            if (t.v === "(" || t.v === "[" || t.v === "{") depth++;
            else if (t.v === ")" || t.v === "]" || t.v === "}") { if (depth-- === 0) return false; }
            else if (t.v === "->" && depth === 0) return true;
        }
        return false;
    }

    parsePrimary(): Expr {
        const t = this.peek();
        if (!this.noLambda && this.startsParam(t)) {
            this.rejectLambdaAnnotation();
            const save = this.i;
            let header: { params: Pattern[]; guard?: Expr } | undefined;
            try { header = this.lambdaHeader(); } catch { this.i = save; }
            if (header) {
                this.skipContinuation();
                const body = this.isSym("{") ? this.parsePrimary() : this.parseExpr();
                if (!header.guard && header.params.every(p => p.p === "var") && new Set(header.params.map(p => (p as Extract<Pattern, { p: "var" }>).name)).size === header.params.length) {
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
                        {
                            const sec = this.tryOperatorSection(close);
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
                            if (this.skipFixityDeclaration()) continue;
                            const operator = this.tryOperatorDefinition();
                            if (operator) { stmts.push({ t: "stmDef", ...operator }); continue; }
                            this.rejectDefinitionAnnotation();
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
                        // Record entries are explicit key/value pairs or .name shorthand.
                        if (this.isKeyedEntry() || this.isSym(".")) {
                            const fs: Array<[string, Expr]> = [];
                            for (;;) {
                                if (this.eatSym(".")) {
                                    const name = this.next();
                                    if (name.k !== "ident" || name.v === "_") {
                                        throw new Error("Parser: record shorthand requires a variable name after '.'");
                                    }
                                    const value: Expr = { t: "var", name: name.v };
                                    sourceLocations.set(value, { source: this.source, file: this.file, start: name.pos, end: name.pos + name.v.length });
                                    fs.push([name.v, value]);
                                    const next = this.peek();
                                    if (!this.isSym(",") && !this.isSym("]") && next.k !== "newline" && next.k !== "dedent") {
                                        throw new Error("Parser: expected ',' or newline after record shorthand");
                                    }
                                } else {
                                    const key = this.parseEntryKey();
                                    if (this.isSym(":")) this.keyColon();
                                    this.expectSym(":");
                                    fs.push([key, this.parseDelimitedExpr()]);
                                }
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
                            const loE = this.parseOperators(6);
                            if (this.isSym("..")) {
                                this.next();
                                if (this.isSym("]")) {
                                    this.next();
                                    return rangeSyntax(loE, null, null);
                                }
                                const hi = this.parseOperators(6);
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
                                const sE = this.parseOperators(6);
                                if (this.isSym("..")) {
                                    this.next();

                                    if (this.isSym("]")) {
                                        this.next();
                                        return rangeSyntax(loE, sE, null);
                                    }
                                    const hi = this.parseOperators(6);
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

    // Inside brackets, `:` is cons again even within a ternary branch.
    parseDelimitedExpr(): Expr {
        const saved = this.noLambda, savedCons = this.noCons;
        this.noLambda = 0;
        this.noCons = 0;
        try { return this.parseExpr(); } finally { this.noLambda = saved; this.noCons = savedCons; }
    }

    noLambda = 0;
    lambdaHeader(): { params: Pattern[]; guard?: Expr } {
        const params: Pattern[] = [];
        while (this.startsParam(this.peek())) params.push(this.parseConsPattern());
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
    //   [name, hello] = [...],  (Some x) = ...,  Some v = ...
    // Only unambiguous pattern starts are tried - `[`, `(` + Uppercase
    // constructor, a bare Uppercase constructor, or a dotted name - so statements like
    // `[1, 2, 3] $ head`, `name = 5`, or `Some (f x)` never reach the pattern
    // path.
    startsPatBinding(): boolean {
        const t = this.peek();
        if (t.k === "sym" && t.v === "[") return true;
        // A cons pattern: x:xs = ..., (x:xs) = ...
        const consAfter = (n: number) => { const c = this.peek(n); return c.k === "sym" && c.v === ":"; };
        if (t.k === "sym" && (t.v === "(" || t.v === "{")) {
            const n1 = this.peek(1);
            return n1.k === "ident" && (/^[A-Z]/.test(n1.v) || consAfter(2));
        }
        const next = this.peek(1);
        return t.k === "ident" && (/^[A-Z]/.test(t.v) || (next.k === "sym" && (next.v === "." || next.v === ":")));
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
                    if (this.eatSym(":")) this.parseKey();
                    this.skipListSeparators();
                }
                this.next();
            } else {
                this.parseKey();
                while (this.eatSym(".")) {
                    if (this.eatSym("[")) {
                        this.skipListLeading();
                        while (!this.isSym("]")) { this.parseKey(); if (this.eatSym(":")) this.parseKey(); this.skipListSeparators(); }
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
        const start = this.i;
        let pattern: Pattern | undefined;
        let patternEnd: number | undefined;
        try { pattern = this.parsePattern(); if (this.isSym("=")) patternEnd = this.i; } catch { /* literal field names need not be patterns */ }
        this.i = start;
        const nt = this.next();
        if (nt.k !== "ident") throw new Error("Parser: expected a name before '.'");
        const name = nt.v;
        this.next(); // "."
        const entries: string[] = [];
        const aliases: string[] = [];
        const path: string[] = [];
        while (!this.isSym("[")) {
            if (this.isSym("(") || this.isSym("{")) {
                const error = "scoped record expressions are not assignment targets; use a string key";
                if (pattern?.p === "as" && patternEnd !== undefined) {
                    this.i = patternEnd;
                    this.expectSym("=");
                    const value = this.parseExpr();
                    return { t: "patDef", pattern, value, update: { name, value, error } };
                }
                throw new Error(`Parser: ${error}`);
            }
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
                if (this.isSym(":")) this.keyColon();
                if (this.eatSym(":")) aliases.push(this.parseKey());
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
        // Unnamed bracketed selection takes a list; renamed selection takes a record.
        // Only direct field assignment wraps its scalar RHS.
        if (aliases.length && aliases.length !== entries.length) throw new Error("Parser: cannot mix renamed and unnamed assignment entries");
        const value = bracketed ? rhs : { t: "list", v: [rhs] } as Expr;
        const update: Expr = { t: "setFields", rec: { t: "var", name }, entries, value, ...(aliases.length ? { aliases } : {}), ...(path.length ? { path } : {}) };
        return pattern?.p === "as"
            ? { t: "patDef", pattern, value: rhs, update: { name, value: update } }
            : { t: "patDef", pattern: { p: "var", name }, value: update };
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
        // A built-in type name cannot be redefined, so Int x = 1 is a typed binding.
        if (t.k === "ident" && !declaredCtors.has(t.v) && !TYPE_NAMES.includes(t.v) && !(this.peek(1).k === "sym" && [".", ":"].includes((this.peek(1) as { v: string }).v))) return false;
        const save = this.i;
        try {
            const p = this.parseConsPattern();
            if (p.p === "var") return false;
            // A typed binding names one value: Int x = 1.
            if (t.k === "ident" && TYPE_NAMES.includes(t.v) && !declaredCtors.has(t.v) && !(p.p === "constr" && p.args.length === 1)) return false;
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
        const update = pattern.p === "as" && pattern.left.p === "var"
            ? { name: pattern.left.name, value, error: "this dotted pattern is not a field-update target" } : undefined;
        return { t: "patDef", pattern, value, ...(update ? { update } : {}) };
    }

    // Operator sections, for every operator: (+ 2) is x -> x + 2, (2 +) is
    // x -> 2 + x, and a lone (+) is the operator's function. (- 2) is not a
    // section: it stays unary negation (use a lambda); (10 -) and (-) are.
    // Each is a lambda over a binop, so the operator's meaning is looked up
    // where it is applied, like any other use of it.
    static operatorBody(op: string, l: Expr, r: Expr): Expr {
        return op === "$" ? { t: "pipe", f: l, x: r } : { t: "binop", op, l, r };
    }

    tryOperatorSection(close: string): Expr | null {
        const save = this.i;
        const t = this.peek();
        const lone = this.peek(1).k === "sym" && (this.peek(1) as { v: string }).v === close;
        // op-front:  (+ 2)   (op followed by an operand, then ')')
        if (t.k === "sym" && isOperatorName(t.v) && (t.v !== "-" || lone)) {
            try {
                // lone (op): a 2-arg lambda —  add = (+)
                if (lone) {
                    this.next(); // op
                    this.next(); // )
                    return { t: "lambda", params: ["$L", "$R"], body: Parser.operatorBody(t.v, { t: "var", name: "$L" }, { t: "var", name: "$R" }) };
                }
                this.next(); // op
                const operandStart = this.peek().pos;
                const operand = this.parseUnary();
                if (!sourceLocations.has(operand)) sourceLocations.set(operand, { source: this.source, file: this.file, start: operandStart, end: this.peek().pos });
                this.expectSym(close);
                return { t: "lambda", params: ["$S"], body: Parser.operatorBody(t.v, { t: "var", name: "$S" }, operand) };
            } catch {
                this.i = save;
            }
        }
        // operand-front:  (2 +)   (operand, then op, then ')')
        try {
            const operand = this.parseUnary();
            const op = this.peek();
            if (op.k === "sym" && isOperatorName(op.v) && this.peek(1).k === "sym" && (this.peek(1) as { v: string }).v === close) {
                this.next(); // op
                this.next(); // )
                return { t: "lambda", params: ["$S"], body: Parser.operatorBody(op.v, operand, { t: "var", name: "$S" }) };
            }
        } catch {
            // fall through to the normal parenthesized-expression parse
        }
        this.i = save;
        return null;
    }

    // A fixity declaration (infixl 6 +): already recorded (declareFixities),
    // so the statement only needs skipping.
    skipFixityDeclaration(): boolean {
        if (!isFixityStart(this.toks, this.i)) return false;
        this.i += 2;
        while (this.peek().k === "sym" && isOperatorName((this.peek() as { v: string }).v)) this.next();
        return true;
    }

    // An operator definition: (+) = value, or a + b = body with one pattern
    // on each side (the patterns of a two-argument clause).
    tryOperatorDefinition(): { name: string; clauses: { params: Pattern[]; body: Expr }[] } | null {
        const save = this.i;
        const t = this.peek(), op = this.peek(1), close = this.peek(2), eq = this.peek(3);
        if (t.k === "sym" && t.v === "(" && op.k === "sym" && isOperatorName(op.v) && close.k === "sym" && close.v === ")" && eq.k === "sym" && eq.v === "=") {
            this.i += 3;
            this.next(); // =
            return { name: op.v, clauses: [{ params: [], body: this.parseDefBody("=") }] };
        }
        try {
            const left = this.parsePatternAtom();
            const name = this.peek();
            // x:xs = ... binds a cons pattern; it defines no operator.
            if (name.k === "sym" && isOperatorName(name.v) && name.v !== ":") {
                this.next();
                const right = this.parsePatternAtom();
                if (this.isSym("=")) {
                    this.next();
                    return { name: name.v, clauses: [{ params: [left, right], body: this.parseDefBody("=") }] };
                }
            }
        } catch { /* not an operator definition */ }
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
    // definition? Recognizes  name = expr  and the Haskell-style
    // name p1 p2 p3 = expr  where each pi is a PATTERN
    // (in `[x, y]`, `(x:rest)`, `[]`, `(Some x)`, a literal, a bare var, ...).
    isDef(): boolean {
        const save = this.i;
        try {
            const t = this.next(); // definition name
            if (t.k !== "ident") return false;
            // collect param patterns; a param must be a self-delimited pattern
            for (;;) {
                if (!this.startsParam(this.peek())) break;
                this.parseConsPattern();
            }
            return this.isSym("=");
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
        if (t.k === "int" || t.k === "float" || t.k === "char" || t.k === "bool" || t.k === "str") return true;
        if (t.k === "kw" && (t.v === "true" || t.v === "false")) return true;
        if (t.k === "sym" && (t.v === "(" || t.v === "{" || t.v === "[")) return true;
        if (t.k === "sym" && t.v === "_") return true;
        return false;
    }

    // Parse  name p1 p2 = body  (isDef() must already have returned true).
    parseDefStatement(): { name: string; clauses: { params: Pattern[]; body: Expr; guard?: Expr }[] } {
        const name = (this.next() as { v: string }).v;
        const params: Pattern[] = [];
        // Haskell-style params are PATTERNS:  f [x, y] = ..., f (x:rest) = ...
        while (this.startsParam(this.peek())) {
            params.push(this.parseConsPattern());
        }
        const equals = this.next(); // =
        let body = this.parseDefBody();
        // f = Int x -> ... is the curried spelling of f (Int x) = ...: the
        // same clause, so another one overloads it the same way.
        let guard: Expr | undefined;
        const lambda = !params.length && /^[a-z]/.test(name) ? curried(name, body) : undefined;
        if (lambda) {
            params.push(...lambda.params);
            guard = lambda.guard;
            body = lambda.body;
        }
        if (guard) return { name, clauses: [{ params, body, guard }] };
        if (name === "return" && params.length > 1) throw new APNError("parse", "return takes one argument", { pos: equals.pos, hint: "`return = Some`" });
        return { name, clauses: [{ params, body }] };
    }

    // A body is required; only an indented continuation can cross a newline.
    parseDefBody(operator = "="): Expr {
        if (this.peek().k === "newline") {
            let j = this.i;
            while (this.toks[j] && this.toks[j].k === "newline") j++;
            if (this.toks[j] && this.toks[j].k === "indent") {
                const first = this.toks[j + 1];
                if (first?.k === "sym" && first.v === "{" && !looseSpacing) {
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

            if (this.skipFixityDeclaration()) continue;
            const operator = this.tryOperatorDefinition();
            if (operator) {
                out.push({ t: "def", ...operator });
                continue;
            }
            if (t.k === "ident") this.rejectDefinitionAnnotation();
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
                    while (this.peek().k === "ident" || this.isSym("(") || this.isSym("{") || this.isSym("[")) {
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
                if (this.peek(1).k === "sym" && (this.peek(1) as { v: string }).v === "::") {
                    this.next(); // name
                    throw new Error("Parser: type signatures are not supported; require types with constructor patterns, e.g. f (Int x) = ...");
                }
                // Field/pluck assignment:  vec.x = 10   vec.[x, y] = ...
                if (this.isFieldAssignStart()) {
                    out.push(this.parseFieldAssign() as TopLevel);
                    continue;
                }
                // A binding definition. Supports the Haskell-style param form too:
                //   name = expr            name a b c = expr
                // An Uppercase constructor on the LHS is a destructuring BINDING
                // (Some v = ...), not a function definition.
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
// args ambiguous: `Some v = ...` destructures only when `Some` was DECLARED a
// constructor; otherwise `Vector3 x y z = [x: x, y: y, z: z]` stays a plain
// (record-constructor) function def. Module-level so declarations persist
// across REPL lines (each line is re-parsed standalone).
let declaredCtors = new Set<string>();
const nullaryCtors = new Set<string>();

// Tooling parses each document independently, without leaking REPL declarations.
export function parseDocument(src: string): TopLevel[] {
    const sets = [declaredCtors, nullaryCtors];
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

// Loose spacing (apn --loose): none of the spacing rules apply.
let looseSpacing = false;
export function setLooseSpacing(loose: boolean): void { looseSpacing = loose; }

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
        declareFixities(toks);
        if (!looseSpacing) p.checkBracketSpacing();
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
// The lambda a definition's body is, with its parameters as patterns. An
// operator like (+) is a value, and a parameter named after the definition
// would mean equality with it as a clause (x x = x), so neither is one.
function curried(name: string, body: Expr): { params: Pattern[]; body: Expr; guard?: Expr } | undefined {
    const names = body.t === "lambda" ? body.params : body.t === "patternLambda" ? body.params.flatMap(patternVariables) : [];
    if (names.some(n => n === name || n.startsWith("$"))) return undefined;
    if (body.t === "lambda" && body.params.length) return { params: body.params.map((name): Pattern => name === "_" ? { p: "wildcard" } : { p: "var", name }), body: body.body };
    if (body.t === "patternLambda" && body.params.length) return { params: body.params, body: body.body, guard: body.guard };
    return undefined;
}

function patternVariables(p: Pattern): string[] {
    switch (p.p) {
        case "var": return [p.name];
        case "typeBind": return [p.name, ...patternVariables(p.value)];
        case "as": return [...patternVariables(p.left), ...patternVariables(p.right)];
        case "schema": return patternVariables(p.value);
        case "list": return p.v.flatMap(patternVariables);
        case "cons": return [...patternVariables(p.head), ...patternVariables(p.tail)];
        case "constr": return p.args.flatMap(patternVariables);
        case "recPat": return p.v.map(([, v]) => v);
        default: return [];
    }
}


export function exprToSource(e: Expr): string {
    switch (e.t) {
        case "computedRange": return `[${exprToSource(e.lo)}${e.second === null ? "" : "," + exprToSource(e.second)}..${e.hi === null ? "" : exprToSource(e.hi)}]`;
        case "import": return `import ${Array.isArray(e.module) ? `[${e.module.map(m => JSON.stringify(m)).join(",")}]` : JSON.stringify(e.module)}`;
        case "numeric": return numberText(e.v);
        case "rationalRange": return `[${numberText(e.lo)},${numberText(arithmetic("+", e.lo, e.step))}..${e.hi === null ? "" : numberText(e.hi)}]`;
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
        case "patternLambda": return `${e.params.map(patternSource).join(" ")}${e.guard ? " | " + exprToSource(e.guard) : ""} -> ${exprToSource(e.body)}`;
        case "lambda": return `${e.params.join(" ")} -> ${exprToSource(e.body)}`;
        case "list": return `[${e.v.map(exprToSource).join(",")}]`;
        case "record": return `[${e.v.map(([k, x]) => `${keySource(k)}: ${exprToSource(x)}`).join(", ")}]`;
    case "floatRange": {
        const decimal = (v: number) => Number.isInteger(v) ? `${v}.0` : String(v);
        return `[${decimal(e.lo)}${e.step !== 1 ? `,${decimal(e.lo + e.step)}` : ""}..${e.hi === null ? "" : decimal(e.hi)}]`;
    }
    case "range":
      return e.hi === null
        ? `[${e.lo}${e.step !== 1n ? `,${e.lo + e.step}` : ""}..]`
        : `[${e.lo}${e.step !== 1n ? `,${e.lo + e.step}` : ""}..${e.hi}]`;
        case "ternary": return `${exprToSource(e.cond)} ? ${exprToSource(e.then)} : ${exprToSource(e.els)}`;
        case "pipe": return `${exprToSource(e.f)} $ ${exprToSource(e.x)}`;
        case "recordAccess":
            return `${exprToSource(e.rec)}.${e.scoped && e.argument ? exprToSource(e.argument) : keySource(e.field)}`;
        case "pluck":
            if (e.values) return `${exprToSource(e.rec)}.${exprToSource(e.values)}`;
            return `${exprToSource(e.rec)}.[${e.entries.map((x) => typeof x === "string" ? keySource(x) : `${keySource(x[0])}: ${x[1]}`).join(e.entries.some(x => typeof x !== "string") ? ", " : ",")}]`;
        case "setItem": return `${exprToSource(e.rec)} (${exprToSource(e.index)}) = ${exprToSource(e.value)}`;
        case "setFields":
            return `${exprToSource(e.rec)}.${(e.path ?? []).map(keySource).map(key => key + ".").join("")}[${e.entries.map((key, n) => keySource(key) + (e.aliases ? ": " + keySource(e.aliases[n]) : "")).join(e.aliases ? ", " : ",")}] = ${exprToSource(e.value)}`;
        case "block": {
            const one = e.stmts.length === 1 && e.stmts[0].t !== "stmDef" && e.stmts[0].t !== "patDef";
            if (one && e.style === "(") return exprToSource(e.stmts[0]);
            const body = e.stmts.map((st) => {
                if (st.t === "stmDef") return `${st.name} = ${exprToSource(st.clauses[0].body)}`;
                if (st.t === "patDef" && (st.value.t === "setItem" || st.value.t === "setFields")) return exprToSource(st.value);
                if (st.t === "patDef") return `${patternSource(st.pattern)} ${st.eager ? "<-" : "="} ${exprToSource(st.value)}`;
                return exprToSource(st);
            }).join("; ");
            return e.style === "(" ? `(${body})` : `{ ${body} }`;
        }
        default: return "<expr>";
    }
}
export function patternSource(p: Pattern): string {
    switch (p.p) {
        case "as": return `${patternSource(p.left)}.${patternSource(p.right)}`;
        case "schema": return `(${exprToSource(p.type)} ${patternSource(p.value)})`;
        case "wildcard": return "_";
        case "var": return p.name;
        case "int": return String(p.v);
        case "bool": return String(p.v);
        case "string": return JSON.stringify(p.v);
        case "char": return `'${p.v}'`;
        case "float": return numberText({ kind: "float", v: p.v });
        case "list": return `[${p.v.map(patternSource).join(",")}]`;
        case "cons": return `(${patternSource(p.head)} : ${patternSource(p.tail)})`;
        case "constr": return p.args.length ? `(${p.tag} ${p.args.map(patternSource).join(" ")})` : p.tag;
        case "typeBind": return `(${p.name} ${patternSource(p.value)})`;
        case "recPat": return `[${p.v.map(([k, v]) => `${keySource(k)}: ${v}`).join(", ")}]`;
        case "range": return `[${p.lo}..${p.hi}]`;
    }
}
