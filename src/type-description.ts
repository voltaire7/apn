import type { Expr, Pattern } from "./ast.ts";
import { type Env, type Value, typeToString } from "./types.ts";
import { numericType } from "./type-system.ts";

// Diagnostic descriptions, not inferred contracts. Never evaluate APN code here:
// lazy fields may contain effects, undefined names, or infinite computations.
type Shape = string | { from: Shape; to: Shape };
const arrow = (from: Shape, to: Shape): Shape => ({ from, to });
function show(t: Shape): string {
    return typeof t === "string" ? t : `${typeof t.from === "string" ? t.from : "(" + show(t.from) + ")"} -> ${show(t.to)}`;
}
function join(ts: Shape[]): Shape {
    if (ts.length && ts.every(t => typeof t !== "string")) {
        const arrows = ts as { from: Shape; to: Shape }[];
        return arrow(join(arrows.map(t => t.from)), join(arrows.map(t => t.to)));
    }
    const names = [...new Set(ts.map(show))];
    if (names.includes("?")) return "?";
    return names.length === 1 ? ts[0] : names.length ? names.join(" | ") : "?";
}

export function describeType(value: Value): string {
    let budget = 2048;
    const active = new Set<Value>();
    const list = (ts: Shape[]): Shape => `[${show(join(ts))}]`;
    function pattern(p: Pattern, env: Env, locals: Map<string, Shape>, expected: Shape = "?"): Shape {
        switch (p.p) {
            case "var": locals.set(p.name, expected); return expected;
            case "wildcard": return expected;
            case "int": return "Int";
            case "bool": return "Bool";
            case "string": return "String";
            case "schema": {
                const t = p.type.t === "var" ? p.type.name : "?";
                pattern(p.value, env, locals, t); return t;
            }
            case "contract": {
                const spec = (s: typeof p.spec): Shape => "name" in s ? s.name : arrow(spec(s.from), spec(s.to));
                const t = spec(p.spec); pattern(p.value, env, locals, t); return t;
            }
            case "constr": {
                const ctor = env.get(p.tag);
                const family = ctor && (ctor.kind === "native" || ctor.kind === "variant" || ctor.kind === "type") ? ctor.family : undefined;
                const t = family?.name ?? p.tag;
                p.args.forEach(a => pattern(a, env, locals, family ? "?" : t));
                return t;
            }
            case "typeBind": locals.set(p.name, "Type"); return pattern(p.value, env, locals, expected);
            case "list": return list(p.v.map(x => pattern(x, env, locals)));
            case "cons": pattern(p.head, env, locals); pattern(p.tail, env, locals, "[?]"); return "[?]";
            case "recPat": p.v.forEach(([, name]) => locals.set(name, "?")); return "Record";
            case "range": return "Int";
        }
    }
    function fn(params: Pattern[], body: Expr, env: Env, applied: Value[] = []): Shape {
        const locals = new Map<string, Shape>();
        const inputs = params.map((p, i) => pattern(p, env, locals, i < applied.length ? inspect(applied[i]) : "?"));
        let result = expr(body, env, locals);
        for (let i = inputs.length - 1; i >= applied.length; i--) result = arrow(inputs[i], result);
        return params.length ? result : arrow("Unit", result);
    }
    function expr(e: Expr, env: Env, locals = new Map<string, Shape>()): Shape {
        if (--budget < 0) return "?";
        switch (e.t) {
            case "numeric": return numericType(e.v);
            case "int": case "float": case "bool": case "string": case "char": case "unit":
                return { int: "Int", float: "Float", bool: "Bool", string: "String", char: "Char", unit: "Unit" }[e.t];
            case "var": return locals.get(e.name) ?? (env.get(e.name) ? inspect(env.get(e.name)!) : "?");
            case "range": return "[Int]";
            case "floatRange": return "[Float]";
            case "rationalRange": return "[Fraction]";
            case "list": return list(e.v.map(x => expr(x, env, locals)));
            case "record": return "Record";
            case "functionType": return "Type";
            case "lambda": return fn(e.params.map(name => ({ p: "var", name })), e.body, env);
            case "patternLambda": return fn(e.params, e.body, env);
            case "app": case "pipe": {
                // Calling a constructor has a known successful result type.
                const f = e.f;
                if (f.t === "var" && !locals.has(f.name)) {
                    const v = env.get(f.name);
                    if (v?.kind === "type") return v.name;
                }
                const t = expr(f, env, locals);
                return typeof t === "string" ? "?" : t.to;
            }
            case "ternary": return join([expr(e.then, env, locals), expr(e.els, env, locals)]);
            case "unop": return e.op === "not" ? "Bool" : expr(e.e, env, locals);
            case "binop": {
                if (["==", "!=", "<", ">", "<=", ">=", "&&", "||"].includes(e.op)) return "Bool";
                // Overloaded arithmetic/application can change types. Do not guess.
                return "?";
            }
            case "block": {
                const scope = new Map(locals);
                let result: Shape = "Unit";
                for (const s of e.stmts) {
                    if (s.t === "patDef" && s.pattern.p === "var") scope.set(s.pattern.name, expr(s.value, env, scope));
                    result = expr(s, env, scope);
                }
                return result;
            }
            default: return "?";
        }
    }
    function inspect(v: Value): Shape {
        if (--budget < 0 || active.has(v)) return "?";
        active.add(v);
        try {
            switch (v.kind) {
                case "int": case "float": case "rational": case "complex": return numericType(v);
                case "type": case "functionType": return "Type";
                case "thunk": return v.value ? inspect(v.value) : expr(v.body, v.env);
                case "deferred": return v.value ? inspect(v.value) : "?";
                case "lazyList": return v.value ? inspect(v.value) : list(v.exprs.map(e => expr(e, v.env)));
                case "list": return list(v.v.map(inspect));
                case "range": return "[Int]";
                case "floatRange": return "[Float]";
                case "rationalRange": return "[Fraction]";
                case "cons": return "[?]";
                case "contract": return arrow(typeToString(v.from), typeToString(v.to));
                case "closure": return fn(v.params.map(name => ({ p: "var", name })), v.body, v.env);
                case "clauseFn": {
                    const clauses = v.clauses.map(c => fn(c.params, c.body, v.env, v.applied));
                    // Preserve differing signatures instead of silently claiming they agree.
                    return join(clauses);
                }
                case "native": {
                    let result: Shape = v.family?.name ?? (v.name === "print" ? "Unit" : "?");
                    for (let i = v.applied.length; i < v.arity; i++) result = arrow("?", result);
                    return v.arity ? result : arrow("Unit", result);
                }
                case "variant": return v.family?.name ?? "Variant";
                default: return { bool: "Bool", string: "String", char: "Char", unit: "Unit", record: "Record", mutable: "Mutable", pointer: "Pointer", hashmap: "HashMap", nomatch: "?" }[v.kind];
            }
        } finally { active.delete(v); }
    }
    return show(inspect(value));
}
