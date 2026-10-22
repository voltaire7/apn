import { countingFamily, sourceLocations } from "./ast.ts";
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
import { charLiteral, itemsText, stringLiteral } from "./separators.ts";

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
// ":" writes a record field and separates a ternary; "::" is cons.
const RESERVED_OPERATORS = new Set(["=", "|", ":", "->", "<-", "!"]);
// The intrinsics behind the prelude's operators (lib/prelude.apn binds
// each symbol to one), keyed by name.
export const PRIMITIVE_OPERATORS = new Map<string, string>([
    ["intrinsics.apply", "$"], ["intrinsics.or", "||"], ["intrinsics.and", "&&"], ["intrinsics.eq", "=="], ["intrinsics.ne", "!="],
    ["intrinsics.lt", "<"], ["intrinsics.gt", ">"], ["intrinsics.le", "<="], ["intrinsics.ge", ">="], ["intrinsics.cons", "::"],
    ["intrinsics.add", "+"], ["intrinsics.sub", "-"], ["intrinsics.append", "++"], ["intrinsics.mul", "*"], ["intrinsics.div", "/"],
    ["intrinsics.mod", "%"], ["intrinsics.pow", "^"], ["intrinsics.compose", "\\"],
]);

// An operator naming a constructor, usable in patterns: ::, :+, ...
export function isConstructorOperator(text: string): boolean {
    return text.length > 1 && text.startsWith(":") && isOperatorName(text);
}
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
    // inside each brace ({ 123 }), while ( ) and [ ] keep none ((123), [1, 2]);
    // empty ones are {}, () and []. A bracket ending its line (before an
    // optional comment) or a closing one starting its line is laid out instead.
    checkBracketSpacing(): void {
        const pairs: Record<string, string> = { "{": "}", "(": ")", "[": "]", "}": "{", ")": "(", "]": "[" };
        // What each open bracket holds: record fields or list items ([ ]), or
        // anything else, where a ',' separates lambda parameters.
        const holds: ("record" | "list" | "params")[] = [];
        const tight = this.tightCommas();
        for (const [index, t] of this.toks.entries()) {
            if (t.k === "sym" && t.v === "=") this.checkEqualsSpacing(t);
            if (t.k === "sym" && t.v === ",") {
                this.checkTrailingComma(index);
                this.checkCommaSpacing(t, holds[holds.length - 1] ?? "params", tight.has(index));
            }
            if (t.k === "sym" && t.v === ";") this.checkSemicolon(index);
            this.checkOperatorSpacing(index);
            if (t.k === "sym" && "([{".includes(t.v)) holds.push(t.v !== "[" ? "params" : this.opensRecord(index) ? "record" : "list");
            if (t.k === "sym" && ")]}".includes(t.v)) holds.pop();
            if (t.k !== "sym" || !(t.v in pairs)) continue;
            // Application is juxtaposition with a space: Vector3 [1,2,3],
            // func (123) and run { x }, not Vector3[1,2,3], func(123) or run{ x }.
            if ("([{".includes(t.v) && /[A-Za-z0-9_'")\]}]/.test(this.source[t.pos - 1] ?? "")) {
                this.seen = t;
                const example = { "[": "f [1, 2], not f[1, 2]", "(": "f (x), not f(x)", "{": "f { x }, not f{ x }" }[t.v];
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

    // A binary operator has a space on both sides or neither (1 + 2, 1+2):
    // 1 +2 and 1+ 2 are errors. Where it can be prefix (-, !), a space
    // before alone writes an argument (f -1, the function-minus overload);
    // after an opening bracket, a ',' or another operator it is prefix, and
    // before a closing bracket it ends a section ((1 +)).
    checkOperatorSpacing(index: number): void {
        const t = this.toks[index], previous = this.toks[index - 1], next = this.toks[index + 1];
        if (t.k !== "sym" || ![...t.v].every(c => OPERATOR_CHARS.includes(c)) || ["=", ":", "->", "<-", "|"].includes(t.v)) return;
        const prefixPlace = !previous || ["newline", "indent", "dedent"].includes(previous.k)
            || previous.k === "sym" && ("([{,;".includes(previous.v) || [...previous.v].every(c => OPERATOR_CHARS.includes(c)));
        if (prefixPlace || next?.k === "sym" && ")]}".includes(next.v)) return;
        const before = /\s/.test(this.source[t.pos - 1] ?? " "), after = /\s/.test(this.source[t.pos + t.v.length] ?? " ");
        if (before === after || before && ["-", "!"].includes(t.v)) return;
        this.seen = t;
        throw new Error(`Parser: put a space on both sides of '${t.v}' or neither (write 1 ${t.v} 2 or 1${t.v}2)`);
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

    // Whether the [ at index opens record fields ([x: 1], keyed patterns and
    // selections) rather than list items.
    opensRecord(index: number): boolean {
        let i = index + 1;
        while (["newline", "indent", "dedent"].includes(this.toks[i]?.k)) i++;
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

    // A ',' follows its item directly, and takes nothing after it when no
    // item it separates has a space ([1,2,3]), one space otherwise ([x: 1, y: 2],
    // [1 + 1, 2], and always between lambda parameters: x, y -> x). A newline already separates items, so a
    // ',' ending its line is redundant.
    checkCommaSpacing(t: Token, holds: "record" | "list" | "params", tight: boolean): void {
        const after = this.source.slice(t.pos + 1).split("\n", 1)[0];
        this.seen = t;
        if (/^\s*(#.*)?$/.test(after)) throw new Error("Parser: a newline already separates items; remove the ',' at the end of the line");
        if (!/\s/.test(this.source[t.pos - 1] ?? " ") && (tight ? /^\S/ : /^ \S/).test(after)) return;
        // x:xs (cons written the old way) right after '[' read as a field: the item is a cons.
        const item = this.source.slice(this.source.lastIndexOf("[", t.pos) + 1, t.pos);
        if (holds === "record" && /^\s*[\w']+:\S/.test(item)) throw new Error(`Parser: cons is '::': write [${item.trim().replace(":", " :: ")}, ...]`);
        if (holds === "params") throw new Error("Parser: separate lambda parameters by ', ' (write x, y -> x + y)");
        const what = holds === "record" ? "record fields" : "list items";
        throw new Error(tight
            ? `Parser: separate ${what} with no spaces in them by ',' alone (write [1,2,3])`
            : `Parser: separate ${what} by ', ' when one has a space (write ${holds === "record" ? "[x: 1, y: 2]" : "[1 + 1, 2]"})`);
    }

    // The commas whose items have no space in them (outside strings and
    // characters): a line's items in [ ]. Lambda parameters are always
    // separated by ', ', as the lambda they start is spaced.
    tightCommas(): Set<number> {
        const tight = new Set<number>(), toks = this.toks;
        const layout = (t?: Token) => t !== undefined && ["newline", "indent", "dedent", "eof"].includes(t.k);
        const opens = (t?: Token) => t?.k === "sym" && "([{".includes(t.v);
        const closes = (t?: Token) => t?.k === "sym" && ")]}".includes(t.v);
        // Whether the source from token a up to b's position has a space, outside literals.
        const spaced = (a: number, b: number): boolean => {
            let text = "", at = toks[a].pos;
            for (let k = a; k < b; k++) {
                const t = toks[k];
                if (t.k !== "str" && t.k !== "char") continue;
                text += this.source.slice(at, t.pos) + "_";
                at = literalEnd(this.source, t.pos);
            }
            return /\s/.test((text + this.source.slice(at, toks[b].pos)).replace(/#.*$/, "").trimEnd());
        };
        type Frame = { list: boolean; start: number; items: [number, number][]; commas: number[] };
        const decide = (frame: Frame, end: number) => {
            if (frame.commas.length && frame.start < end) frame.items.push([frame.start, end]);
            if (frame.commas.length && frame.items.every(([a, b]) => !spaced(a, b))) frame.commas.forEach(c => tight.add(c));
            frame.items = []; frame.commas = [];
        };
        const frames: Frame[] = [{ list: false, start: 0, items: [], commas: [] }];
        for (let i = 0; i < toks.length; i++) {
            const t = toks[i], frame = frames[frames.length - 1];
            if (opens(t)) {
                frames.push({ list: t.k === "sym" && t.v === "[", start: i + 1, items: [], commas: [] });
                continue;
            }
            if (closes(t) || layout(t)) {
                decide(frame, i);
                if (closes(t) && frames.length > 1) frames.pop();
                let next = i + 1;
                while (layout(toks[next])) next++;
                frames[frames.length - 1].start = closes(t) ? frames[frames.length - 1].start : next;
                continue;
            }
            if (frame.list && t.k === "sym" && t.v === ",") {
                frame.items.push([frame.start, i]);
                frame.commas.push(i);
                frame.start = i + 1;
            }
        }
        return tight;
    }

    // A record key's ':' follows the key directly, with one space after it
    // (x: 1); a ':' ending its line leaves the value to the next.
    keyColon(): void {
        if (looseSpacing) return;
        const t = this.peek();
        const after = this.source.slice(t.pos + 1).split("\n", 1)[0];
        if (!/\s/.test(this.source[t.pos - 1] ?? " ") && (/^ \S/.test(after) || /^\s*(#.*)?$/.test(after))) return;
        this.seen = t;
        throw new Error(/^\S/.test(after) ? "Parser: cons is '::' (x :: xs); a record field is key: value, with one space after ':'" : "Parser: write a record field as key: value (no space before ':', one after)");
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
            // (t x) binds the value's type and payload; (_ x) only the payload.
            if (typeName.k === "ident" && (/^[a-z]/.test(typeName.v) || typeName.v === "_") &&
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
            // A type applied in a pattern (Vect n Int xs): its arguments are
            // types and indices, so a capitalized one takes nothing after it.
            if (declaredTypes.has(name) && !declaredCtors.has(name) && this.startsParam(this.peek())) {
                const args: Pattern[] = [];
                while (this.startsParam(this.peek())) {
                    const token = this.peek();
                    if (token.k === "ident" && /^[A-Z]/.test(token.v) && token.v !== "_") { this.next(); args.push({ p: "constr", tag: token.v, args: [] }); }
                    else args.push(this.parsePattern());
                }
                return { p: "constr", tag: name, args };
            }
            // constructor application: Some x. A capitalized argument takes
            // nothing after it (R low None high): one with fields is parenthesized.
            if (/^[A-Z]/.test(name)) {
                const args = [] as Pattern[];
                while (this.startsParam(this.peek())) {
                    const token = this.peek();
                    if (token.k === "ident" && /^[A-Z]/.test(token.v)) { this.next(); args.push({ p: "constr", tag: token.v, args: [] }); }
                    else args.push(this.parsePattern());
                }
                return { p: "constr", tag: name, args };
            }
            return { p: "var", name };
        }
        throw new Error(`Parser: bad pattern '${this.tokenStr(t)}'`);
    }

    // ':' writes a record field ([x: 1], inside [ ]) or a ternary's else
    // (c ? a : b); anything else is cons written the old way or a type
    // annotation, which APN does not have.
    checkColons(): void {
        const open: string[] = [], pending = [0];
        for (const t of this.toks) {
            if (t.k !== "sym") continue;
            if (["(", "[", "{"].includes(t.v)) { open.push(t.v); pending.push(0); continue; }
            if ([")", "]", "}"].includes(t.v)) { open.pop(); if (pending.length > 1) pending.pop(); continue; }
            if (t.v === "?") { pending[pending.length - 1]++; continue; }
            if (t.v !== ":") continue;
            if (open[open.length - 1] === "[") continue;
            if (pending[pending.length - 1] > 0) { pending[pending.length - 1]--; continue; }
            const next = this.toks[this.toks.indexOf(t) + 1];
            this.seen = t;
            if (next?.k === "ident" && /^[A-Z]/.test(next.v)) {
                throw new Error(`Parser: APN has no type annotations; type with the constructor instead: (${next.v} x) in a pattern, ${next.v} value in an expression`);
            }
            throw new Error("Parser: cons is '::' (x :: xs); ':' writes a record field ([x: 1]) or a ternary's else (c ? a : b)");
        }
    }

    // An infix constructor pattern: x :: xs, or x op y for any operator
    // starting with ':' (as in Haskell); it matches the constructor op names.
    parseConsPattern(): Pattern {
        const p = this.parsePattern();
        const t = this.peek();
        if (t.k === "sym" && isConstructorOperator(t.v)) {
            this.next();
            const tail = this.parseConsPattern();
            return { p: "cons", head: p, tail, ...t.v !== "::" ? { op: t.v } : {} };
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

    // The indentation of the line the current statement starts on: a deeper
    // line continues it, a line at its level starts the next one.
    statementIndent = 0;
    // At a line break, step onto the next line when it is deeper than the
    // statement and starts with what wanted accepts. Items in [ ] are
    // separated by line breaks instead.
    continueLine(wanted: (t: Token) => boolean): boolean {
        const layout = (k: string) => k === "newline" || k === "indent" || k === "dedent";
        if (!layout(this.peek().k)) return false;
        let j = this.i;
        while (this.toks[j] && layout(this.toks[j].k)) j++;
        const next = this.toks[j];
        if (!next || !wanted(next) || this.lineIndent(next) <= this.statementIndent || !["", "{", "["].includes(this.enclosing(j))) return false;
        this.i = j;
        return true;
    }

    skipLayout() {
        while (this.peek().k === "newline" || this.peek().k === "indent") this.next();
    }

    // Operators by precedence climbing over their fixities (see fixityOf).
    // Below every operator but $ sits the ternary c ? a : b (level 1, right);
    // prefix - and ! take an operand of level 8 (so -2 ^ 2 is -(2 ^ 2), and
    // 2 ^ -3 works). f $ x is a pipe node, x :: xs and the rest binops.
    parsePipe(): Expr { return this.parseOperators(0); }
    parseTernary(): Expr { return this.parseOperators(1); }
    parseUnary(): Expr { return this.parseOperators(8); }

    noCons = 0; // >0 while parsing a ternary branch (`:` belongs to the ternary)

    parseOperators(minPrec: number): Expr {
        const start = this.peek().pos;
        let left = this.parseOperand();
        for (;;) {
            // A deeper line starting with an operator (or a ternary's ?)
            // continues the expression, as a trailing one does.
            if (this.continueLine(x => x.k === "sym" && (x.v === "?" || isOperatorName(x.v)))) continue;
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
                this.continueLine(x => x.k === "sym" && x.v === ":");
                this.expectSym(":");
                const els = this.parseOperators(1);
                left = { t: "ternary", cond: left, then, els };
                continue;
            }
            if (!isOperatorName(t.v)) break;
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

    // A '-' written against its operand negates it (-x, -(1/3), -[1,2,3]); a
    // spaced one is always subtraction, of two operands, or a section ((- 2)).
    tightMinus(t = this.peek()): boolean {
        return t.k === "sym" && t.v === "-" && !/[\s)\]},;]/.test(this.source[t.pos + 1] ?? " ");
    }

    parseOperand(): Expr {
        if (this.isSym("-")) {
            if (!this.tightMinus()) throw new Error("Parser: write a negation against its operand (-x); a spaced '-' subtracts");
            this.next();
            return { t: "unop", op: "neg", e: this.parseOperators(8) };
        }
        if (this.isSym("!")) { this.next(); return { t: "unop", op: "not", e: this.parseOperators(8) }; }
        return this.parseApp();
    }

    parseApp(): Expr {
        const start = this.peek().pos;
        let f = this.parsePostfix(this.parsePrimary());
        // application: f x y  (does not cross a newline at the statement's level,
        // nor a `;`). A deeper line starting an argument continues it, as one
        // starting with an operator does (never with `{`: braces stay on the line),
        // unless the line ends a block or is the closing line of a bracket: a
        // stray indented statement after one stays an error.
        const argument = (t: Token) => t.k === "ident" || t.k === "int" || t.k === "float" || t.k === "bool" ||
            (t.k === "kw" && (t.v === "true" || t.v === "false")) || t.k === "str" || t.k === "char" ||
            (t.k === "sym" && (t.v === "(" || t.v === "["));
        const closed = (t: Token | undefined) => t?.k === "sym" && (t.v === "}" ||
            (t.v === "]" || t.v === ")") && !this.source.slice(this.source.lastIndexOf("\n", t.pos - 1) + 1, t.pos).trim());
        for (;;) {
            if (!closed(this.toks[this.i - 1])) this.continueLine(argument);
            const t = this.peek();
            if (t.k === "newline" || t.k === "dedent" || t.k === "indent" || t.k === "eof") break;
            if (t.k === "sym" && t.v === ";") break;
            // f -x passes -x: a '-' spaced before and not after negates.
            if (this.tightMinus(t) && /\s/.test(this.source[t.pos - 1] ?? "")) {
                this.next();
                const a: Expr = { t: "unop", op: "neg", e: this.parsePostfix(this.parsePrimary()) };
                sourceLocations.set(a, { source: this.source, file: this.file, start: t.pos, end: this.peek().pos });
                f = { t: "app", f, a };
                sourceLocations.set(f, { source: this.source, file: this.file, start, end: this.peek().pos });
                continue;
            }
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

    // Whether a -> follows on this line at this level: a lambda's header never
    // spans lines, so most names need no attempt to parse one (a failed
    // attempt throws, which costs a stack trace).
    arrowOnLine(): boolean {
        for (let j = this.i, depth = 0; j < this.toks.length; j++) {
            const t = this.toks[j];
            if (t.k === "eof" || depth === 0 && (t.k === "newline" || t.k === "indent" || t.k === "dedent")) return false;
            if (t.k !== "sym") continue;
            if (t.v === "(" || t.v === "[" || t.v === "{") depth++;
            else if (t.v === ")" || t.v === "]" || t.v === "}") { if (depth-- === 0) return false; }
            else if (t.v === "->" && depth === 0) return true;
        }
        return false;
    }

    parsePrimary(): Expr {
        const t = this.peek();
        if (!this.noLambda && this.startsParam(t) && this.arrowOnLine()) {
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
                    case "=": {
                        // What came before on this line was read as an expression.
                        const before = this.source.slice(this.source.lastIndexOf("\n", t.pos - 1) + 1, t.pos).trim();
                        throw new Error(before
                            ? `Parser: \`${before}\` is neither a name to define nor a pattern: a definition starts with a name (f 1 = 1), a pattern binding with a pattern ([a,b] = xs)`
                            : "Parser: expected a name or a pattern before '='");
                    }
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
                        const outerIndent = this.statementIndent;
                        for (;;) {
                            if (this.isSym(";")) { this.next(); continue; }
                            while (this.peek().k === "newline") this.next();
                            while (this.peek().k === "dedent") this.next();
                            if (this.isSym(close)) {
                                if (multilineBrace && this.lineIndent(this.peek()) !== this.lineIndent(t)) {
                                    throw new Error("Parser: closing } must align with the line containing {");
                                }
                                this.statementIndent = outerIndent;
                                this.next(); return { t: "block", stmts, style: close === ")" ? "(" : "{" };
                            }
                            const tb = this.peek();
                            this.statementIndent = this.lineIndent(tb);
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
                            if (this.isEagerBinding()) {
                                stmts.push(this.parseEagerBinding());
                            } else if (this.isFieldAssignStart()) {
                                stmts.push(this.parseFieldAssign());
                            } else if (this.isPatBinding()) {
                                stmts.push(this.parsePatBinding());
                            } else {
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
                        // Record entries are key/value pairs.
                        if (this.isKeyedEntry()) {
                            const fs: Array<[string, Expr]> = [];
                            for (;;) {
                                const keyToken = this.peek();
                                const key = this.parseEntryKey();
                                if (this.isSym(":")) this.keyColon();
                                this.expectSym(":");
                                fs.push([key, this.item(keyToken, () => this.parseDelimitedExpr())]);
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
                        // An item may be a binding, as a block's statement may: its
                        // value is what it binds, in scope for the items after it.
                        const es = [] as Expr[];
                        for (;;) {
                            if (this.isEagerBinding()) throw new Error("Parser: a list item cannot run an action (x <- ...); use a block { x <- ...; ... }");
                            es.push(this.item(this.peek(), () => this.isPatBinding() ? this.parsePatBinding() : this.isDef() ? this.parseBlockDef() : this.parseDelimitedExpr()));
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
                        if (modules.includes(module.v)) throw new APNError("parse", `'${module.v}' is imported twice`, { pos: module.pos, hint: `list each module once; remove this '${module.v}'` });
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
    // A list item or record field starting at token first: a deeper line
    // continues it, a line at its level starts the next one.
    item<T>(first: Token, parse: () => T): T {
        const outer = this.statementIndent;
        this.statementIndent = this.lineIndent(first);
        try { return parse(); } finally { this.statementIndent = outer; }
    }

    parseDelimitedExpr(): Expr {
        const saved = this.noLambda, savedCons = this.noCons;
        this.noLambda = 0;
        this.noCons = 0;
        try { return this.parseExpr(); } finally { this.noLambda = saved; this.noCons = savedCons; }
    }

    noLambda = 0;
    // A lambda's parameters are patterns separated by ',' (x, y -> x + y);
    // juxtaposition is one pattern, as in a definition's parentheses ((t x)
    // binds a type, Some x a payload). Directly in a list, ',' separates the
    // list's items instead: write (x, y -> x) there.
    lambdaHeader(): { params: Pattern[]; guard?: Expr } {
        if (!this.startsParam(this.peek())) throw new Error("Parser: expected lambda parameters");
        const params: Pattern[] = [this.lambdaParam()];
        while (this.isSym(",") && this.enclosing(this.i) !== "[") { this.next(); params.push(this.lambdaParam()); }
        let guard: Expr | undefined;
        if (this.eatSym("|")) {
            this.noLambda++;
            try { guard = this.parsePipe(); } finally { this.noLambda--; }
        }
        this.expectSym("->");
        return { params, guard };
    }

    lambdaParam(): Pattern {
        const t = this.peek(), next = this.peek(1);
        // f a e, or (f a e): an e of type f a, as (Vec n a xs) is ((Vec n a)
        // xs) and x y is (x y); read as a type, f applied to a and e.
        const open = t.k === "sym" && t.v === "(" ? 1 : 0, names: string[] = [];
        let n = open;
        for (let w = this.peek(n); w.k === "ident" && /^[a-z]/.test(w.v); w = this.peek(++n)) names.push(w.v);
        const end = this.peek(n);
        if (names.length >= 3 && end.k === "sym" && (open ? end.v === ")" : ["->", ",", "|"].includes(end.v))) {
            for (let k = 0; k < n + open; k++) this.next();
            const type = names.slice(1, -1).reduce((f: Expr, name): Expr => ({ t: "app", f, a: { t: "var", name } }), { t: "var", name: names[0] });
            return { p: "schema", type, value: { p: "var", name: names[names.length - 1] } };
        }
        if ((t.k === "ident" && /^[a-z]/.test(t.v) || t.k === "sym" && t.v === "_") && this.startsParam(next)) {
            this.next();
            return { p: "typeBind", name: t.k === "ident" ? t.v : "_", value: this.parseConsPattern() };
        }
        return this.parseConsPattern();
    }
    // The innermost bracket open at token index i ("" at statement level).
    private enclosingCache?: string[];
    enclosing(i: number): string {
        if (!this.enclosingCache) {
            const open: string[] = [];
            this.enclosingCache = this.toks.map(t => {
                const here = open[open.length - 1] ?? "";
                if (t.k === "sym" && "([{".includes(t.v)) open.push(t.v);
                if (t.k === "sym" && ")]}".includes(t.v)) open.pop();
                return here;
            });
        }
        return this.enclosingCache[i] ?? "";
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
        // A literal is a pattern too, as inside one: 1 = 1 matches, 1 = 2 fails.
        const after = this.peek(1);
        if ((["int", "float", "char", "str"].includes(t.k) || t.k === "kw" && (t.v === "true" || t.v === "false")) && after.k === "sym" && after.v === "=") return true;
        // A cons pattern: x :: xs = ..., (x :: xs) = ...
        const consAfter = (n: number) => { const c = this.peek(n); return c.k === "sym" && isConstructorOperator(c.v); };
        if (t.k === "sym" && (t.v === "(" || t.v === "{")) {
            const n1 = this.peek(1);
            return n1.k === "ident" && (/^[A-Z]/.test(n1.v) || consAfter(2));
        }
        const next = this.peek(1);
        return t.k === "ident" && (/^[A-Z]/.test(t.v) || (next.k === "sym" && (next.v === "." || isConstructorOperator(next.v))));
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
        // A capitalized name not known as a constructor starts a type alias,
        // unless what follows it is not parameter names (Some 1 = ...).
        const unknown = t.k === "ident" && !declaredCtors.has(t.v) && !TYPE_NAMES.includes(t.v) && !(this.peek(1).k === "sym" && ((this.peek(1) as { v: string }).v === "." || isConstructorOperator((this.peek(1) as { v: string }).v)));
        if (unknown && !/^[A-Z]/.test(t.v)) return false;
        const save = this.i;
        try {
            const p = this.parseConsPattern();
            if (unknown && !(p.p === "constr" && p.args.some(a => a.p !== "var"))) return false;
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
    // x -> 2 + x, and a lone (+) is the operator's function. (- 2) is a
    // section and (-2) a negation (see tightMinus).
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
        if (t.k === "sym" && isOperatorName(t.v) && !this.tightMinus(t)) {
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
            // x :: xs = ... binds a constructor pattern; it defines no operator.
            if (name.k === "sym" && isOperatorName(name.v) && !isConstructorOperator(name.v)) {
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
    // (in `[x, y]`, `(x :: rest)`, `[]`, `(Some x)`, a literal, a bare var, ...).
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
        // Haskell-style params are PATTERNS:  f [x, y] = ..., f (x :: rest) = ...
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
                // A body on the next line is a statement of its own level.
                const outerIndent = this.statementIndent;
                this.statementIndent = this.lineIndent(first);
                try { return this.parseExpr(); } finally { this.statementIndent = outerIndent; }
            }
            throw new Error(`Parser: expected an expression after '${operator}'; use '_' for an unfinished definition`);
        }
        if (this.peek().k === "eof" || this.peek().k === "dedent" ||
            this.isSym(";") || this.isSym("}") || this.isSym(")") || this.isSym("]")) {
            throw new Error(`Parser: expected an expression after '${operator}'; use '_' for an unfinished definition`);
        }
        return this.parseExpr();
    }

    // A declaration's constructors, after its '=' (or inside the ( ) of the
    // lambda form). One line: T = A | B (a single constructor marks itself,
    // T = | A). More lines: each constructor on its own, after a '|'.
    parseConstructors(name: string, header = name): { tag: string; arity: number; fields: Expr[]; result?: Expr }[] {
        // Line breaks come from the source: inside ( ) there are no layout tokens.
        const layout = (k: string) => k === "newline" || k === "indent";
        const breakBefore = (k: number) => k > 0 && /\n/.test(this.source.slice(this.toks[k - 1].pos, this.toks[k].pos));
        let first = this.i;
        while (layout(this.toks[first].k)) first++;
        const multiLine = first > this.i || breakBefore(first);
        this.skipNL();
        const leading = this.isSym("|") ? this.next() : undefined;
        if (multiLine && !leading) {
            this.seen = this.peek();
            throw new Error(`Parser: start each constructor's line with '|' (${header} =, then | A and | B on lines of their own)`);
        }
        const variants: { tag: string; arity: number; fields: Expr[]; result?: Expr }[] = [];
        for (;;) {
            // A constructor: a name with its fields, or a list's own: [] and
            // a :: rest (a family of lists: Vect n a = [] -> ... | a :: ...).
            const vt = this.peek(), fields: Expr[] = [];
            let tag: string;
            if (vt.k === "sym" && vt.v === "[" && this.peek(1).k === "sym" && (this.peek(1) as { v: string }).v === "]") {
                this.next(); this.next();
                tag = "[]";
            } else if (vt.k === "ident" && /^[A-Z]/.test(vt.v)) {
                this.next();
                tag = vt.v;
                // A field is a type: a name (module.Type too), a group or a list.
                while (this.peek().k === "ident" || this.isSym("(") || this.isSym("{") || this.isSym("[")) {
                    this.noLambda++;
                    try { fields.push(this.parsePostfix(this.parsePrimary())); } finally { this.noLambda--; }
                }
            } else {
                if (!(vt.k === "ident" && /^[a-z]/.test(vt.v) || vt.k === "sym" && vt.v === "(")) throw new Error("Parser: expected a constructor: a capitalized name, [] or x :: rest");
                this.noLambda++;
                try {
                    fields.push(this.parsePrimary());
                    if (!this.isSym("::")) throw new Error("Parser: expected a constructor: a capitalized name, [] or x :: rest");
                    this.next();
                    fields.push(this.parseApp());
                } finally { this.noLambda--; }
                tag = "::";
            }
            // -> Type: the type this constructor makes (Nil -> Vec Z a).
            let result: Expr | undefined;
            if (this.eatSym("->")) {
                this.noLambda++;
                try { result = this.parseApp(); } finally { this.noLambda--; }
                let head = result;
                while (head.t === "app") head = head.f;
                if (head.t !== "var" || head.name !== name) throw new Error(`Parser: ${tag} must make a ${name}, as in ${tag} -> ${name} ...`);
            }
            variants.push({ tag, arity: fields.length, fields, ...result ? { result } : {} });
            if (this.isSym("|") && !breakBefore(this.i)) {
                if (multiLine) { this.seen = this.peek(); throw new Error("Parser: put each constructor of a multi-line declaration on its own line, after a '|'"); }
                this.next();
                continue;
            }
            let ahead = 0;
            while (layout(this.peek(ahead).k)) ahead++;
            const separator = this.peek(ahead);
            if (separator.k === "sym" && separator.v === "|") {
                if (!multiLine) { this.seen = separator; throw new Error(`Parser: a declaration on several lines starts on the line after '=', with each constructor after a '|' (${header} =, then | A and | B on lines of their own)`); }
                this.i += ahead + 1;
                continue;
            }
            break;
        }
        if (!multiLine && leading && variants.length > 1) {
            this.seen = leading;
            throw new Error(`Parser: a one-line declaration takes no leading '|' (write ${header} = A | B); only a single constructor needs one (${header} = | A)`);
        }
        // A family of lists has only the list's constructors, each saying the
        // index it makes ([] -> Vect Z a): its values are lists.
        // A list's fields are types, so a family of lists can only count its
        // elements: it is the length-indexed list, as Vect is.
        const listed = variants.filter(v => v.tag === "[]" || v.tag === "::");
        if (listed.length && !countingFamily({ name, parameters: header.split(" ").slice(1), variants })) {
            throw new Error(`Parser: a family of lists counts its elements, as Vect does: ${name} n a = [] -> ${name} Z a | a :: ${name} k a -> ${name} (S k) a`);
        }
        return variants;
    }

    // At i, the lambda form of a declaration's parameters: n, a -> ( or
    // n -> a -> (, with constructors (a '|') directly inside the ( ).
    lambdaDeclarationAt(i: number): boolean {
        let j = i;
        for (;;) {
            const p = this.toks[j], sep = this.toks[j + 1];
            if (p?.k !== "ident" || !/^[a-z]/.test(p.v) || sep?.k !== "sym") return false;
            j += 2;
            if (sep.v === ",") continue;
            if (sep.v !== "->") return false;
            const open = this.toks[j];
            if (open?.k === "sym" && open.v === "(") break;
        }
        let depth = 0;
        for (let k = j; k < this.toks.length; k++) {
            const t = this.toks[k];
            if (t.k !== "sym") continue;
            if ("([{".includes(t.v)) depth++;
            else if (")]}".includes(t.v)) { if (--depth === 0) return false; }
            else if (t.v === "|" && depth === 1) return true;
        }
        return false;
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
        if (j === 2 && this.lambdaDeclarationAt(this.i + j)) return true;
        const ctor = this.peek(j), after = this.peek(j + 1);
        // A family of lists starts with [] or x :: rest.
        const listed = ctor.k === "sym" && ctor.v === "[" && after.k === "sym" && after.v === "]" ||
            ctor.k === "ident" && /^[a-z]/.test(ctor.v) && after.k === "sym" && after.v === "::";
        if (!listed && (ctor.k !== "ident" || !/^[A-Z]/.test(ctor.v))) return false;
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
            this.statementIndent = 0;

            if (this.skipFixityDeclaration()) continue;
            const operator = this.tryOperatorDefinition();
            if (operator) {
                out.push({ t: "def", ...operator });
                continue;
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
                // Vec = n, a -> (Nil -> ... | Cons ...) is Vec n a = ..., as
                // f = x -> e is f x = e: the parameters, then the constructors in ( ).
                let variants: ReturnType<Parser["parseConstructors"]>;
                if (!parameters.length && this.lambdaDeclarationAt(this.i)) {
                    for (;;) {
                        parameters.push((this.next() as { v: string }).v);
                        if (this.eatSym(",")) continue;
                        this.expectSym("->");
                        if (this.isSym("(")) break;
                    }
                    if (new Set(parameters).size !== parameters.length) throw new Error("Parser: type parameters must be distinct lowercase names");
                    this.expectSym("(");
                    variants = this.parseConstructors(name, [name, ...parameters].join(" "));
                    this.skipNL();
                    this.expectSym(")");
                } else variants = this.parseConstructors(name, [name, ...parameters].join(" "));
                if (new Set(variants.map(v => v.tag)).size !== variants.length) throw new Error("Parser: duplicate value constructor");
                if (variants.some(v => TYPE_NAMES.includes(v.tag))) throw new Error("Parser: a value constructor cannot replace a built-in type");
                // Register only after the entire declaration has parsed successfully.
                declaredTypes.add(name);
                for (const { tag, arity } of variants) {
                    if (tag === "[]" || tag === "::") continue;
                    declaredCtors.add(tag);
                    if (arity === 0) nullaryCtors.add(tag); else nullaryCtors.delete(tag);
                }
                out.push({ t: "type", def: { name, parameters, variants } });
                continue;
            }

            if (t.k === "kw") {
                if (this.isPatBinding()) { out.push(this.parsePatBinding() as TopLevel); continue; }
                // Keyword-led expressions still include trailing operators and pipes.
                const e = this.parseExpr();
                out.push({ t: "expr", value: e });
                continue;
            }

            if (t.k === "ident") {
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
                if (this.isPatBinding()) { out.push(this.parsePatBinding() as TopLevel); continue; }
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
// Type names (built in or declared): in a pattern their arguments are types
// and indices, so a capitalized one takes nothing after it (Vect n Int xs).
const declaredTypes = new Set<string>(TYPE_NAMES);

// Tooling parses each document independently, without leaking REPL declarations.
export function parseDocument(src: string): TopLevel[] {
    const sets = [declaredCtors, nullaryCtors, declaredTypes];
    const saved = sets.map((set) => [...set]);
    sets.forEach((set) => set.clear());
    TYPE_NAMES.forEach((name) => declaredTypes.add(name));
    try { return parse(src); }
    finally {
        sets.forEach((set, i) => {
            set.clear();
            saved[i].forEach((name) => set.add(name));
        });
    }
}

// Where the string or character literal starting at pos ends.
function literalEnd(source: string, pos: number): number {
    let at = pos + 1;
    while (at < source.length && source[at] !== source[pos]) at += source[at] === "\\" ? 2 : 1;
    return at + 1;
}

// Loose spacing (apn --loose): none of the spacing rules apply.
let looseSpacing = false;
export function setLooseSpacing(loose: boolean): void { looseSpacing = loose; }
export function getLooseSpacing(): boolean { return looseSpacing; }

// A line has at most this many characters (code points), each string,
// character or number literal on it, and its comment, counting as one: a line
// may overflow only by what cannot be broken.
export const MAX_LINE_LENGTH = 99;
function checkLineLengths(src: string, toks: Token[]): void {
    const width = (from: number, to: number) => [...src.slice(from, to)].length;
    // Each literal's source span, from where it starts to where it ends.
    const literals: Array<[number, number]> = [];
    toks.forEach((t, n) => {
        if (t.k === "str" || t.k === "char") literals.push([t.pos, literalEnd(src, t.pos)]);
        else if (t.k === "int" || t.k === "float") literals.push([t.pos, t.pos + src.slice(t.pos, toks[n + 1]?.pos ?? src.length).split("#")[0].trimEnd().length]);
    });
    let start = 0, next = 0;
    for (const raw of src.split("\n")) {
        const line = raw.replace(/\r$/, ""), end = start + line.length;
        const spans: Array<[number, number]> = [];
        while (next < literals.length && literals[next][0] < end) spans.push(literals[next++]);
        const length = width(start, end);
        if (length > MAX_LINE_LENGTH) {
            // The comment: a '#' outside the literals, to the end of the line.
            let comment = start;
            for (; comment < end; comment++) {
                if (src[comment] === "#" && !spans.some(([a, b]) => a <= comment && comment < b)) break;
            }
            const parts = [[comment, end], ...spans.map(([a, b]) => [a, Math.min(b, end)])].filter(([a, b]) => a < b);
            const counted = length - parts.reduce((sum, [a, b]) => sum + width(a, b) - 1, 0);
            if (counted > MAX_LINE_LENGTH) {
                const e = new APNError("parse", `line is ${counted} characters long, counting each literal and comment as one; the limit is ${MAX_LINE_LENGTH}`, {
                    pos: start + [...line].slice(0, MAX_LINE_LENGTH).join("").length, len: 1,
                    hint: "break it: a deeper line continues an application's arguments, an operator chain, a list item or a record field",
                });
                e.src = src;
                throw e;
            }
        }
        start = end + raw.length - line.length + 1;
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
    if (!looseSpacing) checkLineLengths(src, toks);
    const p = new Parser(toks, src, file);
    try {
        declareFixities(toks);
        p.checkColons();
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
//   len (x :: rest) = 1 + len rest
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
        case "computedRange": {
            const end = `..${e.hi === null ? "" : exprToSource(e.hi)}`;
            return `[${itemsText(e.second === null ? [exprToSource(e.lo) + end] : [exprToSource(e.lo), exprToSource(e.second) + end])}]`;
        }
        case "import": return `import ${Array.isArray(e.module) ? `[${itemsText(e.module.map(m => JSON.stringify(m)))}]` : JSON.stringify(e.module)}`;
        case "numeric": return numberText(e.v);
        case "rationalRange": return `[${itemsText([numberText(e.lo), `${numberText(arithmetic("+", e.lo, e.step))}..${e.hi === null ? "" : numberText(e.hi)}`])}]`;
        case "int": return String(e.v);
        case "float": return numberText({ kind: "float", v: e.v });
        case "bool": return e.v ? "true" : "false";
        case "string": return stringLiteral(e.v);
        case "char": return charLiteral(e.v);
        case "placeholder": return "_";
        case "var": return e.name;
        case "binop": return `${exprToSource(e.l)} ${e.op} ${exprToSource(e.r)}`;
        case "unop": return `${e.op === "neg" ? "-" : "!"}${exprToSource(e.e)}`;
        case "app": return `${exprToSource(e.f)} ${exprToSource(e.a)}`;
        case "patternLambda": return `${e.params.map(patternSource).join(", ")}${e.guard ? " | " + exprToSource(e.guard) : ""} -> ${exprToSource(e.body)}`;
        case "lambda": return `${e.params.join(", ")} -> ${exprToSource(e.body)}`;
        case "list": return `[${itemsText(e.v.map(exprToSource))}]`;
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
            return `${exprToSource(e.rec)}.[${itemsText(e.entries.map((x) => typeof x === "string" ? keySource(x) : `${keySource(x[0])}: ${x[1]}`))}]`;
        case "setItem": {
            const index = exprToSource(e.index);
            return `${exprToSource(e.rec)} ${e.index.t === "block" ? index : `(${index})`} = ${exprToSource(e.value)}`;
        }
        case "setFields":
            return `${exprToSource(e.rec)}.${(e.path ?? []).map(keySource).map(key => key + ".").join("")}[${itemsText(e.entries.map((key, n) => keySource(key) + (e.aliases ? ": " + keySource(e.aliases[n]) : "")))}] = ${exprToSource(e.value)}`;
        case "block": {
            const body = e.stmts.map(exprToSource).join("; ");
            return e.style === "(" ? `(${body})` : `{ ${body} }`;
        }
        // A binding (a block's statement or a list's item): f n = ..., [a,b] = xs.
        case "stmDef": return e.clauses.map(c => [e.name, ...c.params.map(patternSource)].join(" ") + ` = ${exprToSource(c.body)}`).join("; ");
        case "patDef":
            if (e.value.t === "setItem" || e.value.t === "setFields") return exprToSource(e.value);
            return `${patternSource(e.pattern)} ${e.eager ? "<-" : "="} ${exprToSource(e.value)}`;
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
        case "string": return stringLiteral(p.v);
        case "char": return charLiteral(p.v);
        case "float": return numberText({ kind: "float", v: p.v });
        case "list": return `[${itemsText(p.v.map(patternSource))}]`;
        case "cons": return `(${patternSource(p.head)} ${p.op ?? "::"} ${patternSource(p.tail)})`;
        case "constr": return p.args.length ? `(${p.tag} ${p.args.map(patternSource).join(" ")})` : p.tag;
        case "typeBind": return `(${p.name} ${patternSource(p.value)})`;
        case "recPat": return `[${p.v.map(([k, v]) => `${keySource(k)}: ${v}`).join(", ")}]`;
        case "range": return `[${p.lo}..${p.hi}]`;
    }
}
