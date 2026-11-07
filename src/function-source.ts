import type { Expr, Pattern } from "./ast.ts";
import type { Value } from "./types.ts";
import { exprToSource, PRIMITIVE_OPERATORS, sectionSource, wholePatternSource } from "./parser.ts";
import { compoundArgument, valueToString } from "./types.ts";

// Function text is source text (exprToSource): an argument is written as one.
const source = (e: Expr, argument = false) => exprToSource(e, argument ? { kind: "argument", min: 0, follows: -1 } : undefined);
// Inspect syntax only: never demand bound arguments or walk a captured environment.
export function argument(v: Value): string {
    if (v.kind === "thunk") return source(v.body, true);
    if (v.kind === "deferred") return "...";
    const text = valueToString(v);
    return compoundArgument(v) ? `(${text})` : text;
}
// An operator's lambda as source writes it: (+), (1 +), (+ 1).
function operatorForm(params: string[], body: Expr, applied: Value[]): string | undefined {
    return applied.length ? undefined : sectionSource(params, body, e => exprToSource(e, { kind: "operand", min: 8, follows: -1 }));
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
        // An operator's intrinsic shows as the operator: (+), and (1 +) given 1.
        const op = PRIMITIVE_OPERATORS.get(v.name);
        if (op && v.applied.length === 1) return `(${argument(v.applied[0])} ${op})`;
        const name = op ? `(${op})` : v.tag ?? v.name;
        return name + v.applied.map(a => ` ${argument(a)}`).join("");
    }
    // Each clause is a pattern lambda, one per line, with the arguments
    // applied so far after each:
    //     ((x : Int), y -> 1) 1
    //     ((x : Float), y -> 2) 1
    const args = v.applied.map(a => ` ${argument(a)}`).join("");
    return v.clauses.map(c => args ? `(${clauseSource(c)})${args}` : clauseSource(c)).join("\n");
}
// A clause as a pattern lambda, each parameter a whole pattern: Some x, y -> x.
// A typed one keeps its parentheses: (x : Int) -> x.
function clauseSource(c: { params: Pattern[]; body: Expr; guard?: Expr }): string {
    const params = c.params.map(wholePatternSource).join(", ");
    return `${params}${c.guard ? " | " + exprToSource(c.guard, { kind: "guard", min: 0, follows: -1 }) : ""} -> ${source(c.body)}`;
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
