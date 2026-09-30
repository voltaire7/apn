import { type Expr, type Pattern, sourceLocations, type TopLevel } from "./ast.ts";
import { castNumeric, NUMERIC_TYPES, numericType, TYPE_NAMES } from "./type-system.ts";
import { APNError } from "./errors.ts";
import { parseDocument } from "./parser.ts";

type Index = { constant: bigint; terms: Map<string, bigint> };
type Ty =
    | { k: "overload"; choices: Ty[] }
    | { k: "dynamic" }
    | { k: "var"; link?: Ty }
    | { k: "atom"; name: string }
    | { k: "fn"; input: Ty; output: Ty; binder?: string }
    | { k: "list"; element: Ty; length?: Index; items?: Ty[] }
    | { k: "record"; fields: Map<string, Ty> }
    | { k: "type"; value: Ty }
    | { k: "factory"; args: Entry[] }
    | { k: "alias"; params: string[]; body: Expr; scope: Scope; args: Entry[] }
    | { k: "variant"; name: string; args: Ty[] };
interface Entry {
    type: Ty;
    index?: Index;
    boolean?: boolean;
    mono?: boolean;
    inherited?: boolean;
    nonGeneric?: Set<Ty>;
}
type Scope = Map<string, Entry>;
export interface TypeIssue {
    message: string;
    pos: number;
    len: number;
}
export interface CheckResult {
    issues: TypeIssue[];
    dynamicBoundaries: number;
}
const dynamic: Ty = { k: "dynamic" };
const variable = (): Ty => ({ k: "var" });
const atom = (name: string): Ty => name === "Dynamic" ? dynamic : { k: "atom", name };
const fn = (input: Ty, output: Ty, binder?: string): Ty => ({ k: "fn", input, output, binder });
const list = (element: Ty, length?: Index): Ty => ({ k: "list", element, length });
const constant = (n: bigint): Index => ({ constant: n, terms: new Map() });
const resolve = (t: Ty): Ty => t.k === "var" && t.link ? resolve(t.link) : t;
function indexAdd(a: Index, b: Index, scale = 1n): Index {
    const terms = new Map(a.terms);
    for (const [key, value] of b.terms) {
        const n = (terms.get(key) ?? 0n) + value * scale;
        if (n) terms.set(key, n);
        else terms.delete(key);
    }
    return { constant: a.constant + b.constant * scale, terms };
}
function indexScale(a: Index, n: bigint): Index {
    return indexAdd(constant(0n), a, n);
}
function indexText(n: Index): string {
    return [
        ...[...n.terms].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${value}*${key}`),
        String(n.constant),
    ].join("+");
}
function text(t: Ty): string {
    t = resolve(t);
    switch (t.k) {
        case "overload":
            return t.choices.map(text).join(" | ");
        case "dynamic":
            return "Dynamic";
        case "var":
            return "an unresolved type";
        case "atom":
            return t.name;
        case "fn":
            return `(${text(t.input)} -> ${text(t.output)})`;
        case "list":
            return t.length ? `Vector ${indexText(t.length)} ${text(t.element)}` : `[${text(t.element)}]`;
        case "record":
            return `[${[...t.fields].map(([k, v]) => `${k}: ${text(v)}`).join(", ")}]`;
        case "type":
            return `Type (${text(t.value)})`;
        case "variant":
            return t.name + t.args.map((x) => " " + text(x)).join("");
        default:
            return "a type constructor";
    }
}
function children(t: Ty): Ty[] {
    switch (t.k) {
        case "overload":
            return t.choices;
        case "fn":
            return [t.input, t.output];
        case "list":
            return [t.element];
        case "type":
            return [t.value];
        case "record":
            return [...t.fields.values()];
        case "variant":
            return t.args;
        default:
            return [];
    }
}
function occurs(v: Ty, t: Ty): boolean {
    t = resolve(t);
    return v === t || children(t).some((x) => occurs(v, x));
}
function variables(t: Ty, found = new Set<Ty>()): Set<Ty> {
    t = resolve(t);
    if (t.k === "var") found.add(t);
    else children(t).forEach((x) => variables(x, found));
    return found;
}
function captured(scope: Scope): Set<Ty> {
    const found = new Set<Ty>();
    for (const entry of scope.values()) {
        if (entry.mono) variables(entry.type, found);
        for (const t of entry.nonGeneric ?? []) variables(t, found);
    }
    return found;
}
function instantiate(entry: Entry): Ty {
    return entry.mono
        ? entry.type
        : copy(entry.type, new Map([...(entry.nonGeneric ?? [])].map((t) => [resolve(t), resolve(t)])));
}
function copy(t: Ty, vars = new Map<Ty, Ty>(), subst?: [string, Index]): Ty {
    t = resolve(t);
    if (t.k === "var") {
        if (!vars.has(t)) vars.set(t, variable());
        return vars.get(t)!;
    }
    const go = (x: Ty) => copy(x, vars, subst);
    switch (t.k) {
        case "overload":
            return { ...t, choices: t.choices.map(go) };
        case "fn":
            return { ...t, input: go(t.input), output: go(t.output) };
        case "list": {
            let length = t.length;
            if (length && subst && length.terms.has(subst[0])) {
                const terms = new Map(length.terms), coefficient = terms.get(subst[0])!;
                terms.delete(subst[0]);
                length = indexAdd({ constant: length.constant, terms }, subst[1], coefficient);
            }
            return { ...t, element: go(t.element), items: t.items?.map(go), length };
        }
        case "record":
            return { k: "record", fields: new Map([...t.fields].map(([k, v]) => [k, go(v)])) };
        case "type":
            return { k: "type", value: go(t.value) };
        case "variant":
            return { ...t, args: t.args.map(go) };
        default:
            return t;
    }
}

// This checker never evaluates APN expressions or follows imports/load. Unknown
// operations are explicit gradual boundaries; concrete contradictions are errors.
export function checkTypes(program: TopLevel[]): CheckResult {
    const issues: TypeIssue[] = [];
    // Rebound value indices are dynamic: a lazy type alias can observe a later
    // binding, so freezing its first literal value would reject valid APN.
    const writes = new Map<string, number>();
    const note = (name: string) => writes.set(name, (writes.get(name) ?? 0) + 1);
    const scan = (node: unknown): void => {
        if (!node || typeof node !== "object") return;
        const value = node as Record<string, any>;
        if ((value.t === "def" || value.t === "stmDef") && value.clauses?.[0]?.params.length === 0) note(value.name);
        if (value.t === "patDef" && value.pattern?.p === "var") note(value.pattern.name);
        if (value.t === "setFields") { for (const key of value.entries) note(key); }
        for (const child of Object.values(value)) scan(child);
    };
    scan(program);
    let dynamicBoundaries = 0, serial = 0, budget = 50000;
    const unknown = (): Ty => {
        dynamicBoundaries++;
        return dynamic;
    };
    const problem = (message: string, e?: Expr): never => {
        const loc = e && sourceLocations.get(e);
        throw {
            message,
            pos: loc?.start ?? 0,
            len: Math.max(1, (loc?.end ?? 1) - (loc?.start ?? 0)),
        } satisfies TypeIssue;
    };
    function unify(expected: Ty, actual: Ty, e?: Expr): void {
        expected = resolve(expected);
        actual = resolve(actual);
        if (expected === actual) return;
        if (expected.k === "dynamic" || actual.k === "dynamic") {
            dynamicBoundaries++;
            return;
        }
        if (expected.k === "var") {
            if (occurs(expected, actual)) problem("recursive type requires a Dynamic boundary", e);
            expected.link = actual;
            return;
        }
        if (actual.k === "var") return unify(actual, expected, e);
        if (expected.k === "atom" && expected.name === "Type" && actual.k === "type") return;
        if (expected.k === "atom" && actual.k === "atom") {
            if (expected.name === actual.name) return;
            if (expected.name === "Number" && NUMERIC_TYPES.includes(actual.name)) return;
        }
        if (expected.k === "fn" && actual.k === "fn") {
            unify(expected.input, actual.input, e);
            unify(expected.output, actual.output, e);
            return;
        }
        if (expected.k === "list" && actual.k === "list") {
            unify(expected.element, actual.element, e);
            if (expected.length && actual.length) {
                const delta = indexAdd(expected.length, actual.length, -1n);
                if (!delta.terms.size && delta.constant !== 0n) {
                    problem(
                        `length mismatch: expected ${indexText(expected.length)}, got ${indexText(actual.length)}`,
                        e,
                    );
                }
                if (delta.terms.size) dynamicBoundaries++;
            } else if (expected.length) dynamicBoundaries++;
            return;
        }
        if (expected.k === "record" && actual.k === "record") {
            for (const [key, type] of expected.fields) {
                if (!actual.fields.has(key)) problem(`missing field '${key}'`, e);
                unify(type, actual.fields.get(key)!, e);
            }
            return;
        }
        if (expected.k === "type" && actual.k === "type") return unify(expected.value, actual.value, e);
        if (
            expected.k === "variant" && actual.k === "variant" && expected.name === actual.name &&
            expected.args.length === actual.args.length
        ) {
            expected.args.forEach((t, i) => unify(t, actual.args[i], e));
            return;
        }
        problem(`cannot use ${text(actual)} where ${text(expected)} is required`, e);
    }
    function boolean(e: Expr, scope: Scope): boolean | undefined {
        if (e.t === "bool") return e.v;
        if (e.t === "int") return e.v !== 0n;
        if (e.t === "string") return e.v.length > 0;
        if (e.t === "unop" && e.op === "not") {
            const b = boolean(e.e, scope);
            return b === undefined ? undefined : !b;
        }
        if (e.t === "binop" && ["==", "!=", "<", ">", "<=", ">="].includes(e.op)) {
            const a = index(e.l, scope), b = index(e.r, scope);
            if (a && b && !a.terms.size && !b.terms.size) {
                const x = a.constant, y = b.constant;
                return e.op === "=="
                    ? x === y
                    : e.op === "!="
                    ? x !== y
                    : e.op === "<"
                    ? x < y
                    : e.op === ">"
                    ? x > y
                    : e.op === "<="
                    ? x <= y
                    : x >= y;
            }
        }
        if (e.t === "var") return scope.get(e.name)?.boolean;
        if (e.t === "block" && e.stmts.length === 1) return boolean(e.stmts[0], scope);
        return undefined;
    }
    function index(e: Expr, scope: Scope): Index | undefined {
        if (e.t === "int") return constant(e.v);
        if (e.t === "numeric" && e.v.kind === "int") return constant(e.v.v);
        if (e.t === "var") return scope.get(e.name)?.index;
        if (e.t === "block" && e.stmts.length === 1) return index(e.stmts[0], scope);
        if (e.t === "unop" && e.op === "neg") {
            const a = index(e.e, scope);
            return a && indexScale(a, -1n);
        }
        if (e.t === "binop") {
            const a = index(e.l, scope), b = index(e.r, scope);
            if (!a || !b) return;
            if (e.op === "+" || e.op === "-") return indexAdd(a, b, e.op === "+" ? 1n : -1n);
            if (e.op === "*" && !a.terms.size) return indexScale(b, a.constant);
            if (e.op === "*" && !b.terms.size) return indexScale(a, b.constant);
        }
    }
    function typeExpr(e: Expr, scope: Scope): Ty {
        const t = resolve(infer(e, scope));
        if (t.k === "type") return t.value;
        if (t.k === "dynamic") return unknown();
        if (t.k === "list") {
            return list(
                resolve(t.element).k === "type" ? (resolve(t.element) as Extract<Ty, { k: "type" }>).value : dynamic,
                t.length,
            );
        }
        if (t.k === "record") {
            return {
                k: "record",
                fields: new Map(
                    [...t.fields].map((
                        [key, value],
                    ) => [
                        key,
                        resolve(value).k === "type" ? (resolve(value) as Extract<Ty, { k: "type" }>).value : value,
                    ]),
                ),
            };
        }
        return problem("expected a type description", e);
    }
    function bind(p: Pattern, expected: Ty, scope: Scope, e: Expr): void {
        switch (p.p) {
            case "wildcard":
                return;
            case "var":
                scope.set(p.name, { type: expected, mono: true });
                return;
            case "int":
            case "range":
                return unify(expected, atom("Int"), e);
            case "bool":
                return unify(expected, atom("Bool"), e);
            case "string":
                return unify(expected, atom("String"), e);
            case "schema": {
                const t = typeExpr(p.type, scope);
                unify(t, expected, e);
                bind(p.value, t, scope, e);
                return;
            }
            case "typeBind":
                scope.set(p.name, { type: atom("Type"), mono: true });
                bind(p.value, expected, scope, e);
                return;
            case "contract": {
                const spec = (s: typeof p.spec): Ty => "name" in s ? atom(s.name) : fn(spec(s.from), spec(s.to));
                const t = spec(p.spec);
                unify(t, expected, e);
                bind(p.value, t, scope, e);
                return;
            }
            case "list": {
                const a = variable();
                unify(list(a), expected, e);
                p.v.forEach((x) => bind(x, a, scope, e));
                return;
            }
            case "cons": {
                const a = variable(), t = list(a);
                unify(t, expected, e);
                bind(p.head, a, scope, e);
                bind(p.tail, t, scope, e);
                return;
            }
            case "recPat": {
                const fields = new Map<string, Ty>();
                for (const [key, name] of p.v) {
                    const t = variable();
                    fields.set(key, t);
                    scope.set(name, { type: t, mono: true });
                }
                unify({ k: "record", fields }, expected, e);
                return;
            }
            case "constr": {
                const entry = scope.get(p.tag), t = entry ? copy(entry.type) : dynamic;
                if (p.tag === "Type") {
                    const payload: Ty = { k: "type", value: variable() };
                    unify(payload, expected, e);
                    p.args.forEach((x) => bind(x, payload, scope, e));
                    return;
                }
                if (t.k === "type") {
                    unify(t.value, expected, e);
                    p.args.forEach((x) => bind(x, t.value, scope, e));
                    return;
                }
                let rest: Ty = t;
                for (const arg of p.args) {
                    const f = resolve(rest);
                    if (f.k !== "fn") {
                        bind(arg, unknown(), scope, e);
                        continue;
                    }
                    bind(arg, f.input, scope, e);
                    rest = f.output;
                }
                unify(rest, expected, e);
                return;
            }
        }
    }
    function convert(target: Ty, actual: Ty, e: Expr): Ty {
        const t = resolve(target), a = resolve(actual);
        if (t.k === "atom" && t.name === "Bool") return t;
        if (t.k === "atom" && a.k === "atom" && NUMERIC_TYPES.includes(t.name) && NUMERIC_TYPES.includes(a.name)) {
            if (t.name === a.name) return target;
            // Literal conversion is decidable; unknown magnitudes retain runtime losslessness checks.
            const literal = e.t === "numeric"
                ? e.v
                : e.t === "int"
                ? { kind: "int" as const, v: e.v }
                : e.t === "float"
                ? { kind: "float" as const, v: e.v }
                : undefined;
            if (literal) {
                try {
                    castNumeric(t.name, literal);
                } catch (error) {
                    problem((error as Error).message, e);
                }
            } else dynamicBoundaries++;
            return target;
        }
        if (t.k === "list" && a.k === "list") {
            unify(list(dynamic, t.length), list(dynamic, a.length), e);
            if (a.items) a.items.forEach((item, n) => convert(t.element, item, e.t === "list" ? e.v[n] ?? e : e));
            else convert(t.element, a.element, e);
            return target;
        }
        if (t.k === "record" && a.k === "record") {
            for (const [key, type] of t.fields) {
                if (!a.fields.has(key)) problem(`missing field '${key}'`, e);
                convert(type, a.fields.get(key)!, e.t === "record" ? e.v.find(([k]) => key === k)?.[1] ?? e : e);
            }
            return target;
        }
        unify(target, actual, e);
        return target;
    }
    function application(f: Ty, argument: Entry, e: Expr): Ty {
        f = resolve(f);
        if (f.k === "dynamic") return unknown();
        if (f.k === "overload") {
            const outputs: Ty[] = [];
            for (const choice of f.choices) {
                try {
                    outputs.push(application(copy(choice), { ...argument, type: copy(argument.type) }, e));
                } catch (error) {
                    if (!error || typeof error !== "object" || !("message" in error)) throw error;
                }
            }
            if (!outputs.length) return problem(`no overload accepts ${text(argument.type)}`, e);
            if (outputs.length === 1 || outputs.every((x) => text(x) === text(outputs[0]))) return outputs[0];
            if (outputs.every((x) => resolve(x).k === "fn")) return { k: "overload", choices: outputs };
            return unknown();
        }
        if (f.k === "factory") {
            const args = [...f.args, argument];
            if (args.length === 1) {
                convert(atom("Int"), argument.type, e);
                if (argument.index && !argument.index.terms.size && argument.index.constant < 0n) {
                    problem("Vector length must be nonnegative", e);
                }
                return { k: "factory", args };
            }
            let element = resolve(argument.type);
            if (element.k === "var") {
                const payload: Ty = { k: "type", value: variable() };
                unify(element, payload, e);
                element = payload;
            }
            if (element.k !== "type" && element.k !== "dynamic") problem("Vector element must be a type", e);
            if (!args[0].index) dynamicBoundaries++;
            return { k: "type", value: list(element.k === "type" ? element.value : dynamic, args[0].index) };
        }
        if (f.k === "alias") {
            const args = [...f.args, argument];
            if (args.length < f.params.length) return { ...f, args };
            const scope = new Map(f.scope);
            f.params.forEach((name, i) => scope.set(name, args[i]));
            return infer(f.body, scope);
        }
        if (f.k === "type") {
            const t = resolve(f.value), a = resolve(argument.type);
            if (t.k === "atom") {
                if (t.name === "Type" && ["type", "factory", "alias"].includes(a.k)) return argument.type;
                if (t.name === "List" && a.k === "list") return a;
                if (t.name === "Record" && a.k === "record") return a;
                if (t.name === "Function" && (a.k === "fn" || a.k === "overload")) return a;
                if (t.name === "Mutable") return t;
                if (t.name === "HashMap" && (a.k === "list" || a.k === "record")) {
                    dynamicBoundaries++;
                    return t;
                }
                if (t.name === "String" && a.k === "list") {
                    unify(atom("Char"), a.element, e);
                    return t;
                }
            }
            if (t.k === "variant" && a.k === "type") {
                const parameter = t.args.find((x) => resolve(x).k === "var");
                if (parameter) {
                    unify(parameter, a.value, e);
                    return f;
                }
            }
            return convert(f.value, argument.type, e);
        }
        if (f.k === "var") {
            const result = variable();
            unify(f, fn(argument.type, result), e);
            return result;
        }
        if (f.k === "fn") {
            convert(f.input, argument.type, e);
            return f.binder && argument.index
                ? copy(f.output, new Map([...variables(f.output)].map((t) => [t, t])), [f.binder, argument.index])
                : f.output;
        }
        if (f.k === "list") {
            const a = resolve(argument.type);
            if (a.k === "atom" && a.name === "Int") return f.element;
            if (a.k === "list") return list(f.element, a.length);
            // Enumeration indexing remains dynamic.
            return unknown();
        }
        if (f.k === "record") {
            const a = resolve(argument.type);
            if (a.k === "atom") return unknown();
            if (a.k === "record" || a.k === "list") {
                const supplied = a.k === "record"
                    ? a.fields
                    : new Map([...f.fields.keys()].map((k, i) => [k, a.items?.[i] ?? dynamic]));
                if (a.k === "list" && a.items && a.items.length && a.items.length !== f.fields.size) {
                    problem(`record needs ${f.fields.size} positional values, got ${a.items.length}`, e);
                }
                const fields = new Map(f.fields);
                for (const [key, target] of fields) {
                    const t = resolve(target), value = supplied.get(key);
                    fields.set(key, t.k === "type" ? value ? convert(t.value, value, e) : t.value : value ?? t);
                }
                for (const [key, value] of supplied) if (!fields.has(key)) fields.set(key, value);
                return { k: "record", fields };
            }
        }
        // Numeric defaults are only replaceable inside container templates.
        if (f.k === "atom" && NUMERIC_TYPES.includes(f.name)) return problem("cannot apply a number", e);
        if (f.k === "atom" && ["String", "Char", "Bool"].includes(f.name)) {
            unify(f, argument.type, e);
            return argument.type;
        }
        return problem(`cannot apply ${text(f)}`, e);
    }
    function infer(e: Expr, scope: Scope): Ty {
        if (--budget < 0) return unknown();
        switch (e.t) {
            case "int":
                return atom("Int");
            case "float":
                return atom("Float");
            case "numeric":
                return atom(numericType(e.v));
            case "bool":
                return atom("Bool");
            case "char":
                return atom("Char");
            case "string":
                return atom("String");
            case "var": {
                const entry = scope.get(e.name);
                return entry ? instantiate(entry) : unknown();
            }
            case "placeholder":
                return unknown();
            case "import":
                return unknown();
            case "functionType": {
                const spec = (s: typeof e.spec): Ty => "name" in s ? atom(s.name) : fn(spec(s.from), spec(s.to));
                return { k: "type", value: spec(e.spec) };
            }
            case "list": {
                const items = e.v.map((x) => infer(x, scope));
                let element: Ty = items[0] ?? variable();
                for (const item of items.slice(1)) {
                    if (text(resolve(item)) !== text(resolve(element))) {
                        element = dynamic;
                        break;
                    }
                }
                return { k: "list", element, length: constant(BigInt(items.length)), items };
            }
            case "record":
                return { k: "record", fields: new Map(e.v.map(([key, value]) => [key, infer(value, scope)])) };
            case "range":
                return list(
                    atom("Int"),
                    e.hi !== null && e.step !== 0n
                        ? constant(
                            (e.step > 0n && e.lo > e.hi) || (e.step < 0n && e.lo < e.hi)
                                ? 0n
                                : (e.hi - e.lo) / e.step + 1n,
                        )
                        : undefined,
                );
            case "floatRange":
                return list(atom("Float"));
            case "rationalRange":
                return list(atom("Fraction"));
            case "lambda":
                return functionType(e.params.map((name) => ({ p: "var", name })), e.body, scope);
            case "patternLambda":
                return functionType(e.params, e.body, scope);
            case "app":
            case "pipe": {
                const a = e.t === "app" ? e.a : e.x;
                return application(infer(e.f, scope), {
                    type: infer(a, scope),
                    index: index(a, scope),
                    boolean: boolean(a, scope),
                }, a);
            }
            case "setFields": {
                const rec = resolve(infer(e.rec, scope)), value = infer(e.value, scope), v = resolve(value);
                if (rec.k === "dynamic") return unknown();
                if (rec.k !== "record") return problem("field assignment requires a record", e);
                const fields = new Map(rec.fields);
                if (e.entries.length > 1 && v.k === "list" && v.items && v.items.length !== e.entries.length) {
                    problem("field assignment length mismatch", e);
                }
                e.entries.forEach((key, n) => {
                    const incoming = v.k === "list" ? v.items?.[n] ?? v.element : dynamic;
                    const previous = fields.get(key), old = previous && resolve(previous);
                    fields.set(
                        key,
                        old && old.k !== "type"
                            ? convert(old, incoming, e.value.t === "list" ? e.value.v[n] ?? e.value : e.value)
                            : incoming,
                    );
                });
                return { k: "record", fields };
            }
            case "setItem": {
                const rec = resolve(infer(e.rec, scope)), value = infer(e.value, scope), key = index(e.index, scope);
                if (rec.k === "list") {
                    const keys = resolve(infer(e.index, scope));
                    if (keys.k === "list") {
                        const incoming = resolve(value);
                        if (incoming.k !== "list") { dynamicBoundaries++; return rec; }
                        if (keys.items && incoming.items && keys.items.length !== incoming.items.length) problem("index count does not match value count", e);
                        const slots = e.index.t === "list" ? e.index.v : [];
                        slots.forEach((slot, n) => {
                            const k = index(slot, scope);
                            if (k && !k.terms.size && rec.length && !rec.length.terms.size &&
                                (k.constant >= rec.length.constant || k.constant < -rec.length.constant)) problem("list index out of range", slot);
                            convert(rec.element, incoming.items?.[n] ?? incoming.element, e.value.t === "list" ? e.value.v[n] ?? e.value : e.value);
                        });
                        if (!slots.length) dynamicBoundaries++;
                        return rec;
                    }
                    if (
                        key && !key.terms.size && rec.length && !rec.length.terms.size &&
                        (key.constant >= rec.length.constant || key.constant < -rec.length.constant)
                    ) problem("list index out of range", e.index);
                    convert(rec.element, value, e.value);
                    return rec;
                }
                if (rec.k === "record" && e.index.t === "string") {
                    const fields = new Map(rec.fields), old = fields.get(e.index.v);
                    fields.set(e.index.v, old && resolve(old).k !== "type" ? convert(old, value, e.value) : value);
                    return { k: "record", fields };
                }
                return unknown();
            }
            case "pluck": {
                const rec = resolve(infer(e.rec, scope));
                if (rec.k === "record" && e.quoted !== false) {
                    const selected = e.entries.map(entry => {
                        const key = typeof entry === "string" ? entry : entry[0];
                        return rec.fields.get(key) ?? problem(`missing field '${key}'`, e);
                    });
                    return e.entries.every(x => typeof x === "string")
                        ? { k: "list", element: dynamic, length: constant(BigInt(selected.length)), items: selected }
                        : { k: "record", fields: new Map(e.entries.map((x, n) => [(x as [string, string])[1], selected[n]])) };
                }
                if (e.values) infer(e.values, scope);
                return unknown();
            }
            case "recordAccess": {
                const rec = resolve(infer(e.rec, scope));
                if (rec.k === "list" && e.argument) { infer(e.argument, scope); return unknown(); }
                if (rec.k === "var") {
                    const t = variable();
                    unify(rec, { k: "record", fields: new Map([[e.field, t]]) }, e);
                    return t;
                }
                if (rec.k === "dynamic") return unknown();
                if (rec.k !== "record") return problem("field access requires a record", e);
                if (!rec.fields.has(e.field)) return problem(`missing field '${e.field}'`, e);
                return rec.fields.get(e.field)!;
            }
            case "ternary": {
                infer(e.cond, scope);
                const known = boolean(e.cond, scope);
                if (known !== undefined) return infer(known ? e.then : e.els, scope);
                const a = infer(e.then, scope), b = infer(e.els, scope);
                if (resolve(a).k === "type" && resolve(b).k === "type" && text(a) !== text(b)) {
                    dynamicBoundaries++;
                    return { k: "type", value: dynamic };
                }
                unify(a, b, e);
                return a;
            }
            case "binop": {
                const a = infer(e.l, scope), b = infer(e.r, scope);
                if (["==", "!=", "<", ">", "<=", ">=", "&&", "||"].includes(e.op)) return atom("Bool");
                if (e.op === ":") {
                    unify(list(a), b, e);
                    return list(a);
                }
                if (e.op === "++") {
                    const x = resolve(a), y = resolve(b);
                    if (x.k === "list" && y.k === "list") {
                        unify(x.element, y.element, e);
                        return list(x.element, x.length && y.length ? indexAdd(x.length, y.length) : undefined);
                    }
                    unify(atom("String"), a, e);
                    unify(a, b, e);
                    return a;
                }
                // Numeric/array arithmetic and callable * retain runtime overload selection.
                const x = resolve(a), y = resolve(b);
                if (x.k === "atom" && y.k === "atom") {
                    if (NUMERIC_TYPES.includes(x.name) && NUMERIC_TYPES.includes(y.name)) {
                        return e.op === "/" ? unknown() : x.name === y.name ? x : atom("Number");
                    }
                    if (e.op === "+" && x.name === "String" && y.name === "String") return atom("String");
                    return problem(`operator '${e.op}' cannot combine ${text(x)} and ${text(y)}`, e);
                }
                if (e.op !== "*" && e.op !== "-" && e.op !== "\\" && (x.k === "type" || y.k === "type")) {
                    return problem(`operator '${e.op}' requires values, not a type constructor`, e);
                }
                return unknown();
            }
            case "unop":
                return e.op === "not" ? atom("Bool") : infer(e.e, scope);
            case "block": {
                const child: Scope = new Map([...scope].map(([name, entry]) => [name, { ...entry, inherited: true }]));
                let result: Ty = list(dynamic, constant(0n));
                for (const s of e.stmts) result = infer(s, child);
                return result;
            }
            case "stmDef":
                define(e.name, e.clauses, scope, e);
                return list(dynamic, constant(0n));
            case "patDef": {
                const t = infer(e.value, scope);
                if (e.pattern.p === "var") {
                    const old = scope.get(e.pattern.name);
                    if (old && !old.inherited && e.value.t !== "setFields" && e.value.t !== "setItem") {
                        unify(old.type, t, e);
                    }
                    scope.set(e.pattern.name, {
                        type: t,
                        index: (writes.get(e.pattern.name) ?? 0) > 1 ? undefined : index(e.value, scope),
                        boolean: (writes.get(e.pattern.name) ?? 0) > 1 ? undefined : boolean(e.value, scope),
                        nonGeneric: captured(scope),
                    });
                } else bind(e.pattern, t, scope, e);
                return list(dynamic, constant(0n));
            }
            default:
                return unknown();
        }
    }
    function functionType(params: Pattern[], body: Expr, parent: Scope): Ty {
        const scope = new Map(parent), inputs: { type: Ty; binder?: string }[] = [];
        for (const p of params) {
            const t = variable();
            bind(p, t, scope, body);
            const name = p.p === "var"
                ? p.name
                : p.p === "constr" && p.args.length === 1 && p.args[0].p === "var"
                ? p.args[0].name
                : undefined;
            const binder = name ? `n${serial++}` : undefined;
            if (name) {
                scope.set(name, {
                    ...scope.get(name)!,
                    mono: true,
                    index: { constant: 0n, terms: new Map([[binder!, 1n]]) },
                });
            }
            inputs.push({ type: t, binder });
        }
        let result = infer(body, scope);
        for (let n = inputs.length - 1; n >= 0; n--) result = fn(inputs[n].type, result, inputs[n].binder);
        return result;
    }
    function define(name: string, clauses: { params: Pattern[]; body: Expr }[], scope: Scope, location: Expr): void {
        if (/^[A-Z]/.test(name) && clauses[0].params.every((p) => p.p === "var")) {
            const c = clauses[0];
            scope.set(name, {
                type: c.params.length
                    ? {
                        k: "alias",
                        params: c.params.map((p) => (p as Extract<Pattern, { p: "var" }>).name),
                        body: c.body,
                        scope: new Map(scope),
                        args: [],
                    }
                    : infer(c.body, scope),
            });
            return;
        }
        const previous = scope.get(name);
        const collection = previous && resolve(previous.type), c = clauses[0];
        if (collection && (collection.k === "list" || collection.k === "record") && c.params.length === 1) {
            const p = c.params[0];
            const asKey = (p: Pattern): Expr | undefined => {
                if (p.p === "var") return { t: "var", name: p.name };
                if (p.p === "int") return { t: "int", v: p.v };
                if (p.p === "string") return { t: "string", v: p.v };
                if (p.p === "constr" && !p.args.length) return { t: "var", name: p.tag };
                if (p.p === "list") {
                    const values = p.v.map(asKey);
                    if (values.every((v): v is Expr => v !== undefined)) return { t: "list", v: values };
                }
                return undefined;
            };
            const key = asKey(p);
            if (key) {
                const t = infer({ t: "setItem", rec: { t: "var", name }, index: key, value: c.body }, scope);
                scope.set(name, { type: t });
                return;
            }
        }
        if (!clauses[0].params.length) {
            const t = infer(clauses[0].body, scope);
            if (previous && !previous.inherited) unify(previous.type, t, location);
            scope.set(name, {
                type: t,
                index: (writes.get(name) ?? 0) > 1 ? undefined : index(clauses[0].body, scope),
                boolean: (writes.get(name) ?? 0) > 1 ? undefined : boolean(clauses[0].body, scope),
                nonGeneric: captured(scope),
            });
            return;
        }
        const nonGeneric = captured(scope);
        const pending = variable();
        scope.set(name, { type: pending, mono: true });
        const groups = new Map<string, Ty>();
        const domain = (t: Ty): string => {
            t = resolve(t);
            if (t.k !== "fn") return "";
            const input = resolve(t.input);
            return (input.k === "variant" ? input.name : input.k === "var" ? "*" : text(input)) + ";" +
                domain(t.output);
        };
        for (const c of clauses) {
            const t = functionType(c.params, c.body, scope), key = domain(t), existing = groups.get(key);
            if (existing) unify(existing, t, c.body);
            else groups.set(key, t);
        }
        const alternatives = [...groups.values()];
        if (alternatives.length === 1) {
            unify(pending, alternatives[0], location);
            scope.set(name, { type: pending, nonGeneric });
        } else scope.set(name, { type: { k: "overload", choices: alternatives }, nonGeneric });
    }
    const scope: Scope = new Map(TYPE_NAMES.map((name) => [name, { type: { k: "type", value: atom(name) } }]));
    scope.set("Vector", { type: { k: "factory", args: [] } });
    const a = variable(), b = variable();
    for (
        const [name, type] of Object.entries({
            print: fn(a, list(variable(), constant(0n))),
            head: fn(list(a), a),
            tail: fn(list(a), list(a)),
            map: fn(fn(a, b), fn(list(a), list(b))),
            filter: fn(fn(a, b), fn(list(a), list(a))),
            length: fn(dynamic, atom("Int")),
            typeOf: fn(a, atom("Type")),
            fail: fn(atom("String"), variable()),
        })
    ) scope.set(name, { type });
    for (const statement of program) {
        try {
            if (statement.t === "def") define(statement.name, statement.clauses, scope, statement.clauses[0].body);
            else if (statement.t === "type") {
                const d = statement.def, parameters = new Map((d.parameters ?? []).map((p) => [p, variable()]));
                const result: Ty = { k: "variant", name: d.name, args: [...parameters.values()] };
                scope.set(d.name, { type: { k: "type", value: result } });
                const fieldsScope = new Map(scope);
                for (const [name, t] of parameters) {
                    fieldsScope.set(name, { type: { k: "type", value: t }, mono: true });
                }
                for (const v of d.variants) {
                    let t = result as Ty;
                    for (const field of [...v.fields ?? []].reverse()) t = fn(typeExpr(field, fieldsScope), t);
                    scope.set(v.tag, { type: t });
                }
            } else if (statement.t === "expr") infer(statement.value, scope);
            else infer(statement, scope);
        } catch (error) {
            if (error && typeof error === "object" && "pos" in error && "message" in error) {
                issues.push(error as TypeIssue);
            } else throw error;
        }
    }
    return { issues, dynamicBoundaries };
}
export function checkSource(source: string, file = "<input>"): CheckResult {
    return checkTypes(parseDocument(source));
}
export function requireChecked(source: string, file = "<input>"): CheckResult {
    const result = checkSource(source, file);
    if (result.issues.length) {
        const first = result.issues[0];
        const error = new APNError("type", first.message, first);
        error.src = source;
        throw error;
    }
    return result;
}
export async function runTypeCheck(files: string[]): Promise<number> {
    if (!files.length) {
        console.error("usage: apn --check FILE.apn [...]");
        return 2;
    }
    let failed = false;
    for (const file of files) {
        try {
            const source = await Deno.readTextFile(file), result = checkSource(source, file);
            for (const issue of result.issues) {
                failed = true;
                console.error(`${file}:${source.slice(0, issue.pos).split("\n").length}: type error: ${issue.message}`);
            }
            if (!result.issues.length) {
                console.log(
                    `${file}: checked${
                        result.dynamicBoundaries
                            ? ` (${result.dynamicBoundaries} dynamic boundaries retain runtime checks)`
                            : ""
                    }`,
                );
            }
        } catch (error) {
            failed = true;
            console.error(String(error));
        }
    }
    return failed ? 1 : 0;
}
