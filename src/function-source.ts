import { keySource } from "./record-keys.ts";
import type { Expr, Pattern } from "./ast.ts";
import type { Value } from "./types.ts";
import { exprToSource, fixityOf } from "./parser.ts";
import { compoundArgument, valueToString } from "./types.ts";
import { itemsText } from "./separators.ts";

function pattern(p: Pattern): string {
    switch (p.p) {
        case "as": return `${pattern(p.left)}.${pattern(p.right)}`;
        case "schema": return `(${source(p.type)} ${pattern(p.value)})`;
        case "wildcard": return "_";
        case "var": return p.name;
        case "int": return String(p.v);
        case "bool": return String(p.v);
        case "string": return JSON.stringify(p.v);
        case "char": return exprToSource({ t: "char", v: p.v });
        case "float": return exprToSource({ t: "float", v: p.v });
        case "list": return `[${itemsText(p.v.map(pattern))}]`;
        case "cons": return `(${pattern(p.head)} ${p.op ?? "::"} ${pattern(p.tail)})`;
        case "constr": return p.args.length ? `(${p.tag} ${p.args.map(pattern).join(" ")})` : p.tag;
        case "typeBind": return `(${p.name} ${pattern(p.value)})`;
        case "recPat": return `[${p.v.map(([k, v]) => `${keySource(k)}: ${v}`).join(", ")}]`;
        case "range": return `[${p.lo}..${p.hi}]`;
    }
}
function source(e: Expr, parent = -1): string {
    let text: string, level = 12;
    switch (e.t) {
        case "string": return JSON.stringify(e.v);
        case "app": level = 10; text = `${source(e.f, 10)} ${source(e.a, 11)}`; break;
        case "binop": {
            // Levels follow the fixity table: operators 0..9, application 10.
            const { prec, assoc } = fixityOf(e.op);
            level = prec;
            text = `${source(e.l, prec + (assoc === "left" ? 0 : 1))} ${e.op} ${source(e.r, prec + (assoc === "right" ? 0 : 1))}`;
            break;
        }
        // Prefix - and ! bind tighter than * (7) and looser than ^ (8).
        case "unop": level = 7.5; text = `${e.op === "neg" ? "-" : "!"}${source(e.e, 8)}`; break;
        case "patternLambda": level = -1; text = `${e.params.map(pattern).join(", ")}${e.guard ? " | " + source(e.guard) : ""} -> ${source(e.body)}`; break;
        case "lambda": level = -1; text = `${e.params.join(", ")} -> ${source(e.body)}`; break;
        case "pipe": level = 0; text = `${source(e.f, 1)} $ ${source(e.x, 0)}`; break;
        case "ternary": level = 1; text = `${source(e.cond, 2)} ? ${source(e.then, 6)} : ${source(e.els, 2)}`; break;
        case "list": return `[${itemsText(e.v.map(x => source(x)))}]`;
        case "record": return `[${e.v.map(([k, v]) => `${keySource(k)}: ${source(v)}`).join(", ")}]`;
        case "block": {
            if (e.style === "(" && e.stmts.length === 1) return `(${source(e.stmts[0])})`;
            return `{ ${e.stmts.map(x => source(x)).join("; ")} }`;
        }
        case "stmDef": return e.clauses.map(c => `${e.name}${c.params.length ? " " + c.params.map(pattern).join(" ") : ""} = ${source(c.body)}`).join("; ");
        case "patDef": return (e.value.t === "setItem" || e.value.t === "setFields") ? source(e.value) : `${pattern(e.pattern)} ${e.eager ? "<-" : "="} ${source(e.value)}`;
        case "recordAccess": return `${source(e.rec, 11)}.${e.scoped && e.argument ? source(e.argument) : keySource(e.field)}`;
        default: return exprToSource(e);
    }
    return level < parent ? `(${text})` : text;
}
// Inspect syntax only: never demand bound arguments or walk a captured environment.
export function argument(v: Value): string {
    if (v.kind === "thunk") return source(v.body, 11);
    if (v.kind === "deferred") return "...";
    const text = valueToString(v);
    return compoundArgument(v) ? `(${text})` : text;
}
// An operator's lambda as source writes it: (+), (1 +), (+ 1).
function operatorForm(params: string[], body: Expr, applied: Value[]): string | undefined {
    if (body.t !== "binop") return undefined;
    const is = (e: Expr, name: string) => e.t === "var" && e.name === name;
    if (params.length === 2 && params[0] === "$L" && params[1] === "$R" && is(body.l, "$L") && is(body.r, "$R")) {
        if (!applied.length) return `(${body.op})`;
        if (applied.length === 1) return `(${argument(applied[0])} ${body.op})`;
    }
    if (params.length === 1 && params[0] === "$S" && !applied.length) {
        if (is(body.l, "$S")) return `(${body.op} ${source(body.r, 11)})`;
        if (is(body.r, "$S")) return `(${source(body.l, 11)} ${body.op})`;
    }
    return undefined;
}
export function functionSource(v: Extract<Value, { kind: "closure" | "clauseFn" | "native" }>): string {
    if (v.kind === "closure") {
        const params = v.whole ?? v.params, applied = v.applied ?? [];
        const operator = operatorForm(params, v.body, applied);
        if (operator) return operator;
        const text = `${params.length ? params.join(", ") : "()"} -> ${source(v.body)}`;
        return applied.length ? `(${text})${applied.map(a => ` ${argument(a)}`).join("")}` : text;
    }
    if (v.kind === "native") {
        const name = v.tag ?? v.name;
        return name + v.applied.map(a => ` ${argument(a)}`).join("");
    }
    // Each clause is a pattern lambda, one per line, with the arguments
    // applied so far after each:
    //     ((Int x) y -> 1) 1
    //     ((Float x) y -> 2) 1
    const args = v.applied.map(a => ` ${argument(a)}`).join("");
    return v.clauses.map(c => args ? `(${clauseSource(c)})${args}` : clauseSource(c)).join("\n");
}
// A clause as a pattern lambda. A lone constructor pattern needs no
// parentheses (Int x -> x); among several parameters it keeps them ((Int x), y -> x).
function clauseSource(c: { params: Pattern[]; body: Expr; guard?: Expr }): string {
    const lone = c.params.length === 1 && c.params[0].p === "constr" && c.params[0].args.length;
    const params = lone ? pattern(c.params[0]).slice(1, -1) : c.params.map(pattern).join(", ");
    return `${params}${c.guard ? " | " + source(c.guard) : ""} -> ${source(c.body)}`;
}

// What is left of a function after some of its arguments: the remaining
// parameters and body, with each name an argument matched shown as that
// argument (h (Int x) y = x + y applied to 1 is y -> 1 + y). A value is only
// rendered where its name is used.
export function residualSource(params: Array<Pattern | string>, body: Expr, guard: Expr | undefined, values: Map<string, () => string>): string {
    const rest = params.map((p): Pattern => typeof p === "string" ? { p: "var", name: p } : p);
    // Every parameter given: what is left is the body.
    if (!rest.length) return source(substitute(body, values) as Expr);
    return clauseSource({ params: rest, body: substitute(body, values) as Expr, guard: guard && substitute(guard, values) as Expr });
}
function boundNames(p: Pattern): string[] {
    switch (p.p) {
        case "var": return [p.name];
        case "typeBind": return [p.name, ...boundNames(p.value)];
        case "as": return [...boundNames(p.left), ...boundNames(p.right)];
        case "schema": return boundNames(p.value);
        case "list": return p.v.flatMap(boundNames);
        case "cons": return [...boundNames(p.head), ...boundNames(p.tail)];
        case "constr": return p.args.flatMap(boundNames);
        case "recPat": return p.v.map(([, name]) => name);
        default: return [];
    }
}
// A copy of e with the free uses of these names replaced by their values' text.
function substitute(e: unknown, values: Map<string, () => string>): unknown {
    if (Array.isArray(e)) return e.map(x => substitute(x, values));
    if (!e || typeof e !== "object" || !values.size) return e;
    const n = e as Record<string, unknown>;
    if ("p" in n) return n;
    const without = (names: string[]) => {
        const inner = new Map(values);
        for (const name of names) inner.delete(name);
        return inner;
    };
    switch (n.t) {
        case "var": {
            const value = values.get(n.name as string);
            return value ? { t: "var", name: value() } : n;
        }
        case "lambda": return { ...n, body: substitute(n.body, without(n.params as string[])) };
        case "patternLambda": {
            const inner = without((n.params as Pattern[]).flatMap(boundNames));
            return { ...n, body: substitute(n.body, inner), guard: substitute(n.guard, inner) };
        }
        case "block": {
            const stmts = n.stmts as Expr[];
            return { ...n, stmts: substitute(stmts, without(stmts.flatMap(s => s.t === "stmDef" ? [s.name] : s.t === "patDef" ? boundNames(s.pattern) : []))) };
        }
        case "stmDef": return { ...n, clauses: (n.clauses as { params: Pattern[]; body: Expr; guard?: Expr }[]).map(c => {
            const inner = without([n.name as string, ...c.params.flatMap(boundNames)]);
            return { ...c, body: substitute(c.body, inner), guard: substitute(c.guard, inner) };
        }) };
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(n)) out[key] = substitute(value, values);
    return out;
}
