import { type Expr, type Pattern, sourceLocations, type TopLevel } from "./ast.ts";
import { castNumeric, matchesType, NUMERIC_TYPES, numericType, TYPE_NAMES, typedArithmetic, typedPower } from "./type-system.ts";
import { compareNumbers, equalNumbers, floating, integer, negate, NUMBER_NATIVES, numericNative, type Numeric } from "./numbers.ts";
import { APNError, didYouMean } from "./errors.ts";
import { parse, parseDocument, rangeExpr } from "./parser.ts";

type Index = { constant: bigint; terms: Map<string, bigint> };
type Ty =
    | { k: "overload"; choices: Ty[] }
    | { k: "union"; choices: Ty[] }
    | { k: "mutable"; value: Ty }
    | { k: "map"; key: Ty; value: Ty }
    | { k: "intrinsic"; name: string; arity?: number; args?: Ty[] }
    // known: what a deferred call knows about its argument's value (a literal,
    // possibly symbolic in a parameter), so clause ranking can use it later.
    | { k: "operation"; op: string; args: Ty[]; solution?: Ty; known?: Known }
    | { k: "dynamic"; explicit?: boolean }
    | { k: "var"; link?: Ty }
    | { k: "atom"; name: string }
    // shape describes the full result in terms of the arguments (see Shape); args
    // collects argument types across curried application. Both describe the
    // function's code, so they are trusted only at a direct call by name.
    | { k: "fn"; input: Ty; output: Ty; binder?: string; coerce?: boolean; checks?: Ty[]; pattern?: Pattern; selfName?: string; shape?: Shape; args?: Ty[]; clauses?: ClauseOrder[]; callArgs?: Entry[]; summary?: Summary }
    | { k: "list"; element: Ty; length?: Index; items?: Ty[]; contracted?: boolean; preserve?: Set<number> }
    | { k: "record"; fields: Map<string, Ty>; open?: boolean; preserve?: Set<string> }
    | { k: "type"; value: Ty }
    | { k: "factory"; args: Entry[] }
    | { k: "alias"; params: string[]; body: Expr; scope: Scope; args: Entry[] }
    | { k: "variant"; name: string; args: Ty[]; ordinal?: boolean; base?: Ty };
// A function result's list structure in terms of its parameters, by position:
// `arg` is that argument itself; otherwise a list whose length is an argument's
// length or a constant, with an optional shape for each item.
type LengthRef = { param: number } | { constant: bigint };
interface Shape { arg?: number; length?: LengthRef; items?: (Shape | undefined)[] }
// A clause of an overload choice: its source index and patterns, plus the
// names that make a variable pattern refutable (repeated names compare values).
// callArgs collects a call's arguments so the complete call can be ranked as
// the runtime ranks clauses (see clauseFn dispatch in interp.ts).
interface ClauseOrder { index: number; params: Pattern[]; refutable: Set<string> }
// ref names the parameter (by binder) whose value this is, when the value
// itself is only known at that function's calls.
// tag is the constructor that visibly built the value (None, Some 5); call is
// a direct call whose result is evaluated once its arguments are known (they
// may refer to parameters of an enclosing function, substituted at its calls).
// number holds exact rationals and complex numbers (integers use index, floats
// float); expr is an expression over enclosing parameters, evaluated once
// they are known. size is the known length of a list, items what is known
// about each of its elements (when the whole list is known).
interface Known {
    index?: Index; size?: bigint; items?: Known[]; boolean?: boolean; string?: string; char?: string; float?: number; number?: Numeric; tag?: string; ref?: string;
    call?: { summary: Summary; args: Known[] };
    expr?: { e: Expr; env: [string, Known][]; scope: Scope };
}
// A function's clauses and defining scope, so a direct call by name can
// evaluate what its result value is from what is known about the arguments.
interface Summary { clauses: (ClauseOrder & { body: Expr })[]; scope: Scope }
interface Entry {
    type: Ty;
    index?: Index;
    size?: bigint;
    items?: Known[];
    boolean?: boolean;
    string?: string;
    char?: string;
    float?: number;
    tag?: string;
    number?: Numeric;
    ref?: string;
    call?: Known["call"];
    expr?: Known["expr"];
    clauses?: { params: Pattern[]; body: Expr }[];
    mono?: boolean;
    // inherited: visible from an enclosing scope (blocks mark every outer entry).
    inherited?: boolean;
    // builtin: a native or intrinsic from the checker's own root scope.
    builtin?: boolean;
    nonGeneric?: Set<Ty>;
}
export type TypeScope = Map<string, Entry>;
type Scope = TypeScope;
export interface CheckOptions {
    strict?: boolean;
    library?: boolean;
    extendDefinitions?: boolean;
    loads?: (path: string, scope: TypeScope) => TypeScope;
    initial?: TypeScope;
    imports?: (module: string | string[]) => TypeScope;
    result?: (scope: TypeScope, exports: TypeScope) => void;
    /** Names bound in the running interpreter; with it, other unknown names are reported as unbound. */
    runtimeNames?: ReadonlySet<string>;
}
export function copyTypeScope(scope: TypeScope): TypeScope {
    const nodes = new Map<Ty, Ty>(), vars = new Map<Ty, Ty>();
    return new Map([...scope].map(([name, entry]) => [name, {
        ...entry, type: copy(entry.type, vars, undefined, nodes),
        nonGeneric: entry.nonGeneric && new Set([...entry.nonGeneric].map(t => copy(t, vars, undefined, nodes))),
    }]));
}
export interface TypeIssue {
    message: string;
    pos: number;
    len: number;
    source?: string;
    file?: string;
    hint?: string;
}
export interface CheckResult {
    issues: TypeIssue[];
    dynamicBoundaries: number;
    runtimeChecks: number;
}
const dynamic: Ty = { k: "dynamic" };
const explicitDynamic: Ty = { k: "dynamic", explicit: true };
const isExplicit = (t: Ty): boolean => { const value = resolve(t); return value.k === "dynamic" && !!value.explicit; };
const variable = (): Ty => ({ k: "var" });
const atom = (name: string): Ty => name === "Dynamic" ? explicitDynamic : { k: "atom", name };
const fn = (input: Ty, output: Ty, binder?: string, coerce = false): Ty => ({ k: "fn", input, output, binder, coerce });
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
function text(
    t: Ty,
    active = new Map<Ty, string>(),
    recursive = new Set<Ty>(),
): string {
    if (active.size > 96) return "a deeply nested type";
    t = resolve(t);
    if (active.has(t)) {
        recursive.add(t);
        return active.get(t)!;
    }
    const nested = new Map(active);
    nested.set(t, `rec${active.size}`);
    const show = (x: Ty) => text(x, nested, recursive);
    const render = (): string => {
        switch (t.k) {
            case "overload":
            case "union":
                return t.choices.map(show).join(" | ");
            case "map": return `HashMap ${show(t.key)} ${show(t.value)}`;
            case "intrinsic": return t.name;
            case "operation":
                return `${t.op}(${t.args.map(show).join(", ")})`;
            case "dynamic":
                return "Dynamic";
            case "var":
                return "an unresolved type";
            case "atom":
                return t.name;
            case "fn":
                return `(${show(t.input)} -> ${show(t.output)})`;
            case "list":
                return t.length ? `Vect ${indexText(t.length)} ${show(t.element)}` : `[${show(t.element)}]`;
            case "record":
                return `[${[...t.fields].map(([k, v]) => `${k}: ${show(v)}`).join(", ")}]`;
            case "type":
                return `Type (${show(t.value)})`;
            case "variant":
                return t.name + t.args.map((x) => " " + show(x)).join("");
            default:
                return "a type constructor";
        }
    };
    const result = render();
    return recursive.has(t) ? `mu ${nested.get(t)}. ${result}` : result;
}
function children(t: Ty): Ty[] {
    switch (t.k) {
        case "overload":
        case "union":
            return t.choices;
        case "intrinsic": return t.args ?? [];
        case "mutable": return [t.value];
        case "map": return [t.key, t.value];
        case "operation":
            return [...t.args, ...t.solution ? [t.solution] : []];
        case "fn":
            return [t.input, t.output, ...t.checks ?? []];
        case "list":
            return [t.element];
        case "type":
            return [t.value];
        case "record":
            return [...t.fields.values()];
        case "variant":
            return [...t.args, ...t.base ? [t.base] : []];
        default:
            return [];
    }
}
// Types are finite graphs: self-application can introduce a back edge through
// a function node. Traversals must preserve sharing and visit each node once.
function variables(
    t: Ty,
    found = new Set<Ty>(),
    seen = new Set<Ty>(),
): Set<Ty> {
    t = resolve(t);
    if (seen.has(t)) return found;
    seen.add(t);
    if (t.k === "var") found.add(t);
    else children(t).forEach((x) => variables(x, found, seen));
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
// Builtins evaluated over lists whose size or elements are known.
const LIST_NATIVES = ["filter", "map", "take", "drop"];
// Standard-library functions that return a list as long as their final list
// argument, which the checker cannot derive from their code (they rebuild the
// list with a fold or a merge sort). tests/stdlib-length-test.ts verifies each
// one at runtime. sort, sortOn and forceList are inferred from these.
export const DECLARED_KEEPS_LENGTH = new Set(["reverse", "sortBy", "zipWithIndex"]);
function instantiate(entry: Entry): Ty {
    return entry.mono
        ? entry.type
        : copy(entry.type, new Map([...(entry.nonGeneric ?? [])].map((t) => [resolve(t), resolve(t)])));
}
// A parameter's value is now the argument's (a literal, or another parameter),
// in these facts and in the arguments of any pending call.
function substituteKnown(known: Known, subst?: [string, Index], value?: [string, Known]): Known {
    let result = known;
    if (result.index && subst && result.index.terms.has(subst[0])) result = { ...result, index: substituteIndex(result.index, subst) };
    if (result.ref && value && result.ref === value[0]) {
        const v = value[1];
        // The whole value is the argument's, its index included (none for a non-integer).
        result = { index: subst && known.index?.terms.has(subst[0]) ? result.index : v.index, size: v.size, items: v.items, boolean: v.boolean, string: v.string, char: v.char, float: v.float, number: v.number, tag: v.tag, ref: v.ref, call: v.call, expr: v.expr };
    }
    if (result.call) result = { ...result, call: { ...result.call, args: result.call.args.map(a => substituteKnown(a, subst, value)) } };
    if (result.items) result = { ...result, items: result.items.map(a => substituteKnown(a, subst, value)) };
    if (result.expr) result = { ...result, expr: { ...result.expr, env: result.expr.env.map(([n, k]) => [n, substituteKnown(k, subst, value)]) } };
    return result;
}
// The names a pattern binds.
function patternNames(p: Pattern): string[] {
    switch (p.p) {
        case "var": return [p.name];
        case "as": return [...patternNames(p.left), ...patternNames(p.right)];
        case "typeBind": return [p.name, ...patternNames(p.value)];
        case "schema": case "contract": return patternNames(p.value);
        case "list": return p.v.flatMap(patternNames);
        case "cons": return [...patternNames(p.head), ...patternNames(p.tail)];
        case "constr": return p.args.flatMap(patternNames);
        case "recPat": return p.v.map(([, binding]) => binding);
        default: return [];
    }
}
// Replace one symbolic term of an index with a value.
function substituteIndex(index: Index, [name, value]: [string, Index]): Index {
    const terms = new Map(index.terms), coefficient = terms.get(name)!;
    terms.delete(name);
    return indexAdd({ constant: index.constant, terms }, value, coefficient);
}
function copy(
    t: Ty,
    vars = new Map<Ty, Ty>(),
    subst?: [string, Index],
    nodes = new Map<Ty, Ty>(),
    value?: [string, Known],
): Ty {
    t = resolve(t);
    if (vars.has(t)) return vars.get(t)!;
    if (t.k === "var") {
        const fresh = variable();
        vars.set(t, fresh);
        return fresh;
    }
    if (nodes.has(t)) return nodes.get(t)!;
    // Register the shell before traversing children, so recursive edges point
    // into the new graph rather than the original polymorphic instance.
    const result = { ...t } as Ty;
    nodes.set(t, result);
    const go = (x: Ty) => copy(x, vars, subst, nodes, value);
    switch (t.k) {
        case "overload":
        case "union":
            Object.assign(result, { choices: t.choices.map(go) });
            break;
        case "intrinsic": Object.assign(result, { args: t.args?.map(go) }); break;
        case "mutable": Object.assign(result, { value: go(t.value) }); break;
        case "map": Object.assign(result, { key: go(t.key), value: go(t.value) }); break;
        case "operation":
            Object.assign(result, { args: t.args.map(go), solution: t.solution && go(t.solution), known: t.known && substituteKnown(t.known, subst, value) });
            break;
        case "fn":
            Object.assign(result, {
                input: go(t.input), output: go(t.output), checks: t.checks?.map(go),
                callArgs: t.callArgs?.map(a => ({ ...a, ...substituteKnown(a, subst, value), type: go(a.type) })),
            });
            break;
        case "list": {
            let length = t.length;
            if (length && subst && length.terms.has(subst[0])) length = substituteIndex(length, subst);
            Object.assign(result, {
                element: go(t.element),
                items: t.items?.map(go),
                length,
            });
            break;
        }
        case "record":
            Object.assign(result, {
                fields: new Map([...t.fields].map(([k, v]) => [k, go(v)])),
            });
            break;
        case "type":
            Object.assign(result, { value: go(t.value) });
            break;
        case "factory":
            Object.assign(result, { args: t.args.map(a => ({ ...a, type: go(a.type) })) });
            break;
        case "alias":
            Object.assign(result, { args: t.args.map(a => ({ ...a, type: go(a.type) })), scope: new Map([...t.scope].map(([name, entry]) => [name, { ...entry, type: go(entry.type) }])) });
            break;
        case "variant":
            Object.assign(result, { args: t.args.map(go), base: t.base && go(t.base) });
            break;
    }
    return result;
}

// Inference never evaluates APN. Dependency callbacks provide static module
// interfaces; unsupported operations require an explicit Dynamic boundary.
export function checkTypes(program: TopLevel[], options: CheckOptions = {}): CheckResult {
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
    let dynamicBoundaries = 0, runtimeChecks = 0, serial = 0, budget = 50000;
    let activeExpression: Expr | undefined, checkingExpression: Expr | undefined;
    let firstUnknown: Expr | undefined;
    let firstUnbound: { expr: Expr; name: string; hint?: string } | undefined;
    // Callee positions of application chains, where a function's shape is trusted.
    const callees = new WeakSet<Expr>();
    const unknown = (): Ty => {
        firstUnknown ??= activeExpression ?? checkingExpression;
        dynamicBoundaries++;
        return dynamic;
    };
    const problem = (message: string, e?: Expr): never => {
        const expression = e ?? activeExpression ?? checkingExpression;
        const loc = expression && sourceLocations.get(expression);
        throw {
            message,
            pos: loc?.start ?? 0,
            len: Math.max(1, (loc?.end ?? 1) - (loc?.start ?? 0)),
            source: loc?.source, file: loc?.file,
        } satisfies TypeIssue;
    };
    function spend(e?: Expr): void {
        if (--budget < 0) {
            problem("type checking limit exceeded; cannot establish the type", e);
        }
    }
    let requirements: Ty[] = [];
    const resolving = new Set<Ty>();
    function resolve(t: Ty): Ty {
        if (t.k === "var" && t.link) return resolve(t.link);
        if (t.k !== "operation") return t;
        if (resolving.has(t)) return t.solution ?? t;
        spend();
        if (resolving.size > 96) return problem("type checking limit exceeded; recursive operator constraints need an explicit type pattern");
        resolving.add(t);
        try { const result = evaluateOperation(t); return result === t ? t.solution ?? t : result; }
        finally { resolving.delete(t); }
    }
    // The length of a list derived element-for-element from xs.
    function sameLength(xs: Extract<Ty, { k: "list" }>): { length?: Index } {
        return xs.length ? { length: xs.length } : {};
    }
    function pair(key: Ty, value: Ty): Ty { return { k: "list", element: union([key, value]), items: [key, value], length: constant(2n) }; }
    function union(types: Ty[]): Ty {
        const choices = types.flatMap(t => { const r = resolve(t); return r.k === "union" ? r.choices : [t]; });
        const unique: Ty[] = [];
        for (const choice of choices) {
            const value = resolve(choice);
            if (!unique.some(old => old === choice || value.k === "atom" && resolve(old).k === "atom" && text(old) === text(value))) unique.push(choice);
        }
        return unique.length === 1 ? unique[0] : { k: "union", choices: unique };
    }
    // Is this (an operation that is) still waiting for an unknown type?
    function waiting(type: Ty, seen = new Set<Ty>()): boolean {
        let t = type;
        while (t.k === "var" && t.link) t = t.link;
        if (t.k === "var") return true;
        if (t.k !== "operation" || seen.has(t)) return false;
        seen.add(t);
        if (!deciding && t.op === "call" && t.known && symbolic(t.known)) return true;
        return t.args.some(x => waiting(x, seen));
    }
    // Does this value depend on a parameter of an enclosing function?
    function symbolic(k: Known): boolean {
        return !!k.ref || !!k.index?.terms.size || !!k.call?.args.some(symbolic) || !!k.expr?.env.some(([, v]) => symbolic(v));
    }
    // Set while deciding leftover checks at the end: symbolic values no longer wait.
    let deciding = false;
    // The deferred call being evaluated, so deferring it again keeps the same node.
    let evaluatingCall: Extract<Ty, { k: "operation" }> | undefined;
    function deferredCall(f: Ty, argument: Entry): Ty {
        const result: Ty = { k: "operation", op: "call", args: [f, argument.type], known: { index: argument.index, size: argument.size, items: argument.items, boolean: argument.boolean, string: argument.string, char: argument.char, float: argument.float, number: argument.number, tag: argument.tag, ref: argument.ref, call: argument.call, expr: argument.expr } };
        requirements.push(result);
        return resolve(result);
    }
    function operation(op: string, args: Ty[]): Ty {
        const result: Ty = { k: "operation", op, args };
        requirements.push(result);
        return resolve(result);
    }
    function evaluateOperation(t: Extract<Ty, { k: "operation" }>): Ty {
        const operands = t.args.map(resolve);
        if (["+", "-", "*", "/", "%", "^", "compare", "negate"].includes(t.op)) {
            for (let n = 0; n < operands.length; n++) {
                while (operands[n].k === "mutable") operands[n] = resolve((operands[n] as Extract<Ty, { k: "mutable" }>).value);
                if (operands[n].k === "variant" && (operands[n] as Extract<Ty, { k: "variant" }>).ordinal) operands[n] = atom("Int");
            }
        }
        const [a, b] = operands;
        if (t.args.some(x => { const v = resolve(x); return v.k === "var" || v.k === "operation"; })) return t;
        if (t.op === "merge-record") {
            if (isExplicit(a) || isExplicit(b)) return explicitDynamic;
            if (a.k !== "record" || b.k !== "record") return problem("record flattening expects a record");
            return { k: "record", fields: new Map([...a.fields, ...b.fields]) };
        }
        if (t.op === "remainder") {
            if (isExplicit(a)) { runtimeChecks++; return explicitDynamic; }
            if (a.k !== "record" || b.k !== "record") return problem("record remainder requires a record");
            unify(b, a);
            return { k: "record", fields: new Map([...a.fields].filter(([key]) => !b.fields.has(key))) };
        }
        if (t.op.startsWith("field:")) {
            const name = t.op.slice(6);
            if (a.k !== "record") return problem("field access requires a record");
            return a.fields.get(name) ?? problem(`missing field '${name}'`);
        }
        if (t.op === "pattern") return application(a, { type: b }, activeExpression ?? { t: "placeholder" });
        if (t.op === "load") return unknown();
        if (t.op === "distinct") {
            if (a.k !== "type") return problem("distinct expects a type");
            return { k: "type", value: { k: "variant", name: `distinct${serial++}`, args: [], base: a.value } };
        }
        if (t.op === "set") {
            // An explicit Dynamic target (such as an FFI Pointer) is checked at runtime.
            if (isExplicit(a)) { runtimeChecks++; return list(variable(), constant(0n)); }
            if (a.k !== "mutable") return problem("set expects a Mutable reference");
            convert(a.value, b, { t: "placeholder" });
            return list(variable(), constant(0n));
        }
        if (t.op === "insert") {
            if (b.k !== "map") return problem("insert expects a HashMap");
            if (a.k === "record") { unify(b.key, atom("String")); for (const value of a.fields.values()) unify(b.value, value); }
            else unify(list(pair(b.key, b.value)), a);
            return b;
        }
        if (t.op === "negate") {
            if (a.k === "list") return { k: "list", element: operation("negate", [a.element]), ...sameLength(a) };
            if (a.k === "record") return { k: "record", fields: new Map([...a.fields].map(([k, v]) => [k, operation("negate", [v])])) };
            if (a.k === "atom" && NUMERIC_TYPES.includes(a.name)) return a;
            if (isExplicit(a)) return a;
            return problem(`cannot negate ${text(a)}`);
        }
        if (t.op === "cast") {
            if (a.k === "list") return template(a, b, { t: "placeholder" });
            if (a.k !== "type") return problem("cast expects a type description");
            return application(a, { type: b }, { t: "placeholder" });
        }
        if (t.op === "construct") {
            if (a.k !== "type") return problem("expected a type constructor");
            if (resolve(a.value).k === "var") return t;
            return application(a, { type: b }, { t: "placeholder" });
        }
        if (t.op === "template") return template(a, b, { t: "placeholder" });
        if (t.op === "do") {
            if (a.k !== "list") return problem("do expects a list of expressions");
            return a.items ? a.items[a.items.length - 1] ?? list(variable(), constant(0n)) : a.element;
        }
        if (t.op === "match") {
            if (b.k !== "list") return problem("match expects a list of alternatives");
            const outputs: Ty[] = [];
            for (const candidate of b.items ?? [b.element]) {
                const f = resolve(candidate);
                if (f.k !== "fn") return problem("match alternatives must be functions");
                try {
                    if (f.pattern?.p === "as" || f.pattern?.p === "schema" || f.pattern?.p === "recPat") application(copy(f), { type: copy(a) }, activeExpression ?? { t: "placeholder" });
                    else unify(copy(f.input), copy(a));
                } catch { continue; }
                if (f.pattern?.p === "schema" || f.pattern?.p === "recPat") application(f, { type: a }, activeExpression ?? { t: "placeholder" });
                else unify(f.input, a);
                if (!t.solution && f.output.k !== "operation" && f.output.k !== "var") t.solution = f.output;
                for (const check of f.checks ?? []) resolve(check);
                const output = resolve(f.output);
                if (outputs.length) unify(outputs[0], output);
                else outputs.push(output.k === "list" ? list(output.element) : output);
            }
            return outputs[0] ?? variable();
        }
        // A requirement on a call that still waits for an unknown argument waits
        // too, rather than settling for the call's provisional solution.
        if (t.op === "require") { if (t.args.some(x => waiting(x))) return t; unify(a, b); return a; }
        if (isExplicit(a) || b && isExplicit(b)) return explicitDynamic;
        if (a.k === "dynamic" || b?.k === "dynamic") return unknown();
        if (a.k === "union") return union(a.choices.map(x => operation(t.op, t.args.length === 1 ? [x] : [x, b])));
        if (b?.k === "union") return union(b.choices.map(x => operation(t.op, [a, x])));
        if (["pairs", "keys", "values", "enumerate", "length"].includes(t.op)) {
            if (t.op === "length") {
                if (a.k === "list" || a.k === "record" || a.k === "map" || a.k === "atom" && a.name === "String") return atom("Int");
                return problem(`length requires a collection; got ${text(a)}`);
            }
            let key: Ty, value: Ty;
            if (a.k === "map") { key = a.key; value = a.value; }
            else if (a.k === "record" && t.op === "pairs") {
                // One [key, value] pair per field, in field order.
                const items = [...a.fields.values()].map(field => pair(atom("String"), field));
                return { k: "list", element: union(items), items, length: constant(BigInt(items.length)) };
            }
            else if (a.k === "list" && t.op === "enumerate") return { k: "list", element: pair(atom("Int"), a.element), ...sameLength(a) };
            else return problem(`${t.op} requires a collection; got ${text(a)}`);
            return list(t.op === "keys" ? key : t.op === "values" ? value : pair(key, value));
        }
        if (a.k === "variant" && a.base || b?.k === "variant" && b.base) {
            if (a.k !== "variant" || b?.k !== "variant" || a.name !== b.name || !a.base || !b.base) return problem("distinct arithmetic requires the same type on both sides");
            operation(t.op, [a.base, b.base]);
            return a;
        }
        const numeric = (x: Ty) => x.k === "atom" && NUMERIC_TYPES.includes(x.name);
        const callable = (x: Ty) => ["fn", "type", "overload"].includes(x.k);
        if (t.op === "call") {
            const outer = evaluatingCall;
            evaluatingCall = t;
            try { return application(a, { type: b, ...resolveKnown(t.known ?? {}) }, { t: "placeholder" }); }
            finally { evaluatingCall = outer; }
        }
        if (t.op === "compare") {
            if (numeric(a) && numeric(b) || a.k === "atom" && b.k === "atom" && a.name === b.name && ["String", "Char"].includes(a.name)) return atom("Bool");
            return problem(`cannot compare ${text(a)} and ${text(b)}`);
        }
        if (t.op === "++") {
            if (a.k === "list" && b.k === "list") return list(union([a.element, b.element]));
            if (a.k === "atom" && b.k === "atom" && a.name === "String" && b.name === "String") return a;
            return problem(`cannot append ${text(a)} and ${text(b)}`);
        }
        if (t.op === "*" && (callable(a) || callable(b))) {
            const f = callable(b) ? b : a, input = callable(b) ? a : b;
            let element: Ty;
            if (input.k === "list") return { k: "list", element: application(f, { type: input.element }, { t: "placeholder" }), ...sameLength(input) };
            else if (input.k === "record") element = { k: "list", element: union([atom("String"), ...input.fields.values()]), items: [atom("String"), union([...input.fields.values()])], length: constant(2n) };
            else if (input.k === "atom" && input.name === "Int") element = input;
            else return problem(`iteration needs a list, record, or Int; got ${text(input)}`);
            return list(application(f, { type: element }, { t: "placeholder" }));
        }
        if (t.op === "\\" && callable(a) && callable(b)) {
            const input = variable();
            const output = application(a, { type: application(b, { type: input }, { t: "placeholder" }) }, { t: "placeholder" });
            return fn(input, output);
        }
        if (t.op === "-" && callable(a) && numeric(b)) return application(a, { type: b }, { t: "placeholder" });
        if (a.k === "list" || b.k === "list") {
            if (a.k === "list" && b.k === "list") {
                // Elementwise arithmetic pairs lists of equal length.
                if (a.length && b.length && !a.length.terms.size && !b.length.terms.size && a.length.constant !== b.length.constant) {
                    return problem(`elementwise '${t.op}' needs equal lengths; got ${indexText(a.length)} and ${indexText(b.length)}`);
                }
                return { k: "list", element: operation(t.op, [a.element, b.element]), ...sameLength(a.length || !b.length ? a : b) };
            }
            const xs = a.k === "list" ? a : b as Extract<Ty, { k: "list" }>;
            const scalar = a.k === "list" ? b : a;
            if (!numeric(scalar)) return problem("array broadcast requires a number");
            return { k: "list", element: operation(t.op, a.k === "list" ? [xs.element, scalar] : [scalar, xs.element]), ...sameLength(xs) };
        }
        if (a.k === "record" || b.k === "record") {
            if (a.k === "record" && b.k === "record") {
                if (a.fields.size !== b.fields.size || [...a.fields.keys()].some(k => !b.fields.has(k))) return problem("array records require the same fields");
                return { k: "record", fields: new Map([...a.fields].map(([k, v]) => [k, operation(t.op, [v, b.fields.get(k)!])])) };
            }
            const rec = a.k === "record" ? a : b as Extract<Ty, { k: "record" }>;
            const scalar = a.k === "record" ? b : a;
            if (!numeric(scalar)) return problem("array broadcast requires a number");
            return { k: "record", fields: new Map([...rec.fields].map(([k, v]) => [k, operation(t.op, a.k === "record" ? [v, scalar] : [scalar, v])])) };
        }
        if (numeric(a) && numeric(b)) {
            if (a.k === "atom" && b.k === "atom" && ["Float32", "Float64"].includes(a.name) && ["Float32", "Float64"].includes(b.name) && a.name !== b.name) return problem("mixed Float32 and Float64 arithmetic requires an explicit cast");
            return t.op === "/" ? atom("Number") : text(a) === text(b) ? a : atom("Number");
        }
        if (t.op === "+" && a.k === "atom" && b.k === "atom" && a.name === "String" && b.name === "String") return a;
        return problem(`operator '${t.op}' cannot combine ${text(a)} and ${text(b)}`);
    }
    let lengthFacts = new Map<string, Index>();
    function refinedIndex(value: Index): Index {
        let result = constant(value.constant);
        for (const [name, scale] of value.terms) {
            result = indexAdd(result, lengthFacts.get(name) ?? { constant: 0n, terms: new Map([[name, 1n]]) }, scale);
        }
        return result;
    }
    function unify(
        expected: Ty,
        actual: Ty,
        e?: Expr,
        seen = new Map<Ty, Set<Ty>>(),
    ): void {
        spend(e);
        expected = resolve(expected);
        actual = resolve(actual);
        if (expected === actual) return;
        if (seen.get(expected)?.has(actual)) return;
        if (!seen.has(expected)) seen.set(expected, new Set());
        seen.get(expected)!.add(actual);
        if (isExplicit(expected)) {
            if (actual.k === "var") actual.link = explicitDynamic;
            runtimeChecks++;
            return;
        }
        if (isExplicit(actual)) {
            if (expected.k === "var") { expected.link = explicitDynamic; return; }
            return problem(`Dynamic requires an explicit conversion to ${text(expected)}`, e);
        }
        if (expected.k === "dynamic" || actual.k === "dynamic") {
            dynamicBoundaries++;
            return;
        }
        if (expected.k === "var") {
            // A union is not a structural node, so `v = v | t` would expand
            // forever. Its least solution is `v = t`: drop v's own occurrences.
            // Expand nested unions first: variables can also cycle through them.
            if (actual.k === "union") {
                const flat: Ty[] = [], visited = new Set<Ty>();
                const expand = (t: Ty): void => {
                    const r = resolve(t);
                    if (r === expected) return;
                    if (r.k !== "union") { flat.push(t); return; }
                    if (visited.has(r)) return;
                    visited.add(r);
                    r.choices.forEach(expand);
                };
                expand(actual);
                if (!flat.length) return;
                actual = union(flat);
            }
            // resolve() has removed variable aliases. Any back edge introduced
            // here crosses a structural node (a contractive recursive type).
            expected.link = actual;
            return;
        }
        if (actual.k === "var") return unify(actual, expected, e, seen);
        if (expected.k === "operation" || actual.k === "operation") {
            if (expected.k === "operation" && actual.k !== "operation") expected.solution = actual.k === "list" ? list(actual.element) : actual;
            if (actual.k === "operation" && expected.k !== "operation") actual.solution = expected.k === "list" ? list(expected.element) : expected;
            requirements.push({ k: "operation", op: "require", args: [expected, actual] });
            return;
        }
        if (expected.k === "union") {
            if (actual.k === "union") { for (const choice of actual.choices) unify(expected, choice, e, seen); return; }
            for (const choice of expected.choices) {
                try { unify(copy(choice), copy(actual), e); } catch { continue; }
                unify(choice, actual, e, seen); return;
            }
            return problem(`cannot use ${text(actual)} where ${text(expected)} is required`, e);
        }
        if (actual.k === "union") { for (const choice of actual.choices) unify(expected, choice, e, seen); return; }

        if (
            expected.k === "atom" && expected.name === "Type" && actual.k === "type"
        ) return;
        if (expected.k === "atom" && actual.k === "atom") {
            if (expected.name === actual.name) return;
            if (expected.name === "Number" && NUMERIC_TYPES.includes(actual.name)) {
                return;
            }
        }
        if (actual.k === "mutable" && expected.k !== "mutable") return unify(expected, actual.value, e, seen);
        if (expected.k === "mutable" && actual.k === "mutable") return unify(expected.value, actual.value, e, seen);
        if (expected.k === "fn" && (actual.k === "overload" || actual.k === "type" || actual.k === "intrinsic")) {
            unify(expected.output, operation("call", [actual, expected.input]), e, seen);
            return;
        }
        if (expected.k === "fn" && actual.k === "fn") {
            unify(actual.input, expected.input, e, seen);
            unify(expected.output, actual.output, e, seen);
            return;
        }
        if (expected.k === "list" && actual.k === "list") {
            // An empty-list pattern carries no length, so recursion over lists of
            // unknown length still checks; a list known to be non-empty cannot match it.
            const knownLength = (t: Extract<Ty, { k: "list" }>) =>
                t.items?.length ? BigInt(t.items.length) : t.length && !t.length.terms.size ? t.length.constant : undefined;
            const empty = (t: Extract<Ty, { k: "list" }>) => t.items?.length === 0;
            for (const [zero, other] of [[expected, actual], [actual, expected]] as const) {
                const n = knownLength(other);
                if (empty(zero) && n !== undefined && n !== 0n) {
                    problem(`length mismatch: expected ${zero === expected ? 0 : n}, got ${zero === expected ? n : 0}`, e);
                }
            }
            if (expected.items && actual.items && expected.items.length === actual.items.length) expected.items.forEach((t, n) => unify(t, actual.items![n], e, seen));
            else unify(expected.element, actual.element, e, seen);
            if (expected.length && actual.length) {
                const delta = indexAdd(refinedIndex(expected.length), refinedIndex(actual.length), -1n);
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
        if (expected.k === "map" && actual.k === "map") { unify(expected.key, actual.key, e, seen); unify(expected.value, actual.value, e, seen); return; }
        if (expected.k === "record" && actual.k === "record") {
            for (const [key, type] of expected.fields) {
                if (!actual.fields.has(key)) problem(`missing field '${key}'`, e);
                unify(type, actual.fields.get(key)!, e, seen);
            }
            return;
        }
        if (expected.k === "type" && actual.k === "type") {
            return unify(expected.value, actual.value, e, seen);
        }
        if (
            expected.k === "variant" && actual.k === "variant" &&
            expected.name === actual.name &&
            expected.args.length === actual.args.length
        ) {
            expected.args.forEach((t, i) => unify(t, actual.args[i], e, seen));
            return;
        }
        problem(
            `cannot use ${text(actual)} where ${text(expected)} is required`,
            e,
        );
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
        // The builtin length of a list is its static length.
        if (e.t === "app" && e.f.t === "var" && e.f.name === "length" && scope.get("length")?.builtin) {
            const t = resolve(inferred.get(e.a) ?? dynamic);
            if (t.k === "list") return t.items ? constant(BigInt(t.items.length)) : t.length;
            return;
        }
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
    function schemaValue(type: Ty, e: Expr, seen = new Map<Ty, Ty>()): Ty {
        const t = resolve(type);
        if (t.k === "type") return t.value;
        if (t.k === "dynamic") return unknown();
        if (seen.has(t)) return seen.get(t)!;
        if (t.k === "list") {
            const result: Extract<Ty, { k: "list" }> = { k: "list", element: variable(), length: t.length };
            seen.set(t, result);
            const items = t.items?.map(item => schemaValue(item, e, seen));
            result.element = items ? items.length ? union(items) : variable() : schemaValue(t.element, e, seen);
            result.items = items;
            return result;
        }
        if (t.k === "record") {
            const result: Ty = { k: "record", fields: new Map() };
            seen.set(t, result);
            for (const [key, value] of t.fields) result.fields.set(key, schemaValue(value, e, seen));
            return result;
        }
        return problem("expected a type description", e);
    }
    function typeExpr(e: Expr, scope: Scope, captures?: Set<string>): Ty {
        if (e.t === "placeholder") return variable();
        if (captures && e.t === "var" && /^[a-z]/.test(e.name) && !scope.has(e.name)) {
            const value = variable();
            scope.set(e.name, { type: { k: "type", value }, mono: true });
            captures.add(e.name);
            return value;
        }
        if (e.t === "block" && e.stmts.length === 1) return typeExpr(e.stmts[0], scope, captures);
        if (e.t === "record") {
            const fields = new Map<string, Ty>(), preserve = new Set<string>();
            for (const [key, value] of e.v) {
                const type = typeExpr(value, scope, captures);
                if (key !== "_") {
                    fields.set(key, type);
                    if (schemaWildcard(value) || captures && value.t === "var" && captures.has(value.name)) preserve.add(key);
                    else preserve.delete(key);
                    continue;
                }
                const spread = resolve(type);
                if (spread.k !== "record") return problem("record flattening expects a record", value);
                for (const [name, field] of spread.fields) {
                    fields.set(name, field);
                    if (spread.preserve?.has(name)) preserve.add(name); else preserve.delete(name);
                }
            }
            return { k: "record", fields, preserve };
        }
        if (e.t === "list") {
            const items = e.v.map(value => typeExpr(value, scope, captures));
            return { k: "list", items, element: items.length ? union(items) : variable(), length: constant(BigInt(items.length)),
                preserve: new Set(e.v.flatMap((value, n) => (schemaWildcard(value) || captures && value.t === "var" && captures.has(value.name)) ? [n] : [])) };
        }
        return schemaValue(infer(e, scope), e);
    }
    function schemaWildcard(e: Expr): boolean {
        return e.t === "placeholder" || e.t === "block" && e.stmts.length === 1 && schemaWildcard(e.stmts[0]);
    }
    // A var-only list pattern such as [x, y] selects those fields from a record,
    // so it sees the record as the list of the named field types.
    function recordSelection(p: Pattern, value: Ty, e: Expr): Ty {
        const input = resolve(value);
        if (input.k !== "record" || p.p !== "list" || !p.v.every(x => x.p === "var")) return value;
        const items = p.v.map(x => {
            const name = (x as Extract<Pattern, { p: "var" }>).name;
            const field = input.fields.get(name);
            if (!field) return problem(`missing field '${name}'`, e);
            return field;
        });
        return { k: "list", element: union(items), items, length: constant(BigInt(items.length)) };
    }
    function bind(p: Pattern, expected: Ty, scope: Scope, e: Expr, bound = new Set<string>()): void {
        switch (p.p) {
            case "as": {
                bind(p.left, expected, scope, e, bound);
                const right = variable();
                const nestedStart = requirements.length;
                bind(p.right, right, scope, e, bound);
                const checks = requirements.splice(nestedStart);
                const constructor = p.right.p === "constr" ? resolve(scope.get(p.right.tag)?.type ?? dynamic) : undefined;
                const coerce = p.right.p === "schema" || p.right.p === "contract" || constructor?.k === "type";
                const matcher: Ty = { k: "fn", input: right, output: right, pattern: p.right, coerce, checks };
                operation("pattern", [matcher, expected]);
                return;
            }
            case "wildcard":
                return;
            case "var":
                if (bound.has(p.name)) unify(scope.get(p.name)!.type, expected, e);
                else { bound.add(p.name); scope.set(p.name, { type: expected, mono: true }); }
                return;
            case "int":
            case "range":
                return unify(expected, atom("Int"), e);
            case "bool":
                return unify(expected, atom("Bool"), e);
            case "string":
                return unify(expected, atom("String"), e);
            case "char":
                return unify(expected, atom("Char"), e);
            case "float":
                // Compared numerically: 2.0 also matches the integer 2.
                return unify(expected, atom("Number"), e);
            case "schema": {
                const t = typeExpr(p.type, scope, bound);
                application({ k: "fn", input: t, output: t, coerce: true, pattern: p }, { type: expected }, e);
                bind(p.value, t, scope, e, bound);
                return;
            }
            case "typeBind": {
                const type: Ty = { k: "type", value: expected };
                bind({ p: "var", name: p.name }, type, scope, e, bound);
                bind(p.value, expected, scope, e, bound);
                return;
            }
            case "contract": {
                const spec = (s: typeof p.spec): Ty => "name" in s ? atom(s.name) : fn(spec(s.from), spec(s.to), undefined, true);
                const t = spec(p.spec);
                // A contract pattern explicitly installs a runtime wrapper.
                if (isExplicit(expected)) runtimeChecks++;
                else unify(t, expected, e);
                bind(p.value, t, scope, e, bound);
                return;
            }
            case "list": {
                const items = p.v.map(() => variable());
                const pattern: Ty = { k: "list", element: items.length ? union(items) : variable(), items, length: items.length ? constant(BigInt(items.length)) : undefined };
                unify(pattern, expected, e);
                const vector = resolve(expected);
                if (vector.k === "list" && vector.length?.terms.size === 1) {
                    const [name, coefficient] = [...vector.length.terms][0];
                    const difference = BigInt(p.v.length) - vector.length.constant;
                    if (coefficient !== 0n && difference % coefficient === 0n) lengthFacts.set(name, constant(difference / coefficient));
                }
                p.v.forEach((x, n) => bind(x, items[n], scope, e, bound));
                return;
            }
            case "cons": {
                const a = variable(), t = list(a);
                unify(t, expected, e);
                const vector = resolve(expected);
                const tail = vector.k === "list" && vector.length ? list(a, indexAdd(vector.length, constant(-1n))) : t;
                bind(p.head, a, scope, e, bound);
                bind(p.tail, tail, scope, e, bound);
                return;
            }
            case "recPat": {
                const fields = new Map<string, Ty>();
                for (const [key, name] of p.v) {
                    if (key === "_") continue;
                    const t = variable();
                    fields.set(key, t);
                    bind({ p: "var", name }, t, scope, e, bound);
                }
                const rest = p.v.find(([key]) => key === "_");
                if (rest) {
                    const remainder = operation("remainder", [expected, { k: "record", fields }]);
                    bind({ p: "var", name: rest[1] }, remainder, scope, e, bound);
                } else unify({ k: "record", fields }, expected, e);
                return;
            }
            case "constr": {
                const entry = scope.get(p.tag), t = entry ? copy(entry.type) : dynamic;
                if (t.k === "factory" && p.args.length === 3) {
                    const [size, element, value] = p.args;
                    let length: Index | undefined;
                    if (size.p === "var") {
                        const previous = bound.has(size.name) ? scope.get(size.name) : undefined;
                        bind(size, atom("Int"), scope, e, bound);
                        length = previous?.index ?? { constant: 0n, terms: new Map([[`n${serial++}`, 1n]]) };
                        scope.set(size.name, { ...scope.get(size.name)!, index: length });
                    } else if (size.p === "int") length = constant(size.v);
                    else if (size.p !== "wildcard") problem("Vect length pattern needs a name, integer, or _", e);
                    let item: Ty = variable();
                    if (element.p === "var") {
                        bind(element, { k: "type", value: item }, scope, e, bound);
                        const saved = resolve(scope.get(element.name)!.type);
                        if (saved.k === "type") item = saved.value;
                    } else if (element.p === "constr" && !element.args.length) {
                        item = typeExpr({ t: "var", name: element.tag }, scope);
                    } else if (element.p !== "wildcard") problem("Vect element pattern needs a type, name, or _", e);
                    const vector = list(item, length);
                    unify(vector, expected, e);
                    bind(value, vector, scope, e, bound);
                    return;
                }
                if (p.tag === "Type") {
                    const payload: Ty = { k: "type", value: variable() };
                    unify(payload, expected, e);
                    p.args.forEach((x) => bind(x, payload, scope, e, bound));
                    return;
                }
                if (t.k === "type") {
                    const value = t.value.k === "atom" && t.value.name === "List" ? list(variable()) : t.value;
                    unify(value, expected, e);
                    p.args.forEach((x) => bind(x, value.k === "variant" && value.base ? value.base : value, scope, e, bound));
                    return;
                }
                if ((t.k === "record" || t.k === "list") && p.args.length === 1) {
                    const schema = typeExpr({ t: "var", name: p.tag }, scope);
                    unify(schema, expected, e);
                    bind(p.args[0], schema, scope, e, bound);
                    return;
                }
                let rest: Ty = t;
                for (const arg of p.args) {
                    const f = resolve(rest);
                    if (f.k !== "fn") {
                        bind(arg, unknown(), scope, e, bound);
                        continue;
                    }
                    bind(arg, f.input, scope, e, bound);
                    rest = f.output;
                }
                unify(rest, expected, e);
                return;
            }
        }
    }
    function convert(
        target: Ty,
        actual: Ty,
        e: Expr,
        explicitFloat = false,
        seen = new Map<Ty, Set<Ty>>(),
        runtimeProjection = false,
    ): Ty {
        spend(e);
        const t = resolve(target), a = resolve(actual);
        if (isExplicit(a) && (runtimeProjection || explicitFloat)) { runtimeChecks++; return target; }
        if (t.k === "atom" && t.name === "Bool" && explicitFloat) return t;
        if (
            t.k === "atom" && a.k === "atom" && NUMERIC_TYPES.includes(t.name) &&
            NUMERIC_TYPES.includes(a.name)
        ) {
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
                    castNumeric(
                        t.name,
                        literal,
                        explicitFloat && ["Float", "Float32", "Float64"].includes(t.name),
                    );
                } catch (error) {
                    problem((error as Error).message, e);
                }
            } else runtimeChecks++;
            return target;
        }
        if (seen.get(t)?.has(a)) return target;
        if (!seen.has(t)) seen.set(t, new Set());
        seen.get(t)!.add(a);
        if (t.k === "list" && a.k === "list") {
            unify(list(dynamic, t.length), list(dynamic, a.length), e);
            if (a.items) {
                a.items.forEach((item, n) =>
                    t.preserve?.has(n) ? unify(t.items?.[n] ?? t.element, item, e) : convert(
                        t.items?.[n] ?? t.element,
                        item,
                        e.t === "list" ? e.v[n] ?? e : e,
                        false,
                        seen,
                        runtimeProjection || explicitFloat,
                    )
                );
            } else if (t.preserve?.size) unify(t.element, a.element, e);
            else convert(t.element, a.element, e, false, seen, runtimeProjection || explicitFloat);
            return target;
        }
        if (t.k === "record" && a.k === "record") {
            for (const [key, type] of t.fields) {
                if (!a.fields.has(key)) problem(`missing field '${key}'`, e);
                if (t.preserve?.has(key)) {
                    unify(type, a.fields.get(key)!, e);
                    continue;
                }
                convert(
                    type,
                    a.fields.get(key)!,
                    e.t === "record" ? e.v.find(([k]) => key === k)?.[1] ?? e : e,
                    false,
                    seen,
                    runtimeProjection || explicitFloat,
                );
            }
            return target;
        }
        unify(target, actual, e);
        return target;
    }
    function template(target: Ty, input: Ty, e: Expr): Ty {
        const t = resolve(target), a = resolve(input);
        if (t.k === "var" || a.k === "var" || t.k === "operation" || a.k === "operation") return operation("template", [t, a]);
        if (isExplicit(t) || isExplicit(a)) return explicitDynamic;
        if (t.k !== "list") return problem("list template requires a list", e);
        if (a.k === "atom" && a.name === "String") return template(t, list(atom("Char")), e);
        if (a.k === "record") {
            const items = [...a.fields.values()];
            const converted = resolve(template(t, { k: "list", items, element: items.length ? union(items) : variable(), length: constant(BigInt(items.length)) }, e));
            if (converted.k !== "list") return converted;
            return { k: "record", fields: new Map([...a.fields.keys()].map((key, n) => [key, converted.items?.[n] ?? converted.element])) };
        }
        if (a.k !== "list") return problem("list template expects a list, record, or String", e);
        if (t.length && a.length) unify(list(variable(), t.length), list(variable(), a.length), e);
        else runtimeChecks++;
        const apply = (slot: Ty, value: Ty, expression: Expr): Ty => resolve(slot).k === "list"
            ? template(slot, value, expression) : application(slot, { type: value }, expression);
        if (t.items) {
            const items = t.items.map((slot, n) => apply(slot, a.items?.[n] ?? a.element, e.t === "list" ? e.v[n] ?? e : e));
            return { k: "list", element: items.length ? union(items) : variable(), items, length: t.length };
        }
        return list(apply(t.element, a.element, e), t.length);
    }
    function application(f: Ty, argument: Entry, e: Expr): Ty {
        spend(e);
        f = resolve(f);
        if (f.k === "intrinsic") {
            const args = [...f.args ?? [], argument.type];
            return args.length < (f.arity ?? 1) ? { ...f, args } : operation(f.name, args);
        }
        if (f.k === "operation") return deferredCall(f, argument);
        if (f.k === "dynamic") return f.explicit ? explicitDynamic : unknown();
        if (f.k === "overload") {
            const input = resolve(argument.type);
            if (input.k === "var" || input.k === "operation") return deferredCall(f, argument);
            let outputs: Ty[] = [];
            const accepted: { clauses?: ClauseOrder[]; call?: Entry[] }[] = [];
            for (const choice of f.choices) {
                const instance = copy(choice), node = resolve(instance);
                try {
                    const out = application(instance, { ...argument, type: copy(argument.type) }, e);
                    outputs.push(out);
                    let call: Entry[] | undefined;
                    if (node.k === "fn" && node.clauses) {
                        const args = [...node.callArgs ?? [], argument], next = resolve(out);
                        if (next.k === "fn" && next.clauses === node.clauses) next.callArgs = args;
                        else call = args;
                    }
                    accepted.push({ clauses: node.k === "fn" ? node.clauses : undefined, call });
                } catch (error) {
                    if (!error || typeof error !== "object" || !("message" in error)) throw error;
                }
            }
            // A complete call: drop choices none of whose clauses can run, because
            // each definitely fails or comes after a clause that definitely matches.
            if (accepted.length && accepted.every(a => a.clauses && a.call)) {
                const ranked = accepted.flatMap(a => a.clauses!.map(c => ({ clause: c, ...rankClause(c, a.call!) })));
                const sure = ranked.filter(r => r.matches);
                const before = (a: typeof ranked[number], b: typeof ranked[number]) =>
                    a.low > b.high || a.low >= b.high && a.clause.index < b.clause.index;
                const runs = (r: typeof ranked[number]) => !r.fails && !sure.some(d => d !== r && before(d, r));
                outputs = outputs.filter((_, n) => accepted[n].clauses!.some(c => runs(ranked.find(r => r.clause === c)!)));
                // Still ambiguous, and the arguments depend on an enclosing function's
                // parameters: decide at that function's calls, where they are known.
                if (!deciding && outputs.length > 1 && outputs.some(x => text(x) !== text(outputs[0])) && accepted.some(a => a.call!.some(symbolic))) {
                    return evaluatingCall && resolve(evaluatingCall.args[0]) === f ? evaluatingCall : deferredCall(f, argument);
                }
            }
            if (!outputs.length) return problem(`no overload accepts ${text(argument.type)}`, e);
            if (outputs.length === 1 || outputs.every((x) => text(x) === text(outputs[0]))) return outputs[0];
            if (outputs.every((x) => resolve(x).k === "fn")) return { k: "overload", choices: outputs };
            return union(outputs);
        }
        if (f.k === "factory") {
            const args = [...f.args, argument];
            if (args.length === 1) {
                convert(atom("Int"), argument.type, e);
                if (argument.index && !argument.index.terms.size && argument.index.constant < 0n) {
                    problem("Vect length must be nonnegative", e);
                }
                return { k: "factory", args };
            }
            let element = resolve(argument.type);
            if (element.k === "var") {
                const payload: Ty = { k: "type", value: variable() };
                unify(element, payload, e);
                element = payload;
            }
            if (element.k !== "type" && element.k !== "dynamic") problem("Vect element must be a type", e);
            if (!args[0].index) dynamicBoundaries++;
            return { k: "type", value: { k: "list", element: element.k === "type" ? element.value : dynamic, length: args[0].index, contracted: true } };
        }
        if (f.k === "alias") {
            const args = [...f.args, argument];
            if (args.length < f.params.length) return { ...f, args };
            const scope = new Map(f.scope);
            f.params.forEach((name, i) => scope.set(name, { ...args[i], mono: true }));
            return infer(f.body, scope);
        }
        if (f.k === "type") {
            const t = resolve(f.value), a = resolve(argument.type);
            if (t.k === "variant" && t.base) { convert(t.base, argument.type, e); return t; }
            if (t.k === "var") {
                requirements.push({ k: "operation", op: "construct", args: [f, argument.type] });
                return t;
            }
            // A numeric conversion of an unknown value (such as a parameter) is
            // checked once the value's type is known, not forced to the target.
            if (t.k === "atom" && NUMERIC_TYPES.includes(t.name) && a.k === "var") {
                requirements.push({ k: "operation", op: "construct", args: [f, argument.type] });
                return t;
            }
            if (t.k === "atom") {
                if (t.name === "Type" && ["type", "factory", "alias", "list", "record"].includes(a.k)) return argument.type;
                if (t.name === "List" && a.k === "list") return a;
                if (t.name === "Record" && a.k === "record") return a;
                if (t.name === "Function" && (a.k === "fn" || a.k === "overload")) return a;
                if (t.name === "Mutable") return { k: "mutable", value: argument.type };
                if (t.name === "HashMap") {
                    if (a.k === "map") return a;
                    if (a.k === "record") return { k: "map", key: atom("String"), value: union([...a.fields.values()]) };
                    const key = variable(), value = variable();
                    unify(list(pair(key, value)), a, e);
                    return { k: "map", key, value };
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
            return convert(f.value, argument.type, e, true);
        }
        if (f.k === "var") {
            const result = variable();
            unify(f, fn(argument.type, result), e);
            return result;
        }
        if (f.k === "fn") {
            const selection = f.pattern?.p === "schema" && resolve(f.input).k === "list" ? f.pattern.value : f.pattern;
            const selected = selection ? recordSelection(selection, argument.type, e) : argument.type;
            if (selected !== argument.type) return application({ ...f, pattern: undefined }, { ...argument, type: selected }, e);
            const expected = resolve(f.input), actual = resolve(argument.type);
            if (f.coerce && expected.k === "record" && actual.k === "list") {
                const fields = [...expected.fields];
                if (actual.length && !actual.length.terms.size && actual.length.constant !== BigInt(fields.length)) {
                    return problem(`record pattern needs ${fields.length} positional values, got ${actual.length.constant}`, e);
                }
                if (!actual.length || actual.length.terms.size) runtimeChecks++;
                const projected = new Map<string, Ty>();
                for (const [n, [key, target]] of fields.entries()) {
                    const value = actual.items?.[n] ?? actual.element;
                    if (expected.preserve?.has(key)) unify(target, value, e.t === "list" ? e.v[n] ?? e : e);
                    else convert(target, value, e.t === "list" ? e.v[n] ?? e : e, false, new Map(), true);
                    projected.set(key, target);
                }
                return application(f, { ...argument, type: { k: "record", fields: projected } }, e);
            }
            if (expected.k === "list" && actual.k === "list" && expected.length?.terms.size === 1 && actual.length) {
                const [name, coefficient] = [...expected.length.terms][0];
                if (coefficient === 1n) {
                    const value = indexAdd(actual.length, constant(-expected.length.constant));
                    const retained = new Map([...variables(f)].map(t => [t, t]));
                    const instantiated = copy(f, retained, [name, value]) as Extract<Ty, { k: "fn" }>;
                    if (options.strict && !f.coerce) unify(instantiated.input, argument.type, e);
                    else convert(instantiated.input, argument.type, e, false, new Map(), !!f.coerce);
                    return instantiated.output;
                }
            }
            try {
                if (options.strict && !f.coerce) unify(f.input, argument.type, e);
                else convert(f.input, argument.type, e, false, new Map(), !!f.coerce);
            } catch (error) {
                if (f.selfName && error && typeof error === "object" && "message" in error &&
                    /^(cannot use |Dynamic requires an explicit conversion)/.test(String(error.message))) {
                    const got = actual.k === "fn" || actual.k === "overload" ? "Function" : text(actual);
                    return problem(`argument '${f.selfName}' must equal the function '${f.selfName}'; got ${got}`, e);
                }
                throw error;
            }
            const checks: Ty[] = [...f.checks ?? []];
            const collect = (type: Ty, seen = new Set<Ty>()): void => {
                const t = resolve(type);
                if (seen.has(t)) return;
                seen.add(t);
                if (t.k === "fn") checks.push(...t.checks ?? []);
                for (const child of children(t)) collect(child, seen);
            };
            collect(argument.type);
            // With this argument's value known, the function's deferred checks
            // (calls on the parameter) see that value instead of its symbol.
            const value: Known = { index: argument.index, size: argument.size, items: argument.items, boolean: argument.boolean, string: argument.string, char: argument.char, float: argument.float, number: argument.number, tag: argument.tag, ref: argument.ref, call: argument.call, expr: argument.expr };
            const known = argument.index || argument.ref || argument.call || argument.expr || [argument.size, argument.items, argument.boolean, argument.string, argument.char, argument.float, argument.number, argument.tag].some(x => x !== undefined);
            const pending = f.binder && known
                ? checks.map(check => copy(check, new Map([...variables(check)].map(t => [t, t])),
                    argument.index ? [f.binder!, argument.index] : undefined, undefined, [f.binder!, value]))
                : checks;
            const output = resolve(f.output);
            if (output.k === "fn") output.checks = [...output.checks ?? [], ...pending];
            else for (const requirement of pending) {
                // Still waiting on an unknown argument (inside another function's
                // body): it becomes that function's check, decided at its calls.
                if (resolve(requirement) === requirement) requirements.push(requirement);
            }
            if (f.binder && argument.index) {
                const next = copy(f.output, new Map([...variables(f.output)].map((t) => [t, t])), [f.binder, argument.index]);
                const out = resolve(next);
                return f.shape && out.k === "fn" && out.shape === f.shape ? { ...out, args: [...f.args ?? [], argument.type] } : next;
            }
            if (f.shape) {
                const args = [...f.args ?? [], argument.type], next = resolve(f.output);
                if (next.k === "fn" && next.shape === f.shape) return { ...next, args };
                return buildShape(f.shape, f.output, args);
            }
            return f.output;
        }
        if (f.k === "list") {
            const a = resolve(argument.type);
            if (a.k === "atom" && a.name === "Int" || a.k === "variant" && a.ordinal) {
                if (f.items && argument.index && !argument.index.terms.size) {
                    const n = Number(argument.index.constant), at = n < 0 ? f.items.length + n : n;
                    if (at < 0 || at >= f.items.length) return problem("list index out of bounds", e);
                    return f.items[at];
                }
                return f.element;
            }
            if (a.k === "list") return list(f.element, a.length);
            if (a.k === "record") return { k: "record", fields: new Map([...a.fields].map(([key, index]) => {
                const type = resolve(index);
                if (type.k === "var") unify(type, atom("Int"), e);
                else if (isExplicit(type)) { runtimeChecks++; return [key, explicitDynamic]; }
                else if (!(type.k === "atom" && type.name === "Int" || type.k === "variant" && type.ordinal)) {
                    return problem("named list indices must be integers or enumeration values", e);
                }
                const expression = e.t === "record" ? e.v.find(([name]) => name === key)?.[1] : undefined;
                return [key, application(f, { type: index, ...(expression?.t === "int" ? { index: constant(expression.v) } : {}) }, expression ?? e)];
            })) };
            if (a.k === "atom" && a.name === "String") {
                const values = f.items ?? [f.element];
                return union(values.map(value => {
                    const item = resolve(value);
                    if (item.k !== "list") return problem("association lookup requires a list of pairs", e);
                    if (item.items) { unify(atom("String"), item.items[0], e); return item.items[1]; }
                    return item.element;
                }));
            }
            return problem("list index must be Int, an enum, a list or record of indices, or an association key", e);
        }
        if (f.k === "map") { unify(f.key, argument.type, e); return f.value; }
        if (f.k === "record") {
            const a = resolve(argument.type);
            if (a.k === "atom" && a.name === "Int") {
                const entries = [...f.fields.values()];
                if (argument.index && !argument.index.terms.size) {
                    const raw = Number(argument.index.constant), n = raw < 0 ? entries.length + raw : raw;
                    if (n < 0 || n >= entries.length) return problem("record index out of bounds", e);
                    return pair(atom("String"), entries[n]);
                }
                return pair(atom("String"), union(entries));
            }
            if (a.k === "atom" && a.name === "String") {
                if (argument.string !== undefined) {
                    const field = f.fields.get(argument.string);
                    if (!field) return problem(`missing field '${argument.string}'`, e);
                    return field;
                }
                return union([...f.fields.values()]);
            }
            if (a.k === "record" || a.k === "list") {
                const supplied = a.k === "record"
                    ? a.fields
                    : new Map(a.items?.length === 0 ? [] : [...f.fields.keys()].map((k, i) => [k, a.items?.[i] ?? a.element]));
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
            return problem(`cannot apply ${text(f)}`, e);
        }
        return problem(`cannot apply ${text(f)}`, e);
    }
    let inferenceDepth = 0;
    // The type each expression was last inferred with, for facts read right after.
    const inferred = new WeakMap<Expr, Ty>();
    function infer(e: Expr, scope: Scope, expected?: Ty): Ty {
        spend(e);
        if (++inferenceDepth > 256) {
            inferenceDepth--;
            return problem(
                "type checking depth limit exceeded; cannot establish the type",
                e,
            );
        }
        const previousExpression = activeExpression;
        activeExpression = e;
        try {
            const t = inferExpression(e, scope, expected);
            inferred.set(e, t);
            return t;
        } finally {
            activeExpression = previousExpression;
            inferenceDepth--;
        }
    }
    function inferExpression(e: Expr, scope: Scope, expected?: Ty): Ty {
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
                let entry = scope.get(e.name);
                const declaration = forwardDefinitions.get(e.name);
                if (declaration && entry?.type === forward.get(e.name)) {
                    define(declaration.name, declaration.clauses, rootScope, declaration.clauses[0].body);
                    analyzed.add(declaration);
                    entry = rootScope.get(e.name);
                    if (entry) scope.set(e.name, entry);
                }
                if (!entry && !firstUnbound && options.runtimeNames && !options.runtimeNames.has(e.name)) {
                    const near = didYouMean(e.name, [...scope.keys(), ...options.runtimeNames]);
                    firstUnbound = { expr: e, name: e.name, hint: near ? `did you mean '${near}'?` : undefined };
                }
                if (!entry) return unknown();
                const type = instantiate(entry);
                return callees.has(e) && trustsShape(entry) ? type : withoutShapes(type);
            }
            case "placeholder":
                return variable();
            case "import": {
                if (!options.imports) return unknown();
                const imported = copyTypeScope(options.imports(e.module));
                for (const [name, entry] of imported) scope.set(name, entry);
                return { k: "record", fields: new Map([...imported].map(([name, entry]) => [name, entry.type])) };
            }
            case "functionType": {
                const spec = (s: typeof e.spec): Ty => "name" in s ? atom(s.name) : fn(spec(s.from), spec(s.to), undefined, true);
                return { k: "type", value: spec(e.spec) };
            }
            case "list": {
                const items = e.v.map((x) => infer(x, scope));
                const element: Ty = items.length ? union(items) : variable();
                return { k: "list", element, length: constant(BigInt(items.length)), items };
            }
            case "record": {
                let result: Ty = { k: "record", fields: new Map() };
                for (const [key, value] of e.v) {
                    const type = infer(value, scope);
                    result = operation("merge-record", [result, key === "_" ? type : { k: "record", fields: new Map([[key, type]]) }]);
                }
                return result;
            }
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
            case "computedRange": {
                const start = infer(e.lo, scope);
                if (e.second) unify(start, infer(e.second, scope), e.second);
                if (e.hi) unify(start, infer(e.hi, scope), e.hi);
                const value = resolve(start);
                if (value.k === "atom" && value.name === "Char") return atom("String");
                unify(atom("Number"), start, e);
                return list(start);
            }
            case "floatRange":
                return list(atom("Float"));
            case "rationalRange":
                return list(atom("Fraction"));
            case "lambda":
                return functionType(e.params.map((name) => ({ p: "var", name })), e.body, scope);
            case "patternLambda":
                return functionType(e.params, e.body, scope, undefined, e.guard);
            case "app":
            case "pipe": {
                const a = e.t === "app" ? e.a : e.x;
                callees.add(e.f);
                const callee = infer(e.f, scope), resolved = resolve(callee);
                if (resolved.k === "intrinsic" && resolved.name === "load" && a.t === "string" && options.loads) {
                    const loaded = options.loads(a.v, scope);
                    for (const [name, entry] of loaded) scope.set(name, entry);
                    return { k: "record", fields: new Map([...loaded].map(([name, entry]) => [name, entry.type])) };
                }
                if (resolved.k === "intrinsic" && ["quote", "debug", "toAST"].includes(resolved.name)) {
                    return resolved.name === "quote" ? atom("String") : resolved.name === "debug" ? list(variable(), constant(0n)) : explicitDynamic;
                }
                if (resolved.k === "intrinsic" && resolved.name === "use") {
                    const open = (type: Ty): void => {
                        const t = resolve(type);
                        if (t.k === "record") for (const [name, type] of t.fields) scope.set(name, { type });
                        else if (t.k === "list" && t.items) t.items.forEach(open);
                        else if (isExplicit(t)) runtimeChecks++;
                        else problem("use needs a statically known record or list of records; use Dynamic for runtime exports", a);
                    };
                    open(infer(a, scope));
                    return list(variable(), constant(0n));
                }
                if (resolved.k === "type" && isExplicit(resolved.value)) {
                    // The argument is an explicit runtime-checked island. Its
                    // effects may not invalidate protected checked bindings.
                    runtimeChecks++;
                    return explicitDynamic;
                }
                const result = application(callee, { type: infer(a, scope), ...valueEntry(a, scope) }, a);
                // A partial application that leaves its call chain is an ordinary function value.
                return callees.has(e) ? result : withoutShapes(result);
            }
            case "setFields": {
                let rec = resolve(infer(e.rec, scope));
                const value = infer(e.value, scope);
                let v = resolve(value);
                if (isExplicit(rec)) { runtimeChecks++; return explicitDynamic; }
                const parents: Array<[Map<string, Ty>, string]> = [];
                for (const key of e.path ?? []) {
                    if (rec.k === "dynamic") return unknown();
                    if (rec.k !== "record") return problem("nested field assignment requires a record", e);
                    const child = rec.fields.get(key);
                    if (!child) return problem(`missing field '${key}'`, e);
                    parents.push([rec.fields, key]);
                    rec = resolve(child);
                }
                if (rec.k === "dynamic") return unknown();
                if (rec.k === "list" && rec.items?.length === 0) rec = { k: "record", fields: new Map() };
                if (rec.k !== "record") return problem("field assignment requires a record", e);
                const fields = new Map(rec.fields);
                if (e.entries.length === 1 && e.entries[0] === "_") {
                    const spread = resolve(v.k === "list" ? v.items?.[0] ?? v.element : value);
                    if (spread.k !== "record") return problem("record flattening expects a record", e);
                    let merged: Ty = { k: "record", fields: new Map([...fields, ...spread.fields]) };
                    for (let n = parents.length - 1; n >= 0; n--) {
                        const [parent, key] = parents[n];
                        merged = { k: "record", fields: new Map([...parent, [key, merged]]) };
                    }
                    return merged;
                }
                if (e.aliases) {
                    if (v.k !== "record") return problem("renamed selection assignment requires a record", e);
                    const incoming = v.fields;
                    if (incoming.size !== new Set(e.aliases).size || e.aliases.some(name => !incoming.has(name))) return problem("replacement fields must match selection names", e);
                    if (e.entries.some(name => !fields.has(name))) return problem("renamed selection requires existing fields", e);
                    const items = e.aliases.map(name => incoming.get(name)!);
                    v = { k: "list", items, element: union(items), length: constant(BigInt(items.length)) };
                }
                if (v.k !== "list" && v.k !== "dynamic" && v.k !== "var") {
                    problem("field assignment needs a list of values on the right", e);
                }
                if (v.k === "list" && v.items && v.items.length !== e.entries.length) {
                    problem("field assignment length mismatch", e);
                }
                e.entries.forEach((key, n) => {
                    const incoming = v.k === "list" ? v.items?.[n] ?? v.element : dynamic;
                    const previous = fields.get(key), old = previous && resolve(previous);
                    fields.set(
                        key,
                        old && ["atom", "variant", "fn"].includes(old.k)
                            ? convert(old, incoming, e.value.t === "list" ? e.value.v[n] ?? e.value : e.value)
                            : incoming,
                    );
                });
                let result: Ty = { k: "record", fields };
                for (let i = parents.length - 1; i >= 0; i--) {
                    const [parent, key] = parents[i];
                    result = { k: "record", fields: new Map([...parent, [key, result]]) };
                }
                return result;
            }
            case "setItem": {
                const rec = resolve(infer(e.rec, scope)), value = infer(e.value, scope), key = index(e.index, scope);
                if (isExplicit(rec)) { infer(e.index, scope); runtimeChecks++; return explicitDynamic; }
                if (rec.k === "list") {
                    const keys = resolve(infer(e.index, scope));
                    if (keys.k === "atom" && keys.name === "String") {
                        const pairs = rec.items ?? [rec.element];
                        for (let n = 0; n < pairs.length; n++) {
                            const pairType = resolve(pairs[n]);
                            if (pairType.k !== "list") return problem("association assignment requires a list of pairs", e);
                            if (pairType.items && pairType.items.length !== 2) return problem("association assignment requires two-element pairs", e);
                            unify(atom("String"), pairType.items?.[0] ?? pairType.element, e);
                            // The string key is resolved at runtime; assignSlot checks the
                            // selected payload, rather than coercing unrelated pairs.
                        }
                        return rec;
                    }
                    if (keys.k === "record") {
                        const incoming = resolve(value);
                        if (incoming.k !== "record") return problem("named selection assignment requires a record", e);
                        if (keys.fields.size !== incoming.fields.size || [...keys.fields.keys()].some(name => !incoming.fields.has(name))) return problem("replacement fields must match selection names", e);
                        for (const [name, indexType] of keys.fields) {
                            const type = resolve(indexType);
                            if (type.k === "var") unify(type, atom("Int"), e);
                            else if (!(type.k === "atom" && type.name === "Int" || type.k === "variant" && type.ordinal)) return problem("named list indices must be integers or enumeration values", e);
                            const expression = e.index.t === "record" ? e.index.v.find(([key]) => key === name)?.[1] : undefined;
                            const selected = application(rec, { type: indexType, index: expression && index(expression, scope) }, expression ?? e);
                            convert(selected, incoming.fields.get(name)!, e.value);
                        }
                        return rec;
                    }
                    if (keys.k === "list") {
                        const incoming = resolve(value);
                        if (incoming.k !== "list") { dynamicBoundaries++;  return rec; }
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
                const field = e.index.t === "string" ? e.index.v : e.index.t === "var" ? scope.get(e.index.name)?.string : undefined;
                if (rec.k === "record" && field !== undefined) {
                    const fields = new Map(rec.fields), old = fields.get(field);
                    fields.set(field, old && resolve(old).k !== "type" ? convert(old, value, e.value) : value);
                    return { k: "record", fields };
                }
                return unknown();
            }
            case "pluck": {
                const rec = resolve(infer(e.rec, scope));
                if (isExplicit(rec)) { runtimeChecks++; return explicitDynamic; }
                if (rec.k === "record" && e.quoted !== false) {
                    const selected = e.entries.map(entry => {
                        const key = typeof entry === "string" ? entry : entry[0];
                        return rec.fields.get(key) ?? problem(`missing field '${key}'`, e);
                    });
                    return e.entries.every(x => typeof x === "string")
                        ? { k: "list", element: union(selected), length: constant(BigInt(selected.length)), items: selected }
                        : { k: "record", fields: new Map(e.entries.map((x, n) => [(x as [string, string])[1], selected[n]])) };
                }
                if (rec.k === "list" && e.values) return template(rec, infer(e.values, scope), e.values);
                if (e.values) infer(e.values, scope);
                return unknown();
            }
            case "recordAccess": {
                const rec = resolve(infer(e.rec, scope));
                if (isExplicit(rec)) { runtimeChecks++; return explicitDynamic; }
                if (rec.k === "list") return template(rec, infer(e.argument ?? { t: "var", name: e.field }, scope), e.argument ?? e);
                if (e.scoped && e.argument) {
                    if (rec.k === "dynamic" || rec.k === "var") return unknown();
                    if (rec.k !== "record") return problem("scoped evaluation requires a record", e);
                    const local = new Map(scope);
                    for (const [name, type] of rec.fields) local.set(name, { type, mono: true });
                    return infer(e.argument, local);
                }
                if (rec.k === "var") {
                    const t = variable();
                    unify(rec, { k: "record", fields: new Map([[e.field, t]]), open: true }, e);
                    return t;
                }
                if (rec.k === "dynamic") return unknown();
                if (rec.k === "operation") return operation(`field:${e.field}`, [rec]);
                if (rec.k !== "record") return problem("field access requires a record", e);
                if (!rec.fields.has(e.field)) {
                    if (rec.open) rec.fields.set(e.field, variable());
                    else return problem(`missing field '${e.field}'`, e);
                }
                return rec.fields.get(e.field)!;
            }
            case "ternary": {
                infer(e.cond, scope);
                const known = boolean(e.cond, scope);
                if (known !== undefined) return infer(known ? e.then : e.els, scope);
                const a = infer(e.then, scope), b = infer(e.els, scope, a);
                if (resolve(a).k === "type" && resolve(b).k === "type" && text(a) !== text(b)) {
                    dynamicBoundaries++;
                    return { k: "type", value: dynamic };
                }
                const left = resolve(a), right = resolve(b);
                if (left.k === "list" && right.k === "var") { unify(list(left.element), right, e); return list(left.element); }
                if (right.k === "list" && left.k === "var") { unify(list(right.element), left, e); return list(right.element); }
                if (left.k === "list" && right.k === "list") {
                    const join = (a: Ty, b: Ty): Ty => {
                        const x = resolve(a), y = resolve(b);
                        if (x.k === "var" || y.k === "var") { unify(a, b, e); return a; }
                        if (x.k === "list" && y.k === "list") {
                            if (!x.items?.length || !y.items?.length) { unify(x.element, y.element, e); return list(x.element); }
                            return list(union([x.element, y.element]));
                        }
                        return union([a, b]);
                    };
                    if (left.items && right.items && left.items.length === right.items.length) {
                        const items = left.items.map((item, n) => join(item, right.items![n]));
                        return { k: "list", element: items.length ? union(items) : variable(), items, length: constant(BigInt(items.length)) };
                    }
                    if (!left.items?.length || !right.items?.length) { unify(left.element, right.element, e); return list(left.element); }
                    return list(union([left.element, right.element]));
                }
                unify(a, b, e);
                return a;
            }
            case "binop": {
                // A numeric result constraint disambiguates arithmetic from
                // callable iteration. Do not guess numeric inputs otherwise.
                const resultConstraint = expected && resolve(expected);
                const constrain = (value: Ty): Ty => {
                    if (["+", "-", "*"].includes(e.op) && resultConstraint?.k === "atom" &&
                        NUMERIC_TYPES.includes(resultConstraint.name) && resolve(value).k === "var") {
                        unify(value, resultConstraint, e);
                    }
                    return value;
                };
                const a = constrain(infer(e.l, scope)), b = constrain(infer(e.r, scope));
                if (isExplicit(a) || isExplicit(b)) {
                    runtimeChecks++;
                    return ["==", "!=", "<", ">", "<=", ">=", "&&", "||"].includes(e.op) ? atom("Bool") : explicitDynamic;
                }
                if (["==", "!=", "&&", "||"].includes(e.op)) return atom("Bool");
                if (["<", ">", "<=", ">="].includes(e.op)) {
                    operation("compare", [a, b]);
                    return atom("Bool");
                }
                if (e.op === ":") {
                    unify(list(a), b, e);
                    const tail = resolve(b);
                    return list(a, tail.k === "list" && tail.length ? indexAdd(tail.length, constant(1n)) : undefined);
                }
                if (e.op === "++") {
                    const x = resolve(a), y = resolve(b);
                    if (x.k === "list" && y.k === "list") {
                        return list(union([x.element, y.element]), x.length && y.length ? indexAdd(x.length, y.length) : undefined);
                    }
                    return operation("++", [a, b]);
                }
                // Numeric/array arithmetic and callable * retain runtime overload selection.
                const x = resolve(a), y = resolve(b);
                if (x.k === "atom" && y.k === "atom") {
                    if (NUMERIC_TYPES.includes(x.name) && NUMERIC_TYPES.includes(y.name)) {
                        if (["Float", "Float32", "Float64"].includes(x.name) && ["Float", "Float32", "Float64"].includes(y.name)) {
                            if (x.name !== "Float" && y.name !== "Float" && x.name !== y.name) return problem("mixed Float32 and Float64 arithmetic requires an explicit cast", e);
                            return x.name === "Float" ? y : x;
                        }
                        return e.op === "/" ? atom("Number") : x.name === y.name ? x : atom("Number");
                    }
                    if (e.op === "+" && x.name === "String" && y.name === "String") return atom("String");
                    return problem(`operator '${e.op}' cannot combine ${text(x)} and ${text(y)}`, e);
                }
                if (e.op !== "*" && e.op !== "-" && e.op !== "\\" && (x.k === "type" || y.k === "type")) {
                    return problem(`operator '${e.op}' requires values, not a type constructor`, e);
                }
                return operation(e.op, [a, b]);
            }
            case "unop": {
                const operand = infer(e.e, scope);
                if (e.op === "not") return atom("Bool");
                if (isExplicit(operand)) { runtimeChecks++; return explicitDynamic; }
                return operation("negate", [operand]);
            }
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
                if (e.update && scope.has(e.update.name)) {
                    if (e.update.error) return problem(e.update.error, e);
                    return infer({ t: "patDef", pattern: { p: "var", name: e.update.name }, value: e.update.value }, scope);
                }
                const t = infer(e.value, e.value.t === "import" ? new Map(scope) : scope);
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
                } else bind(e.pattern, recordSelection(e.pattern, t, e.value), scope, e);
                return list(dynamic, constant(0n));
            }
            default:
                return unknown();
        }
    }
    // Only a direct call of a function definition (or builtin) by name may use
    // its shape: a function value that flows elsewhere shares its type node.
    function trustsShape(entry: Entry | undefined): boolean {
        return !!entry && !entry.mono && (!!entry.clauses || !!entry.builtin);
    }
    // A copy of a function type's result chain without shapes or collected args.
    function withoutShapes(type: Ty, seen = new Map<Ty, Ty>()): Ty {
        const t = resolve(type);
        if (t.k !== "fn" || !t.shape && !t.args && !t.summary && resolve(t.output).k !== "fn") return type;
        if (seen.has(t)) return seen.get(t)!;
        const result = { ...t, shape: undefined, args: undefined, summary: undefined };
        seen.set(t, result);
        result.output = withoutShapes(t.output, seen);
        return result;
    }
    // What the runtime knows about an argument's value from its static type.
    type Category = { numeric: string } | { kind: string } | undefined;
    function category(type: Ty): Category {
        const t = resolve(type);
        if (t.k === "atom" && NUMERIC_TYPES.includes(t.name)) {
            return ["Number", "Real", "Integer", "Exact", "Inexact"].includes(t.name) ? undefined : { numeric: t.name === "Float64" ? "Float" : t.name };
        }
        if (t.k === "atom" && ["String", "Bool", "Char"].includes(t.name)) return { kind: t.name };
        if (t.k === "list") return { kind: "List" };
        if (t.k === "record") return { kind: "Record" };
        if (t.k === "map") return { kind: "HashMap" };
        if (t.k === "variant" && !t.base) return { kind: "Variant" };
        if (["fn", "overload", "intrinsic"].includes(t.k)) return { kind: "Function" };
        return undefined;
    }
    // The runtime's dispatch score for one pattern, as the range the argument's
    // static type allows: literals 40; a typed pattern 30 for the exact type, 10
    // for a matching numeric aggregate, 1 for a lossless conversion, -1000 when
    // it cannot match; other patterns 0.
    function patternScore(p: Pattern, argument: Entry): [number, number] {
        if (["int", "float", "bool", "string", "char"].includes(p.p)) return [40, 40];
        if (p.p !== "constr" || !TYPE_NAMES.includes(p.tag)) return [0, 0];
        const c = category(argument.type), tag = p.tag;
        if (tag === "Dynamic") return [30, 30];
        if (tag === "Vect") return !c ? [-1000, 30] : "kind" in c && c.kind === "List" ? [30, 30] : [-1000, -1000];
        if (tag === "Mutable" || tag === "Pointer") return [-1000, 30];
        if (!NUMERIC_TYPES.includes(tag)) return !c ? [-1000, 30] : "kind" in c && c.kind === tag ? [30, 30] : [-1000, -1000];
        if (c && "kind" in c) return [-1000, -1000];
        const name = c?.numeric;
        const int = name !== undefined && /^U?Int(8|16|32|64|128)?$/.test(name), float = name !== undefined && /^Float(32)?$/.test(name);
        if (["Number", "Real", "Integer", "Exact", "Inexact"].includes(tag)) {
            if (!name) return [-1000, 10];
            const known: Record<string, boolean | undefined> = {
                Number: true,
                Real: name === "Complex" || name === "ComplexExact" ? undefined : true,
                Integer: int ? true : undefined,
                Exact: int || name === "Fraction" || name === "ComplexExact" ? true : float ? false : undefined,
                Inexact: float ? true : int || name === "Fraction" || name === "ComplexExact" ? false : undefined,
            };
            const result = known[tag];
            return result === undefined ? [-1000, 10] : result ? [10, 10] : [-1000, -1000];
        }
        // A known value decides it exactly, as at runtime: its own type, a
        // lossless conversion, or no match.
        const value = numericOf(argument);
        if (value) {
            if (matchesType(tag, value)) return [30, 30];
            try { castNumeric(tag, value); return [1, 1]; } catch { return [-1000, -1000]; }
        }
        if (!name) return [-1000, 30];
        return (tag === "Float64" ? "Float" : tag) === name ? [30, 30] : [-1000, 1];
    }
    // Score range of a clause for a complete call, and whether it definitely
    // matches (every pattern certain to succeed) or definitely fails.
    function rankClause(c: ClauseOrder, args: Entry[]): { low: number; high: number; matches: boolean; fails: boolean } {
        let low = 0, high = 0, matches = true, fails = false;
        c.params.forEach((p, n) => {
            const [a, b] = patternScore(p, args[n]);
            low += a; high += b;
            if (!definitelyMatches(p, args[n], c.refutable, a)) matches = false;
            if (definitelyFails(p, args[n], a, b)) fails = true;
        });
        return { low, high, matches, fails };
    }
    // A list whose elements are all known.
    function known(items: Known[]): Known {
        return { size: BigInt(items.length), items };
    }
    // An integer range with a finite end, as the runtime enumerates it.
    function rangeKnown(lo: bigint, step: bigint, hi: bigint | null): Known | undefined {
        if (hi === null || step === 0n) return undefined;
        const items: Known[] = [];
        for (let v = lo; step > 0n ? v <= hi : v >= hi; v += step) {
            if (items.length >= 10000) return undefined;
            items.push({ index: constant(v) });
        }
        return known(items);
    }
    // The constant length of a list type.
    function sizeOf(type: Ty | undefined): bigint | undefined {
        const t = type && resolve(type);
        if (t?.k !== "list") return undefined;
        if (t.items) return BigInt(t.items.length);
        return t.length && !t.length.terms.size ? t.length.constant : undefined;
    }
    // Everything known about an expression's value, for an argument entry.
    function valueEntry(e: Expr, scope: Scope): Known {
        const known: Known = {
            index: index(e, scope),
            size: sizeOf(inferred.get(e)),
            boolean: boolean(e, scope),
            string: e.t === "string" ? e.v : e.t === "var" ? scope.get(e.name)?.string : undefined,
            ref: e.t === "var" ? scope.get(e.name)?.ref : undefined,
        };
        const extra = literalOf(e, scope);
        for (const key of Object.keys(extra) as (keyof Known)[]) if (known[key] === undefined) (known as Record<string, unknown>)[key] = extra[key];
        return known;
    }
    // Character, float and constructor values an expression visibly has, and
    // any value a directly called function's result is known to have.
    function literalOf(e: Expr, scope: Scope): Known {
        if (e.t === "char") return { char: e.v };
        if (e.t === "float") return { float: e.v };
        if (e.t === "unop" && e.op === "neg" && e.e.t === "float") return { float: -e.e.v };
        if (e.t === "block" && e.stmts.length === 1) return literalOf(e.stmts[0], scope);
        if (e.t === "var") {
            const entry = scope.get(e.name);
            if (!entry) return {};
            if (/^[A-Z]/.test(e.name) && resolve(entry.type).k === "variant") return { tag: e.name };
            return { size: entry.size, items: entry.items, char: entry.char, float: entry.float, number: entry.number, tag: entry.tag };
        }
        if (e.t === "app") {
            const args: Expr[] = [];
            let head: Expr = e;
            while (head.t === "app") { args.unshift(head.a); head = head.f; }
            if (head.t !== "var") return {};
            const entry = scope.get(head.name);
            if ((NUMERIC_TYPES.includes(head.name) || head.name === "length") && entry?.builtin) return computed(e, scope);
            if (/^[A-Z]/.test(head.name)) {
                // A constructor applied to all its fields.
                let t = resolve(entry?.type ?? dynamic);
                for (let n = 0; n < args.length && t.k === "fn"; n++) t = resolve(t.output);
                return t.k === "variant" ? { tag: head.name } : {};
            }
            if (!trustsShape(entry)) return {};
            const summary = summaryAt(entry!.type, args.length);
            // A builtin with a result shape (map keeps its list's length).
            if (!summary) return shapeAt(entry!.type, args.length) || LIST_NATIVES.includes(head.name) ? computed(e, scope) : {};
            return resolveKnown({ call: { summary, args: args.map(a => valueEntry(a, scope)) } });
        }
        if (["binop", "unop", "ternary", "numeric", "list", "range", "computedRange"].includes(e.t)) return computed(e, scope);
        return {};
    }
    // A computed value; over enclosing parameters it is known only at their calls.
    function computed(e: Expr, scope: Scope): Known {
        const names = new Set<string>();
        const collect = (x: Expr): void => {
            if (x.t === "var" && scope.get(x.name)?.ref) names.add(x.name);
            else if (x.t === "binop") { collect(x.l); collect(x.r); }
            else if (x.t === "unop") collect(x.e);
            else if (x.t === "ternary") { collect(x.cond); collect(x.then); collect(x.els); }
            else if (x.t === "app") { collect(x.f); collect(x.a); }
            else if (x.t === "list") x.v.forEach(collect);
            else if (x.t === "computedRange") [x.lo, x.second, x.hi].forEach(y => y && collect(y));
            else if (x.t === "lambda") collect(x.body);
        };
        collect(e);
        const facts = evaluateKnown(e, new Map(), scope, 0) ?? {};
        if (!names.size) return facts;
        return { ...facts, expr: { e, scope, env: [...names].map(n => [n, valueEntry({ t: "var", name: n }, scope)]) } };
    }
    // The summary of a callee called with `count` arguments, if the call is complete.
    function summaryAt(type: Ty, count: number): Summary | undefined {
        let t = resolve(type);
        if (t.k === "overload") t = resolve(t.choices[0]);
        for (let n = 1; n < count; n++) {
            if (t.k !== "fn") return undefined;
            t = resolve(t.output);
        }
        if (t.k !== "fn" || !t.summary || t.summary.clauses[0].params.length !== count) return undefined;
        return t.summary;
    }
    // Facts plus whatever a pending call evaluates to with its arguments now.
    function resolveKnown(known: Known): Known {
        if (!known.call && !known.expr) return known;
        const facts = known.call
            ? evaluateCall(known.call.summary, known.call.args.map(resolveKnown), 0)
            : evaluateKnown(known.expr!.e, new Map(known.expr!.env.map(([n, v]) => [n, resolveKnown(v)])), known.expr!.scope, 0);
        const result: Known = { ...known };
        for (const key of ["index", "size", "items", "boolean", "string", "char", "float", "number", "tag"] as const) {
            if (result[key] === undefined && facts?.[key] !== undefined) (result as Record<string, unknown>)[key] = facts[key];
        }
        return result;
    }
    // Evaluate a call statically: rank its clauses as the runtime would, and
    // meet the results of every clause that might run. Bounded in depth and work.
    let evaluations = 0;
    function evaluateCall(summary: Summary, args: Known[], depth: number): Known | undefined {
        if (depth > 24 || ++evaluations > 20000) return undefined;
        const entries: Entry[] = args.map(k => ({ type: knownType(k), ...k }));
        const ranked = summary.clauses.map(c => ({ clause: c, ...rankClause(c, entries) }));
        const sure = ranked.filter(r => r.matches);
        const before = (a: typeof ranked[number], b: typeof ranked[number]) =>
            a.low > b.high || a.low >= b.high && a.clause.index < b.clause.index;
        const candidates = ranked.filter(r => !r.fails && !sure.some(d => d !== r && before(d, r)));
        if (!candidates.length) return undefined;
        let result: Known | undefined;
        for (const [n, { clause }] of candidates.entries()) {
            // Pattern-bound names shadow outer variables; only plain names get the argument's value.
            const env = new Map<string, Known>();
            clause.params.forEach((p, i) => {
                for (const name of patternNames(p)) env.set(name, {});
                if (p.p === "var" && !clause.refutable.has(p.name)) env.set(p.name, args[i]);
                // A typed pattern binds the converted value.
                // The tail of a list of known size.
                const items = args[i].items;
                if (p.p === "cons" && p.tail.p === "var" && !clause.refutable.has(p.tail.name) && args[i].size) {
                    env.set(p.tail.name, items ? known(items.slice(1)) : { size: args[i].size! - 1n });
                }
                if (p.p === "cons" && p.head.p === "var" && !clause.refutable.has(p.head.name) && items?.length) env.set(p.head.name, items[0]);
                if (p.p === "list" && items?.length === p.v.length) {
                    p.v.forEach((q, n) => { if (q.p === "var" && !clause.refutable.has(q.name)) env.set(q.name, items[n]); });
                }
                const n = numericOf(args[i]);
                if (p.p === "constr" && NUMERIC_TYPES.includes(p.tag) && p.args[0]?.p === "var" && !clause.refutable.has(p.args[0].name) && n) {
                    const tag = p.tag, inner = p.args[0].name;
                    try { env.set(inner, knownNumber(castNumeric(tag, n)) ?? {}); } catch { /* no match */ }
                }
            });
            const value = evaluateKnown(clause.body, env, summary.scope, depth + 1);
            result = n === 0 ? value : meetValues(result, value);
            if (!result) return undefined;
        }
        return result;
    }
    // The runtime type a known value certainly has, for ranking typed clauses.
    function knownType(k: Known): Ty {
        if (k.number?.typeName) return atom(k.number.typeName);
        if (k.float !== undefined) return atom("Float");
        if (k.index && !k.index.terms.size) return atom("Int");
        if (k.boolean !== undefined) return atom("Bool");
        if (k.string !== undefined) return atom("String");
        if (k.char !== undefined) return atom("Char");
        return dynamic;
    }
    // What e evaluates to, given known values of the names in env.
    function evaluateKnown(e: Expr, env: Map<string, Known>, scope: Scope, depth: number): Known | undefined {
        // Numbers use the runtime's own arithmetic and comparison (numbers.ts,
        // type-system.ts); an operation the runtime would reject gives no value.
        const attempt = (f: () => Numeric | boolean): Known | undefined => {
            try { return knownNumber(f()); } catch { return undefined; }
        };
        // Truthiness as the runtime defines it, where the value decides it.
        const truth = (k: Known | undefined): boolean | undefined => {
            if (!k) return undefined;
            if (k.boolean !== undefined) return k.boolean;
            const n = numericOf(k);
            if (n !== undefined) {
                const real = (x: Numeric): boolean => x.kind === "complex" ? real(x.re) || real(x.im) : x.kind === "float" ? x.v !== 0 && !Number.isNaN(x.v) : !equalNumbers(x, integer(0n));
                return real(n);
            }
            if (k.string !== undefined) return k.string.length > 0;
            if (k.tag !== undefined || k.char !== undefined) return true;
            return undefined;
        };
        switch (e.t) {
            case "int": return { index: constant(e.v) };
            case "float": return { float: e.v };
            case "numeric": return knownNumber(e.v);
            case "bool": return { boolean: e.v };
            case "string": return { string: e.v };
            case "char": return { char: e.v };
            case "var": {
                if (env.has(e.name)) return resolveKnown(env.get(e.name)!);
                const entry = scope.get(e.name);
                if (!entry) return undefined;
                if (/^[A-Z]/.test(e.name) && resolve(entry.type).k === "variant") return { tag: e.name };
                const index = entry.index && !entry.index.terms.size ? entry.index : undefined;
                return { index, size: entry.size, items: entry.items, boolean: entry.boolean, string: entry.string, char: entry.char, float: entry.float, number: entry.number, tag: entry.tag };
            }
            case "block": {
                if (e.stmts.some(st => st.t === "patDef" || st.t === "stmDef")) return undefined;
                const last = e.stmts[e.stmts.length - 1];
                return last && evaluateKnown(last, env, scope, depth);
            }
            case "ternary": {
                const condition = truth(evaluateKnown(e.cond, env, scope, depth));
                if (condition === true) return evaluateKnown(e.then, env, scope, depth);
                if (condition === false) return evaluateKnown(e.els, env, scope, depth);
                return meetValues(evaluateKnown(e.then, env, scope, depth), evaluateKnown(e.els, env, scope, depth));
            }
            case "unop": {
                const v = evaluateKnown(e.e, env, scope, depth);
                if (e.op === "not") { const t = truth(v); return t === undefined ? undefined : { boolean: !t }; }
                const n = numericOf(v);
                return n === undefined ? undefined : attempt(() => n.typeName ? castNumeric(n.typeName, negate(n)) : negate(n));
            }
            case "list": return known(e.v.map(x => evaluateKnown(x, env, scope, depth) ?? {}));
            case "range": return rangeKnown(e.lo, e.step, e.hi);
            case "computedRange": {
                const bound = (x: Expr | null) => x && numericOf(evaluateKnown(x, env, scope, depth));
                const lo = bound(e.lo), second = bound(e.second), hi = bound(e.hi);
                if (!lo || e.second && !second || e.hi && !hi) return undefined;
                if ([lo, second, hi].some(x => x && x.kind !== "int")) return undefined;
                type Real = Parameters<typeof rangeExpr>[0];
                const range = rangeExpr(lo as Real, second as Real | null, hi as Real | null);
                return range.t === "range" ? rangeKnown(range.lo, range.step, range.hi) : undefined;
            }
            case "binop": {
                // List sizes: x : xs is one longer than xs; xs ++ ys adds them.
                if (e.op === ":") {
                    const r = evaluateKnown(e.r, env, scope, depth);
                    if (r?.items) return known([evaluateKnown(e.l, env, scope, depth) ?? {}, ...r.items]);
                    return r?.size === undefined ? undefined : { size: r.size + 1n };
                }
                if (e.op === "++") {
                    const l = evaluateKnown(e.l, env, scope, depth), r = evaluateKnown(e.r, env, scope, depth);
                    if (l?.string !== undefined && r?.string !== undefined) return { string: l.string + r.string };
                    if (l?.items && r?.items) return known([...l.items, ...r.items]);
                    return l?.size !== undefined && r?.size !== undefined ? { size: l.size + r.size } : undefined;
                }
                if (e.op === "&&" || e.op === "||") {
                    const l = truth(evaluateKnown(e.l, env, scope, depth));
                    if (l === undefined) return undefined;
                    if (e.op === "&&" ? !l : l) return { boolean: l };
                    const r = truth(evaluateKnown(e.r, env, scope, depth));
                    return r === undefined ? undefined : { boolean: r };
                }
                const l = evaluateKnown(e.l, env, scope, depth), r = evaluateKnown(e.r, env, scope, depth);
                const x = numericOf(l), y = numericOf(r);
                if (x !== undefined && y !== undefined) {
                    if (["+", "-", "*", "/", "%"].includes(e.op)) return attempt(() => typedArithmetic(e.op, x, y));
                    if (e.op === "^") return attempt(() => typedPower(x, y));
                    if (e.op === "==" || e.op === "!=") return attempt(() => equalNumbers(x, y) === (e.op === "=="));
                    if (["<", ">", "<=", ">="].includes(e.op)) {
                        return attempt(() => {
                            const c = compareNumbers(x, y);
                            // Ordered comparisons involving NaN are false.
                            if (Number.isNaN(c)) return false;
                            return e.op === "<" ? c < 0 : e.op === ">" ? c > 0 : e.op === "<=" ? c <= 0 : c >= 0;
                        });
                    }
                    return undefined;
                }
                if (!["==", "!=", "<", ">", "<=", ">="].includes(e.op)) return undefined;
                let order: number | undefined;
                for (const key of ["string", "char"] as const) {
                    if (l?.[key] !== undefined && r?.[key] !== undefined) order = l[key]! < r[key]! ? -1 : l[key]! > r[key]! ? 1 : 0;
                }
                if (order === undefined && (e.op === "==" || e.op === "!=")) {
                    const plain = (k: Known | undefined) => k?.boolean !== undefined && numericOf(k) === undefined && k.string === undefined;
                    if (plain(l) && plain(r)) order = l!.boolean === r!.boolean ? 0 : 1;
                    // Distinct nullary constructors differ; equal tags with fields may not be equal.
                    else if (l?.tag !== undefined && r?.tag !== undefined && l.tag !== r.tag) order = 1;
                }
                if (order === undefined) return undefined;
                if (e.op === "==") return { boolean: order === 0 };
                if (e.op === "!=") return { boolean: order !== 0 };
                return { boolean: e.op === "<" ? order < 0 : e.op === ">" ? order > 0 : e.op === "<=" ? order <= 0 : order >= 0 };
            }
            case "app": {
                const args: Expr[] = [];
                let head: Expr = e;
                while (head.t === "app") { args.unshift(head.a); head = head.f; }
                if (head.t === "block" && head.stmts.length === 1 && head.style === "(") head = head.stmts[0];
                // A lambda (or operator section) applied to all its parameters.
                if (head.t === "lambda" && head.params.length === args.length) {
                    if (depth > 24 || ++evaluations > 20000) return undefined;
                    const inner = new Map(env);
                    head.params.forEach((name, n) => inner.set(name, evaluateKnown(args[n], env, scope, depth) ?? {}));
                    return evaluateKnown(head.body, inner, scope, depth + 1);
                }
                if (head.t !== "var" || env.has(head.name)) return undefined;
                const entry = scope.get(head.name);
                // List builtins over a list whose elements are known: the
                // predicate or function runs on each element, as at runtime.
                if (LIST_NATIVES.includes(head.name) && entry?.builtin && args.length === 2) {
                    const list = evaluateKnown(args[1], env, scope, depth);
                    if (head.name === "take" || head.name === "drop") {
                        const count = numericOf(evaluateKnown(args[0], env, scope, depth));
                        if (count?.kind !== "int" || count.v < 0n || list?.size === undefined) return undefined;
                        const kept = head.name === "take" ? (count.v < list.size ? count.v : list.size) : (count.v < list.size ? list.size - count.v : 0n);
                        if (!list.items) return { size: kept };
                        return known(head.name === "take" ? list.items.slice(0, Number(kept)) : list.items.slice(list.items.length - Number(kept)));
                    }
                    if (!list?.items) return head.name === "map" && list?.size !== undefined ? { size: list.size } : undefined;
                    const call = (item: Known) => evaluateKnown({ t: "app", f: args[0], a: { t: "var", name: "$item" } }, new Map([...env, ["$item", item]]), scope, depth + 1);
                    if (head.name === "map") return known(list.items.map(item => call(item) ?? {}));
                    const kept: Known[] = [];
                    for (const item of list.items) {
                        const keep = truth(call(item));
                        if (keep === undefined) return undefined;
                        if (keep) kept.push(item);
                    }
                    return known(kept);
                }
                // A numeric type applied to a number: floating types round, others
                // convert losslessly or fail, as at runtime.
                if (NUMERIC_TYPES.includes(head.name) && entry?.builtin && args.length === 1) {
                    const n = numericOf(evaluateKnown(args[0], env, scope, depth));
                    return n === undefined ? undefined : attempt(() => castNumeric(head.name, n, ["Float", "Float32", "Float64"].includes(head.name)));
                }
                if (/^[A-Z]/.test(head.name)) {
                    let t = resolve(entry?.type ?? dynamic);
                    for (let n = 0; n < args.length && t.k === "fn"; n++) t = resolve(t.output);
                    return t.k === "variant" ? { tag: head.name } : undefined;
                }
                // The builtin length of a list or String whose length is known.
                if (head.name === "length" && entry?.builtin && args.length === 1) {
                    const k = evaluateKnown(args[0], env, scope, depth);
                    const n = k?.size ?? (k?.string !== undefined ? BigInt(k.string.length) : undefined);
                    return n === undefined ? undefined : { index: constant(n) };
                }
                // The runtime's numeric natives, when the name is the builtin itself.
                const native = NUMBER_NATIVES.find(([name]) => name === head.name);
                if (native && entry?.builtin && native[1] === args.length) {
                    const values = args.map(a => numericOf(evaluateKnown(a, env, scope, depth)));
                    if (values.some(v => v === undefined)) return undefined;
                    const numbers = values as Numeric[];
                    return attempt(() => head.name === "expt" ? typedPower(numbers[0], numbers[1]) : numericNative(head.name, numbers));
                }
                if (!trustsShape(entry)) return undefined;
                const values = args.map(a => evaluateKnown(a, env, scope, depth) ?? {});
                const summary = summaryAt(entry!.type, args.length);
                const result = summary && evaluateCall(summary, values, depth);
                if (result?.size !== undefined) return result;
                // A builtin's (or inferred) result shape: an argument itself, or a
                // list as long as a constant or as an argument.
                const shape = shapeAt(entry!.type, args.length);
                const size = shape?.arg !== undefined ? values[shape.arg]?.size
                    : shape?.length ? "constant" in shape.length ? shape.length.constant : values[shape.length.param]?.size
                    : undefined;
                return size === undefined ? result : { ...result, size };
            }
            default: return undefined;
        }
    }
    // The facts both a and b agree on (clauses, ternary branches).
    function meetValues(a: Known | undefined, b: Known | undefined): Known | undefined {
        if (!a || !b) return undefined;
        const result: Known = {};
        const same = (x: unknown, y: unknown) => x !== undefined && x === y;
        if (a.index && b.index && !a.index.terms.size && !b.index.terms.size && a.index.constant === b.index.constant) result.index = a.index;
        for (const key of ["size", "boolean", "string", "char", "float", "tag"] as const) {
            if (same(a[key], b[key])) (result as Record<string, unknown>)[key] = a[key];
        }
        if (a.number && b.number && a.number.typeName === b.number.typeName && equalNumbers(a.number, b.number)) result.number = a.number;
        return Object.keys(result).length ? result : undefined;
    }
    // Is the argument's value known to equal (true) or differ from (false) this
    // number, compared exactly as the runtime compares numbers?
    function equalsNumber(argument: Entry, value: bigint | number): boolean | undefined {
        const n = numericOf(argument);
        return n === undefined ? undefined : equalNumbers(n, typeof value === "bigint" ? integer(value) : floating(value));
    }
    // A known untyped number, as the runtime represents it.
    function numericOf(k: Known | undefined): Numeric | undefined {
        if (!k) return undefined;
        if (k.index && !k.index.terms.size) return integer(k.index.constant);
        if (k.float !== undefined) return floating(k.float);
        return k.number;
    }
    // Facts for a number. Int and Float label plain numbers; other typed numbers
    // (Int32, Float32, ...) keep their type in `number`, so later arithmetic
    // checks overflow and rounds as the runtime does.
    function knownNumber(n: Numeric | boolean): Known | undefined {
        if (typeof n === "boolean") return { boolean: n };
        if (n.typeName && n.typeName !== "Int" && n.typeName !== "Float") return { number: n };
        if (n.typeName) n = { ...n, typeName: undefined } as Numeric;
        if (n.kind === "int") return { index: constant(n.v) };
        if (n.kind === "float") return { float: n.v };
        return { number: n };
    }
    // Does this argument always match p? Only what the checker knows exactly
    // qualifies (list lengths, literal values, exact types); repeated names never do.
    function definitelyMatches(p: Pattern, argument: Entry, refutable: Set<string>, score: number): boolean {
        const irrefutable = (q: Pattern) => q.p === "wildcard" || q.p === "var" && !refutable.has(q.name);
        if (irrefutable(p)) return true;
        if (p.p === "int" || p.p === "float") return equalsNumber(argument, p.v) === true;
        if (p.p === "bool") return argument.boolean === p.v;
        if (p.p === "string") return argument.string === p.v;
        if (p.p === "char") return argument.char === p.v;
        if (p.p === "range") return !!argument.index && !argument.index.terms.size && argument.index.constant >= p.lo && argument.index.constant <= p.hi;
        // A constructor the argument was visibly built with, its fields bound plainly.
        if (p.p === "constr" && !TYPE_NAMES.includes(p.tag)) return argument.tag === p.tag && p.args.every(irrefutable);
        // A certain exact-type (30) or aggregate (10) match, binding the value whole.
        if (p.p === "constr" && TYPE_NAMES.includes(p.tag) && p.tag !== "Vect" && p.args.length === 1) {
            // A lossless conversion (1) is certain only for a known value.
            return (score === 30 || score === 10 || score === 1) && irrefutable(p.args[0]);
        }
        const n = sizeOf(argument.type) ?? argument.size;
        if (n === undefined) return false;
        if (p.p === "list") return p.v.every(irrefutable) && n === BigInt(p.v.length);
        if (p.p === "cons") return irrefutable(p.head) && irrefutable(p.tail) && n >= 1n;
        return false;
    }
    // Can this argument never match p? Literal mismatches, known lengths, and
    // typed patterns that the argument's type cannot satisfy.
    function definitelyFails(p: Pattern, argument: Entry, low: number, high: number): boolean {
        if (p.p === "int" || p.p === "float") return equalsNumber(argument, p.v) === false;
        if (p.p === "bool") return argument.boolean !== undefined && argument.boolean !== p.v;
        if (p.p === "string") return argument.string !== undefined && argument.string !== p.v;
        if (p.p === "char") return argument.char !== undefined && argument.char !== p.v;
        if (p.p === "range") return !!argument.index && !argument.index.terms.size && (argument.index.constant < p.lo || argument.index.constant > p.hi);
        if (p.p === "constr" && TYPE_NAMES.includes(p.tag)) return low === -1000 && high === -1000;
        if (p.p === "constr") return argument.tag !== undefined && argument.tag !== p.tag;
        const n = sizeOf(argument.type) ?? argument.size;
        if (n === undefined) return false;
        if (p.p === "list") return n !== BigInt(p.v.length);
        if (p.p === "cons") return n === 0n;
        return false;
    }
    // Forget every list length in a (freshly copied) type graph.
    function withoutLengths(type: Ty, seen = new Set<Ty>()): Ty {
        const t = resolve(type);
        if (seen.has(t)) return type;
        seen.add(t);
        if (t.k === "list") { t.length = undefined; t.items = undefined; }
        children(t).forEach(child => withoutLengths(child, seen));
        return type;
    }
    function lengthOf(shape: Shape | undefined): LengthRef | undefined {
        return shape?.length ?? (shape?.arg !== undefined ? { param: shape.arg } : undefined);
    }
    function sameRef(a: LengthRef | undefined, b: LengthRef | undefined): boolean {
        if (!a || !b) return false;
        return "param" in a ? "param" in b && a.param === b.param : "constant" in b && a.constant === b.constant;
    }
    // The shape both a and b satisfy (clauses, ternary branches).
    function meetShapes(a: Shape | undefined, b: Shape | undefined): Shape | undefined {
        if (!a || !b) return undefined;
        if (a.arg !== undefined && a.arg === b.arg) return a;
        const length = sameRef(lengthOf(a), lengthOf(b)) ? lengthOf(a) : undefined;
        const items = a.items && b.items && a.items.length === b.items.length
            ? a.items.map((x, n) => meetShapes(x, b.items![n])) : undefined;
        return length || items?.some(Boolean) ? { length, items } : undefined;
    }
    // Rewrite a callee's shape in terms of the caller's parameters.
    function substituteShape(shape: Shape | undefined, args: (Shape | undefined)[]): Shape | undefined {
        if (!shape) return undefined;
        if (shape.arg !== undefined) return args[shape.arg];
        const length = shape.length && "param" in shape.length ? lengthOf(args[shape.length.param]) : shape.length;
        const items = shape.items?.map(item => substituteShape(item, args));
        return length || items?.some(Boolean) ? { length, items } : undefined;
    }
    // The shape of a callee's result after `count` arguments, if it is complete.
    function shapeAt(type: Ty, count: number): Shape | undefined {
        let t = resolve(type);
        if (t.k === "overload") {
            // Choices that cannot take a list (such as reverse's String clause) are excluded.
            const choices = t.choices.filter(choice => { const c = resolve(choice); return c.k === "fn" && resolve(c.input).k !== "atom"; });
            return choices.length ? choices.map(c => shapeAt(c, count)).reduce((x, y) => meetShapes(x, y)) : undefined;
        }
        for (let n = 1; n < count; n++) {
            if (t.k !== "fn") return undefined;
            t = resolve(t.output);
        }
        if (t.k !== "fn" || !t.shape) return undefined;
        const next = resolve(t.output);
        return next.k === "fn" && next.shape === t.shape ? undefined : t.shape;
    }
    // What e evaluates to, in terms of the parameters (exact: bound to the
    // whole argument; otherwise only its length is known). Value-level and
    // conservative: folds, cons, appends and filters give no shape.
    function shapeOf(e: Expr, params: { name?: string; exact: boolean }[], scope: Scope): Shape | undefined {
        switch (e.t) {
            case "var": {
                const n = params.findIndex(p => p.name === e.name);
                return n < 0 ? undefined : params[n].exact ? { arg: n } : { length: { param: n } };
            }
            case "list":
                return { length: constant(BigInt(e.v.length)), items: e.v.map(x => shapeOf(x, params, scope)) } as Shape;
            case "block": {
                const shadows = e.stmts.some(st => st.t === "patDef" || st.t === "stmDef" && params.some(p => p.name === st.name));
                const last = e.stmts[e.stmts.length - 1];
                return shadows || !last ? undefined : shapeOf(last, params, scope);
            }
            case "ternary": return meetShapes(shapeOf(e.then, params, scope), shapeOf(e.els, params, scope));
            case "unop": {
                const length = e.op === "neg" ? lengthOf(shapeOf(e.e, params, scope)) : undefined;
                return length && { length };
            }
            case "binop": {
                if (!["+", "-", "*", "/", "%", "^"].includes(e.op)) return undefined;
                const length = lengthOf(shapeOf(e.l, params, scope)) ?? lengthOf(shapeOf(e.r, params, scope));
                return length && { length };
            }
            case "app": {
                const args: Expr[] = [];
                let head: Expr = e;
                while (head.t === "app") { args.unshift(head.a); head = head.f; }
                if (head.t !== "var" || params.some(p => p.name === (head as { name: string }).name)) return undefined;
                if (head.name === "enumerate" && args.length === 1) {
                    const length = lengthOf(shapeOf(args[0], params, scope));
                    return length && { length };
                }
                const callee = scope.get(head.name);
                if (!trustsShape(callee)) return undefined;
                return substituteShape(shapeAt(callee!.type, args.length), args.map(a => shapeOf(a, params, scope)));
            }
            default: return undefined;
        }
    }
    // A fresh result type: the shape's lengths and arguments filled in from args.
    function buildShape(shape: Shape, type: Ty, args: Ty[]): Ty {
        if (shape.arg !== undefined) return args[shape.arg] ?? type;
        const t = resolve(type);
        if (t.k !== "list") return type;
        let length = t.length;
        if (!length && shape.length) {
            if ("constant" in shape.length) length = constant(shape.length.constant);
            else { const a = args[shape.length.param] && resolve(args[shape.length.param]); if (a?.k === "list") length = a.length; }
        }
        let items = t.items, element = t.element;
        if (shape.items && t.items && t.items.length === shape.items.length) {
            items = t.items.map((item, n) => shape.items![n] ? buildShape(shape.items![n]!, item, args) : item);
            if (items.some((item, n) => item !== t.items![n])) element = union(items);
        }
        return length === t.length && items === t.items ? type : { ...t, length, items, element };
    }
    function setShape(type: Ty, shape: Shape | undefined): void {
        const seen = new Set<Ty>();
        for (let t = resolve(type); t.k === "fn" && !seen.has(t); t = resolve(t.output)) { seen.add(t); t.shape = shape; }
    }
    function functionType(params: Pattern[], body: Expr, parent: Scope, recursiveName?: string, guard?: Expr): Ty {
        const outerFacts = lengthFacts;
        lengthFacts = new Map(outerFacts);
        try { return inferFunction(params, body, parent, recursiveName, guard); }
        finally { lengthFacts = outerFacts; }
    }
    function inferFunction(params: Pattern[], body: Expr, parent: Scope, recursiveName?: string, guard?: Expr): Ty {
        const scope = new Map(parent), inputs: { type: Ty; binder?: string; coerce: boolean }[] = [];
        const bound = new Set<string>(recursiveName ? [recursiveName] : []);
        const patternStart = requirements.length;
        for (const p of params) {
            const t = variable();
            bind(p, t, scope, body, bound);
            const name = p.p === "var"
                ? p.name
                : p.p === "constr" && p.args.length === 1 && p.args[0].p === "var"
                ? p.args[0].name
                : undefined;
            const previousIndex = name ? scope.get(name)?.index : undefined;
            const binder = previousIndex && previousIndex.constant === 0n && previousIndex.terms.size === 1
                ? [...previousIndex.terms.keys()][0] : name ? `n${serial++}` : undefined;
            if (name) {
                scope.set(name, {
                    ...scope.get(name)!,
                    mono: true,
                    index: { constant: 0n, terms: new Map([[binder!, 1n]]) },
                    ref: binder,
                });
            }
            const constructor = p.p === "constr" ? resolve(scope.get(p.tag)?.type ?? dynamic) : undefined;
            // A variant pattern checks its tag, not the inferred types of its
            // payloads. Only real type patterns can project Dynamic arguments.
            const converts = constructor?.k === "type" && !variables(constructor.value).size ||
                constructor?.k === "record" || constructor?.k === "list";
            inputs.push({ type: t, binder, coerce: p.p === "schema" || p.p === "contract" || p.p === "int" || converts });
        }
        // An explicit result constructor supplies the recursive signature before
        // checking the body. Only inspect its descriptor; never run user code.
        let declared: Ty | undefined;
        if (body.t === "app" && body.f.t === "app" && body.f.f.t === "app" && body.f.f.f.t === "var" &&
            resolve(scope.get(body.f.f.f.name)?.type ?? dynamic).k === "factory") {
            const descriptor = resolve(infer(body.f, scope));
            if (descriptor.k === "type") declared = descriptor.value;
        }
        if (declared && recursiveName) {
            let signature = declared;
            for (let n = inputs.length - 1; n >= 0; n--) signature = fn(inputs[n].type, signature, inputs[n].binder, inputs[n].coerce);
            scope.set(recursiveName, { type: signature, nonGeneric: captured(parent) });
        }
        const patternRequirements = requirements.splice(patternStart);
        const outerRequirements = requirements;
        requirements = [];
        let result: Ty;
        let checks: Ty[];
        try { if (guard) infer(guard, scope); result = infer(body, scope); checks = [...patternRequirements, ...requirements]; }
        finally { requirements = outerRequirements; }
        if (declared) { unify(declared, result, body); result = declared; }
        const named = params.map(p => p.p === "var" && p.name !== recursiveName ? { name: p.name, exact: true }
            : p.p === "constr" && p.args.length === 1 && p.args[0].p === "var" ? { name: p.args[0].name, exact: false }
            : { exact: false });
        const shape = shapeOf(body, named, scope);
        const all = params.flatMap(patternNames);
        const summary: Summary = { scope: parent, clauses: [{ index: 0, params, body, refutable: new Set([
            ...recursiveName ? [recursiveName] : [], ...all.filter((x, n) => all.indexOf(x) !== n)]) }] };
        for (let n = inputs.length - 1; n >= 0; n--) {
            const parameter = params[n];
            const selfName = parameter.p === "var" && parameter.name === recursiveName ? recursiveName : undefined;
            result = { k: "fn", input: inputs[n].type, output: result, binder: inputs[n].binder, coerce: inputs[n].coerce, checks: n === inputs.length - 1 ? checks : undefined, pattern: parameter, selfName };
            if (shape) result.shape = shape;
            result.summary = summary;
        }
        return result;
    }
    function define(name: string, clauses: { params: Pattern[]; body: Expr }[], scope: Scope, location: Expr): void {
        defineClauses(name, clauses, scope, location);
        const entry = scope.get(name);
        if (options.library && entry && DECLARED_KEEPS_LENGTH.has(name)) declareKeepsLength(entry.type);
    }
    // The result is a list as long as the final argument, for each overload
    // choice that takes a list.
    function declareKeepsLength(type: Ty): void {
        const t = resolve(type);
        if (t.k === "overload") { t.choices.forEach(declareKeepsLength); return; }
        let count = 0, last: Ty = t;
        for (let x: Ty = t; x.k === "fn"; x = resolve(x.output)) { count++; last = x; }
        if (count && last.k === "fn" && resolve(last.input).k !== "atom") setShape(t, { length: { param: count - 1 } });
    }
    function defineClauses(name: string, clauses: { params: Pattern[]; body: Expr }[], scope: Scope, location: Expr): void {
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
        if (options.extendDefinitions && previous?.clauses && !previous.inherited && clauses[0].params.length === previous.clauses[0].params.length) {
            const key = (clause: { params: Pattern[] }): string => {
                const names = new Map<string, number>([[name, -1]]);
                return JSON.stringify(clause.params, (field, value) => {
                    if (field === "name") { if (!names.has(value)) names.set(value, names.size); return names.get(value); }
                    return typeof value === "bigint" ? `${value}n` : value;
                });
            };
            const additions = new Map(clauses.map(c => [key(c), c]));
            clauses = previous.clauses.map(c => {
                const replacement = additions.get(key(c));
                additions.delete(key(c));
                return replacement ?? c;
            }).concat([...additions.values()]);
        }
        const collection = previous && resolve(previous.type), c = clauses[0];
        if (collection && (collection.k === "list" || collection.k === "record" || isExplicit(collection)) && c.params.length === 1) {
            const p = c.params[0];
            const asKey = (p: Pattern): Expr | undefined => {
                if (p.p === "var") return { t: "var", name: p.name };
                if (p.p === "int") return { t: "int", v: p.v };
                if (p.p === "string") return { t: "string", v: p.v };
                if (p.p === "bool") return { t: "bool", v: p.v };
                if (p.p === "char") return { t: "char", v: p.v };
                if (p.p === "float") return { t: "float", v: p.v };
                if (p.p === "recPat") return { t: "record", v: p.v.map(([key, name]) => [key, { t: "var", name }]) };
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
            // A fresh lazy definition can refer to itself. Reassignments still
            // inspect their previous binding under APN's existing rules.
            const pending = previous ? undefined : variable();
            if (pending) scope.set(name, { type: pending, mono: true });
            const body = clauses[0].body;
            const t = infer(body, ["import", "app", "pipe"].includes(body.t) ? new Map(scope) : scope);
            if (pending) unify(pending, t, location);
            if (previous && !previous.inherited) {
                const old = resolve(previous.type), next = resolve(t);
                if (old.k === "list" && next.k === "list" && !old.contracted) unify(old.element, next.element, location);
                else unify(previous.type, t, location);
            }
            scope.set(name, {
                type: t,
                // A name written more than once can change under a closure that captured it.
                ...(writes.get(name) ?? 0) > 1 ? {} : valueEntry(body, scope),
                nonGeneric: captured(new Map([...scope].filter(([key]) => key !== name))),
            });
            return;
        }
        forwardDefinitions.delete(name);
        const nonGeneric = captured(scope);
        const pending = forward.get(name) ?? variable();
        forward.delete(name);
        scope.set(name, { type: pending, mono: true });
        const groups = new Map<string, Ty>();
        const domain = (t: Ty, seen = new Set<Ty>()): string => {
            t = resolve(t);
            if (seen.has(t)) return "recursive";
            seen.add(t);
            if (t.k !== "fn") return "";
            const input = resolve(t.input);
            const patterns = (t.checks ?? []).flatMap(check => {
                if (check.k === "operation" && check.op === "remainder") return [text(check.args[1])];
                if (check.k !== "operation" || check.op !== "pattern") return [];
                const matcher = resolve(check.args[0]);
                if (matcher.k !== "fn" || matcher.pattern?.p === "var" || matcher.pattern?.p === "wildcard") return [];
                return [text(matcher.input)];
            }).join("&");
            // An empty-list clause is its own choice: merged with a cons clause, its
            // input type would reject every non-empty argument.
            const empty = input.k === "list" && input.items?.length === 0 ? "empty:" : "";
            return empty + (input.k === "variant" ? input.name : input.k === "var" ? "*" : text(input)) + patterns + ";" +
                domain(t.output, seen);
        };
        const bindsSelf = (p: Pattern): boolean => {
            switch (p.p) {
                case "as": return bindsSelf(p.left) || bindsSelf(p.right);
                case "var": return p.name === name;
                case "typeBind": return p.name === name || bindsSelf(p.value);
                case "schema": case "contract": return bindsSelf(p.value);
                case "list": return p.v.some(bindsSelf);
                case "cons": return bindsSelf(p.head) || bindsSelf(p.tail);
                case "constr": return p.args.some(bindsSelf);
                case "recPat": return p.v.some(([, binding]) => binding === name);
                default: return false;
            }
        };
        const orders = new Map<string, ClauseOrder[]>();
        for (const [index, c] of clauses.entries()) {
            const t = functionType(c.params, c.body, scope, name);
            let key = `${c.params.some(bindsSelf) ? "self:" : ""}${domain(t)}`, existing = groups.get(key);
            // A clause whose type differs from its group's only in list lengths
            // (f (Int n) = [1, 2]; f 0 = [0]) becomes its own overload choice;
            // clause ranking then decides between them at each call. Any other
            // conflict stays an error when the group is merged below.
            if (existing) {
                const merges = (a: Ty, b: Ty) => {
                    try { unify(a, b, c.body); return true; }
                    catch (error) {
                        if (!error || typeof error !== "object" || !("message" in error)) throw error;
                        return false;
                    }
                };
                if (!merges(copy(existing), copy(t)) && merges(withoutLengths(copy(existing)), withoutLengths(copy(t)))) {
                    key = `${key}#${index}`;
                    existing = undefined;
                }
            }
            const all = c.params.flatMap(patternNames);
            const refutable = new Set([name, ...all.filter((x, n) => all.indexOf(x) !== n)]);
            if (!orders.has(key)) orders.set(key, []);
            orders.get(key)!.push({ index, params: c.params, refutable });
            if (existing) {
                // The group's type is the first clause's: keep only the shape every clause has.
                const first = resolve(existing), next = resolve(t);
                const shape = first.k === "fn" && next.k === "fn" ? meetShapes(first.shape, next.shape) : undefined;
                unify(existing, t, c.body);
                setShape(existing, shape);
            }
            else groups.set(key, t);
        }
        // Every choice evaluates calls against all clauses, as the runtime dispatches.
        const summary: Summary = { scope, clauses: clauses.map((c, index) => {
            const order = [...orders.values()].flat().find(o => o.index === index)!;
            return { ...order, body: c.body };
        }) };
        for (const [key, group] of groups) {
            const seen = new Set<Ty>();
            for (let t = resolve(group); t.k === "fn" && !seen.has(t); t = resolve(t.output)) {
                seen.add(t);
                t.clauses = orders.get(key);
                t.summary = summary;
            }
        }
        const alternatives = [...groups.values()];
        if (alternatives.length === 1) {
            unify(pending, alternatives[0], location);
            scope.set(name, { type: pending, nonGeneric, clauses });
        } else {
            const overload: Ty = { k: "overload", choices: alternatives };
            if (pending.k === "var" && !pending.link) pending.link = overload;
            scope.set(name, { type: overload, nonGeneric, clauses });
        }
    }
    const scope: Scope = new Map(TYPE_NAMES.map((name) => [name, { type: { k: "type", value: atom(name) } }]));
    scope.set("Vect", { type: { k: "factory", args: [] } });
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
            cast: fn({ k: "type", value: a }, fn(explicitDynamic, a)),
            fail: fn(atom("String"), variable()),
        })
    ) scope.set(name, { type });
    const standardOnly = new Set(["seq", "chars", "fromChars", "upper", "lower", "readFile", "readStdin"]);
    const native = (name: string, inputs: Ty[], output: Ty) => {
        if (!standardOnly.has(name) || options.library) scope.set(name, { type: inputs.reduceRight((result, input) => fn(input, result), output) });
    };
    const int = atom("Int"), str = atom("String"), bool = atom("Bool"), num = atom("Number");
    const empty = list(variable(), constant(0n));
    for (const name of ["print", "emit"]) { const t = variable(); native(name, [t], t); }
    native("assert", [variable()], empty);
    native("isType", [variable(), variable()], bool);
    native("parse", [str], explicitDynamic);
    native("step", [int, variable()], explicitDynamic);
    for (const name of ["quote", "debug", "toAST", "use", "distinct", "load"]) scope.set(name, { type: { k: "intrinsic", name } });
    native("exit", [int], empty);
    native("null", [variable()], bool);
    native("length", [list(variable())], int);
    for (const name of ["take", "drop"]) { const t = variable(); native(name, [int, list(t)], list(t)); }
    { const t = variable(); native("iterate", [fn(t, t), t], list(t)); }
    for (const name of ["foldl", "foldr"]) {
        const a = variable(), b = variable();
        native(name, [fn(name === "foldl" ? b : a, fn(name === "foldl" ? a : b, b)), b, list(a)], b);
    }
    { const a = variable(), b = variable(), c = variable(); native("zipWith", [fn(a, fn(b, c)), list(a), list(b)], list(c)); }
    { const a = variable(), b = variable(); native("seq", [a, b], b); }
    { const seq = scope.get("seq"); if (seq) {
        setShape(seq.type, { arg: 1 });
        const summary: Summary = { scope, clauses: [{ index: 0, params: [{ p: "var", name: "a" }, { p: "var", name: "b" }], body: { t: "var", name: "b" }, refutable: new Set() }] };
        for (let t = resolve(seq.type), n = 0; t.k === "fn" && n < 2; t = resolve(t.output), n++) t.summary = summary;
    } }
    setShape(scope.get("map")!.type, { length: { param: 1 } });
    native("toString", [variable()], str);
    native("intToString", [int], str);
    native("format", [str, list(variable())], str);
    native("chars", [str], list(atom("Char")));
    native("fromChars", [list(atom("Char"))], str);
    for (const name of ["upper", "lower", "readFile"]) native(name, [str], str);
    native("readStdin", [empty], str);
    if (options.library) scope.set("getArgs", { type: list(str) });
    for (const name of ["isInteger", "isExact", "isInexact", "isReal", "isComplex", "isRational", "isNumber", "isFinite", "isNaN", "isEven", "isOdd", "isInfinite", "isZero", "isPositive", "isNegative"]) native(name, [["isNumber", "isComplex", "isReal", "isRational", "isInteger"].includes(name) ? variable() : num], bool);
    for (const name of ["sqrt", "sin", "cos", "tan", "asin", "acos", "atan", "exp", "log", "abs", "exact", "inexact", "realPart", "imagPart", "magnitude", "angle", "conjugate"]) native(name, [num], num);
    for (const name of ["floor", "ceiling", "truncate", "round", "numerator", "denominator"]) native(name, [num], num);
    for (const name of ["min", "max", "atan2", "makeRectangular", "makePolar", "expt", "rationalize"]) native(name, [num, num], num);
    for (const name of ["quotient", "remainder", "modulo", "gcd", "lcm"]) native(name, [int, int], int);
    for (const name of ["pairs", "keys", "values", "enumerate", "length"]) scope.set(name, { type: { k: "intrinsic", name } });
    for (const name of ["lookup", "has", "remove", "insert"]) {
        const key = variable(), value = variable(), map: Ty = { k: "map", key, value };
        native(name, [name === "insert" ? list(pair(key, value)) : key, map], name === "lookup" ? value : name === "has" ? bool : map);
    }
    scope.set("set", { type: { k: "intrinsic", name: "set", arity: 2 } });
    scope.set("insert", { type: { k: "intrinsic", name: "insert", arity: 2 } });
    scope.set("cast", { type: { k: "intrinsic", name: "cast", arity: 2 } });
    scope.set("do", { type: { k: "intrinsic", name: "do" } });
    scope.set("match", { type: { k: "intrinsic", name: "match", arity: 2 } });
    if (options.library) {
        const a = variable(), b = variable(), c = variable();
        native("bracket", [a, fn(a, b), fn(a, c)], c);
        for (const name of ["withLibrary", "allocate", "peek", "poke", "offset", "nullPointer", "withFile"]) scope.set(name, { type: explicitDynamic });
    }
    for (const entry of scope.values()) { entry.inherited = true; entry.builtin = true; }
    if (options.initial) for (const [name, entry] of copyTypeScope(options.initial)) scope.set(name, entry);
    const originalScope = new Map(scope);
    const forward = new Map<string, Ty>();
    const forwardDefinitions = new Map<string, Extract<TopLevel, { t: "def" }>>();
    const analyzed = new Set<TopLevel>();
    const rootScope = scope;
    for (const statement of program) if (statement.t === "def" && statement.clauses[0].params.length && !scope.has(statement.name)) {
        const t = variable(); forward.set(statement.name, t);
        forwardDefinitions.set(statement.name, statement);
        scope.set(statement.name, { type: t });
    }
    function validate(t: Ty, seen = new Set<Ty>()): void {
        const value = resolve(t);
        if (seen.has(value)) return;
        seen.add(value);
        for (const child of children(value)) validate(child, seen);
    }
    for (const statement of program) {
        checkingExpression = statement.t === "expr" || statement.t === "patDef" ? statement.value : statement.t === "def" ? statement.clauses[0].body : undefined;
        try {
            if (statement.t === "def") {
                if (!analyzed.has(statement)) define(statement.name, statement.clauses, scope, statement.clauses[0].body);
            }
            else if (statement.t === "type") {
                const d = statement.def, parameters = new Map((d.parameters ?? []).map((p) => [p, variable()]));
                const result: Ty = { k: "variant", name: d.name, args: [...parameters.values()], ordinal: d.variants.every(v => !v.fields?.length) };
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
            } else if (statement.t === "expr") validate(infer(statement.value, scope));
            else validate(infer(statement, scope));
        } catch (error) {
            if (error && typeof error === "object" && "pos" in error && "message" in error) {
                issues.push(error as TypeIssue);
            } else throw error;
        }
    }
    // A check that still waits only because a value was symbolic must not be
    // skipped: decide it now, treating that value as unknown.
    const leftover = requirements.filter(r => { deciding = false; const waits = waiting(r); deciding = true; return waits && !waiting(r); });
    for (const requirement of leftover) {
        try { resolve(requirement); }
        catch (error) {
            if (error && typeof error === "object" && "pos" in error && "message" in error) issues.push(error as TypeIssue);
            else throw error;
        }
    }
    deciding = false;
    if (options.strict && dynamicBoundaries && !issues.length && firstUnbound) {
        // An unknown name is the usual cause; report it rather than the boundary count.
        const loc = sourceLocations.get(firstUnbound.expr);
        issues.push({ message: `unbound variable '${firstUnbound.name}'`, hint: firstUnbound.hint, pos: loc?.start ?? 0, len: Math.max(1, (loc?.end ?? 1) - (loc?.start ?? 0)), source: loc?.source, file: loc?.file });
    } else if (options.strict && dynamicBoundaries && !issues.length) {
        const loc = firstUnknown && sourceLocations.get(firstUnknown);
        issues.push({ message: `cannot establish static types: ${dynamicBoundaries} unresolved dynamic boundaries; mark runtime code with Dynamic`, pos: loc?.start ?? 0, len: Math.max(1, (loc?.end ?? 1) - (loc?.start ?? 0)), source: loc?.source, file: loc?.file });
    }
    options.result?.(scope, new Map([...scope].filter(([name, entry]) => originalScope.get(name) !== entry)));
    return { issues, dynamicBoundaries, runtimeChecks };
}
export function checkSource(source: string, file = "<input>", options: CheckOptions = {}): CheckResult {
    return checkTypes(parseDocument(source), options);
}
export function requireChecked(source: string, file = "<input>"): CheckResult {
    const result = checkSource(source, file, { strict: true });
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
            const source = await Deno.readTextFile(file);
            const { CheckingSession } = await import("./checking-session.ts");
            const slash = file.lastIndexOf("/");
            new CheckingSession().prepare(parse(source, file), slash < 0 ? "." : file.slice(0, slash));
            console.log(`${file}: checked`);
        } catch (error) {
            failed = true;
            console.error(String(error));
        }
    }
    return failed ? 1 : 0;
}
