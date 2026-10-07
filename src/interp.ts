import { CheckingSession } from "./checking-session.ts";
import { checkInterrupt } from "./interrupt.ts";
export { checkInterrupt, setInterruptFlag, resetInterrupt } from "./interrupt.ts";
import { describeType } from "./type-description.ts";
import { sourceLocations } from "./ast.ts";
import { builtinZero } from "./zero-values.ts";
import { isStringKey, keyText, keySource } from "./record-keys.ts";
import typeSource from "../lib/type.apn" with { type: "text" };
import doSource from "../lib/do.apn" with { type: "text" };
import { STANDARD_NATIVES, standardNative } from "./standard-natives.ts";
import { TYPE_NAMES, NUMERIC_TYPES, numericType, numericPayload, matchesType, castNumeric, implicitOperands, typedArithmetic, typedPower, numericHash } from "./type-system.ts";
import { parseNumberText, isNumeric, arithmetic, negate, equalNumbers, compareNumbers, numericNative, NUMBER_NATIVES, integer, type Real } from "./numbers.ts";
import { APNError, didYouMean } from "./errors.ts";
import type { Expr, Pattern, TopLevel } from "./ast.ts";
import type { DefClause, Type } from "./types.ts";
import { type Value, Env } from "./types.ts";
import { mkInt, mkBool, mkStr, mkList, valueToString, rawString } from "./types.ts";
import { KEYWORDS } from "./lexer.ts";
import { parse, exprToSource, patternSource, rangeExpr } from "./parser.ts";

// ---------------- Evaluator ----------------

// Internal control transfers, caught only by their matching execution loop.
class TailCall {
    constructor(readonly body: Expr, readonly env: Env) {}
}
class TailLoad {
    constructor(readonly path: Value, readonly env: Env) {}
}

const STACK_LIMIT = 512; // below V8's own JS stack, so APN errors first

// Native registry: name -> arity. One source of truth for env registration
// and for REPL tab completion.
export const NATIVES: Array<[string, number]> = [
    ...NUMBER_NATIVES,
    ["env", 0], ["distinct", 1], ["assert", 1], ["match", 2], ["set", 2], ["typeOf", 1], ["isType", 2], ["insert", 2], ["lookup", 2], ["has", 2], ["remove", 2], ["keys", 1], ["values", 1],
    ["print", 1], ["head", 1], ["tail", 1], ["length", 1], ["null", 1],
    ["iterate", 2], ["enumerate", 1], ["map", 2], ["filter", 2], ["foldl", 3], ["foldr", 3],
    ["intToString", 1], ["pairs", 1], ["format", 2], ["zipWith", 3],
    ["take", 2], ["drop", 2], ["toString", 1], ["parse", 1], ["debug", 1], ["exit", 1], ["load", 1], ["use", 1],
    ["emit", 1], ["step", 2], ["quote", 1], ["toAST", 1],
];

export class Interpreter {
    // Enabled by normal CLI/REPL execution. Foreign name installation
    // and reflected writes must preserve the visible bindings it has checked.
    checkedExecution = false;
    private checking?: CheckingSession;
    private runDepth = 0;
    private dynamicDepth = 0;

    enableChecking(): void {
        this.checkedExecution = true;
        this.checking = new CheckingSession();
        this.checking.moduleSources = this.moduleSources;
        this.checking.extendDefinitions = this.extendDefinitions;
    }
    private preludeBindings = new Map<string, Value>();
    hostNatives = new Map<string, (args: Value[]) => Value>();
    programArgs: string[] = [];
    moduleSources?: Record<string, string>;
    extendDefinitions = false;
    private modules = new Map<string, Extract<Value, { kind: "record" }>>();
    private importing = new Set<string>();

    importStandard(module: string | string[], open = true): Value {
        if (this.checking && !this.dynamicDepth) this.checking.module(module);
        if (Array.isArray(module)) {
            const fields = new Map<string, Value>();
            for (const name of module) {
                const record = this.importStandard(name, false) as Extract<Value, { kind: "record" }>;
                for (const [key, value] of record.v) fields.set(key, value);
            }
            if (open) this.publishForeignBindings(this.env, [...fields]);
            return { kind: "record", v: [...fields] };
        }
        const names = ["type", "function", "option", "sequence", "array", "number", "text", "map", "meta", "combinator", "io", "search", "html", "browser", "system", "p5", "ffi"];
        const name = module === "std" ? "std" : module.startsWith("std/") && names.includes(module.slice(4)) ? module.slice(4) : null;
        if (!name) throw new APNError("runtime", `unknown module '${module}'`);
        let record = this.modules.get(module);
        if (!record) {
            if (this.importing.has(module)) throw new APNError("runtime", `cyclic import '${module}'`);
            this.importing.add(module);
            const caller = this.env;
            const callerDir = this.sourceDir;
            const extend = this.extendDefinitions;
            // Modules resolve against builtins, never arbitrary caller bindings.
            const builtins = new Env();
            for (const type of TYPE_NAMES) builtins.setLocal(type, { kind: "type", name: type });
            for (const [name, arity] of [...NATIVES, ...STANDARD_NATIVES]) builtins.setLocal(name, { kind: "native", name, arity, applied: [] });
            for (const [name, value] of this.preludeBindings) builtins.setLocal(name, value);
            const scope = new Env(builtins);
            const builtinExports: Record<string, string[]> = {
                ffi: ["withLibrary", "allocate", "peek", "poke", "offset", "nullPointer"],
                io: ["withFile", "readFile", "readStdin", "getArgs"],
                function: ["bracket", "fail", "seq", "do"],
                sequence: [],
                text: ["chars", "fromChars", "upper", "lower"],
            };
            for (const exported of builtinExports[name] ?? []) scope.setLocal(exported, builtins.get(exported)!);
            try {
                const source = this.moduleSources
                    ? this.moduleSources[name] ?? (() => { throw new APNError("runtime", `module '${module}' is not bundled`); })()
                    : Deno.readTextFileSync(new URL(`../lib/${name}.apn`, import.meta.url));
                const program = parse(source, module);
                this.env = scope;
                this.extendDefinitions = false;
                this.sourceDir = new URL("../lib/", import.meta.url).pathname;
                this.runDepth++;
                try { this.run(program); } finally { this.runDepth--; }
                // The bundled cast is already installed from this exact source.
                // Reuse its identity when std/type reexports it.
                if (name === "type" && source === typeSource) scope.setLocal("cast", this.preludeBindings.get("cast")!);
                record = { kind: "record", v: [...scope.map.entries()] };
                this.modules.set(module, record);
            } finally {
                this.env = caller;
                this.sourceDir = callerDir;
                this.extendDefinitions = extend;
                this.importing.delete(module);
            }
        }
        if (open) this.publishForeignBindings(this.env, record.v);
        return record;
    }

    env = new Env();
    stack = 0;
    // Directory of the source file currently being evaluated — `load` resolves
    // relative paths against it ("relative to your current file").
    sourceDir: string = ".";
    sourceFile = "<repl>";

    constructor() {
        for (const name of TYPE_NAMES) this.env.setLocal(name, { kind: "type", name });
        for (const [name, arity] of NATIVES) {
            this.env.setLocal(name, { kind: "native", name, arity, applied: [] });
        }
        const outer = this.env;
        this.env = new Env(outer);
        this.env.setLocal("fail", { kind: "native", name: "fail", arity: 1, applied: [] });
        this.run(parse(typeSource));
        this.run(parse(doSource));
        for (const name of ["cast", "do"]) this.preludeBindings.set(name, this.env.get(name)!);
        this.env = outer;
        for (const [name, value] of this.preludeBindings) outer.setLocal(name, value);
    }

    run(program: TopLevel[], tailLoad = false): Value {
        const candidate = this.checking && !this.runDepth && !this.dynamicDepth
            ? this.checking.prepare(program, this.sourceDir) : undefined;
        const saved = candidate ? new Map(this.env.map) : undefined;
        let succeeded = false;
        this.runDepth++;
        try {
            let last: Value = { kind: "list", v: [] };
            for (const [index, tl] of program.entries()) {
                if (tl.t === "type") {
                    for (const name of [tl.def.name, ...tl.def.variants.map(v => v.tag)]) {
                        const previous = this.env.map.get(name);
                        if (previous && ((previous.kind === "native" && previous.tag) || previous.kind === "variant") && previous.family?.name !== tl.def.name) {
                            throw new APNError("runtime", `cannot redeclare value constructor ${name}; it belongs to ${previous.family?.name}`);
                        }
                    }
                    const family = { name: tl.def.name, parameters: tl.def.parameters ?? [], fields: new Map(tl.def.variants.map(v => [v.tag, v.fields ?? []])), env: new Env(this.env) };
                    this.env.setLocal(tl.def.name, { kind: "type", name: tl.def.name, family });
                    for (const v of tl.def.variants) {
                        if (v.arity === 0) {
                            // Nullary constructors are themselves the value.
                            this.env.setLocal(v.tag, { kind: "variant", tag: v.tag, v: [], family });
                        } else {
                            this.env.setLocal(v.tag, {
                                kind: "native", name: "__constr", arity: v.arity, applied: [], tag: v.tag, family,
                            });
                        }
                    }
                    for (const name of [tl.def.name, ...tl.def.variants.map(v => v.tag)]) family.env.setLocal(name, this.env.get(name)!);
                    continue;
                }
                if (tl.t === "def") {
                    last = this.evalDef(tl.name, tl.clauses);
                    continue;
                }
                if (tl.t === "patDef") {
                    last = this.evalPatBinding(tl);
                    continue;
                }
                // a bare expression statement: 0-arg functions and thunks RUN here
                const tail = tailLoad && index === program.length - 1;
                const value = this.eval(tl.value, tail);
                last = tl.value.t === "import" ? { kind: "list", v: [] } : this.runStmt(value, tail);
            }
            succeeded = true;
            return last;
        } finally {
            this.runDepth--;
            if (!succeeded && saved) {
                this.env.map.clear();
                for (const [name, value] of saved) this.env.map.set(name, value);
            }
            if (candidate && succeeded) {
                const visible = new Set<string>();
                for (let scope: Env | null = this.env; scope; scope = scope.parent) for (const name of scope.map.keys()) visible.add(name);
                this.checking!.commit(candidate, visible);
            }
        }
    }

    evalDef(name: string, clauses: DefClause[]): Value {
        if (/^[A-Z]/.test(name)) {
            const existing = this.env.get(name);
            if (existing && ((existing.kind === "native" && existing.tag) || existing.kind === "variant")) {
                return this.evalPatBinding({ pattern: { p: "constr", tag: name, args: clauses[0].params }, value: clauses[0].body });
            }
            if (clauses.length !== 1 || clauses[0].params.some(p => p.p !== "var")) throw new APNError("runtime", "type aliases require distinct type-parameter names");
            const parameters = clauses[0].params.map(p => (p as Extract<Pattern, { p: "var" }>).name);
            if (new Set(parameters).size !== parameters.length) throw new APNError("runtime", "duplicate type parameter");
            const scope = new Env(this.env);
            const alias: Value = parameters.length
                ? { kind: "type", name, alias: { parameters, body: clauses[0].body, env: scope } }
                : this.defer(() => {
                    const caller = this.env;
                    this.env = scope;
                    try {
                        const value = this.reference(this.eval(clauses[0].body));
                        if (!this.isTypeValue(value)) throw new APNError("runtime", `${name} must alias a type; use | to declare constructors`);
                        if (value.kind === "type" && value.family?.base && value.family.name === "<distinct>") {
                            value.family.name = name;
                            return { ...value, name };
                        }
                        return value;
                    } finally { this.env = caller; }
                });
            scope.setLocal(name, alias);
            this.env.setLocal(name, alias);
            return alias;
        }
        // Existing collections interpret the parameter as a key expression;
        // unbound/function names retain ordinary pattern-clause definitions.
        const previous = this.env.get(name);
        if (previous !== undefined && clauses[0].params.length > 0 &&
            previous.kind !== "clauseFn" && (previous.kind !== "native" || previous.name === "env") &&
            !(previous.kind === "closure" && previous.params.length > 0) &&
            !(previous.kind === "thunk" && previous.body.t === "placeholder")) {
            let collection = this.dataValue(previous);
            if (collection.kind === "record" || this.isList(collection)) {
                for (const clause of clauses) {
                    if (clause.params.length !== 1) throw new APNError("runtime", "collection assignment needs one index or field name");
                    const key = this.dataValue(this.eval(this.assignmentKey(clause.params[0])));
                    collection = this.assignItem(collection, key, clause.body);
                    if (!(collection.kind === "record" && collection.scope)) this.env.setLocal(name, collection);
                }
                return collection;
            }
        }
        // A def with parameters is a pattern-dispatch function.
        if (clauses[0].params.length >= 1) {
            const arity = clauses[0].params.length;
            if (this.extendDefinitions && previous?.kind === "clauseFn" && previous.arity === arity && this.env.map.get(name) === previous) {
                const key = (c: DefClause) => {
                    const names = new Map<string, number>([[name, -1]]);
                    return JSON.stringify(c.params, (field, value) => {
                        if (field === "name") { if (!names.has(value)) names.set(value, names.size); return names.get(value); }
                        return typeof value === "bigint" ? `${value}n` : value;
                    });
                };
                const additions = new Map(clauses.map((c) => [key(c), c]));
                clauses = previous.clauses.map((c) => {
                    const replacement = additions.get(key(c));
                    additions.delete(key(c));
                    return replacement ?? c;
                }).concat([...additions.values()]);
            }
            // Capture a shared env containing the binding itself, enabling recursion.
            const child = new Env(this.env);
            const fn: Value = {
                kind: "clauseFn", name, clauses, arity, env: child, applied: [],
            };
            child.setLocal(name, fn);
            this.env.setLocal(name, fn);
            return fn;
        }
        // Value-style def: single clause, no params.
        const value = clauses[0].body;
        if (value.t === "import") {
            const imported = this.defer(() => this.importStandard(value.module, false));
            this.env.setLocal(name, imported);
            return imported;
        }
        // Lambda bodies become closures (with recursion via shared env), like before.
        if (value.t === "lambda") {
            const child = new Env(this.env);
            const clo: Value = { kind: "closure", params: value.params, body: value.body, env: child };
            child.setLocal(name, clo);
            this.env.setLocal(name, clo);
            return clo;
        }
        // An ACTION body (a block, an application, or a pipe — with or without
        // {}s, `f = print "hi"` == `f = { print "hi" }`) declares a 0-arg
        // FUNCTION: nothing runs at the definition, expression position yields
        // the function itself, statement position CALLS it (the bare name runs).
        if (value.t === "block" || value.t === "app" || value.t === "pipe") {
            const child = new Env(this.env);
            const clo: Value = { kind: "closure", params: [], body: value, env: child };
            child.setLocal(name, clo);
            this.env.setLocal(name, clo);
            return clo;
        }
        // Otherwise it's a lazy value binding: a THUNK. The body is not run at
        // definition time. Forcing memoizes the outer value across aliases and
        // arguments; lazy container components retain their own thunks.
        const thunk: Value = { kind: "thunk", body: value, env: this.env, value: undefined };
        this.env.setLocal(name, thunk);
        return thunk;
    }

    // These forms have both a pattern reading (function definitions) and an
    // expression reading (an existing collection's index). Never bind names here.
    private assignmentKey(pattern: Pattern): Expr {
        switch (pattern.p) {
            case "var": return { t: "var", name: pattern.name };
            case "int": return { t: "int", v: pattern.v };
            case "string": return { t: "string", v: pattern.v };
            case "bool": return { t: "bool", v: pattern.v };
            case "list": return { t: "list", v: pattern.v.map(p => this.assignmentKey(p)) };
            case "typeBind": return { t: "app", f: { t: "var", name: pattern.name }, a: this.assignmentKey(pattern.value) };
            case "constr": return pattern.args.reduce<Expr>((f, arg) => ({ t: "app", f, a: this.assignmentKey(arg) }), { t: "var", name: pattern.tag });
            default: throw new APNError("runtime", "collection assignment needs an index expression, not a destructuring pattern");
        }
    }

    private assignSlot(slot: Value, value: Value): Value {
        // Inspect the old slot without invoking an action stored there.
        slot = this.force(slot);
        if (isNumeric(slot)) {
            const target = numericType(slot);
            if (!isNumeric(value)) {
                const source = this.renderString(this.callNative("typeOf", [value]));
                throw new APNError("runtime", `cannot convert ${source} to ${target}`);
            }
            return this.constructType(target, value);
        }
        if (slot.kind === "variant" && slot.family) {
            return this.conform({ kind: "type", name: slot.family.name, family: slot.family, arguments: slot.arguments }, value);
        }
        if (slot.kind === "contract") return this.conform({ kind: "functionType", from: slot.from, to: slot.to }, value);
        return value;
    }

    private protectDynamicWrite(previous: Value, incoming: Value, name: string): Value {
        const old = this.force(previous), value = this.force(incoming);
        if (old === value) return value;
        const reject = (detail: string): never => {
            throw new APNError("runtime", `Dynamic write to '${name}': ${detail}`);
        };
        if (isNumeric(old)) return this.assignSlot(old, this.dataValue(value));
        if (old.kind === "contract") return this.conform({ kind: "functionType", from: old.from, to: old.to }, value);
        if (old.kind === "type" || old.kind === "functionType") {
            if (!this.sameType(old, value)) reject("cannot change an established type descriptor");
            return value;
        }
        if (old.kind === "native" && value.kind === "native" && old.name === value.name &&
            old.arity === value.arity && old.invoke === value.invoke && old.family === value.family &&
            old.tag === value.tag && !old.applied.length && !value.applied.length) return value;
        if (["closure", "clauseFn", "native"].includes(old.kind)) {
            return reject("replacing a function requires an existing explicit function contract");
        }
        if (old.kind === "record") {
            if (value.kind !== "record") return reject("expected a Record");
            if (old.scope || value.scope) return reject("cannot replace an environment reference");
            const fields = new Map(value.v);
            for (const [key, item] of old.v) {
                if (!fields.has(key)) reject(`missing field '${key}'`);
                const replacement = fields.get(key)!;
                fields.set(key, this.defer(() => this.protectDynamicWrite(item, replacement, `${name}.${key}`)));
            }
            return { kind: "record", v: [...fields] };
        }
        if (this.isList(old)) {
            if (!this.isList(value)) return reject("expected a List");
            // Preserve both positional types and length, checking lazily so
            // finite observations of infinite values remain possible.
            const guard = (before: Value, after: Value): Value => this.defer(() => {
                const a = this.cell(before), b = this.cell(after);
                if (!a || !b) {
                    if (a !== b) reject("list length changed");
                    return mkList([]);
                }
                return { kind: "cons", head: this.defer(() => this.protectDynamicWrite(a.head, b.head, `${name}[]`)), tail: guard(a.tail, b.tail) };
            });
            const guarded = guard(old, value);
            return old.kind === "list" && old.schema ? this.conform(old.schema, guarded) : guarded;
        }
        if (old.kind === "variant" && old.family) {
            if (value.kind !== "variant" || value.family !== old.family) return reject(`expected ${old.family.name}`);
            if (old.arguments?.length) return this.conform({ kind: "type", name: old.family.name, family: old.family, arguments: old.arguments }, value);
            if (!value.v.length) return value;
            if (old.tag !== value.tag || old.v.length !== value.v.length) return reject("variant replacement needs an explicit specialized family contract");
            return { ...value, v: value.v.map((item, index) => this.defer(() => this.protectDynamicWrite(old.v[index], item, name))) };
        }
        if (["mutable", "pointer", "hashmap"].includes(old.kind)) return reject("cannot replace an opaque reference without a contract");
        if (old.kind !== value.kind) return reject(`cannot replace ${old.kind} with ${value.kind}`);
        return value;
    }

    private publishForeignBindings(scope: Env, bindings: Array<[string, Value]>): void {
        const pending = new Map<string, Value>();
        for (const [key, value] of bindings) {
            const old = pending.get(key) ?? (this.checking && !this.dynamicDepth ? scope.map.get(key) : scope.get(key));
            pending.set(key, this.checkedExecution && old ? this.protectDynamicWrite(old, value, key) : value);
        }
        for (const [key, value] of pending) scope.setLocal(key, value);
    }

    private listIndex(value: Value): bigint | undefined {
        if (value.kind === "int") return value.v;
        if (value.kind !== "variant" || value.v.length || !value.family?.fields?.size) return undefined;
        const fields = value.family.fields;
        if ([...fields.values()].some(args => args.length)) return undefined;
        const index = [...fields.keys()].indexOf(value.tag);
        return index < 0 ? undefined : BigInt(index);
    }

    private arithmeticValue(value: Value): Value {
        const v = this.dataValue(value);
        const ordinal = v.kind === "variant" ? this.listIndex(v) : undefined;
        return ordinal === undefined ? v : mkInt(ordinal);
    }

    private environmentValue(scope = this.env, guarded = false): Extract<Value, { kind: "record" }> {
        return {
            kind: "record", scope, guarded,
            get v() {
                const names = new Map<string, Value>();
                for (let current: Env | null = scope; current; current = current.parent) {
                    for (const [name, value] of current.map) if (!names.has(name)) names.set(name, value);
                }
                return [...names.entries()];
            },
        };
    }

    private updateEnvironment(record: Extract<Value, { kind: "record" }>, entries: Array<[string, Value]>): Value {
        const scope = record.scope!;
        const updates = entries.map(([name, value]): [string, Value] => {
            if (!/^[A-Za-z_][A-Za-z0-9_']*$/.test(name) || name === "_" || KEYWORDS.has(name)) throw new APNError("runtime", `invalid binding name '${name}'`);
            const old = scope.get(name);
            return [name, old === undefined ? value : record.guarded || this.checkedExecution
                ? this.protectDynamicWrite(old, value, name) : this.assignSlot(old, value)];
        });
        // Publish only after every conversion succeeds. Update the nearest visible
        // binding; absent names are added to the captured scope.
        for (const [name, value] of updates) scope.set(name, value);
        return record;
    }

    private assignItem(collection: Value, key: Value, expression: Expr): Value {
        if (this.isList(collection)) {
            if (this.isList(key)) {
                // Resolve indices and RHS against the old binding, then publish one copy.
                const indices = this.items(key).map(value => {
                    const index = this.listIndex(this.dataValue(value));
                    if (index === undefined) throw new APNError("runtime", "list assignment needs integer indices or enumeration values");
                    this.index(collection, index); // bounds without demanding the element
                    return index;
                });
                let rest = this.dataValue(this.eval(expression));
                if (!this.isList(rest)) throw new APNError("runtime", "multi-index assignment needs a list of values");
                const values: Value[] = [];
                for (const _index of indices) {
                    const cell = this.cell(rest);
                    if (!cell) throw new APNError("runtime", "index count does not match value count");
                    values.push(this.demand(cell.head));
                    rest = cell.tail;
                }
                if (this.cell(rest)) throw new APNError("runtime", "index count does not match value count");
                // Check each conversion against its original slot, even for duplicate indices.
                const checked = indices.map((index, n) => this.setIndex(collection, index, values[n]));
                let result = collection;
                for (let n = 0; n < indices.length; n++) result = this.setIndex(result, indices[n], this.index(checked[n], indices[n]));
                return result;
            }
            const index = this.listIndex(key);
            if (index === undefined) throw new APNError("runtime", "list assignment needs an integer index or a nullary variant from an enumeration");
            const value = this.demand(this.eval(expression));
            return this.setIndex(collection, index, value);
        }
        if (collection.kind === "record") {
            if (key.kind !== "string") throw new APNError("runtime", "record assignment needs a string field name");
            const value = this.demand(this.eval(expression));
            if (collection.scope) return this.updateEnvironment(collection, [[key.v, value]]);
            const fields = collection.v.slice();
            const index = fields.findIndex(([field]) => field === key.v);
            if (index < 0) fields.push([key.v, value]);
            else fields[index] = [key.v, this.assignSlot(collection.v[index][1], value)];
            return { kind: "record", v: fields };
        }
        throw new APNError("runtime", "indexed assignment expects an existing list or record");
    }

    // Destructuring binding:  [name, hello] = value  (or (Just x) = value, ...).
    // Evaluates the RHS, matches the pattern, and binds the destructured names
    // in the CURRENT environment (top level or the enclosing block's env).
    evalPatBinding(b: { pattern: Pattern; value: Expr; eager?: boolean }): Value {
        // Selecting fields must not first open every export into this scope.
        const evaluated = b.value.t === "import"
            ? this.importStandard(b.value.module, false)
            : this.eval(b.value);
        const v = b.eager ? this.reference(evaluated) : this.force(evaluated);
        if ((b.value.t === "setFields" || b.value.t === "setItem") && v.kind === "record" && v.scope) return v;
        const binds = new Map<string, Value>();
        if (!this.matchPattern(b.pattern, v, binds)) {
            throw new Error("Runtime: binding pattern did not match its value");
        }
        for (const [k, bv] of binds) this.env.setLocal(k, bv);
        return v;
    }


    // S-expression of an expression: nested APN lists, head first —
    //   toAST (1 + 2)  =>  [+, 1, 2]
    sexprOf(e: import("./ast.ts").Expr): Value {
        switch (e.t) {
            case "import": return mkList([mkStr("import"), Array.isArray(e.module) ? mkList(e.module.map(mkStr)) : mkStr(e.module)]);
            case "numeric": return e.v;
            case "int": return mkInt(e.v);
            case "float": return { kind: "float", v: e.v };
            case "bool": return mkBool(e.v);
            case "string": return mkStr(e.v);
            case "char": return { kind: "char", v: e.v };
            case "placeholder": return mkStr("_");
            case "var": return mkStr(e.name);
            case "binop": return mkList([mkStr(e.op), this.sexprOf(e.l), this.sexprOf(e.r)]);
            case "unop": return mkList([mkStr(e.op), this.sexprOf(e.e)]);
            case "app": return mkList([this.sexprOf(e.f), this.sexprOf(e.a)]);
            case "functionType": return mkStr(exprToSource(e));
            case "patternLambda": return mkList([mkStr("->"), mkStr(e.params.map(patternSource).join(" ")), this.sexprOf(e.body)]);
            case "lambda": return mkList([mkStr("->"), mkStr(e.params.join(" ")), this.sexprOf(e.body)]);
            case "list": return mkList(e.v.map((x) => this.sexprOf(x)));
            case "record":
                return mkList(e.v.map(([k, x]) => mkList([mkStr(keySource(k)), this.sexprOf(x)])));
            case "ternary":
                return mkList([mkStr("?:") as Value, this.sexprOf(e.cond), this.sexprOf(e.then), this.sexprOf(e.els)]);
            case "block": {
                // a single-statement ( ) group is transparent — toAST (1 + 2) => [+, 1, 2]
                const one = e.stmts.length === 1 && e.style === "(" && e.stmts[0].t !== "stmDef" && e.stmts[0].t !== "patDef";
                if (one) return this.sexprOf(e.stmts[0]);
                return mkList(e.stmts.map((st) => this.sexprOf(st.t === "stmDef" ? st.clauses[0].body : st.t === "patDef" ? st.value : st)));
            }
            case "pipe": return mkList([mkStr("$"), this.sexprOf(e.f), this.sexprOf(e.x)]);
            case "setItem": return mkList([mkStr("setItem"), this.sexprOf(e.rec), this.sexprOf(e.index), this.sexprOf(e.value)]);
            case "recordAccess":
                return mkList([mkStr("."), this.sexprOf(e.rec), mkStr(keySource(e.field))]);
            default: return mkList([mkStr(e.t)]);
        }
    }


    // A concrete value back to a literal expression (for step's evaluation
    // levels): lists/records rebuild structurally, so  [1 + 2]  steps to  [3].
    valueToExpr(v: Value): Expr {
        v = this.demand(v);
        if (this.isList(v)) return { t: "list", v: this.items(v).map((x) => this.valueToExpr(x)) };
        switch (v.kind) {
            case "rational": case "complex": return { t: "numeric", v };
            case "int": return { t: "int", v: v.v };
            case "float": return { t: "float", v: v.v };
            case "bool": return { t: "bool", v: v.v };
            case "string": return { t: "string", v: v.v };
            case "char": return { t: "char", v: v.v };
            case "list": return { t: "list", v: v.v.map((x) => this.valueToExpr(x)) };
            case "record":
                return { t: "record", v: v.v.map(([k, x]) => [k, this.valueToExpr(x)] as [string, Expr]) };
            default: return { t: "var", name: "<" + v.kind + ">" };
        }
    }

    // step n v — descend n levels into v's unevaluated structure (resolving
    // names, unwrapping blocks/thunks/0-arg bodies) and return a LIVE 0-arg
    // action over the level's expression: debug shows its source, print RUNS it.
    stepNative(argsIn: Value[]): Value {
        const n = this.dataValue(argsIn[0]);
        if (n.kind !== "int" || n.v < 0) {
            throw new APNError("runtime", "step needs a non-negative int count");
        }
        const t = argsIn[1];
        // the argument's thunk wrapper is NOT a level — level 0 is its body
        let expr: import("./ast.ts").Expr | null = t.kind === "thunk" ? t.body : null;
        let val: Value = { kind: "list", v: [] };
        for (let i = 0n; i < n.v; i++) {
            checkInterrupt();
            // free descents: names resolve, blocks expose their last statement
            for (;;) {
                if (expr !== null && expr.t === "var") {
                    val = this.env.get(expr.name) ?? { kind: "list", v: [] };
                    expr = null;
                } else if (expr !== null && expr.t === "block") {
                    const last = expr.stmts[expr.stmts.length - 1];
                    if (!last || last.t === "stmDef" || last.t === "patDef") break;
                    expr = last;
                } else break;
            }
            // the level: a 0-arg action or a thunk opens its body (structural);
            // anything computable evaluates ONE level (step 1 [1 + 2] => [3])
            const act = val.kind === "closure" && val.params.length === 0
                ? val
                : val.kind === "thunk"
                ? val
                : null;
            if (act !== null) {
                expr = act.body;
                val = { kind: "list", v: [] };
                continue;
            }
            if (
                expr === null ||
                ["int", "float", "bool", "string", "char"].includes(expr.t)
            ) break;
            expr = this.valueToExpr(this.demand(this.eval(expr)));
            val = { kind: "list", v: [] };
        }
        if (expr === null) return val;
        return { kind: "closure", params: [], body: expr, env: this.env };
    }



    // `*` iteration: seq * fn or fn * seq — applies fn over the sequence and returns the
    // results. seq is a list (elements), a record (entries as [field, value]
    // lists), or an int n (0..n-1; a negative n counts 0, -1, ... n+1).
    iterate(seq: Value, f: Value): Value {
        seq = this.dataValue(seq);
        const out: Value[] = [];
        if (this.isList(seq)) {
            for (const x of this.elements(seq)) out.push(this.demand(this.apply(f, x)));
        } else if (seq.kind === "record") {
            for (const [k, x] of seq.v) out.push(this.apply(f, mkList([mkStr(keyText(k)), x])));

        } else if (seq.kind === "int") {
            const n = seq.v < 0n ? -seq.v : seq.v;
            for (let i = 0n; i < n; i++) {
                checkInterrupt();
                out.push(this.apply(f, mkInt(seq.v >= 0n ? i : -i)));
            }
        } else {
            throw new APNError("runtime", `cannot iterate a ${seq.kind}`, {
                hint: "expected a list, a record, or an int count",
            });
        }
        return mkList(out);
    }

    // Run a 0-arg function (an action def: f = { ... } / f = print "hi").
    // Nullary native actions follow the same demand rules as APN action closures.
    callBlockFn(v: Value, tailLoad = false): Value {
        if (v.kind === "native" && v.arity === 0) return v.invoke ? v.invoke([]) : this.callNative(v.name, [], v.tag);
        if (v.kind !== "closure" || v.params.length !== 0) return v;
        if (v.mutableValue) return v.mutableValue;
        const old = this.env;
        this.env = v.env;
        try {
            const result = this.force(this.eval(v.body, tailLoad));
            if (result.kind === "mutable" || result.kind === "pointer") v.mutableValue = result;
            return result;
        } finally {
            this.env = old;
        }
    }

    // Demand only the outer value. Actions remain repeatable, while argument
    // thunks share the result of an action within a call.
    reference(v: Value, tailLoad = false): Value {
        const original = v;
        v = this.force(v);
        while ((v.kind === "closure" && v.params.length === 0) || (v.kind === "native" && v.arity === 0)) {
            checkInterrupt();
            v = this.force(this.callBlockFn(v, tailLoad));
        }
        if (original.kind === "thunk" || original.kind === "deferred") original.value = v;
        return v;
    }

    demand(v: Value, tailLoad = false): Value {
        v = this.reference(v, tailLoad);
        while (v.kind === "mutable") v = this.reference(v.v, tailLoad);
        return v;
    }

    // Ordinary value demand never initializes a type descriptor.
    dataValue(v: Value): Value {
        return this.demand(v);
    }

    // Defaults are created only for omitted slots during record construction.
    private zeroValue(v: Value, path: readonly Value[]): Value {
        v = this.demand(v);
        if (v.kind !== "type") return v;
        if (v.alias) throw new APNError("runtime", `${v.name} needs type arguments before it has a default`);
        if (!v.family) return builtinZero(v.name) ?? v;
        const family = v.family;
        if (path.some(type => this.sameType(type, v))) throw new APNError("runtime", `${v.name} has no finite default; supply a value explicitly`);
        if (path.length >= 128) throw new APNError("runtime", "default initialization is too deeply recursive; supply a value explicitly");
        if (family.base) return { kind: "variant", tag: family.name, family,
            v: [this.defer(() => this.defaultField(family.base!, [...path, v]))] };
        const choices = [...family.fields ?? []];
        const choice = choices.find(([, fields]) => !fields.length) ?? choices[0];
        if (!choice) throw new APNError("runtime", `${v.name} has no default constructor`);
        const [tag, fields] = choice;
        const scope = new Env(family.env);
        family.parameters?.forEach((name, index) => {
            const argument = v.kind === "type" ? v.arguments?.[index] : undefined;
            scope.setLocal(name, argument ?? { kind: "type", name: "$any" });
        });
        const nextPath = [...path, v];
        return { kind: "variant", tag, family, arguments: v.arguments, v: fields.map(spec => this.defer(() => {
            const caller = this.env; this.env = scope;
            try {
                const type = this.reference(this.eval(spec));
                if (!this.isTypeValue(type)) throw new APNError("runtime", `${tag} needs an explicit field value`);
                return this.defaultField(type, nextPath);
            } finally { this.env = caller; }
        })) };
    }

    private inspectType(v: Value): Value {
        v = this.reference(v);
        if (v.kind === "type") return { ...v, inspect: true };
        if (v.kind === "record") return { kind: "record", v: v.v.map(([k, x]) => [k, this.defer(() => this.inspectType(x))]) };
        if (this.isList(v)) {
            const cell = this.cell(v);
            return cell ? { kind: "cons", head: this.defer(() => this.inspectType(cell.head)), tail: this.defer(() => this.inspectType(cell.tail)) } : mkList([]);
        }
        return v;
    }

    private defaultField(v: Value, path: readonly Value[]): Value {
        v = this.force(v);
        if (v.kind === "type") v = this.zeroValue(v, path);
        if (v.kind === "type" || v.kind === "functionType") throw new APNError("runtime", "this type needs an explicit default value");
        if (v.kind === "record") return { kind: "record", v: v.v.map(([k, x]) => [k, this.defer(() => this.defaultField(x, path))]) };
        if (this.isList(v)) {
            const cell = this.cell(v);
            return cell ? { kind: "cons", head: this.defer(() => this.defaultField(cell.head, path)), tail: this.defer(() => this.defaultField(cell.tail, path)) } : mkList([]);
        }
        return v;
    }

    runStmt(v: Value, tailLoad = false): Value {
        return this.demand(v, tailLoad);
    }

    eval(e: Expr, tailLoad = false): Value {
        const caller = this.env;
        let forceResult = false;
        this.stack++;
        try {
            if (this.stack > STACK_LIMIT) {
                throw new APNError("runtime", "call stack overflow", {
                    hint: "unbounded strict recursion? Use a lazy cons tail to produce lists incrementally.",
                });
            }
            for (;;) {
                checkInterrupt();
                let r: Value = { kind: "list", v: [] };
                let next: TailCall | undefined;
                switch (e.t) {
                    case "functionType": r = this.resolveFunctionSpec(e.spec); break;
                    case "computedRange": {
                        const real = (expression: Expr): Real => {
                            const value = this.dataValue(this.eval(expression));
                            if (value.kind !== "int" && value.kind !== "float" && value.kind !== "rational") throw new APNError("runtime", "range bounds must be real numbers");
                            return value;
                        };
                        r = this.eval(rangeExpr(real(e.lo), e.second === null ? null : real(e.second), e.hi === null ? null : real(e.hi)));
                        break;
                    }
                    case "import": r = this.importStandard(e.module); break;
                    case "numeric": r = e.v; break;
                    case "rationalRange": r = { kind: "rationalRange", lo: e.lo, step: e.step, hi: e.hi }; break;
                    case "int": r = mkInt(e.v); break;
                    case "float": r = { kind: "float", v: e.v }; break;
                    case "bool": r = mkBool(e.v); break;
                    case "string": r = mkStr(e.v); break;
                    case "char": r = { kind: "char", v: e.v }; break;
                    case "placeholder": throw new APNError("runtime", "not implemented: '_' placeholder");
                    case "var": {
                        const v = this.env.get(e.name);
                        if (v === undefined) {
                            const near = didYouMean(e.name, envNames(this.env));
                            throw new APNError("runtime", `unbound variable '${e.name}'`, {
                                hint: near ? `did you mean '${near}'?` : undefined,
                            });
                        }
                        r = v.kind === "native" && v.name === "env" ? this.environmentValue() : v;
                        break;
                    }
                    case "binop": r = this.evalBinop(e); break;
                    case "unop": {
                        const v = this.dataValue(this.eval(e.e));
                        if (e.op === "neg") {
                            r = this.arrayNegate(v);
                        } else {
                            r = mkBool(!this.truthy(v));
                        }
                        break;
                    }
                    case "app": {
                        // Arguments stay lazy; a completed call can hand its body
                        // straight back to this loop instead of nesting eval calls.
                        const result = this.apply(this.eval(e.f), { kind: "thunk", body: e.a, env: this.env }, false, true, tailLoad);
                        if (result instanceof TailCall) next = result; else r = result;
                        break;
                    }
                    case "patternLambda": r = { kind: "clauseFn", name: "<lambda>", clauses: [{ params: e.params, body: e.body, guard: e.guard }], arity: e.params.length, env: this.env, applied: [] }; break;
                    case "lambda": r = { kind: "closure", params: e.params, body: e.body, env: this.env }; break;
                    case "ternary": {
                        const c = this.dataValue(this.eval(e.cond));
                        next = new TailCall(this.truthy(c) ? e.then : e.els, this.env);
                        break;
                    }
                    case "range": r = { kind: "range", lo: e.lo, step: e.step, hi: e.hi }; break;
                    case "floatRange": r = { kind: "floatRange", lo: e.lo, step: e.step, hi: e.hi }; break;
                    case "list": r = { kind: "lazyList", exprs: e.v, env: this.env }; break;
                    case "record": r = { kind: "record", v: e.v.map(([k, x]) => [k, this.eval(x)] as [string, Value]) }; break;
                    case "recordAccess": {
                        // Resolve aliases/actions to the outer record, leaving its fields lazy.
                        const rec = this.dataValue(this.eval(e.rec));
                        if (this.isList(rec) && e.argument) {
                            r = this.templateList(rec, this.eval(e.argument));
                            break;
                        }
                        if (rec.kind !== "record") throw new Error("record access on non-record");
                        if (e.scoped && e.argument) {
                            const outer = this.env;
                            const local = new Env(outer);
                            for (const [key, value] of rec.v) {
                                if (/^[A-Za-z_][A-Za-z0-9_']*$/.test(key) && key !== "_" && !KEYWORDS.has(key)) local.setLocal(key, value);
                            }
                            this.env = local;
                            try { r = this.eval(e.argument); } finally { this.env = outer; }
                        } else r = this.recordField(rec, e.field);
                        break;
                    }
                    case "pluck": {
                        let rec = this.dataValue(this.eval(e.rec));
                        if (this.isList(rec) && e.values) {
                            r = this.templateList(rec, this.eval(e.values));
                            break;
                        }
                        if (rec.kind !== "record") throw new Error("dotted application expects a list or record");
                        if (e.quoted === false) throw new Error("record selection expects literal field names");
                        const byKey = new Map(rec.v);
                        if (e.entries.every((x) => typeof x === "string")) {
                            const out: Value[] = [];
                            for (const n of e.entries as string[]) {
                                const v = byKey.get(n);
                                if (v === undefined) {
                                    this.missingField(rec, n);
                                }
                                out.push(v);
                            }
                            r = { kind: "list", v: out };
                        } else {
                            const out: Array<[string, Value]> = [];
                            for (const [src, dst] of e.entries as Array<[string, string]>) {
                                const v = byKey.get(src);
                                if (v === undefined) {
                                    this.missingField(rec, src);
                                }
                                out.push([dst, v]);
                            }
                            r = { kind: "record", v: out };
                        }
                        break;
                    }
                    case "setItem": {
                        const collection = this.dataValue(this.eval(e.rec));
                        const key = this.dataValue(this.eval(e.index));
                        r = this.assignItem(collection, key, e.value);
                        break;
                    }
                    case "setFields": {
                        // eager: read the OLD record and the RHS fully BEFORE building the
                        // new one, so  vec.[x, y] = vec.[y, x]  swaps correctly
                        let rec = this.dataValue(this.eval(e.rec));
                        const parents: Array<[Extract<Value, { kind: "record" }>, string]> = [];
                        for (const key of e.path ?? []) {
                            if (rec.kind !== "record") throw new APNError("runtime", "nested field assignment requires a record");
                            parents.push([rec, key]);
                            rec = this.dataValue(this.recordField(rec, key));
                        }
                        if (this.isList(rec) && this.cell(rec) === null) rec = mkList([]);
                        let base: Array<[string, Value]> | null = null;
                        if (rec.kind === "record") base = rec.v;
                        else if (rec.kind === "list" && rec.v.length === 0) base = []; // [] seeds a record
                        if (base === null) {
                            throw new APNError("runtime", `cannot set a field on a ${rec.kind}`, {
                                hint: "only records accept fields (an empty list promotes to a record)",
                            });
                        }
                        const rhsValue = this.demand(this.eval(e.value));
                        const rhs = this.isList(rhsValue) ? mkList(this.items(rhsValue).map((x) => this.demand(x))) : rhsValue;
                        if (rhs.kind !== "list") {
                            throw new APNError("runtime", "field assignment needs a list of values on the right");
                        }
                        if (rhs.v.length !== e.entries.length) {
                            throw new APNError(
                                "runtime",
                                `${e.entries.length} field${e.entries.length === 1 ? "" : "s"} need ${e.entries.length} value${e.entries.length === 1 ? "" : "s"} (got ${rhs.v.length})`,
                            );
                        }
                        if (rec.kind === "record" && rec.scope) {
                            r = this.updateEnvironment(rec, e.entries.map((key, index) => [key, rhs.v[index]]));
                        } else {
                            const out = base.map(([k, v]) => [k, v] as [string, Value]);
                            for (let i = 0; i < e.entries.length; i++) {
                                const key = e.entries[i];
                                const idx = out.findIndex(([k]) => k === key);
                                if (idx === -1) out.push([e.entries[i], rhs.v[i]]);
                                else out[idx] = [e.entries[i], this.assignSlot(base[idx][1], rhs.v[i])];
                            }
                            r = { kind: "record", v: out };
                        }
                        for (let i = parents.length - 1; i >= 0; i--) {
                            const [parent, key] = parents[i];
                            r = parent.scope
                                ? this.updateEnvironment(parent, [[key, r]])
                                : { kind: "record", v: parent.v.map(([name, value]) => [name, name === key ? r : value]) };
                        }
                        break;
                    }
                    case "pipe": {
                        const result = this.apply(this.eval(e.f), { kind: "thunk", body: e.x, env: this.env }, false, true, tailLoad);
                        if (result instanceof TailCall) next = result; else r = result;
                        break;
                    }
                    case "block": {
                        const child = new Env(this.env);
                        const old = this.env;
                        this.env = child;
                        try {
                            r = { kind: "list", v: [] };
                            for (let si = 0; si < e.stmts.length; si++) {
                                const s = e.stmts[si];
                                if (s.t === "stmDef") r = this.evalDef(s.name, s.clauses);
                                else if (s.t === "patDef") r = this.evalPatBinding(s);
                                else if (si === e.stmts.length - 1) {
                                    forceResult = true;
                                    next = new TailCall(s, child);
                                    break;
                                } else r = this.runStmt(this.eval(s)); // bare name = call
                            }
                            // Reveal the last value without traversing a returned list.
                            // A returned action is run by the caller's demand loop.
                            if (!next) r = this.force(r);
                        } finally {
                            this.env = old;
                        }
                        break;
                    }
                    case "stmDef":
                        throw new Error("Runtime: internal error — statement definition used as an expression");
                    case "patDef":
                        r = this.evalPatBinding(e);
                        break;
                }
                if (next) {
                    e = next.body;
                    this.env = next.env;
                    continue;
                }
                return forceResult ? this.force(r) : r;
            }
        } finally {
            this.env = caller;
            this.stack--;
        }
    }

    evalBinop(e: Extract<Expr, { t: "binop" }>): Value {
        if (e.op === ":") {
            // Reject a definitely non-list tail without evaluating either side.
            // Unknown tails stay lazy, so head (1:missing) remains productive.
            if (["int", "float", "bool", "string", "char", "record", "lambda"].includes(e.r.t)) {
                throw new APNError("runtime", `cons tail expected a list, got ${e.r.t}`);
            }
            const tail = this.delay(e.r);
            return {
                kind: "cons", head: this.delay(e.l),
                tail: this.defer(() => {
                    const value = this.dataValue(tail);
                    if (!this.isList(value)) throw new APNError("runtime", `cons tail expected a list, got ${value.kind}`);
                    return value;
                }),
            };
        }
        if (e.op === "++") {
            const l = this.dataValue(this.eval(e.l));
            const r = this.delay(e.r);
            if (this.isList(l)) return this.append(l, r);
            const right = this.dataValue(r);
            if (l.kind === "string" && right.kind === "string") return mkStr(l.v + right.v);
            throw new APNError("runtime", `cannot apply '++' to ${l.kind} and ${right.kind}`);
        }
        if (e.op === "&&" || e.op === "||") {
            const left = this.truthy(this.eval(e.l));
            return mkBool(e.op === "&&"
                ? left && this.truthy(this.eval(e.r))
                : left || this.truthy(this.eval(e.r)));
        }
        let l = this.demand(this.eval(e.l));
        let r = this.demand(this.eval(e.r));
        if (e.op === "*") {
            const callable = (v: Value) => ["closure", "clauseFn", "native", "type", "contract", "functionType"].includes(v.kind);
            if (callable(r)) return this.iterate(l, r);
            if (callable(l)) return this.iterate(r, l);
        }
        if (e.op === "==" || e.op === "!=") return mkBool(this.equals(l, r) === (e.op === "=="));
        if ((l.kind === "variant" && l.family?.base) || (r.kind === "variant" && r.family?.base)) {
            if (l.kind !== "variant" || r.kind !== "variant" || l.family !== r.family) {
                throw new APNError("runtime", "distinct arithmetic requires the same distinct type on both sides");
            }
            const a = this.demand(l.v[0]), b = this.demand(r.v[0]);
            if (isNumeric(a) && isNumeric(b) && ["+", "-", "*", "/", "%", "^"].includes(e.op)) {
                const result = e.op === "^" ? typedPower(a, b) : typedArithmetic(e.op, a, b);
                return this.conform({ kind: "type", name: l.family!.name, family: l.family }, result);
            }
            if (["<", ">", "<=", ">="].includes(e.op)) {
                const order = this.compare(a, b);
                return mkBool(e.op === "<" ? order < 0 : e.op === ">" ? order > 0 : e.op === "<=" ? order <= 0 : order >= 0);
            }
            throw new APNError("runtime", `operator '${e.op}' requires unwrapping this distinct value`);
        }
        if (["+", "-", "*", "/", "%", "^"].includes(e.op)) {
            l = this.arithmeticValue(l); r = this.arithmeticValue(r);
        } else if (e.op !== "\\") { l = this.dataValue(l); r = this.dataValue(r); }
        if (["+", "-", "*", "/", "%", "^"].includes(e.op) &&
                (this.isList(l) || this.isList(r) || l.kind === "record" || r.kind === "record")) {
            return this.arrayArithmetic(e.op, l, r);
        }
        const bad = (): never => {
            throw new APNError("runtime", `cannot apply '${e.op}' to ${l.kind} and ${r.kind}`);
        };
        if (isNumeric(l) && isNumeric(r) && ["+", "-", "*", "/", "%"].includes(e.op)) return typedArithmetic(e.op, l, r);
        if (e.op === "\\") {
            const functions = ["closure", "clauseFn", "native", "type", "contract", "functionType"];
            if (!functions.includes(l.kind) || !functions.includes(r.kind)) {
                throw new APNError("runtime", "composition expects functions on both sides of '\\'");
            }
            const env = new Env(this.env);
            env.setLocal("f", l);
            env.setLocal("g", r);
            return {
                kind: "closure", params: ["x"], env,
                body: { t: "app", f: { t: "var", name: "f" },
                    a: { t: "app", f: { t: "var", name: "g" }, a: { t: "var", name: "x" } } },
            };
        }
        if (e.op === "^") {
            if (!isNumeric(l) || !isNumeric(r)) return bad();
            return typedPower(l, r);
        }
        switch (e.op) {
            case "+":
                if (l.kind === "string" && r.kind === "string") return mkStr(l.v + r.v);
                return bad();
            case "*": return bad();
            case "-":
                if ((l.kind === "closure" || l.kind === "clauseFn" || l.kind === "native" || l.kind === "type") && isNumeric(r)) {
                    return this.apply(l, negate(r));
                }
                return bad();
            case "/": case "%": return bad();
            case "<": return this.compare(l, r) < 0 ? mkBool(true) : mkBool(false);
            case ">": return this.compare(l, r) > 0 ? mkBool(true) : mkBool(false);
            case "<=": return this.compare(l, r) <= 0 ? mkBool(true) : mkBool(false);
            case ">=": return this.compare(l, r) >= 0 ? mkBool(true) : mkBool(false);

        }
    }

    private arrayNegate(value: Value): Value {
        const v = this.arithmeticValue(value);
        if (v.kind === "variant" && v.family?.base) return this.conform({ kind: "type", name: v.family.name, family: v.family }, this.arrayNegate(v.v[0]));
        if (isNumeric(v)) return v.typeName ? castNumeric(v.typeName, negate(v)) : negate(v);
        if (this.isList(v)) return this.defer(() => {
            const cell = this.cell(v);
            return cell ? { kind: "cons", head: this.defer(() => this.arrayNegate(cell.head)), tail: this.defer(() => this.arrayNegate(cell.tail)) } : mkList([]);
        });
        if (v.kind === "record") return { kind: "record", v: v.v.map(([key, field]) => [key, this.defer(() => this.arrayNegate(field))]) };
        throw new APNError("runtime", "negation expects numbers or numeric collections");
    }

    private arrayArithmetic(op: string, left: Value, right: Value, broadcast = true): Value {
        const l = this.arithmeticValue(left), r = this.arithmeticValue(right);
        if (isNumeric(l) && isNumeric(r)) return op === "^" ? typedPower(l, r) : typedArithmetic(op, l, r);
        const ll = this.isList(l), rl = this.isList(r);
        if (ll && rl) return this.defer(() => {
            const a = this.cell(l), b = this.cell(r);
            if (!a || !b) {
                if (a !== b) throw new APNError("runtime", "array shape mismatch: list lengths differ");
                return mkList([]);
            }
            return { kind: "cons",
                head: this.defer(() => this.arrayArithmetic(op, a.head, b.head, false)),
                tail: this.defer(() => this.arrayArithmetic(op, a.tail, b.tail, false)),
            };
        });
        if (l.kind === "record" && r.kind === "record") {
            const fields = new Map(r.v);
            if (l.v.length !== r.v.length || l.v.some(([key]) => !fields.has(key))) {
                throw new APNError("runtime", "array shape mismatch: record keys differ");
            }
            return { kind: "record", v: l.v.map(([key, field]) => [key, this.defer(() => this.arrayArithmetic(op, field, fields.get(key)!, false))]) };
        }
        if (broadcast && (isNumeric(l) || isNumeric(r))) {
            const scalarLeft = isNumeric(l), collection = scalarLeft ? r : l;
            const apply = (value: Value) => scalarLeft ? this.arrayArithmetic(op, l, value) : this.arrayArithmetic(op, value, r);
            if (this.isList(collection)) return this.defer(() => {
                const cell = this.cell(collection);
                return cell ? { kind: "cons", head: this.defer(() => apply(cell.head)), tail: this.defer(() => apply(cell.tail)) } : mkList([]);
            });
            if (collection.kind === "record") return { kind: "record", v: collection.v.map(([key, field]) => [key, this.defer(() => apply(field))]) };
        }
        throw new APNError("runtime", `array arithmetic '${op}' expects numeric leaves and matching shapes (got ${l.kind} and ${r.kind})`);
    }

    private missingField(rec: Extract<Value, { kind: "record" }>, key: string): never {
        const near = didYouMean(keyText(key), rec.v.map(([k]) => keyText(k)));
        throw new APNError("runtime", `record has no field '${keyText(key)}'`, {
            hint: near ? `did you mean '${near}'?` : undefined,
        });
    }

    private recordField(rec: Extract<Value, { kind: "record" }>, key: string): Value {
        const field = rec.v.find(([k]) => k === key);
        return field ? field[1] : this.missingField(rec, key);
    }

    equals(a: Value, b: Value): boolean {
        a = this.demand(a); b = this.demand(b);
        a = this.dataValue(a); b = this.dataValue(b);
        if ((a.kind === "record" && a.scope) || (b.kind === "record" && b.scope)) {
            return a.kind === "record" && b.kind === "record" && a.scope === b.scope;
        }
        if (this.isList(a) && this.isList(b)) {
            for (;;) {
                checkInterrupt();
                const x = this.cell(a), y = this.cell(b);
                if (x === null || y === null) return x === y;
                if (!this.equals(x.head, y.head)) return false;
                a = x.tail;
                b = y.tail;
            }
        }
        if (isNumeric(a) && isNumeric(b)) return equalNumbers(a, b);
        if (a.kind === "hashmap" && b.kind === "hashmap") {
            return a.entries.size === b.entries.size && [...a.entries].every(([key, [, value]]) => b.entries.has(key) && this.equals(value, b.entries.get(key)![1]));
        }
        if (a.kind === "record" && b.kind === "record") {
            const fields = new Map(b.v);
            return a.v.length === b.v.length && a.v.every(([key, value]) => fields.has(key) && this.equals(value, fields.get(key)!));
        }
        if (a.kind !== b.kind) return false;
        switch (a.kind) {
            case "int": return a.v === (b as any).v;
            case "float": return a.v === (b as any).v;
            case "bool": return a.v === (b as any).v;
            case "string": return a.v === (b as any).v;
            case "char": return a.v === (b as any).v;
            case "pointer": return b.kind === "pointer" && a.bits === b.bits;
            case "type": return b.kind === "type" && this.sameType(a, b);
            case "functionType": return b.kind === "functionType" && this.sameType(a, b);
            case "list": {
                const bl = b as any;
                if (a.v.length !== bl.v.length) return false;
                return a.v.every((x, i) => this.equals(x, bl.v[i]));
            }
            case "variant": {
                const bv = b as any;
                return a.tag === bv.tag && (!(a.family?.base || bv.family?.base) || a.family === bv.family) && this.equals({ kind: "list", v: a.v }, { kind: "list", v: bv.v });
            }
            case "closure": case "clauseFn": case "native": case "contract":
                return a === b;
            case "nomatch": return true;
            default: return false;
        }
    }

    compare(a: Value, b: Value): number {
        a = this.dataValue(a); b = this.dataValue(b);
        if (isNumeric(a) && isNumeric(b)) return compareNumbers(a, b);
        if (a.kind === "int" && b.kind === "int") return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
        if (a.kind === "float" && b.kind === "float") return a.v - b.v;
        if (a.kind === "string" && b.kind === "string") return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
        if (a.kind === "char" && b.kind === "char") return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
        throw new Error("Runtime: cannot compare these values");
    }

    apply(f: Value, arg: Value, probe?: boolean): Value;
    apply(f: Value, arg: Value, probe: boolean, tail: true, tailLoad: boolean): Value | TailCall;
    apply(f: Value, arg: Value, probe = false, tail = false, tailLoad = false): Value | TailCall {
        // A lazy 0-param def used as a function (`f = g; f 1`) is a thunk — run it.
        f = this.force(f);
        if (isNumeric(f)) throw new APNError("runtime", "cannot apply a number", {
            hint: "use a type constructor such as Int, or replace a default inside a template",
        });
        if (["string", "char", "bool"].includes(f.kind)) throw new APNError("runtime", `cannot apply a ${f.kind}`, {
            hint: "use a type constructor or replace a default inside a template",
        });
        switch (f.kind) {
            case "functionType": return this.conform(f, arg);
            case "contract": return this.defer(() => {
                const input = this.conform(f.from, arg);
                return this.conform(f.to, this.apply(f.target, input));
            });
            case "mutable": return this.apply(this.demand(f), arg);
            case "type": {
                if (f.name === "$any" && !f.family && !f.alias) return arg;
                if (f.name === "Dynamic" && !f.family && !f.alias) {
                    this.dynamicDepth++;
                    try { return this.constructType("Dynamic", this.reference(arg)); }
                    finally { this.dynamicDepth--; }
                }
                const value = this.demand(arg);
                if (f.name === "Vect" && !f.family && !f.alias && (f.arguments?.length ?? 0) < 2) {
                    const args = [...f.arguments ?? []];
                    if (!args.length && (value.kind !== "int" || value.v < 0n)) throw new APNError("runtime", "Vect length must be a nonnegative Int");
                    if (args.length === 1 && !this.isTypeValue(value)) throw new APNError("runtime", "Vect element must be a type");
                    return { ...f, arguments: [...args, value] };
                }
                const parameters = f.alias?.parameters ?? f.family?.parameters ?? [];
                if ((f.arguments?.length ?? 0) < parameters.length && (f.alias || this.isTypeValue(value))) {
                    const arguments_ = [...f.arguments ?? [], value];
                    if (f.alias && arguments_.length === parameters.length) {
                        const scope = new Env(f.alias.env);
                        parameters.forEach((name, index) => scope.setLocal(name, arguments_[index]));
                        const caller = this.env;
                        this.env = scope;
                        try {
                            const result = this.reference(this.eval(f.alias.body));
                            if (!this.isTypeValue(result)) throw new APNError("runtime", `${f.name} must return a type`);
                            return result;
                        } finally { this.env = caller; }
                    }
                    return { ...f, arguments: arguments_ };
                }
                if (f.alias) throw new APNError("runtime", `${f.name} expects ${parameters.length} arguments`);
                if (!f.family && ["Float", "Float32", "Float64"].includes(f.name)) {
                    if (!isNumeric(value)) throw new APNError("runtime", `${f.name} expects a number`);
                    return castNumeric(f.name, value, true);
                }
                return this.conform(f, value);
            }
            case "hashmap": return this.mapLookup(f, this.demand(arg));
            case "closure": {
                if (f.params.length === 0) {
                    // a 0-arg action APPLIED to arguments: run it, then hand the
                    // result the argument — keeps partial application working:
                    //   addTwo = add 2   addTwo 10  ==  (add 2) 10
                    return this.apply(this.callBlockFn(f), arg);
                }
                const child = new Env(f.env);
                child.setLocal(f.params[0], arg);
                if (f.params.length === 1) {
                    if (tail) return new TailCall(f.body, child);
                    const old = this.env;
                    this.env = child;
                    try { return this.eval(f.body); } finally { this.env = old; }
                }
                return { kind: "closure", params: f.params.slice(1), body: f.body, env: child };
            }
            case "native": {
                if (f.arity === 0) {
                    if (f.invoke) return f.invoke([arg]);
                    return this.callNative(f.name, [], f.tag);
                }
                const args = [...f.applied, arg];
                if (args.length < f.arity) return { ...f, applied: args };
                if (f.invoke) return f.invoke(args);
                if (f.name === "__constr") return this.variantValue(f.tag!, args, f.family);
                if (f.name === "load" && tailLoad) throw new TailLoad(this.demand(args[0]), this.env);
                return this.callNative(f.name, args, f.tag);
            }
            case "clauseFn": {
                const raw = [...f.applied, arg];
                if (raw.length < f.arity) return { ...f, applied: raw };
                // Patterns demand only the structure they inspect. Shared
                // argument thunks prevent repeated effects across fallthrough.
                const hasTypedClauses = f.clauses.some((clause) => clause.params.some((p) => p.p === "constr" && TYPE_NAMES.includes(p.tag)));
                const ranked = f.clauses.map((clause, index) => ({ clause, index, score: clause.params.reduce((score, pattern, i) => {
                    if (["int", "bool", "string"].includes(pattern.p)) return score + 40;
                    if (pattern.p !== "constr" || !TYPE_NAMES.includes(pattern.tag)) return score;
                    if (pattern.tag === "Vect") return score + (this.isList(this.dataValue(raw[i])) ? 30 : -1000);
                    const value = pattern.tag === "Mutable" ? this.reference(raw[i]) : pattern.tag === "Type" ? this.demand(raw[i]) : this.dataValue(raw[i]);
                    if (!NUMERIC_TYPES.includes(pattern.tag)) return score + (this.matchesValueType(pattern.tag, value) ? 30 : -1000);
                    if (!isNumeric(value)) return score - 1000;
                    if (["Number", "Real", "Integer", "Exact", "Inexact"].includes(pattern.tag)) return score + (matchesType(pattern.tag, value) ? 10 : -1000);
                    if (matchesType(pattern.tag, value)) return score + 30;
                    try { castNumeric(pattern.tag, value); return score + 1; } catch { return score - 1000; }
                }, 0) })).sort((a, b) => b.score - a.score || a.index - b.index);
                for (const { clause } of ranked) {
                    const binds = new Map<string, Value>();
                    // The definition name is the first binding in a named clause.
                    // Use the original function, even when applying a partial call.
                    if (f.name !== "<lambda>") {
                        const self = f.env.map.get(f.name);
                        if (self) binds.set(f.name, self);
                    }
                    let ok = true;
                    const args = raw;
                    const patternCaller = this.env;
                    this.env = f.env;
                    try {
                        for (let i = 0; i < clause.params.length; i++) {
                            if (!this.matchPattern(clause.params[i], args[i], binds)) { ok = false; break; }
                        }
                    } finally { this.env = patternCaller; }
                    if (!ok) continue;
                    const child = new Env(f.env);
                    for (const [k, v] of binds) child.setLocal(k, v);
                    const old = this.env;
                    this.env = child;
                    try {
                        if (clause.guard) {
                            const guard = this.dataValue(this.eval(clause.guard));
                            if (!this.truthy(guard)) continue;
                        }
                        if (probe) return this.defer(() => {
                            const caller = this.env;
                            this.env = child;
                            try { return this.eval(clause.body); } finally { this.env = caller; }
                        });
                        if (tail) return new TailCall(clause.body, child);
                        return this.eval(clause.body);
                    } finally { this.env = old; }
                }
                if (probe) return { kind: "nomatch" };
                throw new APNError(
                    "runtime",
                    `no clause of '${f.name}' matches the given arguments`,
                    { hint: "the definition's patterns don't cover this input" },
                );
            }
            case "list":
            case "lazyList":
            case "cons":
            case "rationalRange":
            case "floatRange":
            case "range": {
                const value = this.dataValue(arg);
                const index = this.listIndex(value);
                if (index !== undefined) return this.index(f, index);
                if (this.isList(value)) return this.selectList(f, value);
                if (value.kind === "string") return this.associationValue(f, value.v);
                throw new APNError("runtime", "indexing a list needs an integer, enumeration value, list of indices, or association string key; use .[...] for list templates");
            }
            case "record": {
                // Strings select named fields; lists/records clone, ints select entries.
                const value = this.dataValue(arg);
                const carg = this.isList(value) ? mkList(this.items(value)) : value;
                if (carg.kind === "string") {
                    // Application uses the exact string, including any quote characters.
                    return this.recordField(f, carg.v);
                }
                if (carg.kind === "list") {
                    if (carg.v.length !== 0 && carg.v.length !== f.v.length) {
                        throw new Error(`Runtime: field count (${f.v.length}) does not match list size (${carg.v.length})`);
                    }
                    return { kind: "record", v: f.v.map(([k, template], i) => [k, this.defer(() => i < carg.v.length ? this.applyTemplateSlot(template, carg.v[i]) : this.defaultField(template, []))] as [string, Value]) };
                }
                if (carg.kind === "record") {
                    const supplied = new Set(carg.v.map(([key]) => key));
                    for (const [key, slot] of f.v) {
                        if (slot.kind === "type" && slot.name === "$any" && !supplied.has(key)) {
                            throw new APNError("runtime", `missing field '${key}'`);
                        }
                    }
                    const idx = new Map(f.v.map(([k], i) => [k, i]));
                    const out: [string, Value][] = f.v.map(([k, template]) => [k, this.defer(() => this.defaultField(template, []))]);
                    for (const [k, v] of carg.v) {
                        const i = idx.get(k);
                        if (i !== undefined) out[i] = [k, this.defer(() => this.applyTemplateSlot(f.v[i][1], v))]; else out.push([k, v]);
                    }
                    return { kind: "record", v: out };
                }
                if (carg.kind === "int") {
                    let i = carg.v;
                    if (i < 0n) i += BigInt(f.v.length);
                    if (i < 0 || i >= f.v.length) {
                        throw new Error(`Runtime: index ${carg.v} out of range (len ${f.v.length})`);
                    }
                    return mkList([mkStr(keyText(f.v[Number(i)][0])), f.v[Number(i)][1]]);
                }
                throw new Error("Runtime: applying an object needs a field-name string, a list, a record, or an int index");
            }
            default:
                throw new APNError(
                    "runtime",
                    `cannot call a non-function (${f.kind})`,
                    { hint: "lists index by integer; container templates apply their slots to supplied values" },
                );
        }
    }

    delay(body: Expr): Value {
        return { kind: "thunk", body, env: this.env };
    }

    defer(compute: () => Value): Value {
        return { kind: "deferred", compute };
    }

    // Weak-head evaluation: cache every thunk in an alias chain, never force
    // a cons head/tail or a container field just to reveal its outer shape.
    force(v: Value): Value {
        const pending: Array<Extract<Value, { kind: "thunk" | "deferred" }>> = [];
        try {
            for (;;) {
                checkInterrupt();
                if (v.kind === "lazyList") {
                    const env = v.env;
                    v.value ??= mkList(v.exprs.map((body) => ({ kind: "thunk", body, env })));
                    v = v.value;
                } else if (v.kind === "thunk" || v.kind === "deferred") {
                    if (v.value !== undefined) { v = v.value; continue; }
                    if (v.busy) {
                        // An unproductive fixed point diverges, but remains interruptible.
                        const sleep = new Int32Array(new SharedArrayBuffer(4));
                        for (;;) { checkInterrupt(); Atomics.wait(sleep, 0, 0, 20); }
                    }
                    v.busy = true;
                    pending.push(v);
                    if (v.kind === "deferred") v = v.compute();
                    else {
                        const old = this.env;
                        this.env = v.env;
                        try { v = this.eval(v.body); } finally { this.env = old; }
                    }
                } else break;
            }
            for (const thunk of pending) thunk.value = v;
            return v;
        } finally {
            for (const thunk of pending) thunk.busy = false;
        }
    }

    unpackThunk(v: Value): Value { return this.force(v); }

    isList(v: Value): boolean {
        return v.kind === "list" || v.kind === "lazyList" || v.kind === "cons" || v.kind === "range" || v.kind === "floatRange" || v.kind === "rationalRange";
    }

    fromArray(values: Value[], i = 0): Value {
        return this.defer(() => i === values.length ? mkList([]) : {
            kind: "cons", head: values[i], tail: this.fromArray(values, i + 1),
        });
    }

    cell(v: Value): { head: Value; tail: Value } | null {
        v = this.dataValue(v);
        if (v.kind === "cons") return v;
        if (v.kind === "list") return v.v.length ? { head: v.v[0], tail: this.fromArray(v.v, 1) } : null;
        if (v.kind === "rationalRange") {
            if (v.hi !== null && (compareNumbers(v.step, integer(0n)) >= 0 ? compareNumbers(v.lo, v.hi) > 0 : compareNumbers(v.lo, v.hi) < 0)) return null;
            return { head: v.lo, tail: { ...v, lo: arithmetic("+", v.lo, v.step) as Real } };
        }
        if (v.kind === "floatRange") {
            const index = v.index ?? 0;
            const current = v.lo + index * v.step;
            const tolerance = v.hi === null || v.step === 0 ? 0 : Math.min(
                Math.abs(v.step) / 2, 4 * Number.EPSILON * Math.max(1, Math.abs(current), Math.abs(v.hi)),
            );
            if (v.hi !== null && (v.step >= 0 ? current > v.hi + tolerance : current < v.hi - tolerance)) return null;
            if (!Number.isFinite(current) || index + 1 === index ||
                (index > 0 && v.step !== 0 && current === v.lo + (index - 1) * v.step)) {
                throw new APNError("runtime", "float range cannot advance at this precision");
            }
            const value = v.hi !== null && Math.abs(current - v.hi) <= tolerance ? v.hi : current;
            return { head: { kind: "float", v: value }, tail: { ...v, index: index + 1 } };
        }
        if (v.kind === "range") {
            if (v.hi !== null && (v.step >= 0 ? v.lo > v.hi : v.lo < v.hi)) return null;
            return { head: mkInt(v.lo), tail: { ...v, lo: v.lo + v.step } };
        }
        throw new APNError("runtime", `expected a list, got ${v.kind}`);
    }

    *elements(v: Value): Generator<Value> {
        for (;;) {
            checkInterrupt();
            const cell = this.cell(v);
            if (cell === null) return;
            yield cell.head;
            v = cell.tail;
        }
    }

    items(v: Value): Value[] { return [...this.elements(v)]; }

    index(v: Value, i: bigint): Value {
        const original = i;
        if (i < 0) {
            const values = this.items(v);
            i += BigInt(values.length);
            if (i >= 0 && i < values.length) return values[Number(i)];
        } else {
            for (const value of this.elements(v)) {
                if (i-- === 0n) return value;
            }
        }
        throw new APNError("runtime", `index ${original} out of range`);
    }

    setIndex(list: Value, index: bigint, value: Value): Value {
        const actual = this.force(list);
        if (actual.kind === "list" && actual.schema) {
            const values = [...actual.v];
            const offset = index < 0n ? BigInt(values.length) + index : index;
            if (offset < 0n || offset >= values.length) throw new APNError("runtime", `index ${index} out of range`);
            const schema = actual.schema as Extract<Value, { kind: "type" }>;
            const [, element] = this.vectorParts(schema);
            values[Number(offset)] = this.conform(element, value);
            return { ...actual, v: values };
        }
        const original = index;
        if (index < 0n) {
            const values = this.items(list);
            index += BigInt(values.length);
            if (index < 0n || index >= values.length) throw new APNError("runtime", `index ${original} out of range`);
            values[Number(index)] = this.assignSlot(values[Number(index)], value);
            return mkList(values);
        }
        const prefix: Value[] = [];
        for (;;) {
            checkInterrupt();
            const cell = this.cell(list);
            if (cell === null) throw new APNError("runtime", `index ${original} out of range`);
            if (index-- === 0n) {
                let result: Value = { kind: "cons", head: this.assignSlot(cell.head, value), tail: cell.tail };
                for (let i = prefix.length - 1; i >= 0; i--) result = { kind: "cons", head: prefix[i], tail: result };
                return result;
            }
            prefix.push(cell.head);
            list = cell.tail;
        }
    }

    append(xs: Value, ys: Value): Value {
        return this.defer(() => {
            const cell = this.cell(xs);
            if (cell === null) {
                const right = this.dataValue(ys);
                if (!this.isList(right)) throw new APNError("runtime", "list append expects a list");
                return right;
            }
            return { kind: "cons", head: cell.head, tail: this.append(cell.tail, ys) };
        });
    }

    // Rendering is incremental, including nested lists. Consumers decide
    // whether to stream fragments or collect a finite result into a string.
    render(v: Value, emit: (s: string, kind?: Value["kind"] | "key") => void, raw = false, ancestors = new Set<Value>()): void {
        checkInterrupt();
        v = this.demand(v);
        // Track nested values, not successive spine cells: 1:xs may stream
        // forever, but a list containing itself cannot render a first element.
        if (v.kind === "record" && v.scope && [...ancestors].some(parent => parent.kind === "record" && parent.scope === v.scope)) {
            emit("env", "record");
            return;
        }
        if (ancestors.has(v)) throw new APNError("runtime", "cannot display a cyclic nested value");
        ancestors.add(v);
        try {
            if (v.kind === "hashmap") {
                emit("HashMap", "type"); emit(" ");
                this.render(mkList([...v.entries.values()].map(([key, value]) => mkList([key, value]))), emit, false, ancestors);
            } else if (this.isList(v)) {
                emit("[");
                let first = true;
                for (const item of this.elements(v)) {
                    if (!first) emit(", ");
                    first = false;
                    this.render(item, emit, false, ancestors);
                }
                emit("]");
            } else if (v.kind === "record") {
                emit("[");
                v.v.forEach(([key, val], i) => {
                    if (i) emit(", ");
                    emit(keySource(key), isStringKey(key) ? "string" : "key");
                    emit(": ");
                    // Inspect module actions without running halt; ordinary data
                    // fields still render their memoized values.
                    const field = this.force(val);
                    if ((field.kind === "closure" && !field.params.length) || (v.scope && field.kind === "native" && field.arity === 0)) emit(valueToString(field), field.kind);
                    else this.render(field, emit, false, ancestors);
                });
                emit("]");
            } else if (v.kind === "type" && v.inspect) {
                emit(v.description ?? v.name, "type");
                for (const argument of v.arguments ?? []) {
                    emit(" "); this.render(this.inspectType(argument), emit, false, ancestors);
                }
            } else if (v.kind === "variant") {
                emit(v.tag, "variant");
                for (const arg of v.v) { emit(" "); this.render(arg, emit, false, ancestors); }
            } else emit(raw ? rawString(v) : valueToString(v), v.kind);
        } finally {
            ancestors.delete(v);
        }
    }

    renderString(v: Value, raw = false): string {
        const parts: string[] = [];
        this.render(v, (s) => parts.push(s), raw);
        return parts.join("");
    }

    printValue(v: Value, newline = true, raw = true): void {
        const enc = new TextEncoder();
        let buffer = "";
        this.render(v, (s) => {
            buffer += s;
            if (buffer.length >= 256) {
                Deno.stdout.writeSync(enc.encode(buffer));
                buffer = "";
            }
        }, raw);
        if (newline) console.log(buffer);
        else if (buffer) Deno.stdout.writeSync(enc.encode(buffer));
    }

    resolveFunctionSpec(spec: import("./ast.ts").FunctionSpec): Value {
        if (!("name" in spec)) return { kind: "functionType", from: this.resolveFunctionSpec(spec.from), to: this.resolveFunctionSpec(spec.to) };
        const value = this.env.get(spec.name);
        if (!value) throw new APNError("runtime", `unknown type '${spec.name}'`);
        const type = this.demand(value);
        if (type.kind !== "type" && type.kind !== "functionType") throw new APNError("runtime", `${spec.name} is not a type`);
        return type;
    }

    private vectorParts(type: Extract<Value, { kind: "type" }>): [bigint, Value] {
        const [size, element] = type.arguments ?? [];
        if (type.arguments?.length !== 2 || size.kind !== "int" || size.v < 0n) throw new APNError("runtime", "Vect needs a nonnegative length and an element type");
        return [size.v, element];
    }

    private vectorElements(value: Value, size: bigint): Value[] {
        if (!this.isList(value)) throw new APNError("runtime", "Vect expects a list");
        const out: Value[] = [];
        let rest = value;
        for (let n = 0n; n < size; n++) {
            checkInterrupt();
            const cell = this.cell(rest);
            if (!cell) throw new APNError("runtime", `Vect length mismatch: expected ${size}, got ${n}`);
            out.push(cell.head); rest = cell.tail;
        }
        if (this.cell(rest)) throw new APNError("runtime", `Vect length mismatch: expected ${size}, got at least ${size + 1n}`);
        return out;
    }

    conform(type: Value, value: Value): Value {
        if (type.kind === "type" && type.name === "Vect" && !type.family && !type.alias) {
            const [size, element] = this.vectorParts(type);
            const values = this.vectorElements(this.dataValue(value), size);
            return { kind: "list", schema: type, v: values.map(x => this.defer(() => this.conform(element, x))) };
        }
        if (type.kind === "type") {
            if (type.name === "Dynamic" && !type.family) return this.constructType("Dynamic", value);
            if (type.name === "$any") return value;
            const actual = type.name === "Type" ? this.demand(value) : this.dataValue(value);
            if (type.family?.base) {
                if (actual.kind === "variant" && actual.family?.base) {
                    if (actual.family !== type.family) throw new APNError("runtime", `${type.name} requires explicit unwrapping of ${actual.family.name}`);
                    return actual;
                }
                return { kind: "variant", tag: type.family.name, family: type.family,
                    v: [this.conform(type.family.base, actual)] };
            }
            if (type.family) {
                if (actual.kind !== "variant" || actual.family !== type.family) throw new APNError("runtime", `${type.name} expects a ${type.name} variant`);
                return type.arguments?.length ? this.variantValue(actual.tag, actual.v, type.family, type.arguments) : actual;
            }
            return this.constructType(type.name, actual);
        }
        if (this.isList(type)) return this.templateList(type, value);
        if (type.kind === "record") return this.apply(type, value);
        if (type.kind !== "functionType") throw new APNError("runtime", "expected a type constructor");
        const target = this.force(value);
        if (!this.matchesValueType("Function", target)) throw new APNError("runtime", "function contract expects a function");
        return { kind: "contract", target, from: type.from, to: type.to };
    }

    sameType(a: Value, b: Value): boolean {
        a = this.reference(a); b = this.reference(b);
        if (a === b) return true;
        if (a.kind === "type" && b.kind === "type") {
            const other = b.arguments ?? [];
            return a.name === b.name && a.family === b.family && a.alias === b.alias &&
                (a.arguments?.length ?? 0) === other.length && (a.arguments ?? []).every((v, index) => this.sameType(v, other[index]));
        }
        if (isNumeric(a) && isNumeric(b)) return equalNumbers(a, b);
        if (a.kind === "bool" && b.kind === "bool") return a.v === b.v;
        if (a.kind === "string" && b.kind === "string") return a.v === b.v;
        if (a.kind === "functionType" && b.kind === "functionType") return this.sameType(a.from, b.from) && this.sameType(a.to, b.to);
        if (a.kind === "record" && b.kind === "record") {
            const fields = new Map(b.v);
            return a.v.length === b.v.length && a.v.every(([key, value]) => fields.has(key) && this.sameType(value, fields.get(key)!));
        }
        if (this.isList(a) && this.isList(b)) {
            for (;;) {
                const left = this.cell(a), right = this.cell(b);
                if (!left || !right) return left === right;
                if (!this.sameType(left.head, right.head)) return false;
                a = left.tail; b = right.tail;
            }
        }
        return false;
    }

    belongsToType(type: Value, value: Value): boolean {
        type = this.reference(type); value = this.reference(value);
        if (type.kind === "type" && type.name === "Vect" && !type.family && !type.alias) {
            const [size, element] = this.vectorParts(type);
            if (!this.isList(value)) return false;
            let rest = value;
            for (let n = 0n; n < size; n++) {
                checkInterrupt();
                const cell = this.cell(rest);
                if (!cell || !this.belongsToType(element, cell.head)) return false;
                rest = cell.tail;
            }
            return this.cell(rest) === null;
        }
        if (type.kind === "type") {
            if (type.name === "$any") return true;
            if (type.family) {
                value = this.dataValue(value);
                if (value.kind !== "variant" || value.family !== type.family) return false;
                if (!type.arguments?.length) return true;
                if (value.arguments?.length) return this.sameType(type, { kind: "type", name: type.family.name, family: type.family, arguments: value.arguments });
                const scope = new Env(type.family.env);
                const arguments_ = type.arguments;
                const payloads = value.v;
                type.family.parameters?.forEach((name, index) => scope.setLocal(name, arguments_?.[index] ?? { kind: "type", name: "$any" }));
                const fields = type.family.fields?.get(value.tag) ?? [];
                const caller = this.env; this.env = scope;
                try { return fields.every((field, index) => this.belongsToType(this.eval(field), payloads[index])); }
                finally { this.env = caller; }
            }
            return this.matchesValueType(type.name, type.name === "Mutable" ? value : this.demand(value));
        }
        if (type.kind === "functionType") return this.matchesValueType("Function", value);
        value = this.dataValue(value);
        if (type.kind === "record") {
            if (value.kind !== "record") return false;
            const fields = new Map(value.v);
            return type.v.every(([key, field]) => fields.has(key) && this.belongsToType(field, fields.get(key)!));
        }
        if (this.isList(type)) {
            if (!this.isList(value)) return false;
            for (;;) {
                const field = this.cell(type), element = this.cell(value);
                if (!field || !element) return field === element;
                if (!this.belongsToType(field.head, element.head)) return false;
                type = field.tail; value = element.tail;
            }
        }
        return false;
    }

    isTypeValue(value: Value, seen = new Set<Value>()): boolean {
        value = this.reference(value);
        if (value.kind === "type" || value.kind === "functionType") return true;
        if (seen.has(value)) return false;
        const path = new Set(seen); path.add(value);
        if (value.kind === "record") return value.v.every(([, field]) => this.isTypeValue(field, path));
        if (this.isList(value)) {
            const spine = new Set<Value>();
            let rest: Value = value;
            for (;;) {
                rest = this.demand(rest);
                if (spine.has(rest)) return false;
                spine.add(rest);
                const cell = this.cell(rest);
                if (!cell) return true;
                if (!this.isTypeValue(cell.head, path)) return false;
                rest = cell.tail;
            }
        }
        return false;
    }

    variantValue(tag: string, fields: Value[], family?: import("./types.ts").VariantFamily, arguments_: Value[] = []): Value {
        const scope = new Env(family?.env);
        family?.parameters?.forEach((name, index) => scope.setLocal(name, arguments_[index] ?? { kind: "type", name: "$any" }));
        return { kind: "variant", tag, family, arguments: arguments_.length ? arguments_ : undefined,
            v: fields.map((value, index) => {
                const spec = family?.fields?.get(tag)?.[index];
                if (!spec || (spec.t === "var" && /^[a-z]/.test(spec.name) && !arguments_[family?.parameters?.indexOf(spec.name) ?? -1])) return value;
                return this.defer(() => {
                    const caller = this.env;
                    this.env = scope;
                    try {
                        const type = this.reference(this.eval(spec));
                        if (!this.isTypeValue(type)) throw new APNError("runtime", `constructor ${tag} field must describe a type`);
                        return this.conform(type, value);
                    } finally { this.env = caller; }
                });
            }) };
    }

    matchesValueType(name: string, value: Value): boolean {
        if (name === "Dynamic") return true;
        if (name === "Type") return this.isTypeValue(value);
        if (name !== "Function" && name !== "Mutable") value = this.dataValue(value);
        if (name === "Pointer") return value.kind === "pointer";
        if (name === "Mutable") return value.kind === "mutable";
        if (isNumeric(value)) return NUMERIC_TYPES.includes(name) && matchesType(name, value);
        if (name === "List") return this.isList(value);
        if (name === "Type" && value.kind === "functionType") return true;
        if (name === "Function") return value.kind === "contract" || value.kind === "closure" || value.kind === "clauseFn" || value.kind === "native";
        const names: Partial<Record<Value["kind"], string>> = {
            bool: "Bool", string: "String", char: "Char",
            record: "Record", hashmap: "HashMap", type: "Type", variant: "Variant", pointer: "Pointer",
        };
        return names[value.kind] === name;
    }

    // Empty-container checks inspect only the outer shape/first cell, never heads.
    truthy(value: Value): boolean {
        const v = this.dataValue(value);
        if (v.kind === "bool") return v.v;
        if (isNumeric(v)) {
            if (v.kind === "complex") return this.truthy(v.re) || this.truthy(v.im);
            if (v.kind === "float") return v.v !== 0 && !Number.isNaN(v.v);
            return !equalNumbers(v, integer(0n));
        }
        if (v.kind === "string") return v.v.length > 0;
        if (this.isList(v)) return this.cell(v) !== null;
        if (v.kind === "record") return v.v.length > 0;
        if (v.kind === "hashmap") return v.entries.size > 0;
        if (v.kind === "pointer") return v.bits !== 0n;
        return true;
    }

    constructType(name: string, value: Value): Value {
        if (name === "Dynamic") {
            const actual = this.reference(value);
            return actual.kind === "record" && actual.scope ? this.environmentValue(actual.scope, true) : actual;
        }
        if (name === "Bool") return mkBool(this.truthy(value));
        if (name === "Type") {
            if (!this.isTypeValue(value)) throw new APNError("runtime", "Type constructor expects a Type value");
            return this.inspectType(value);
        }
        value = this.dataValue(value);
        if (name === "Mutable") return { kind: "mutable", v: value };
        if (name === "HashMap") return this.makeHashMap(value);
        if (name === "String" && this.isList(value)) return this.callNative("fromChars", [value]);
        if (NUMERIC_TYPES.includes(name)) {
            if (!isNumeric(value)) throw new APNError("runtime", `${name} expects a number`);
            return castNumeric(name, value);
        }
        if (!this.matchesValueType(name, value)) throw new APNError("runtime", `${name} constructor expects a ${name} value`);
        return value;
    }

    hashKey(value: Value): string {
        value = this.dataValue(value);
        if (isNumeric(value)) return "number:" + numericHash(value);
        if (value.kind === "string" || value.kind === "char" || value.kind === "bool") return value.kind + ":" + String(value.v);
        throw new APNError("runtime", "HashMap keys must be finite numbers, strings, chars, or booleans");
    }

    associations(value: Value): Array<[Value, Value]> {
        if (value.kind === "hashmap") return [...value.entries.values()];
        if (value.kind === "record") return value.v.map(([key, item]) => [mkStr(keyText(key)), item]);
        if (!this.isList(value)) throw new APNError("runtime", "HashMap expects a record or association list");
        const items = this.items(value);
        return items.map((item) => {
            const pair = this.demand(item);
            if (!this.isList(pair)) throw new APNError("runtime", "association entries must be [key, value] pairs");
            const cells = this.items(pair);
            if (cells.length !== 2) throw new APNError("runtime", "association entries must have exactly two elements");
            return [this.demand(cells[0]), cells[1]];
        });
    }

    makeHashMap(value: Value): Value {
        const entries = new Map<string, [Value, Value]>();
        for (const [key, item] of this.associations(value)) entries.set(this.hashKey(key), [key, item]);
        return { kind: "hashmap", entries };
    }

    mapLookup(map: Extract<Value, { kind: "hashmap" }>, key: Value): Value {
        const entry = map.entries.get(this.hashKey(key));
        if (!entry) throw new APNError("runtime", "HashMap key not found");
        return entry[1];
    }

    callNative(name: string, argsIn: Value[], tag?: string): Value {
        if (name === "env") return this.environmentValue();
        if (name === "assert") {
            const argument = argsIn[0];
            const condition = this.demand(argument);
            if (!this.truthy(condition)) {
                const body = argument.kind === "thunk" ? argument.body : undefined;
                const location = body && sourceLocations.get(body);
                const expression = location ? location.source.slice(location.start, location.end).trim() : body ? exprToSource(body) : "false";
                const line = location ? location.source.slice(0, location.start).split("\n").length : undefined;
                const error = new APNError("runtime", `assertion failed: ${expression}${location ? ` (${location.file}:${line})` : ""}`,
                    location ? { pos: location.start, len: Math.max(1, location.end - location.start) } : {});
                if (location) error.src = location.source;
                throw error;
            }
            return { kind: "list", v: [] };
        }
        if (name === "distinct") {
            const base = this.reference(argsIn[0]);
            if (!this.isTypeValue(base)) throw new APNError("runtime", "distinct expects a type");
            const family = { name: "<distinct>", base };
            return { kind: "type", name: family.name, family };
        }
        if (name === "match") {
            // Traverse only as far as the first match. Share the original lazy
            // argument across probes; errors are never treated as mismatches.
            for (const candidate of this.elements(argsIn[1])) {
                const f = this.demand(candidate);
                const arity = f.kind === "clauseFn" || f.kind === "native" ? f.arity - f.applied.length : f.kind === "closure" ? f.params.length : f.kind === "contract" ? 1 : -1;
                if (arity !== 1) throw new APNError("runtime", "match expects alternatives with one remaining argument");
                const result = f.kind === "clauseFn" ? this.apply(f, argsIn[0], true) : this.defer(() => this.apply(f, argsIn[0]));
                if (result.kind !== "nomatch") return result;
            }
            throw new APNError("runtime", "non-exhaustive match: no alternative fits this value");
        }

        const host = this.hostNatives.get(name);
        if (host) return host(argsIn);
        if (name === "use") {
            const value = this.dataValue(argsIn[0]);
            const records = this.isList(value) ? this.items(value).map(v => this.dataValue(v)) : [value];
            const bindings: Array<[string, Value]> = [];
            for (const record of records) {
                if (record.kind !== "record") throw new APNError("runtime", "use expects a record or a list of records");
                for (const [key, field] of record.v) {
                    if (!/^[A-Za-z_][A-Za-z0-9_']*$/.test(key) || key === "_" || KEYWORDS.has(key)) {
                        throw new APNError("runtime", `use cannot bind field ${JSON.stringify(key)}: expected an identifier`);
                    }
                    bindings.push([key, field]);
                }
            }
            // Validate the whole input before publishing; keep the field values lazy.
            this.publishForeignBindings(this.env, bindings);
            return { kind: "list", v: [] };
        }
        if (name === "set") {
            const target = this.reference(argsIn[0]);
            if (target.kind === "pointer") {
                if (!target.elementType) throw new APNError("runtime", "set needs a typed APN allocation; use ffi.poke Type for untyped pointers");
                return standardNative(this, "poke", [{ kind: "type", name: target.elementType }, argsIn[1], target]);
            }
            if (target.kind !== "mutable") throw new APNError("runtime", "set expects a Mutable target");
            // Evaluate against the old contents before changing the shared cell.
            const value = this.demand(argsIn[1]);
            target.v = this.checkedExecution ? this.protectDynamicWrite(target.v, value, "Mutable") : value;
            return { kind: "list", v: [] };
        }
        if (STANDARD_NATIVES.some(([n]) => n === name)) return standardNative(this, name, argsIn);
        if (name === "typeOf") {
            const ref = this.reference(argsIn[0]);
            if (ref.kind === "closure" || ref.kind === "clauseFn" || ref.kind === "native") {
                return { kind: "type", inspect: true, name: "Function", description: describeType(ref) };
            }
            if (ref.kind === "mutable") return { kind: "type", inspect: true, name: "Mutable" };
            if (ref.kind === "functionType") return { kind: "type", inspect: true, name: "Type" };
            if (ref.kind === "contract") return { kind: "functionType", from: ref.from, to: ref.to };
            const value = this.demand(ref);
            if (value.kind === "variant" && value.family) return { kind: "type", inspect: true, name: value.family.name, family: value.family, arguments: value.arguments };
            if (isNumeric(value)) return { kind: "type", inspect: true, name: numericType(value) };
            if (value.kind === "list" && value.schema) return this.inspectType(value.schema);
            if (this.isList(value)) return { kind: "type", inspect: true, name: "List", description: describeType(value) };
            const names: Partial<Record<Value["kind"], string>> = {
                bool: "Bool", string: "String", char: "Char",
                hashmap: "HashMap", record: "Record", variant: "Variant", type: "Type", pointer: "Pointer",
                closure: "Function", clauseFn: "Function", native: "Function",
            };
            return { kind: "type", inspect: true, name: names[value.kind] ?? value.kind,
                description: ["closure", "clauseFn", "native"].includes(value.kind) ? describeType(value) : undefined };
        }
        if (name === "isType") {
            const target = this.reference(argsIn[0]);
            if (!this.isTypeValue(target)) throw new APNError("runtime", "isType expects a type as its first argument");
            return mkBool(this.belongsToType(target, argsIn[1]));
        }
        if (["insert", "lookup", "has", "remove"].includes(name)) {
            const value = this.dataValue(argsIn[0]), map = this.dataValue(argsIn[1]);
            if (map.kind !== "hashmap") throw new APNError("runtime", `${name} expects a HashMap`);
            if (name === "lookup") return this.mapLookup(map, value);
            if (name === "has") return mkBool(map.entries.has(this.hashKey(value)));
            const entries = new Map(map.entries);
            if (name === "remove") entries.delete(this.hashKey(value));
            else for (const [key, item] of this.associations(value)) entries.set(this.hashKey(key), [key, item]);
            return { kind: "hashmap", entries };
        }
        if (name === "keys" || name === "values") {
            const map = this.dataValue(argsIn[0]);
            if (map.kind !== "hashmap") throw new APNError("runtime", `${name} expects a HashMap`);
            return mkList([...map.entries.values()].map((entry) => entry[name === "keys" ? 0 : 1]));
        }
        if (NUMBER_NATIVES.some(([n]) => n === name)) {
            let args = argsIn.map((x) => this.dataValue(x));
            if (name === "expt" && isNumeric(args[0]) && isNumeric(args[1])) return typedPower(args[0], args[1]);
            if (args.length === 2 && isNumeric(args[0]) && isNumeric(args[1]) &&
                ["min", "max", "gcd", "lcm", "quotient", "remainder", "modulo", "makeRectangular"].includes(name)) {
                args = implicitOperands(args[0], args[1]);
            }
            const result = numericNative(name, args);
            return typeof result === "boolean" ? mkBool(result) : result;
        }
        // debug forces without demanding a returned action; quote/toAST inspect
        // syntax and step has its own rules. Ordinary natives (including
        // print and toString) demand values and run zero-argument actions.
        // expression-level natives: they consume the argument's UNEVALUATED form
        if (name === "quote" || name === "toAST") {
            const t = argsIn[0];
            if (t.kind !== "thunk") throw new APNError("runtime", `${name} needs an expression`);
            if (name === "quote") {
                // quote: the expression's SOURCE TEXT as a string (parens kept for
                // ( ) groups); the expression is never evaluated
                const inner = exprToSource(t.body);
                const text = t.body.t === "block" && t.body.style === "(" ? `(${inner})` : inner;
                return mkStr(text);
            }
            return this.sexprOf(t.body);
        }
        if (name === "step") return this.stepNative(argsIn);
        if (name === "debug") {
            // debug = SOURCE inspection: show the argument as written; if what it
            // produces is a 0-arg action (and it wasn't a bare name), show its BODY.
            const t = argsIn[0];
            const forced = this.force(t);
            let text: string;
            if (t.kind === "thunk") {
                const isVar = t.body.t === "var";
                const act = forced.kind === "closure" && forced.params.length === 0
                    ? forced : forced.kind === "thunk" ? forced : null;
                text = !isVar && act ? exprToSource(act.body) : exprToSource(t.body);
            } else text = valueToString(t);
            console.log(text);
            return { kind: "list", v: [] };
        }
        // These natives select their own demand points. In particular take 0
        // never inspects its input, and list producers defer their first cell.
        if (name === "__constr") return { kind: "variant", tag: tag!, v: argsIn };
        if (name === "iterate") return this.iterateList(argsIn[0], argsIn[1]);
        if (name === "map") return this.mapList(argsIn[0], argsIn[1]);
        if (name === "filter") return this.filterList(argsIn[0], argsIn[1]);
        if (name === "zipWith") return this.zipList(argsIn[0], argsIn[1], argsIn[2]);
        if (name === "foldr") return this.foldRight(argsIn[0], argsIn[1], argsIn[2]);
        if (name === "take" || name === "drop") {
            const count = this.dataValue(argsIn[0]);
            if (count.kind !== "int" || count.v < 0) throw new APNError("runtime", `${name} expects a non-negative int count`);
            if (name === "take") return this.takeList(count.v, argsIn[1]);
            let rest = argsIn[1];
            for (let i = 0n; i < count.v; i++) {
                checkInterrupt();
                const cell = this.cell(rest);
                if (cell === null) return mkList([]);
                rest = cell.tail;
            }
            return rest;
        }
        const args = argsIn.map((x, index) => ["print", "emit", "toString", "format"].includes(name) || (name === "foldl" && index === 0) ? this.demand(x) : this.dataValue(x));
        const a = args[0];
        switch (name) {
            case "print":
                this.printValue(a);
                return a;
            case "emit":
                this.printValue(a, false);
                return a;
            case "toString":
                return mkStr(this.renderString(a));
            case "parse": {
                if (a.kind !== "string") throw new Error("Runtime: parse expects a string");
                const s = a.v.trim();
                if (s === "true") return mkBool(true);
                if (s === "false") return mkBool(false);
                const numeric = parseNumberText(s);
                if (numeric !== null) return numeric;
                throw new APNError("runtime", `parse: can't parse '${s}'`);
            }
            case "head": {
                const cell = this.cell(a);
                if (cell === null) throw new APNError("runtime", "head of empty list");
                return cell.head;
            }
            case "tail": {
                const cell = this.cell(a);
                if (cell === null) throw new APNError("runtime", "tail of empty list");
                return cell.tail;
            }
            case "length":
                if (a.kind === "hashmap") return mkInt(a.entries.size); {
                if (a.kind === "string") return mkInt(a.v.length);
                let n = 0n;
                for (const _ of this.elements(a)) n++;
                return mkInt(n);
            }
            case "null":
                if (a.kind === "hashmap") return mkBool(a.entries.size === 0);
                if (a.kind === "string") return mkBool(a.v.length === 0);
                return mkBool(this.cell(a) === null);
            case "enumerate": {
                const walk = (xs: Value, index: bigint): Value => this.defer(() => {
                    const cell = this.cell(xs);
                    return cell ? {
                        kind: "cons", head: mkList([mkInt(index), cell.head]),
                        tail: walk(cell.tail, index + 1n),
                    } : mkList([]);
                });
                return walk(a, 0n);
            }
            case "foldl": {
                const f = args[0];
                let acc = args[1];
                for (const x of this.elements(args[2])) acc = this.demand(this.apply(this.apply(f, acc), x));
                return acc;
            }
            case "intToString":
                if (a.kind !== "int") throw new Error("Runtime: intToString expects int");
                return mkStr(String(a.v));
            case "pairs":
                if (a.kind === "hashmap") return mkList([...a.entries.values()].map(([key, value]) => mkList([key, value])));
                if (a.kind !== "record") throw new Error("Runtime: pairs expects a record");
                return mkList(a.v.map(([k, v]) => mkList([mkStr(keyText(k)), v])));
            case "format": {
                const fmt = this.dataValue(args[0]);
                if (fmt.kind !== "string") throw new Error("Runtime: format expects a string");
                if (!this.isList(args[1])) throw new APNError("runtime", "format expects a list of arguments");
                let expected = 0;
                for (let i = 0; i < fmt.v.length; i++) {
                    if (fmt.v[i] !== "%") continue;
                    if (fmt.v[i + 1] === "%") i++;
                    else expected++;
                }
                const vals: Value[] = [];
                for (const value of this.elements(args[1])) {
                    vals.push(value);
                    if (vals.length > expected) throw new APNError("runtime", `format expected ${expected} arguments, got at least ${vals.length}`);
                }
                if (vals.length !== expected) throw new APNError("runtime", `format expected ${expected} arguments, got ${vals.length}`);
                let out = "";
                let vi = 0;
                for (let i = 0; i < fmt.v.length; i++) {
                    if (fmt.v[i] === "%") {
                        if (fmt.v[i + 1] === "%") { out += "%"; i++; continue; }
                        out += this.renderString(vals[vi], true);
                        vi++;
                    } else out += fmt.v[i];
                }
                return mkStr(out);
            }
            case "exit":
                // Can be put anywhere in the program: terminates the process instantly.
                if (a.kind !== "int") throw new Error("Runtime: exit expects an int status code");
                // Deno takes a signed 32-bit host exit code; never silently round.
                if (a.v < -2147483648n || a.v > 2147483647n) {
                    throw new APNError("runtime", "exit status must fit a signed 32-bit integer");
                }
                return Deno.exit(Number(a.v));
            case "load": return this.loadFile(a);

        }
        throw new Error(`Runtime: unknown native '${name}'`);
    }

    // Files retain include/module semantics. Pending merges live on the heap,
    // so a tail load never retains a JavaScript evaluator stack frame.
    loadFile(pathValue: Value): Value {
        const caller = this.env, callerDir = this.sourceDir;
        const frames: Array<{ caller: Env; loaded: Env }> = [];
        try {
            for (;;) {
                checkInterrupt();
                if (pathValue.kind !== "string") throw new APNError("runtime", "load expects a file path string");
                const filename = pathValue.v.slice(pathValue.v.lastIndexOf("/") + 1);
                if (!filename || filename.includes(".")) {
                    throw new APNError("runtime", "load expects an extensionless file name", {
                        hint: 'use load "file", not load "file.apn"; .apn is added automatically',
                    });
                }
                const p = `${pathValue.v}.apn`;
                const path = this.sourceDir === "." || p.startsWith("/") ? p : `${this.sourceDir}/${p}`;
                let src: string;
                try { src = Deno.readTextFileSync(path); }
                catch (err) { throw new APNError("runtime", `load: can't read '${p}' (looked in '${path}'): ${(err as Error).message}`); }
                let program: TopLevel[];
                try { program = parse(src, path); }
                catch (err) { throw new APNError("runtime", `load: parse error in '${path}': ${(err as Error).message}`); }
                if (this.checking && !this.dynamicDepth) this.checking.verifyLoad(pathValue.v, this.sourceDir, src);
                const loaded = new Env(this.env);
                frames.push({ caller: this.env, loaded });
                this.env = loaded;
                this.sourceDir = dirname(path);
                try {
                    this.runDepth++;
                    try { this.run(program, true); } finally { this.runDepth--; }
                }
                catch (step) {
                    if (!(step instanceof TailLoad)) throw step;
                    pathValue = step.path;
                    this.env = step.env;
                    continue;
                }
                let result: Value = { kind: "record", v: [] };
                while (frames.length) {
                    checkInterrupt();
                    const frame = frames.pop()!;
                    const fields: Array<[string, Value]> = [];
                    this.publishForeignBindings(frame.caller, [...frame.loaded.map]);
                    for (const [key] of frame.loaded.map) fields.push([key, frame.caller.get(key)!]);
                    result = { kind: "record", v: fields };
                }
                return result;
            }
        } finally {
            this.env = caller;
            this.sourceDir = callerDir;
        }
    }

    iterateList(f: Value, value: Value): Value {
        return this.defer(() => ({
            kind: "cons", head: value,
            tail: this.defer(() => this.iterateList(f, this.defer(() => this.apply(this.demand(f), value)))),
        }));
    }

    private associationValue(entries: Value, key: string): Value {
        let rest = entries;
        for (;;) {
            checkInterrupt();
            const entry = this.cell(rest);
            if (entry === null) throw new APNError("runtime", `association list has no key ${JSON.stringify(key)}`);
            const pair = this.dataValue(entry.head);
            if (!this.isList(pair)) throw new APNError("runtime", "association lookup expects [string, value] pairs");
            const first = this.cell(pair);
            const second = first && this.cell(first.tail);
            if (!first || !second || this.cell(second.tail) !== null) {
                throw new APNError("runtime", "association lookup expects [string, value] pairs");
            }
            const candidate = this.dataValue(first.head);
            if (candidate.kind !== "string") throw new APNError("runtime", "association lookup expects string keys");
            if (candidate.v === key) return second.head;
            rest = entry.tail;
        }
    }

    selectList(values: Value, indices: Value): Value {
        return this.defer(() => {
            const cell = this.cell(indices);
            if (cell === null) return mkList([]);
            return {
                kind: "cons",
                head: this.defer(() => {
                    const index = this.listIndex(this.dataValue(cell.head));
                    if (index === undefined) throw new APNError("runtime", "list selection needs integer indices or enumeration values");
                    return this.index(values, index);
                }),
                tail: this.selectList(values, cell.tail),
            };
        });
    }

    applyTemplateSlot(template: Value, value: Value): Value {
        const target = this.force(template);
        if (isNumeric(target)) {
            const incoming = this.dataValue(value);
            if (!isNumeric(incoming)) throw new APNError("runtime", "a numeric template expects a number");
            return target.typeName ? this.constructType(target.typeName, incoming) : incoming;
        }
        if (["string", "char", "bool"].includes(target.kind)) {
            const incoming = this.dataValue(value);
            if (incoming.kind !== target.kind) throw new APNError("runtime", `${target.kind} template expects ${target.kind}, got ${incoming.kind}`);
            return incoming;
        }
        return this.isList(target) ? this.templateList(target, value, true) : this.apply(target, value);
    }

    templateList(templates: Value, values: Value, replaceDefaults = false): Value {
        const input = this.dataValue(values);
        const list = input.kind === "string" ? this.callNative("chars", [input]) : input;
        if (!this.isList(list)) throw new APNError("runtime", "list template expects a list or string");
        return this.applyListTemplate(templates, list, replaceDefaults);
    }

    // Multi-slot templates zip positionally. Shape errors appear when that
    // spine is demanded, without traversing infinite inputs or forcing heads.
    applyListTemplate(templates: Value, values: Value, replaceDefaults = false): Value {
        return this.defer(() => {
            const template = this.cell(templates), value = this.cell(values);
            if (template === null && value === null) return mkList([]);
            if (template === null || value === null) throw new APNError("runtime", "list template and input must have the same length");
            return {
                kind: "cons",
                head: this.defer(() => {
                    if (replaceDefaults) return this.applyTemplateSlot(template.head, value.head);
                    const target = this.force(template.head);
                    return this.isList(target) ? this.templateList(target, value.head) : this.apply(target, value.head);
                }),
                tail: this.applyListTemplate(template.tail, value.tail, replaceDefaults),
            };
        });
    }

    mapList(f: Value, xs: Value): Value {
        return this.defer(() => {
            const cell = this.cell(xs);
            if (cell === null) return mkList([]);
            return { kind: "cons", head: this.defer(() => this.apply(this.demand(f), cell.head)), tail: this.mapList(f, cell.tail) };
        });
    }

    filterList(f: Value, xs: Value): Value {
        return this.defer(() => {
            for (;;) {
                checkInterrupt();
                const cell = this.cell(xs);
                if (cell === null) return mkList([]);
                const predicate = this.dataValue(this.apply(this.demand(f), cell.head));
                if (this.truthy(predicate)) {
                    return { kind: "cons", head: cell.head, tail: this.filterList(f, cell.tail) };
                }
                xs = cell.tail;
            }
        });
    }

    zipList(f: Value, xs: Value, ys: Value): Value {
        return this.defer(() => {
            const x = this.cell(xs);
            if (x === null) return mkList([]);
            const y = this.cell(ys);
            if (y === null) return mkList([]);
            return {
                kind: "cons",
                head: this.defer(() => this.apply(this.apply(this.demand(f), x.head), y.head)),
                tail: this.zipList(f, x.tail, y.tail),
            };
        });
    }

    takeList(n: bigint, xs: Value): Value {
        return this.defer(() => {
            if (n === 0n) return mkList([]);
            const cell = this.cell(xs);
            if (cell === null) return mkList([]);
            return { kind: "cons", head: cell.head, tail: this.takeList(n - 1n, cell.tail) };
        });
    }

    foldRight(f: Value, initial: Value, xs: Value): Value {
        return this.defer(() => {
            const cell = this.cell(xs);
            if (cell === null) return initial;
            return this.apply(this.apply(this.demand(f), cell.head), this.foldRight(f, initial, cell.tail));
        });
    }

    // Check positional shape without forcing elements or traversing an unbounded list.
    recordPatternInput(type: Extract<Value, { kind: "record" }>, value: Value): Value | null {
        if (value.kind === "record") return value;
        if (!this.isList(value)) return null;
        const values: Value[] = [];
        let rest: Value = value;
        for (let index = 0; index < type.v.length; index++) {
            const cell = this.cell(rest);
            if (!cell) return null;
            values.push(cell.head);
            rest = cell.tail;
        }
        return this.cell(rest) === null ? mkList(values) : null;
    }

    // Empty unannotated vectors carry no evidence for their element type.
    // Keep that binder open until another parameter supplies the evidence.
    private vectorTypeHoles = new WeakMap<Map<string, Value>, Set<string>>();

    private matchVectorPattern(args: Pattern[], input: Value, binds: Map<string, Value>): boolean {
        const value = this.dataValue(input);
        if (!this.isList(value)) return false;
        let size: bigint, element: Value | undefined;
        const sizePattern = args[0];
        const fixed = sizePattern.p === "int" ? mkInt(sizePattern.v)
            : sizePattern.p === "var" && binds.has(sizePattern.name) ? this.dataValue(binds.get(sizePattern.name)!) : undefined;
        if (fixed && (fixed.kind !== "int" || fixed.v < 0n)) return false;
        const limit = fixed?.kind === "int" ? fixed.v : undefined;
        if (value.kind === "list" && value.schema?.kind === "type" && value.schema.name === "Vect") {
            [size, element] = this.vectorParts(value.schema);
        } else {
            size = 0n;
            let rest = value;
            for (;;) {
                checkInterrupt();
                const cell = this.cell(rest);
                if (!cell) break;
                if (limit !== undefined && size >= limit) return false;
                const current = this.callNative("typeOf", [cell.head]);
                if (element && !this.sameType(element, current)) return false;
                element = current;
                size++;
                rest = cell.tail;
            }
        }
        if (!this.matchPattern(args[0], mkInt(size), binds)) return false;
        const typePattern = args[1];
        if (typePattern.p === "var") {
            const holes = this.vectorTypeHoles.get(binds) ?? new Set<string>();
            this.vectorTypeHoles.set(binds, holes);
            if (element) {
                if (holes.delete(typePattern.name)) binds.set(typePattern.name, element);
                else if (!this.matchPattern(typePattern, element, binds)) return false;
            } else if (!binds.has(typePattern.name)) {
                holes.add(typePattern.name);
                binds.set(typePattern.name, { kind: "type", name: "$any", description: typePattern.name });
            }
            element = binds.get(typePattern.name)!;
        } else if (typePattern.p === "constr" && typePattern.args.length === 0) {
            const binding = this.env.get(typePattern.tag);
            if (!binding) return false;
            const requested = this.reference(binding);
            if (!this.isTypeValue(requested) || (element && !this.sameType(requested, element))) return false;
            element = requested;
        } else if (typePattern.p !== "wildcard") {
            if (!element || !this.matchPattern(typePattern, element, binds)) return false;
        }
        const type: Value = { kind: "type", name: "Vect", arguments: [mkInt(size), element ?? { kind: "type", name: "$any" }] };
        return this.matchPattern(args[2], this.conform(type, value), binds);
    }

    private schemaPatternType(expression: Expr): Value {
        if (expression.t === "placeholder") return { kind: "type", name: "$any" };
        if (expression.t === "record") return { kind: "record", v: expression.v.map(([key, value]) => [key, this.schemaPatternType(value)]) };
        if (expression.t === "list") return mkList(expression.v.map(value => this.schemaPatternType(value)));
        if (expression.t === "block" && expression.stmts.length === 1) return this.schemaPatternType(expression.stmts[0]);
        return this.reference(this.eval(expression));
    }

    matchPattern(p: Pattern, v: Value, binds: Map<string, Value>): boolean {
        if (p.p === "wildcard") return true;
        if (p.p === "var") {
            if (binds.has(p.name)) return this.equals(binds.get(p.name)!, v);
            binds.set(p.name, v); return true;
        }
        if (p.p === "constr" && p.tag === "Dynamic" && p.args.length === 1) {
            const type = this.reference(this.env.get(p.tag)!);
            if (type.kind === "type" && type.name === "Dynamic" && !type.family && !type.alias) {
                return this.matchPattern(p.args[0], this.constructType("Dynamic", v), binds);
            }
        }
        if (p.p === "schema") {
            const scope = new Env(this.env);
            for (const [name, value] of binds) scope.setLocal(name, value);
            const caller = this.env;
            let type: Value;
            this.env = scope;
            try { type = this.schemaPatternType(p.type); } finally { this.env = caller; }
            if (type.kind === "type" && type.name === "Vect" && !type.family && !type.alias) {
                return this.matchPattern(p.value, this.conform(type, v), binds);
            }
            if (!this.isTypeValue(type)) throw new APNError("runtime", "pattern expects a type description");
            const actual = this.reference(v);
            if (type.kind === "type") {
                if (type.alias) return false;
                if (!type.family) return this.matchPattern({ p: "constr", tag: type.name, args: [p.value] }, actual, binds);
                const variant = this.dataValue(actual);
                if (variant.kind !== "variant" || variant.family !== type.family) return false;
            }
            if (type.kind === "record") {
                const input = this.recordPatternInput(type, this.demand(actual));
                return input !== null && this.matchPattern(p.value, this.conform(type, input), binds);
            }
            if ((this.isList(type) && !this.isList(this.demand(actual))) || (type.kind === "functionType" && !this.matchesValueType("Function", actual))) return false;
            return this.matchPattern(p.value, this.conform(type, actual), binds);
        }
        if (p.p === "contract") {
            const f = this.force(v);
            if (!this.matchesValueType("Function", f)) return false;
            return this.matchPattern(p.value, this.conform(this.resolveFunctionSpec(p.spec), f), binds);
        }
        if (p.p === "constr" && (!TYPE_NAMES.includes(p.tag) || p.tag === "Vect")) {
            const binding = this.env.get(p.tag);
            if (binding) {
                const type = this.reference(binding);
                if (p.args.length === 3 && type.kind === "type" && type.name === "Vect" && !type.arguments?.length && !type.family && !type.alias) return this.matchVectorPattern(p.args, v, binds);
                if (p.args.length === 1 && type.kind === "type" && type.name === "Vect" && !type.family && !type.alias) return this.matchPattern(p.args[0], this.conform(type, v), binds);
                if (p.args.length === 1 && type.kind === "type" && !type.family && !type.alias) {
                    return this.matchPattern({ p: "constr", tag: type.name, args: p.args }, v, binds);
                }
                if (p.args.length === 1 && (this.isList(type) || type.kind === "record") && this.isTypeValue(type)) {
                    const actual = this.dataValue(v);
                    const input = type.kind === "record" ? this.recordPatternInput(type, actual) : this.isList(actual) ? actual : null;
                    return input !== null && this.matchPattern(p.args[0], this.conform(type, input), binds);
                }
                if (type.kind === "type" && type.family) {
                    const actual = this.dataValue(v);
                    return p.args.length === 1 && actual.kind === "variant" && actual.family === type.family &&
                        this.matchPattern(p.args[0], type.family.base ? actual.v[0] : this.conform(type, actual), binds);
                }
                if (type.kind === "functionType") {
                    const f = this.force(v);
                    return p.args.length === 1 && this.matchesValueType("Function", f) && this.matchPattern(p.args[0], this.conform(type, f), binds);
                }
            }
        }
        if (p.p === "constr" && p.tag === "Mutable") {
            const ref = this.reference(v);
            return ref.kind === "mutable" && p.args.length === 1 && this.matchPattern(p.args[0], ref, binds);
        }
        v = p.p === "typeBind" || (p.p === "constr" && p.tag === "Type") ? this.demand(v) : this.dataValue(v);
        switch (p.p) {
            case "typeBind": {
                const type = this.callNative("typeOf", [v]);
                return this.matchPattern({ p: "var", name: p.name }, type, binds) && this.matchPattern(p.value, isNumeric(v) ? numericPayload(v) : v.kind === "variant" && v.family?.base ? v.v[0] : v, binds);
            }
            case "int": return isNumeric(v) && equalNumbers(v, integer(p.v));
            case "bool": return v.kind === "bool" && v.v === p.v;
            case "string": return v.kind === "string" && v.v === p.v;
            case "list": {
                if (v.kind === "record") {
                    // A var-only list pattern destructures a record by field name:
                    //   [x, y]  matches  [x: 1, y: 2]  binding x=1, y=2
                    const fields = new Map<string, Value>();
                    for (const [k, val] of v.v) fields.set(k, val);
                    for (const el of p.v) {
                        if (el.p !== "var") return false;
                        if (!fields.has(el.name)) return false;
                        if (!this.matchPattern(el, fields.get(el.name)!, binds)) return false;
                    }
                    return true;
                }
                if (!this.isList(v)) return false;
                let rest: Value = v;
                for (const pattern of p.v) {
                    const cell = this.cell(rest);
                    if (cell === null || !this.matchPattern(pattern, cell.head, binds)) return false;
                    rest = cell.tail;
                }
                return this.cell(rest) === null;
            }

            case "range":
                // [0..10] matches any int in the range, inclusive
                return v.kind === "int" && v.v >= p.lo && v.v <= p.hi;
            case "recPat": {
                // Keyed record pattern (Rust-style):  [x: a, y: b]  extracts fields x, y
                // from a record and binds a, b to their values.
                if (v.kind !== "record") return false;
                const fields = new Map<string, Value>();
                for (const [k, val] of v.v) fields.set(k, val);
                for (const [key, name] of p.v) {
                    if (!fields.has(key)) return false;
                    if (!this.matchPattern({ p: "var", name }, fields.get(key)!, binds)) return false;
                }
                return true;
            }
            case "cons": {
                if (!this.isList(v)) return false;
                const cell = this.cell(v);
                if (cell === null) return false;
                const nm = new Map(binds);
                if (!this.matchPattern(p.head, cell.head, nm)) return false;
                return this.matchPattern(p.tail, cell.tail, nm) && this.mergeBinds(binds, nm);
            }
            case "constr": {
                if (TYPE_NAMES.includes(p.tag)) {
                    if (p.args.length !== 1) return false;
                    if (!NUMERIC_TYPES.includes(p.tag)) return this.matchesValueType(p.tag, v) && this.matchPattern(p.args[0], v, binds);
                    if (!isNumeric(v)) return false;
                    let converted: Value;
                    try { converted = numericPayload(castNumeric(p.tag, v)); } catch { return false; }
                    return this.matchPattern(p.args[0], converted, binds);
                }
                if (v.kind !== "variant" || v.tag !== p.tag) return false;
                if (v.v.length !== p.args.length) return false;
                for (let i = 0; i < p.args.length; i++) {
                    if (!this.matchPattern(p.args[i], v.v[i], binds)) return false;
                }
                return true;
            }
        }
    }

    mergeBinds(orig: Map<string, Value>, added: Map<string, Value>): boolean {
        for (const [k, v] of added) orig.set(k, v);
        return true;
    }


}

// Directory part of a path (no external deps).
export function dirname(p: string): string {
    const i = p.lastIndexOf("/");
    if (i < 0) return ".";
    return i === 0 ? "/" : p.slice(0, i);
}



export function envNames(env: Env): string[] {
    const s = new Set<string>();
    for (let e: Env | null = env; e; e = e.parent) {
        for (const k of e.map.keys()) s.add(k);
    }
    return [...s];
}