import type { Expr, Pattern, FunctionSpec } from "./ast.ts";
import { type Env, type Value, type VariantFamily, typeToString } from "./types.ts";
import { numericType, NUMERIC_TYPES } from "./type-system.ts";

// Bounded, non-evaluating inference for display, not an enforced static type system.
// Variable identity preserves relationships; links accumulate application/pattern constraints.
type Shape =
    | { tag: "var"; link?: Shape }
    | { tag: "name"; name: string; args: Shape[] }
    | { tag: "arrow"; from: Shape; to: Shape }
    | { tag: "list"; element: Shape }
    | { tag: "union"; choices: Shape[] };
const fresh = (): Shape => ({ tag: "var" });
const named = (name: string, args: Shape[] = []): Shape => ({ tag: "name", name, args });
const arrow = (from: Shape, to: Shape): Shape => ({ tag: "arrow", from, to });
const list = (element: Shape): Shape => ({ tag: "list", element });
function resolve(t: Shape): Shape {
    return t.tag === "var" && t.link ? resolve(t.link) : t;
}
function occurs(v: Shape, t: Shape): boolean {
    t = resolve(t);
    if (v === t) return true;
    switch (t.tag) {
        case "arrow": return occurs(v, t.from) || occurs(v, t.to);
        case "list": return occurs(v, t.element);
        case "name": return t.args.some(a => occurs(v, a));
        case "union": return t.choices.some(a => occurs(v, a));
        default: return false;
    }
}
function unify(a: Shape, b: Shape): Shape {
    a = resolve(a); b = resolve(b);
    if (a === b) return a;
    if (a.tag === "var") {
        // APN permits self-application. Do not create an infinite type graph.
        if (!occurs(a, b)) a.link = b;
        return a;
    }
    if (b.tag === "var") return unify(b, a);
    if (a.tag === "arrow" && b.tag === "arrow") return arrow(unify(a.from, b.from), unify(a.to, b.to));
    if (a.tag === "list" && b.tag === "list") return list(unify(a.element, b.element));
    if (a.tag === "name" && b.tag === "name" && a.name === b.name && a.args.length === b.args.length) {
        return named(a.name, a.args.map((x, i) => unify(x, b.args[i])));
    }
    return { tag: "union", choices: [a, b] };
}

export function describeType(value: Value): string {
    let budget = 1024;
    const active = new Map<Value, Shape>();
    const join = (ts: Shape[]) => ts.reduce(unify, fresh());
    const sequence = (ts: Shape[]) => list(join(ts));
    function spec(s: FunctionSpec): Shape {
        return "name" in s ? named(s.name) : arrow(spec(s.from), spec(s.to));
    }
    function declared(e: Expr, parameters: Map<string, Shape>): Shape {
        if (e.t === "var") return parameters.get(e.name) ?? named(e.name);
        if (e.t === "list") return sequence(e.v.map(x => declared(x, parameters)));
        if (e.t === "functionType") return spec(e.spec);
        if (e.t === "app") {
            const f = declared(e.f, parameters);
            return f.tag === "name" ? named(f.name, [...f.args, declared(e.a, parameters)]) : fresh();
        }
        return fresh();
    }
    function constructor(family: VariantFamily, tag: string): { result: Shape; fields: Shape[] } {
        const args = (family.parameters ?? []).map(fresh);
        const parameters = new Map((family.parameters ?? []).map((p, i) => [p, args[i]]));
        return { result: named(family.name, args), fields: (family.fields?.get(tag) ?? []).map(e => declared(e, parameters)) };
    }
    function pattern(p: Pattern, env: Env, locals: Map<string, Shape>, expected = fresh()): Shape {
        let result: Shape;
        switch (p.p) {
            case "var":
                if (locals.has(p.name)) unify(expected, locals.get(p.name)!);
                locals.set(p.name, expected); return expected;
            case "wildcard": return expected;
            case "int": case "range": result = named("Int"); break;
            case "bool": result = named("Bool"); break;
            case "string": result = named("String"); break;
            case "schema": result = declared(p.type, new Map()); pattern(p.value, env, locals, result); break;
            case "contract": result = spec(p.spec); pattern(p.value, env, locals, result); break;
            case "constr": {
                const ctor = env.get(p.tag);
                const family = ctor && (ctor.kind === "native" || ctor.kind === "variant" || ctor.kind === "type") ? ctor.family : undefined;
                if (family) {
                    const c = constructor(family, p.tag);
                    result = c.result;
                    p.args.forEach((a, i) => pattern(a, env, locals, c.fields[i] ?? fresh()));
                } else {
                    result = named(p.tag);
                    // Numeric patterns strip explicit storage annotations from their payload.
                    const payload = /^(U?Int)(8|16|32|64|128)?$/.test(p.tag) ? named("Int")
                        : /^Float(32|64)?$/.test(p.tag) ? named("Float") : result;
                    p.args.forEach(a => pattern(a, env, locals, payload));
                }
                break;
            }
            case "typeBind": locals.set(p.name, named("Type")); return pattern(p.value, env, locals, expected);
            case "list": result = sequence(p.v.map(x => pattern(x, env, locals))); break;
            case "cons": {
                const element = fresh(); result = list(element);
                pattern(p.head, env, locals, element); pattern(p.tail, env, locals, result); break;
            }
            case "recPat": p.v.forEach(([, name]) => locals.set(name, fresh())); result = named("Record"); break;
        }
        return unify(expected, result);
    }
    function fn(params: Pattern[], body: Expr, env: Env, applied: Value[] = [], outer = new Map<string, Shape>()): Shape {
        const locals = new Map(outer);
        // Parameters shadow captured names, while repeated names within patterns share a type.
        const bindings = new Map<string, Shape>();
        const inputs = params.map((p, i) => pattern(p, env, bindings, i < applied.length ? inspect(applied[i]) : fresh()));
        for (const [name, t] of bindings) locals.set(name, t);
        let result = expr(body, env, locals);
        for (let i = inputs.length - 1; i >= applied.length; i--) result = arrow(inputs[i], result);
        return params.length ? result : arrow(named("[]"), result);
    }
    function apply(f: Shape, argument: Shape): Shape {
        f = resolve(f);
        if (f.tag === "arrow") { unify(f.from, argument); return f.to; }
        const result = fresh();
        if (f.tag === "var") unify(f, arrow(argument, result));
        return result;
    }
    function expr(e: Expr, env: Env, locals = new Map<string, Shape>()): Shape {
        if (--budget < 0) return fresh();
        switch (e.t) {
            case "numeric": return named(numericType(e.v));
            case "int": case "float": case "bool": case "string": case "char":
                return named({ int: "Int", float: "Float", bool: "Bool", string: "String", char: "Char" }[e.t]);
            case "var": return locals.get(e.name) ?? (env.get(e.name) ? inspect(env.get(e.name)!) : fresh());
            case "range": return list(named("Int"));
            case "floatRange": return list(named("Float"));
            case "rationalRange": return list(named("Fraction"));
            case "list": return sequence(e.v.map(x => expr(x, env, locals)));
            case "record": return named("Record");
            case "functionType": return named("Type");
            case "lambda": return fn(e.params.map(name => ({ p: "var", name })), e.body, env, [], locals);
            case "patternLambda": return fn(e.params, e.body, env, [], locals);
            case "app": case "pipe": {
                if (e.f.t === "var" && !locals.has(e.f.name)) {
                    const v = env.get(e.f.name);
                    if (v?.kind === "type") return named(v.name);
                }
                return apply(expr(e.f, env, locals), expr(e.t === "app" ? e.a : e.x, env, locals));
            }
            case "ternary": return unify(expr(e.then, env, locals), expr(e.els, env, locals));
            case "unop": return e.op === "not" ? named("Bool") : expr(e.e, env, locals);
            case "binop": {
                if (["==", "!=", "<", ">", "<=", ">=", "&&", "||"].includes(e.op)) return named("Bool");
                const l = expr(e.l, env, locals), r = expr(e.r, env, locals);
                if (e.op === ":") { const result = list(l); unify(result, r); return result; }
                if (e.op === "\\") {
                    const input = fresh(); return arrow(input, apply(l, apply(r, input)));
                }
                const a = resolve(l), b = resolve(r);
                if (["+", "-", "*"].includes(e.op) && a.tag === "name" && b.tag === "name" && a.name === b.name && NUMERIC_TYPES.includes(a.name)) return a;
                // The remaining overloaded operators have no single sound static rule.
                return fresh();
            }
            case "block": {
                const scope = new Map(locals);
                let result = named("[]");
                for (const s of e.stmts) {
                    if (s.t === "stmDef") {
                        scope.set(s.name, join(s.clauses.map(c => c.params.length ? fn(c.params, c.body, env, [], scope) : expr(c.body, env, scope))));
                        result = named("[]");
                    } else if (s.t === "patDef") {
                        const bindings = new Map<string, Shape>();
                        pattern(s.pattern, env, bindings, expr(s.value, env, scope));
                        for (const [name, t] of bindings) scope.set(name, t);
                        result = named("[]");
                    } else result = expr(s, env, scope);
                }
                return result;
            }
            default: return fresh();
        }
    }
    function inspect(v: Value): Shape {
        if (--budget < 0) return fresh();
        if (active.has(v)) return active.get(v)!;
        const pending = fresh(); active.set(v, pending);
        try {
            const result = inspectValue(v);
            unify(pending, result);
            return result;
        } finally { active.delete(v); }
    }
    function inspectValue(v: Value): Shape {
        switch (v.kind) {
            case "int": case "float": case "rational": case "complex": return named(numericType(v));
            case "type": case "functionType": return named("Type");
            case "thunk": return v.value ? inspect(v.value) : expr(v.body, v.env);
            case "deferred": return v.value ? inspect(v.value) : fresh();
            case "lazyList": return v.value ? inspect(v.value) : sequence(v.exprs.map(e => expr(e, v.env)));
            case "list": return sequence(v.v.map(inspect));
            case "range": return list(named("Int"));
            case "floatRange": return list(named("Float"));
            case "rationalRange": return list(named("Fraction"));
            case "cons": { const t = list(inspect(v.head)); unify(t, inspect(v.tail)); return t; }
            case "contract": return arrow(named(typeToString(v.from)), named(typeToString(v.to)));
            case "closure": return fn(v.params.map(name => ({ p: "var", name })), v.body, v.env);
            case "clauseFn": return join(v.clauses.map(c => fn(c.params, c.body, v.env, v.applied)));
            case "native": {
                const a = fresh(), b = fresh();
                let result: Shape;
                if (v.family && v.tag) {
                    const c = constructor(v.family, v.tag);
                    result = c.fields.reduceRight((result, input) => arrow(input, result), c.result);
                } else {
                    const signatures: Record<string, Shape> = {
                        print: arrow(a, named("[]")), head: arrow(list(a), a), tail: arrow(list(a), list(a)),
                        map: arrow(arrow(a, b), arrow(list(a), list(b))),
                        filter: arrow(arrow(a, b), arrow(list(a), list(a))),
                        length: arrow(a, named("Int")), null: arrow(a, named("Bool")),
                        fail: arrow(named("String"), a),
                    };
                    result = signatures[v.name] ?? Array.from({ length: v.arity }, fresh).reduceRight((result, input) => arrow(input, result), fresh());
                }
                for (const arg of v.applied) result = apply(result, inspect(arg));
                return v.arity ? result : arrow(named("[]"), result);
            }
            case "variant": return v.family ? constructor(v.family, v.tag).result : named("Variant");
            default: return named({ bool: "Bool", string: "String", char: "Char", record: "Record", mutable: "Mutable", pointer: "Pointer", hashmap: "HashMap", nomatch: "a" }[v.kind]);
        }
    }
    const names = new Map<Shape, string>();
    function show(t: Shape, precedence = 0): string {
        t = resolve(t);
        switch (t.tag) {
            case "var": {
                if (!names.has(t)) { const n = names.size; names.set(t, String.fromCharCode(97 + n % 26) + (n >= 26 ? Math.floor(n / 26) : "")); }
                return names.get(t)!;
            }
            case "list": return `[${show(t.element)}]`;
            case "name": {
                const text = t.name + t.args.map(a => " " + show(a, 2)).join("");
                return t.args.length && precedence > 1 ? `(${text})` : text;
            }
            case "arrow": { const text = `${show(t.from, 1)} -> ${show(t.to)}`; return precedence > 0 ? `(${text})` : text; }
            case "union": return [...new Set(t.choices.flatMap(c => resolve(c).tag === "union" ? (resolve(c) as Extract<Shape, { tag: "union" }>).choices.map(x => show(x)) : [show(c)]))].join(" | ");
        }
    }
    return show(inspect(value));
}
