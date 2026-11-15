import { countingOf, typeOperators, writtenOperators, type DataDef, extendedDeclaration, fillPlaceholders, holdsPlaceholder, patternNames, sourceLocations } from "./ast.ts";
import { fieldSource, keySource } from "./record-keys.ts";
import { TYPE_NAMES } from "./type-system.ts";
import { type Real, type Numeric, numericNative, complex, arithmetic, negate, compareNumbers, integer, asFloat, numberText } from "./numbers.ts";
import { lex, OPERATOR_CHARS } from "./lexer.ts";
import preludeSource from "../lib/prelude.apn" with { type: "text" };
import { APNError, tokLen } from "./errors.ts";
import type { Expr, Pattern, TopLevel, BinOp } from "./ast.ts";
import type { DefClause, Type, Value, Env } from "./types.ts";
import type { Token } from "./lexer.ts";
import { charLiteral, itemsText, stringLiteral } from "./separators.ts";

// ---------------- Fixity ----------------

// An operator's precedence (0 loosest .. 9) and associativity, from fixity
// declarations: the prelude's, and any a program makes (infixl 6 +, infixr 5
// ++ +++, infix 4 ==). An undeclared operator is infixl 9.
export interface Fixity { prec: number; assoc: "left" | "right" | "none" }
// The prelude's fixities hold everywhere; a file's own, in the file. Another
// operator's is its value's, where the code runs (see reassociate).
const preludeFixities = new Map<string, Fixity>();
let fileFixities = new Map<string, Fixity>();
export const DEFAULT_FIXITY: Fixity = { prec: 9, assoc: "left" };
// The fixity the file being parsed can see for an operator, if any.
export function declaredFixity(op: string): Fixity | undefined {
    return fileFixities.get(op) ?? preludeFixities.get(op);
}
export function fixityOf(op: string): Fixity {
    return declaredFixity(op) ?? DEFAULT_FIXITY;
}
export function preludeFixity(op: string): Fixity | undefined { return preludeFixities.get(op); }
// The fixities each parsed program declares, for the values it binds.
const programFixities = new WeakMap<TopLevel[], Map<string, Fixity>>();
export function fixitiesOf(program: TopLevel[]): Map<string, Fixity> | undefined { return programFixities.get(program); }
const fixityKind = (f: Fixity) => `infix${f.assoc === "none" ? "" : f.assoc[0]} ${f.prec}`;
// Operators of one level and two associativities group only as parentheses
// say: (Int | String) == t, as Int | String == t is neither grouping.
function mixable(first: { op: string; fixity: Fixity }, second: Extract<Token, { k: "sym" }>): void {
    if (!declaredFixity(first.op) || !declaredFixity(second.v)) return;
    const next = fixityOf(second.v), kind = fixityKind;
    if (next.prec !== first.fixity.prec || next.assoc === first.fixity.assoc) return;
    throw new APNError("parse", `'${first.op}' (${kind(first.fixity)}) and '${second.v}' (${kind(next)}) share a level but not an associativity`,
        { pos: second.pos, hint: "add parentheses" });
}
// Tokens that are syntax, not operators, though made of operator characters.
// ":" writes a record field and separates a ternary; "::" is cons. "|" is
// both: the union of types (Int | String), and a lambda's guard after its
// parameters (x | x > 0 -> x), which a declaration's alternatives are too.
const RESERVED_OPERATORS = new Set(["=", ":=", ":", "->", "<-", "!"]);
// The intrinsics behind the prelude's operators (lib/prelude.apn binds
// each symbol to one), keyed by name.
export const PRIMITIVE_OPERATORS = new Map<string, string>([
    ["intrinsics.apply", "$"], ["intrinsics.or", "||"], ["intrinsics.and", "&&"], ["intrinsics.eq", "=="], ["intrinsics.ne", "!="],
    ["intrinsics.lt", "<"], ["intrinsics.gt", ">"], ["intrinsics.le", "<="], ["intrinsics.ge", ">="], ["intrinsics.cons", "::"],
    ["intrinsics.add", "+"], ["intrinsics.sub", "-"], ["intrinsics.append", "++"], ["intrinsics.mul", "*"], ["intrinsics.div", "/"],
    ["intrinsics.mod", "%"], ["intrinsics.pow", "^"], ["intrinsics.compose", "\\"],
]);

// An operator section as written ((+ 1), (2 +)), which the parser reads as a
// lambda over $S; operand writes the section's operand.
export function sectionSource(params: string[], body: Expr, operand: (e: Expr) => string): string | undefined {
    const parts = body.t === "binop" ? [body.op, body.l, body.r] as const : body.t === "pipe" ? ["$", body.f, body.x] as const : undefined;
    if (!parts) return undefined;
    const [op, l, r] = parts, is = (e: Expr, name: string) => e.t === "var" && e.name === name, names = params.join();
    if (names === "$S" && is(l, "$S")) return `(${op} ${operand(r)})`;
    if (names === "$S" && is(r, "$S")) return `(${operand(l)} ${op})`;
    return undefined;
}
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
function declareFixities(toks: Token[], fixities: Map<string, Fixity>): void {
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
declareFixities(lex(preludeSource), preludeFixities);

// A chain of operators the parse could not see every fixity of (one a module
// defines), regrouped by the fixities its operators have where it runs (the
// fixity of each operator's value there): one grouping per set of fixities.
const regroupings = new WeakMap<Expr, Map<string, Expr>>();
export function regroup(e: Expr, fixityHere: (op: string) => Fixity): Expr {
    const ops: string[] = [];
    const walk = (x: Expr): void => { if (x.t === "binop") { walk(x.l); ops.push(x.op); walk(x.r); } };
    walk(e);
    const fixities = new Map(ops.map(op => [op, fixityHere(op)]));
    const key = [...fixities].map(([op, f]) => `${op} ${f.prec}${f.assoc}`).join(",");
    let cached = regroupings.get(e);
    if (!cached) regroupings.set(e, cached = new Map());
    let grouped = cached.get(key);
    if (!grouped) cached.set(key, grouped = reassociate(e, op => fixities.get(op)!));
    return grouped;
}
// The chain's operands as written (a group, in parentheses, is one) with its
// operators, grouped by the fixities given.
function reassociate(e: Expr, fixity: (op: string) => Fixity): Expr {
    const operands: Expr[] = [], ops: string[] = [];
    const flatten = (x: Expr): void => {
        if (x.t === "binop") { flatten(x.l); ops.push(x.op); flatten(x.r); } else operands.push(x);
    };
    flatten(e);
    const at = sourceLocations.get(e);
    let j = 0;
    const chain = (min: number): Expr => {
        let left = operands[j];
        while (j < ops.length && fixity(ops[j]).prec >= min) {
            const op = ops[j], f = fixity(op);
            j++;
            const right = chain(f.assoc === "right" ? f.prec : f.prec + 1);
            const next = ops[j], g = next === undefined ? undefined : fixity(next);
            if (g && g.prec === f.prec && (g.assoc !== f.assoc || f.assoc === "none")) {
                throw new APNError("runtime", f.assoc === "none" && g.assoc === "none" ? `'${op}' is non-associative (${fixityKind(f)}); add parentheses`
                    : `'${op}' (${fixityKind(f)}) and '${next}' (${fixityKind(g)}) share a level but not an associativity`, { hint: "add parentheses" });
            }
            left = { t: "binop", op: op as BinOp, l: left, r: right };
            if (at) sourceLocations.set(left, at);
        }
        return left;
    };
    return chain(0);
}

// ---------------- Parser ----------------

// For the unnecessary-parentheses rule: how an expression would parse written
// without its parentheses. A primary is one piece of an application (a name,
// literal, bracket or postfix access); level is its loosest top operator
// (Infinity: none, so any operand place takes it); reach is the loosest
// operator after it that it would take in (a lambda's body takes everything).
const isLambda = (e: Expr) => e.t === "lambda" || e.t === "patternLambda";
// An ascription is written in its own parentheses: (x : T).
const primary = (e: Expr) => e.t === "app" && !!e.ascribed || !["binop", "pipe", "unop", "app", "ternary", "lambda", "patternLambda"].includes(e.t);
// (r.1).2 is not r.1.2, which reads the float 1.2.
const postfixHead = (e: Expr) => primary(e) && !["int", "float", "numeric"].includes(e.t) && !(e.t === "recordAccess" && /^\d/.test(e.field));
function level(e: Expr): number {
    if (e.t === "binop") return fixityOf(e.op).prec;
    if (e.t === "pipe") return fixityOf("$").prec;
    return e.t === "ternary" ? 1 : Infinity;
}
function reach(e: Expr): number {
    const binding = (op: string) => fixityOf(op).assoc === "right" ? fixityOf(op).prec : fixityOf(op).prec + 1;
    switch (e.t) {
        case "lambda": case "patternLambda": return -Infinity;
        case "app": return isLambda(e.a) ? -Infinity : Infinity;
        case "ternary": return Math.min(1, reach(e.els));
        case "unop": return Math.min(8, reach(e.e));
        case "binop": return Math.min(binding(e.op), reach(e.r));
        case "pipe": return Math.min(binding("$"), reach(e.x));
        default: return Infinity;
    }
}

// Where a pattern's parentheses are needed (see Parser.judgePattern): around
// a negative number, which bare reads as subtraction; around a binding's
// as-pattern (a.b = v sets a field) or name ((x) = v is no binding).
const negative = (p: Pattern) => (p.p === "int" || p.p === "float") && p.v < 0;
const bindingNeeds = (p: Pattern) => p.p === "as" || p.p === "var" || negative(p);

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
                this.checkCommaSpacing(t, holds[holds.length - 1] ?? "params", tight.has(index), this.pairedCommas.has(index));
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

    // Whether the [ at index opens record fields ([x = 1], keyed patterns and
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
    // item it separates has a space ([1,2,3]), one space otherwise ([x = 1, y = 2],
    // [1 + 1, 2], and always between lambda parameters: x, y -> x). A newline already separates items, so a
    // ',' ending its line is redundant.
    checkCommaSpacing(t: Token, holds: "record" | "list" | "params", tight: boolean, paired = false): void {
        const after = this.source.slice(t.pos + 1).split("\n", 1)[0];
        this.seen = t;
        if (/^\s*(#.*)?$/.test(after)) throw new Error("Parser: a newline already separates items; remove the ',' at the end of the line");
        if (!/\s/.test(this.source[t.pos - 1] ?? " ") && (tight ? /^\S/ : /^ \S/).test(after)) return;
        if (this.eitherCommas.has(this.toks.indexOf(t)) && !/\s/.test(this.source[t.pos - 1] ?? " ") && /^ \S/.test(after)) return;
        if (holds === "params") throw new Error("Parser: separate lambda parameters by ', ' (write x, y -> x + y)");
        const what = holds === "record" ? "record fields" : "list items";
        throw new Error(tight
            ? `Parser: separate ${what} with no spaces in them by ',' alone (write [1,2,3])`
            : `Parser: separate ${what} by ', ' when one has a space${paired ? ", on either side of =" : ""} (write ${holds === "record" ? "[x = 1, y = 2]" : paired ? "[f x, g y] = [x, y]" : "[1 + 1, 2]"})`);
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
        // A bracket's commas, and whether any of its items has a space.
        type Bracket = { open: number; commas: number[]; spaced: boolean };
        type Frame = { list: boolean; open: number; start: number; items: [number, number][]; commas: number[]; whole: Bracket };
        const decide = (frame: Frame, end: number) => {
            if (frame.start < end) frame.items.push([frame.start, end]);
            const segmentSpaced = frame.items.some(([a, b]) => spaced(a, b));
            if (frame.commas.length && !segmentSpaced) frame.commas.forEach(c => tight.add(c));
            if (frame.list) { frame.whole.commas.push(...frame.commas); frame.whole.spaced ||= segmentSpaced; }
            frame.items = []; frame.commas = [];
        };
        const closed = new Map<number, Bracket>(), opened = new Map<number, Bracket>();
        const frames: Frame[] = [{ list: false, open: -1, start: 0, items: [], commas: [], whole: { open: -1, commas: [], spaced: false } }];
        for (let i = 0; i < toks.length; i++) {
            const t = toks[i], frame = frames[frames.length - 1];
            if (opens(t)) {
                frames.push({ list: t.k === "sym" && t.v === "[", open: i, start: i + 1, items: [], commas: [], whole: { open: i, commas: [], spaced: false } });
                continue;
            }
            if (closes(t) || layout(t)) {
                decide(frame, i);
                if (closes(t) && frame.list) { closed.set(i, frame.whole); opened.set(frame.open, frame.whole); }
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
        // [f x, g y] = [x, y]: a bracket that is the whole left side of =
        // (a statement's start, in a block too, or the fields v.[x,y] names) pairs its items
        // with the right's, so one rule spaces both: ', ' when an item on
        // either side has a space. A parameter's just before = or ->, beside a
        // spaced body, may follow it (f [x, y] = [x + x, y + y], [x, y] ->
        // [x + x, y + y]) or its own items ([op,x] = ["->", op]).
        const starts = (t?: Token) => !t || layout(t) || t.k === "sym" && [";", "{", "("].includes(t.v);
        const whole = (open: number) => {
            let at = open;
            // v.[x,y] or obj.child.[x,y]: the selection's chain starts the statement.
            while (toks[at - 1]?.k === "sym" && (toks[at - 1] as { v: string }).v === "." && toks[at - 2]?.k === "ident") at -= 2;
            return starts(toks[at - 1]);
        };
        toks.forEach((t, i) => {
            const left = closed.get(i - 1), right = opened.get(i + 1);
            if (t.k !== "sym" || t.v !== "=" && t.v !== "->" || !left || !right) return;
            if (t.v === "->" || !whole(left.open)) {
                if (right.spaced) left.commas.forEach(c => this.eitherCommas.add(c));
                return;
            }
            const commas = [...left.commas, ...right.commas];
            commas.forEach(c => this.pairedCommas.add(c));
            if (left.spaced || right.spaced) commas.forEach(c => tight.delete(c));
        });
        return tight;
    }
    // Commas whose spacing both sides of an = decide (see tightCommas).
    private pairedCommas = new Set<number>();
    // A parameter's commas, which may follow a spaced body (see tightCommas).
    private eitherCommas = new Set<number>();


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
    isSymAt(n: number, v: string) { const t = this.peek(n); return t.k === "sym" && t.v === v; }
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

    // A plain grouped pattern, (p), by its ( token's index: where it stands
    // decides whether it needs the parentheses (see judgePattern).
    patternGroups = new WeakMap<Pattern, number>();
    // Parentheses around a pattern that reads the same without them are
    // unnecessary, as around an expression: needed tells where they are not.
    judgePattern(p: Pattern, needed: (p: Pattern) => boolean): void {
        const open = this.patternGroups.get(p);
        // A built-in type applied to a value ((Int x)) is the old typed
        // spelling, whose own error says how to write it.
        const typed = p.p === "constr" && !p.typed && p.args.length > 0 && TYPE_NAMES.includes(p.tag);
        if (open !== undefined) this.unnecessary.set(open, !typed && !needed(p));
    }

    // A constructor's field stands alone: it is parenthesized only to apply
    // a constructor or to write a cons or an as-pattern (Some (Ok x), not Some (x)).
    field(p: Pattern): Pattern {
        this.judgePattern(p, q => q.p === "constr" && q.args.length > 0 || q.p === "cons" || q.p === "as" || negative(q));
        return p;
    }

    parsePattern(): Pattern {
        const left = this.parsePatternAtom();
        return this.eatSym(".") ? { p: "as", left, right: this.parsePattern() } : left;
    }

    parsePatternAtom(): Pattern {
        const t = this.peek();
        if (t.k === "sym" && t.v === "(") {
            this.unnecessary.delete(this.i);
            // (sin x), (t1 1 t2): a lowercase name applied, a head its binding
            // decides where it runs (see resolveHeads).
            const name = this.peek(1), first = this.peek(2);
            if (name.k === "ident" && /^[a-z]/.test(name.v) && this.startsParam(first) && !(first.k === "sym" && first.v === "_" && this.isSymAt(3, ")"))) {
                const save = this.i;
                try {
                    this.next(); this.next();
                    const args: Pattern[] = [];
                    while (!this.isSym(")")) args.push(this.parsePatternAtom());
                    this.next();
                    return { p: "constr", tag: name.v, args, head: true };
                } catch { this.i = save; }
            }
        }
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
        if (t.k === "kw" && (t.v === "True" || t.v === "False")) { this.next(); return { p: "bool", v: t.v === "True" }; }
        if (t.k === "str") { this.next(); return { p: "string", v: t.v }; }
        if (t.k === "sym" && (t.v === "(" || t.v === "{")) {
            const close = t.v === "(" ? ")" : "}";
            this.next();
            if (this.isSym(close)) { this.next(); return { p: "list", v: [] }; }
            const signatureStart = this.i;
            // A typed pattern: ((Int -> Int) f), ([Int] xs). Its type is any
            // expression read as a type, a lambda included.
            if (this.isSym("[") || this.isSym("(") || this.isSym("{")) {
                let typed: Pattern | undefined;
                try {
                    this.noLambda++;
                    let type: Expr;
                    try { type = this.parsePrimary(); } finally { this.noLambda--; }
                    if (this.startsParam(this.peek())) {
                        const value = this.parsePattern();
                        this.expectSym(close);
                        typed = { p: "schema", type, value };
                    }
                } catch { /* ordinary grouped pattern */ }
                if (typed) return writtenTypeFirst(typed, t.pos);
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
            // A union of types with no name, (Int | String), matches a value of
            // one of them, as (a -> b) matches a function.
            if (close === ")" && this.arrowBefore(close, "|")) {
                const type = this.parseExpr();
                if (type.t !== "binop" || type.op !== "|" || !this.isSym(close)) throw new Error("Parser: a union in a pattern is types joined by '|': (Int | String)");
                this.next();
                return { p: "schema", type, value: { p: "wildcard" } };
            }
            const typeName = this.peek(), valueName = this.peek(1), closing = this.peek(2);
            // (t x) binds the value's type and payload; (_ x) only the payload.
            if (typeName.k === "ident" && (/^[a-z]/.test(typeName.v) || typeName.v === "_") &&
                valueName.k === "ident" && closing.k === "sym" && closing.v === close) {
                this.next();
                const value = this.parsePattern();
                this.expectSym(close);
                return writtenTypeFirst({ p: "typeBind", name: typeName.v, value }, t.pos);
            }
            const p = this.parseConsPattern();
            if (this.eatSym(",")) {
                throw new Error("Parser: tuple patterns are not supported; use a list pattern [a, b, ...] instead");
            }
            // (p : T) matches a value of T, as T, then p.
            if (this.eatSym(":")) {
                const type = this.typeExpr(this.typeEnd("group").end);
                this.expectSym(close);
                return typedPattern(p, type);
            }
            this.expectSym(close);
            if (close === ")") this.patternGroups.set(p, this.toks.indexOf(t));
            return p;
        }
        // [x : Int, y : Int]: a record of those fields' types, each bound to its
        // name, as (r : [x : Int, y : Int]) is the record and r.x its field.
        if (t.k === "sym" && t.v === "[" && this.peek(1).k === "ident" && this.isSymAt(2, ":")) {
            const type = this.parsePrimary();
            if (type.t === "record" && type.declared?.length === type.v.length) {
                return { p: "schema", type, value: { p: "recPat", v: type.v.map(([key]) => [key, key] as [string, string]) } };
            }
            throw new Error("Parser: a record pattern of types gives each field a type: [x : Int, y : Int]");
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
                    if (mode === "bare") throw new Error("Parser: a pattern cannot mix bare names and 'field = name' entries");
                    mode = "keyed";
                    const key = this.parseEntryKey();
                    this.next(); // =
                    const nm = this.next();
                    if (nm.k !== "ident") throw new Error("Parser: expected a name after '=' in a record pattern");
                    if (key === "_" && keyed.some(([k]) => k === "_")) throw new Error("Parser: record pattern permits only one remainder");
                    keyed.push([key, nm.v]);
                } else {
                    if (mode === "keyed") throw new Error("Parser: a pattern cannot mix bare names and 'field = name' entries");
                    mode = "bare";
                    // An item is a whole pattern, up to its ',': [Some x, y].
                    const item = this.parseConsPattern();
                    this.judgePattern(item, negative);
                    ps.push(item);
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
            // constructor application: Some x. A capitalized argument takes
            // nothing after it (R low None high): one with fields is parenthesized.
            if (/^[A-Z]/.test(name)) {
                const args = [] as Pattern[];
                while (this.startsParam(this.peek())) {
                    const token = this.peek();
                    if (token.k === "ident" && /^[A-Z]/.test(token.v)) { this.next(); args.push({ p: "constr", tag: token.v, args: [] }); }
                    else args.push(this.field(this.parsePattern()));
                }
                return { p: "constr", tag: name, args };
            }
            return { p: "var", name };
        }
        throw new Error(`Parser: bad pattern '${this.tokenStr(t)}'`);
    }

    // A spaced ':' writes a type (x : Int, a field's [x : Int] included), an
    // unspaced one a ternary's else (c ? a : b); anything else is cons or a
    // record field written the old way.
    checkColons(): void {
        const open: string[] = [], pending = [0];
        for (const t of this.toks) {
            if (t.k !== "sym") continue;
            if (["(", "[", "{"].includes(t.v)) { open.push(t.v); pending.push(0); continue; }
            if ([")", "]", "}"].includes(t.v)) { open.pop(); if (pending.length > 1) pending.pop(); continue; }
            if (t.v === "?") { pending[pending.length - 1]++; continue; }
            if (t.v !== ":") continue;
            if (pending[pending.length - 1] > 0) { pending[pending.length - 1]--; continue; }
            // A declaration, an ascription or a field's type, x : Int: the parser places it.
            if (/\s/.test(this.source[t.pos - 1] ?? "") && /\s/.test(this.source[t.pos + 1] ?? "")) continue;
            const next = this.toks[this.toks.indexOf(t) + 1];
            this.seen = t;
            if (open[open.length - 1] === "[" && /\s/.test(this.source[t.pos + 1] ?? "")) {
                throw new Error("Parser: a record's field is written x = 1, or x : T for its type");
            }
            if (next?.k === "ident" && /^[A-Z]/.test(next.v)) {
                throw new Error(`Parser: a declaration or an ascription spaces its ':' (x : ${next.v})`);
            }
            throw new Error("Parser: cons is '::' (x :: xs); ': T' writes a type (x : T) and ':' a ternary's else (c ? a : b)");
        }
    }

    // An infix constructor pattern: x :: xs, or x op y for any operator
    // starting with ':' (as in Haskell); it matches the constructor op names.
    parseConsPattern(): Pattern {
        const p = this.parsePattern();
        const t = this.peek();
        if (t.k === "sym" && isConstructorOperator(t.v)) {
            this.next();
            // Cons groups to the right and takes applied constructors:
            // Some x :: rest, x :: y :: rest; (x :: y) :: rest needs them.
            this.judgePattern(p, q => q.p === "cons" || q.p === "as" || negative(q));
            const tail = this.parseConsPattern();
            this.judgePattern(tail, q => q.p === "as" || negative(q));
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

    // A ternary's branch. A ternary inside one is parenthesized, which keeps
    // its parentheses (see judge): c ? (d ? 1 : 2) : 3, c ? 1 : (d ? 2 : 3).
    branches = new Set<number>();
    branch(): Expr {
        const at = this.nextToken(), start = this.toks[at];
        this.branches.add(at);
        const e = this.parseOperators(1);
        if (e.t === "ternary") throw new APNError("parse", "a ternary inside a ternary needs parentheses", {
            pos: start.pos, len: 1, hint: "write `c ? (d ? 1 : 2) : 3`, or `c ? 1 : (d ? 2 : 3)`",
        });
        return e;
    }
    // The index of the next token past line breaks and indentation.
    nextToken(): number {
        let j = this.i;
        while (["newline", "indent", "dedent"].includes(this.toks[j].k)) j++;
        return j;
    }

    // outer: the operator whose right operand this is, which one of its
    // level and another associativity cannot follow without parentheses.
    // Operators met whose fixity this file cannot see (see reassociate).
    unknownOperators = 0;
    parseOperators(minPrec: number, outer?: { op: string; fixity: Fixity }): Expr {
        const start = this.peek().pos, unknownBefore = this.unknownOperators;
        const at = this.nextToken();
        let left = this.parseOperand();
        this.judge(left, e => level(e) >= minPrec && this.fitsBefore(e) &&
            !(isLambda(e) && (this.noLambda || this.listedParams(left))) && !(e.t === "unop" && this.afterPrefix(left)) &&
            !(e.t === "ternary" && this.branches.has(at)));
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
                const then = this.branch();
                this.noCons = saved;
                this.continueLine(x => x.k === "sym" && x.v === ":");
                this.expectSym(":");
                const els = this.branch();
                left = { t: "ternary", cond: left, then, els };
                continue;
            }
            if (!isOperatorName(t.v)) break;
            // Leave a trailing operator for the operand-front section (2 ^).
            const after = this.peek(1);
            if (after.k === "sym" && (after.v === ")" || after.v === "}")) break;
            const fixity = fixityOf(t.v);
            if (fixity.prec < minPrec) break;
            if (!declaredFixity(t.v)) this.unknownOperators++;
            if (outer) mixable(outer, t);
            this.next();
            this.skipContinuation();
            const rightStart = this.peek().pos;
            const right = this.parseOperators(fixity.assoc === "right" ? fixity.prec : fixity.prec + 1, { op: t.v, fixity });
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
            if (fixity.assoc === "none" && following.k === "sym" && isOperatorName(following.v) && declaredFixity(following.v) && fixityOf(following.v).prec === fixity.prec) {
                throw new Error(`Parser: '${t.v}' is non-associative (infix ${fixity.prec}); add parentheses`);
            }
            if (following.k === "sym" && isOperatorName(following.v)) mixable({ op: t.v, fixity }, following);
        }
        // A whole chain holding an operator of unknown fixity is regrouped where it runs.
        if (!outer && this.unknownOperators > unknownBefore && left.t === "binop") left.reassociate = true;
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
        const piece = this.parsePrimary(), head = this.parsePostfix(piece);
        if (head !== piece) this.judge(piece, postfixHead);
        let f = head;
        // application: f x y  (does not cross a newline at the statement's level,
        // nor a `;`). A deeper line starting an argument continues it, as one
        // starting with an operator does (never with `{`: braces stay on the line),
        // unless the line ends a block or is the closing line of a bracket: a
        // stray indented statement after one stays an error.
        const argument = (t: Token) => t.k === "ident" || t.k === "int" || t.k === "float" || t.k === "bool" ||
            (t.k === "kw" && (t.v === "True" || t.v === "False")) || t.k === "str" || t.k === "char" ||
            (t.k === "sym" && (t.v === "(" || t.v === "["));
        const closed = (t: Token | undefined) => t?.k === "sym" && (t.v === "}" ||
            (t.v === "]" || t.v === ")") && !this.source.slice(this.source.lastIndexOf("\n", t.pos - 1) + 1, t.pos).trim());
        for (;;) {
            if (!closed(this.toks[this.i - 1])) this.continueLine(argument);
            const t = this.peek();
            if (t.k === "newline" || t.k === "dedent" || t.k === "indent" || t.k === "eof") break;
            if (t.k === "sym" && t.v === ";") break;
            // f -x passes -x, and f !x passes !x: a prefix operator spaced
            // before and not after applies to what follows it.
            const prefix = this.negated(t) ? "neg" : this.notted(t) ? "not" : undefined;
            if (prefix) {
                this.next();
                const a: Expr = { t: "unop", op: prefix, e: this.parsePiece(primary) };
                sourceLocations.set(a, { source: this.source, file: this.file, start: t.pos, end: this.peek().pos });
                f = { t: "app", f, a };
                sourceLocations.set(f, { source: this.source, file: this.file, start, end: this.peek().pos });
                continue;
            }
            if (t.k === "ident" || t.k === "int" || t.k === "float" || t.k === "bool" ||
                    (t.k === "kw" && (t.v === "True" || t.v === "False")) ||
                    t.k === "str" || t.k === "char" ||
                    (t.k === "sym" && (t.v === "(" || t.v === "[" || t.v === "{"))) {
                const a = this.parsePiece(e => primary(e) || e.t === "unop" && primary(e.e));
                sourceLocations.set(a, { source: this.source, file: this.file, start: t.pos, end: this.peek().pos });
                f = { t: "app", f, a };
                sourceLocations.set(f, { source: this.source, file: this.file, start, end: this.peek().pos });
            } else break;
        }
        if (f !== head) this.judge(head, e => (primary(e) || e.t === "app") && reach(e) === Infinity);
        return f;
    }

    // -(-x) is not --x, one operator.
    afterPrefix(group: Expr): boolean {
        const open = this.groups.get(group)!, before = this.toks[open - 1];
        return before?.k === "sym" && (before.v === "-" || before.v === "!") && before.pos + 1 === this.toks[open].pos;
    }

    // In a list, (x, y -> e) needs its parentheses: x, y would be two items.
    listedParams(group: Expr): boolean {
        const lambda = (group as Extract<Expr, { t: "block" }>).stmts[0] as Extract<Expr, { t: "lambda" | "patternLambda" }>;
        return lambda.params.length > 1 && this.enclosing(this.groups.get(group)!) === "[";
    }

    // An argument: a primary and its postfix accesses. Parentheses around the
    // primary are unnecessary where its expression is one fits would take (a
    // lambda argument keeps them: f a (x -> e), as f a x -> e is).
    parsePiece(fits: (e: Expr) => boolean): Expr {
        const piece = this.parsePrimary(), e = this.parsePostfix(piece);
        this.judge(piece, e === piece ? fits : postfixHead);
        return e;
    }

    // Parentheses around one expression where it reads the same without them
    // are an error (reported once the parse is done; --loose allows them). A
    // group's verdict is decided where it stands, by the ( token's index; the
    // last parse of the tokens decides, so a speculative one is overruled.
    groups = new WeakMap<Expr, number>();
    unnecessary = new Map<number, boolean>();
    judge(group: Expr, fits: (e: Expr) => boolean): void {
        const open = this.groups.get(group);
        if (open === undefined) return;
        // Beside an operator this file cannot see the fixity of, or holding a
        // chain of one, parentheses may group as the operator's fixity needs.
        const inner = (group as Extract<Expr, { t: "block" }>).stmts[0], close = this.closer(open);
        const unknown = (t?: Token) => t?.k === "sym" && isOperatorName(t.v) && !declaredFixity(t.v);
        const unseen = unknown(this.toks[open - 1]) || unknown(this.toks[close + 1]) || inner.t === "binop" && (!!inner.reassociate || !declaredFixity(inner.op));
        this.unnecessary.set(open, !unseen && fits(inner));
    }

    // Whether what follows the group leaves its expression, written bare, as
    // it is: the end of the expression, or an operator it would not take in.
    fitsBefore(e: Expr): boolean {
        let j = this.i;
        while (["newline", "indent", "dedent"].includes(this.toks[j].k)) j++;
        const t = this.toks[j];
        if (t.k === "eof" || j > this.i && this.lineIndent(t) <= this.statementIndent) return true;
        if (t.k !== "sym") return false;
        if ([")", "]", "}", ",", ";", ":", "->", "..", "|"].includes(t.v)) return true;
        const prec = t.v === "?" ? 1 : isOperatorName(t.v) ? fixityOf(t.v).prec : undefined;
        if (prec === undefined) return false;
        const top = e.t === "binop" ? e.op : e.t === "pipe" ? "$" : undefined;
        return prec < reach(e) && !(top && fixityOf(top).assoc === "none" && fixityOf(top).prec === prec);
    }

    // Postfix:  field access  a.b, a.`b c`, a."b"  and the
    // record PLUCK, or evaluated list-template inputs
    //   a.[x, y]            -> list of those fields' values
    //   a.[v1 = x, v2 = y]  -> smaller record: field x kept as v1
    parsePostfix(e: Expr): Expr {
        while (this.isSym(".")) {
            this.next();
            const t = this.peek();
            if (t.k === "sym" && (t.v === "{" || t.v === "(")) {
                const argument = this.parsePrimary();
                e = { t: "recordAccess", rec: e, field: this.source.slice(t.pos, this.toks[this.i - 1].pos + 1), argument, scoped: true };
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
                        const key = this.parseEntryKey();
                        // v.[total = count]: a record whose total is v.count.
                        if (this.eatSym("=")) entries.push([this.parseEntryKey(), key]);
                        else {
                            entries.push(key);
                        }
                        this.skipListSeparators();
                        if (this.isSym("]")) break;
                        if (this.peek().k === "eof") throw new Error("Parser: unexpected end of file inside pluck");
                    }
                    this.next(); // ]
                    const mixed = new Set(entries.map((x) => typeof x));
                    if (mixed.size > 1) throw new Error("Parser: a selection cannot mix bare names and 'name = field' pairs");
                } catch { quoted = false; entries.length = 0; }
                this.i = bracketEnd;
                e = { t: "pluck", rec: e, entries, values, quoted };
            } else {
                const keyStart = this.i;
                // T."text": a list type applied to a string, as T.("text") is.
                const field = t.k === "str" ? (this.next(), t.v) : this.parseKey();
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

    // A keyed pattern's or selection's key: a name (or one in backticks).
    parseEntryKey(): string {
        const t = this.next();
        if (t.k !== "ident") throw new Error("Parser: expected a field name");
        return t.v;
    }

    // key = ..., in a keyed pattern ([x = a]) or selection (r.[a = x]).
    isKeyedEntry(): boolean {
        return this.peek().k === "ident" && this.peek(1).k === "sym" && (this.peek(1) as { v: string }).v === "=";
    }

    // A field after '.': a name, in backticks when it is not one.
    keyTok(t: Token): string {
        if (t.k === "ident") return t.v;
        if (t.k === "str") throw new Error(`Parser: a field that is not a name is written in backticks: \`${t.v}\``);
        if (t.k === "int" || t.k === "float") {
            const n = this.tokenStr(t);
            throw new Error(`Parser: a field is a name: write .\`${n}\` for the field named ${n}, or apply to ${n} for an index`);
        }
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
    // Whether this symbol (-> by default) stands at this level before the group closes.
    arrowBefore(close: string, symbol = "->"): boolean {
        for (let j = this.i, depth = 0; j < this.toks.length; j++) {
            const t = this.toks[j];
            if (t.k === "eof") return false;
            if (t.k !== "sym") continue;
            if (t.v === "(" || t.v === "[" || t.v === "{") depth++;
            else if (t.v === ")" || t.v === "]" || t.v === "}") { if (depth-- === 0) return false; }
            else if (t.v === symbol && depth === 0) return true;
            // (x : a -> b) and (x : Int | String) type a name.
            else if (t.v === ":" && depth === 0) return false;
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
                        const close = t.v === "(" ? ")" : "}", open = this.i;
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
                        let ascribing = false;
                        for (;;) {
                            if (this.isSym(";")) { this.next(); continue; }
                            while (this.peek().k === "newline") this.next();
                            while (this.peek().k === "dedent") this.next();
                            if (this.isSym(close)) {
                                if (multilineBrace && this.lineIndent(this.peek()) !== this.lineIndent(t)) {
                                    throw new Error("Parser: closing } must align with the line containing {");
                                }
                                this.statementIndent = outerIndent;
                                this.next();
                                this.applyDeclarations(stmts);
                                const block: Expr = { t: "block", stmts, style: close === ")" ? "(" : "{" };
                                // An ascription's parentheses are its own syntax: (e : T) is e : T.
                                if (ascribing) { this.unnecessary.set(open, false); return stmts[0] as Expr; }
                                if (close === ")" && stmts.length === 1 && !["stmDef", "patDef", "setItem", "setFields"].includes(stmts[0].t)) {
                                    this.groups.set(block, open);
                                    this.unnecessary.set(open, false);
                                }
                                return block;
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
                                                    if (this.isDeclaration(t.v === "(" && !stmts.length)) {
                                const declared = this.parseDeclaration();
                                stmts.push(declared.t === "def" ? { t: "stmDef", name: declared.name, clauses: declared.clauses } : declared.value);
                                continue;
                            }
                            const operator = this.tryOperatorDefinition();
                            if (operator) { stmts.push({ t: "stmDef", ...operator }); continue; }
                            // A block declares types as the top level does.
                            if (this.isTypeDeclaration()) {
                                for (const d of this.parseTypeDeclaration()) stmts.push(d.t === "type" ? { t: "typeDef", def: d.def } : d.t === "def" ? { t: "stmDef", name: d.name, clauses: d.clauses } : d.value);
                                continue;
                            }
                            const paired = this.pairedDefs();
                            if (paired) {
                                for (const d of paired) stmts.push({ t: "stmDef", ...d });
                            } else if (this.isEagerBinding()) {
                                stmts.push(this.parseEagerBinding());
                            } else if (this.isFieldAssignStart()) {
                                stmts.push(this.parseFieldAssign());
                            } else if (this.isPatBinding()) {
                                stmts.push(this.parsePatBinding());
                            } else {
                                if (this.isTypeAlone()) {
                                    throw this.typeAloneError();
                                } else if (this.isDef()) {
                                    const made = this.parseDefinition(tb.pos, stmts);
                                    if ("type" in made) this.declareInto(stmts, made.type, def => ({ t: "typeDef", def }));
                                    else joinClauses(stmts, { t: "stmDef", ...made.def });
                                }
                                else stmts.push(this.tryItemAssign() ?? this.parseDelimitedExpr());
                            }
                            // (e : T): e as a value of T.
                            if (close === ")" && stmts.length === 1 && this.isSym(":")) {
                                const colon = this.next();
                                stmts[0] = this.ascription(stmts[0], colon, "group");
                                ascribing = true;
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
                                    return { t: "range", lo: loE, second: null, hi: null };
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
                                return { t: "range", lo: loE, second: null, hi };
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
                                        return { t: "range", lo: loE, second: sE, hi: null };
                                    }
                                    const hi = this.parseOperators(6);
                                    this.expectSym("]");
                                    return { t: "range", lo: loE, second: sE, hi };
                                }
                                this.i = save2; // [1, 2] — a plain list
                            }
                            this.i = save; // not a range at all
                        }
                        // An item may be a binding, as a block's statement may: it is
                        // in scope for the items after it (x <- m when the code runs).
                        const es = [] as Expr[];
                        for (;;) {
                            es.push(this.item(this.peek(), () => this.isFieldDeclaration() ? this.parseFieldDeclaration()
                                : this.isEagerBinding() ? this.parseEagerBinding()
                                : this.isPatBinding() ? this.parsePatBinding() : this.isDef() ? this.parseBlockDef() : this.parseDelimitedExpr()));
                            this.skipListSeparators();
                            if (this.isSym("]")) { this.next(); return recordOf(es) ?? { t: "list", v: es }; }
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
            case "True": this.next(); return { t: "bool", v: true };
            case "False": this.next(); return { t: "bool", v: false };
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

    // f a e, t1 1 t2, withFile "notes" file (or the same in parentheses): one
    // typed pattern, an e of type f a, the type's arguments names or literals.
    typedRun(open: boolean): Pattern | undefined {
        const pieces: Expr[] = [];
        const piece = (w: Token): Expr | undefined => w.k === "ident" && /^[a-z]/.test(w.v) ? { t: "var", name: w.v }
            : !pieces.length ? undefined : w.k === "int" ? { t: "int", v: w.v } : w.k === "float" ? { t: "float", v: w.v }
            : w.k === "str" ? { t: "string", v: w.v } : w.k === "char" ? { t: "char", v: w.v } : undefined;
        let n = open ? 1 : 0;
        for (let w = this.peek(n), e = piece(w); e; w = this.peek(++n), e = piece(w)) pieces.push(e);
        const end = this.peek(n), value = pieces[pieces.length - 1];
        if (pieces.length < 3 || value.t !== "var" || end.k !== "sym" || !(open ? end.v === ")" : ["->", ",", "|"].includes(end.v))) return undefined;
        for (let k = 0; k < n + (open ? 1 : 0); k++) this.next();
        const type = pieces.slice(1, -1).reduce((f: Expr, a): Expr => ({ t: "app", f, a }), pieces[0]);
        return { p: "schema", type, value: { p: "var", name: value.name } };
    }

    lambdaParam(): Pattern {
        const t = this.peek(), next = this.peek(1);
        // A parenthesized run is a head (see parsePatternAtom).
        const run = t.k === "sym" && t.v === "(" ? undefined : this.typedRun(false);
        if (run) return run;
        if ((t.k === "ident" && /^[a-z]/.test(t.v) || t.k === "sym" && t.v === "_") && this.startsParam(next)) {
            this.next();
            return { p: "typeBind", name: t.k === "ident" ? t.v : "_", value: this.parseConsPattern() };
        }
        // A lambda's parameter is a whole pattern (Some x -> x, x :: xs -> x).
        const p = this.parseConsPattern();
        this.judgePattern(p, negative);
        return p;
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
        if ((["int", "float", "char", "str"].includes(t.k) || t.k === "kw" && (t.v === "True" || t.v === "False")) && after.k === "sym" && after.v === "=") return true;
        // A cons pattern: x :: xs = ..., (x :: xs) = ...
        const consAfter = (n: number) => { const c = this.peek(n); return c.k === "sym" && isConstructorOperator(c.v); };
        if (t.k === "sym" && (t.v === "(" || t.v === "{")) {
            const n1 = this.peek(1), n2 = this.peek(2);
            // ... or a typed one: (x : Float) :: rest = ...
            return n1.k === "ident" && (/^[A-Z]/.test(n1.v) || consAfter(2) || n2.k === "sym" && n2.v === ":");
        }
        const next = this.peek(1);
        return t.k === "ident" && (/^[A-Z]/.test(t.v) || (next.k === "sym" && (next.v === "." || isConstructorOperator(next.v))));
    }

    // The index of the bracket closing the one at token index open.
    closer(open: number): number {
        let close = open + 1;
        for (let depth = 0; ; close++) {
            const t = this.toks[close];
            if (t.k === "sym" && "([{".includes(t.v)) depth++;
            else if (t.k === "sym" && ")]}".includes(t.v) && depth-- === 0) return close;
        }
    }

    reportUnnecessary(): void {
        const open = [...this.unnecessary].filter(([, redundant]) => redundant).map(([index]) => index).sort((a, b) => a - b)[0];
        if (open === undefined) return;
        const close = this.closer(open);
        const text = this.source.slice(this.toks[open].pos, this.toks[close].pos + 1);
        throw new APNError("parse", `unnecessary parentheses: ${text.includes("\n") || text.length > 40 ? "this group" : `\`${text}\``} reads the same without them`, {
            pos: this.toks[open].pos, len: 1, hint: "remove the ( and its )",
        });
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
            if (this.isSym("[")) this.parseAssignEntries();
            else {
                this.parseKey();
                while (this.eatSym(".")) {
                    if (this.isSym("[")) { this.parseAssignEntries(); break; }
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
        let entries: string[] = [];
        let aliases: string[] = [];
        const path: string[] = [];
        while (!this.isSym("[")) {
            if (this.isSym("(") || this.isSym("{")) {
                const error = "scoped record expressions are not assignment targets; use a string key";
                if (pattern?.p === "as" && patternEnd !== undefined) {
                    this.i = patternEnd;
                    this.expectSym("=");
                    const value = this.parseDefBody();
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
        let types: (Expr | undefined)[] = [];
        if (bracketed) ({ entries, aliases, types } = this.parseAssignEntries());
        else entries.push(this.parseKey());
        this.expectSym("=");
        const rhs = this.parseDefBody();
        // Unnamed bracketed selection takes a list; renamed selection takes a record.
        // Only direct field assignment wraps its scalar RHS.
        if (aliases.length && aliases.length !== entries.length) throw new Error("Parser: cannot mix renamed and unnamed assignment entries");
        if (types.some(t => t)) return { t: "patDef", pattern: { p: "var", name }, value: this.typedAssignment(name, path, rhs, entries, aliases, types) };
        const value = bracketed ? rhs : { t: "list", v: [rhs] } as Expr;
        const update: Expr = { t: "setFields", rec: { t: "var", name }, entries, value, ...(aliases.length ? { aliases } : {}), ...(path.length ? { path } : {}) };
        return pattern?.p === "as"
            ? { t: "patDef", pattern, value: rhs, update: { name, value: update } }
            : { t: "patDef", pattern: { p: "var", name }, value: update };
    }

    // A field assignment's [ ] entries: x, x = a (renamed), each typed or not
    // (x : T, x : T = a).
    parseAssignEntries(): { entries: string[]; aliases: string[]; types: (Expr | undefined)[] } {
        const entries: string[] = [], aliases: string[] = [], types: (Expr | undefined)[] = [];
        this.expectSym("[");
        this.skipListLeading();
        while (!this.isSym("]")) {
            entries.push(this.parseEntryKey());
            types.push(this.eatSym(":") ? this.typeExpr(this.typeEnd("item").end) : undefined);
            if (this.eatSym("=")) aliases.push(this.parseEntryKey());
            this.skipListSeparators();
            if (this.isSym("]")) break;
            if (this.peek().k === "eof") throw new Error("Parser: unexpected end of file inside field-assignment entries");
        }
        this.next(); // ]
        return { entries, aliases, types };
    }
    // v.[x : T, y] = [a, b] declares x anew, as x : T = a does in a literal:
    // v = [use v, x : T = a].[y] = [b], the typed fields in a copy and the
    // others assigned to it as usual. A value that is not a list literal is
    // read once (vs = rhs, then vs 0, vs 1, ...); a renamed one gives each
    // field by its name. A path's last record is the one copied.
    typedAssignment(name: string, path: string[], rhs: Expr, entries: string[], aliases: string[], types: (Expr | undefined)[]): Expr {
        const held = this.freshName(), from: Expr = { t: "var", name: held };
        const literal = !aliases.length && rhs.t === "list" && rhs.v.length === entries.length ? rhs.v : undefined;
        const given = (n: number): Expr => literal ? literal[n]
            : aliases.length ? { t: "recordAccess", rec: from, field: aliases[n] } : { t: "app", f: from, a: { t: "int", v: BigInt(n) } };
        const target = path.reduce((rec: Expr, field): Expr => ({ t: "recordAccess", rec, field }), { t: "var", name });
        const fields: Array<[string, Expr]> = [["_", target]], declared: string[] = [];
        entries.forEach((entry, n) => {
            if (!types[n]) return;
            fields.push([entry, ascribed(given(n), types[n]!, this.freshName())]);
            declared.push(entry);
        });
        const rest = entries.flatMap((entry, n) => types[n] ? [] : [[entry, n] as const]);
        const copy: Expr = { t: "record", v: fields, declared };
        const updated: Expr = !rest.length ? copy : aliases.length
            ? { t: "setFields", rec: copy, entries: rest.map(([entry]) => entry), aliases: rest.map(([, n]) => aliases[n]), value: { t: "record", v: rest.map(([, n]): [string, Expr] => [aliases[n], given(n)]) } }
            : { t: "setFields", rec: copy, entries: rest.map(([entry]) => entry), value: { t: "list", v: rest.map(([, n]) => given(n)) } };
        const placed: Expr = path.length
            ? { t: "setFields", rec: { t: "var", name }, entries: [path[path.length - 1]], value: { t: "list", v: [updated] }, ...path.length > 1 ? { path: path.slice(0, -1) } : {} }
            : updated;
        return literal ? placed : { t: "block", style: "(", stmts: [{ t: "stmDef", name: held, clauses: [{ params: [], body: rhs }] }, placed] };
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
        this.judgePattern(pattern, bindingNeeds);
        this.expectSym("<-");
        return { t: "patDef", pattern, value: this.parseDefBody("<-"), eager: true };
    }

    isPatBinding(): boolean {
        if (!this.startsPatBinding()) return false;
        const t = this.peek();
        // A capitalized name starts a definition, whatever its parameters
        // (Vect Z a = [], Int x = x + 1); one naming a constructor where it
        // runs (Some x = m) is a pattern binding then (evalDef), which the
        // parser cannot know.
        const capitalized = t.k === "ident" && /^[A-Z]/.test(t.v) && !(this.peek(1).k === "sym" && ((this.peek(1) as { v: string }).v === "." || isConstructorOperator((this.peek(1) as { v: string }).v)));
        if (capitalized) return false;
        const save = this.i;
        try {
            const p = this.parseConsPattern();
            if (p.p === "var") return false;
            if (!this.isSym("=")) return false;
            // Name params = ... _ declares the constructor again: _ is no value
            // to take apart.
            this.next();
            return !holdsPlaceholder(this.parseExpr());
        } catch {
            return false;
        } finally {
            this.i = save;
        }
    }

    parsePatBinding(): Expr {
        const pattern = this.parseConsPattern();
        this.judgePattern(pattern, bindingNeeds);
        this.expectSym("=");
        const value = this.parseDefBody();
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
                // lone (op): the operator's own binding, as a + b applies it —  add = (+)
                if (lone) {
                    this.next(); // op
                    this.next(); // )
                    return { t: "var", name: t.v };
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
                // xs -2 = 5 gives xs -2, as f -1 passes -1: no definition of -.
                if (this.isSym("=") && !this.negated(name)) {
                    this.next();
                    // An operand is a constructor applied without them, as an
                    // application binds tighter than any operator: Some x >>= f.
                    const needed = (q: Pattern) => q.p === "cons" || q.p === "as" || negative(q);
                    this.judgePattern(left, needed);
                    this.judgePattern(right, needed);
                    return { name: name.v, clauses: [{ params: [left, right], body: this.parseDefBody("=") }] };
                }
            }
        } catch { /* not an operator definition */ }
        this.i = save;
        return null;
    }

    // A '-' spaced before and not after: a negated argument (f -1), not subtraction.
    negated(t: Token): boolean {
        return t.k === "sym" && t.v === "-" && this.tightMinus(t) && /\s/.test(this.source[t.pos - 1] ?? "");
    }
    notted(t: Token): boolean {
        return t.k === "sym" && t.v === "!" && this.source[t.pos + 1] !== undefined && !/\s/.test(this.source[t.pos + 1]) && /\s/.test(this.source[t.pos - 1] ?? "");
    }
    // A negative number as a definition's parameter, as an argument: f -1 = ...
    negativeLiteral(): boolean {
        return this.negated(this.peek()) && (this.peek(1).k === "int" || this.peek(1).k === "float");
    }

    // A definition's parameter reads as an argument does: a capitalized name
    // stands alone (f Int x takes the type Int, then x; f Some x the function
    // Some, then x), so a constructor applied to patterns is parenthesized,
    // f (Some x). A bare cons (len x :: xs) is an error: write len (x :: xs).
    parameter(): Pattern {
        const start = this.i, t = this.peek(), next = this.peek(1);
        if (t.k === "ident" && /^[A-Z]/.test(t.v) && !(next.k === "sym" && next.v === ".")) {
            this.next();
            return { p: "constr", tag: t.v, args: [] };
        }
        const p = this.parseConsPattern(), last = this.toks[this.i - 1];
        // A parameter is parenthesized only to apply a constructor, to write a
        // cons or an as-pattern as one, or to set an item (xs (i) = v, while
        // xs i = v defines xs): f (Some x), not f (None) or f (-1).
        this.judgePattern(p, q => q.p === "constr" && q.args.length > 0 || q.p === "cons" || q.p === "as" || q.p === "var");
        if (p.p !== "cons" || t.k === "sym" && (t.v === "(" || t.v === "{") && this.closer(start) === this.i - 1) return p;
        const text = this.source.slice(t.pos, last.pos + tokLen(last));
        throw new APNError("parse", `the parameter \`${text}\` is one pattern: write it in parentheses`, {
            pos: t.pos, len: text.length, hint: `write (${text})`,
        });
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
    // A definition's guards, after its parameters: | on the same line, or on
    // each line of the indented block that follows.
    // (A guard's line has its = and body: a union, Int | String, has none.)
    guardsFollow(): boolean {
        const [a, b, c] = [this.peek(), this.peek(1), this.peek(2)];
        const at = a.k === "sym" && a.v === "|" ? this.i : a.k === "newline" && b.k === "indent" && c.k === "sym" && c.v === "|" ? this.i + 2 : -1;
        if (at < 0) return false;
        for (let j = at + 1, depth = 0; j < this.toks.length; j++) {
            const t = this.toks[j];
            if (t.k === "eof" || !depth && (t.k === "newline" || t.k === "indent" || t.k === "dedent")) return false;
            if (t.k !== "sym") continue;
            if (["(", "[", "{"].includes(t.v)) depth++;
            else if ([")", "]", "}"].includes(t.v)) { if (!depth--) return false; }
            else if (!depth && t.v === "=") return true;
        }
        return false;
    }
    guardedClauses(params: Pattern[]): DefClause[] {
        const block = !this.isSym("|");
        if (block) { this.next(); this.next(); }
        const clauses: DefClause[] = [];
        const outerIndent = this.statementIndent, level = this.lineIndent(this.peek());
        // Each guard's line is a statement's: a deeper line continues its body,
        // one at its level starts the next guard.
        if (block) this.statementIndent = level;
        try {
            for (;;) {
                this.expectSym("|");
                let guard: Expr;
                this.noLambda++;
                try { guard = this.parsePipe(); } finally { this.noLambda--; }
                const equals = this.next() as { v: string };
                if (equals.v !== "=") { this.seen = equals as Token; throw new Error("Parser: a guard is followed by = and the clause's body (| x > 0 = ...)"); }
                clauses.push({ params, guard, body: this.parseDefBody("=") });
                if (!block) return clauses;
                // The next guard: past the line breaks (and the ends of any lines
                // continuing this body) to a | at the guards' level.
                let j = this.i;
                while (this.toks[j] && (this.toks[j].k === "newline" || this.toks[j].k === "dedent")) j++;
                const next = this.toks[j];
                if (next?.k === "sym" && next.v === "|" && this.lineIndent(next) === level) { this.i = j; continue; }
                if (next && next.k !== "eof" && this.lineIndent(next) >= level) { this.seen = next; throw new Error("Parser: each line of a definition's guards starts with |"); }
                break;
            }
        } finally { this.statementIndent = outerIndent; }
        // The block's end is the statement's, as a continued line's is.
        return clauses;
    }
    isDef(): boolean {
        const save = this.i;
        try {
            const t = this.next(); // definition name
            if (t.k !== "ident") return false;
            // collect param patterns; a param must be a self-delimited pattern
            while (this.startsParam(this.peek()) || this.negativeLiteral()) this.parseConsPattern();
            // f x : T = e: the type of f x, then its definition.
            if (this.eatSym(":")) this.i = this.typeEnd("statement").end;
            return this.isSym("=") || this.isSym(":=") || this.guardsFollow();
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
        // xs (i) = v is not the definition xs i = v.
        const group = this.groups.get(left.a);
        if (group !== undefined) this.unnecessary.delete(group);
        this.expectSym("=");
        const value = this.parseDefBody();
        return { t: "patDef", pattern: { p: "var", name: left.f.name },
            value: { t: "setItem", rec: left.f, index: left.a, value } };
    }

    // [f x, g y] = [e1, e2]: one definition per pair, as f x = e1 and
    // g y = e2 (each body in its own parameters' scope). A list of names
    // alone is a destructuring binding instead.
    pairedDefs(): { name: string; clauses: DefClause[] }[] | undefined {
        if (!this.isSym("[")) return undefined;
        const save = this.i;
        const heads: { name: string; params: Pattern[] }[] = [];
        try {
            this.next();
            this.skipListLeading();
            while (!this.isSym("]")) {
                const t = this.next();
                if (t.k !== "ident" || !/^[a-z_]/.test(t.v)) throw new Error("not a head");
                const params: Pattern[] = [];
                while (this.startsParam(this.peek()) || this.negativeLiteral()) params.push(this.parameter());
                heads.push({ name: t.v, params });
                this.skipListSeparators();
            }
            this.next();
            if (!heads.some(h => h.params.length) || !this.isSym("=")) throw new Error("not paired");
        } catch { this.i = save; return undefined; }
        this.next();
        const at = this.peek(), value = this.parseDefBody();
        if (value.t !== "list" || value.v.length !== heads.length) {
            throw new APNError("parse", `[${heads.map(h => h.name).join(", ")}] = ... defines each by its own item: write a list of ${heads.length} bodies`, {
                pos: at.pos, hint: "[f x, g y] = [x + 1, y * 2] is f x = x + 1 and g y = y * 2" });
        }
        return heads.map((h, n) => ({ name: h.name, clauses: [{ params: h.params, body: value.v[n] }] }));
    }

    // A definition inside a `{ }` block (a statement, not a value expression).
    parseBlockDef(): Extract<Expr, { t: "stmDef" }> {
        const d = this.typedClauses(this.parseDefStatement());
        return { t: "stmDef", name: d.name, clauses: d.clauses };
    }
    // name params : T = body, T the type of name params: its body ascribed.
    typedClauses(d: { name: string; clauses: DefClause[]; result?: Expr }): { name: string; clauses: DefClause[] } {
        return d.result ? { name: d.name, clauses: d.clauses.map(c => ({ ...c, body: ascribed(c.body, d.result!, this.freshName()) })) } : d;
    }
    // A definition, name params [: T] = body, of any name. A capitalized one
    // whose body holds _ declares a constructor (into T, if given), its rules
    // the clauses just before it (see rulesBefore); any other is a clause.
    parseDefinition(pos: number, before: Array<TopLevel | Expr>): { type: DataDef } | { def: { name: string; clauses: DefClause[] } } {
        const d = this.parseDefStatement(), [clause] = d.clauses;
        if (holdsPlaceholder(clause.body)) {
            const logic = clause.body.t === "placeholder" ? undefined : clause.body;
            return { type: constructorDeclaration(d.name, clause.params, pos, logic, d.result, rulesBefore(before, d.name)).def };
        }
        return { def: this.typedClauses(d) };
    }

    // A token that can begin a definition parameter pattern.
    startsParam(t: Token): boolean {
        if (t.k === "ident") return t.v !== "_" ? true : true;
        if (t.k === "int" || t.k === "float" || t.k === "char" || t.k === "bool" || t.k === "str") return true;
        if (t.k === "kw" && (t.v === "True" || t.v === "False")) return true;
        if (t.k === "sym" && (t.v === "(" || t.v === "{" || t.v === "[")) return true;
        if (t.k === "sym" && t.v === "_") return true;
        return false;
    }

    // Lookahead: Name params : _ (or : Name params) alone, which declares
    // nothing: a type is a constructor declared into Type (Opt a : Type = _).
    isTypeAlone(): boolean {
        const word = (j: number) => { const t = this.toks[j]; return t?.k === "ident" || t?.k === "sym" ? (t as { v: string }).v : undefined; };
        const head: string[] = [];
        let j = this.i;
        if (this.toks[j]?.k !== "ident" || !/^[A-Z]/.test(word(j)!)) return false;
        for (head.push(word(j++)!); this.toks[j]?.k === "ident" && /^[a-z]/.test(word(j)!); j++) head.push(word(j)!);
        if (word(j) !== ":" || this.toks[j].k !== "sym") return false;
        j++;
        if (word(j) === "_") j++;
        else {
            for (const part of head) if (word(j++) !== part) return false;
        }
        const end = this.toks[j];
        return !end || ["newline", "dedent", "eof"].includes(end.k) || end.k === "sym" && end.v === ";";
    }
    typeAloneError(): APNError {
        const at = this.peek(), head: string[] = [];
        for (let j = this.i; this.toks[j]?.k === "ident"; j++) head.push((this.toks[j] as { v: string }).v);
        return new APNError("parse", "a type is declared into Type", { pos: at.pos, hint: `${head.join(" ")} : Type = _` });
    }
    // A constructor declared into a type (Square (x : Float) : Shape = _)
    // joins that type's declaration earlier in the same statements; the run
    // and the checker add it to one declared elsewhere (see extendedDeclaration).
    declareInto<S extends TopLevel | Expr>(statements: S[], def: DataDef, wrap: (def: DataDef) => S): void {
        const at = def.extends ? statements.findIndex(s => (s.t === "type" || s.t === "typeDef") && s.def.name === def.name) : -1;
        if (at < 0) { statements.push(wrap(def)); return; }
        const existing = statements[at] as { def: DataDef };
        if (existing.def.variants.some(v => def.variants.some(w => w.tag === v.tag))) throw new APNError("parse", `${def.variants[0].tag} is already a constructor of ${def.name}`);
        existing.def = { ...extendedDeclaration(existing.def, def), extends: existing.def.extends };
    }

    // Parse  name p1 p2 = body  (isDef() must already have returned true).
    parseDefStatement(): { name: string; clauses: DefClause[]; result?: Expr } {
        const name = (this.next() as { v: string }).v;
        const params: Pattern[] = [];
        // Haskell-style params are PATTERNS:  f [x, y] = ..., f (x :: rest) = ...
        while (this.startsParam(this.peek()) || this.negativeLiteral()) params.push(this.parameter());
        // f x : T = e: T is the type of f x, what its = gives, as x : T = v
        // is v's (f x : Int -> Int = ... gives a function).
        const result = this.eatSym(":") ? this.typeExpr(this.typeEnd("statement").end) : undefined;
        // f x | guard = body, or f x [: T] with a line for each | guard = body:
        // clauses of the same parameters (and type), tried as written.
        if (this.guardsFollow()) return { name, clauses: this.guardedClauses(params), result };
        const equals = this.next() as { v: string; pos: number };
        if (equals.v === ":=") {
            throw new APNError("parse", "APN defines with =, not :=", { pos: equals.pos,
                hint: `${name} = Int names a type; ${name} (Int x) = _ declares a new one` });
        }
        let body = this.parseDefBody(equals.v);
        if (result) return { name, clauses: [{ params, body }], result };
        // f = Int x -> ... is the curried spelling of f (Int x) = ...: the
        // same clause, so another one overloads it the same way.
        let guard: Expr | undefined;
        const lambda = !params.length && /^[a-z]/.test(name) ? curried(name, body) : undefined;
        // f = (x -> e) binds a value where f = x -> e is a clause: its parentheses count.
        const group = this.groups.get(body);
        if (!params.length && /^[a-z]/.test(name) && group !== undefined && isLambda((body as Extract<Expr, { t: "block" }>).stmts[0])) this.unnecessary.set(group, false);
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
        const refined = operator === "=" ? this.refinement() : undefined;
        if (refined) return refined;
        const body = this.parseExpr();
        // X = (A | B) is the union of A and B; without its parentheses the
        // statement declares constructors (see isTypeDeclaration): they're needed.
        const group = this.groups.get(body);
        if (group !== undefined && (body as Extract<Expr, { t: "block" }>).stmts[0]?.t === "binop" && ((body as Extract<Expr, { t: "block" }>).stmts[0] as Extract<Expr, { t: "binop" }>).op === "|") this.unnecessary.set(group, false);
        // x = e : T, outermost.
        if (operator === "=" && this.isSym(":")) return this.ascription(body, this.next(), "statement");
        return body;
    }

    // A refinement type, X = (p : T) | condition: the values of T matching p
    // for which the condition holds, as a guarded clause's parameter accepts
    // them. It is refine T (v -> v ~ [(p : T) -> condition, _ -> False]).
    refinement(): Expr | undefined {
        if (!this.isSym("(")) return undefined;
        const start = this.i;
        let pattern: Pattern, type: Expr;
        try {
            this.next();
            const p = this.parseConsPattern();
            if (!this.eatSym(":")) throw new Error("no type");
            type = this.typeExpr(this.typeEnd("group").end);
            this.expectSym(")");
            if (!this.isSym("|")) throw new Error("no condition");
            pattern = typedPattern(p, type);
        } catch { this.i = start; return undefined; }
        this.next();
        // Its condition is a guard's, which no lambda continues: followed by
        // ->, the whole is a guarded lambda ((p : T) | condition -> body).
        let condition: Expr;
        this.noLambda++;
        try { condition = this.parsePipe(); } finally { this.noLambda--; }
        if (this.isSym("->")) { this.i = start; return undefined; }
        const value = this.freshName();
        const intrinsic = (field: string): Expr => ({ t: "recordAccess", rec: { t: "var", name: "intrinsics" }, field });
        const arms: Expr = { t: "list", v: [
            { t: "patternLambda", params: [pattern], body: condition },
            { t: "patternLambda", params: [{ p: "wildcard" }], body: { t: "bool", v: false } },
        ] };
        const test: Expr = { t: "lambda", params: [value], body: { t: "app", f: { t: "app", f: { t: "var", name: "~" }, a: { t: "var", name: value } }, a: arms } };
        return { t: "app", f: { t: "app", f: intrinsic("refine"), a: type }, a: test };
    }

    // ---- Declarations and ascription (name : T, e : T, (p : T)) ----
    // A declaration's or an ascription's type ends at the end of its statement
    // (or its value's =), or at its group's ). Its top-level arrows split it.
    typeEnd(until: "statement" | "group" | "item"): { end: number; arrows: number[] } {
        const arrows: number[] = [];
        let depth = 0;
        for (let j = this.i; ; j++) {
            const t = this.toks[j];
            if (!t || t.k === "eof" || t.k === "dedent") return { end: j, arrows };
            if (t.k === "newline" && !depth && until !== "group") return { end: j, arrows };
            if (t.k !== "sym") continue;
            if (["(", "[", "{"].includes(t.v)) { depth++; continue; }
            if ([")", "]", "}"].includes(t.v)) { if (!depth) return { end: j, arrows }; depth--; continue; }
            if (depth) continue;
            if (t.v === "->") arrows.push(j);
            else if (t.v === ";" || t.v === "=" && until !== "group" || t.v === ":" && until === "group" || t.v === "," && until === "item") return { end: j, arrows };
        }
    }
    // The type written between this.i and end, read as an expression is (a
    // lambda reads as the function type it spells out); this.i moves to end.
    typeExpr(end: number): Expr {
        if (end === this.i) throw new Error("Parser: expected a type after ':'");
        const last = this.toks[end - 1];
        const sub = new Parser([...this.toks.slice(this.i, end), { k: "eof", pos: last.pos + tokLen(last) } as Token], this.source, this.file);
        let type: Expr;
        // A refinement is a type anywhere one is written ((n : Int) | n > 0),
        // as on a declaration's right side.
        try { type = sub.refinement() ?? sub.parseExpr(); } catch (error) { this.seen = sub.seen; throw error; }
        if (sub.peek().k !== "eof") { this.seen = sub.peek(); throw new Error("Parser: unexpected token in a type"); }
        this.i = end;
        return typeOperators(type);
    }
    // e : T, after its ':'. A ternary is ascribed in parentheses.
    ascription(e: Expr, colon: Token, until: "statement" | "group"): Expr {
        if (e.t === "ternary") { this.seen = colon; throw new Error("Parser: parenthesize a ternary to ascribe it: (c ? a : b) : T"); }
        // Parentheses around what is ascribed are needed: (c ? a : b) : T.
        const group = this.groups.get(e);
        if (group !== undefined) { this.groups.delete(e); this.unnecessary.set(group, false); }
        const type = this.typeExpr(this.typeEnd(until).end), list = bareType(type);
        // A list of values is no type: 1 : [2] is cons written ':'.
        if (list.t === "list" && list.v.some(x => ["int", "float", "numeric", "string", "char", "bool"].includes(bareType(x as Expr).t))) {
            this.seen = colon;
            throw new Error("Parser: cons is '::' (x :: xs); ': T' ascribes a type");
        }
        return ascribed(e, type, this.freshName());
    }
    // name : T at the start of a statement.
    // A group's first statement that runs to its end, (x : T) or (f x : T), is
    // an ascription instead.
    isDeclaration(grouped = false): boolean {
        const name = this.peek(), colon = this.peek(1);
        if (name.k !== "ident" || !/^[a-z_]/.test(name.v)) return false;
        // x : T = v is a definition (isDef); x : T alone declares.
        if (colon.k === "sym" && colon.v === ":") return (!grouped || !this.ascribesGroup()) && !this.isDef();
        // f x : T = e types f x, a definition (see isDef); without = it
        // declares nothing.
        let depth = 0;
        for (let j = this.i + 1; ; j++) {
            const t = this.toks[j];
            if (!t || t.k === "eof" || t.k === "newline" || t.k === "dedent") return false;
            if (t.k !== "sym") continue;
            if (["(", "[", "{"].includes(t.v)) depth++;
            else if ([")", "]", "}"].includes(t.v)) { if (!depth--) return false; }
            else if (!depth && ["=", "?", ";", "<-", "->"].includes(t.v)) return false;
            else if (!depth && t.v === ":") {
                if (grouped || this.isDef()) return false;
                this.seen = t;
                throw new Error(`Parser: ${name.v} with parameters is typed in its definition (${name.v} x : T = ...), or on a line of its own: ${name.v} : A -> B`);
            }
        }
    }
    // A record's field declared with its type, x : T, or x : T = default.
    isFieldDeclaration(): boolean {
        const name = this.peek(), colon = this.peek(1);
        return name.k === "ident" && colon.k === "sym" && colon.v === ":";
    }
    parseFieldDeclaration(): Expr {
        const name = (this.next() as Extract<Token, { k: "ident" }>).v;
        this.next();
        const type = this.typeExpr(this.typeEnd("item").end);
        const value = this.eatSym("=") ? ascribed(this.parseDelimitedExpr(), type, this.freshName()) : type;
        const field: Expr = { t: "stmDef", name, clauses: [{ params: [], body: value }] };
        declaredFields.add(field);
        return field;
    }
    // (name : T), the type running to the group's end.
    ascribesGroup(): boolean {
        const save = this.i;
        this.i += 2;
        try { const end = this.toks[this.typeEnd("group").end]; return end?.k === "sym" && end.v === ")"; }
        finally { this.i = save; }
    }
    // name : T declares the definition after it; name : T = value is both.
    // A declaration alone stays a marker until applyDeclarations meets the
    // definition it declares.
    parseDeclaration(): Extract<TopLevel, { t: "def" | "expr" }> {
        const nameToken = this.next() as Extract<Token, { k: "ident" }>, name = nameToken.v;
        this.next();
        const start = this.i, { end, arrows } = this.typeEnd("statement");
        const pieces = [start, ...arrows.map(a => a + 1)].map((from, n) => {
            this.i = from;
            return this.typeExpr(n < arrows.length ? arrows[n] : end);
        });
        const marker: Extract<TopLevel, { t: "expr" }> = { t: "expr", value: { t: "placeholder" } };
        // The function type after the first k pieces, for a clause with k parameters.
        const rest = (k: number): Expr => {
            const at = this.i;
            this.i = k ? arrows[k - 1] + 1 : start;
            try { return this.typeExpr(end); } finally { this.i = at; }
        };
        // (A block keeps the marker's value as its statement.)
        const declaration = { name, pos: nameToken.pos, pieces, rest, marker };
        this.declarations.set(marker, declaration);
        this.declarations.set(marker.value, declaration);
        return marker;
    }
    declarations = new WeakMap<object, { name: string; pos: number; pieces: Expr[]; rest: (k: number) => Expr; marker: object }>();
    // Each declaration types the clauses of the definition right after it:
    // its parameters' types are typed patterns, and its result type the
    // claim of each clause's body (a function type, when fewer parameters
    // are written than the type takes, ascribes the body instead).
    applyDeclarations(items: (TopLevel | Expr)[]): void {
        for (let n = 0; n < items.length; n++) {
            const declaration = this.declarations.get(items[n]);
            if (!declaration) continue;
            const { name, pos, pieces } = declaration, arity = pieces.length - 1;
            const defines = (item: TopLevel | Expr | undefined): item is Extract<TopLevel, { t: "def" }> | Extract<Expr, { t: "stmDef" }> =>
                !!item && (item.t === "def" || item.t === "stmDef") && item.name === name;
            // Alone, it defines the name as its type's zero, as a record slot
            // does: x : Int is x = ([] : [x : Int]).x.
            if (!defines(items[n + 1])) {
                const type = declaration.rest(0);
                const slots: Expr = { t: "record", v: [[name, type]], items: [{ t: "stmDef", name, clauses: [{ params: [], body: type }] }], declared: [name] };
                const zero: Expr = { t: "recordAccess", rec: { t: "app", f: slots, a: { t: "list", v: [] }, ascribed: true }, field: name, argument: { t: "var", name } };
                const def = { name, clauses: [{ params: [], body: zero }] };
                items[n] = items[n] === declaration.marker ? { t: "def", ...def } : { t: "stmDef", ...def } as Expr;
                continue;
            }
            items.splice(n, 1);
            for (let m = n; defines(items[m]); m++) {
                const item = items[m] as Extract<TopLevel, { t: "def" }>;
                item.clauses = item.clauses.map(clause => {
                    const k = clause.params.length;
                    if (k > arity) throw new APNError("parse", `${name} is declared with ${arity} parameter${arity === 1 ? "" : "s"}, but a clause takes ${k}`, { pos, len: name.length });
                    const params = clause.params.map((p, i) => typedPattern(p, pieces[i]));
                    const result = k === arity ? pieces[arity] : declaration.rest(k);
                    // A result naming a type variable no parameter binds, or _
                    // (any), is checked by inference, not by a claim the clause
                    // can read.
                    const bound = new Set(params.flatMap(typedNames));
                    const free = freeLowercase(result).filter(x => !bound.has(x));
                    const body = k < arity || isFunctionType(result) ? ascribed(clause.body, result, this.freshName())
                        : free.length || result.t === "placeholder" ? clause.body : { t: "app" as const, f: result, a: clause.body, ascribed: true as const };
                    return { ...clause, params, body };
                });
            }
        }
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
            } else if (vt.k === "sym" && vt.v === "[") {
                // [Int,Int] is Int :: Int :: [], as a list is.
                let list: Expr;
                this.noLambda++;
                try { list = this.parsePrimary(); } finally { this.noLambda--; }
                if (list.t !== "list" || list.v.some(item => ["stmDef", "patDef", "typeDef"].includes(item.t))) throw new Error("Parser: a list type's alternative lists its elements' types: [Int,String]");
                const [first, ...rest] = list.v;
                fields.push(first, rest.reduceRight<Expr>((tail, item) => ({ t: "binop", op: "::", l: item, r: tail }), { t: "list", v: [] }));
                tag = "::";
            } else if (vt.k === "ident" && /^[A-Z]/.test(vt.v)) {
                this.next();
                tag = vt.v;
                // A field is a type: a name (module.Type too), a group or a list.
                while (this.peek().k === "ident" || this.isSym("(") || this.isSym("{") || this.isSym("[")) {
                    this.noLambda++;
                    try { fields.push(this.parsePostfix(this.parsePrimary())); } finally { this.noLambda--; }
                }
                // Int :: Ints: a list type whose first element is that type.
                if (this.isSym("::")) {
                    const element = fields.splice(0).reduce<Expr>((f, a) => ({ t: "app", f, a }), { t: "var", name: tag });
                    this.next();
                    this.noLambda++;
                    try {
                        const items = [this.parseApp()];
                        while (this.eatSym("::")) items.push(this.parseApp());
                        fields.push(element, items.reduceRight((rest, item) => ({ t: "binop", op: "::", l: item, r: rest })));
                    } finally { this.noLambda--; }
                    tag = "::";
                }
            } else {
                if (!(vt.k === "ident" && /^[a-z]/.test(vt.v) || vt.k === "sym" && vt.v === "(")) throw new Error("Parser: expected a constructor: a capitalized name, [] or x :: rest");
                this.noLambda++;
                try {
                    fields.push(this.parsePrimary());
                    if (!this.isSym("::")) throw new Error("Parser: expected a constructor: a capitalized name, [] or x :: rest");
                    this.next();
                    // The rest may hold more elements first (a :: a :: Pairs k a).
                    const items = [this.parseApp()];
                    while (this.eatSym("::")) items.push(this.parseApp());
                    fields.push(items.reduceRight((rest, item) => ({ t: "binop", op: "::", l: item, r: rest })));
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
        // A family of lists is a type function's clauses (see listClauses);
        // the list's own constructors are not declared again.
        // A union of them alone (List a = [] | a :: List a) is a type of lists.
        const listed = variants.filter(v => v.tag === "[]" || v.tag === "::");
        if (listed.length && (listed.length < variants.length || listed.some(v => !v.result) && listed.some(v => v.result))) {
            throw new Error(`Parser: a family of lists has only [] and x :: rest, each saying its index: ${name} n a = [] -> ${name} Z a | a :: ${name} k a -> ${name} (S k) a`);
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
        // A family of lists, or a union of list types, starts with [], a
        // written list or x :: rest.
        const listed = ctor.k === "sym" && ctor.v === "[" ||
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

    // A type declaration (Color = Red | Green, Vec n a = ...), at the top level
    // or in a block.
    parseTypeDeclaration(): TopLevel[] {
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
        // A union of list types (Pairs a = [] | a :: a :: Pairs a) is a union;
        // a family of lists, its type function's clauses (see listClauses).
        if (variants.some(v => v.tag === "[]" || v.tag === "::")) return [{ t: "type", def: { name, parameters, variants } }];
        if (new Set(variants.map(v => v.tag)).size !== variants.length) throw new Error("Parser: duplicate value constructor");
        return [{ t: "type", def: { name, parameters, variants } }];
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
            if (this.isTypeAlone()) throw this.typeAloneError();
            if (this.isDeclaration()) {
                out.push(this.parseDeclaration());
                continue;
            }
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
                out.push(...this.parseTypeDeclaration());
                continue;
            }

            if (t.k === "kw") {
                if (this.isPatBinding()) { out.push(this.parsePatBinding() as TopLevel); continue; }
                // Keyword-led expressions still include trailing operators and pipes.
                out.push({ t: "expr", value: this.parseExpr() });
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
                if (this.isDef()) {
                    const made = this.parseDefinition(t.pos, out);
                    if ("type" in made) this.declareInto(out, made.type, def => ({ t: "type", def }));
                    else out.push({ t: "def", ...made.def });
                } else if (/^[A-Z]/.test(t.v)) {
                    out.push({ t: "expr", value: this.parseExpr() });
                } else {
                    const assignment = this.tryItemAssign();
                    if (assignment) out.push(assignment as TopLevel);
                    else out.push({ t: "expr", value: this.parseExpr() });
                }
                continue;
            }

            if (t.k === "sym") {
                const paired = this.pairedDefs();
                if (paired) for (const d of paired) out.push({ t: "def", ...d });
                else if (this.isPatBinding()) {
                    out.push(this.parsePatBinding() as TopLevel);
                } else {
                    out.push({ t: "expr", value: this.parseExpr() });
                }
                continue;
            }

            if (t.k === "int" || t.k === "float" || t.k === "bool" ||
                    t.k === "str" || t.k === "char") {
                if (this.isPatBinding()) { out.push(this.parsePatBinding() as TopLevel); continue; }
                out.push({ t: "expr", value: this.parseExpr() });
                continue;
            }

            throw new Error(`Parser: unexpected '${this.tokenStr(t)}'`);
        }
        return out;
    }
}

// Name params = _ declares a constructor: its applications stand for nothing
// but themselves, so each is a value (Box 5), with one field per parameter. A
// name holds anything (a type parameter); a typed name converts its field, as a
// typed parameter does ((w : Float)), and a record of typed fields is a field
// of that record's type ([x : Int, y : Int]). It is the declaration
// Name a = | Name a is.
//
// Name params : T = _ declares it into the type T (Circle (r : Float) : Shape
// = _), whose parameters are T's names (Some a : Option a = _); T naming a
// computed index makes it an indexed family's (Cons a (Vect k a) : Vect (S k)
// a = _, whose result is that type). Without one, T is Name params itself.
function constructorDeclaration(name: string, params: Pattern[], pos: number, body?: Expr, owner?: Expr, rules: DefClause[] = []): Extract<TopLevel, { t: "type" }> {
    // Declared into Type, its applications are types: Opt a : Type = _ is the
    // type Opt, its constructors declared into it (Some x : Opt x = _).
    if (owner?.t === "var" && owner.name === "Type" && name !== "Type") {
        if (body || rules.length) throw new APNError("parse", "a type declared into Type has no logic", { pos, hint: `${name} ... : Type = _` });
        const parameters = params.map(p => {
            if (p.p !== "var") throw new APNError("parse", "a type's parameters are names", { pos, hint: `${name} a : Type = _` });
            return p.name;
        });
        if (new Set(parameters).size !== parameters.length) throw new APNError("parse", "a type's parameters are distinct names", { pos });
        return { t: "type", def: { name, parameters, variants: [] } };
    }
    if (rules.some(r => r.params.length !== params.length)) throw new APNError("parse", `every clause of ${name} takes ${params.length} parameters, as its declaration`, { pos });
    const parameters: string[] = [], names: string[] = [];
    const typeOf = (p: Pattern): Expr | undefined => p.p === "var" ? { t: "var", name: p.name }
        : p.p === "int" ? { t: "int", v: p.v }
        : p.p === "constr" ? p.args.reduce<Expr | undefined>((f, a) => { const x = typeOf(a); return f && x && { t: "app", f, a: x }; }, { t: "var", name: p.tag })
        : undefined;
    const fields = params.map(p => {
        if (p.p === "var") { parameters.push(p.name); names.push(p.name); return typeOf(p)!; }
        const [type, named] = p.p === "schema" ? [p.type, p.value] : p.p === "typeBind" ? [{ t: "var" as const, name: p.name }, p.value] : p.p === "constr" && p.typed && p.args.length ? [typeOf({ ...p, args: p.args.slice(0, -1) }), p.args[p.args.length - 1]] : [];
        if (!type || !named || named.p !== "var" && named.p !== "wildcard" && !(named.p === "recPat" && p.p === "schema" && p.type.t === "record")) {
            throw new APNError("parse", "a constructor's field is a name, a typed name or a record of typed fields", { pos, hint: `${name} (x : Float) = _` });
        }
        if (named.p === "var") names.push(named.name);
        else if (body || rules.length) throw new APNError("parse", "a constructor with logic names each field, which its _ holds", { pos, hint: `${name} (x : Float) = ... _` });
        return type;
    });
    if (new Set(names).size !== names.length) throw new APNError("parse", "a constructor's field names are distinct", { pos });
    // Its logic's _ is the raw value: intrinsics.tag Name Name [fields].
    const tagged = { t: "var" as const, name };
    const tag: Expr = { t: "recordAccess", rec: { t: "var", name: "intrinsics" }, field: "tag" };
    const raw: Expr = { t: "app", f: { t: "app", f: { t: "app", f: tag, a: tagged }, a: { t: "var", name } }, a: { t: "list", v: names.map(n => ({ t: "var", name: n })) } };
    const into = owner && ownerType(name, owner, pos);
    if (into) tagged.name = into.name;
    // With rules, the declaring clause is the otherwise: plain names, the
    // least specific, given to it as written (Frac n 0 = ... before Frac
    // (n : Int) (d : Int) = _ takes Frac 1 0).
    const declared: Expr = body ? fillPlaceholders(body, raw) : raw;
    const own = params.map((_, n): Pattern => ({ p: "var", name: `$field${n}` }));
    const otherwise = { params: own, body: own.reduce<Expr>((f, p) => ({ t: "app", f, a: { t: "var", name: (p as { name: string }).name } }), { t: "patternLambda", params, body: declared }) };
    const logic = body || rules.length ? { clauses: rules.length ? [...rules, otherwise] : [{ params, body: declared }], owner: tagged } : undefined;
    const variant = { tag: name, arity: fields.length, fields, ...into?.result ? { result: into.result } : {}, ...logic ? { logic } : {} };
    if (!into) return { t: "type", def: { name, parameters, variants: [variant] } };
    return { t: "type", def: { name: into.name, parameters: into.parameters, variants: [variant], extends: true } };
}

// The type a constructor is declared into: its name and parameters, and the
// result the constructor makes when that names a computed index. The
// constructor's own type (Box x : Box x) is no other.
function ownerType(tag: string, owner: Expr, pos: number): { name: string; parameters: string[]; result?: Expr } | undefined {
    // Without : T a constructor is its own type: : _ would say it twice.
    if (owner.t === "placeholder") throw new APNError("parse", "a constructor is its own type without : T", { pos, hint: `${tag} ... = _, or ${tag} ... : Type = _ for a type` });
    const args: Expr[] = [];
    let head: Expr = owner;
    while (head.t === "app") { args.unshift(head.a); head = head.f; }
    if (head.t !== "var" || !/^[A-Z]/.test(head.name)) throw new APNError("parse", "a constructor is declared into a type by its name", { pos, hint: `${tag} (x : Float) : Shape = _` });
    const plain = args.every((a, n) => a.t === "var" && /^[a-z]/.test(a.name) && args.findIndex(b => b.t === "var" && b.name === a.name) === n);
    if (head.name === tag) {
        if (!plain) throw new APNError("parse", `${tag} is its own type: declare it into another for a computed index`, { pos });
        return undefined;
    }
    const parameters = args.map((a, n) => plain && a.t === "var" ? a.name : `t${n}`);
    return { name: head.name, parameters, ...plain ? {} : { result: owner } };
}

// The clauses of name written just before its declaration with _ (Add x Zero
// = x before Add x y = _): its rules, taken from the statements.
function rulesBefore(statements: Array<TopLevel | Expr>, name: string): DefClause[] {
    const rules: DefClause[] = [];
    for (let last = statements[statements.length - 1]; last && (last.t === "def" || last.t === "stmDef") && last.name === name; last = statements[statements.length - 1]) {
        rules.unshift(...last.clauses);
        statements.pop();
    }
    return rules;
}

// A block's statement, joined to the definition before it when it continues
// it (see continues).
function joinClauses<T extends { t: string }>(statements: T[], definition: T & { name: string; clauses: DefClause[] }): void {
    const last = statements[statements.length - 1] as unknown as { t: string; name: string; clauses: DefClause[] } | undefined;
    if (last?.t === definition.t && continues(last, definition)) last.clauses.push(...definition.clauses);
    else statements.push(definition);
}

// A document parses alone: whether `Some v = ...` binds or defines, and what
// (x : T) reads as, are decided where they run (evalDef, knownTypeArguments,
// rewriteTypedPatterns), so no declaration carries from one parse to the next.
export const parseDocument = parse;

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
// Whether programs run and are checked with the prelude (apn --no-prelude:
// without it, only the intrinsics and what a program defines).
let preludeUsed = true;
export function setPreludeUsed(used: boolean): void { preludeUsed = used; }
export function getPreludeUsed(): boolean { return preludeUsed; }

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
    const outerFixities = fileFixities;
    fileFixities = new Map();
    try {
        declareFixities(toks, fileFixities);
        p.checkColons();
        if (!looseSpacing) p.checkBracketSpacing();
        const out = p.parseTopLevel();
        p.applyDeclarations(out);
        if (!looseSpacing) p.reportUnnecessary();
        const grouped = groupClauses(out);
        rejectOldSpellings(grouped);
        if (fileFixities.size) programFixities.set(grouped, fileFixities);
        return grouped;
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
    } finally { fileFixities = outerFixities; }
}

// Consecutive Haskell-style clauses of the same function are one definition:
//   len [] = 0
//   len (x :: rest) = 1 + len rest
// Only same-name defs that carry parameters with equal arity are grouped;
// value defs stay separate
// (consecutive re-bindings still behave as last-wins aliases).
function continues(last: { name: string; clauses: DefClause[] }, next: { name: string; clauses: DefClause[] }): boolean {
    const [a, b] = [last.clauses[0], next.clauses[0]];
    return last.name === next.name && !!b?.params.length && a.params.length === b.params.length;
}
// What a type written in parentheses is: (a -> b) is a -> b.
function bareType(type: Expr): Expr {
    return type.t === "block" && type.style === "(" && type.stmts.length === 1 ? bareType(type.stmts[0] as Expr) : type;
}
function isFunctionType(type: Expr): boolean {
    const t = bareType(type);
    return t.t === "lambda" || t.t === "patternLambda";
}
// A record's fields as they were written: x = 1, x : T, x : T = 1, use base,
// f x = ...
function recordFieldsSource(e: Extract<Expr, { t: "record" }>, of: (x: Expr) => string): string[] {
    const declared = new Set(e.declared);
    return e.v.map(([key, x]) => {
        if (key === "_") return `use ${of(x)}`;
        if (x.t === "block" && x.stmts.length === 2 && x.stmts[0].t === "stmDef" && x.stmts[0].name === key) return of(x.stmts[0] as Expr);
        if (!declared.has(key)) return fieldSource(key, of(x));
        const typed = x.t === "app" && x.ascribed ? x : undefined;
        return typed ? `${fieldSource(key, of(typed.f), true)} = ${of(typed.a)}` : fieldSource(key, of(x), true);
    });
}
// The item code.x = v puts in place of the item binding x: x = v (a field
// assignment's value is the list of its fields' values; one field's is its
// only item).
export function bindingItem(name: string, value: Expr): Expr {
    const body: Expr = value.t === "list" && value.v.length === 1 ? value.v[0] : { t: "app", f: value, a: { t: "int", v: 0n } };
    return { t: "stmDef", name, clauses: [{ params: [], body }] };
}
// A list whose items are all fields is a record: [x = 1, y = x + 1] (each
// field in scope for those after it), [x : Float, y : Float = 1.0] (a declared
// field holds its type, or its default as one), [use base, x = 1] (a spread).
const declaredFields = new WeakSet<Expr>();
function recordOf(items: Expr[]): Expr | undefined {
    if (!items.length) return undefined;
    const fields: Array<[string, Expr]> = [], declared = new Set<string>();
    for (const item of items) {
        if (item.t === "app" && item.f.t === "var" && item.f.name === "use") { fields.push(["_", item.a]); continue; }
        if (item.t !== "stmDef") return undefined;
        const [clause] = item.clauses;
        const simple = item.clauses.length === 1 && !clause.params.length;
        fields.push([item.name, simple ? clause.body : { t: "block", style: "{", stmts: [item, { t: "var", name: item.name }] }]);
        if (declaredFields.has(item)) declared.add(item.name);
    }
    return { t: "record", v: fields, items, ...declared.size ? { declared: [...declared] } : {} };
}
// e : T, marked ascribed: T makes e a member (Int 1.0 is 1), never an argument.
// A function type's value is checked as a typed parameter's: ((r : T) -> r) e.
function ascribed(e: Expr, type: Expr, fresh: string): Expr {
    if (!isFunctionType(type)) return { t: "app", f: type, a: e, ascribed: true };
    const check: Expr = { t: "patternLambda", params: [{ p: "schema", type, value: { p: "var", name: fresh } }], body: { t: "var", name: fresh } };
    return { t: "app", f: check, a: e, ascribed: true };
}
// (p : T): T's typed pattern around p; a type variable (or _) binds the type.
// (p : T) is the typed pattern the type takes: (x : t) binds its type, and
// a type's name given names, literals and types as its arguments
// (x : Vect n Int) checks and dispatches as a type pattern does; any other
// type, a constructor's name or a function type's, is a schema.
function typedPattern(p: Pattern, type: Expr): Pattern {
    const t = bareType(type);
    if (t.t === "var" && /^[a-z_]/.test(t.name)) return { p: "typeBind", name: t.name, value: p };
    if (t.t === "placeholder") return { p: "typeBind", name: "_", value: p };
    // A name applied to names, literals and types: what it is (a type, a
    // constructor, a function type) is decided where it runs (see
    // rewriteTypedPatterns).
    const named = typeArguments(t);
    if (named?.p === "constr") return { ...named, args: [...named.args, p], typed: true };
    return { p: "schema", type, value: p };
}
// The old spelling of a typed pattern, the type before the value (((T) p),
// (t x)): an error once it is part of the program (parses that try a pattern
// and give it up do not count), its type written after the value.
const oldSpellings = new WeakMap<object, number>();
function writtenTypeFirst(p: Pattern, pos: number): Pattern {
    oldSpellings.set(p, pos);
    return p;
}
function rejectOldSpellings(node: unknown): void {
    if (!node || typeof node !== "object") return;
    const pos = oldSpellings.get(node);
    if (pos !== undefined) throw new APNError("parse", "a typed pattern writes its type after the value", { pos, hint: `write ${patternSource(node as Pattern)}` });
    for (const value of Object.values(node)) rejectOldSpellings(value);
}
function typeArguments(e: Expr): Pattern | undefined {
    const t = bareType(e);
    if (t.t === "var") return t.name === "_" ? { p: "wildcard" } : /^[A-Z]/.test(t.name) ? { p: "constr", tag: t.name, args: [] } : { p: "var", name: t.name };
    if (t.t === "int") return { p: "int", v: t.v };
    if (t.t === "placeholder") return { p: "wildcard" };
    if (t.t !== "app") return undefined;
    const head = typeArguments(t.f), arg = typeArguments(t.a);
    return head?.p === "constr" && arg ? { ...head, args: [...head.args, arg] } : undefined;
}
// The names a typed parameter binds: its pattern's, and its type's
// parameters ((Vect n a) xs binds n and a; a function type binds none).
function typedNames(p: Pattern): string[] {
    if (p.p === "schema") return [...isFunctionType(p.type) ? [] : freeLowercase(p.type), ...typedNames(p.value)];
    if (p.p === "typeBind") return [p.name, ...typedNames(p.value)];
    return patternNames(p);
}
// The lowercase names a type mentions: its variables.
function freeLowercase(e: unknown, found: string[] = []): string[] {
    if (!e || typeof e !== "object") return found;
    if (Array.isArray(e)) { for (const x of e) freeLowercase(x, found); return found; }
    const node = e as { t?: string; name?: string };
    if (node.t === "var" && node.name && /^[a-z]/.test(node.name)) found.push(node.name);
    for (const value of Object.values(e)) if (value && typeof value === "object") freeLowercase(value, found);
    return found;
}

export function groupClauses(program: TopLevel[]): TopLevel[] {
    const result: TopLevel[] = [];
    for (const tl of program) {
        if (tl.t === "def") joinClauses(result, tl);
        else result.push(tl);
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

export function patternVariables(p: Pattern): string[] {
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


// Source text for an expression, with parentheses only where the parser
// needs them (the unnecessary-parentheses rule, as level and reach above
// read it): each part is written for its place, and a group in the tree is
// written as its expression.
export type Place = { kind: "operand" | "item" | "guard" | "argument" | "head" | "selected"; min: number; follows: number };
const END: Place = { kind: "operand", min: 0, follows: -1 };
const place = (kind: Place["kind"], min = 0, follows = -1): Place => ({ kind, min, follows });
const isGroup = (e: Expr): e is Extract<Expr, { t: "block" }> => e.t === "block" && e.style === "(" && e.stmts.length === 1 && !["stmDef", "patDef", "setItem", "setFields"].includes(e.stmts[0].t);
const ungrouped = (e: Expr): Expr => isGroup(e) ? ungrouped(e.stmts[0]) : e;
// How far written text reaches right: as reach, but a call's lambda argument
// is parenthesized, so a call takes in nothing.
function written(e: Expr): number {
    e = ungrouped(e);
    const binding = (op: string) => fixityOf(op).assoc === "right" ? fixityOf(op).prec : fixityOf(op).prec + 1;
    switch (e.t) {
        case "lambda": case "patternLambda": return sectionSource(e.t === "lambda" ? e.params : [], e.body, String) ? Infinity : -Infinity;
        case "ternary": return Math.min(1, written(e.els));
        case "unop": return Math.min(8, written(e.e));
        case "binop": return Math.min(binding(e.op), written(e.r));
        case "pipe": return Math.min(binding("$"), written(e.x));
        default: return Infinity;
    }
}
function fits(where: Place, e: Expr): boolean {
    const section = e.t === "lambda" && sectionSource(e.params, e.body, String) !== undefined;
    switch (where.kind) {
        case "argument": return primary(e) || section || e.t === "unop" && e.op === "neg";
        case "head": return primary(e) || section || e.t === "app";
        case "selected": return postfixHead(e) || section;
    }
    const top = e.t === "binop" ? e.op : e.t === "pipe" ? "$" : undefined;
    return level(e) >= where.min && (where.follows < 0 || where.follows < written(e)) &&
        !(isLambda(e) && !section && (where.kind === "guard" || where.kind === "item" && (e as { params: unknown[] }).params.length > 1)) &&
        !(top && fixityOf(top).assoc === "none" && fixityOf(top).prec === where.follows);
}
export function exprToSource(e: Expr, where: Place = END): string {
    e = ungrouped(e);
    return fits(where, e) ? bareSource(e, where) : `(${bareSource(e, END)})`;
}
function bareSource(e: Expr, where: Place): string {
    const of = (x: Expr, at: Place = END) => exprToSource(x, at);
    switch (e.t) {
        case "range": {
            const end = `..${e.hi === null ? "" : of(e.hi, place("operand", 6))}`;
            if (e.lo === null) return `[${end}]`;
            return `[${itemsText(e.second === null ? [of(e.lo, place("operand", 6)) + end] : [of(e.lo, place("operand", 6)), of(e.second, place("operand", 6)) + end])}]`;
        }
        case "numeric": return numberText(e.v);
        case "int": return String(e.v);
        case "float": return numberText({ kind: "float", v: e.v });
        case "bool": return e.v ? "True" : "False";
        case "string": return stringLiteral(e.v);
        case "char": return charLiteral(e.v);
        case "placeholder": return "_";
        case "var": return isOperatorName(e.name) ? `(${e.name})` : e.name;
        case "binop": return `${of(e.l, place("operand", 0, fixityOf(e.op).prec))} ${e.op} ${of(e.r, place("operand", fixityOf(e.op).assoc === "right" ? fixityOf(e.op).prec : fixityOf(e.op).prec + 1, where.follows))}`;
        case "pipe": return `${of(e.f, place("operand", 0, fixityOf("$").prec))} $ ${of(e.x, place("operand", fixityOf("$").prec, where.follows))}`;
        case "unop": {
            // -(-x) is not --x, one operator.
            const operand = ungrouped(e.e), at = where.kind === "argument" ? place("argument") : place("operand", 8, where.follows);
            return `${e.op === "neg" ? "-" : "!"}${operand.t === "unop" ? `(${of(operand)})` : of(operand, at)}`;
        }
        case "app": {
            if (e.ascribed) return `(${of(e.a)} : ${of(e.f.t === "patternLambda" && e.f.params[0].p === "schema" ? e.f.params[0].type : e.f)})`;
            const args: Expr[] = [];
            let head: Expr = e;
            for (; head.t === "app"; head = ungrouped(head.f)) args.unshift(head.a);
            return [of(head, place("head")), ...args.map(a => of(a, place("argument")))].join(" ");
        }
        case "patternLambda": return `${e.params.map(wholePatternSource).join(", ")}${e.guard ? " | " + of(e.guard, place("guard")) : ""} -> ${of(e.body)}`;
        case "lambda": return sectionSource(e.params, e.body, x => of(x, place("operand", 8))) ?? `${e.params.join(", ")} -> ${of(e.body)}`;
        case "list": return `[${itemsText(e.v.map(x => of(x, place("item"))))}]`;
        case "record": return `[${recordFieldsSource(e, x => of(x)).join(", ")}]`;
        case "ternary": {
            // A ternary inside a ternary is parenthesized: c ? (d ? 1 : 2) : 3.
            const branch = (x: Expr, at: Place) => ungrouped(x).t === "ternary" ? `(${of(ungrouped(x))})` : of(x, at);
            return `${branch(e.cond, place("operand", 0, 1))} ? ${branch(e.then, place("operand", 1))} : ${branch(e.els, place("operand", 1, where.follows))}`;
        }
        case "recordAccess": {
            // A scoped selection's brackets are its syntax: xs.(i + 1), r.{ k }.
            const argument = e.scoped && e.argument ? e.argument : undefined;
            const key = !argument ? keySource(e.field) : isGroup(argument) ? `(${of(argument)})` : of(argument);
            return `${of(e.rec, place("selected"))}.${key}`;
        }
        case "pluck":
            if (e.values) return `${of(e.rec, place("selected"))}.${of(e.values)}`;
            return `${of(e.rec, place("selected"))}.[${itemsText(e.entries.map((x) => typeof x === "string" ? keySource(x) : fieldSource(x[1], keySource(x[0]))))}]`;
        case "setItem": return `${of(e.rec, place("head"))} (${of(e.index)}) = ${of(e.value)}`;
        case "setFields":
            return `${of(e.rec, place("selected"))}.${(e.path ?? []).map(keySource).map(key => key + ".").join("")}[${itemsText(e.entries.map((key, n) => e.aliases ? fieldSource(key, keySource(e.aliases[n])) : keySource(key)))}] = ${of(e.value)}`;
        case "block": {
            const body = e.stmts.map(x => of(x)).join("; ");
            return e.style === "(" ? `(${body})` : e.stmts.length ? `{ ${body} }` : "{}";
        }
        // A binding (a block's statement or a list's item): f n = ..., [a,b] = xs.
        case "stmDef": return e.clauses.map(c => [e.name, ...c.params.map(patternSource)].join(" ") + ` = ${of(c.body)}`).join("; ");
        case "patDef":
            if (e.value.t === "setItem" || e.value.t === "setFields") return of(e.value);
            return `${wholePatternSource(e.pattern)} ${e.eager ? "<-" : "="} ${of(e.value)}`;
        default: return "<expr>";
    }
}
// A pattern standing where a whole one is read (a lambda's parameter, a
// binding, a list's item): a constructor's fields and a cons need no
// parentheses there (Some x -> x, x :: xs = ys); a typed one keeps them.
export function wholePatternSource(p: Pattern): string {
    const written = patternSource(p);
    return p.p === "cons" || p.p === "constr" && p.args.length && written.startsWith(`(${p.tag} `) ? written.slice(1, -1) : written;
}
export function patternSource(p: Pattern): string {
    // A typed pattern rewritten where it runs shows as written.
    if ((p.p === "as" || p.p === "schema") && p.written) return patternSource(p.written);
    switch (p.p) {
        case "as": return `${patternSource(p.left)}.${patternSource(p.right)}`;
        case "schema": {
            // A type spelled with an operator (Int | String, a -> a) is grouped
            // before its value's name, and stands alone for no name.
            let written = writtenOperators(p.type);
            while (written.t === "block" && written.style === "(" && written.stmts.length === 1) written = written.stmts[0];
            const type = exprToSource(written), spelled = ["binop", "lambda", "patternLambda"].includes(written.t);
            if (spelled && p.value.p === "wildcard") return `(${type})`;
            return `(${patternSource(p.value)} : ${type})`;
        }
        case "wildcard": return "_";
        case "var": return p.name;
        case "int": return String(p.v);
        case "bool": return p.v ? "True" : "False";
        case "string": return stringLiteral(p.v);
        case "char": return charLiteral(p.v);
        case "float": return numberText({ kind: "float", v: p.v });
        // An item stands alone up to its ',': [x :: _, d], [Some x, y].
        case "list": return `[${itemsText(p.v.map(wholePatternSource))}]`;
        // A cell written with a constructor's name (Cons h t) shows as written.
        case "cons": return p.op && /^[A-Z]/.test(p.op) ? `(${p.op} ${patternSource(p.head)} ${patternSource(p.tail)})` : `(${patternSource(p.head)} ${p.op ?? "::"} ${patternSource(p.tail)})`;
        // A type's pattern is written as the value it types: (xs : Vect n a).
        case "constr":
            if (!p.args.length) return p.tag;
            if (p.typed) return `(${patternSource(p.args[p.args.length - 1])} : ${[p.tag, ...p.args.slice(0, -1).map(patternSource)].join(" ")})`;
            return `(${p.tag} ${p.args.map(patternSource).join(" ")})`;
        case "typeBind": return `(${patternSource(p.value)} : ${p.name})`;
        case "recPat": return `[${p.v.map(([k, v]) => fieldSource(k, v)).join(", ")}]`;
        case "range": return `[${p.lo}..${p.hi}]`;
    }
}
