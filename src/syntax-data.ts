// APN syntax as data (toAST's lists) and back: syntaxOf reads the parser's
// nodes, syntaxSource writes data as source that reads back as the same data.
// lib/syntax.apn's fromAST and eval, and macros, use them.
import { type Expr, type Pattern, type SourceLocation, sourceLocations, type TopLevel } from "./ast.ts";
import { type Value, mkBool, mkInt, mkList, mkStr } from "./types.ts";
import { keySource } from "./record-keys.ts";
import { arithmetic, isNumeric, numberText } from "./numbers.ts";
import { charLiteral, itemsText, stringLiteral } from "./separators.ts";
import { fixityOf, getLooseSpacing, parse, setLooseSpacing } from "./parser.ts";
import { APNError } from "./errors.ts";

// An expression as data, as written: a leaf is a number, a Bool, a name or
// a literal's source text ("x", "\"x\"", "'c'"); anything else is a list,
// an application function first (["f","x"], ["+",1,2]), or headed by a
// token no name can be: ["[]",...] a list, ["[:]",[key,value]...] a record,
// ["->",[params],body], ["?:",c,a,b], [".",r,key], ["{}",...] a block,
// ["..",low,high,next], ["=",left,right], ["<-",left,right], ["()","+",x]
// the section (+ x), ["import",...]. A pattern is written as an expression.
export function syntaxOf(e: Expr): Value {
    const of = syntaxOf;
    const node = (...items: Value[]) => mkList(items);
    const text = (t: string) => mkStr(t);
    const pattern = (p: Pattern) => patternSyntax(p);
    const range = (low: Value, high: Value | undefined, next: Value | undefined) =>
        node(text(".."), low, high ?? mkList([]), ...next ? [next] : []);
    switch (e.t) {
        case "import": return node(text("import"), ...[e.module].flat().map(text));
        case "numeric": return e.v;
        case "int": return mkInt(e.v);
        case "float": return { kind: "float", v: e.v };
        case "bool": return mkBool(e.v);
        case "string": return text(stringLiteral(e.v));
        case "char": return text(charLiteral(e.v));
        case "placeholder": return text("_");
        case "var": return text(e.name);
        case "binop": return node(text(e.op), of(e.l), of(e.r));
        case "pipe": return node(text("$"), of(e.f), of(e.x));
        case "unop": return node(text(e.op === "neg" ? "negate" : "not"), of(e.e));
        case "app": {
            // f x y is ["f","x","y"]: one list for the whole spine.
            const args: Expr[] = [];
            let head: Expr = e;
            while (head.t === "app") { args.unshift(head.a); head = head.f; }
            return node(of(head), ...args.map(of));
        }
        case "lambda": {
            // An operator section, as written: (+) its name, (2 +) the operator
            // given its left operand, (+ 2) a "()" node.
            const op = e.body.t === "binop" ? e.body.op : e.body.t === "pipe" ? "$" : undefined;
            const [l, r] = e.body.t === "binop" ? [e.body.l, e.body.r] : e.body.t === "pipe" ? [e.body.f, e.body.x] : [];
            const own = (x: Expr | undefined, param: string) => x?.t === "var" && x.name === param;
            if (op && e.params.join() === "$L,$R") return text(op);
            if (op && e.params.join() === "$S" && own(l, "$S")) return node(text("()"), text(op), of(r!));
            if (op && e.params.join() === "$S" && own(r, "$S")) return node(text(op), of(l!));
            return node(text("->"), mkList(e.params.map(text)), of(e.body));
        }
        case "patternLambda": {
            const body = e.guard ? node(text("|"), of(e.guard), of(e.body)) : of(e.body);
            return node(text("->"), mkList(e.params.map(pattern)), body);
        }
        case "ternary": return node(text("?:"), of(e.cond), of(e.then), of(e.els));
        case "list": return node(text("[]"), ...e.v.map(of));
        case "record": return node(text("[:]"), ...e.v.map(([k, x]) => node(text(keySource(k)), of(x))));
        case "recordAccess": return node(text("."), of(e.rec), e.scoped && e.argument ? scopedSyntax(e.argument) : text(keySource(e.field)));
        case "pluck":
            if (e.values) return node(text("."), of(e.rec), of(e.values));
            return node(text("."), of(e.rec), e.entries.every(x => typeof x === "string")
                ? node(text("[]"), ...(e.entries as string[]).map(text))
                : node(text("[:]"), ...(e.entries as [string, string][]).map(([k, v]) => node(text(keySource(k)), text(v)))));
        case "computedRange": return range(of(e.lo), e.hi ? of(e.hi) : undefined, e.second ? of(e.second) : undefined);
        case "range": return range(mkInt(e.lo), e.hi === null ? undefined : mkInt(e.hi), e.step !== 1n ? mkInt(e.lo + e.step) : undefined);
        case "floatRange": return range({ kind: "float", v: e.lo }, e.hi === null ? undefined : { kind: "float", v: e.hi }, { kind: "float", v: e.lo + e.step });
        case "rationalRange": return range(e.lo, e.hi === null ? undefined : e.hi, arithmetic("+", e.lo, e.step) as Value);
        // a single-statement ( ) group is transparent: toAST (1 + 2) is ["+",1,2]
        case "block":
            if (e.stmts.length === 1 && e.style === "(") return of(e.stmts[0]);
            return node(text("{}"), ...e.stmts.flatMap(st => st.t === "stmDef" ? clauseSyntax(st) : [of(st)]));
        case "stmDef": {
            const binds = clauseSyntax(e);
            return binds.length === 1 ? binds[0] : node(text("{}"), ...binds);
        }
        case "patDef":
            if (e.value.t === "setItem" || e.value.t === "setFields") return of(e.value);
            return node(text(e.eager ? "<-" : "="), pattern(e.pattern), of(e.value));
        case "setItem": return node(text("="), node(of(e.rec), of(e.index)), of(e.value));
        case "setFields": {
            const rec = (e.path ?? []).reduce((r, key) => node(text("."), r, text(keySource(key))), of(e.rec));
            const target = e.entries.length === 1 && !e.aliases ? node(text("."), rec, text(keySource(e.entries[0])))
                : node(text("."), rec, node(text("[]"), ...e.entries.map(text)));
            return node(text("="), target, of(e.value));
        }
    }
}
// What r.(e) and r.{ e } select: always a block, so a name stays a selection.
function scopedSyntax(e: Expr): Value {
    const stmts = e.t === "block" ? e.stmts : [e];
    return mkList([mkStr("{}"), ...stmts.map(st => syntaxOf(st))]);
}
// A definition's clauses, each ["=", [name, params...], body] (["=", name, body] without parameters).
function clauseSyntax(d: Extract<Expr, { t: "stmDef" }>): Value[] {
    return d.clauses.map(c => mkList([mkStr("="),
        c.params.length ? mkList([mkStr(d.name), ...c.params.map(p => patternSyntax(p))]) : mkStr(d.name), syntaxOf(c.body)]));
}
// A pattern, as the expression it is written as.
function patternSyntax(p: Pattern): Value {
    const node = (...items: Value[]) => mkList(items), text = mkStr, of = (q: Pattern) => patternSyntax(q);
    switch (p.p) {
        case "var": return text(p.name);
        case "wildcard": return text("_");
        case "int": return mkInt(p.v);
        case "float": return { kind: "float", v: p.v };
        case "string": return text(stringLiteral(p.v));
        case "char": return text(charLiteral(p.v));
        case "bool": return mkBool(p.v);
        case "list": return node(text("[]"), ...p.v.map(of));
        case "cons": return node(text(p.op ?? "::"), of(p.head), of(p.tail));
        case "constr": return p.args.length ? node(text(p.tag), ...p.args.map(of)) : text(p.tag);
        case "typeBind": return node(text(p.name), of(p.value));
        case "schema": return node(syntaxOf(p.type), of(p.value));
        case "as": return node(text("."), of(p.left), of(p.right));
        case "recPat": return node(text("[:]"), ...p.v.map(([k, v]) => node(text(keySource(k)), text(v))));
        case "range": return node(text(".."), mkInt(p.lo), mkInt(p.hi));
    }
}

// The heads that are syntax, not functions.
const TAGS = new Set(["[]", "[:]", "->", "?:", ".", "{}", "..", "=", "<-", "()", "import", "|"]);
const isOperator = (name: string) => name !== "" && "!$%&*+-/<=>\\^|~:".includes(name[0]);
const headOf = (v: Value) => v.kind === "list" && v.v.length ? v.v[0] : undefined;
const tagOf = (v: Value) => { const h = headOf(v); return h?.kind === "string" && TAGS.has(h.v) ? h.v : undefined; };

// Syntax data (fully realized: lists of lists, strings, numbers and Bools) as
// source, parenthesized only where precedence needs it.
export function syntaxSource(v: Value): string {
    if (v.kind === "string") return isOperator(v.v) ? `(${v.v})` : v.v;
    if (v.kind === "bool") return String(v.v);
    if (isNumeric(v)) return numberText(v);
    if (v.kind !== "list") throw new APNError("runtime", `syntax data holds lists, names, numbers and Bools, not ${v.kind === "char" ? "a Char" : `a ${v.kind}`}`, {
        hint: 'a literal is written as its source text: "\\"text\\"" or "\'c\'"' });
    if (!v.v.length) return "[]";
    const [head, ...rest] = v.v, tag = tagOf(v);
    const text = (x: Value) => x.kind === "string" ? x.v : syntaxSource(x);
    switch (tag) {
        case "[]": return `[${itemsText(rest.map(syntaxSource))}]`;
        case "[:]": return `[${rest.map(f => f.kind === "list" ? `${text(f.v[0])}: ${syntaxSource(f.v[1])}` : syntaxSource(f)).join(", ")}]`;
        case "->": {
            const params = rest[0]?.kind === "list" ? rest[0].v : [];
            const body = rest[1], guard = tagOf(body) === "|" && body.kind === "list" ? body.v : undefined;
            return itemsText(params.map(operand)) + (guard ? ` | ${syntaxSource(guard[1])} -> ${syntaxSource(guard[2])}` : ` -> ${syntaxSource(body)}`);
        }
        case "?:": return `${operand(rest[0])} ? ${operand(rest[1])} : ${operand(rest[2])}`;
        case ".": return `${operand(rest[0])}.${text(rest[1])}`;
        case "{}": return rest.length ? `{ ${rest.map(syntaxSource).join("; ")} }` : "{}";
        case "..": {
            const end = rest[1]?.kind === "list" && !rest[1].v.length ? "" : operand(rest[1]);
            return rest[2] ? `[${itemsText([operand(rest[0]), `${operand(rest[2])}..${end}`])}]` : `[${operand(rest[0])}..${end}]`;
        }
        case "=": case "<-": return `${syntaxSource(rest[0])} ${tag} ${syntaxSource(rest[1])}`;
        case "()": return `(${text(rest[0])} ${operand(rest[1])})`;
        case "import": return rest.length === 1 ? `import ${stringLiteral(text(rest[0]))}` : `import [${itemsText(rest.map(m => stringLiteral(text(m))))}]`;
        case "|": return `${syntaxSource(rest[0])} | ${syntaxSource(rest[1])}`;
    }
    // An operator given its two operands is written between them.
    if (head.kind === "string" && isOperator(head.v) && rest.length === 2) {
        return `${infixOperand(head.v, "left", rest[0])} ${head.v} ${infixOperand(head.v, "right", rest[1])}`;
    }
    return [head, ...rest].map(operand).join(" ");
}

const isInfix = (v: Value) => { const h = headOf(v); return v.kind === "list" && v.v.length === 3 && h?.kind === "string" && isOperator(h.v); };
const isCall = (v: Value) => v.kind === "list" && v.v.length >= 2 && !tagOf(v);
// An operand of an operator needs no parentheses when it is a call
// (application binds tightest) or an operator binding tighter, or as tight on
// its associativity's side.
function infixOperand(outer: string, side: "left" | "right", v: Value): string {
    if (isInfix(v)) {
        const inner = fixityOf((headOf(v) as { v: string }).v), { prec, assoc } = fixityOf(outer);
        return inner.prec > prec || inner.prec === prec && assoc === side ? syntaxSource(v) : `(${syntaxSource(v)})`;
    }
    return isCall(v) ? syntaxSource(v) : operand(v);
}
// An operand or argument: parenthesized unless it is one piece of syntax.
function operand(v: Value): string {
    const atomic = v.kind === "string" || v.kind === "bool"
        || isNumeric(v) && /^[0-9.]+$/.test(numberText(v))
        || ["[]", "[:]", "{}", ".", "..", "()"].includes(tagOf(v) ?? "");
    return atomic ? syntaxSource(v) : `(${syntaxSource(v)})`;
}

// Syntax data read back as one expression, a block of its statements (so a
// binding stays inside it). Generated source has no layout to keep, so its
// spacing is read loosely. With at (a macro call's location), every part of
// it is located there, where problems in it are reported.
export function syntaxExpr(data: Value, file: string, at?: SourceLocation): Expr {
    const source = syntaxSource(data), loose = getLooseSpacing();
    setLooseSpacing(true);
    let program: TopLevel[];
    try { program = parse(source, file); } finally { setLooseSpacing(loose); }
    const stmts: Expr[] = program.map(tl => {
        if (tl.t === "def") return { t: "stmDef", name: tl.name, clauses: tl.clauses };
        if (tl.t === "type") throw new APNError("runtime", "syntax data cannot declare a type");
        return tl.t === "expr" ? tl.value : tl;
    });
    const block: Expr = { t: "block", stmts, style: "{" };
    if (at) locate(block, { ...at, expansion: source });
    return block;
}
function locate(node: unknown, at: SourceLocation): void {
    if (!node || typeof node !== "object") return;
    if ("t" in node) sourceLocations.set(node as Expr, at);
    for (const value of Array.isArray(node) ? node : Object.values(node)) locate(value, at);
}
