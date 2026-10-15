import { CheckingSession } from "./checking-session.ts";
import { checkInterrupt } from "./interrupt.ts";
export { checkInterrupt, setInterruptFlag, resetInterrupt } from "./interrupt.ts";
import { describeType } from "./type-description.ts";
import { METHODS, sourceLocations } from "./ast.ts";
import { builtinZero } from "./zero-values.ts";
import { isStringKey, keyText, keySource } from "./record-keys.ts";
import typeSource from "../lib/type.apn" with { type: "text" };
import doSource from "../lib/do.apn" with { type: "text" };
import preludeSource from "../lib/prelude.apn" with { type: "text" };
import { STANDARD_NATIVES, standardNative } from "./standard-natives.ts";
import { NATIVE_EXPORTS, RETIRED_NATIVES } from "./native-exports.ts";
import { parseLiteral } from "./text-natives.ts";
import { loadPath, type ModuleFile, readLoad, resolveModule, unknownModule } from "./modules.ts";
import { TYPE_NAMES, NUMERIC_TYPES, numericType, numericPayload, matchesType, castNumeric, implicitOperands, typedArithmetic, typedPower, numericHash } from "./type-system.ts";
import { isNumeric, numberText, arithmetic, negate, equalNumbers, compareNumbers, numericNative, NUMBER_NATIVES, integer, type Real } from "./numbers.ts";
import { APNError, didYouMean, withArticle } from "./errors.ts";
import type { Expr, Pattern, TopLevel } from "./ast.ts";
import { clauseKey, countingFamily, flatTypedPattern, isLoadCall, mergeClauses } from "./ast.ts";
import type { DefClause, Type } from "./types.ts";
import { type Value, Env, IOTail } from "./types.ts";
import { canonicalTypeText, compoundArgument, mkInt, mkBool, mkStr, mkList, typeToString, valueToString, rawString } from "./types.ts";
import { argument, functionSource, residualSource } from "./function-source.ts";
import { KEYWORDS } from "./lexer.ts";
import { parse, exprToSource, patternSource, rangeExpr, isOperatorName, PRIMITIVE_OPERATORS } from "./parser.ts";

// ---------------- Evaluator ----------------

// Internal control transfers, caught only by their matching execution loop.
class TailCall {
    constructor(readonly body: Expr, readonly env: Env) {}
}
class TailLoad {
    constructor(readonly path: Value, readonly env: Env) {}
}

// Natives with effects: applying one builds an IO action; running it performs them.
export const IO_NATIVES = new Set(["print", "emit", "exit", "set", "readFile", "readStdin", "getArgs", "fetch", "bracket", "withFile", "withLibrary"]);
// What the actions of IO builtins yield, for showing their types (IO []).
const IO_RESULTS: Record<string, string> = {
    print: "[]", emit: "[]", exit: "[]", set: "[]", readFile: "String", readStdin: "String", getArgs: "[String]", fetch: "Record", env: "Record",
};

// Scalar types an alias names a subtype of (Money = Float): not aggregates.
const NAMED_BASES = new Set([...NUMERIC_TYPES.filter(t => !["Number", "Real", "Integer", "Exact", "Inexact"].includes(t)), "String", "Bool", "Char"]);

// Builtins that take an undecided value as it is: they show it or pass it on.
const SHOWS_UNDECIDED = new Set(["print", "emit", "toString", "format", "typeOf", "isType", "debug", "seq", "Dynamic"]);

// Operators whose builtin meaning does not demand both operands first.
const LAZY_OPERATORS = new Set(["::", "++", "&&", "||", "$"]);

const STACK_LIMIT = 512; // below V8's own JS stack, so APN errors first

// Native registry: name -> arity. One source of truth for env registration
// and for REPL tab completion.
export const NATIVES: Array<[string, number]> = [
    ...NUMBER_NATIVES,
    ["env", 0], ["assert", 1], ["match", 2], ["set", 2], ["typeOf", 1], ["isType", 2], ["insert", 2], ["lookup", 2], ["has", 2], ["remove", 2], ["keys", 1], ["values", 1],
    ["print", 1], ["head", 1], ["tail", 1], ["length", 1], ["null", 1],
    ["iterate", 2], ["enumerate", 1], ["map", 2], ["filter", 2], ["foldl", 3], ["foldr", 3],
    ["intToString", 1], ["pairs", 1], ["format", 2], ["zipWith", 3],
    ["take", 2], ["drop", 2], ["toString", 1], ["parse", 1], ["debug", 1], ["exit", 1], ["load", 1], ["use", 1],
    ["emit", 1], ["step", 2], ["quote", 1], ["toAST", 1],
    ...[...PRIMITIVE_OPERATORS.keys()].map((name): [string, number] => [name, 2]),
    // Functor, Applicative and Monad, for actions, lists and Option-like variants.
    ["primBind", 2], ["primAp", 2], ["primReturn", 1],
    // Natural numbers are UInt: Z is UInt 0, S n the next one.
    ["S", 1],
    // to T x writes x as a T; from T x reads it back (methods, like map).
    ["to", 2], ["from", 2],
];
const ZERO: Value = { kind: "int", v: 0n, typeName: "UInt" };

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
        this.checking.nativeArities = new Map([...NATIVES, ...STANDARD_NATIVES]);
        this.checking.runtimeNames = () => envNames(this.env);
        // Checking right before running may read the program's input; the run
        // then sees the same file contents and arguments.
        this.checking.inputs = {
            readFile: path => this.inputFile(path), args: () => this.programArgs,
            // Interactive input is never read ahead of the program.
            readStdin: () => Deno.stdin.isTerminal() ? undefined : this.inputStdin(),
        };
    }
    // All of stdin, read once: readStdin returns the same text every time, so
    // the checker (reading ahead of a non-interactive run) and the run agree.
    private stdinText?: string;
    inputStdin(): string {
        if (this.stdinText !== undefined) return this.stdinText;
        const decoder = new TextDecoder();
        const buffer = new Uint8Array(65536);
        const chunks: string[] = [];
        for (;;) {
            const count = Deno.stdin.readSync(buffer);
            if (count === null) break;
            chunks.push(decoder.decode(buffer.subarray(0, count), { stream: true }));
        }
        chunks.push(decoder.decode());
        return this.stdinText = chunks.join("");
    }
    // Files readFile reads, captured once per interpreter (see enableChecking).
    private inputFiles = new Map<string, string>();
    inputFile(path: string): string | undefined {
        if (this.inputFiles.has(path)) return this.inputFiles.get(path);
        try {
            const text = Deno.readTextFileSync(path);
            this.inputFiles.set(path, text);
            return text;
        } catch {
            return undefined;
        }
    }
    private preludeBindings = new Map<string, Value>();
    // Whether the last top-level statement run was an action (the REPL does
    // not echo an action's empty result, as GHCi does not echo ()).
    ranAction = false;
    hostNatives = new Map<string, (args: Value[]) => Value>();
    programArgs: string[] = [];
    // A bundle (a browser build) to import from instead of the disk: virtual
    // paths to sources (see bundleProgram in modules.ts).
    moduleSources?: Record<string, string>;
    private modules = new Map<string, Extract<Value, { kind: "record" }>>();
    private importing = new Set<string>();

    importStandard(module: string | string[], open = true): Value {
        if (this.checking && !this.dynamicDepth) this.checking.module(module, this.sourceDir);
        if (Array.isArray(module)) {
            const fields = new Map<string, Value>();
            for (const name of module) {
                const record = this.importStandard(name, false) as Extract<Value, { kind: "record" }>;
                for (const [key, value] of record.v) fields.set(key, value);
            }
            if (open) this.publishForeignBindings(this.env, [...fields]);
            return { kind: "record", v: [...fields] };
        }
        const resolved = resolveModule(module, this.sourceDir, this.moduleSources, this.moduleRoot);
        if (!resolved) { const { message, hint } = unknownModule(module, !!this.moduleSources); throw new APNError("runtime", message, { hint }); }
        let record = this.modules.get(resolved.key);
        if (!record) {
            if (this.importing.has(resolved.key)) throw new APNError("runtime", `cyclic import '${module}'`);
            this.importing.add(resolved.key);
            try {
                // A folder's files are modules of their own; their exports merge.
                const fields = new Map<string, Value>();
                for (const file of resolved.files) {
                    for (const [name, value] of this.runModuleFile(file)) {
                        if (fields.has(name) && resolved.files.length > 1) throw new APNError("runtime", `'${name}' is defined by more than one file of '${module}'`);
                        fields.set(name, value);
                    }
                }
                record = { kind: "record", v: [...fields] };
                this.modules.set(resolved.key, record);
            } finally { this.importing.delete(resolved.key); }
        }
        if (open) this.publishForeignBindings(this.env, record.v);
        return record;
    }

    // Run one module file against builtins only (never the caller's bindings);
    // its top-level bindings are its exports.
    private runModuleFile(file: ModuleFile): Array<[string, Value]> {
        const caller = this.env;
        const callerDir = this.sourceDir;
        const builtins = new Env();
        // Vect is the prelude's declaration.
        for (const type of TYPE_NAMES) if (type !== "Vect") builtins.setLocal(type, { kind: "type", name: type });
        builtins.setLocal("Z", ZERO);
        for (const [name, arity] of [...NATIVES, ...STANDARD_NATIVES]) if (!(name in RETIRED_NATIVES)) builtins.setLocal(name, { kind: "native", name, arity, applied: [] });
        for (const [name, value] of this.preludeBindings) builtins.setLocal(name, value);
        const scope = new Env(builtins);
        for (const exported of file.std ? NATIVE_EXPORTS[file.std] ?? [] : []) scope.setLocal(exported, builtins.get(exported)!);
        try {
            const program = parse(file.source, file.label);
            this.env = scope;
            this.sourceDir = file.directory;
            this.runDepth++;
            try { this.run(program); } finally { this.runDepth--; }
            // The bundled cast is already installed from this exact source.
            // Reuse its identity when type reexports it.
            if (file.std === "type" && file.source === typeSource) scope.setLocal("cast", this.preludeBindings.get("cast")!);
            return [...scope.map.entries()];
        } finally {
            this.env = caller;
            this.sourceDir = callerDir;
        }
    }

    env = new Env();
    stack = 0;
    // Directory of the source file currently being evaluated — `load` resolves
    // relative paths against it ("relative to your current file").
    sourceDir: string = ".";
    // The program's folder, where import stops searching parent folders.
    moduleRoot?: string;
    sourceFile = "<repl>";

    constructor() {
        for (const name of TYPE_NAMES) if (name !== "Vect") this.env.setLocal(name, { kind: "type", name });
        this.env.setLocal("Z", ZERO);
        // empty in a monad not decided yet, as return x is (the prelude's empty).
        this.env.setLocal("primEmpty", { kind: "pending", step: { op: "empty" } });
        for (const [name, arity] of NATIVES) {
            if (!(name in RETIRED_NATIVES)) this.env.setLocal(name, { kind: "native", name, arity, applied: [] });
        }
        const outer = this.env;
        this.env = new Env(outer);
        this.env.setLocal("fail", { kind: "native", name: "fail", arity: 1, applied: [] });
        this.run(parse(preludeSource));
        // Bind each operator to its value itself, so evaluation finds the intrinsic.
        for (const [name, value] of this.env.map) if (name !== "fail") this.preludeBindings.set(name, this.reference(value));
        this.run(parse(typeSource));
        this.run(parse(doSource));
        for (const name of ["cast", "do"]) this.preludeBindings.set(name, this.env.get(name)!);
        this.loadingPrelude = false;
        this.env = outer;
        for (const [name, value] of this.preludeBindings) outer.setLocal(name, value);
    }

    run(program: TopLevel[], tailLoad = false): Value {
        // The outermost run's folder is the program's: imports search up to it.
        if (!this.runDepth && !this.dynamicDepth) this.moduleRoot = this.sourceDir;
        // Each checked top-level run takes a fresh input snapshot.
        if (this.checking && !this.runDepth && !this.dynamicDepth) this.inputFiles.clear();
        const candidate = this.checking && !this.runDepth && !this.dynamicDepth
            ? this.checking.prepare(program, this.sourceDir) : undefined;
        const saved = candidate ? new Map(this.env.map) : undefined;
        let succeeded = false;
        this.runDepth++;
        try {
            let last: Value = { kind: "list", v: [] };
            for (const [index, tl] of program.entries()) {
                if (tl.t === "type") {
                    // A family of lists counting its elements (Vect n a = [] ->
                    // Vect Z a | a :: Vect k a -> Vect (S k) a) is the length-indexed list.
                    if (countingFamily(tl.def)) { this.env.setLocal(tl.def.name, { kind: "type", name: "Vect" }); continue; }
                    for (const name of [tl.def.name, ...tl.def.variants.map(v => v.tag)]) {
                        const previous = this.env.map.get(name);
                        if (previous && ((previous.kind === "native" && previous.tag) || previous.kind === "variant") && previous.family?.name !== tl.def.name) {
                            throw new APNError("runtime", `cannot redeclare value constructor ${name}; it belongs to ${previous.family?.name}`);
                        }
                    }
                    const results = new Map(tl.def.variants.flatMap(v => v.result ? [[v.tag, v.result] as [string, Expr]] : []));
                    const family = { name: tl.def.name, parameters: tl.def.parameters ?? [], fields: new Map(tl.def.variants.map(v => [v.tag, v.fields ?? []])), env: new Env(this.env), ...results.size ? { results } : {} };
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
                this.ranAction = false;
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
                        // A lambda is a value: applied, it runs (Sized 2 is Vect 2 Int);
                        // where a type is expected, it reads as a function type.
                        if (!this.isTypeValue(value) && value.kind !== "closure" && value.kind !== "clauseFn") throw new APNError("runtime", `${name} must alias a type; use | to declare constructors`);
                        // An alias of a scalar type names a subtype: Money = Float.
                        // A Money is a Float wherever one is accepted, but keeps its
                        // name, and (Money x) accepts only Money values.
                        if (value.kind === "type" && NAMED_BASES.has(value.name) && !value.family && !value.alias && !value.arguments?.length && !value.variable) {
                            const family = { name, base: value };
                            return { kind: "type", name, family };
                        }
                        return value;
                    } finally { this.env = caller; }
                });
            scope.setLocal(name, alias);
            this.env.setLocal(name, alias);
            return alias;
        }
        // A definition of map, >>=, <*> or return defines an instance: it joins
        // the method everywhere instead of shadowing it here. Its clauses are
        // the instance (return x = Some x), or its value is (return = Some).
        if (METHODS.has(name) && !this.loadingPrelude) {
            const child = new Env(this.env), arity = clauses[0].params.length, body = clauses[0].body;
            const method: Value = arity ? { kind: "clauseFn", name, clauses, arity, env: child, applied: [] } : this.defer(() => {
                const caller = this.env;
                this.env = child;
                try { return this.reference(this.eval(body)); } finally { this.env = caller; }
            });
            this.registerInstance(name, method, clauses);
            return method;
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
            // More clauses for a function of this scope extend it (an
            // equivalent one rebinds its clause), wherever they are defined.
            const extended = previous?.kind === "clauseFn" && previous.arity === arity && this.env.map.get(name) === previous;
            const scope = this.env;
            clauses = mergeClauses(name, extended ? previous.clauses : [], clauses, c => this.clauseHead(c, scope));
            // Capture a shared env containing the binding itself, enabling recursion.
            const child = new Env(this.env);
            // Clauses for an operator overload it: the previous meaning still
            // applies to arguments no clause matches.
            // Redefining the clauses in the same scope keeps that fallback.
            const overloaded = !isOperatorName(name) || previous === undefined ? undefined
                : previous.kind === "clauseFn" && this.env.map.get(name) === previous ? previous.fallback : previous;
            const fn: Value = {
                kind: "clauseFn", name, clauses, arity, env: child, applied: [], ...overloaded ? { fallback: overloaded } : {},
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
            case "char": return { t: "char", v: pattern.v };
            case "float": return { t: "float", v: pattern.v };
            case "list": return { t: "list", v: pattern.v.map(p => this.assignmentKey(p)) };
            case "recPat": return { t: "record", v: pattern.v.map(([key, name]) => [key, { t: "var", name }]) };
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

    // origin names the source of the bindings (a loaded file's path and
    // text): running the same source again may replace what it published,
    // since its definitions are the same. checked bindings (a load the
    // static check followed) need no guard: it typed what they replace.
    private publishForeignBindings(scope: Env, bindings: Array<[string, Value]>, origin?: string, checked = false): void {
        const pending = new Map<string, Value>();
        const published = this.publishedBy.get(scope);
        for (const [key, value] of bindings) {
            const old = pending.get(key) ?? (this.checking && !this.dynamicDepth ? scope.map.get(key) : scope.get(key));
            const own = origin !== undefined && old !== undefined && published?.get(key)?.origin === origin && published.get(key)!.value === old;
            pending.set(key, this.checkedExecution && old && !own && !checked ? this.protectDynamicWrite(old, value, key) : value);
        }
        for (const [key, value] of pending) scope.setLocal(key, value);
        if (origin === undefined) { for (const [key] of pending) published?.delete(key); return; }
        const record = published ?? new Map<string, { origin: string; value: Value }>();
        for (const [key, value] of pending) record.set(key, { origin, value });
        this.publishedBy.set(scope, record);
    }
    private publishedBy = new WeakMap<Env, Map<string, { origin: string; value: Value }>>();

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
            if (key.kind === "string") {
                let rest = collection, position = 0n;
                for (;;) {
                    const entry = this.cell(rest);
                    if (!entry) throw new APNError("runtime", `association key '${key.v}' not found`);
                    const pair = this.dataValue(entry.head);
                    if (!this.isList(pair)) throw new APNError("runtime", "association assignment expects [string, value] pairs");
                    const first = this.cell(pair), second = first && this.cell(first.tail);
                    if (!first || !second || this.cell(second.tail)) throw new APNError("runtime", "association lookup expects [string, value] pairs");
                    const name = this.dataValue(first.head);
                    if (name.kind !== "string") throw new APNError("runtime", "association lookup expects string keys");
                    if (name.v === key.v) {
                        const replacement = this.assignSlot(second.head, this.demand(this.eval(expression)));
                        return this.setIndex(collection, position, mkList([first.head, replacement]));
                    }
                    position++; rest = entry.tail;
                }
            }
            if (key.kind === "record") {
                const indices = key.v.map(([name, value]): [string, bigint] => {
                    const index = this.listIndex(this.dataValue(value));
                    if (index === undefined) throw new APNError("runtime", "named list indices must be integers or enumeration values");
                    this.index(collection, index);
                    return [name, index];
                });
                const incoming = this.dataValue(this.eval(expression));
                if (incoming.kind !== "record") throw new APNError("runtime", "named selection assignment requires a record");
                const fields = new Map(incoming.v);
                if (fields.size !== indices.length || indices.some(([name]) => !fields.has(name))) throw new APNError("runtime", "replacement fields must match selection names");
                const checked = indices.map(([name, index]) => this.setIndex(collection, index, this.demand(fields.get(name)!)));
                let result = collection;
                indices.forEach(([, index], n) => { result = this.setIndex(result, index, this.index(checked[n], index)); });
                return result;
            }
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

    // Destructuring binding:  [name, hello] = value  (or (Some x) = value, ...).
    // Evaluates the RHS, matches the pattern, and binds the destructured names
    // in the CURRENT environment (top level or the enclosing block's env).
    evalPatBinding(b: { pattern: Pattern; value: Expr; eager?: boolean; update?: { name: string; value: Expr; error?: string } }): Value {
        if (b.update && this.env.get(b.update.name)) {
            if (b.update.error) throw new APNError("runtime", b.update.error);
            return this.evalPatBinding({ pattern: { p: "var", name: b.update.name }, value: b.update.value });
        }
        // Selecting fields must not first open every export into this scope.
        const evaluated = b.pattern.p === "as" && !b.eager ? this.delay(b.value) : b.value.t === "import"
            ? this.importStandard(b.value.module, false)
            : this.eval(b.value);
        // x <- action runs the action and binds its result; anything else is
        // an error, except a load (which runs a file and yields its exports).
        if (b.eager && !isLoadCall(b.value) && b.value.t !== "import") {
            const action = this.reference(evaluated);
            if (action.kind !== "io" && action.kind !== "pending") throw new APNError("runtime", `<- runs an action, not a ${action.kind}`, { hint: "bind a value with `=`" });
        }
        // The result's outer value is evaluated now (x <- return (x + 1) reads the old x).
        const v = b.eager ? this.reference(this.runIO(evaluated)) : b.pattern.p === "as" ? evaluated : this.force(evaluated);
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
            // An action has no source form: the level stays as written.
            const level = this.demand(this.eval(expr));
            if (level.kind === "io" || level.kind === "pending") break;
            expr = this.valueToExpr(level);
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
            const items = this.elements(seq);
            for (let next = items.next(); !next.done; next = items.next()) {
                const result = this.demand(this.apply(f, next.value));
                // Iterating an action streams: one action running each element's
                // action as it reaches it ([0..] * print prints until Ctrl+C).
                if ((result.kind === "io" || result.kind === "pending") && !out.length) {
                    const list = seq;
                    return { kind: "io", run: () => {
                        const results: Value[] = [];
                        for (const x of this.elements(list)) results.push(this.runIO(this.apply(f, x)));
                        return mkList(results);
                    } };
                }
                out.push(result);
            }
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
        // Iterating an action (xs * print) is one action running each in turn.
        if (out.length && ["io", "pending"].includes(this.reference(out[0]).kind)) {
            return { kind: "io", run: () => mkList(out.map(x => this.runIO(x))) };
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

    // A statement runs its value when that is an IO action.
    runStmt(v: Value, tailLoad = false): Value {
        const value = this.demand(v, tailLoad);
        const action = value.kind === "io" || value.kind === "pending";
        const result = action ? this.runIO(value) : value;
        this.ranAction = action;
        return result;
    }

    // Run an IO action: its effects, then its result. A do-block's last step
    // (an IOTail) continues this loop, so recursive actions use no stack.
    runIO(v: Value): Value {
        const io: Value = { kind: "type", name: "IO" };
        let current = this.realize(v, io);
        while (current.kind === "io") {
            checkInterrupt();
            const result = current.run();
            if (!(result instanceof IOTail)) return result;
            current = this.realize(result.next, io);
        }
        return current;
    }

    // Run the rest of a do-block from its first action, in a fresh scope per
    // run: each statement's IO runs in order; the last statement's action is
    // the block's continuation.
    private runDoBlock(e: Extract<Expr, { t: "block" }>, env: Env, start: number, first?: Value): Value | IOTail {
        const caller = this.env;
        this.env = new Env(env);
        try {
            let r: Value = { kind: "list", v: [] };
            for (let i = start; i < e.stmts.length; i++) {
                const s = e.stmts[i];
                if (i === start && first) { const result = this.runIO(first); r = s.t === "patDef" ? this.bindResult(s, result) : result; }
                else if (s.t === "stmDef") r = this.evalDef(s.name, s.clauses);
                else if (s.t === "patDef") r = this.evalPatBinding(s);
                else if (i < e.stmts.length - 1) this.runStmt(this.eval(s));
                else {
                    // The last statement is the action whose result the block yields.
                    const last = this.realize(this.eval(s), { kind: "type", name: "IO" });
                    if (last.kind !== "io") throw new APNError("runtime", `the last statement of a do-block must be an action, not a ${last.kind}`, { hint: "`return x` is the action yielding `x`" });
                    return new IOTail(last);
                }
            }
            throw new APNError("runtime", "the last statement of a do-block must be an action, not a binding", { hint: "end the block with an action, such as `return x`" });
        } finally { this.env = caller; }
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
                        // env is the action that yields a live view of this scope.
                        if (v.kind === "native" && v.name === "env") {
                            const scope = this.env;
                            r = { kind: "io", result: "Record", run: () => this.environmentValue(scope) };
                        } else r = v;
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
                    case "record": {
                        const fields = new Map<string, Value>();
                        for (const [key, expression] of e.v) {
                            if (key !== "_") { fields.set(key, this.eval(expression)); continue; }
                            const spread = this.dataValue(this.eval(expression));
                            if (spread.kind !== "record") throw new APNError("runtime", "record flattening expects a record");
                            for (const [name, value] of spread.v) fields.set(name, value);
                        }
                        r = { kind: "record", v: [...fields] };
                        break;
                    }
                    case "recordAccess": {
                        // Resolve aliases/actions to the outer record, leaving its fields lazy.
                        const rec = this.dataValue(this.eval(e.rec));
                        if (this.isList(rec) && e.argument) {
                            r = this.templateList(rec, this.eval(e.argument));
                            break;
                        }
                        // (a -> a).(+ 1): a function read as a type, like [Int].[1].
                        if ((rec.kind === "closure" || rec.kind === "clauseFn") && e.scoped && e.argument) {
                            const type = this.asType(rec);
                            if (!type) throw new APNError("runtime", "dotted application expects a type");
                            r = this.conform(type, this.eval(e.argument));
                            break;
                        }
                        if (rec.kind === "io") throw new APNError("runtime", "an action has no fields", { hint: "bind its result first: `x <- action` (`scope <- env; scope.x`)" });
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
                                hint: rec.kind === "io" ? "bind the action's result first: scope <- env; scope.x = 1" : "only records accept fields (an empty list promotes to a record)",
                            });
                        }
                        if (e.entries.length === 1 && e.entries[0] === "_") {
                            const expression = e.value.t === "list" ? e.value.v[0] : e.value;
                            const spread = this.dataValue(this.eval(expression));
                            if (spread.kind !== "record") throw new APNError("runtime", "record flattening expects a record");
                            let merged: Value = { kind: "record", v: [...new Map([...base!, ...spread.v])] };
                            for (let n = parents.length - 1; n >= 0; n--) {
                                const [parent, key] = parents[n];
                                merged = { kind: "record", v: parent.v.map(([k, v]) => [k, k === key ? merged : v]) };
                            }
                            r = merged;
                            break;
                        }
                        const rhsValue = this.demand(this.eval(e.value));
                        let rhs = this.isList(rhsValue) ? mkList(this.items(rhsValue).map((x) => this.demand(x))) : rhsValue;
                        if (e.aliases) {
                            if (rhsValue.kind !== "record") throw new APNError("runtime", "renamed selection assignment requires a record");
                            const fields = new Map(rhsValue.v);
                            if (fields.size !== new Set(e.aliases).size || e.aliases.some(name => !fields.has(name))) throw new APNError("runtime", "replacement fields must match selection names");
                            if (e.entries.some(name => !base!.some(([key]) => key === name))) throw new APNError("runtime", "renamed selection requires existing fields");
                            rhs = mkList(e.aliases.map(name => this.demand(fields.get(name)!)));
                        }
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
                        const dollar = this.env.get("$");
                        if (!(dollar?.kind === "native" && dollar.name === "primApply" && !dollar.applied.length)) {
                            r = this.evalBinop({ t: "binop", op: "$", l: e.f, r: e.x });
                            break;
                        }
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
                                if (s.t === "stmDef") { r = this.evalDef(s.name, s.clauses); continue; }
                                if (s.t === "patDef" && !(s.eager && s.value.t !== "import" && !(s.update && this.env.get(s.update.name)))) { r = this.evalPatBinding(s); continue; }
                                if (s.t !== "patDef" && si === e.stmts.length - 1) {
                                    forceResult = true;
                                    next = new TailCall(s, child);
                                    break;
                                }
                                // A <- binding, or a discarded statement in a monad, makes the
                                // rest of the block a do-block: the block is the action (or
                                // the Option, ...) that runs it, as in Haskell.
                                // Its monad: IO for an action (or a load), undecided for
                                // return and the like, else the value's own (a list, an Option).
                                // A discarded list is pure: [] is also the unit value.
                                const value = s.t === "patDef" ? (isLoadCall(s.value) || s.value.t === "import" ? undefined : this.reference(this.eval(s.value))) : this.demand(this.eval(s));
                                const block = e, start = si;
                                if (!value || value.kind === "io") {
                                    r = { kind: "io", run: () => this.runDoBlock(block, child, start, value) };
                                    break;
                                }
                                if (value.kind === "pending") {
                                    // Undecided, unless the checker found the block's monad.
                                    const target = this.checkedMonad(block);
                                    r = target ? this.desugarDo(block, child, start, target, value) : { kind: "pending", step: { op: "do", block, env: child, start, first: value } };
                                    break;
                                }
                                if (s.t === "patDef") {
                                    const target = this.monadTypeOf(value);
                                    if (!target) throw new APNError("runtime", `<- runs an action, not a ${value.kind}`, { hint: "bind a value with `=`" });
                                    r = this.desugarDo(block, child, start, target, value);
                                    break;
                                }
                                if (value.kind === "variant" && value.family && this.familiesOf(">>=").has(value.family)) {
                                    r = this.desugarDo(block, child, start, this.monadTypeOf(value)!, value);
                                    break;
                                }
                                r = value;
                            }
                            // Reveal the last value without traversing a returned list.
                            if (!next && r.kind !== "io") r = this.force(r);
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
        if (e.op === "::" && ["int", "float", "bool", "string", "char", "record", "lambda"].includes(e.r.t)) {
            // Reject a definitely non-list tail without evaluating either side.
            // Unknown tails stay lazy, so head (1:missing) remains productive.
            const cons = this.env.get("::");
            if (cons?.kind === "native" && cons.name === "primCons" && !cons.applied.length) {
                throw new APNError("runtime", `cons tail expected a list, got ${e.r.t}`);
            }
        }
        const bound = this.env.get(e.op);
        if (bound === undefined) throw new APNError("runtime", `unbound operator '${e.op}'`);
        const f = bound.kind === "thunk" || bound.kind === "deferred" ? this.reference(bound) : bound;
        // A prelude operator bound to its intrinsic runs it directly; strict
        // ones evaluate their operands in place.
        const op = f.kind === "native" && !f.applied.length ? PRIMITIVE_OPERATORS.get(f.name) : undefined;
        if (op && !LAZY_OPERATORS.has(op)) return this.operate(op, this.eval(e.l), this.eval(e.r));
        const l = this.delay(e.l), r = this.delay(e.r);
        if (op) return this.operate(op, l, r);
        return this.apply(this.apply(f, l), r);
    }

    // The builtin meaning of an operator, over lazy operands.
    operate(op: string, lThunk: Value, rThunk: Value): Value {
        if (op === "$") return this.apply(this.demand(lThunk), rThunk);
        if (op === "::") {
            const tail = rThunk;
            return {
                kind: "cons", head: lThunk,
                tail: {
                    kind: "deferred", describes: tail,
                    compute: () => {
                        const value = this.dataValue(tail);
                        if (!this.isList(value)) throw new APNError("runtime", `cons tail expected a list, got ${value.kind}`);
                        return value;
                    },
                },
            };
        }
        if (op === "++") {
            const l = this.dataValue(lThunk);
            const r = rThunk;
            if (this.isList(l)) return this.append(l, r);
            const right = this.dataValue(r);
            if (l.kind === "string" && right.kind === "string") return mkStr(l.v + right.v);
            throw new APNError("runtime", `cannot apply '++' to ${l.kind} and ${right.kind}`);
        }
        if (op === "&&" || op === "||") {
            const left = this.truthy(lThunk);
            return mkBool(op === "&&"
                ? left && this.truthy(rThunk)
                : left || this.truthy(rThunk));
        }
        let l = this.demand(lThunk);
        let r = this.demand(rThunk);
        if (op === "*") {
            const callable = (v: Value) => ["closure", "clauseFn", "native", "type", "contract", "functionType"].includes(v.kind);
            if (callable(r)) return this.iterate(l, r);
            if (callable(l)) return this.iterate(r, l);
        }
        if (op === "==" || op === "!=") return mkBool(this.equals(l, r) === (op === "=="));
        // A named subtype keeps its name through arithmetic with itself or a
        // plain value (Money 1 + 1.0 is a Money); two names do not mix.
        const named = (v: Value) => v.kind === "variant" && v.family?.base ? v.family : undefined;
        const ln = named(l), rn = named(r);
        if (ln || rn) {
            if (ln && rn && ln !== rn) throw new APNError("runtime", `cannot combine ${ln.name} and ${rn.name}`, { hint: "convert one explicitly, as in `Money (amount distance)`" });
            const family = (ln ?? rn)!;
            const a = this.demand(ln ? (l as Extract<Value, { kind: "variant" }>).v[0] : l), b = this.demand(rn ? (r as Extract<Value, { kind: "variant" }>).v[0] : r);
            if (["+", "-", "*", "/", "%", "^"].includes(op)) {
                return this.conform({ kind: "type", name: family.name, family }, this.operate(op, a, b));
            }
            if (["<", ">", "<=", ">="].includes(op)) return this.operate(op, a, b);
            throw new APNError("runtime", `operator '${op}' cannot use a ${family.name} here`);
        }
        if (["+", "-", "*", "/", "%", "^"].includes(op)) {
            l = this.arithmeticValue(l); r = this.arithmeticValue(r);
        } else if (op !== "\\") { l = this.dataValue(l); r = this.dataValue(r); }
        if (["+", "-", "*", "/", "%", "^"].includes(op) &&
                (this.isList(l) || this.isList(r) || l.kind === "record" || r.kind === "record")) {
            return this.arrayArithmetic(op, l, r);
        }
        const bad = (): never => {
            if (l.kind === "pending") this.ambiguous(l);
            if (r.kind === "pending") this.ambiguous(r);
            throw new APNError("runtime", `cannot apply '${op}' to ${l.kind} and ${r.kind}`);
        };
        if (isNumeric(l) && isNumeric(r) && ["+", "-", "*", "/", "%"].includes(op)) return typedArithmetic(op, l, r);
        if (op === "\\") {
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
        if (op === "^") {
            if (!isNumeric(l) || !isNumeric(r)) return bad();
            return typedPower(l, r);
        }
        switch (op) {
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
        throw new APNError("runtime", `'${op}' has no builtin meaning`);
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
        // Against a type, the other side is read as a type too ((a -> a) ==
        // typeOf (x -> x)); types differing only in variable names are equal.
        if (a.kind === "type" || a.kind === "functionType" || b.kind === "type" || b.kind === "functionType") {
            const x = this.asType(a), y = this.asType(b);
            if (!x || !y) return false;
            // A bare constructor names a kind of type: typeOf [1] == List.
            const bare = (t: Value) => t.kind === "type" && !t.arguments?.length && !t.description && !t.variable;
            const kind = (t: Value) => t.kind === "functionType" ? "Function" : t.kind === "type" ? t.name : undefined;
            if ((bare(x) || bare(y)) && x.kind !== "list" && y.kind !== "list") {
                if (x.kind === "type" && y.kind === "type" && x.family && y.family) return x.family === y.family;
                return kind(x) === kind(y);
            }
            // Types with variables, functions or only a description compare by
            // their text, variables renamed in order; others structurally.
            const loose = (t: Value) => t.kind === "functionType" || t.kind === "type" && !!t.description || this.hasVariables(t);
            if (!loose(x) && !loose(y)) return this.sameType(x, y);
            return canonicalTypeText(this.writtenType(x)) === canonicalTypeText(this.writtenType(y));
        }
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
        // A named subtype equals a plain value of its base by payload
        // (Money 1.2 == 1.2); two different names are never equal.
        const named = (v: Value) => v.kind === "variant" && !!v.family?.base;
        if (named(a) !== named(b) && !(a.kind === "variant" && b.kind === "variant")) {
            return this.equals(named(a) ? (a as Extract<Value, { kind: "variant" }>).v[0] : a, named(b) ? (b as Extract<Value, { kind: "variant" }>).v[0] : b);
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
            hint: "use a type constructor such as `Int`, or replace a default inside a template",
        });
        if (["string", "char", "bool"].includes(f.kind)) throw new APNError("runtime", `cannot apply a ${f.kind}`, {
            hint: "use a type constructor or replace a default inside a template",
        });
        switch (f.kind) {
            case "functionType": return this.conform(f, arg);
            // Each call decides the contract's type variables from its
            // arguments: with (a -> a), 1 makes a Int, so the result must be one.
            case "contract": return this.defer(() => {
                const variables = new Map(f.variables ?? []);
                const from = this.instantiate(f.from, variables);
                const input = this.conform(from, arg);
                if (from.kind === "type" && from.variable && from.name !== "_") {
                    const actual = this.reference(this.callNative("typeOf", [input]));
                    if (actual.kind === "type" && !actual.description && !actual.variable) variables.set(from.name, actual);
                }
                const to = this.instantiate(f.to, variables);
                const result = this.apply(f.target, input);
                if (to.kind === "functionType") return { kind: "contract", target: this.force(result), from: to.from, to: to.to, variables };
                try { return this.conform(to, result); }
                catch (error) {
                    if (!(error instanceof APNError)) throw error;
                    throw new APNError("runtime", `function contract ${typeToString({ kind: "functionType", from: f.from, to: f.to })}: the result is not ${typeToString(to)} (${error.message})`);
                }
            });
            case "mutable": return this.apply(this.demand(f), arg);
            case "type": {
                if (f.name === "$any" && !f.family && !f.alias) return arg;
                if (f.name === "Dynamic" && !f.family && !f.alias) {
                    this.dynamicDepth++;
                    try { return this.constructType("Dynamic", this.reference(arg)); }
                    finally { this.dynamicDepth--; }
                }
                let value = this.demand(arg);
                // A base type applied to a named value unwraps it: Float (Money 1.2).
                if (!f.family && !f.alias && NAMED_BASES.has(f.name) && value.kind === "variant" && value.family?.base) value = this.baseValue(value);
                if (f.name === "Vect" && !f.family && !f.alias && (f.arguments?.length ?? 0) < 2) {
                    const args = [...f.arguments ?? []];
                    if (!args.length && (value.kind !== "int" || value.v < 0n)) throw new APNError("runtime", "Vect length must be a nonnegative Int");
                    if (args.length === 1 && !this.isTypeValue(value)) throw new APNError("runtime", "Vect element must be a type");
                    return { ...f, arguments: [...args, value] };
                }
                const parameters = f.alias?.parameters ?? f.family?.parameters ?? [];
                // An indexed family takes values as arguments too (Vec 2 Int).
                const indexed = !!f.family?.results && !(value.kind === "variant" && value.family === f.family);
                if ((f.arguments?.length ?? 0) < parameters.length && (f.alias || indexed || this.isTypeValue(value))) {
                    const arguments_ = [...f.arguments ?? [], isNumeric(value) ? numericPayload(value) : value];
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
                // Applying a named subtype applies its base, as written:
                // F .1 with F = Float32 is F (Float32 .1).
                if (f.family?.base && !(value.kind === "variant" && value.family?.base)) {
                    return this.conform(f, this.apply(f.family.base, value));
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
                return { kind: "closure", params: f.params.slice(1), body: f.body, env: child, whole: f.whole ?? f.params, applied: [...f.applied ?? [], arg] };
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
                const ranked = f.clauses.map((clause, index) => ({ clause, index, score: clause.params.reduce((score, pattern, i) => score + this.patternScore(pattern, raw[i]), 0) }))
                    .sort((a, b) => b.score - a.score || a.index - b.index);
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
                        // Overloads that differ only in result type: the
                        // context of the result chooses (Int (read "3")).
                        const choices = this.resultOverloads(f).get(clause);
                        if (choices) return { kind: "pending", step: { op: "call", fn: f, args: raw, choices } };
                        if (probe) return this.defer(() => {
                            const caller = this.env;
                            this.env = child;
                            try { return this.eval(clause.body); } finally { this.env = caller; }
                        });
                        if (tail) return new TailCall(clause.body, child);
                        return this.eval(clause.body);
                    } finally { this.env = old; }
                }
                if (f.fallback) return raw.reduce((g: Value, x) => this.apply(g, x), f.fallback);
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
                if (value.kind === "record") return { kind: "record", v: value.v.map(([key, selected]) => [key, this.defer(() => {
                    const index = this.listIndex(this.dataValue(selected));
                    if (index === undefined) throw new APNError("runtime", "named list indices must be integers or enumeration values");
                    return this.index(f, index);
                })]) };
                if (value.kind === "string") return this.associationValue(f, value.v);
                throw new APNError("runtime", "indexing a list needs an integer, enumeration value, list or record of indices, or association string key; use .[...] for list templates");
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
                    { hint: f.kind === "io" ? "an action is not a function; bind its result first: `x <- action`" : "lists index by integer; container templates apply their slots to supplied values" },
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
        if (v.kind === "pending") this.ambiguous(v);
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

    // IO is a type constructor: IO T is the type of actions yielding T, and
    // IO T action converts the action's result to T when it runs.
    private actionType(type: Extract<Value, { kind: "type" }>, value: Value): Value {
        if (!type.arguments?.length) {
            if (!this.isTypeValue(value)) {
                throw new APNError("runtime", "IO is a type constructor: IO [] is the type of an action yielding []", { hint: "`return x` is the action yielding `x`" });
            }
            return { kind: "type", name: "IO", arguments: [this.reference(value)] };
        }
        const action = this.realize(value, type);
        if (action.kind !== "io") throw new APNError("runtime", `${valueToString(type)} expects an action, not a ${action.kind}`, { hint: "`return x` is the action yielding `x`" });
        const result = type.arguments[0];
        return { kind: "io", result: () => this.renderString(result), run: () => this.conform(result, this.runIO(action)) };
    }

    // List T: the type of lists of T; applied to a value, a list of T
    // (a pending monadic value becomes a list).
    private listType(type: Extract<Value, { kind: "type" }>, value: Value): Value {
        if (!type.arguments?.length && this.isTypeValue(value)) return { kind: "type", name: "List", arguments: [this.reference(value)] };
        const list = this.realize(value, type);
        if (!this.isList(list)) throw new APNError("runtime", `List constructor expects a List value`);
        const element = type.arguments?.[0];
        if (!element) return list;
        return this.mapList({ kind: "native", name: "<List>", arity: 1, applied: [], invoke: ([x]) => this.conform(element, x) }, list);
    }

    // ---- Monads: instances of map, >>=, <*> and return ----
    // Clause functions a program defines for these methods, newest last: tried
    // (newest first) before the builtin IO and list instances.
    private instances = new Map<string, Value[]>();
    // The variant families each method has an instance for (Monad/Functor patterns).
    private instanceFamilies = new Map<string, Set<unknown>>();
    private loadingPrelude = true;

    // The builtin each method starts from (its IO and list instances).
    static readonly METHOD_NATIVES = new Map([["map", "map"], ["primReturn", "return"], ["primBind", ">>="], ["primAp", "<*>"], ["to", "to"], ["from", "from"]]);
    // to T x and from T x: a program's instances first (newest first), then
    // the builtin ones: String (its text, read back as parse does), JSON
    // (JSON text) and List Char (a string's characters). to of any other type
    // applies it: to Float (Money 1.2) is Float (Money 1.2).
    private convertTo(method: "to" | "from", target: Value, value: Value): Value {
        const own = this.instance(method, [target, value]);
        if (own) return own;
        const type = this.reference(target);
        const is = (name: string) => {
            const builtin = this.preludeBindings.get(name);
            return name === "String" ? type.kind === "type" && type.name === "String" && !type.family && !type.alias
                : !!builtin && this.isTypeValue(type) && this.sameType(this.reference(builtin), type);
        };
        const element = this.isListType(type) && type.kind === "type" && type.arguments?.length === 1 ? this.reference(type.arguments[0]) : undefined;
        const chars = element?.kind === "type" && element.name === "Char" && !element.family && !element.alias;
        if (method === "to") {
            if (is("String")) return this.callNative("toString", [value]);
            if (is("JSON")) return standardNative(this, "toJson", [value]);
            if (chars) return standardNative(this, "chars", [value]);
            // A list template ([Char], [Int,String]) converts position by position, as cast does.
            if (this.isList(type) && this.isTypeValue(type)) return this.templateList(type, value);
            if (this.isTypeValue(type)) return this.apply(type, value);
        } else {
            if (is("String")) return this.callNative("parse", [this.demand(value)]);
            if (is("JSON")) return standardNative(this, "fromJson", [value]);
            if (chars) return standardNative(this, "fromChars", [value]);
        }
        throw new APNError("runtime", `no ${method} instance for ${this.renderString(type)}`, { hint: `define one, such as \`${method} ${this.renderString(type)} x = ...\`` });
    }
    // The method a value is: its builtin, or an operator section of it ((>>=)).
    private methodOf(v: Value): string | undefined {
        if (v.kind === "native" && !v.applied.length) return Interpreter.METHOD_NATIVES.get(v.name);
        if (v.kind !== "closure" || v.applied?.length || v.params.join() !== "$L,$R" || v.body.t !== "binop") return undefined;
        const op = v.body.op, bound = v.env.get(op), base = bound && this.reference(bound);
        return base?.kind === "native" && !base.applied.length ? Interpreter.METHOD_NATIVES.get(base.name) : undefined;
    }
    // A method as an overloaded function shows itself: its builtin (by name),
    // then each instance's clauses, one per line, oldest first.
    private methodText(method: string): string {
        const lines = [/^[a-z]/.test(method) ? method : `(${method})`];
        for (const instance of this.instances.get(method) ?? []) {
            const fn = this.reference(instance);
            lines.push(fn.kind === "clauseFn" || fn.kind === "closure" || fn.kind === "native" ? functionSource(fn) : valueToString(fn));
        }
        return lines.join("\n");
    }
    private registerInstance(method: string, fn: Value, clauses: DefClause[]): void {
        this.instances.set(method, [...this.instances.get(method) ?? [], fn]);
        this.instanceClauses.set(fn, clauses[0]);
        this.instanceFamilies.delete(method);
    }
    // The variant families a method's instances take, read from their clauses
    // (map's second parameter, the others' first), whether they were written
    // as clauses or as a value (map = mapTree).
    private familiesOf(method: string): Set<unknown> {
        const known = this.instanceFamilies.get(method);
        if (known) return known;
        const families = new Set<unknown>(), position = method === "map" ? 1 : 0;
        for (const instance of this.instances.get(method) ?? []) {
            const fn = this.force(instance);
            if (fn.kind !== "clauseFn") continue;
            for (const clause of fn.clauses) {
                const p = clause.params[position];
                const bound = p?.p === "constr" ? fn.env.get(p.tag) : undefined;
                const value = bound && this.force(bound);
                const family = value && (value.kind === "type" || value.kind === "variant" || value.kind === "native") ? value.family : undefined;
                if (family) families.add(family);
            }
        }
        this.instanceFamilies.set(method, families);
        return families;
    }

    // The first instance whose clauses accept these arguments.
    private instance(method: string, args: Value[]): Value | undefined {
        const fns = this.instances.get(method) ?? [];
        // Each argument may decide it: a curried instance (to Celsius = ...)
        // takes the first alone.
        next: for (let n = fns.length - 1; n >= 0; n--) {
            let f = fns[n];
            for (let i = 0; i < args.length; i++) {
                f = this.apply(f, args[i], true);
                if (f.kind === "nomatch") continue next;
            }
            return f;
        }
        return undefined;
    }

    // return x in a monad: return is overloaded on its result, so the newest
    // return instance whose result is in the target monad makes it.
    private returnIn(target: Value, x: Value): Value | undefined {
        const family = target.kind === "type" ? target.family : undefined;
        if (!family) return undefined;
        const fns = this.instances.get("return") ?? [];
        for (let n = fns.length - 1; n >= 0; n--) {
            if (this.instanceHead(fns[n]) === family.name) return this.reference(this.apply(fns[n], x));
        }
        return undefined;
    }
    // The clause each instance was defined by, and the result type it makes.
    private instanceClauses = new WeakMap<Value, DefClause>();
    private instanceHeads = new WeakMap<Value, string | undefined>();
    private instanceHead(fn: Value): string | undefined {
        if (this.instanceHeads.has(fn)) return this.instanceHeads.get(fn);
        const clause = this.instanceClauses.get(fn);
        let head = clause && this.checkedHead(clause);
        if (!head) {
            const value = this.reference(fn);
            if ((value.kind === "native" || value.kind === "variant") && value.family) head = value.family.name;
            else if (value.kind === "clauseFn" || value.kind === "closure") head = headOfDescription(describeType(value), 1);
        }
        this.instanceHeads.set(fn, head);
        return head;
    }
    // A clause's inferred result type (its head: Int, Option): the checker's,
    // or else described from its source without running it.
    private checkedHead(clause: DefClause): string | undefined {
        const at = sourceLocations.get(clause.body);
        return at ? this.checking?.resultHeads.get(`${at.file}:${at.start}`) : undefined;
    }
    // A do-block's monad as the checker inferred it (Result for a block whose
    // statements name it), as a type: undefined when it did not, or for IO.
    private checkedMonad(block: Expr): Value | undefined {
        const at = sourceLocations.get(block);
        const head = at && this.checking?.resultHeads.get(`${at.file}:${at.start}`);
        if (!head || head === "IO") return undefined;
        if (head === "List") return { kind: "type", name: "List" };
        const type = this.env.get(head), value = type && this.reference(type);
        return value?.kind === "type" && value.family ? value : undefined;
    }
    clauseHead(clause: DefClause, env: Env): string | undefined {
        return this.checkedHead(clause) ?? headOfDescription(describeType({ kind: "clauseFn", name: "<clause>", clauses: [clause], arity: clause.params.length, env, applied: [] }), clause.params.length);
    }
    // For each clause with overloads differing only in result type, all of them.
    private overloadGroups = new WeakMap<DefClause[], Map<DefClause, DefClause[]>>();
    private resultOverloads(f: Extract<Value, { kind: "clauseFn" }>): Map<DefClause, DefClause[]> {
        let groups = this.overloadGroups.get(f.clauses);
        if (groups) return groups;
        groups = new Map();
        if (f.clauses.length > 1) {
            const byKey = new Map<string, DefClause[]>();
            for (const c of f.clauses) { const k = clauseKey(f.name, c); byKey.set(k, [...byKey.get(k) ?? [], c]); }
            for (const group of byKey.values()) {
                if (group.length > 1 && new Set(group.map(c => this.clauseHead(c, f.env))).size > 1) for (const c of group) groups.set(c, group);
            }
        }
        this.overloadGroups.set(f.clauses, groups);
        return groups;
    }
    // One clause run on the arguments a call gave it.
    private runClause(f: Extract<Value, { kind: "clauseFn" }>, clause: DefClause, args: Value[]): Value {
        const binds = new Map<string, Value>();
        const caller = this.env;
        this.env = f.env;
        try {
            if (!clause.params.every((p, i) => this.matchPattern(p, args[i], binds))) throw new APNError("runtime", `no clause of '${f.name}' matches the given arguments`);
        } finally { this.env = caller; }
        const child = new Env(f.env);
        for (const [k, v] of binds) child.setLocal(k, v);
        this.env = child;
        try { return this.eval(clause.body); } finally { this.env = caller; }
    }
    // The type a context names, as an overload's result type is written.
    private headOf(target: Value): string | undefined {
        return target.kind === "type" ? target.family?.name ?? target.name : this.isList(target) ? "List" : undefined;
    }

    // The monad a concrete monadic value belongs to, as a type: IO, List, or its variant type.
    monadTypeOf(v: Value): Extract<Value, { kind: "type" }> | undefined {
        if (v.kind === "io") return { kind: "type", name: "IO" };
        if (this.isList(v)) return { kind: "type", name: "List" };
        if (v.kind === "variant" && v.family) return { kind: "type", name: v.family.name, family: v.family };
        return undefined;
    }
    private isIOType(t: Value): boolean { return t.kind === "type" && t.name === "IO" && !t.family; }
    private isListType(t: Value): boolean { return t.kind === "type" && t.name === "List" && !t.family; }

    pendingReturn(value: Value): Value { return { kind: "pending", step: { op: "return", value } }; }

    // A value in the target monad: a pending value is realized there (return
    // by that monad's instance); a concrete one is itself.
    realize(v: Value, target: Value): Value {
        const m = this.reference(v);
        if (m.kind !== "pending") return m;
        const step = m.step;
        if (step.op === "bind") return this.bind(this.realize(step.m, target), step.f);
        if (step.op === "do") return this.desugarDo(step.block as Extract<Expr, { t: "block" }>, step.env, step.start, target, step.first);
        if (step.op === "call") {
            const head = this.headOf(this.reference(target));
            const choice = step.choices.find(c => this.clauseHead(c, step.fn.env) === head);
            if (!choice) throw new APNError("runtime", `no overload of '${step.fn.name}' makes ${head ? `a ${head}` : "this type"}`);
            return this.reference(this.runClause(step.fn, choice, step.args));
        }
        if (step.op === "empty") return this.emptyIn(target);
        if (this.isIOType(target)) { const value = step.value; return { kind: "io", result: () => this.typeText(value), run: () => value }; }
        if (this.isListType(target)) return mkList([step.value]);
        const made = this.returnIn(target, step.value);
        if (made) return made;
        throw new APNError("runtime", `no return instance for ${valueToString(target)}`, { hint: "define one, such as `return = Some`" });
    }

    // empty in a monad: [] for a list, an action failing when run for IO (a
    // failed guard), else the newest empty instance making the target's type.
    private emptyIn(target: Value): Value {
        if (this.isListType(target)) return mkList([]);
        if (this.isIOType(target)) return { kind: "io", result: "a", run: () => { throw new APNError("runtime", "empty ran as an action (a guard failed)"); } };
        const family = target.kind === "type" ? target.family : undefined;
        const fns = this.instances.get("empty") ?? [];
        for (let n = fns.length - 1; family && n >= 0; n--) {
            if (this.instanceHead(fns[n]) === family.name) return this.reference(fns[n]);
        }
        throw new APNError("runtime", `no empty instance for ${valueToString(target)}`, { hint: "define one, such as `empty = None`" });
    }

    // m >>= f: through m's monad. f's results are realized in the same monad.
    bind(mIn: Value, f: Value): Value {
        const m = this.dataValue(mIn);
        if (m.kind === "pending") return { kind: "pending", step: { op: "bind", m, f } };
        const target = this.monadTypeOf(m);
        if (!target) throw new APNError("runtime", `'>>=' needs an action, a list or a monadic value, not a ${m.kind}`);
        if (m.kind === "io") return { kind: "io", run: () => new IOTail(this.realize(this.apply(f, this.runIO(m)), target)) };
        const k: Value = { kind: "native", name: "<bind>", arity: 1, applied: [], invoke: ([x]) => this.realize(this.apply(f, x), target) };
        if (this.isList(m)) return this.concatMapList(m, k);
        const result = this.instance(">>=", [m, k]);
        if (result) return result;
        throw new APNError("runtime", `no >>= instance for ${valueToString(target)}`, { hint: "define one, such as `(Some x) >>= f = f x`" });
    }

    // map f m: lazily over a list, an instance, or derived from m's monad (m >>= (x -> return (f x))).
    mapValue(f: Value, mIn: Value): Value {
        const m = this.dataValue(mIn);
        if (m.kind === "io") return { kind: "io", run: () => this.apply(f, this.runIO(m)) };
        if (this.isList(m)) return this.mapList(f, m);
        if (m.kind !== "pending") {
            if (!this.monadTypeOf(m)) throw new APNError("runtime", `map needs an action, a list or a functor, not a ${m.kind}`);
            const result = this.instance("map", [f, m]);
            if (result) return result;
        }
        return this.bind(m, { kind: "native", name: "<map>", arity: 1, applied: [], invoke: ([x]) => this.pendingReturn(this.defer(() => this.apply(f, x))) });
    }

    // mf <*> mx: an instance, or derived from the monad.
    apValue(mfIn: Value, mx: Value): Value {
        const mf = this.dataValue(mfIn);
        if (mf.kind === "io") return { kind: "io", run: () => { const f = this.runIO(mf); return this.apply(f, this.runIO(mx)); } };
        if (this.isList(mf)) return this.concatMapList(mf, { kind: "native", name: "<ap>", arity: 1, applied: [], invoke: ([f]) => this.mapValue(f, mx) });
        if (mf.kind !== "pending") {
            const result = this.instance("<*>", [mf, mx]);
            if (result) return result;
        }
        return this.bind(mf, { kind: "native", name: "<ap>", arity: 1, applied: [], invoke: ([f]) => this.mapValue(f, mx) });
    }

    // xs >>= k for lists: k's lists concatenated, lazily.
    private concatMapList(list: Value, k: Value): Value {
        return this.defer(() => {
            const cell = this.cell(list);
            return cell === null ? mkList([]) : this.dataValue(this.append(this.apply(k, cell.head), this.concatMapList(cell.tail, k)));
        });
    }

    // A do-block in a monad other than IO: its statements chained with >>=.
    private desugarDo(e: Extract<Expr, { t: "block" }>, env: Env, start: number, target: Value, first?: Value): Value {
        if (this.isIOType(target)) return { kind: "io", run: () => this.runDoBlock(e, env, start, first) };
        const lastAction = (what: string): never => {
            throw new APNError("runtime", `the last statement of a do-block must be an action, not ${what}`, { hint: "end the block with `return x`" });
        };
        const go = (scope: Env, from: number, given?: Value): Value => {
            const caller = this.env;
            this.env = scope;
            try {
                for (let i = from; i < e.stmts.length; i++) {
                    const s = e.stmts[i], last = i === e.stmts.length - 1;
                    if (s.t === "stmDef") { this.evalDef(s.name, s.clauses); continue; }
                    if (s.t === "patDef" && !s.eager) { this.evalPatBinding(s); continue; }
                    if (s.t === "patDef" && last) return lastAction("a binding");
                    const m = given ?? (s.t === "patDef" ? this.reference(this.eval(s.value)) : this.demand(this.eval(s)));
                    given = undefined;
                    if (last) {
                        const value = this.realize(m, target);
                        if (!this.monadTypeOf(value)) lastAction(`a ${value.kind}`);
                        return value;
                    }
                    // A discarded statement outside any monad (assert ...) is pure,
                    // as is a list outside a list block ([] is also the unit value);
                    // an action or another monad's value cannot run here.
                    if (m.kind === "io") throw new APNError("runtime", `an IO action cannot run in ${withArticle(valueToString(target))} do-block`);
                    if (s.t !== "patDef" && m.kind !== "pending" && !this.sameMonad(m, target)) {
                        const other = m.kind === "variant" && m.family && this.familiesOf(">>=").has(m.family) ? this.monadTypeOf(m) : undefined;
                        if (other) throw new APNError("runtime", `${withArticle(valueToString(other))} value cannot run in ${withArticle(valueToString(target))} do-block`);
                        continue;
                    }
                    const next = i + 1, binding = s;
                    return this.bind(this.realize(m, target), { kind: "native", name: "<do>", arity: 1, applied: [], invoke: ([x]) => {
                        const child = new Env(scope);
                        if (binding.t === "patDef") {
                            const old = this.env;
                            this.env = child;
                            try { this.bindResult(binding, x); } finally { this.env = old; }
                        }
                        return go(child, next);
                    } });
                }
                return lastAction("nothing");
            } finally { this.env = caller; }
        };
        return go(new Env(env), start, first);
    }
    private sameMonad(v: Value, target: Value): boolean {
        const t = this.monadTypeOf(v);
        return !!t && target.kind === "type" && t.name === target.name && t.family === target.family;
    }
    // Bind a <- binding's pattern to the result its action yielded.
    private bindResult(b: { pattern: Pattern }, result: Value): Value {
        const v = this.reference(result);
        const binds = new Map<string, Value>();
        if (!this.matchPattern(b.pattern, v, binds)) throw new APNError("runtime", "binding pattern did not match its value");
        for (const [k, bv] of binds) this.env.setLocal(k, bv);
        return v;
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
                    if (!first) emit(",");
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
            } else if (v.kind === "pending") {
                emit(this.undecidedText(v), "pending");
            } else if (v.kind === "variant") {
                // Arguments show as source writes them: Some (Some 1).
                emit(v.tag, "variant");
                for (const arg of v.v) {
                    const shown = this.demand(arg);
                    // A named subtype's payload shows without its base's name:
                    // F 0.1 for F = Float32, not F (Float32 0.1).
                    if (v.family?.base && isNumeric(shown) && shown.typeName) {
                        const text = numberText(shown);
                        emit(text.startsWith("-") ? " (" : " ");
                        emit(text, shown.kind);
                        if (text.startsWith("-")) emit(")");
                        continue;
                    }
                    const wrap = compoundArgument(shown);
                    emit(wrap ? " (" : " ");
                    this.render(shown, emit, false, ancestors);
                    if (wrap) emit(")");
                }
            } else if (v.kind === "clauseFn" && v.applied.length || v.kind === "closure" && v.applied?.length && !(v.whole ?? v.params)[0].startsWith("$")) {
                emit(this.residualText(v), v.kind);
            } else if (this.methodOf(v)) {
                emit(this.methodText(this.methodOf(v)!), v.kind);
            } else emit(raw ? rawString(v) : valueToString(v), v.kind);
        } finally {
            ancestors.delete(v);
        }
    }

    // The type of a value as typeOf shows it: Int, [String], Some Int.
    typeText(v: Value): string { return this.renderString(this.callNative("typeOf", [v])); }

    // How specifically a pattern accepts an argument, for choosing among
    // clauses: literals first, then exact types, then conversions.
    private patternScore(pattern: Pattern, arg: Value): number {
        if (["int", "float", "bool", "string", "char"].includes(pattern.p)) return 40;
        // A named subtype's own pattern outranks its base's: (Money x) first.
        // Only a constructor pattern looks at its argument.
        if (pattern.p !== "constr") return 0;
        const named = this.reference(arg);
        if (named.kind === "variant" && named.family?.base) {
            if (pattern.tag === named.family.name) return 35;
            if (TYPE_NAMES.includes(pattern.tag)) arg = named.v[0];
        }
        if (pattern.p !== "constr" || !TYPE_NAMES.includes(pattern.tag)) return 0;
        // An undecided call fits a typed pattern as an exact type would.
        const undecided = this.reference(arg);
        if (undecided.kind === "pending" && undecided.step.op === "call") return 30;
        if (pattern.tag === "Vect") return this.isList(this.dataValue(arg)) ? 30 : -1000;
        const value = pattern.tag === "Mutable" ? this.reference(arg) : pattern.tag === "Type" ? this.demand(arg) : this.dataValue(arg);
        if (!NUMERIC_TYPES.includes(pattern.tag)) return this.matchesValueType(pattern.tag, value) ? 30 : -1000;
        if (!isNumeric(value)) return -1000;
        if (["Number", "Real", "Integer", "Exact", "Inexact"].includes(pattern.tag)) return matchesType(pattern.tag, value) ? 10 : -1000;
        if (matchesType(pattern.tag, value)) return 30;
        try { castNumeric(pattern.tag, value); return 1; } catch { return -1000; }
    }
    // The most a pattern can score for any argument.
    private bestPatternScore(pattern: Pattern): number {
        if (["int", "float", "bool", "string", "char"].includes(pattern.p)) return 40;
        return pattern.p === "constr" && TYPE_NAMES.includes(pattern.tag) ? 30 : 0;
    }

    // A named subtype's value as its base: Money 1.2 is 1.2 to builtins.
    private baseValue(v: Value): Value {
        return v.kind === "variant" && v.family?.base ? this.dataValue(v.v[0]) : v;
    }

    // Nothing named the type an undecided value should have.
    ambiguous(v: Extract<Value, { kind: "pending" }>): never {
        const step = v.step;
        if (step.op === "bind" || step.op === "do") throw new APNError("runtime", "ambiguous: nothing decides which monad this is", { hint: "name it, as in `Option Int { ... }` or `IO [] { ... }`" });
        const name = step.op === "call" ? step.fn.name : step.op === "empty" ? "empty" : "return";
        throw new APNError("runtime", `ambiguous: nothing decides which ${name}`, { hint: `name the type it should have, as in \`Int (${name} ...)\`` });
    }

    // An undecided value shows each overload it could become, one per line,
    // as a partly applied overloaded function does: return 123 is Some 123,
    // Ok 123, ... for the instances defined.
    private undecidedText(v: Extract<Value, { kind: "pending" }>): string {
        const step = v.step;
        if (step.op === "call") return step.choices.map(c => this.residualText({ ...step.fn, clauses: [c], applied: step.args })).join("\n");
        if (step.op === "bind") return `${this.renderString(step.m)} >>= ${argument(this.force(step.f))}`;
        if (step.op === "do") return exprToSource(step.block);
        if (step.op === "empty") return ["[]", ...(this.instances.get("empty") ?? []).map(instance => this.renderString(instance))].join("\n");
        const lines = (this.instances.get("return") ?? []).map(instance => {
            const fn = this.reference(instance);
            if (fn.kind === "clauseFn") return this.residualText({ ...fn, applied: [...fn.applied, step.value] });
            if (fn.kind === "native") return functionSource({ ...fn, applied: [...fn.applied, step.value] });
            return `${valueToString(fn)} ${argument(step.value)}`;
        });
        return lines.length ? [...new Set(lines)].join("\n") : `return ${argument(step.value)}`;
    }

    // A partly applied function as what is left of it: the clauses its
    // arguments match, without those parameters, the names they bound shown
    // as the arguments (g (Int x) y = 1 applied to 1 is y -> 1).
    private residualText(f: Extract<Value, { kind: "clauseFn" | "closure" }>): string {
        // An argument not evaluated yet shows as its source: printing
        // evaluates nothing a call would not.
        const shown = (x: Value) => () => {
            if (x.kind === "thunk" && x.value === undefined || x.kind === "deferred") return argument(x);
            const value = this.demand(x), text = this.renderString(value);
            return compoundArgument(value) ? `(${text})` : text;
        };
        if (f.kind === "closure") {
            const params = f.whole ?? f.params, applied = f.applied ?? [];
            const values = new Map(params.slice(0, applied.length).map((name, i) => [name, shown(applied[i])]));
            return residualSource(params.slice(applied.length), f.body, undefined, values);
        }
        // The clauses the arguments match, ranked as a call ranks them by
        // these arguments. One that matches anything after them, unguarded,
        // hides those ranked below it, unless the rest of their patterns could
        // still rank them higher.
        const k = f.applied.length, caller = this.env;
        const matched: Array<{ clause: DefClause; index: number; score: number; binds: Map<string, Value> }> = [];
        this.env = f.env;
        try {
            f.clauses.forEach((clause, index) => {
                const binds = new Map<string, Value>();
                if (!f.applied.every((x, i) => this.matchPattern(clause.params[i], x, binds))) return;
                matched.push({ clause, index, binds, score: f.applied.reduce((score: number, x, i) => score + this.patternScore(clause.params[i], x), 0) });
            });
        } finally { this.env = caller; }
        matched.sort((a, b) => b.score - a.score || a.index - b.index);
        const lines: string[] = [], catchAll: Array<{ score: number; index: number }> = [];
        for (const m of matched) {
            const rest = m.clause.params.slice(k);
            const best = m.score + rest.reduce((score, p) => score + this.bestPatternScore(p), 0);
            if (catchAll.some(c => c.score > best || c.score === best && c.index < m.index)) continue;
            lines.push(residualSource(rest, m.clause.body, m.clause.guard, new Map([...m.binds].map(([name, x]) => [name, shown(x)]))));
            if (!m.clause.guard && rest.every(p => p.p === "var" || p.p === "wildcard")) catchAll.push(m);
        }
        if (lines.length) return lines.join("\n");
        if (f.fallback) return this.renderString(f.applied.reduce((g: Value, x) => this.apply(g, x), f.fallback));
        throw new APNError("runtime", `no clause of '${f.name}' matches the given arguments`, { hint: "the definition's patterns don't cover this input" });
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

    conform(typeIn: Value, value: Value): Value {
        const read = this.reference(typeIn);
        const type = read.kind === "closure" || read.kind === "clauseFn" ? this.asType(read) ?? read : typeIn;
        // A type variable not decided by a call takes any value.
        if (type.kind === "type" && type.variable) return value;
        if (type.kind === "type" && type.name === "Vect" && !type.family && !type.alias) {
            const [size, element] = this.vectorParts(type);
            const values = this.vectorElements(this.dataValue(value), size);
            return { kind: "list", schema: type, v: values.map(x => this.defer(() => this.conform(element, x))) };
        }
        if (type.kind === "type") {
            if (type.name === "IO" && !type.family) return this.actionType(type, value);
            if (type.name === "Dynamic" && !type.family) return this.constructType("Dynamic", value);
            if (type.name === "$any") return value;
            if (type.name === "List" && !type.family) return this.listType(type, value);
            let actual = type.name === "Type" ? this.demand(value) : this.dataValue(value);
            // A pending monadic value takes this type's monad (Option Int { return 42 }).
            if (actual.kind === "pending" && (type.family || actual.step.op === "call")) actual = this.dataValue(this.realize(actual, type));
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
                // An indexed family's value has the arguments its constructors made.
                if (type.family.results) {
                    const indices = this.indicesOf(actual)!;
                    if ((type.arguments ?? []).some((wanted, n) => !this.sameIndex(wanted, indices[n]))) {
                        throw new APNError("runtime", `expected ${this.renderString(type)}, got ${this.typeText(actual)}`);
                    }
                    return actual;
                }
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

    // A type's text, its nested types evaluated: Option [Int], a -> List a.
    private writtenType(type: Value): string {
        const t = this.reference(type);
        const argument = (x: Value) => { const text = this.writtenType(x); return /\s/.test(text) && !/^[[(]/.test(text) ? `(${text})` : text; };
        if (t.kind === "type") return (t.description ?? t.name) + (t.arguments ?? []).map(x => " " + argument(x)).join("");
        if (t.kind === "functionType") {
            const from = this.reference(t.from);
            return `${from.kind === "functionType" ? `(${this.writtenType(from)})` : this.writtenType(from)} -> ${this.writtenType(t.to)}`;
        }
        if (this.isList(t)) return `[${[...this.elements(t)].map(x => this.writtenType(x)).join(",")}]`;
        if (t.kind === "record") return `[${t.v.map(([key, x]) => `${keySource(key)}: ${this.writtenType(x)}`).join(", ")}]`;
        return valueToString(t);
    }

    private hasVariables(type: Value): boolean {
        const t = this.reference(type);
        if (t.kind === "type") return !!t.variable || !!t.arguments?.some(x => this.hasVariables(x));
        if (t.kind === "functionType") return this.hasVariables(t.from) || this.hasVariables(t.to);
        return t.kind === "list" && t.v.some(x => this.hasVariables(x));
    }

    // A type with the variables a call has decided replaced by their types.
    private instantiate(type: Value, variables: Map<string, Value>): Value {
        const t = this.reference(type);
        if (!variables.size) return t;
        if (t.kind === "type" && t.variable) return variables.get(t.name) ?? t;
        if (t.kind === "type" && t.arguments?.length) return { ...t, arguments: t.arguments.map(x => this.instantiate(x, variables)) };
        if (t.kind === "functionType") return { kind: "functionType", from: this.instantiate(t.from, variables), to: this.instantiate(t.to, variables) };
        if (t.kind === "list") return mkList(t.v.map(x => this.instantiate(x, variables)));
        return t;
    }

    // A value read as a type, where one is expected. A type is itself; a
    // function is the function type its source spells out ((Int -> Int),
    // (a -> a), ((a -> b) -> List a -> List b)), as a list of types is a
    // positional type. In it a lowercase name is the type it is bound to, or
    // else a type variable. undefined when the value is not a type.
    asType(value: Value, variables = new Map<string, Value>()): Value | undefined {
        const v = this.reference(value);
        if (v.kind === "type" || v.kind === "functionType") return v;
        if (v.kind === "closure" || v.kind === "clauseFn") return this.readFunctionType(v, variables);
        if (this.isList(v)) {
            const items: Value[] = [];
            for (let rest: Value = v; ;) {
                const cell = this.cell(rest);
                if (!cell) return mkList(items);
                const item = this.asType(cell.head, variables);
                if (!item) return undefined;
                items.push(item);
                rest = cell.tail;
            }
        }
        if (v.kind === "record") {
            const fields: Array<[string, Value]> = [];
            for (const [key, field] of v.v) {
                const type = this.asType(field, variables);
                if (!type) return undefined;
                fields.push([key, type]);
            }
            return { kind: "record", v: fields };
        }
        return undefined;
    }
    private readFunctionType(f: Extract<Value, { kind: "closure" | "clauseFn" }>, variables: Map<string, Value>): Value | undefined {
        if (f.kind === "closure" ? f.applied?.length : f.applied.length || f.clauses.length !== 1 || f.clauses[0].guard) return undefined;
        const scope = new Env(f.env);
        const variable = (name: string): Value => {
            if (name === "_") return { kind: "type", name: "_", variable: true };
            const bound = f.env.get(name), value = bound && this.reference(bound);
            if (value && (value.kind === "type" || value.kind === "functionType")) return value;
            if (!variables.has(name)) variables.set(name, { kind: "type", name, variable: true });
            return variables.get(name)!;
        };
        const caller = this.env;
        this.env = scope;
        try {
            const pattern = (p: Pattern): Value | undefined => {
                switch (p.p) {
                    case "var": { const t = variable(p.name); scope.setLocal(p.name, t); return t; }
                    case "wildcard": return variable("_");
                    case "list": {
                        const items = p.v.map(pattern);
                        return items.every(x => x) ? mkList(items as Value[]) : undefined;
                    }
                    case "constr": {
                        const bound = scope.get(p.tag);
                        let type = bound && this.reference(bound);
                        if (!type || type.kind !== "type") return undefined;
                        for (const arg of p.args) {
                            const argument = pattern(arg);
                            if (!argument) return undefined;
                            type = this.reference(this.apply(type, argument));
                        }
                        return type;
                    }
                    case "schema": return this.typeIn(p.type, scope, variables);
                    default: return undefined;
                }
            };
            const params = f.kind === "closure" ? f.params.map((name): Pattern => ({ p: "var", name })) : f.clauses[0].params;
            const inputs = params.map(pattern);
            if (!inputs.every(x => x)) return undefined;
            const body = f.kind === "closure" ? f.body : f.clauses[0].body;
            // Any other lowercase name the body uses is a type variable too,
            // unless it names a type or a function (a type built by one).
            for (const name of freeTypeNames(body)) if (this.typeVariableName(name, scope)) scope.setLocal(name, variable(name));
            const output = this.typeIn(body, scope, variables);
            if (!output) return undefined;
            return (inputs as Value[]).reduceRight((to: Value, from) => ({ kind: "functionType", from, to }), output);
        } catch (error) {
            if (error instanceof APNError) return undefined;
            throw error;
        } finally { this.env = caller; }
    }
    // Whether a lowercase name in a type is a type variable: it is unless it
    // names a type, or a function (which builds one).
    private typeVariableName(name: string, scope: Env): boolean {
        const bound = scope.get(name);
        if (!bound) return true;
        const value = this.reference(bound);
        return !(value.kind === "type" || value.kind === "functionType" || value.kind === "closure" || value.kind === "clauseFn" || value.kind === "native");
    }
    private typeIn(e: Expr, scope: Env, variables: Map<string, Value>): Value | undefined {
        for (const name of freeTypeNames(e)) {
            if (!this.typeVariableName(name, scope)) continue;
            if (!variables.has(name)) variables.set(name, { kind: "type", name, variable: true });
            scope.setLocal(name, variables.get(name)!);
        }
        const caller = this.env;
        this.env = scope;
        try { return this.asType(this.eval(e), variables); }
        catch (error) { if (error instanceof APNError) return undefined; throw error; }
        finally { this.env = caller; }
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
                try { return fields.every((field, index) => this.belongsToType(this.asType(this.eval(field)) ?? this.eval(field), payloads[index])); }
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
                // A field naming an index (Vec k a) takes its value as given:
                // the constructor's indices come from it (see indicesOf).
                if (family?.results && freeTypeNames(spec).some(name => !scope.get(name))) return value;
                return this.defer(() => {
                    const caller = this.env;
                    this.env = scope;
                    try {
                        const type = this.asType(this.eval(spec));
                        if (!type) throw new APNError("runtime", `constructor ${tag} field must describe a type`);
                        return this.conform(type, value);
                    } finally { this.env = caller; }
                });
            }) };
    }

    // Does an index fit what is wanted? Numbers compare by value; a type the
    // value's elements did not decide (Nil's a) fits any type.
    private sameIndex(wanted: Value, actual: Value | undefined): boolean {
        if (!actual) return false;
        const a = this.reference(wanted), b = this.reference(actual);
        if (isNumeric(a) || isNumeric(b)) return isNumeric(a) && isNumeric(b) && equalNumbers(a, b);
        if (a.kind === "type" && (a.name === "$any" || a.variable) || b.kind === "type" && (b.name === "$any" || b.variable)) return true;
        return this.isTypeValue(a) && this.isTypeValue(b) ? this.sameType(a, b) : this.equals(a, b);
    }
    // An indexed family's value's arguments (Vec 2 Int for Cons 1 (Cons 2 Nil)):
    // the result type its constructor makes, with each name its fields give
    // (k from the tail's own indices, a from the element) evaluated. Computed
    // on demand, once; a name nothing gives is any type.
    private indexCache = new WeakMap<Value, Value[]>();
    indicesOf(value: Extract<Value, { kind: "variant" }>): Value[] | undefined {
        const family = value.family;
        if (!family?.results) return undefined;
        const cached = this.indexCache.get(value);
        if (cached) return cached;
        const scope = new Env(family.env);
        const fields = family.fields?.get(value.tag) ?? [];
        const given = (name: string, found: () => Value) => { if (!scope.map.has(name)) scope.setLocal(name, found()); };
        fields.forEach((spec, n) => {
            while (spec.t === "block" && spec.stmts.length === 1) spec = spec.stmts[0];
            if (spec.t === "var" && /^[a-z]/.test(spec.name)) { given(spec.name, () => this.callNative("typeOf", [value.v[n]])); return; }
            const args: Expr[] = [];
            let head = spec;
            while (head.t === "app") { args.unshift(head.a); head = head.f; }
            if (head.t !== "var" || head.name !== family.name) return;
            const inner = this.dataValue(value.v[n]);
            const indices = inner.kind === "variant" && inner.family === family ? this.indicesOf(inner) : undefined;
            args.forEach((arg, i) => { if (arg.t === "var" && /^[a-z]/.test(arg.name) && indices?.[i]) given(arg.name, () => indices[i]); });
        });
        const result = family.results.get(value.tag);
        const args: Expr[] = [];
        let head = result;
        while (head?.t === "app") { args.unshift(head.a); head = head.f; }
        const unknown = (n: number): Value => ({ kind: "type", name: family.parameters?.[n] ?? "a", variable: true });
        const caller = this.env;
        this.env = scope;
        try {
            const indices = result
                ? args.map((arg, n) => {
                    if (arg.t === "var" && /^[a-z]/.test(arg.name) && !scope.map.has(arg.name)) return unknown(n);
                    const v = this.reference(this.eval(arg));
                    return isNumeric(v) ? numericPayload(v) : v;
                })
                : (family.parameters ?? []).map((name, n) => scope.map.get(name) ?? unknown(n));
            this.indexCache.set(value, indices);
            return indices;
        } finally { this.env = caller; }
    }

    matchesValueType(name: string, value: Value): boolean {
        if (name === "Dynamic") return true;
        if (name === "Monad" || name === "Functor") {
            const v = this.dataValue(value);
            if (v.kind === "io" || v.kind === "pending" || this.isList(v)) return true;
            if (v.kind !== "variant" || !v.family) return false;
            const methods = name === "Monad" ? [">>="] : ["map", ">>="];
            return methods.some(m => this.familiesOf(m).has(v.family));
        }
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
            record: "Record", hashmap: "HashMap", type: "Type", variant: "Variant", pointer: "Pointer", io: "IO",
        };
        return names[value.kind] === name;
    }

    // Empty-container checks inspect only the outer shape/first cell, never heads.
    truthy(value: Value): boolean {
        const v = this.dataValue(value);
        if (v.kind === "bool") return v.v;
        if (v.kind === "io" || v.kind === "pending") throw new APNError("runtime", "an action is not a condition", { hint: "run it first: `x <- action`" });
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
            // Dynamic action: the action whose result is Dynamic (Dynamic env).
            if (actual.kind === "io") return { kind: "io", result: "Dynamic", run: () => this.constructType("Dynamic", this.runIO(actual)) };
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

    callNative(name: string, argsIn: Value[], tag?: string, perform = false): Value {
        // Host natives (p5 drawing methods) are effects too.
        if (!perform && (IO_NATIVES.has(name) || this.hostNatives.has(name))) return { kind: "io", result: IO_RESULTS[name], run: () => this.callNative(name, argsIn, tag, true) };
        if (name === "env") { const scope = this.env; return { kind: "io", result: "Record", run: () => this.environmentValue(scope) }; }
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
            // true, not [] (the empty list): a passing assert is pure in any block.
            return { kind: "bool", v: true };
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

        const primitive = PRIMITIVE_OPERATORS.get(name);
        if (primitive) return this.operate(primitive, argsIn[0], argsIn[1]);
        if (name === "primBind") return this.bind(argsIn[0], argsIn[1]);
        if (name === "primAp") return this.apValue(argsIn[0], argsIn[1]);
        if (name === "primReturn") return this.pendingReturn(argsIn[0]);
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
            if (value.kind === "io") return { kind: "type", inspect: true, name: "IO", description: valueToString(value) };
            // An undecided value: return x is m T for the monad m the context
            // decides; a call of result overloads is one of their results.
            if (value.kind === "pending") {
                const step = value.step;
                if (step.op === "call") return { kind: "type", inspect: true, name: "Undecided", description: [...new Set(step.choices.map(c => this.clauseHead(c, step.fn.env) ?? "a"))].join(" | ") };
                const held = step.op === "return" ? this.typeText(step.value) : "a";
                return { kind: "type", inspect: true, name: "Undecided", description: `m ${/\s/.test(held) && !/^[[(]/.test(held) ? `(${held})` : held}` };
            }
            if (value.kind === "variant" && value.family) return { kind: "type", inspect: true, name: value.family.name, family: value.family, arguments: this.indicesOf(value) ?? value.arguments };
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
        if (name === "to" || name === "from") return this.convertTo(name, argsIn[0], argsIn[1]);
        if (name === "isType") {
            const target = this.asType(argsIn[0]);
            if (!target || !this.isTypeValue(target)) throw new APNError("runtime", "isType expects a type as its first argument");
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
            let args = argsIn.map((x) => this.baseValue(this.dataValue(x)));
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
        // map over anything with an instance; a list stays lazy (its spine is
        // not demanded until the result is).
        if (name === "map") { const [f, m] = argsIn; return this.defer(() => this.force(this.mapValue(f, m))); }
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
        // An undecided value reaching a builtin that needs a plain value.
        if (!SHOWS_UNDECIDED.has(name)) for (const x of args) if (x.kind === "pending") this.ambiguous(x);
        // A named subtype is its base to builtins: sqrt (Money 4.0) is 2.0.
        if (!SHOWS_UNDECIDED.has(name)) args.forEach((x, n) => { args[n] = this.baseValue(x); });
        switch (name) {
            // Output actions yield [] (nothing), as print does in Haskell.
            case "print":
                this.printValue(a);
                return mkList([]);
            case "emit":
                this.printValue(a, false);
                return mkList([]);
            case "toString":
                return mkStr(this.renderString(a));
            case "parse": {
                if (a.kind !== "string") throw new Error("Runtime: parse expects a string");
                const parsed = parseLiteral(a.v);
                if (parsed === null) throw new APNError("runtime", `from String: '${a.v.trim()}' is not a Bool or number literal`);
                return typeof parsed === "boolean" ? mkBool(parsed) : parsed;
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
            case "S": {
                if (!isNumeric(a)) throw new APNError("runtime", "S expects a natural number (a UInt)");
                const n = castNumeric("UInt", a);
                return { kind: "int", v: (n as { v: bigint }).v + 1n, typeName: "UInt" };
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
        const frames: Array<{ caller: Env; loaded: Env; origin: string; checked: boolean }> = [];
        try {
            for (;;) {
                checkInterrupt();
                if (pathValue.kind !== "string") throw new APNError("runtime", "load expects a file path string");
                const filename = pathValue.v.slice(pathValue.v.lastIndexOf("/") + 1);
                if (!filename || filename.includes(".")) {
                    throw new APNError("runtime", "load expects an extensionless file name", {
                        hint: `use \`load "file"\`, not \`load "file.apn"\`; .apn is added automatically`,
                    });
                }
                const p = `${pathValue.v}.apn`;
                // A browser build reads the bundle (see bundleProgram in modules.ts).
                const path = this.moduleSources ? loadPath(pathValue.v, this.sourceDir, this.moduleSources)
                    : this.sourceDir === "." || p.startsWith("/") ? p : `${this.sourceDir}/${p}`;
                let src: string;
                if (this.moduleSources) {
                    const bundled = readLoad(path, this.moduleSources);
                    if (bundled === undefined) throw new APNError("runtime", `load: '${p}' is not bundled`, { hint: "a browser build bundles only files inside the program's folder" });
                    src = bundled;
                } else {
                    try { src = Deno.readTextFileSync(path); }
                    catch (err) { throw new APNError("runtime", `load: can't read '${p}' (looked in '${path}'): ${(err as Error).message}`); }
                }
                let program: TopLevel[];
                try { program = parse(src, path); }
                catch (err) { throw new APNError("runtime", `load: parse error in '${path}': ${(err as Error).message}`); }
                const checked = !!this.checking && !this.dynamicDepth;
                if (checked) this.checking!.verifyLoad(pathValue.v, this.sourceDir, src);
                const loaded = new Env(this.env);
                frames.push({ caller: this.env, loaded, origin: `${path}\0${src}`, checked });
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
                    this.publishForeignBindings(frame.caller, [...frame.loaded.map], frame.origin, frame.checked);
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
        const list = input.kind === "string" ? this.callNative("chars", [input]) : input.kind === "record" ? mkList(input.v.map(([, value]) => value)) : input;
        if (!this.isList(list)) throw new APNError("runtime", "list template expects a list, record, or string");
        let converted = this.applyListTemplate(templates, list, replaceDefaults);
        if (input.kind !== "record") return converted;
        // Reuse positional conversion, but retain record keys and lazy fields.
        const fields: [string, Value][] = [];
        for (const [key] of input.v) {
            const cell = this.cell(converted);
            if (cell === null) throw new APNError("runtime", "list template and input must have the same length");
            fields.push([key, cell.head]);
            converted = cell.tail;
        }
        if (this.cell(converted) !== null) throw new APNError("runtime", "list template and input must have the same length");
        return { kind: "record", v: fields };
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

    // A typed pattern whose type names what it binds: (Vect n a) xs, the same
    // as Vect n a xs, binds the length and element type; (List a) xs binds a
    // to the elements' type, computed only if used. undefined when the type
    // binds nothing (every name in it is bound).
    private typeBinding(p: Extract<Pattern, { p: "schema" }>, v: Value, binds: Map<string, Value>): boolean | undefined {
        const args: Expr[] = [];
        let head = p.type;
        while (head.t === "block" && head.stmts.length === 1) head = head.stmts[0];
        while (head.t === "app") { args.unshift(head.a); head = head.f; }
        if (head.t !== "var") return undefined;
        const type = this.env.get(head.name), base = type && this.reference(type);
        if (base?.kind === "type" && base.family?.results) return this.indexedPattern(base.family, args, p.value, v, binds);
        // A length is a value: a bound name is that value. A type position keeps
        // a name bound to a type or function; any other name binds here.
        const free = (e: Expr, n: number) => e.t === "placeholder" || e.t === "var" && /^[a-z]/.test(e.name) && !binds.has(e.name) &&
            (base?.kind === "type" && base.name === "Vect" && n === 0 ? !this.env.get(e.name) : this.typeVariableName(e.name, this.env));
        if (!args.some(free)) return undefined;
        if (base?.kind !== "type" || base.family || base.alias) return undefined;
        // Each argument as the Vect pattern's part: a free name binds, a bound
        // one (or a literal) is compared.
        const asPattern = (e: Expr, n: number): Pattern | undefined => {
            if (e.t === "placeholder") return { p: "wildcard" };
            if (free(e, n) || e.t === "var" && binds.has(e.name)) return { p: "var", name: (e as { name: string }).name };
            if (e.t === "int") return { p: "int", v: e.v };
            if (e.t !== "var") return undefined;
            if (n > 0) return { p: "constr", tag: e.name, args: [] };
            const value = this.dataValue(this.env.get(e.name)!);
            return value.kind === "int" ? { p: "int", v: value.v } : undefined;
        };
        if (base.name === "Vect" && args.length === 2) {
            const [size, element] = args.map(asPattern);
            return !!size && !!element && this.matchVectorPattern([size, element, p.value], v, binds);
        }
        if (base.name === "List" && args.length === 1 && (args[0].t === "var" || args[0].t === "placeholder")) {
            const list = this.dataValue(v);
            if (!this.isList(list)) return false;
            if (args[0].t === "var") {
                const name = args[0].name;
                binds.set(name, this.defer(() => this.elementType(list)));
            }
            return this.matchPattern(p.value, list, binds);
        }
        return undefined;
    }
    // (Vec n a) v on an indexed family: v's indices bind the free names and
    // must equal the rest (an earlier parameter's value, a literal, a type).
    private indexedPattern(family: import("./types.ts").VariantFamily, args: Expr[], value: Pattern, v: Value, binds: Map<string, Value>): boolean {
        const actual = this.dataValue(v);
        if (actual.kind !== "variant" || actual.family !== family) return false;
        const indices = this.indicesOf(actual)!;
        // An index position (one a constructor's result computes: Z, S k) is a
        // value; a type position follows the written-function-type rule.
        const valueAt = (n: number) => [...family.results!.values()].some(result => {
            const parts: Expr[] = [];
            while (result.t === "app") { parts.unshift(result.a); result = result.f; }
            return parts[n] && !(parts[n].t === "var" && /^[a-z]/.test((parts[n] as { name: string }).name));
        });
        for (const [n, arg] of args.entries()) {
            if (arg.t === "placeholder") continue;
            const free = arg.t === "var" && /^[a-z]/.test(arg.name) && !binds.has(arg.name) && (valueAt(n) ? !this.env.get(arg.name) : this.typeVariableName(arg.name, this.env));
            if (free) { binds.set((arg as { name: string }).name, indices[n]); continue; }
            const wanted = arg.t === "var" && binds.has(arg.name) ? binds.get(arg.name)! : this.reference(this.eval(arg));
            if (!this.sameIndex(wanted, indices[n])) return false;
        }
        return this.matchPattern(value, actual, binds);
    }
    // The type typeOf describes for a list's elements: Int for [1,2].
    private elementType(list: Value): Value {
        const described = this.reference(this.callNative("typeOf", [list]));
        const text = described.kind === "type" && described.description ? described.description.replace(/^List /, "").replace(/^\((.*)\)$/, "$1") : "a";
        const name = /^[A-Z][A-Za-z0-9_]*/.exec(text)?.[0];
        return name && name === text && TYPE_NAMES.includes(name) ? { kind: "type", name } : { kind: "type", inspect: true, name: name ?? "$any", description: text };
    }
    private readonly schemaTypeCaptures = new WeakMap<Value, string>();

    private schemaPatternType(expression: Expr, capture = false): Value {
        if (expression.t === "placeholder") return { kind: "type", name: "$any" };
        if (expression.t === "record") {
            const fields = new Map<string, Value>();
            for (const [key, expression_] of expression.v) {
                const value = this.schemaPatternType(expression_, capture);
                if (key !== "_") { fields.set(key, value); continue; }
                if (value.kind !== "record") throw new APNError("runtime", "record flattening expects a record");
                for (const [name, type] of value.v) fields.set(name, type);
            }
            return { kind: "record", v: [...fields] };
        }
        if (expression.t === "list") return mkList(expression.v.map(value => this.schemaPatternType(value, capture)));
        if (expression.t === "block" && expression.stmts.length === 1) return this.schemaPatternType(expression.stmts[0], capture);
        if (capture && expression.t === "var" && /^[a-z]/.test(expression.name) && !this.env.get(expression.name)) {
            const type: Value = { kind: "type", name: "$any" };
            this.schemaTypeCaptures.set(type, expression.name);
            return type;
        }
        return this.reference(this.eval(expression));
    }

    private captureSchema(type: Value, value: Value, binds: Map<string, Value>): Value | null {
        const name = this.schemaTypeCaptures.get(type);
        if (name) {
            const ref = this.reference(value);
            if (!this.matchPattern({ p: "var", name }, this.callNative("typeOf", [ref]), binds)) return null;
            return isNumeric(ref) ? numericPayload(ref) : ref;
        }
        if (type.kind === "record") {
            const actual = this.reference(value);
            if (actual.kind !== "record") return null;
            const fields = new Map(actual.v);
            for (const [key, slot] of type.v) {
                if (!fields.has(key)) return null;
                const captured = this.captureSchema(slot, fields.get(key)!, binds);
                if (captured === null) return null;
                fields.set(key, captured);
            }
            return { kind: "record", v: [...fields] };
        }
        if (type.kind === "list") {
            const fields: Value[] = [];
            let rest = value;
            for (const slot of type.v) {
                const cell = this.cell(rest);
                if (!cell) return null;
                const captured = this.captureSchema(slot, cell.head, binds);
                if (captured === null) return null;
                fields.push(captured); rest = cell.tail;
            }
            return this.cell(rest) === null ? mkList(fields) : null;
        }
        return value;
    }

    private hasSchemaCapture(type: Value): boolean {
        if (this.schemaTypeCaptures.has(type)) return true;
        if (type.kind === "record") return type.v.some(([, value]) => this.hasSchemaCapture(value));
        return type.kind === "list" && type.v.some(value => this.hasSchemaCapture(value));
    }

    matchPattern(p: Pattern, v: Value, binds: Map<string, Value>): boolean {
        if (p.p === "as") {
            const local = new Map(binds);
            if (!this.matchPattern(p.left, v, local) || !this.matchPattern(p.right, v, local)) return false;
            return this.mergeBinds(binds, local);
        }
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
            const bindsType = this.typeBinding(p, v, binds);
            if (bindsType !== undefined) return bindsType;
            const scope = new Env(this.env);
            for (const [name, value] of binds) scope.setLocal(name, value);
            const caller = this.env;
            let type: Value;
            this.env = scope;
            try { type = this.schemaPatternType(p.type, true); } finally { this.env = caller; }
            type = this.asType(type) ?? type;
            if (type.kind === "type" && type.name === "Vect" && !type.family && !type.alias) {
                return this.matchPattern(p.value, this.conform(type, v), binds);
            }
            if (!this.isTypeValue(type)) throw new APNError("runtime", "pattern expects a type description");
            let actual = this.reference(v);
            if (this.isList(type) && actual.kind === "record" && p.value.p === "list") {
                const fields = new Map(actual.v), selected: Value[] = [];
                for (const field of p.value.v) {
                    if (field.p !== "var" || !fields.has(field.name)) return false;
                    selected.push(fields.get(field.name)!);
                }
                actual = mkList(selected);
            }
            if (type.kind === "type") {
                if (type.alias) return false;
                if (!type.family) return this.matchPattern({ p: "constr", tag: type.name, args: [p.value] }, actual, binds);
                const variant = this.dataValue(actual);
                if (variant.kind !== "variant" || variant.family !== type.family) return false;
            }
            if (type.kind === "record") {
                const input = this.recordPatternInput(type, this.demand(actual));
                if (input === null) return false;
                const converted = this.conform(type, input);
                const captured = this.hasSchemaCapture(type) ? this.captureSchema(type, converted, binds) : converted;
                return captured !== null && this.matchPattern(p.value, captured, binds);
            }
            if ((this.isList(type) && !this.isList(this.demand(actual))) || (type.kind === "functionType" && !this.matchesValueType("Function", actual))) return false;
            const converted = this.conform(type, actual);
            const captured = this.hasSchemaCapture(type) ? this.captureSchema(type, converted, binds) : converted;
            return captured !== null && this.matchPattern(p.value, captured, binds);
        }
        // A typed pattern names the type an undecided call should have:
        // g (Int n) applied to read "3" takes the Int overload.
        if (p.p === "constr" && p.args.length) {
            const undecided = this.reference(v);
            const named = undecided.kind === "pending" && undecided.step.op === "call" ? this.env.get(p.tag) : undefined;
            const type = named && this.reference(named);
            if (type && type.kind === "type") {
                try { v = this.realize(undecided, type); }
                catch (error) { if (error instanceof APNError) return false; throw error; }
            }
        }
        // A bare type name matches that type itself, as a value: describe Int.
        if (p.p === "constr" && !p.args.length) {
            const bound = this.env.get(p.tag), named = bound && this.reference(bound);
            if (named && this.isTypeValue(named) && !(named.kind === "type" && named.name === "$any")) {
                const given = this.reference(v);
                return this.isTypeValue(given) && this.sameType(named, given);
            }
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
                // (Vec n a xs) is the typed pattern ((Vec n a) xs).
                const flat = flatTypedPattern(p, name => {
                    const bound = this.env.get(name), t = bound && this.reference(bound);
                    return t?.kind === "type" && t.family && !t.arguments?.length && !t.alias ? t.family.parameters?.length : undefined;
                });
                if (flat) return this.matchPattern(flat, v, binds);
                if (type.kind === "type" && type.family) {
                    // The type itself, described (Option t matching the type Option Int):
                    // its arguments bind to the pattern's.
                    const described = this.reference(v);
                    if (described.kind === "type" && described.family === type.family) {
                        return p.args.every((arg, i) => this.matchPattern(arg, described.arguments?.[i] ?? { kind: "type", name: "$any" }, binds));
                    }
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
        // A named subtype matches its base's patterns: (Float x) takes Money 1.2.
        if (p.p === "constr" && TYPE_NAMES.includes(p.tag) && !["Type", "Mutable", "Dynamic"].includes(p.tag)) {
            const named = this.reference(v);
            if (named.kind === "variant" && named.family?.base) v = named.v[0];
        }
        v = p.p === "typeBind" || (p.p === "constr" && p.tag === "Type") ? this.demand(v) : this.dataValue(v);
        switch (p.p) {
            case "typeBind": {
                const type = this.callNative("typeOf", [v]);
                return this.matchPattern(p.name === "_" ? { p: "wildcard" } : { p: "var", name: p.name }, type, binds) && this.matchPattern(p.value, isNumeric(v) ? numericPayload(v) : v.kind === "variant" && v.family?.base ? v.v[0] : v, binds);
            }
            case "int": return isNumeric(v) && equalNumbers(v, integer(p.v));
            case "bool": return v.kind === "bool" && v.v === p.v;
            case "string": return v.kind === "string" && v.v === p.v;
            case "char": return v.kind === "char" && v.v === p.v;
            // Like integer patterns, float patterns compare numerically.
            case "float": return isNumeric(v) && equalNumbers(v, { kind: "float", v: p.v });
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
                const selected = new Set(p.v.filter(([key]) => key !== "_").map(([key]) => key));
                for (const [key, name] of p.v) {
                    if (key === "_") {
                        if (!this.matchPattern({ p: "var", name }, { kind: "record", v: v.v.filter(([field]) => !selected.has(field)) }, binds)) return false;
                        continue;
                    }
                    if (!fields.has(key)) return false;
                    if (!this.matchPattern({ p: "var", name }, fields.get(key)!, binds)) return false;
                }
                return true;
            }
            case "cons": {
                // The constructor the operator names: list cons, or one a program
                // bound it to ((::) = Cons makes x :: xs match Cons x xs).
                const op = p.op ?? "::", bound = this.env.get(op), named = bound && this.reference(bound);
                if (named && !(named.kind === "native" && named.name === "primCons" && !named.applied.length)) {
                    if (named.kind === "native" && named.name === "__constr" && named.arity === 2 && !named.applied.length) {
                        return this.matchPattern({ p: "constr", tag: named.tag!, args: [p.head, p.tail] }, v, binds);
                    }
                    throw new APNError("runtime", `'${op}' is not a constructor, so it cannot take a value apart`, { hint: `bind it to a two-field constructor, as in \`(${op}) = Cons\`` });
                }
                if (!named && op !== "::") throw new APNError("runtime", `unbound operator '${op}'`, { hint: `bind it to a two-field constructor, as in \`(${op}) = Cons\`` });
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
                // Z and S k take a natural number apart: 0, or k + 1 (k a UInt).
                if (isNumeric(v) && (p.tag === "Z" && !p.args.length || p.tag === "S" && p.args.length === 1)) {
                    let n: bigint;
                    try { n = (castNumeric("UInt", v) as { v: bigint }).v; } catch { return false; }
                    return p.tag === "Z" ? n === 0n : n > 0n && this.matchPattern(p.args[0], { kind: "int", v: n - 1n, typeName: "UInt" }, binds);
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



// The head of a described function's result after these parameters:
// "a -> Option a" after 1 is Option. undefined for a variable or unknown.
function headOfDescription(description: string, arity: number): string | undefined {
    let depth = 0, start = 0, seen = 0;
    for (let i = 0; i < description.length; i++) {
        const c = description[i];
        if (c === "(" || c === "[") depth++;
        else if (c === ")" || c === "]") depth--;
        else if (depth === 0 && description.startsWith("->", i)) {
            if (++seen === arity) { start = i + 2; break; }
        }
    }
    if (seen < arity) return undefined;
    const result = description.slice(start).trim();
    if (result.startsWith("[")) return "List";
    return /^[A-Z][A-Za-z0-9_]*/.exec(result)?.[0];
}

// The lowercase names an expression uses that it does not bind itself: in a
// type, those not bound elsewhere are type variables.
function freeTypeNames(e: Expr): string[] {
    const names = new Set<string>();
    const walk = (x: unknown, bound: Set<string>): void => {
        if (Array.isArray(x)) { x.forEach(y => walk(y, bound)); return; }
        if (!x || typeof x !== "object" || "p" in (x as object)) return;
        const n = x as Record<string, unknown>;
        if (n.t === "var" && /^[a-z]/.test(n.name as string) && !bound.has(n.name as string)) { names.add(n.name as string); return; }
        if (n.t === "lambda") { walk(n.body, new Set([...bound, ...n.params as string[]])); return; }
        if (n.t === "patternLambda") return;
        for (const value of Object.values(n)) if (value && typeof value === "object") walk(value, bound);
    };
    walk(e, new Set());
    return [...names];
}

export function envNames(env: Env): string[] {
    const s = new Set<string>();
    for (let e: Env | null = env; e; e = e.parent) {
        for (const k of e.map.keys()) s.add(k);
    }
    return [...s];
}