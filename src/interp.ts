import { CheckingSession } from "./checking-session.ts";
import type { TypeScope } from "./type-checker.ts";
import { checkInterrupt } from "./interrupt.ts";
export { checkInterrupt, setInterruptFlag, resetInterrupt } from "./interrupt.ts";
import { describeElementType, describeType } from "./type-description.ts";
import { isForTypes, METHOD_INTRINSICS, literals, sourceLocations, boolSelection, ternaryExpansion, writtenMatch, type CoreMatch, type PatternLambda } from "./ast.ts";
import { builtinZero } from "./zero-values.ts";
import { fieldSource, keySource } from "./record-keys.ts";
import doSource from "../lib/std/do.apn" with { type: "text" };
import preludeSource from "../lib/prelude.apn" with { type: "text" };
import { captureSnapshot } from "./snapshot.ts";
import { buildExecutable } from "./compile.ts";
import { standardNative } from "./standard-natives.ts";
import { ACTIONS, MODELED, NATIVE_EXPORTS, NATIVES, RETIRED_NATIVES, STANDARD_NATIVES, TAKES_UNDECIDED } from "./natives.ts";
import { parseLiteral, textNatives } from "./text-natives.ts";
import { bundledText, IMPORT_ONE, loadPath, type ModuleFile, readLoad, resolveModule, sourcePath, unknownModule } from "./modules.ts";
import { CONSTRUCTING_TYPES, TYPE_NAMES, NUMERIC_CLASSES, NUMERIC_TYPES, OWN_SCALAR_TYPES, SCALAR_TYPES, numericWithin, numericType, numericPayload, matchesType, castNumeric, implicitOperands, typedArithmetic, typedPower, numericHash } from "./type-system.ts";
import { isNumeric, numberText, arithmetic, negate, equalNumbers, compareNumbers, numericNative, NUMBER_NATIVES, integer, type Real } from "./numbers.ts";
import { ACTION_SHOWN, APNError, LIST_FIELDS, didYouMean, missingTypeParameters, placeholderError, typeApplied, withArticle } from "./errors.ts";
import type { Expr, Pattern, TopLevel } from "./ast.ts";
import { type Alternative, type Binding, clausePlaces, listRole, readPatterns, listExpansion, listPatternExpansion, rangeExpansion, rangeName, extendedDeclaration, headError, declaresNames, TYPE_RANGE, clauseKey, type DataDef, type Counting, countingOf, flatTypedPattern, mentions, mergeClauses, constructorPattern, listAlternatives, listClauses, listUnion, isUnionBody, unionClause, unionKind } from "./ast.ts";
import type { DefClause, Type, VariantFamily } from "./types.ts";
import { type Value, Env, IOTail } from "./types.ts";
import { enumerationPositions, givesValue, isUse, OPEN, opening } from "./ast.ts";
import { canonicalTypeText, ioTypeText, compoundArgument, slotField, mkInt, mkBool, mkStr, mkList, rangeValue, typeToString, valueToString, rawString } from "./types.ts";
import { argument, functionSource, residualSource } from "./function-source.ts";
import { KEYWORDS, lex } from "./lexer.ts";
import { bindingItem, getPreludeUsed, parse, parseDocument, exprToSource, itemComparisonHint, patternSource, patternVariables, isOperatorName, PRIMITIVE_OPERATORS, DEFAULT_FIXITY, type Fixity, fixitiesOf, getLooseSpacing, preludeFixity, regroup, setLooseSpacing } from "./parser.ts";
import { charLiteral, itemsText, literalKind, spacedItem, stringLiteral } from "./separators.ts";

// ---------------- Evaluator ----------------

// Internal control transfers, caught only by their matching execution loop.
// An item of a list as written (see Interpreter.written).
// runs: an x <- m item, whose names are bound when the code runs (see do);
// joined: the bindings code joined before it gave it when it last ran.
type Written = { expr: Expr; env: Env; binds?: Map<string, Value>; runs?: boolean; joined?: Map<string, Value> };
// Code running item by item: the bindings so far, the names bound
// differently than when the items after were written, and the scope the
// current run of items written in one scope shares.
type CodeState = { before: Map<string, Value>; changed: Set<string>; env?: Env; scope?: Env; running?: Set<string> };

// Natives by name, and the intrinsics (intrinsics.add, ...) as fields of one record.
function bindNatives(env: Env, natives: Iterable<readonly [string, number]>): void {
    const intrinsics: [string, Value][] = [];
    for (const [name, arity] of natives) {
        if (name in RETIRED_NATIVES) continue;
        const value: Value = { kind: "native", name, arity, applied: [] };
        if (name.startsWith("intrinsics.")) intrinsics.push([name.slice("intrinsics.".length), value]);
        else env.setLocal(name, value);
    }
    env.setLocal("intrinsics", { kind: "record", v: intrinsics });
}
const LITERAL_PATTERNS = new Set(["int", "bool", "string", "char", "float"]);
// Written alternatives in the order they are tried, when that does not depend
// on the value (null when it does).
const rankedAlternatives = new WeakMap<object, PatternLambda[] | null>();
class TailCall {
    constructor(readonly body: Expr, readonly env: Env) {}
}
// The record r ++ [...] joins, as the written record's items see it.
const JOINED = "[..]joined";
// A tail use of code (see spliceCode): the code, and the scope it runs over.
class TailLoad {
    constructor(readonly code: Value, readonly env: Env) {}
}


// Operators whose builtin meaning does not demand both operands first.
const LAZY_OPERATORS = new Set(["::", "++", "&&", "||", "$"]);
const stackOverflow = () => new APNError("runtime", "call stack overflow", {
    hint: "unbounded strict recursion? Use a lazy cons tail to produce lists incrementally.",
});
// The values application calls; any other applies as get gives it.
const CALLABLE_KINDS = new Set(["functionType", "contract", "mutable", "type", "closure", "native", "clauseFn"]);

const STACK_LIMIT = 512; // below V8's own JS stack, so APN errors first

// The names editors color as built-in functions (the natives and do).
// The names natives are bound by (each intrinsic is a field of intrinsics).
export const NATIVE_NAMES = new Set(["do", ...NATIVES.map(([name]) => name.split(".")[0])]);
// The types the prelude declares (Vect n a = ..., List a = [] | a :: List a);
// a list union is bound to the list type (see listUnion).
const PRELUDE_TYPES = new Set(["Vect", "List"]);

// The type an ascription was written with: the parser checks a function type's
// value with the typed lambda ((r : T) -> r), so T is its parameter's type.
function ascribedType(check: Expr): Expr {
    return check.t === "patternLambda" && check.params[0].p === "schema" ? check.params[0].type : check;
}
export class Interpreter {
    // Enabled by normal CLI/REPL execution. Foreign name installation
    // and reflected writes must preserve the visible bindings it has checked.
    checkedExecution = false;
    private checking?: CheckingSession;
    // Without checking, a run still infers its program's types, reporting
    // nothing, so that what depends on them (typed list and variant patterns)
    // means the same (see typesOf).
    private typing?: CheckingSession;
    private get types(): CheckingSession | undefined { return this.checking ?? this.typing; }
    private runDepth = 0;
    // Modules being run by an import.
    private moduleDepth = 0;
    private dynamicDepth = 0;

    // A checking session that knows this interpreter's natives and names
    // (apn --check checks with one, without running or reading input).
    checkingSession(): CheckingSession {
        const session = new CheckingSession();
        session.moduleSources = this.moduleSources;
        session.runtimeNames = () => envNames(this.env);
        return session;
    }
    enableChecking(): void {
        this.checkedExecution = true;
        this.checking = this.checkingSession();
        // Checking right before running may read the program's input; the run
        // then sees the same file contents and arguments.
        this.checking.inputs = {
            readFile: path => this.inputFile(path), args: () => this.programArgs,
            // Interactive input is never read ahead of the program.
            readStdin: () => Deno.stdin.isTerminal() ? undefined : this.inputStdin(),
        };
    }
    // A run's types, inferred as checking would, its type errors unreported
    // (the program then runs as far as it can): the scope to commit, if any.
    private typesOf(program: TopLevel[]): TypeScope | undefined {
        this.typing ??= this.checkingSession();
        try { return this.typing.prepare(program, this.sourceDir); }
        catch (error) {
            if (error instanceof APNError) return undefined;
            throw error;
        }
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
        // A browser build reads the text files it bundled, by the path the program names.
        if (this.moduleSources) return bundledText(this.moduleSources, path);
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
    // A file the build bundled, by the path the program names, as a URL the page can load.
    assetUrl?: (path: string) => string | undefined;
    programArgs: string[] = [];
    // Colors rendered text by its kind, for echo on a terminal (see repl.ts).
    paint?: (text: string, kind?: Value["kind"] | "key" | "code") => string;
    // The REPL loop repl runs (see session): the command line's (repl.ts).
    interactive?: () => void;
    // The outermost run's program and the statement it is running.
    private running?: { program: TopLevel[]; index: number };
    // A bundle (a browser build) to import from instead of the disk: virtual
    // paths to sources (see bundleProgram in modules.ts).
    moduleSources?: Record<string, string>;
    private modules = new Map<string, Value>();
    private importing = new Set<string>();

    // The records import and load yield are modules: nothing opens one but
    // use, which publishes its names as the module's (its origin, and whether
    // the static check typed them).
    private moduleValues = new WeakMap<Value, { origin?: string; checked?: boolean }>();
    // An operator's fixity travels with its value: a program's declaration
    // marks the value it binds, which use, an alias or added clauses keep.
    private valueFixities = new WeakMap<Value, Fixity>();
    // The fixities the source running now declares (see fixitiesOf).
    private runningFixities?: Map<string, Fixity>;
    private valueFixity(op: string): Fixity {
        return this.fixityOfValue(this.env.get(op)) ?? preludeFixity(op) ?? DEFAULT_FIXITY;
    }
    private fixityOfValue(value: Value | undefined): Fixity | undefined {
        for (let v = value, seen = 0; v && seen < 64; seen++) {
            const fixity = this.valueFixities.get(v);
            if (fixity) return fixity;
            const next: Value | undefined = v.kind === "thunk" || v.kind === "deferred" ? this.reference(v) : v.kind === "clauseFn" ? v.fallback : undefined;
            if (next === v) break;
            v = next;
        }
        return undefined;
    }
    private regrouped(e: Expr): Expr { return regroup(e, op => this.valueFixity(op)); }
    // Whether a name is a built-in type here: one of TYPE_NAMES that the scope
    // still binds to it (a program's own Int, shadowing it, is its own).
    private builtinType(name: string, scope: Env = this.env): boolean {
        if (!TYPE_NAMES.includes(name)) return false;
        const bound = scope.get(name);
        if (!bound || this.loadingPrelude) return true;
        if (PRELUDE_TYPES.has(name)) return bound === this.preludeBindings.get(name);
        return bound.kind === "type" && bound.name === name && !bound.family;
    }
    private namedTypes = new WeakMap<Value, Value>();
    // typeOf a list: the list of its items' types, made as it is read ([1,"a"]
    // gives [Int,String]); an endless one repeats its type ([1..] gives
    // [Int..], as does ones = 1 :: ones, its cells met again).
    private itemTypes(list: Value, made = new Map<Value, Value>()): Value {
        let first: Value | undefined, last: Extract<Value, { kind: "cons" }> | undefined;
        const link = (next: Value): Value => { if (last) last.tail = next; else first = next; return first!; };
        // Along the cells already made, at once (so a list that is its own tail
        // gives one); a tail still to compute is typed when it is read.
        for (let rest = list; ;) {
            checkInterrupt();
            const ready = (x: Value | undefined): boolean => !!x && (!(x.kind === "thunk" || x.kind === "deferred") || x.value !== undefined
                || x.kind === "thunk" && x.body.t === "var" && ready((x.env ?? this.env).get(x.body.name))
                || x.kind === "deferred" && ready(x.describes));
            const pending = !ready(rest);
            if (pending && last) { const tail = rest; return link(this.defer(() => this.itemTypes(tail, made))); }
            const spine = this.force(rest);
            const known = made.get(spine);
            if (known) return link(known);
            if ((spine.kind === "range" || spine.kind === "floatRange" || spine.kind === "rationalRange") && spine.hi === null) {
                const repeated: Extract<Value, { kind: "cons" }> = { kind: "cons", head: this.callNative("typeOf", [this.cell(spine)!.head]), tail: mkList([]) };
                repeated.tail = repeated;
                return link(repeated);
            }
            const cell = this.cell(spine);
            if (!cell) return link(mkList([]));
            const head = cell.head, out: Extract<Value, { kind: "cons" }> = { kind: "cons", head: this.defer(() => this.callNative("typeOf", [head])), tail: mkList([]) };
            made.set(spine, out);
            link(out);
            last = out;
            rest = cell.tail;
        }
    }
    // A definition names the type it gives, whatever its name's case: a scalar
    // type names a subtype (Money = Float: a Float wherever one is accepted,
    // keeping its name, and (x : Money) takes a Money or a Float it converts);
    // so does a refinement of one (Int32 = (n : Int) | ...), its values the
    // refinement's; another type remembers it (see remembered). A list or
    // record of types is named where written as one (Point = [x : Float]), not
    // computed (ts = t :: ts), whose values are data first.
    private namedValue(name: string, value: Value, body: Expr): Value {
        while (body.t === "block" && body.stmts.length === 1) body = body.stmts[0];
        // Written as types: names of types, types applied, lists and records of them.
        const writtenType = (e: Expr): boolean => e.t === "var" ? /^[A-Z]/.test(e.name) : e.t === "placeholder" ? true
            : e.t === "app" ? writtenType(e.f) : e.t === "list" ? e.v.every(writtenType) : e.t === "record" ? e.v.every(([, x]) => writtenType(x))
            : e.t === "block" && e.stmts.length === 1 ? writtenType(e.stmts[0]) : false;
        if (value.kind !== "type" && !((body.t === "record" || body.t === "list") && writtenType(body))) return value;
        if (value.kind === "type" && OWN_SCALAR_TYPES.has(value.name) && !value.family && !value.alias && !value.arguments?.length && !value.variable) {
            return { kind: "type", name, family: { name, base: value } };
        }
        if (value.kind === "type" && value.refine && this.scalarRefinement(value)) {
            return { kind: "type", name, family: { name, base: { ...value, name } } };
        }
        return this.remembered(name, [], value);
    }
    // Whether a refinement's base is a scalar type (through refinements and
    // named subtypes): naming one names a subtype.
    private scalarRefinement(t: Value): boolean {
        for (let base = t; ; ) {
            base = this.reference(base);
            if (base.kind !== "type") return false;
            if (base.refine) { base = base.choices![0]; continue; }
            if (base.family?.base) { base = base.family.base; continue; }
            return OWN_SCALAR_TYPES.has(base.name) && !base.family && !base.alias && !base.arguments?.length && !base.variable;
        }
    }
    // (p : T), T a refinement: the value as its base's pattern takes it
    // (converted: (c : Scalar) takes 65 as (c : UInt) does), its condition
    // holding, then p.
    private refinedPattern(type: Extract<Value, { kind: "type" }>, p: Pattern, v: Value, binds: Map<string, Value>): boolean {
        const member = this.refinedMember(type, v);
        return member !== undefined && this.matchPattern(p, member, binds);
    }
    private refinedMember(type: Value, v: Value): Value | undefined {
        if (type.kind === "type" && type.refine) {
            let member = this.refinedMember(this.reference(type.choices![0]), v);
            // A constructor's type converts another value as its to instance
            // declares (to (Money Float) (x : Float) = Money x).
            if (member === undefined && type.made) { const made = this.declaredConversion(type, v); if (made) member = this.dataValue(made); }
            return member !== undefined && this.truthy(this.demand(this.apply(type.refine, member))) ? member : undefined;
        }
        try { return this.conform(type, v); } catch (error) { if (error instanceof APNError) return undefined; throw error; }
    }
    /** Whether a value is a module's record (what import and load yield). */
    isModule(v: Value): boolean { return this.moduleValues.has(v); }
    // Text readFileFrom read: its file, and whether the static check could
    // follow it (read outside Dynamic, while checking).
    private sourcePaths = new WeakMap<Value, { path: string; checked: boolean }>();
    // Code parse made from a file's text: the file's folder, which reads in
    // the code (a load there) are beside.
    private codeDirs = new WeakMap<Env, string>();
    private codeSources = new WeakMap<Value, string>();
    private runningDir(): string {
        for (let e: Env | null = this.env; e; e = e.parent) { const dir = this.codeDirs.get(e); if (dir !== undefined) return dir; }
        return this.sourceDir;
    }
    // Source text as code: its statements as items, written in the scope parse
    // runs in. Text a readFileFrom read keeps its file: errors name it, and the
    // code is that file's module (use publishes its names as the file's).
    private parseCode(source: Extract<Value, { kind: "string" }>): Value {
        const file = this.sourcePaths.get(source);
        let program: TopLevel[];
        try { program = parse(source.v, file?.path ?? "<parse>"); }
        catch (err) { throw err instanceof APNError ? err : new APNError("parse", (err as Error).message); }
        const scope = new Env(this.env);
        if (file) this.codeDirs.set(scope, dirname(file.path));
        const code = this.codeList(this.statementItems(program), scope);
        if (file) {
            this.moduleValues.set(code, { origin: `${file.path}\0${source.v}`, checked: file.checked });
            this.codeSources.set(code, dirname(file.path));
        }
        return code;
    }

    importStandard(module: string): Value {
        // The static check follows an import outside Dynamic, so it typed what
        // the module's bindings replace (its step over the debugger's). A
        // module's own imports are checked where the check uses that module.
        const checked = !!this.checking && !this.dynamicDepth && !this.moduleDepth;
        if (checked) this.checking!.module(module, this.sourceDir);
        return this.importModule(module, this.sourceDir);
    }
    // The module spec names from directory, imported once.
    private importModule(module: string, directory: string): Value {
        const resolved = resolveModule(module, directory, this.moduleSources, this.moduleRoot);
        if (!resolved) { const { message, hint } = unknownModule(module, !!this.moduleSources); throw new APNError("runtime", message, { hint }); }
        let value: Value | undefined = this.modules.get(resolved.key);
        if (!value) {
            if (this.importing.has(resolved.key)) throw new APNError("runtime", `cyclic import '${module}'`);
            this.importing.add(resolved.key);
            try {
                // A file's value, or the record of a folder's entries, each a
                // module imported now (once per interpreter, however many import it).
                // (The folder's record is there while its entries run, each
                // imported when first read: an entry importing the folder reads
                // the others it uses, std/glsl its std.text.)
                if (resolved.files.length) value = this.runModuleFile(resolved.files[0]);
                else {
                    const entries = resolved.entries.map(entry => [entry.name, this.defer(() => this.importModule(entry.spec, entry.directory))] as [string, Value]);
                    const folder: Value = { kind: "record", v: entries };
                    this.modules.set(resolved.key, folder);
                    // (Imported by one of its own entries, it imports each when
                    // first read: another may need the one being imported.)
                    const running = [...this.importing].some(key => key !== resolved.key && key.startsWith(resolved.key));
                    // (Each imported as itself, so one read back while it is
                    // imported is a cyclic import, not a value awaiting itself.)
                    try { if (!running) for (const entry of resolved.entries) this.importModule(entry.spec, entry.directory); }
                    catch (error) { this.modules.delete(resolved.key); throw error; }
                    value = folder;
                }
                this.modules.set(resolved.key, value);
                this.moduleValues.set(value, { origin: resolved.key });
            } finally { this.importing.delete(resolved.key); }
        }
        return value;
    }
    // load "file": run file.apn beside the running file in a scope of its own,
    // again each time, yielding its value.
    // Its last statement's action is the load's tail (an IOTail runIO goes on
    // with), so a file loading itself last loops in constant stack, as a
    // function calling itself last does.
    private runFile(name: string, directory = this.runningDir()): Value {
        const path = sourcePath(name, directory, this.moduleSources);
        const source = this.moduleSources ? readLoad(path, this.moduleSources) : (() => { try { return Deno.readTextFileSync(path); } catch { return undefined; } })();
        if (source === undefined) {
            throw new APNError("runtime", this.moduleSources ? `'${name}' is not bundled` : `load: cannot read '${name}' (looked in '${path}')`,
                this.moduleSources ? { hint: "a browser build bundles only files inside the program's folder" } : {});
        }
        // (Its names publish by use as a module's do, from this file's text.)
        let value: Value | IOTail;
        try { value = this.runModuleFile({ source, label: path, directory: dirname(path) }, true); }
        catch (error) { throw error instanceof RangeError ? stackOverflow() : error; }
        if (value instanceof IOTail) return value as unknown as Value;
        this.moduleValues.set(value, { origin: `${path}\0${source}`, checked: !!this.checking && !this.dynamicDepth });
        return value;
    }

    // Run one module file against builtins only (never the caller's bindings):
    // its value is its last statement's ([] when that binds).
    private runModuleFile(file: ModuleFile): Value;
    private runModuleFile(file: ModuleFile, tail: true): Value | IOTail;
    private runModuleFile(file: ModuleFile, tail = false): Value | IOTail {
        const caller = this.env;
        const callerDir = this.sourceDir;
        const builtins = new Env();
        for (const type of TYPE_NAMES) if (!PRELUDE_TYPES.has(type)) builtins.setLocal(type, { kind: "type", name: type });
        bindNatives(builtins, [...NATIVES, ...STANDARD_NATIVES]);
        for (const [name, value] of this.preludeBindings) builtins.setLocal(name, value);
        const scope = new Env(builtins);
        try {
            const program = parse(file.source, file.label);
            this.env = scope;
            this.sourceDir = file.directory;
            this.runDepth++; this.moduleDepth++;
            const last = program[program.length - 1];
            try {
                // (A tail's action runs after the file returns, in the scope its closures keep.)
                if (tail && givesValue(last)) {
                    this.run(program.slice(0, -1));
                    const value = this.demand(this.eval(last.value));
                    return value.kind === "io" || value.kind === "pending" ? new IOTail(value) : value;
                }
                const value = this.run(program);
                return givesValue(last) ? value : mkList([]);
            } finally { this.runDepth--; this.moduleDepth--; }
        } finally {
            this.env = caller;
            this.sourceDir = callerDir;
        }
    }

    env = new Env();
    // The program's top-level scope, where eval runs.
    programEnv!: Env;
    stack = 0;
    // Directory of the source file currently being evaluated — `load` resolves
    // relative paths against it ("relative to your current file").
    sourceDir: string = ".";
    // The program's folder, where import stops searching parent folders.
    moduleRoot?: string;
    sourceFile = "<repl>";

    constructor() {
        for (const name of TYPE_NAMES) if (!PRELUDE_TYPES.has(name)) this.env.setLocal(name, { kind: "type", name });
        bindNatives(this.env, NATIVES);
        const outer = this.env;
        this.env = new Env(outer);
        this.env.setLocal("fail", { kind: "native", name: "fail", arity: 1, applied: [] });
        // Without the prelude (apn --no-prelude) a program has only the intrinsics.
        if (getPreludeUsed()) {
            // A native the prelude defines (see MODELED) runs as itself: its
            // definition, which the checker reads, is not run, so it neither
            // binds the name nor joins the native; typeOf describes it.
            const prelude = parseDocument(preludeSource);
            const modeled = (s: TopLevel): s is Extract<TopLevel, { t: "def" }> => s.t === "def" && MODELED.has(s.name);
            this.run(prelude.filter(s => !modeled(s)));
            const intrinsics = this.env.get("intrinsics") as Extract<Value, { kind: "record" }>;
            for (const [name, native] of MODELED) {
                const clauses = prelude.filter(modeled).filter(s => s.name === name).flatMap(s => s.clauses);
                if (!clauses.length) continue;
                const scope = new Env(this.env);
                const definition: Value = { kind: "clauseFn", name, clauses, arity: clauses[0].params.length, env: scope, applied: [] };
                scope.setLocal(name, definition);
                this.modeledDefinitions.set(native, definition);
                if (native !== name) this.env.setLocal(name, intrinsics.v.find(([key]) => `intrinsics.${key}` === native)![1]);
            }
            // Bind each operator to its value itself, so evaluation finds the intrinsic.
            // (fail, which marks code still to write, is the prelude's too.)
            for (const [name, value] of this.env.bindings()) this.preludeBindings.set(name, this.reference(value));
            this.run(parse(doSource));
            this.preludeBindings.set("do", this.env.get("do")!);
        }
        this.loadingPrelude = false;
        this.env = this.programEnv = outer;
        for (const [name, value] of this.preludeBindings) outer.setLocal(name, value);
        this.initialBindings = new Map(outer.map);
        this.initialInstances = new Map([...this.instances].map(([method, fns]) => [method, fns.length]));
    }
    // What the interpreter starts with (its natives, types and prelude), and its
    // instances then: compile carries only what a program adds (see snapshot.ts).
    initialBindings = new Map<string, Value>();
    private initialInstances = new Map<string, number>();
    addedInstances(): Array<[string, Value[]]> {
        return [...this.instances].map(([method, fns]): [string, Value[]] => [method, fns.slice(this.initialInstances.get(method) ?? 0)]).filter(([, fns]) => fns.length);
    }
    addInstance(method: string, fn: Value): void {
        this.registerInstance(method, fn, fn.kind === "clauseFn" ? fn.clauses : []);
    }

    // A type declaration (Color = Red | Green), at the top level or in a block,
    // declared for its whole scope (scope), as a new name is. A union of
    // existing types is a definition instead: the value it makes.
    private declare(def: DataDef, scope: Env): Value | undefined {
        def = listAlternatives(def, tag => listRole(this.binding(tag)));
        if (listUnion(def)) { scope.setLocal(def.name, { kind: "type", name: "List" }); return undefined; }
        if (def.variants.some(v => v.result && (v.tag === "[]" || v.tag === "::"))) return this.evalDef(def.name, listClauses(def.variants));
        // Constructors declared into a type declared before join it.
        if (def.extends) {
            const bound = this.env.get(def.name), type = bound && this.reference(bound);
            const into = type?.kind === "type" && type.family && this.declarations.get(type.family);
            if (into) def = extendedDeclaration(into, def);
        }
        const written = def, kind = def.extends ? "declaration" : unionKind(def, name => this.alternative(name, written.name));
        if (kind === "union") return this.evalDef(def.name, [unionClause(def)]);
        if (kind !== "declaration") throw new APNError("runtime", kind);
        // A type is declared for its whole scope, as a new name is.
        for (const name of [def.name, ...def.variants.map(v => v.tag)]) {
            const previous = this.scopeBinding(name);
            if (previous && ((previous.kind === "native" && previous.tag) || previous.kind === "variant") && previous.family?.name !== def.name) {
                throw new APNError("runtime", `cannot redeclare value constructor ${name}; it belongs to ${previous.family?.name}`);
            }
        }
        const results = new Map(def.variants.flatMap(v => v.result ? [[v.tag, v.result] as [string, Expr]] : []));
        const family = { name: def.name, parameters: def.parameters ?? [], fields: new Map(def.variants.map(v => [v.tag, v.fields ?? []])), env: new Env(this.env), ...results.size ? { results } : {} };
        scope.setLocal(def.name, { kind: "type", name: def.name, family });
        this.declarations.set(family, def);
        for (const v of def.variants) {
            if (v.arity === 0) {
                // Nullary constructors are themselves the value.
                scope.setLocal(v.tag, { kind: "variant", tag: v.tag, v: [], family });
            } else {
                // A constructor with logic runs it when applied; its _
                // makes the raw value (see ConstructorLogic).
                const logic = v.logic && { kind: "clauseFn" as const, name: v.tag, clauses: v.logic.clauses, arity: v.arity, env: family.env, applied: [] };
                scope.setLocal(v.tag, {
                    kind: "native", name: "__constr", arity: v.arity, applied: [], tag: v.tag, family,
                    ...logic ? { invoke: (args: Value[]) => args.reduce<Value>((f, arg) => this.apply(f, arg), logic) } : {},
                });
            }
        }
        for (const name of [def.name, ...def.variants.map(v => v.tag)]) family.env.setLocal(name, this.env.get(name)!);
        const positions = enumerationPositions(def);
        if (positions) this.evalDef("to", positions);
        return undefined;
    }

    // A file (file) is a block run once: as in a block, a statement that binds
    // nothing is an action, the last one too once one ran; a REPL input's last
    // value is shown instead. A load runs a file.
    run(program: TopLevel[], tailLoad = false, file = tailLoad): Value {
        // The outermost run's folder is the program's: imports search up to it.
        if (!this.runDepth && !this.dynamicDepth) this.moduleRoot = this.sourceDir;
        // Each checked top-level run takes a fresh input snapshot.
        if (this.checking && !this.runDepth && !this.dynamicDepth) this.inputFiles.clear();
        const top = !this.runDepth && !this.dynamicDepth;
        const candidate = this.checking && top ? this.checking.prepare(program, this.sourceDir, this.sourceDir, file) : undefined;
        const inferred = !this.checking && top && !this.loadingPrelude ? this.typesOf(program) : undefined;
        // A check may decide more expressions' monads (see checkedMonad).
        if (top && this.types) this.checkedHeads = new WeakMap();
        // A failed run leaves the scope as it was: its definitions and versions.
        const savedEnv = this.env, root = this.env.root(), saved = candidate ? new Map(root.map) : undefined;
        let succeeded = false;
        this.runDepth++;
        const fixities = this.runningFixities;
        this.runningFixities = fixitiesOf(program) ?? fixities;
        try {
            let last: Value = { kind: "list", v: [] }, ran = false;
            for (const [index, written] of program.entries()) {
                if (this.runDepth === 1 && !this.dynamicDepth) this.running = { program, index };
                const tl = written;
                this.readPatterns(tl);
                if (tl.t === "type") {
                    last = this.declare(tl.def, this.env.root()) ?? last;
                    continue;
                }
                if (tl.t === "def") {
                    // An operator's fixity is its value's: declared here, or kept by clauses added to it.
                    const kept = isOperatorName(tl.name) ? this.fixityOfValue(this.env.get(tl.name)) : undefined;
                    last = this.evalDef(tl.name, tl.clauses);
                    const fixity = fixitiesOf(program)?.get(tl.name) ?? kept;
                    if (fixity) { const bound = this.env.get(tl.name); if (bound) this.valueFixities.set(bound, fixity); }
                    continue;
                }
                if (tl.t === "patDef") {
                    if (tl.eager) ran = true;
                    last = this.evalPatBinding(tl);
                    continue;
                }
                // a bare expression statement: 0-arg functions and thunks RUN here
                const tail = tailLoad && index === program.length - 1;
                const value = this.eval(tl.value, tail);
                this.ranAction = false;
                last = this.runStmt(value, tail, index < program.length - 1 || file && ran ? tl.value : undefined);
                ran = true;
                this.adoptPublished();
            }
            succeeded = true;
            return last;
        } finally {
            this.runDepth--;
            this.runningFixities = fixities;
            if (!succeeded && saved) {
                this.env = savedEnv;
                root.map.clear();
                for (const [name, value] of saved) root.map.set(name, value);
            }
            if ((candidate || inferred) && succeeded) {
                const visible = new Set<string>();
                for (let scope: Env | null = this.env; scope; scope = scope.parent) for (const name of scope.map.keys()) visible.add(name);
                this.types!.commit(candidate ?? inferred!, visible);
            }
        }
    }

    // A REPL session (repl) on the names visible where it runs, a function's
    // own among them: its chunks are top-level runs in that scope, and what
    // they bind stays in the session. A top-level name as the running
    // statement has it is checked against the program's types there; any
    // other name (a local, or an older version a function sees) by its value
    // (see sessionNames).
    private session(loop: () => void): void {
        const caller = this.env, roots = [...new Set([caller.root(), this.programEnv])];
        const saved = roots.map(root => ({ root, names: new Map(root.map), newest: root.newest }));
        const { runDepth, dynamicDepth, running } = this;
        const { visible, locals } = this.sessionNames(caller);
        const leave = this.checking && running ? this.checking.enter(running.program, running.index, this.sourceDir, visible, locals) : undefined;
        this.runDepth = this.dynamicDepth = 0;
        try {
            loop();
        } finally {
            this.runDepth = runDepth; this.dynamicDepth = dynamicDepth;
            this.running = running; this.env = caller;
            leave?.();
            for (const { root, names, newest } of saved) {
                root.map.clear();
                for (const [name, value] of names) root.map.set(name, value);
                root.newest = newest;
            }
        }
    }

    // The names a session sees from env: visible, those bound as at the top
    // level now (typed statically), and locals, each with the source of its
    // value when that is finite data already evaluated (typed exactly, as
    // that literal) or null (Dynamic: what it cannot know is checked at run
    // time). Nothing is forced: a session computes nothing to start.
    private sessionNames(env: Env): { visible: Set<string>; locals: Map<string, string | null> } {
        const top = this.live(this.programEnv), visible = new Set<string>(), locals = new Map<string, string | null>();
        for (let scope: Env | null = env; scope; scope = scope.parent) for (const [name, value] of scope.map) {
            if (visible.has(name) || locals.has(name)) continue;
            if (top.get(name) === value) visible.add(name);
            else if (/^[a-z_][A-Za-z0-9_']*$/.test(name)) locals.set(name, this.dataSource(value) ?? null);
        }
        return { visible, locals };
    }

    // A value as the literal that writes it, when it is data that is already
    // evaluated (or a literal not evaluated yet, such as an argument 3) and
    // that literal means the same value: a list item written as other code
    // ([1 + 1]), a typed record, or a constructor the scope names differently
    // is not. A range stays one ([1..]). Nothing is evaluated or rendered.
    private dataSource(value: Value): string | undefined {
        let budget = 10_000;
        const literal = (e: Expr): boolean => ["int", "float", "bool", "string", "char", "numeric"].includes(e.t)
            || e.t === "range" && [e.lo, e.second, e.hi].every(x => !x || literal(x))
            || e.t === "list" && e.v.every(literal) || e.t === "record" && e.v.every(([, x]) => literal(x));
        const evaluated = (v: Value): Value | undefined => {
            while (v.kind === "thunk" || v.kind === "deferred" || v.kind === "lazyList") {
                if (v.value === undefined) return undefined;
                v = v.value;
            }
            return v;
        };
        // An argument with a space in it is parenthesized: Some (UInt8 3).
        const argument = (text: string) => /\s/.test(text) && !/^[[("']/.test(text) ? `(${text})` : text;
        const source = (item: Value): string | undefined => {
            if (--budget < 0) return undefined;
            const v = evaluated(item);
            if (!v) return item.kind === "thunk" && literal(item.body) ? exprToSource(item.body) : undefined;
            const text = shape(v);
            const written = this.written(item);
            return text !== undefined && (!written || !written.binds && !written.runs && exprToSource(written.expr) === text) ? text : undefined;
        };
        const items = (values: Value[]): string | undefined => {
            const texts = values.map(source);
            return texts.every(text => text !== undefined) ? `[${itemsText(texts as string[])}]` : undefined;
        };
        const shape = (v: Value): string | undefined => {
            switch (v.kind) {
                case "int": case "float": case "rational": case "complex": case "bool": case "string": case "char": return valueToString(v);
                case "range": return v.hi === null || (v.hi - v.lo) / v.step < 10_000n ? valueToString(v) : undefined;
                case "list": return v.schema ? undefined : items(v.v);
                case "cons": {
                    const values: Value[] = [];
                    let rest: Value | undefined = v;
                    for (; rest?.kind === "cons" && values.length < 10_000; rest = evaluated(rest.tail)) values.push(rest.head);
                    return rest?.kind === "list" && !rest.schema ? items([...values, ...rest.v]) : undefined;
                }
                case "record": {
                    if (v.shared || !v.v.length || this.declaredTypes.has(v)) return undefined;
                    const fields = v.v.map(([key, x]) => [key, source(x)] as const);
                    return fields.every(([, text]) => text !== undefined) ? `[${fields.map(([key, text]) => fieldSource(key, text!, true)).join(", ")}]` : undefined;
                }
                case "variant": {
                    const named = this.programEnv.get(v.tag), args = v.v.map(source);
                    if (!named || !(named.kind === "variant" || named.kind === "native") || named.family !== v.family) return undefined;
                    return args.every(text => text !== undefined) ? [v.tag, ...(args as string[]).map(argument)].join(" ") : undefined;
                }
                default: return undefined;
            }
        };
        return source(value);
    }

    // Bind names as Haskell's values are bound: a value never changes. A name
    // not visible here is defined for its whole scope (code above may use it;
    // its definition may use itself). One visible here is rebound: a new
    // version from here on, so what was written before keeps the one it saw.
    private bindNames(bindings: Iterable<[string, Value]>): void {
        const rebound: [string, Value][] = [];
        for (const [name, value] of bindings) {
            if (this.env.get(name) === undefined) this.env.root().setLocal(name, value);
            else rebound.push([name, value]);
        }
        if (!rebound.length) return;
        const next = new Env(this.env, true);
        for (const [name, value] of rebound) next.setLocal(name, value);
        this.env.root().newest = next;
        this.env = next;
    }
    // A scope as eval sees it: its newest version.
    private live(scope: Env): Env {
        return scope.root().newest ?? scope;
    }
    // The binding name has in this scope (any of its versions), if any.
    private scopeBinding(name: string): Value | undefined {
        return this.env.bindings().get(name);
    }

    evalDef(name: string, clauses: DefClause[]): Value {
        if (/^[A-Z]/.test(name)) {
            // An existing constructor destructures (Some x = Some 1); each
            // clause is a binding of its own.
            if (this.isConstructorName(name)) {
                let last: Value = { kind: "list", v: [] };
                for (const clause of clauses) last = this.evalPatBinding({ pattern: constructorPattern(name, clause.params, this.binding(name).kind === "cons"), value: clause.body });
                return last;
            }
            const arity = clauses[0].params.length;
            if (clauses.some(c => c.params.length !== arity)) throw new APNError("runtime", `every clause of ${name} takes ${arity} parameters`);
            // One whose length its index makes (Vect Z a = [], Vect (S k) a =
            // a :: Vect k a) is known by that length (see countingOf); those
            // counting n are one type, Vect.
            const counts = countingOf(name, clauses);
            if (counts) {
                const type: Value = { kind: "type", name: counts.scale === 1n && !counts.offset ? "Vect" : name, counts };
                this.bindNames([[name, type]]);
                return type;
            }
            if (arity && clauses.length > 1 && !clauses[0].params.length) throw new APNError("runtime", `${name} is defined twice`);
            const scope = new Env(this.env);
            // A capitalized function (Pairs n a = Vect (n * 2) a): its clauses
            // run as a function's do.
            const alias: Value = arity
                ? { kind: "type", name, alias: { parameters: clauses[0].params.map((p, n) => p.p === "var" ? p.name : `$${n}`),
                    run: { kind: "clauseFn", name, clauses, arity, env: scope, applied: [] } } }
                : this.defer(() => {
                    const caller = this.env;
                    this.env = scope;
                    try {
                        // = names the value. A lambda is a value: applied, it runs
                        // (Sized 2 is Vect 2 Int); where a type is expected, it
                        // reads as a function type.
                        return this.namedValue(name, this.reference(this.eval(clauses[0].body)), clauses[0].body);
                    } finally { this.env = caller; }
                });
            scope.setLocal(name, alias);
            this.bindNames([[name, alias]]);
            return alias;
        }
        const joined = this.travelling(name, clauses);
        if (joined) return joined;
        // Existing collections interpret the parameter as a key expression;
        // unbound/function names retain ordinary pattern-clause definitions.
        const previous = this.env.get(name);
        if (previous !== undefined && clauses[0].params.length > 0 &&
            previous.kind !== "clauseFn" && previous.kind !== "native" &&
            !(previous.kind === "closure" && previous.params.length > 0) &&
            !(previous.kind === "thunk" && previous.body.t === "placeholder")) {
            let collection = this.dataValue(previous);
            // Another value is assigned to when clauses for with give it slots.
            if (collection.kind === "record" || collection.kind === "hashmap" || this.isList(collection) || !CALLABLE_KINDS.has(collection.kind) && this.extended("with")) {
                for (const clause of clauses) {
                    if (clause.params.length !== 1) throw new APNError("runtime", "collection assignment needs one index or field name");
                    const key = this.dataValue(this.eval(this.assignmentKey(clause.params[0])));
                    collection = this.assigned(collection, key, clause.body);
                    this.bindNames([[name, collection]]);
                }
                return collection;
            }
        }
        // A def with parameters is a pattern-dispatch function.
        if (clauses[0].params.length >= 1) {
            const arity = clauses[0].params.length;
            // More clauses for a function of this scope extend it (an
            // equivalent one rebinds its clause), wherever they are defined.
            const extended = previous?.kind === "clauseFn" && previous.arity === arity && this.scopeBinding(name) === previous;
            const scope = this.env;
            clauses = mergeClauses(name, extended ? previous.clauses : [], clauses, c => this.clauseHead(c, scope));
            // Capture a shared env containing the binding itself, enabling recursion.
            const child = new Env(this.env);
            // Clauses for a function this scope binds otherwise (get =
            // intrinsics.get, then get True a = ...) extend it: its meaning
            // still applies to arguments no clause matches. Redefining the
            // clauses in the same scope keeps that fallback.
            const overloaded = previous === undefined || this.scopeBinding(name) !== previous || this.knownArity(previous) !== arity ? undefined
                : previous.kind === "clauseFn" ? previous.fallback : previous;
            const fn: Value = {
                kind: "clauseFn", name, clauses, arity, env: child, applied: [], ...overloaded ? { fallback: overloaded } : {},
            };
            child.setLocal(name, fn);
            this.bindNames([[name, fn]]);
            return fn;
        }
        // Value-style def: single clause, no params.
        const value = clauses[0].body;
        // Lambda bodies become closures (with recursion via shared env), like before.
        if (value.t === "lambda") {
            const child = new Env(this.env);
            const clo: Value = { kind: "closure", params: value.params, body: value.body, env: child };
            child.setLocal(name, clo);
            this.bindNames([[name, clo]]);
            return clo;
        }
        // An ACTION body (a block, an application, or a pipe — with or without
        // {}s, `f = print "hi"` == `f = { print "hi" }`) declares a 0-arg
        // FUNCTION: nothing runs at the definition, expression position yields
        // the function itself, statement position CALLS it (the bare name runs).
        // As for a thunk below: a rebinding reads the version before it
        // (xs = map f xs), a new name itself.
        if (value.t === "block" || value.t === "app" || value.t === "pipe") {
            const child = new Env(this.env);
            const clo: Value = { kind: "closure", params: [], body: value, env: child, names: name };
            if (this.env.get(name) === undefined) child.setLocal(name, clo);
            this.bindNames([[name, clo]]);
            return clo;
        }
        // Otherwise it's a lazy value binding: a THUNK. The body is not run at
        // definition time. Forcing memoizes the outer value across aliases and
        // arguments; lazy container components retain their own thunks.
        // A rebinding's right side reads the version before it (count = count + 1);
        // a new name's reads itself (ones = 1 :: ones).
        // A type it gives is named, as by any definition (see namedValue).
        const thunk: Value = { kind: "thunk", body: value, env: this.env, value: undefined, names: name };
        if (this.env.get(name) === undefined) this.env.root().setLocal(name, thunk);
        else this.bindNames([[name, thunk]]);
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
            // A typed pattern reads as the ascription it was written as: (i : Int32).
            case "typeBind": return { t: "app", f: { t: "var", name: pattern.name }, a: this.assignmentKey(pattern.value), ascribed: true };
            case "schema": return { t: "app", f: pattern.type, a: this.assignmentKey(pattern.value), ascribed: true };
            case "constr": {
                const args = pattern.typed ? pattern.args.slice(0, -1) : pattern.args;
                const head = args.reduce<Expr>((f, arg) => ({ t: "app", f, a: this.assignmentKey(arg) }), { t: "var", name: pattern.tag });
                return pattern.typed ? { t: "app", f: head, a: this.assignmentKey(pattern.args[pattern.args.length - 1]), ascribed: true } : head;
            }
            default: throw new APNError("runtime", "collection assignment needs an index expression, not a destructuring pattern");
        }
    }

    // A field's new value, as its old one requires: every field has a type,
    // what it holds. Holding a type, it is given a type (its type changes; a
    // Type field takes it as its value) or a value converted to it, a default
    // of that type (Vector3.x = 1 is x: Float 1). Holding a value, it is given
    // one of that value's type: a number converted losslessly, a string,
    // character or Bool of its kind, a function.
    private assignSlot(slot: Value, value: Value, bound = false): Value {
        // Inspect the old slot without invoking an action stored there.
        slot = this.force(slot);
        if (!bound && this.holdsType(slot)) return this.holdsType(value) ? value : this.applyTemplateSlot(slot, value);
        const mismatch = (): never => {
            const source = this.renderString(this.callNative("typeOf", [value]));
            throw new APNError("runtime", `cannot use ${source} where ${this.renderString(this.callNative("typeOf", [slot]))} is required`);
        };
        if (["string", "char", "bool"].includes(slot.kind) && this.dataValue(value).kind !== slot.kind) mismatch();
        const callable = (v: Value) => v.kind === "closure" ? v.params.length > 0 : ["clauseFn", "native", "contract"].includes(v.kind);
        if (callable(slot) && !callable(this.force(value)) || slot.kind === "io" && this.force(value).kind !== "io") mismatch();
        if (isNumeric(slot)) {
            const data = this.dataValue(value);
            if (!isNumeric(data)) mismatch();
            return this.constructType(numericType(slot), data);
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
        // An overload of the function (an imported operator's clauses) extends it.
        const base = value.kind === "clauseFn" && value.fallback ? this.force(value.fallback) : undefined;
        if (base && (base === old || base.kind === "native" && old.kind === "native" && base.name === old.name &&
            !base.applied.length && !old.applied.length)) return value;
        if (["closure", "clauseFn", "native"].includes(old.kind)) {
            return reject("replacing a function requires an existing explicit function contract");
        }
        if (old.kind === "record") {
            if (value.kind !== "record") return reject("expected a Record");
            // A shared stateful object (a p5 object) is a reference: another
            // with the same fields replaces it as itself.
            if (old.shared || value.shared) {
                const keys = (r: Extract<Value, { kind: "record" }>) => r.v.map(([key]) => key).join("\n");
                if (!old.shared || !value.shared || keys(old) !== keys(value)) reject("cannot replace a shared object with another value");
                return value;
            }
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
    // Bindings an import, load or use publishes into scope, as definitions
    // there would be (see bindNames): the statement that published them goes
    // on in the scope they leave (adoptPublished). The scope they leave.
    private publishForeignBindings(scope: Env, bindings: Array<[string, Value]>, origin?: string, checked = false): Env {
        const pending = new Map<string, Value>();
        const published = this.publishedBy.get(scope.root()), own = scope.bindings();
        for (const [key, value] of bindings) {
            const old = pending.get(key) ?? (this.checking && !this.dynamicDepth ? own.get(key) : scope.get(key));
            const same = origin !== undefined && old !== undefined && published?.get(key)?.origin === origin && published.get(key)!.value === old;
            pending.set(key, this.checkedExecution && old && !same && !checked ? this.protectDynamicWrite(old, value, key) : value);
        }
        const caller = this.env, into = scope;
        this.env = scope;
        try { this.bindNames(pending); scope = this.env; } finally { this.env = caller; }
        if (scope !== into) this.published = { from: into, to: scope };
        if (origin === undefined) { for (const [key] of pending) published?.delete(key); return scope; }
        const record = published ?? new Map<string, { origin: string; value: Value }>();
        for (const [key, value] of pending) record.set(key, { origin, value });
        this.publishedBy.set(scope.root(), record);
        return scope;
    }
    // A statement that published bindings goes on in the scope they leave.
    private published?: { from: Env; to: Env };
    private adoptPublished(): void {
        if (this.published?.from === this.env) this.env = this.published.to;
        this.published = undefined;
    }
    private publishedBy = new WeakMap<Env, Map<string, { origin: string; value: Value }>>();

    // An index: an Int, or a value its to Int instance makes one (an
    // enumeration's position).
    private listIndex(value: Value): bigint | undefined {
        const v = value.kind === "int" ? value : this.builtinValue("Int", value);
        return v?.kind === "int" ? v.v : undefined;
    }

    // An operand of arithmetic: a value of a type the program defines is the
    // number its to instance makes (an Int or a Float).
    private arithmeticValue(value: Value): Value {
        const v = this.dataValue(value);
        return this.builtinValue("Int", v) ?? this.builtinValue("Float", v) ?? v;
    }

    // A value of a type the program defines where a built-in type is needed:
    // what its to instance for that type makes (to Int East is 1).
    // (Choosing the instance may meet the value again, in an instance's own
    // typed pattern: there it is not converted.)
    private builtinValue(name: string, v: Value): Value | undefined {
        if (v.kind !== "variant" || !v.family || v.family.base || !this.makes(name)) return undefined;
        const made = this.declaredConversion({ kind: "type", name }, v);
        return made && this.dataValue(made);
    }
    // What a program's to instance makes of a value for a type (to Int East),
    // if it has one.
    private declaredConversion(type: Value, arg: Value): Value | undefined {
        if (!this.instances.has("to")) return undefined;
        const v = this.demand(arg);
        if (this.converting.has(v)) return undefined;
        this.converting.add(v);
        const target = this.reference(type);
        // An instance takes a constructor's type as written: to (Money Float),
        // to (Box Int) for its type's own constructor applied to its parameters.
        const written = target.kind !== "type" ? type : target.made ? target.made
            : target.family && target.arguments?.length && target.family.fields?.has(target.name) ? { kind: "variant" as const, tag: target.name, family: target.family, v: target.arguments } : type;
        try { return this.instance("to", [written, v]); } finally { this.converting.delete(v); }
    }
    private converting = new Set<Value>();

    // The builtin with: a copy of a list or record with key set to the value
    // (written code, as a list's items are, or one already made).
    private assignItem(collection: Value, key: Value, given: Expr | Value): Value {
        const evaluate = () => "kind" in given ? given : this.eval(given);
        // A HashMap's key takes the value: a copy with it set or added at the end.
        const map = collection.kind === "hashmap" ? collection.entries : undefined;
        if (map) {
            const entries = new Map(map), held = entries.get(this.hashKey(key));
            entries.set(this.hashKey(key), [held ? held[0] : key, held ? this.assignSlot(held[1], this.demand(evaluate())) : this.demand(evaluate())]);
            return { kind: "hashmap", entries };
        }
        if (this.isList(collection)) {
            // An association list's key: its last pair with the key replaced,
            // as code's last binding of a name is the one read; a new key's
            // pair joins the end, as a record gains a field.
            if (key.kind === "string") {
                let rest = collection, position = 0n, last: { position: bigint; key: Value; value: Value } | undefined;
                for (let entry = this.cell(rest); entry; rest = entry.tail, entry = this.cell(rest), position++) {
                    checkInterrupt();
                    const pair = this.dataValue(entry.head);
                    if (!this.isList(pair)) throw new APNError("runtime", "association assignment expects [string,value] pairs");
                    const first = this.cell(pair), second = first && this.cell(first.tail);
                    if (!first || !second || this.cell(second.tail)) throw new APNError("runtime", "association lookup expects [string,value] pairs");
                    const name = this.dataValue(first.head);
                    if (name.kind !== "string") throw new APNError("runtime", "association lookup expects string keys");
                    if (name.v === key.v) last = { position, key: first.head, value: second.head };
                }
                if (!last) return this.append(collection, mkList([mkList([key, this.demand(evaluate())])]));
                return this.setIndex(collection, last.position, mkList([last.key, this.assignSlot(last.value, this.demand(evaluate()))]));
            }
            if (key.kind === "record") {
                const indices = key.v.map(([name, value]): [string, bigint] => {
                    const index = this.listIndex(this.dataValue(value));
                    if (index === undefined) throw new APNError("runtime", "named list indices must be integers or enumeration values");
                    this.index(collection, index);
                    return [name, index];
                });
                const incoming = this.dataValue(evaluate());
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
                let rest = this.dataValue(evaluate());
                if (!this.isList(rest)) throw new APNError("runtime", "multi-index assignment needs a list of values");
                const values: Value[] = [], items: (Written | undefined)[] = [];
                for (const _index of indices) {
                    const cell = this.cell(rest);
                    if (!cell) throw new APNError("runtime", "index count does not match value count");
                    items.push(this.written(cell.head));
                    values.push(items.at(-1) ? cell.head : this.demand(cell.head));
                    rest = cell.tail;
                }
                if (this.cell(rest)) throw new APNError("runtime", "index count does not match value count");
                // Items written as code replace theirs as code, in order.
                if (items.some(item => item)) {
                    const slots = indices.map(index => this.index(collection, index));
                    return indices.reduce((list, index, n) => this.setIndex(list, index, values[n], items[n], slots[n]), collection);
                }
                // Check each conversion against its original slot, even for duplicate indices.
                const checked = indices.map((index, n) => this.setIndex(collection, index, values[n]));
                let result = collection;
                for (let n = 0; n < indices.length; n++) result = this.setIndex(result, indices[n], this.index(checked[n], indices[n]));
                return result;
            }
            const index = this.listIndex(key);
            if (index === undefined) throw new APNError("runtime", "list assignment needs an integer index or a nullary variant from an enumeration");
            // The new item is code, as the list's are: code 0 = (x = 10) binds x.
            if ("kind" in given) return this.setIndex(collection, index, given);
            let item = given;
            while (item.t === "block" && item.style === "(" && item.stmts.length === 1) item = item.stmts[0];
            return this.setIndex(collection, index, mkList([]), { expr: item, env: this.env });
        }
        if (collection.kind === "record") {
            const entry = key.kind === "string" ? undefined : this.listIndex(key);
            if (entry !== undefined) return this.setEntry(collection, entry, this.demand(evaluate()));
            if (key.kind !== "string") throw new APNError("runtime", "record assignment needs a field name, or an entry's index");
            return this.assignFields(collection, [[key.v, this.demand(evaluate())]]);
        }
        throw new APNError("runtime", "indexed assignment expects an existing list or record");
    }

    // Destructuring binding:  [name, hello] = value  (or (Some x) = value, ...).
    // Evaluates the RHS, matches the pattern, and binds the destructured names
    // in the CURRENT environment (top level or the enclosing block's env).
    evalPatBinding(b: { pattern: Pattern; value: Expr; eager?: boolean; update?: { name: string; value: Expr; error?: string } }): Value {
        this.typesAfterValues([b.pattern], this.env, b);
        if (b.update && this.env.get(b.update.name)) {
            if (b.update.error) throw new APNError("runtime", b.update.error);
            return this.evalPatBinding({ pattern: { p: "var", name: b.update.name }, value: b.update.value });
        }
        const evaluated = b.pattern.p === "as" && !b.eager ? this.delay(b.value) : this.eval(b.value);
        // x <- action runs the action and binds its result; anything else is an error.
        if (b.eager) {
            const action = this.reference(evaluated);
            if (action.kind !== "io" && action.kind !== "pending") throw new APNError("runtime", `<- runs an action, not a ${action.kind}`, { hint: "bind a value with `=`" });
        }
        // The result's outer value is evaluated now (x <- return (x + 1) reads the old x).
        const v = b.eager ? this.reference(this.runIO(evaluated)) : b.pattern.p === "as" ? evaluated : this.force(evaluated);
        this.adoptPublished();
        const binds = new Map<string, Value>();
        if (!this.matchPattern(b.pattern, v, binds)) {
            throw new Error("Runtime: binding pattern did not match its value");
        }
        this.bindNames(binds);
        return v;
    }


    // An expression as data, as written: a leaf is a number, a Bool, a name or
    // a literal's source text ("x", "\"x\"", "'c'"); anything else is a list,
    // an application function first (["f","x"], ["+",1,2]), or headed by a
    // token no name can be: ["[]",...] a list, ["[:]",[key,value]...] a record,
    // ["->",[params],body], ["?:",c,a,b], [".",r,key], ["{}",...] a block,
    // ["..",low,high,next], ["=",left,right], ["<-",left,right], ["()","+",x]
    // the section (+ x). A pattern is written as an expression.
    sexprOf(e: Expr): Value {
        const of = (x: Expr) => this.sexprOf(x);
        const node = (...items: Value[]) => mkList(items);
        const text = (t: string) => mkStr(t);
        const pattern = (p: Pattern) => this.patternNode(p);
        const range = (low: Value, high: Value | undefined, next: Value | undefined) =>
            node(text(".."), low, high ?? mkList([]), ...next ? [next] : []);
        switch (e.t) {
            case "numeric": return e.v;
            case "int": return mkInt(e.v);
            case "float": return { kind: "float", v: e.v };
            case "bool": return mkBool(e.v);
            case "string": return text(stringLiteral(e.v));
            case "char": return text(charLiteral(e.v));
            case "placeholder": return text("_");
            case "var": return text(e.name);
            case "binop": {
                if (e.reassociate) return of(this.regrouped(e));
                return node(text(e.op), of(e.l), of(e.r));
            }
            case "pipe": return node(text("$"), of(e.f), of(e.x));
            case "unop": return node(text(e.op === "neg" ? "negate" : "not"), of(e.e));
            case "app": {
                // (x : T) is [":", x, T]: no application, as a type takes no value.
                if (e.ascribed) return node(text(":"), of(e.a), of(ascribedType(e.f)));
                // f x y is ["f","x","y"]: one list for the whole spine.
                const args: Expr[] = [];
                let head: Expr = e;
                while (head.t === "app" && !head.ascribed) { args.unshift(head.a); head = head.f; }
                return node(of(head), ...args.map(of));
            }
            case "lambda": {
                // An operator section, as written: (2 +) the operator given its
                // left operand, (+ 2) a "()" node.
                const op = e.body.t === "binop" ? e.body.op : e.body.t === "pipe" ? "$" : undefined;
                const [l, r] = e.body.t === "binop" ? [e.body.l, e.body.r] : e.body.t === "pipe" ? [e.body.f, e.body.x] : [];
                const own = (x: Expr | undefined, param: string) => x?.t === "var" && x.name === param;
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
            case "recordAccess": return node(text("."), of(e.rec), e.scoped && e.argument ? this.scoped(e.argument) : text(keySource(e.field)));
            case "pluck":
                if (e.values) return node(text("."), of(e.rec), of(e.values));
                return node(text("."), of(e.rec), e.entries.every(x => typeof x === "string")
                    ? node(text("[]"), ...(e.entries as string[]).map(text))
                    : node(text("[:]"), ...(e.entries as [string, string][]).map(([k, v]) => node(text(keySource(k)), text(v)))));
            case "range": return range(of(e.lo), e.hi ? of(e.hi) : undefined, e.second ? of(e.second) : undefined);
            // a single-statement ( ) group is transparent: toAST (1 + 2) is ["+",1,2]
            case "block":
                if (e.stmts.length === 1 && e.style === "(") return of(e.stmts[0]);
                return node(text("{}"), ...e.stmts.flatMap(st => st.t === "stmDef" ? this.clauseNodes(st) : [of(st)]));
            case "stmDef": {
                const binds = this.clauseNodes(e);
                return binds.length === 1 ? binds[0] : node(text("{}"), ...binds);
            }
            case "typeDef": throw new APNError("runtime", "a type declaration has no form as code");
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
    private scoped(e: Expr): Value {
        const stmts = e.t === "block" ? e.stmts : [e];
        return mkList([mkStr("{}"), ...stmts.map(st => this.sexprOf(st))]);
    }
    // A definition's clauses, each ["=", [name, params...], body] (["=", name, body] without parameters).
    private clauseNodes(d: Extract<Expr, { t: "stmDef" }>): Value[] {
        return d.clauses.map(c => mkList([mkStr("="),
            c.params.length ? mkList([mkStr(d.name), ...c.params.map(p => this.patternNode(p))]) : mkStr(d.name), this.sexprOf(c.body)]));
    }
    // A pattern, as the expression it is written as.
    private patternNode(p: Pattern): Value {
        const node = (...items: Value[]) => mkList(items), text = mkStr, of = (q: Pattern) => this.patternNode(q);
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
            // A typed pattern is [":", value, type], as the ascription it reads as.
            case "constr": {
                if (!p.typed) return p.args.length ? node(text(p.tag), ...p.args.map(of)) : text(p.tag);
                const types = p.args.slice(0, -1);
                return node(text(":"), of(p.args[p.args.length - 1]), types.length ? node(text(p.tag), ...types.map(of)) : text(p.tag));
            }
            case "typeBind": return node(text(":"), of(p.value), text(p.name));
            case "schema": return node(text(":"), of(p.value), this.sexprOf(p.type));
            case "as": return node(text("."), of(p.left), of(p.right));
            case "recPat": return node(text("[:]"), ...p.v.map(([k, v]) => node(text(v), text(k === "_" ? k : keySource(k)))));
            case "range": return node(text(".."), mkInt(p.lo), mkInt(p.hi));
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
    // step n code: n levels into code's (last) item, as code: a name goes to
    // what it is defined as, a block to its last statement, a 0-argument
    // action or a thunk to its body, and anything else computable evaluates one
    // level (step 1 [1 + 2] is [3]); an action stays as written.
    stepNative(argsIn: Value[]): Value {
        const n = this.dataValue(argsIn[0]);
        if (n.kind !== "int" || n.v < 0) {
            throw new APNError("runtime", "step needs a non-negative int count");
        }
        const code = this.dataValue(argsIn[1]);
        const item = this.isList(code) ? this.items(code).at(-1) : undefined;
        const written = item && this.written(item);
        if (!written) throw new APNError("runtime", "step takes code: a list's items as written", { hint: "quote what to step into: step 1 [inner]" });
        let expr: Expr | null = written.expr, env = written.env;
        let val: Value = { kind: "list", v: [] };
        for (let i = 0n; i < n.v; i++) {
            checkInterrupt();
            // free descents: names resolve, blocks expose their last statement
            for (;;) {
                if (expr !== null && expr.t === "var") {
                    val = env.get(expr.name) ?? { kind: "list", v: [] };
                    expr = null;
                } else if (expr !== null && expr.t === "block") {
                    const last: Expr | undefined = expr.stmts[expr.stmts.length - 1];
                    if (!last || last.t === "stmDef" || last.t === "patDef") break;
                    expr = last;
                } else break;
            }
            const act: Extract<Value, { kind: "closure" | "thunk" }> | null = val.kind === "closure" && val.params.length === 0 ? val : val.kind === "thunk" ? val : null;
            if (act !== null) {
                expr = act.body;
                env = act.env ?? env;
                val = { kind: "list", v: [] };
                continue;
            }
            if (expr === null || ["int", "float", "bool", "string", "char"].includes(expr.t)) break;
            // An action has no source form: the level stays as written.
            const outer = this.env;
            this.env = env;
            let level: Value;
            try { level = this.demand(this.eval(expr)); } finally { this.env = outer; }
            if (level.kind === "io" || level.kind === "pending") break;
            expr = this.valueToExpr(level);
            val = { kind: "list", v: [] };
        }
        return this.codeList([expr ?? this.valueToExpr(val)], env);
    }



    // `*` iteration: seq * fn or fn * seq — applies fn over the sequence and returns the
    // results. seq is a list (elements), a string (characters), a record (entries
    // as [field, value] lists), or an int n (0..n-1; a negative n counts 0, -1, ... n+1).
    iterate(seq: Value, f: Value): Value {
        seq = this.dataValue(seq);
        // A string supplies its characters, as to (List Char) gives them.
        if (seq.kind === "string") seq = this.dataValue(standardNative(this, "chars", [seq]));
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
            for (const [k, x] of seq.v) out.push(this.apply(f, mkList([mkStr(k), x])));
        } else if (seq.kind === "hashmap") {
            for (const [k, x] of seq.entries.values()) out.push(this.apply(f, mkList([k, x])));

        } else if (seq.kind === "int") {
            const n = seq.v < 0n ? -seq.v : seq.v;
            for (let i = 0n; i < n; i++) {
                checkInterrupt();
                out.push(this.apply(f, mkInt(seq.v >= 0n ? i : -i)));
            }
        } else {
            throw new APNError("runtime", `cannot iterate a ${seq.kind}`, {
                hint: "expected a list, a string, a record, a HashMap, or an int count",
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
        this.env = v.env!;
        try {
            const result = this.force(this.eval(v.body, tailLoad));
            // A stateful object (a cell, an allocation, a p5 object) is allocated once and shared.
            if (result.kind === "mutable" || result.kind === "pointer" || result.kind === "record" && result.shared) v.mutableValue = result;
            // An application that is not an action is a value, kept as any value
            // is (v = 1 + 2), and lets go of its scope; only an action is
            // evaluated again at each run (bump = set c (c + 1)). A game's model
            // holding one (velocity = step dt keys person) would otherwise
            // recompute, and keep, every earlier frame.
            else if (v.body.t !== "block" && result.kind !== "io" && result.kind !== "pending") { v.mutableValue = result; v.env = undefined; }
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
            // A definition's type is named (see namedValue), once: each use
            // is the same type.
            const definition = v.kind === "closure" && v.names ? v : undefined;
            const known = definition && this.namedTypes.get(definition);
            if (known) { v = known; break; }
            v = this.force(this.callBlockFn(v, tailLoad));
            if (definition) {
                v = this.namedValue(definition.names!, this.reference(v), definition.body);
                if (v.kind === "type") this.namedTypes.set(definition, v);
            }
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
        const made: Value = { kind: "variant", tag, family, arguments: v.arguments, v: fields.map(spec => this.defer(() => {
            const caller = this.env; this.env = scope;
            try {
                const type = this.reference(this.eval(spec));
                if (!this.isTypeValue(type)) throw new APNError("runtime", `${tag} needs an explicit field value`);
                return this.defaultField(type, nextPath);
            } finally { this.env = caller; }
        })) };
        // A constructor with logic makes its default as it makes any value.
        const ctor = family.env?.get(tag);
        return ctor?.kind === "native" && ctor.invoke && made.kind === "variant" ? ctor.invoke(made.v) : made;
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
        v = this.sharedType(v) ?? v;
        // A constructor's type (UserId Int) defaults as its type does, when
        // that default is one of its values (UserId 0).
        if (v.kind === "type" && v.refine && v.choices?.length === 1) {
            const made = this.zeroValue(this.reference(v.choices[0]), path);
            if (made.kind !== "type" && this.belongsToType(v, made)) return made;
        }
        if (v.kind === "type") v = this.zeroValue(v, path);
        if (v.kind === "type" || v.kind === "functionType") throw new APNError("runtime", "this type needs an explicit default value");
        if (v.kind === "record") {
            const result: Value = { kind: "record", v: v.v.map(([k, x]) => [k, this.defer(() => this.defaultField(x, path))]) };
            if (this.isTypeValue(v)) this.declaredTypes.set(result, v);
            return result;
        }
        if (this.isList(v)) {
            const cell = this.cell(v);
            return cell ? { kind: "cons", head: this.defer(() => this.defaultField(cell.head, path)), tail: this.defer(() => this.defaultField(cell.tail, path)) } : mkList([]);
        }
        return v;
    }

    // A statement runs its value when that is an IO action.
    // statement: one whose value must be in the block's monad (see dropped).
    runStmt(v: Value, tailLoad = false, statement?: Expr): Value {
        const value = this.demand(v, tailLoad);
        if (statement) this.dropped(statement, value, false);
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
    // As in Haskell, a block's statement that binds nothing, but the last, is in
    // its monad (see the checker): what the check could not decide is checked
    // here. [] is the unit, and a list block takes lists.
    private dropped(s: Expr, value: Value, listBlock: boolean): void {
        if (["io", "pending"].includes(value.kind)) return;
        if (value.kind === "variant" && value.family && this.familiesOf(">>=").has(value.family)) return;
        if (this.isList(value) && (listBlock || this.cell(value) === null)) return;
        const at = sourceLocations.get(s);
        const error = new APNError("runtime", `a statement in a do-block must be an action, not ${this.typeText(value)}: its value would be dropped`, {
            hint: "bind it (`x = ...`), or remove it", ...at ? { pos: at.start, len: Math.max(1, at.end - at.start) } : {},
        });
        if (at) error.src = at.source;
        throw error;
    }
    private runDoBlock(e: Extract<Expr, { t: "block" }>, env: Env, start: number, first?: Value): Value | IOTail {
        const caller = this.env;
        this.env = new Env(env);
        try {
            for (let i = start; i < e.stmts.length; i++) {
                const s = e.stmts[i];
                if (declaresNames(e)) this.readPatterns(s);
                if (i === start && first) {
                    const result = this.runIO(first);
                    if (s.t === "patDef") this.bindResult(s, result);
                }
                else if (s.t === "stmDef") this.evalDef(s.name, s.clauses);
                else if (s.t === "typeDef") this.declare(s.def, this.env);
                else if (s.t === "patDef") this.evalPatBinding(s);
                else if (i < e.stmts.length - 1) {
                    const value = this.demand(this.eval(s));
                    this.dropped(s, value, false);
                    this.runStmt(value);
                    this.adoptPublished();
                }
                else {
                    // The last statement is the action whose result the block yields.
                    const last = this.realize(this.eval(s), { kind: "type", name: "IO" });
                    // [], the unit (what print yields), ends it as {} does.
                    if (this.isList(last) && this.cell(last) === null) return last;
                    if (last.kind !== "io") throw new APNError("runtime", `the last statement of a do-block must be an action, not a ${last.kind}`, { hint: "`return x` is the action yielding `x`" });
                    return new IOTail(last);
                }
            }
            // A binding last is followed by {}, the unit: [].
            return mkList([]);
        } finally { this.env = caller; }
    }

    eval(e: Expr, tailLoad = false): Value {
        const value = this.evaluate(e, tailLoad);
        // A list or variant an expression makes keeps the type the checker
        // gave it, for typed patterns (see staticTypeOf).
        if ((e.t === "list" || e.t === "app") && this.types?.bridge) {
            const type = this.recordedType(e, this.types.valueTypes);
            if (type && !this.staticTypes.has(value)) this.staticTypes.set(value, type);
        }
        return value;
    }
    private evaluate(e: Expr, tailLoad = false): Value {
        const caller = this.env;
        let forceResult = false;
        // The monad the checker found for an expression a tail call left.
        let decided: Value | undefined;
        this.stack++;
        try {
            if (this.stack > STACK_LIMIT) throw stackOverflow();
            for (;;) {
                checkInterrupt();
                let r: Value = { kind: "list", v: [] };
                let next: TailCall | undefined;
                switch (e.t) {
                    case "range": {
                        // [a..] is enumFrom a, and so on: with the prelude's, a
                        // range of numbers is made in place, and one of a type
                        // repeats it (enumFrom's own clause).
                        const name = rangeName(e), bound = this.loadingPrelude ? undefined : this.env.get(name);
                        if (bound !== undefined && (this.reference(bound) !== this.preludeBindings.get(name) || this.joins(bound))) { next = new TailCall(rangeExpansion(e), this.env); break; }
                        const lo: Value = this.reference(this.dataValue(this.eval(e.lo)));
                        if (this.isTypeValue(lo) && bound && !e.second && !e.hi) { r = this.apply(this.reference(bound), lo); break; }
                        r = this.range(lo, e.second && this.eval(e.second), e.hi && this.eval(e.hi));
                        break;
                    }
                    case "numeric": r = e.v; break;
                    case "int": r = mkInt(e.v); break;
                    case "float": r = { kind: "float", v: e.v }; break;
                    case "bool": r = mkBool(e.v); break;
                    case "string": r = mkStr(e.v); break;
                    case "char": r = { kind: "char", v: e.v }; break;
                    case "placeholder": throw placeholderError();
                    case "var": {
                        const v = this.env.get(e.name);
                        if (v === undefined) {
                            const near = didYouMean(e.name, envNames(this.env));
                            throw new APNError("runtime", `unbound variable '${e.name}'`, {
                                hint: near ? `did you mean '${near}'?` : undefined,
                            });
                        }
                        r = v;
                        break;
                    }
                    case "binop": {
                        if (e.reassociate) { next = new TailCall(this.regrouped(e), this.env); break; }
                        // The builtin ~ with written alternatives runs here, as
                        // a call of it does, its chosen body in place of the match.
                        const written = e.op === "~" ? writtenMatch(e) : undefined;
                        if (written && this.preludeCons() && this.isBuiltinMatch(this.env.get("~"))) { next = this.coreMatch(written); break; }
                        r = this.evalBinop(e);
                        break;
                    }
                    case "unop": {
                        // -x is negate x and !x is not x, with what those mean
                        // here; the prelude's run in place.
                        const name = e.op === "neg" ? "negate" : "not", bound = this.env.get(name);
                        if (bound === undefined) throw new APNError("runtime", `unbound variable '${name}'`);
                        const f = this.reference(bound);
                        if (f !== this.preludeBindings.get(name) || this.joins(f)) {
                            const result = this.apply(f, { kind: "thunk", body: e.e, env: this.env }, false, true, tailLoad);
                            if (result instanceof TailCall) next = result; else r = result;
                            break;
                        }
                        const v = this.dataValue(this.eval(e.e));
                        r = e.op === "neg" ? this.arrayNegate(v) : mkBool(!this.truthy(v));
                        break;
                    }
                    case "app": {
                        // A Bool applied to two values, with the prelude's get and
                        // Bool, is the match on it its clauses make.
                        const selection = e.f.t === "app" ? boolSelection(e) : undefined;
                        if (selection && this.preludeSelection(selection)) { next = this.coreMatch(selection); break; }
                        // The builtin match with written alternatives runs here,
                        // its chosen body in place of the match.
                        const written = e.f.t === "app" && e.f.f.t === "var" ? writtenMatch(e) : undefined;
                        if (written && this.preludeCons() && this.isBuiltinMatch(this.env.get(((e.f as Extract<Expr, { t: "app" }>).f as Extract<Expr, { t: "var" }>).name))) { next = this.coreMatch(written); break; }
                        // Arguments stay lazy; a completed call can hand its body
                        // straight back to this loop instead of nesting eval calls.
                        const head = this.eval(e.f);
                        // _ given to a type (or a constructor named as its type)
                        // is any, as in a pattern: List _ is every list.
                        const argument: Value = e.a.t === "placeholder" && this.takesTypes(head) ? { kind: "type", name: "$any" } : { kind: "thunk", body: e.a, env: this.env };
                        // e : T: a type applied to a value, as a member of it. A
                        // constructor named as its type is the type there (Point, Box Int).
                        const ascribed = e.ascribed ? this.reference(head) : undefined;
                        const type = ascribed && (this.sharedType(ascribed) ?? ascribed);
                        if (type?.kind === "type") { r = this.typeValue(this.valuesType(type), argument); break; }
                        // A function type's member is a contract (f : Int -> Int).
                        if (type?.kind === "functionType") { r = this.conform(type, argument); break; }
                        // A record or list of types makes its value ([] : [v : Int],
                        // [1] : [Float]); its first item tells a list of types.
                        if (ascribed && (ascribed.kind === "record" || this.isList(ascribed) && this.listOfTypes(ascribed) || this.asWritten.has(ascribed))) { r = this.conform(ascribed, argument); break; }
                        this.writtenApplication = !e.ascribed;
                        if (e.types) {
                            this.typeOperands++;
                            try { r = this.apply(head, argument); } finally { this.typeOperands--; }
                            break;
                        }
                        const result = this.apply(head, argument, false, true, tailLoad);
                        if (result instanceof TailCall) next = result; else r = result;
                        break;
                    }
                    case "patternLambda": r = { kind: "clauseFn", name: "<lambda>", clauses: [{ params: e.params, body: e.body, guard: e.guard }], arity: e.params.length, env: this.env, applied: [] }; break;
                    case "lambda": r = { kind: "closure", params: e.params, body: e.body, env: this.env }; break;
                    case "ternary": {
                        const expansion = ternaryExpansion(e), selection = boolSelection(expansion)!;
                        next = this.preludeSelection(selection) ? this.coreMatch(selection) : new TailCall(expansion, this.env);
                        break;
                    }
                    case "list": {
                        // [a, b] is a :: b :: [], with what :: means here; the
                        // prelude's builds the list in place.
                        const binds = e.v.some(x => x.t === "stmDef" || x.t === "patDef" || isUse(x));
                        if (e.v.length && !this.preludeCons() && !binds) { next = new TailCall(listExpansion(e), this.env); break; }
                        if (!binds) { r = { kind: "lazyList", exprs: e.v, env: this.env }; break; }
                        r = this.codeList(e.v, this.env);
                        this.literalItems.set(r, e.v);
                        break;
                    }
                    case "record": {
                        if (e.items) { r = this.recordBlock(e as Extract<Expr, { t: "record" }> & { items: Expr[] }); break; }
                        // Fields are code: each is in scope for those after it, and
                        // x = x + 1 reads the x before it, as in a block.
                        // A field is bound to its value (x = Float), except one
                        // declared with only its type, a slot (x : Float).
                        const fields = new Map<string, Value>(), bound = new Set<string>(), outer = this.env;
                        const written = e.v;
                        const slots = new Set(e.declared?.filter(key => !written.some(([k, x]) => k === key && x.t === "app" && x.ascribed)));
                        const bind = (name: string, value: Value, isBound: boolean) => {
                            fields.set(name, value);
                            if (isBound) bound.add(name); else bound.delete(name);
                            this.env = new Env(this.env);
                            this.env.setLocal(name, value);
                        };
                        try {
                            for (const [key, expression] of e.v) {
                                // A bound value is computed when used, as a list's item
                                // is. A function is made where it is written (its
                                // clauses read the scope here, not a later use's), a
                                // literal costs nothing, and a declared field is checked
                                // now (a slot's type is known: see holdsType).
                                const now = !!e.declared?.includes(key) || ["int", "float", "numeric", "string", "char", "bool"].includes(expression.t)
                                    || expression.t === "block" && expression.stmts[0]?.t === "stmDef";
                                if (key !== "_") { bind(key, now ? this.eval(expression) : this.delay(expression), !slots.has(key)); continue; }
                                const spread = this.dataValue(this.eval(expression));
                                if (spread.kind !== "record") throw new APNError("runtime", "[..] opens a record");
                                for (const [name, value] of spread.v) bind(name, value, !!spread.bound?.has(name));
                            }
                        } finally { this.env = outer; }
                        r = { kind: "record", v: [...fields], ...bound.size ? { bound } : {} };
                        if (e.items) this.recordCode.set(r, { exprs: e.items, env: outer });
                        break;
                    }
                    case "recordAccess": {
                        // Resolve aliases/actions to the outer record, leaving its fields lazy.
                        const rec = this.dataValue(this.eval(e.rec));
                        // code.x: the value code's binding of x gives, as a
                        // record's field is (a list binding nothing applies).
                        const binding = this.isList(rec) && !e.scoped ? this.codeBinding(rec, e.field) : undefined;
                        if (binding) { r = binding.value; break; }
                        if ((this.isList(rec) || rec.kind === "hashmap") && e.scoped) throw new APNError("runtime", "scoped evaluation requires a record", { hint: "its names are known only at runtime: open a record (to Record xs).(e)" });
                        // On a list or HashMap, v.x is get v "x": its key's value, as a record's.
                        if (this.isList(rec)) { r = this.associationValue(rec, e.field); break; }
                        if (rec.kind === "hashmap") { r = this.mapLookup(rec, mkStr(e.field)); break; }
                        if (rec.kind === "io") throw new APNError("runtime", "an action has no fields", { hint: "bind its result first: `x <- action; x.field`" });
                        // Another value's field is get v "x", when clauses for get give it fields.
                        if (rec.kind !== "record" && !e.scoped && this.extended("get", rec)) { r = this.apply(rec, mkStr(e.field)); break; }
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
                        const rec = this.dataValue(this.eval(e.rec));
                        if (e.quoted === false && this.isList(rec)) throw new APNError("runtime", "a list has no fields", { hint: LIST_FIELDS });
                        if (e.quoted === false) throw new APNError("runtime", "record selection expects literal field names");
                        // Each key's value: a record's field, or get v "key" on a list or HashMap.
                        const byKey = rec.kind === "record" ? new Map(rec.v) : undefined;
                        const look = (key: string): Value => {
                            if (this.isList(rec)) return this.associationValue(rec, key);
                            if (rec.kind === "hashmap") return this.mapLookup(rec, mkStr(key));
                            if (!byKey) throw new APNError("runtime", `cannot select fields of a ${rec.kind}`);
                            return byKey.get(key) ?? this.missingField(rec as Extract<Value, { kind: "record" }>, key);
                        };
                        r = e.entries.every((x) => typeof x === "string")
                            ? mkList((e.entries as string[]).map(look))
                            : { kind: "record", v: (e.entries as Array<[string, string]>).map(([src, dst]) => [dst, look(src)] as [string, Value]) };
                        break;
                    }
                    case "setItem": {
                        const collection = this.dataValue(this.eval(e.rec));
                        const key = this.dataValue(this.eval(e.index));
                        r = this.assigned(collection, key, e.value);
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
                        // code.x = v replaces the item binding x with x = v, as
                        // code i = (x = v) does: the items after it see it.
                        const [only] = e.entries;
                        const binding = this.isList(rec) && e.entries.length === 1 && !e.aliases && only !== "_" ? this.codeBinding(rec, only) : undefined;
                        if (binding) {
                            if (!binding.simple) throw new APNError("runtime", `code binds ${only} with a pattern; replace the item: code ${binding.index} = (...)`);
                            r = this.setIndex(rec, binding.index, mkList([]), { expr: bindingItem(only, e.value), env: this.env });
                            for (let n = parents.length - 1; n >= 0; n--) {
                                const [parent, key] = parents[n], child = r;
                                r = this.keepType(parent, { kind: "record", v: parent.v.map(([k, v]) => [k, k === key ? child : v]) });
                            }
                            break;
                        }
                        if (this.isList(rec) && this.cell(rec) === null) rec = mkList([]);
                        let base: Array<[string, Value]> | null = null;
                        if (rec.kind === "record") base = rec.v;
                        else if (rec.kind === "list" && rec.v.length === 0) base = []; // [] seeds a record
                        // Another value's fields are set by with v "x" value, when clauses for
                        // with give it fields; a list's or HashMap's by the builtin with.
                        const keyed = base === null && (this.isList(rec) || rec.kind === "hashmap") && !e.aliases && e.entries[0] !== "_";
                        const through = base === null && !CALLABLE_KINDS.has(rec.kind) ? this.extended("with") : undefined;
                        if (base === null && !through && !keyed) {
                            throw new APNError("runtime", `cannot set a field on a ${rec.kind}`, {
                                hint: rec.kind === "io" ? "bind the action's result first: x <- action; x.field = 1" : "only records accept fields (an empty list promotes to a record)",
                            });
                        }
                        if (e.entries.length === 1 && e.entries[0] === "_" && base !== null) {
                            const expression = e.value.t === "list" ? e.value.v[0] : e.value;
                            const spread = this.dataValue(this.eval(expression));
                            if (spread.kind !== "record") throw new APNError("runtime", "record flattening expects a record");
                            if (rec.kind === "record") for (const [key] of spread.v) if (!base.some(([k]) => k === key)) this.newField(rec, key);
                            let merged: Value = this.keepType(rec, { kind: "record", v: [...new Map([...base!, ...spread.v])] });
                            for (let n = parents.length - 1; n >= 0; n--) {
                                const [parent, key] = parents[n];
                                merged = this.keepType(parent, { kind: "record", v: parent.v.map(([k, v]) => [k, k === key ? merged : v]) });
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
                        const values = rhs.v;
                        r = through ? e.entries.reduce((v, key, i) => this.apply(this.apply(this.apply(through, v), mkStr(key)), values[i]), rec)
                            : keyed ? e.entries.reduce((v, key, i) => this.assignItem(v, mkStr(key), values[i]), rec)
                            : this.assignFields(rec.kind === "record" ? rec : { kind: "record", v: base! }, e.entries.map((key, i) => [key, values[i]]));
                        for (let i = parents.length - 1; i >= 0; i--) {
                            const [parent, key] = parents[i];
                            r = this.keepType(parent, { kind: "record", v: parent.v.map(([name, value]) => [name, name === key ? r : value]) });
                        }
                        break;
                    }
                    case "pipe": {
                        const dollar = this.env.get("$");
                        if (!(dollar?.kind === "native" && dollar.name === "intrinsics.apply" && !dollar.applied.length)) {
                            r = this.evalBinop({ t: "binop", op: "$", l: e.f, r: e.x });
                            break;
                        }
                        const head = this.eval(e.f);
                        this.writtenApplication = true;
                        const result = this.apply(head, { kind: "thunk", body: e.x, env: this.env }, false, true, tailLoad);
                        if (result instanceof TailCall) next = result; else r = result;
                        break;
                    }
                    case "block": {
                        const child = new Env(this.env);
                        const old = this.env;
                        this.env = child;
                        try {
                            r = { kind: "list", v: [] };
                            const scoped = declaresNames(e);
                            for (let si = 0; si < e.stmts.length; si++) {
                                const s = e.stmts[si];
                                if (scoped) this.readPatterns(s);
                                // A binding last is followed by {}: { x = 1 } is (x -> {}) 1, [].
                                if (s.t === "stmDef") { this.evalDef(s.name, s.clauses); r = mkList([]); continue; }
                                if (s.t === "typeDef") { this.declare(s.def, this.env); r = mkList([]); continue; }
                                if (s.t === "patDef" && !(s.eager && !(s.update && this.env.get(s.update.name)))) { this.evalPatBinding(s); r = mkList([]); continue; }
                                if (s.t !== "patDef" && si === e.stmts.length - 1) {
                                    forceResult = true;
                                    next = new TailCall(s, this.env);
                                    break;
                                }
                                // A <- binding, or a discarded statement in a monad, makes the
                                // rest of the block a do-block: the block is the action (or
                                // the Option, ...) that runs it, as in Haskell.
                                // Its monad: IO for an action (or a load), undecided for
                                // return and the like, else the value's own (a list, an Option).
                                // A discarded list is pure: [] is also the unit value.
                                const value = s.t === "patDef" ? this.reference(this.eval(s.value)) : this.demand(this.eval(s));
                                // The rest of the block runs in the scope as it is here.
                                const block = e, start = si, here = this.env;
                                if (!value || value.kind === "io") {
                                    r = { kind: "io", result: this.blockResult(block, here, start), run: () => this.runDoBlock(block, here, start, value) };
                                    break;
                                }
                                if (value.kind === "pending") {
                                    // Undecided, unless the checker found the block's monad.
                                    const target = this.checkedMonad(block);
                                    r = target ? this.desugarDo(block, here, start, target, value) : { kind: "pending", step: { op: "do", block, env: here, start, first: value } };
                                    break;
                                }
                                if (s.t === "patDef") {
                                    const target = this.monadTypeOf(value);
                                    if (!target) throw new APNError("runtime", `<- runs an action, not a ${value.kind}`, { hint: "bind a value with `=`" });
                                    r = this.desugarDo(block, here, start, target, value);
                                    break;
                                }
                                if (value.kind === "variant" && value.family && this.familiesOf(">>=").has(value.family)) {
                                    r = this.desugarDo(block, here, start, this.monadTypeOf(value)!, value);
                                    break;
                                }
                                // do { e; ss } is e >> do { ss }: a plain e is an error (see dropped).
                                this.dropped(s, value, false);
                                r = value;
                                this.adoptPublished();
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
                    // A tail call leaves this expression: keep the monad the
                    // checker found for it (the outermost), as below.
                    if (this.types?.resultHeads.size) decided ??= this.checkedMonad(e);
                    e = next.body;
                    this.env = next.env;
                    continue;
                }
                // An undecided value from code the checker found in a monad
                // (a >>= chain, a call) is in that monad.
                const shown = r.kind === "thunk" && r.value ? r.value : r;
                if (shown.kind === "pending") {
                    const target = decided ?? this.checkedMonad(e);
                    if (target) r = this.realize(shown, target);
                }
                return forceResult ? this.force(r) : r;
            }
        } catch (error) {
            // The host's stack, filled before STACK_LIMIT (by frames that
            // nest more per level), is the same overflow.
            if (error instanceof RangeError && error.message.includes("call stack")) throw stackOverflow();
            throw error;
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
            if (cons?.kind === "native" && cons.name === "intrinsics.cons" && !cons.applied.length) {
                throw new APNError("runtime", `cons tail expected a list, got ${e.r.t}`);
            }
        }
        const bound = this.env.get(e.op);
        if (bound === undefined) throw new APNError("runtime", `unbound operator '${e.op}'`);
        const f = bound.kind === "thunk" || bound.kind === "deferred" ? this.reference(bound) : bound;
        // A prelude operator bound to its intrinsic runs it directly; strict
        // ones evaluate their operands in place.
        const op = f.kind === "native" && !f.applied.length && !this.joins(f) ? PRIMITIVE_OPERATORS.get(f.name) : undefined;
        if (op && !LAZY_OPERATORS.has(op)) return this.operate(op, this.eval(e.l), this.eval(e.r));
        const l = this.delay(e.l), r = this.delay(e.r);
        if (op) return this.operate(op, l, r);
        // (An operand the joined clauses force first is forced here, as the
        // builtin's are: see firstForced.)
        const first = f.kind === "native" && this.attachments.size ? this.joinedFirst(f, [l, r]) : undefined;
        if (first) this.force(first);
        return this.apply(this.apply(f, l), r);
    }

    // A record ++ a record: one record, the left's fields, then the right's (a
    // later one wins).
    private mergeRecords(record: Extract<Value, { kind: "record" }>, other: Value): Value | undefined {
        return other.kind === "record" ? { kind: "record", v: [...new Map([...record.v, ...other.v])] } : undefined;
    }
    // A record ++ a record written there: the record [[..] = r, ...] with the
    // written one's items, which see r's names (code joins code).
    private joinRecord(left: Value, rThunk: Value): Value | undefined {
        if (rThunk.kind !== "thunk" || !rThunk.env || rThunk.body.t !== "record" || !rThunk.body.items) return undefined;
        const r = rThunk.body, held: Expr = { t: "var", name: JOINED };
        const env = new Env(rThunk.env);
        env.setLocal(JOINED, left);
        return { kind: "thunk", body: { ...r, v: [["_", held], ...r.v], items: [opening(held), ...r.items!] }, env };
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
                        if (!this.isList(value) && !this.ofLists(value)) throw new APNError("runtime", `cons tail expected a list, got ${value.kind}`);
                        return value;
                    },
                },
            };
        }
        if (op === "++") {
            const record = this.dataValue(lThunk);
            const joined = record.kind === "record" ? this.joinRecord(record, rThunk) ?? this.mergeRecords(record, this.dataValue(rThunk)) : undefined;
            if (joined) return joined;
            const l = this.code(record);
            const r = rThunk;
            if (this.isList(l)) return this.appendCode(l, r);
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
            // (A type is no function: it takes types, and a value only by ascription.)
            const callable = (v: Value) => ["closure", "clauseFn", "native", "contract"].includes(v.kind);
            if (callable(r)) return this.iterate(l, r);
            if (callable(l)) return this.iterate(r, l);
            const type = [l, r].find(v => v.kind === "type" || v.kind === "functionType");
            if (type) {
                const { message, hint } = typeApplied(this.renderString(type));
                throw new APNError("runtime", message, { hint });
            }
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
        const promoted = this.promote(op, l, r);
        if (promoted) return promoted;
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
            const functions = ["closure", "clauseFn", "native", "contract"];
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
            case "*": case "-": case "/": case "%": return bad();
            case "<": case ">": case "<=": case ">=": {
                // Values compare as sets (see setOf): a <= b when a's set is
                // within b's, a < b when b's also has more.
                const read = (v: Value) => this.setOf(v) === "type" ? this.asType(v) ?? v : v;
                // A list and one value, as the checker reports it: what is meant is its items.
                const single = (v: Value) => ["ordered", "sequence"].includes(this.setOf(v) ?? "") && !this.isList(v);
                const listLeft = this.isList(l) && single(r), listRight = this.isList(r) && single(l);
                if (listLeft || listRight) {
                    throw new APNError("runtime", `cannot compare ${this.renderString(l)} and ${this.renderString(r)}`, {
                        hint: itemComparisonHint(op, this.valueToExpr(listLeft ? r : l), listLeft) });
                }
                const [small, large] = op[0] === "<" ? [read(l), read(r)] : [read(r), read(l)];
                return mkBool(this.subset(small, large) && (op.length === 2 || !this.subset(large, small)));
            }
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

    // The record with these fields set: r.f = v, r.[f, g] = [v, w], and
    // r [f = v, g = w], which is the same update. A field it has keeps what its
    // old value requires (a number's type, a variant's family); a new one is
    // added, unless a record type made the record.
    private assignFields(rec: Extract<Value, { kind: "record" }>, fields: Array<[string, Value]>): Value {
        const out = rec.v.slice(), bound = new Set(rec.bound);
        for (const [key, value] of fields) {
            const index = out.findIndex(([field]) => field === key);
            // A new field is bound to its value, as assignment binds.
            if (index < 0) { out.push([this.newField(rec, key), value]); bound.add(key); }
            else out[index] = [key, this.assignSlot(out[index][1], value, bound.has(key))];
        }
        const result = this.keepType(rec, { kind: "record", v: out });
        if (result.kind === "record") result.bound = bound.size ? bound : undefined;
        return result;
    }

    // v 0 = ["x1",22]: entry n replaced by a [key,value] pair, as v 0 reads it;
    // a negative n counts from the end.
    private setEntry(rec: Extract<Value, { kind: "record" }>, index: bigint, value: Value): Value {
        const n = Number(index < 0n ? index + BigInt(rec.v.length) : index);
        if (n < 0 || n >= rec.v.length) throw new APNError("runtime", `the record has no entry ${index}`, { hint: `it has ${rec.v.length}` });
        const pair = this.isList(value) ? this.items(value) : [];
        const key = pair.length === 2 ? this.dataValue(pair[0]) : undefined, field = pair[1];
        if (key?.kind !== "string") throw new APNError("runtime", "an entry is a [key,value] pair, as reading it gives: [\"x1\", 22]");
        const [old, held] = rec.v[n];
        const other = rec.v.findIndex(([k], i) => k === key.v && i !== n);
        if (other >= 0) throw new APNError("runtime", `the record already has a field '${key.v}' (entry ${other})`);
        const out = rec.v.slice();
        const bound = new Set(rec.bound);
        if (key.v === old) out[n] = [old, this.assignSlot(held, field, bound.has(old))];
        else { out[n] = [this.newField(rec, key.v), field]; bound.delete(old); bound.add(key.v); }
        return this.keepType(rec, { kind: "record", v: out, ...bound.size ? { bound } : {} });
    }

    // A record a record type made keeps that type's fields: a new one is an
    // error. (A copy made by an update keeps the type.)
    private newField(rec: Extract<Value, { kind: "record" }>, key: string): string {
        const type = this.declaredTypes.get(rec);
        if (type?.kind !== "record") return key;
        const near = didYouMean(key, rec.v.map(([k]) => k));
        throw new APNError("runtime", `${valueToString(type)} has no field '${key}'`, {
            hint: near ? `did you mean '${near}'?` : `a record its type made keeps its fields; copy it to add one: [_: record, ${key}: value]`,
        });
    }
    // A copy keeps the record's type and which of its fields are bound.
    private keepType(from: Value, to: Value): Value {
        const type = this.declaredTypes.get(from);
        if (type) this.declaredTypes.set(to, type);
        if (from.kind === "record" && from.bound && to.kind === "record" && !to.bound) to.bound = from.bound;
        return to;
    }
    private missingField(rec: Extract<Value, { kind: "record" }>, key: string): never {
        const near = didYouMean(key, rec.v.map(([k]) => k));
        throw new APNError("runtime", `record has no field '${key}'`, {
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
            // A type taking no parameters names a kind of type (typeOf (x -> x)
            // == Function); one taking some is not a type of values until
            // given them (typeOf [1] == List Int, not List).
            const bare = (t: Value) => t.kind === "type" && !t.arguments?.length && !t.description && !t.variable && !t.choices && !this.typeArity(t);
            const kind = (t: Value) => t.kind === "functionType" ? "Function" : t.kind === "type" ? t.name : undefined;
            if ((bare(x) || bare(y)) && x.kind !== "list" && y.kind !== "list") {
                if (x.kind === "type" && y.kind === "type" && x.family && y.family) return x.family === y.family;
                return kind(x) === kind(y);
            }
            // Types with variables, functions or only a description compare by
            // their text, variables renamed in order; others structurally.
            const loose = (t: Value) => t.kind === "functionType" || t.kind === "type" && !!t.description || this.hasVariables(t);
            // Others are equal when they have the same values (Int | String
            // == String | Int, List Int == [] | Int :: List Int).
            if (!loose(x) && !loose(y)) return this.sameType(x, y) || this.within(x, y) && this.within(y, x);
            return canonicalTypeText(this.writtenType(x)) === canonicalTypeText(this.writtenType(y));
        }
        a = this.dataValue(a); b = this.dataValue(b);
        // Endless lists of types ([Int..]) compare as types, so they end.
        if ((this.repeatedType(a) || this.repeatedType(b)) && this.isTypeValue(a) && this.isTypeValue(b)) return this.sameType(a, b);
        // (A record is its pairs, in order: [x = 1] == [["x", 1]].)
        const pairs = (v: Value) => this.isList(v) || v.kind === "record" || v.kind === "hashmap";
        if (pairs(a) && pairs(b)) {
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
                return a.tag === bv.tag && a.family?.name === bv.family?.name && (!(a.family?.base || bv.family?.base) || a.family === bv.family) &&
                    this.equals({ kind: "list", v: a.v }, { kind: "list", v: bv.v });
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
        // Applied as written (f x in the program), a type takes only its
        // parameters: a value is ascribed (x : T).
        const written = this.writtenApplication;
        this.writtenApplication = false;
        // A lazy 0-param def used as a function (`f = g; f 1`) is a thunk — run it.
        f = this.force(f);
        const made = this.asWritten.get(f);
        // A written list of types makes a list of them, as .[ ] does.
        if (made) {
            this.writtenApplication = written && !this.isList(made.made);
            return this.writtenValue(f, this.isList(made.made) ? this.templateList(made.made, arg) : this.apply(made.made, arg));
        }
        // A value that is not a function applies as get gives it (xs 2 is
        // get xs 2); clauses for get in scope extend it.
        if (!CALLABLE_KINDS.has(f.kind)) {
            // A Bool selects by the prelude's clauses whatever get is in scope.
            const get = this.extended("get", f) ?? (f.kind === "bool" ? this.preludeBindings.get("get") : undefined);
            return get ? this.apply(this.apply(get, f), arg) : this.builtinGet(f, arg);
        }
        switch (f.kind) {
            // A function type takes no value either: f : Int -> Int makes a contract.
            case "functionType": {
                const { message, hint } = typeApplied(typeToString(f));
                throw new APNError("runtime", message, { hint });
            }
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
                const parameter = this.typeParameter(f, arg);
                if (parameter) return parameter;
                // A type takes types, never a value: Int32 5, or map Int32 xs, is
                // an error, as applying any name to more than it takes is; a
                // value is made a member by ascription (x : Int32).
                if (!CONSTRUCTING_TYPES.has(f.name)) {
                    // (Its hint writes the parameters it still takes: HashMap _ _.)
                    const missing = Math.max(0, (f.alias ? 0 : this.typeParameters(f.name)) - (f.arguments?.length ?? 0));
                    const { message, hint } = typeApplied(typeToString(f), typeToString(f) + " _".repeat(missing));
                    throw new APNError("runtime", message, { hint });
                }
                return this.typeValue(f, arg);
            }
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
                // A constructor given a type for each field is the type of
                // the values it makes: its logic runs only on values (Mod7 Int).
                if (f.name === "__constr" && (!f.invoke || args.every(x => this.isTypeValue(this.demand(x))))) return this.variantValue(f.tag!, args, f.family);
                const joined = this.joinedCall(f, args);
                if (joined) return joined;
                if (f.invoke) return f.invoke(args);
                if (f.name === OPEN && tailLoad) {
                    const code = this.dataValue(args[0]);
                    if (this.isList(code) && this.codeItems(code)) throw new TailLoad(code, this.env);
                }
                return this.callNative(f.name, args, f.tag);
            }
            case "clauseFn": {
                const raw = [...f.applied, arg];
                if (raw.length < f.arity) return { ...f, applied: raw };
                // Patterns demand only the structure they inspect. Shared
                // argument thunks prevent repeated effects across fallthrough.
                // The definition name is the first binding in a named clause:
                // the original function, even when applying a partial call.
                const joined = this.joinedCall(f, raw);
                if (joined) return joined;
                const self = f.name !== "<lambda>" ? f.env.map.get(f.name) : undefined;
                const chosen = this.choose(f.clauses, raw, f.env, self && [f.name, self]);
                if (chosen) {
                    const { clause, child } = chosen;
                    // Overloads that differ only in result type: the context of
                    // the result chooses (Int (read "3")).
                    const choices = this.resultOverloads(f).get(clause);
                    if (choices) return { kind: "pending", step: { op: "call", fn: f, args: raw, choices } };
                    if (tail) return new TailCall(clause.body, child);
                    if (probe) return this.defer(() => {
                        const caller = this.env;
                        this.env = child;
                        try { return this.eval(clause.body); } finally { this.env = caller; }
                    });
                    const caller = this.env;
                    this.env = child;
                    try { return this.eval(clause.body); } finally { this.env = caller; }
                }
                if (f.fallback) return raw.reduce((g: Value, x) => this.apply(g, x), f.fallback);
                if (probe) return { kind: "nomatch" };
                throw new APNError(
                    "runtime",
                    `no clause of '${f.name}' matches the given arguments`,
                    { hint: "the definition's patterns don't cover this input" },
                );
            }
            default: throw new APNError("runtime", `cannot call a non-function (${f.kind})`);
        }
    }

    private isBuiltinMatch(v: Value | undefined): boolean {
        return v?.kind === "native" && v.name === "intrinsics.match" && v.applied.length === 0;
    }
    // A match against written alternatives: the most specific whose pattern and
    // guard fit, as among a function's clauses (see clausePlaces),
    // gives its body, evaluated in place of the match. The value is one lazy
    // argument shared by every alternative tried.
    private coreMatch({ value, alternatives }: CoreMatch): TailCall {
        let ranked = rankedAlternatives.get(alternatives);
        // Only a constructor pattern's rank depends on the value.
        if (!ranked) {
            const dynamic = alternatives.some(a => a.params[0].p === "constr");
            ranked = dynamic ? null : this.ranked(alternatives, a => LITERAL_PATTERNS.has(a.params[0].p) ? 1 : 0, clausePlaces(alternatives, this.containsPattern));
            rankedAlternatives.set(alternatives, ranked);
        }
        // A literal pattern tried first demands the value at once.
        const first = (ranked ?? alternatives)[0].params[0];
        const argument: Value = LITERAL_PATTERNS.has(first.p) ? this.matchedValue(value) : { kind: "thunk", body: value, env: this.env };
        const chosen = this.choose(alternatives, [argument], this.env, undefined, ranked ?? undefined);
        if (chosen) return new TailCall(chosen.clause.body, chosen.child);
        throw new APNError("runtime", "non-exhaustive match: no alternative fits this value");
    }
    // Whether truthy here is the truthy intrinsic, as the prelude binds it.
    private namesTruthy(): boolean {
        const bound = this.env.get("truthy"), truthy = bound && this.reference(bound);
        return truthy?.kind === "native" && truthy.name === "intrinsics.truthy" && !truthy.applied.length;
    }
    private preludeSelection({ value }: CoreMatch): boolean {
        const get = this.extended("get", mkBool(true));
        if (get && get !== this.preludeBindings.get("get")) return false;
        return value.t === "bool" || this.namesTruthy();
    }
    // A matched value demanded at once: truthy x with the prelude's truthy
    // is x's truth, taken in place.
    private matchedValue(value: Expr): Value {
        if (value.t === "app" && value.f.t === "var" && value.f.name === "truthy" && this.namesTruthy()) {
            return mkBool(this.truthy(this.eval(value.a)));
        }
        return this.eval(value);
    }
    // The clause these arguments take (a match's alternatives are clauses of
    // one parameter): the most specific whose patterns and guard fit (see
    // clausePlaces), and the scope its body runs in. Patterns are ranked
    // and matched in the scope they were written in.
    private choose<C extends { params: Pattern[]; guard?: Expr }>(clauses: C[], args: Value[], scope: Env, self?: [string, Value], ranked?: C[]): { clause: C; child: Env } | undefined {
        for (const clause of clauses) this.typesAfterValues(clause.params, scope, clause);
        const caller = this.env;
        this.env = scope;
        try {
            const order = ranked ?? this.ranked(clauses, c => c.params.reduce((score, p, i) => score + this.patternScore(p, args[i]), 0), clausePlaces(clauses, this.containsPattern));
            for (const clause of order) {
                this.env = scope;
                const binds = new Map<string, Value>(self ? [self] : []);
                let fits = true;
                for (let i = 0; fits && i < clause.params.length; i++) fits = this.matchPattern(clause.params[i], args[i], binds);
                if (!fits) continue;
                const child = binds.size ? new Env(scope) : scope;
                for (const [k, v] of binds) child.setLocal(k, v);
                this.env = child;
                if (clause.guard && !this.truthy(this.eval(clause.guard))) continue;
                return { clause, child };
            }
            return undefined;
        } finally { this.env = caller; }
    }

    // Items by score, highest first; among equals, in their places (clauses:
    // the most specific first, see clausePlaces), else in their order.
    private ranked<T>(items: T[], score: (item: T) => number, places?: number[]): T[] {
        return items.map((item, index) => ({ item, place: places?.[index] ?? index, score: score(item) }))
            .sort((a, b) => b.score - a.score || a.place - b.place).map(x => x.item);
    }

    // get or with, when clauses in scope extend the builtin one.
    // (The prelude's own clauses for get take only a Bool: any other value
    // goes to the builtin get directly.)
    private extended(name: "get" | "with", of?: Value): Value | undefined {
        const f = this.env.get(name);
        if (!f) return undefined;
        if (this.joins(f)) return f;
        if (name === "get" && f === this.preludeBindings.get("get") && of?.kind !== "bool") return undefined;
        return f.kind === "clauseFn" && f.fallback ? f : undefined;
    }
    // xs i = v binds xs to with xs i v: the builtin's copy, or what clauses for with give.
    private assigned(collection: Value, key: Value, value: Expr): Value {
        const w = this.extended("with");
        return w ? this.apply(this.apply(this.apply(w, collection), key), this.delay(value)) : this.assignItem(collection, key, value);
    }

    // How many arguments a function takes before it runs (undefined for a value).
    // A visible binding's arity, if it is a function already known as one: a
    // thunk is read only when it is a field of another value (an alias, (+) =
    // intrinsics.add), never run.
    private knownArity(v: Value): number | undefined {
        if (v.kind === "thunk" && v.value === undefined && v.body.t !== "recordAccess") return undefined;
        try { return this.arity(v); } catch (error) { if (error instanceof APNError) return undefined; throw error; }
    }
    private arity(v: Value): number | undefined {
        v = this.force(v);
        if (v.kind === "native" || v.kind === "clauseFn") return v.arity - v.applied.length;
        return v.kind === "closure" ? v.params.length : undefined;
    }

    // The builtin get: indexing a list (by position, a list or record of
    // positions, or an association key), a record (by key or position; given
    // fields, a copy with them) or a HashMap.
    builtinGet(f: Value, arg: Value): Value {
        if (isNumeric(f)) throw new APNError("runtime", "cannot apply a number", {
            hint: "use a type constructor such as `Int`, or replace a default inside a template",
        });
        if (["string", "char", "bool"].includes(f.kind)) throw new APNError("runtime", `cannot apply a ${f.kind}`, {
            hint: "use a type constructor or replace a default inside a template",
        });
        if (CALLABLE_KINDS.has(f.kind)) throw new APNError("runtime", "get takes a value, not a function");
        switch (f.kind) {
            case "hashmap": return this.mapLookup(f, this.demand(arg));
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
                // Fields given by name, or all of them in order (r [10] is r
                // [x = 10]): a copy with them, exactly as by field assignment
                // (model [name = n]; Vector3 [x : Int] is Vector3.x = Int). A
                // record's value is made by ascription ([] : Vector3).
                if (carg.kind === "list" || carg.kind === "record") {
                    return this.assignFields(f, this.givenFields(f, carg).map(([key, value]) => [key, this.demand(value)]));
                }
                if (carg.kind === "int") {
                    let i = carg.v;
                    if (i < 0n) i += BigInt(f.v.length);
                    if (i < 0 || i >= f.v.length) {
                        throw new Error(`Runtime: index ${carg.v} out of range (len ${f.v.length})`);
                    }
                    return mkList([mkStr(f.v[Number(i)][0]), f.v[Number(i)][1]]);
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

    // Source text as statements, its spacing read loosely (it is generated,
    // or written inside a string).
    private readSource(text: string, file: string): Expr[] {
        const loose = getLooseSpacing();
        setLooseSpacing(true);
        let program: TopLevel[];
        try { program = parse(text, file); } finally { setLooseSpacing(loose); }
        return this.statementItems(program);
    }
    // A program's statements as a block's (or code's items).
    private statementItems(program: TopLevel[]): Expr[] {
        return program.map(tl => {
            if (tl.t === "def") return { t: "stmDef", name: tl.name, clauses: tl.clauses };
            if (tl.t === "type") return { t: "typeDef", def: tl.def };
            return tl.t === "expr" ? tl.value : tl;
        });
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
                    if (!v.value) {
                        v.value = mkList(v.exprs.map((body) => this.writtenAs({ kind: "thunk", body, env }, { expr: body, env })));
                        this.literalItems.set(v.value, v.exprs);
                    }
                    v = v.value;
                } else if (v.kind === "thunk" || v.kind === "deferred") {
                    if (v.value !== undefined) { v = v.value; continue; }
                    if (v.busy) {
                        // An unproductive fixed point diverges, but remains interruptible
                        // (a browser page, which cannot wait, reports it).
                        if (typeof SharedArrayBuffer === "undefined") throw new APNError("runtime", "a value depends on itself", { hint: "a cell's new contents read the cell after set replaced them: read it first, through a typed (List xs) parameter" });
                        const sleep = new Int32Array(new SharedArrayBuffer(4));
                        for (;;) { checkInterrupt(); Atomics.wait(sleep, 0, 0, 20); }
                    }
                    v.busy = true;
                    pending.push(v);
                    if (v.kind === "deferred") v = v.compute!();
                    else {
                        const old = this.env;
                        this.env = v.env!;
                        try { v = this.eval(v.body); } finally { this.env = old; }
                    }
                } else break;
            }
            for (const thunk of pending) {
                thunk.value = v;
                if (thunk.kind === "thunk") thunk.env = undefined;
                else thunk.compute = thunk.describes = undefined;
            }
            // Inner thunks first: a definition's (names) names what it gives
            // (its value already set, so naming one that holds itself, x =
            // x :: 1, meets it), and those forced through it see the name.
            for (const thunk of [...pending].reverse()) {
                if (thunk.kind === "thunk" && thunk.names) v = this.namedValue(thunk.names, this.reference(v), thunk.body);
                thunk.value = v;
            }
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
        // A record is the list of its [key, value] pairs, as a HashMap is.
        if (v.kind === "record") return v.v.length ? { head: mkList([mkStr(v.v[0][0]), v.v[0][1]]), tail: { ...v, v: v.v.slice(1) } } : null;
        if (v.kind === "hashmap") return this.cell(mkList([...v.entries.values()].map(([key, value]) => mkList([key, value]))));
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

    // How a list literal's item was written: its expression, the scope it was
    // written in, and the names it bound if it is a binding. A list's code is
    // its items as written (one without, such as an item map made, is its
    // value), so code is edited as any list is: reverse and take keep it, ++
    // joins it (appendCode) and an item update replaces an item (setIndex).
    private writtenItems = new WeakMap<Value, Written>();
    private writtenAs(value: Value, item: Written): Value {
        this.writtenItems.set(value, item);
        return value;
    }
    // How an item was written, through the names it was passed by (x :: acc
    // in a fold takes the item x names).
    private written(value: Value): Written | undefined {
        for (let depth = 0; depth < 64; depth++) {
            const item = this.writtenItems.get(value);
            if (item || value.kind !== "thunk" || value.body.t !== "var") return item;
            const named = value.env?.get(value.body.name);
            if (!named) return undefined;
            value = named;
        }
        return undefined;
    }
    // A list literal with bindings: its items, in order, as a block's statements.
    // A record written as bindings runs them as a block does: a name it binds
    // is in scope for all of it (a function a later item defines too), a
    // rebinding reads the version before it, a function's clauses join and a
    // type declares its constructors. Its fields are the names it binds, as
    // their last versions have them, in the order first bound; each is bound
    // to its value, except one declared with only its type, a slot (x : Float).
    private recordBlock(e: Extract<Expr, { t: "record" }> & { items: Expr[] }): Value {
        const outer = this.env, order: string[] = [], bound = new Set<string>();
        const slots = new Set(e.declared?.filter(key => !e.v.some(([k, x]) => k === key && x.t === "app" && x.ascribed)));
        const field = (name: string, isBound: boolean) => {
            if (!order.includes(name)) order.push(name);
            if (isBound) bound.add(name); else bound.delete(name);
        };
        this.env = new Env(outer);
        try {
            let n = 0;
            for (const item of e.items) {
                if (item.t === "typeDef") {
                    this.declare(item.def, this.env);
                    const own = this.env.bindings();
                    for (const name of [item.def.name, ...item.def.variants.map(v => v.tag)]) if (own.has(name)) field(name, true);
                    continue;
                }
                const [key, expression] = e.v[n++];
                if (key === "_") {
                    const spread = this.dataValue(this.eval(expression));
                    if (spread.kind !== "record") throw new APNError("runtime", "[..] opens a record");
                    for (const [name, value] of spread.v) { this.bindNames([[name, value]]); field(name, !!spread.bound?.has(name)); }
                    continue;
                }
                const { clauses } = item as Extract<Expr, { t: "stmDef" }>;
                // A function is defined as a block defines it (its clauses join,
                // and travel with the types they take).
                if (clauses[0].params.length) {
                    this.evalDef(key, clauses);
                    // An operator's fixity is its value's, as at the top level.
                    const fixity = this.runningFixities?.get(key), bound = this.env.get(key);
                    if (fixity && bound) this.valueFixities.set(bound, fixity);
                    field(key, true);
                    continue;
                }
                // A method's value for a type travels with the type, as a block's does (return = Some).
                if (!e.declared?.includes(key) && this.travelling(key, clauses)) { field(key, true); continue; }
                // A value is computed when used, as a list's item is; a literal
                // costs nothing, and a declared field is checked now (a slot's
                // type is known: see holdsType).
                // (A capitalized one written as a type names it, as a block's
                // definition does: G = String; [x = Float] holds Float, and
                // Y = yCombinator is a function.)
                const now = e.declared?.includes(key) || ["int", "float", "numeric", "string", "char", "bool"].includes(expression.t);
                let head = expression;
                while (head.t === "app") head = head.f;
                const typed = head.t === "var" && /^[A-Z]/.test(head.name) || ["list", "record"].includes(expression.t) || expression.t === "binop" && expression.op === "|";
                const later: Value = /^[A-Z]/.test(key) && typed ? { kind: "thunk", body: expression, env: this.env, value: undefined, names: key } : this.delay(expression);
                this.bindNames([[key, now ? this.eval(expression) : later]]);
                field(key, !slots.has(key));
            }
            const live = this.env;
            const r: Value = { kind: "record", v: order.map(name => [name, live.get(name)!]), ...bound.size ? { bound } : {} };
            this.recordCode.set(r, { exprs: e.items, env: outer });
            return r;
        } finally { this.env = outer; }
    }
    private codeList(exprs: Expr[], env: Env): Value {
        const state: CodeState = { before: new Map(), changed: new Set() };
        return mkList(exprs.map(expr => this.runItem({ expr, env }, state)));
    }
    // Run an item as written after the bindings before it: in the scope it was
    // written in, with those bindings in it (a joined list's winning over the
    // names there). Consecutive items written in one scope share one, as a
    // block's statements do (a function's clauses written as items merge).
    // A binding's item is its value; the names it binds go in state.
    private runItem(item: Written, state: CodeState): Value {
        if (state.env !== item.env || !state.scope) {
            state.env = item.env;
            state.scope = new Env(item.env);
            for (const [name, value] of state.before) state.scope.setLocal(name, value);
        }
        // What earlier joins gave it, unless the code before it now binds the name.
        for (const [name, value] of item.joined ?? []) if (!state.before.has(name)) state.scope.setLocal(name, value);
        const joined = item.joined || state.before.size ? new Map([...item.joined ?? [], ...state.before]) : undefined;
        const old = this.env;
        this.env = state.scope;
        try {
            const { expr } = item;
            // A type declaration binds its type and constructors, as a block's does.
            if (expr.t === "typeDef") {
                this.declare(expr.def, this.env);
                state.scope = this.env;
                const names = [expr.def.name, ...expr.def.variants.map(v => v.tag)].filter(name => this.env.map.has(name));
                const binds = new Map(names.map(name => [name, this.env.get(name)!]));
                for (const [name, bound] of binds) { state.before.set(name, bound); state.changed.add(name); }
                return this.writtenAs(mkList([]), { expr, env: item.env, binds, joined });
            }
            // [..] = r binds r's fields for the items after it, as a binding does
            // (one of a record an x <- m item binds runs only when the code does).
            if (isUse(expr) && !(state.running && mentions(expr.a, state.running))) {
                const opened = this.dataValue(this.delay(expr.a));
                const records = this.isList(opened) ? this.items(opened).map(v => this.dataValue(v)) : [opened];
                const binds = new Map<string, Value>();
                for (const record of records) {
                    if (record.kind !== "record") throw new APNError("runtime", "[..] opens a record");
                    for (const [name, value] of record.v) binds.set(name, value);
                }
                for (const [name, bound] of binds) { this.env.setLocal(name, bound); state.before.set(name, bound); state.changed.add(name); }
                state.scope = this.env;
                return this.writtenAs(mkList([]), { expr, env: item.env, binds, joined });
            }
            if (expr.t !== "stmDef" && expr.t !== "patDef") return this.writtenAs(this.delay(expr), { expr, env: item.env, joined });
            // x <- m: its value is the action m; x is bound when the code runs
            // (do runs m and joins x = its result before the items after it).
            if (expr.t === "patDef" && expr.eager) {
                const binds = new Map(patternVariables(expr.pattern).map(name => [name, this.defer(() => {
                    throw new APNError("runtime", `'${name}' is bound when the code runs`, { hint: "run the list with do, which runs each x <- m in turn" });
                })]));
                for (const [name, bound] of binds) { this.env.setLocal(name, bound); state.before.set(name, bound); state.changed.add(name); (state.running ??= new Set()).add(name); }
                return this.writtenAs(this.delay(expr.value), { expr, env: item.env, binds, runs: true, joined });
            }
            // Some v = m takes a value apart, as a pattern binding does.
            const existing = expr.t === "stmDef" && /^[A-Z]/.test(expr.name) ? this.env.get(expr.name) : undefined;
            const pattern: Pattern | undefined = expr.t === "patDef" ? expr.pattern
                : existing && (existing.kind === "native" && existing.tag || existing.kind === "variant") && expr.t === "stmDef"
                    ? { p: "constr", tag: expr.name, args: expr.clauses[0].params } : undefined;
            const value = pattern ? this.matchItem(pattern, expr.t === "patDef" ? expr.value : (expr as Extract<Expr, { t: "stmDef" }>).clauses[0].body)
                : this.evalDef((expr as Extract<Expr, { t: "stmDef" }>).name, (expr as Extract<Expr, { t: "stmDef" }>).clauses);
            state.scope = this.env;
            const binds = new Map((pattern ? patternVariables(pattern) : [(expr as Extract<Expr, { t: "stmDef" }>).name]).map(name => [name, this.env.get(name)!]));
            for (const [name, bound] of binds) { state.before.set(name, bound); state.changed.add(name); }
            return this.writtenAs({ kind: "deferred", compute: () => value }, { expr, env: item.env, binds, joined });
        } finally { this.env = old; }
    }
    // A pattern binding's item, matched when a name it binds is first used
    // (code may read a name a list joined before it binds): its value.
    private matchItem(pattern: Pattern, written: Expr): Value {
        const scope = this.env, value = this.delay(written);
        let matched: Map<string, Value> | undefined;
        const match = (): Map<string, Value> => {
            if (matched) return matched;
            const old = this.env;
            this.env = scope;
            try {
                const binds = new Map<string, Value>();
                if (!this.matchPattern(pattern, this.force(value), binds)) throw new APNError("runtime", `the item ${patternSource(pattern)} = ... did not match its value`);
                return matched = binds;
            } finally { this.env = old; }
        };
        for (const name of patternVariables(pattern)) this.env.setLocal(name, this.defer(() => this.reference(match().get(name)!)));
        return this.defer(() => { match(); return this.reference(value); });
    }
    // The bindings a kept item makes, for the items after it.
    private keepItem(item: Value, state: CodeState): void {
        for (const [name, bound] of this.written(item)?.binds ?? []) {
            state.before.set(name, bound);
            state.scope?.setLocal(name, bound);
        }
    }
    // The items after code was joined or changed before them: one that reads a
    // name bound differently now runs again (runItem); any other is kept, its
    // value shared.
    private rerun(rest: Value, state: CodeState): Value {
        if (!state.changed.size) return rest;
        return this.defer(() => {
            const cell = this.cell(rest);
            if (cell === null) return mkList([]);
            const next: CodeState = { ...state, before: new Map(state.before), changed: new Set(state.changed) };
            const item = this.written(cell.head);
            let head = cell.head;
            if (item && mentions(item.expr, next.changed)) head = this.runItem(item, next);
            else this.keepItem(head, next);
            return { kind: "cons", head, tail: this.rerun(cell.tail, next) };
        });
    }
    // What code yields, item by item (print, reduce): a binding yields nothing,
    // and an item after an x <- m item is the block of the bindings before it
    // ending in it ([x <- m, f x] yields { x <- m; f x }; run if undecided).
    // An item's own value stays its statement's, which do runs once.
    private yielded(item: Value, bindings: Value[]): Value {
        const written = this.written(item);
        if (!written || !bindings.some(b => this.written(b)?.runs)) return item;
        // The block, run where the item is, with what earlier joins gave it.
        const block: Expr = { t: "block", stmts: [...bindings.map(b => this.written(b)!.expr), written.expr], style: "{" };
        const scope = new Env(written.env);
        for (const [name, value] of written.joined ?? []) scope.setLocal(name, value);
        return this.defer(() => {
            const old = this.env;
            this.env = scope;
            try {
                // An undecided block (of returns) is run, as the REPL runs it:
                // [x <- return 1, return x] yields 1.
                const value = this.reference(this.eval(block));
                return value.kind === "pending" ? this.runIO(value) : value;
            } finally { this.env = old; }
        });
    }
    private yields(list: Value, bindings: Value[] = []): Value {
        return this.defer(() => {
            for (let rest = list;;) {
                checkInterrupt();
                const cell = this.cell(rest);
                if (cell === null) return mkList([]);
                rest = cell.tail;
                if (this.written(cell.head)?.binds) { bindings = [...bindings, cell.head]; continue; }
                return { kind: "cons", head: this.yielded(cell.head, bindings), tail: this.yields(rest, bindings) };
            }
        });
    }
    // A record keeps the code it was written as ([x = 1] is the code x = 1,
    // and its value the record): code joins and reads it as a list.
    private recordCode = new WeakMap<Value, { exprs: Expr[]; env: Env; code?: Value }>();
    private code(value: Value): Value {
        const written = value.kind === "record" ? this.recordCode.get(value) : undefined;
        return written ? written.code ??= this.codeList(written.exprs, written.env) : value;
    }
    // The item of code that binds name last (what the code leaves it as):
    // its position, the value, and whether it binds name alone (x = ...).
    // An x <- m item binds x only when do runs the code. Only items written
    // as code are walked.
    private codeBinding(code: Value, name: string): { index: bigint; value: Value; simple: boolean } | undefined {
        let found: { index: bigint; value: Value; simple: boolean } | undefined, index = 0n;
        for (let rest = code;; index++) {
            const cell = this.cell(rest);
            if (!cell) return found;
            const item = this.written(cell.head);
            if (!item) return found;
            const value = item.binds?.get(name);
            if (value && item.runs) throw new APNError("runtime", `code binds ${name} only when it runs`, { hint: "do runs the code: x <- m binds x for the items after it" });
            if (value) {
                const e = item.expr;
                found = { index, value, simple: e.t === "stmDef" ? e.name === name : e.t === "patDef" && e.pattern.p === "var" };
            }
            rest = cell.tail;
        }
    }
    // xs ++ ys: xs's items, then ys's, which see the bindings xs's make (see
    // rerun): [x = 1] ++ [x + 1] is the code [x = 1, x + 1].
    private appendCode(xs: Value, ys: Value, before = new Map<string, Value>()): Value {
        return this.defer(() => {
            const cell = this.cell(xs);
            if (cell === null) {
                const right = this.code(this.dataValue(ys));
                if (!this.isList(right)) throw new APNError("runtime", "list append expects a list");
                return this.rerun(right, { before, changed: new Set(before.keys()) });
            }
            const binds = this.written(cell.head)?.binds;
            return { kind: "cons", head: cell.head, tail: this.appendCode(cell.tail, ys, binds ? new Map([...before, ...binds]) : before) };
        });
    }
    // The items of the literal a list was made from, while it is that list.
    private literalItems = new WeakMap<Value, Expr[]>();
    // A literal's text as written, its line breaks, indentation and comments
    // kept: from its [ to the ] matching it, its lines moved left by the
    // indentation of the line it starts on.
    private originalText(literal: Expr): string | undefined {
        const place = sourceLocations.get(literal);
        if (!place) return undefined;
        const lineStart = place.source.lastIndexOf("\n", place.start - 1) + 1;
        const indent = /^ */.exec(place.source.slice(lineStart))![0].length;
        const text = place.source.slice(place.start, place.end).split("\n")
            .map((line, n) => n ? line.replace(new RegExp(`^ {0,${indent}}`), "") : line).join("\n");
        if (text[0] !== "[") return undefined;
        let depth = 0;
        try {
            for (const token of lex(text)) {
                if (token.k !== "sym") continue;
                if (["[", "(", "{"].includes(token.v)) depth++;
                else if (["]", ")", "}"].includes(token.v) && --depth === 0) return text.slice(0, token.pos + 1);
            }
        } catch { /* text that does not lex alone is shown from its items */ }
        return undefined;
    }
    // A value's code: a list's or record's literal as written, a list's items
    // as written (an item without, as its value's code), anything else as its
    // value is shown.
    private writtenText(v: Value): string {
        const value = this.dataValue(v);
        const items = this.literalItems.get(value) ?? this.recordCode.get(value)?.exprs;
        const literal = items && literals.get(items);
        const original = literal && this.originalText(literal);
        if (original) return original;
        if (value.kind === "range" || value.kind === "floatRange" || value.kind === "rationalRange" || !this.isList(value)) return this.renderString(value);
        const ITEM = { kind: "item", min: 0, follows: -1 } as const;
        return `[${itemsText(this.items(value).map(item => {
            const written = this.written(item);
            return written ? exprToSource(written.expr, ITEM) : this.writtenText(item);
        }))}]`;
    }

    // A copy of a list with an item replaced: by a value, or by an item as
    // written, which runs as the list's code does (see runItem). The items
    // after it reading a name either binds run again (see rerun). A value
    // takes the type of its slot (the item replaced, unless given).
    setIndex(list: Value, index: bigint, value: Value, item?: Written, slot?: Value): Value {
        const actual = this.force(list);
        if (actual.kind === "list" && actual.schema) {
            if (item) {
                const old = this.env;
                this.env = item.env;
                try { value = this.demand(this.eval(item.expr)); } finally { this.env = old; }
            }
            const values = [...actual.v];
            const offset = index < 0n ? BigInt(values.length) + index : index;
            if (offset < 0n || offset >= values.length) throw new APNError("runtime", `index ${index} out of range`);
            const schema = actual.schema as Extract<Value, { kind: "type" }>;
            const [, element] = this.vectorParts(schema);
            values[Number(offset)] = this.conform(element, value);
            return { ...actual, v: values };
        }
        const original = index;
        if (index < 0n) index += BigInt(this.items(list).length);
        if (index < 0n) throw new APNError("runtime", `index ${original} out of range`);
        const prefix: Value[] = [], state: CodeState = { before: new Map(), changed: new Set() };
        for (;;) {
            checkInterrupt();
            const cell = this.cell(list);
            if (cell === null) throw new APNError("runtime", `index ${original} out of range`);
            if (index-- === 0n) {
                for (const name of this.written(cell.head)?.binds?.keys() ?? []) state.changed.add(name);
                let head: Value;
                if (item) {
                    head = this.runItem(item, state);
                    // A value takes its slot's type, as a field's does; a binding
                    // binds what it binds.
                    if (!this.written(head)?.binds) head = this.writtenAs({ kind: "deferred", value: this.assignSlot(slot ?? cell.head, this.demand(head)) }, { expr: item.expr, env: item.env });
                } else head = this.assignSlot(slot ?? cell.head, value);
                state.scope = undefined;
                let result: Value = { kind: "cons", head, tail: this.rerun(cell.tail, state) };
                for (let i = prefix.length - 1; i >= 0; i--) result = { kind: "cons", head: prefix[i], tail: result };
                return result;
            }
            prefix.push(cell.head);
            this.keepItem(cell.head, state);
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
        const realized = this.realize(value, type), given = this.dataValue(realized);
        // (A record is the list of its pairs.)
        const list = given.kind === "record" ? mkList(given.v.map(([key, field]) => mkList([mkStr(key), field])))
            : given.kind === "hashmap" ? mkList([...given.entries.values()].map(([key, value]) => mkList([key, value]))) : realized;
        if (!this.isList(list)) throw new APNError("runtime", `List constructor expects a List value`);
        const element = type.arguments?.[0];
        if (!element) return list;
        const mapped = this.mapList({ kind: "native", name: "<List>", arity: 1, applied: [], invoke: ([x]) => this.conform(element, x) }, list);
        // Marked once forced too (its outer cell is what a Mutable is given).
        const result = this.defer(() => {
            const outer = this.force(mapped);
            this.declaredTypes.set(outer, type);
            return outer;
        });
        this.declaredTypes.set(result, type);
        return result;
    }
    // The type a conversion's result has (List T, a record schema), for a
    // Mutable made from one.
    private declaredTypes = new WeakMap<Value, Value>();

    // A typed pattern (List Int xs, Option Int x) decides by the
    // value's type as the checker inferred it, as the checker decides: the
    // type recorded for the expression that made the value, found through the
    // argument's own expression and the names it was passed by. Without one
    // (code no check reached: Dynamic, or after a type error), the value
    // matches and converts as used.
    private staticTypes = new WeakMap<Value, unknown>();
    private recordedTypes = new WeakMap<Expr, unknown>();
    private recordedType(e: Expr, types: Map<string, unknown>): unknown {
        if (this.recordedTypes.has(e)) return this.recordedTypes.get(e);
        const at = sourceLocations.get(e), type = at ? types.get(`${at.file}:${at.start}`) ?? null : null;
        this.recordedTypes.set(e, type);
        return type;
    }
    private staticTypeOf(v: Value): unknown {
        const session = this.types!, bridge = session.bridge!;
        let general: unknown;
        // The most specific: a name passed through generic code has a general
        // type there (List a), the expression that made its value a concrete one.
        const consider = (type: unknown) => {
            if (!type) return false;
            if (bridge.concrete(type)) return true;
            general ??= type;
            return false;
        };
        for (let depth = 0; depth < 64; depth++) {
            if (consider(this.staticTypes.get(v))) return this.staticTypes.get(v);
            if (v.kind === "thunk") {
                const type = this.recordedType(v.body, session.valueTypes);
                if (consider(type)) return type;
                const named = v.body.t === "var" && v.env?.get(v.body.name);
                if (named) { v = named; continue; }
            }
            if ((v.kind === "thunk" || v.kind === "deferred") && v.value) { v = v.value; continue; }
            break;
        }
        return general;
    }
    // Whether a value of a typed pattern's type may match it: its type is
    // accepted where the pattern's is, as a typed parameter accepts it.
    private staticallyFits(type: Expr, v: Value): boolean {
        const bridge = this.types?.bridge;
        if (!bridge) return true;
        const target = this.types!.patternTypes.get(type), actual = target && this.staticTypeOf(v);
        return !target || !actual || bridge.fits(target, actual);
    }

    // ---- Monads: instances of map, >>=, <*> and return ----
    // Clause functions a program defines for these methods, newest last: tried
    // (newest first) before the builtin IO and list instances.
    private instances = new Map<string, Value[]>();
    // The variant families each method has an instance for (a discarded
    // statement of one with >>= makes a do-block).
    private instanceFamilies = new Map<string, Set<unknown>>();
    private loadingPrelude = true;

    // The builtin each method starts from (its IO and list instances).
    // to T x and from T x: a program's instances first (newest first), then
    // the builtin ones: String (its text, read back as parse does), JSON
    // (JSON text) and List Char (a string's characters). to of any other type
    // converts as ascription does: to Float (Money 1.2) is (Money 1.2 : Float).
    private convertTo(method: "to" | "from", target: Value, value: Value): Value {
        const own = this.instance(method, [target, value]);
        if (own) return own;
        const type = this.reference(target);
        const is = (name: string) => {
            const builtin = this.preludeBindings.get(name);
            return name === "String" || name === "Record" ? type.kind === "type" && type.name === name && !type.family && !type.alias
                : !!builtin && this.isTypeValue(type) && this.sameType(this.reference(builtin), type);
        };
        const element = this.isListType(type) && type.kind === "type" && type.arguments?.length === 1 ? this.reference(type.arguments[0]) : undefined;
        const chars = element?.kind === "type" && element.name === "Char" && !element.family && !element.alias;
        if (method === "to") {
            if (is("String")) return this.callNative("toString", [value]);
            if (is("JSON")) return standardNative(this, "toJson", [value]);
            if (chars) return standardNative(this, "chars", [value]);
            // An association list with String keys is a record's pairs, a
            // repeated key keeping its first place and last value, as in code.
            if (is("Record")) {
                const fields = new Map<string, Value>();
                for (const item of this.elements(this.demand(value))) {
                    const [key, field] = [...this.elements(this.demand(item))];
                    const name = key && this.dataValue(key);
                    if (name?.kind !== "string" || field === undefined) throw new APNError("runtime", "to Record expects [String,value] pairs", { hint: 'write each field as a pair: to Record [["x", 1]]' });
                    fields.set(name.v, field);
                }
                return { kind: "record", v: [...fields] };
            }
            // A list template ([Char], [Int,String]) converts position by position.
            if (this.isList(type) && this.isTypeValue(type)) return this.templateList(type, value);
            if (type.kind === "record" && this.isTypeValue(type)) return this.buildRecord(type, value);
            // Any other type converts as ascription does (to Int 1.0 is 1.0 : Int).
            if (type.kind === "type") return this.typeValue(type, value);
        } else {
            if (is("String")) return this.callNative("parse", [this.demand(value)]);
            if (is("JSON")) return standardNative(this, "fromJson", [value]);
            if (chars) return standardNative(this, "fromChars", [value]);
        }
        throw new APNError("runtime", `no ${method} instance for ${this.renderString(type)}`, { hint: `define one, such as \`${method} ${this.renderString(type)} x = ...\`` });
    }
    // The method a value is: its builtin ((>>=) is intrinsics.bind).
    private methodOf(v: Value): string | undefined {
        return v.kind === "native" && !v.applied.length ? METHOD_INTRINSICS.get(v.name) : undefined;
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
        this.makers.clear();
    }
    // Whether some to instance may make a type (one whose clauses all name
    // others cannot), so a value need not be offered to each.
    private makes(name: string): boolean {
        let known = this.makers.get(name);
        if (known === undefined) {
            known = (this.instances.get("to") ?? []).some(f => this.instanceTargets(f)?.has(name) !== false);
            this.makers.set(name, known);
        }
        return known;
    }
    private makers = new Map<string, boolean>();
    // The variant families a method's instances take, read from their clauses
    // (map's second parameter, the others' first), whether they were written
    // as clauses or as a value (return = Some).
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

    // An operand of a type the program defines, met by one of another type
    // that no clause of the operator took, converts the other through a to
    // instance the program gave, and the operator runs again: with
    // to Money (Float x) = Money x, Money 1.0 + 2.5 is Money 1.0 + Money 2.5.
    // Both converting is ambiguous; neither leaves the operator's own error.
    private promote(op: string, l: Value, r: Value): Value | undefined {
        if (!["+", "-", "*", "/", "%", "^", "<", ">", "<=", ">="].includes(op) || !this.instances.has("to")) return undefined;
        const family = (v: Value) => v.kind === "variant" && v.family && !v.family.base ? v.family : undefined;
        const lf = family(l), rf = family(r);
        if (!lf && !rf || lf === rf) return undefined;
        // Converted to the other's type, as a to instance for it is written.
        const target = (other: Value): Value => {
            const type = this.callNative("typeOf", [other]);
            return type.kind === "type" && type.made ? type.made : { kind: "type", name: family(other)!.name, family: family(other) };
        };
        const to = (v: Value, other: Value, f?: VariantFamily) => f && this.instance("to", [target(other), v]);
        const left = to(l, r, rf), right = to(r, l, lf);
        if (left && right) {
            throw new APNError("runtime", `ambiguous: '${op}' could convert ${lf!.name} to ${rf!.name} or ${rf!.name} to ${lf!.name}`,
                { hint: `convert one explicitly, as in \`to ${rf!.name} x\`` });
        }
        if (!left && !right) return undefined;
        const operator = this.env.get(op);
        if (!operator) return undefined;
        return this.apply(this.apply(operator, left ?? l), right ?? r);
    }

    // The first instance whose clauses accept these arguments.
    private instance(method: string, args: Value[]): Value | undefined {
        const fns = this.instances.get(method) ?? [];
        // (One whose clauses all name another type first is passed over at once:
        // to Int North = 0 is no to String.)
        const named = args[0]?.kind === "type" ? args[0].name : undefined;
        // Each argument may decide it: a curried instance (to Celsius = ...)
        // takes the first alone.
        next: for (let n = fns.length - 1; n >= 0; n--) {
            let f = fns[n];
            if (named !== undefined && this.instanceTargets(f)?.has(named) === false) continue;
            for (let i = 0; i < args.length; i++) {
                f = this.apply(f, args[i], true);
                if (f.kind === "nomatch") continue next;
            }
            return f;
        }
        return undefined;
    }

    // The type names an instance's clauses take first, when each names one.
    private instanceTargets(fn: Value): Set<string> | undefined {
        if (this.targets.has(fn)) return this.targets.get(fn);
        const f = this.force(fn);
        const firsts = f.kind === "clauseFn" ? f.clauses.map(c => c.params[0]) : [];
        const targets = firsts.length && firsts.every(p => p?.p === "constr" && !p.args.length)
            ? new Set(firsts.map(p => (p as Extract<Pattern, { p: "constr" }>).tag)) : undefined;
        this.targets.set(fn, targets);
        return targets;
    }
    private targets = new WeakMap<Value, Set<string> | undefined>();
    // return x (or throw e) in a monad: the method is overloaded on its result,
    // so the newest instance whose result is in the target monad makes it.
    private instanceIn(method: string, target: Value, x: Value): Value | undefined {
        const family = target.kind === "type" ? target.family : undefined;
        if (!family) return undefined;
        const fns = this.instances.get(method) ?? [];
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
        return at ? this.types?.resultHeads.get(`${at.file}:${at.start}`) : undefined;
    }
    // A do-block's monad as the checker inferred it (Result for a block whose
    // statements name it), as a type: undefined when it did not, or for IO.
    private checkedMonad(block: Expr): Value | undefined {
        // Looked up once per expression: most have none, and a loop asks often.
        let head = this.checkedHeads.get(block);
        if (head === undefined) {
            const at = sourceLocations.get(block);
            head = (at && this.types?.resultHeads.get(`${at.file}:${at.start}`)) || "";
            this.checkedHeads.set(block, head);
        }
        if (!head || head === "IO") return undefined;
        if (head === "List") return { kind: "type", name: "List" };
        const type = this.env.get(head), value = type && this.reference(type);
        return value?.kind === "type" && value.family ? value : undefined;
    }
    private checkedHeads = new WeakMap<Expr, string>();
    // An IO do-block's result as the checker inferred it: "a" when it did not,
    // or inferred more than one (a generic function's body).
    private checkedResult(block: Expr): string {
        const session = this.types, bridge = session?.bridge;
        const type = bridge && this.recordedType(block, session.valueTypes) as { k: string; args?: unknown[] } | null;
        const result = type?.args?.[0];
        return result !== undefined && bridge!.concrete(result) ? bridge!.text(result) : "a";
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
        if (this.isList(v) || v.kind === "record" || v.kind === "hashmap") return { kind: "type", name: "List" };
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
        // throw e: [] in a list, an action failing with e for IO (as fail does).
        const value = step.value, method = step.op;
        if (this.isIOType(target)) {
            return method === "throw"
                ? { kind: "io", result: "a", run: () => { throw new APNError("runtime", rawString(this.dataValue(value))); } }
                : { kind: "io", result: () => this.typeText(value), run: () => value };
        }
        if (this.isListType(target)) return mkList(method === "throw" ? [] : [value]);
        const made = this.instanceIn(method, target, value);
        if (made) return made;
        throw new APNError("runtime", `no ${method} instance for ${valueToString(target)}`, { hint: method === "throw" ? "define one, such as `throw _ = None`" : "define one, such as `return = Some`" });
    }

    // f applied to what m >>= f passes it; a value that is no function is an
    // error saying so (checked only when applied: None >>= f never is).
    private continueWith(f: Value, x: Value): Value {
        const g = this.demand(f);
        if (["int", "float", "rational", "complex", "string", "bool", "char", "variant", "pending", "io", "record", "hashmap", "list", "lazyList", "cons", "range"].includes(g.kind)) {
            const what = g.kind === "pending" ? "an undecided value" : isNumeric(g) ? "a number" : g.kind === "variant" && g.family ? withArticle(g.family.name)
                : g.kind === "io" ? "an action" : this.isList(g) ? "a list" : withArticle(g.kind);
            throw new APNError("runtime", `'>>=' needs a function on its right, not ${what}`, { hint: "to run it after the left side, discarding that value, use `>>`" });
        }
        return this.apply(g, x);
    }

    // m >>= f: through m's monad. f's results are realized in the same monad.
    bind(mIn: Value, f: Value): Value {
        const m = this.dataValue(mIn);
        if (m.kind === "pending") return { kind: "pending", step: { op: "bind", m, f } };
        const target = this.monadTypeOf(m);
        if (!target) throw new APNError("runtime", `'>>=' needs an action, a list or a monadic value, not a ${m.kind}`);
        if (m.kind === "io") return { kind: "io", run: () => new IOTail(this.inMonad(this.continueWith(f, this.runIO(m)), target)) };
        // Any other monad's are clauses of >>= (the prelude's for lists), given
        // f with what it returns made in m's monad.
        // (An f already made so for this monad, as rest >>= f passes it on, is
        // used as it is.)
        const given = f.kind === "thunk" || f.kind === "deferred" ? f.value ?? f : f;
        const k: Value = given.kind === "native" && given.name === "<bind>" && this.bindTargets.get(given) === this.headOf(target) ? given
            : { kind: "native", name: "<bind>", arity: 1, applied: [], invoke: ([x]) => this.inMonad(this.continueWith(f, x), target) };
        this.bindTargets.set(k, this.headOf(target));
        if ((this.isList(m) || m.kind === "record" || m.kind === "hashmap") && this.preludeListBind()) return this.concatMapList(m, k);
        const result = this.instance(">>=", [m, k]);
        if (result) return result;
        throw new APNError("runtime", `no >>= instance for ${valueToString(target)}`, { hint: "define one, such as `Some x >>= f = f x`" });
    }

    private bindTargets = new WeakMap<Value, string | undefined>();
    // Whether a list's >>= is the prelude's clauses, no instance after them
    // taking a list first: then it runs in place, as they do.
    private preludeListBind(): boolean {
        const instances = this.instances.get(">>=") ?? [];
        return instances.slice(1).every(fn => {
            const f = this.force(fn);
            return f.kind === "clauseFn" && f.clauses.every(c => c.params[0]?.p === "constr" && !this.builtinType(c.params[0].tag));
        });
    }
    // xs >>= k as the prelude's clauses make it: k's lists joined, lazily.
    private concatMapList(list: Value, k: Value): Value {
        return this.defer(() => {
            const cell = this.cell(list);
            return cell === null ? mkList([]) : this.dataValue(this.append(this.apply(k, cell.head), this.concatMapList(cell.tail, k)));
        });
    }
    // What m >>= f's f gives, made in m's monad, where it must be a value: an
    // action after an action (print 1 >> 2 is an error, as { print 1; 2 } is).
    private inMonad(v: Value, target: Value): Value {
        const made = this.realize(v, target), monad = this.monadTypeOf(this.force(made));
        if (monad && this.headOf(monad) === this.headOf(target)) return made;
        // [], the unit (what print yields), ends an action: print 1 >> [].
        if (this.headOf(target) === "IO" && this.isList(made) && this.cell(made) === null) return made;
        const head = this.headOf(target) ?? "monad";
        throw new APNError("runtime", `'>>=' needs a function giving ${head === "IO" ? "an action" : withArticle(head)}, not ${this.typeText(made)}`, {
            hint: head === "IO" ? "end the chain or block with an action, such as `return x`" : `give ${withArticle(head)} value, such as \`return x\``,
        });
    }

    // map f m: lazily over a list, an instance, or derived from m's monad (m >>= (x -> return (f x))).
    mapValue(f: Value, mIn: Value): Value {
        const m = this.dataValue(mIn);
        if (m.kind === "io") return { kind: "io", run: () => this.apply(f, this.runIO(m)) };
        if (this.isList(m) || m.kind === "record" || m.kind === "hashmap") return this.mapList(f, m);
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
        if (mf.kind !== "pending") {
            const result = this.instance("<*>", [mf, mx]);
            if (result) return result;
        }
        return this.bind(mf, { kind: "native", name: "<ap>", arity: 1, applied: [], invoke: ([f]) => this.mapValue(f, mx) });
    }


    // What a do-block yields, known without running it when its last statement
    // reads no name the block binds: { print 1; return 5 } yields an Int, its
    // last statement evaluated (an action made, never run) where the block runs.
    // A definition last yields []; one reading a bound name (x <- e; return x)
    // yields what the checker inferred, when it inferred one type.
    private blockResult(block: Extract<Expr, { t: "block" }>, here: Env, start: number): () => string {
        return () => {
            const last = block.stmts[block.stmts.length - 1];
            if (!last || last.t === "stmDef" || last.t === "typeDef" || last.t === "patDef" && !last.eager) return "[]";
            const bound = new Set(block.stmts.slice(start).flatMap(s => s.t === "patDef" ? patternVariables(s.pattern) : s.t === "stmDef" ? [s.name] : []));
            if (last.t === "patDef" || mentions(last, bound)) return this.checkedResult(block);
            const caller = this.env;
            this.env = here;
            try {
                const made = this.demand(this.eval(last));
                if (made.kind === "io") return typeof made.result === "function" ? made.result() : made.result ?? "a";
                if (made.kind === "pending" && made.step.op === "return") return this.typeText(made.step.value);
                return "a";
            } catch (error) {
                if (error instanceof APNError) return "a";
                throw error;
            } finally { this.env = caller; }
        };
    }
    // A do-block in a monad other than IO: its statements chained with >>=.
    private desugarDo(e: Extract<Expr, { t: "block" }>, env: Env, start: number, target: Value, first?: Value): Value {
        if (this.isIOType(target)) return { kind: "io", result: this.blockResult(e, env, start), run: () => this.runDoBlock(e, env, start, first) };
        const lastAction = (what: string): never => {
            throw new APNError("runtime", `the last statement of a do-block must be an action, not ${what}`, { hint: "end the block with `return x`" });
        };
        const go = (scope: Env, from: number, given?: Value): Value => {
            const caller = this.env;
            this.env = scope;
            try {
                for (let i = from; i < e.stmts.length; i++) {
                    const s = e.stmts[i], last = i === e.stmts.length - 1;
                    if (declaresNames(e)) this.readPatterns(s);
                    if (s.t === "stmDef") { this.evalDef(s.name, s.clauses); continue; }
                    if (s.t === "typeDef") { this.declare(s.def, this.env); continue; }
                    if (s.t === "patDef" && !s.eager) { this.evalPatBinding(s); continue; }
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
                    const next = i + 1, binding = s, here = this.env;
                    return this.bind(this.realize(m, target), { kind: "native", name: "<do>", arity: 1, applied: [], invoke: ([x]) => {
                        let child = new Env(here);
                        if (binding.t === "patDef") {
                            const old = this.env;
                            this.env = child;
                            try { this.bindResult(binding, x); child = this.env; } finally { this.env = old; }
                        }
                        return go(child, next);
                    } });
                }
                // A binding last is followed by {}: [], a value of a list monad only.
                const unit = mkList([]);
                return this.sameMonad(unit, target) ? unit : lastAction(e.stmts.length ? "a binding" : "nothing");
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
        this.bindNames(binds);
        return v;
    }

    append(xs: Value, ys: Value): Value {
        return this.defer(() => {
            const cell = this.cell(xs);
            if (cell === null) {
                const right = this.code(this.dataValue(ys));
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
        // A value a program says how to write (to String (Frac n d) = ...)
        // shows as that text, wherever it is: print, the REPL, inside a list.
        const own = this.makes("String") ? this.instance("to", [{ kind: "type", name: "String" }, v]) : undefined;
        if (own) {
            const text = this.demand(own);
            if (text.kind !== "string") throw new APNError("runtime", `to String gave ${this.typeText(text)}, not a String`);
            emit(text.v, v.kind);
            return;
        }
        // Track nested values, not successive spine cells: 1:xs may stream
        // forever, but a list containing itself cannot render a first element.
        if (ancestors.has(v)) throw new APNError("runtime", "cannot display a cyclic nested value");
        ancestors.add(v);
        try {
            if (v.kind === "type" || this.asWritten.has(v)) {
                // Its arguments show as source writes them: Vect 2 (Option Int),
                // a written type's as written (Pairs 2 Int).
                const written = this.asWritten.get(v), type = v as Extract<Value, { kind: "type" }>;
                emit(written?.name ?? type.description ?? (this.isAny(type) ? "_" : type.name), "type");
                for (const argument of written?.args ?? type.arguments ?? []) {
                    const shown = this.inspectType(argument), wrap = compoundArgument(shown);
                    emit(wrap ? " (" : " ");
                    this.render(shown, emit, false, ancestors);
                    if (wrap) emit(")");
                }
            } else if (v.kind === "hashmap") {
                // (Its association list, as a record shows its fields.)
                this.render(mkList([...v.entries.values()].map(([key, value]) => mkList([key, value]))), emit, false, ancestors);
            } else if (this.repeatedType(v)) {
                emit("[");
                this.render(this.repeatedType(v)!, emit, false, ancestors);
                emit("..]");
            } else if (this.isList(v)) {
                // Its ',' takes a space when an item has one or two are literals
                // of different kinds (itemsText), so the items are held until
                // that is known, the list ends, or sixteen (or 4096 characters)
                // are held: a list streams after that.
                emit("[");
                type Part = [string, Parameters<typeof emit>[1]] | null;
                let separator: string | undefined, item = "", held: Part[] = [], heldLength = 0, count = 0;
                const kinds = new Set<string>();
                const spaced = (text: string) => {
                    const kind = literalKind(text);
                    if (kind) kinds.add(kind);
                    return spacedItem(text) || kinds.size > 1;
                };
                const decide = (spaced: boolean) => {
                    separator = spaced ? ", " : ",";
                    for (const part of held) part ? emit(...part) : emit(separator);
                    held = [];
                };
                const out = (text: string, kind?: Parameters<typeof emit>[1]) => {
                    if (separator !== undefined) return emit(text, kind);
                    held.push([text, kind]);
                    item += text;
                    if ((heldLength += text.length) > 4096) decide(spacedItem(item));
                };
                // A list shows what its code yields (see yields).
                const bindings: Value[] = [];
                for (const entry of this.elements(v)) {
                    if (this.written(entry)?.binds) { bindings.push(entry); continue; }
                    const element = this.yielded(entry, bindings);
                    if (count++) separator === undefined ? held.push(null) : emit(separator);
                    item = "";
                    this.render(element, out, false, ancestors);
                    if (separator === undefined && (spaced(item) || count >= 16)) decide(spaced(item));
                }
                if (separator === undefined) decide(false);
                emit("]");
            } else if (v.kind === "record") {
                emit("[");
                v.v.forEach(([key, val], i) => {
                    if (i) emit(", ");
                    emit(keySource(key), "key");
                    // A zero-argument function whose call runs statements (a
                    // block, f = { print "hi" }) shows as one, so showing a module
                    // runs nothing; any other (m0 = (5 : Int), x = inc 3) gives
                    // its value, as a list's item does.
                    const field = this.force(val);
                    emit(slotField(v, key, field, x => this.force(x)) ? " : " : " = ");
                    if (field.kind === "closure" && !field.params.length && field.body.t === "block") emit(valueToString(field), field.kind);
                    else this.render(field, emit, false, ancestors);
                });
                emit("]");
            } else if (v.kind === "pending") {
                // Inside another value it shows as its source (return "a").
                emit(this.undecidedText(v, ancestors.size > 1), "pending");
            } else if (v.kind === "variant" && v.family?.base && v.v.length === 1) {
                // A named subtype's value is its base's (5 : Count prints 5).
                this.render(v.v[0], emit, raw, ancestors);
            } else if (v.kind === "variant") {
                // Arguments show as source writes them: Some (Some 1).
                emit(v.tag, "variant");
                for (const arg of v.v) {
                    const shown = this.demand(arg);
                    const wrap = compoundArgument(shown);
                    emit(wrap ? " (" : " ");
                    this.render(shown, emit, false, ancestors);
                    if (wrap) emit(")");
                }
            } else if (v.kind === "clauseFn" && v.applied.length || v.kind === "closure" && v.applied?.length && !(v.whole ?? v.params)[0].startsWith("$")) {
                emit(this.residualText(v), v.kind);
            } else if (this.methodOf(v)) {
                emit(this.methodText(this.methodOf(v)!), v.kind);
            } else if (v.kind === "io") {
                // An action has no value to show until it runs, as in Haskell:
                // showing it is a mistake (print (readFile "f") for its text).
                throw new APNError("runtime", ACTION_SHOWN.message, { hint: ACTION_SHOWN.hint });
            } else emit(raw ? rawString(v) : valueToString(v), v.kind);
        } finally {
            ancestors.delete(v);
        }
    }

    // The type of a value as typeOf shows it: Int, [String], Some Int.
    typeText(v: Value): string { return this.renderString(this.callNative("typeOf", [v])); }

    // How specifically a pattern accepts an argument, for choosing among
    // clauses: literals first, then exact types, then conversions.
    // A type's bare name as a pattern matches each type within it, as <=
    // compares types (Int matches typeOf 5, List typeOf [1,2], Number Int, a
    // declared Shape typeOf (Circle 1)): "same" for the type itself, "within"
    // for one it holds; undefined for any other pattern.
    private bareType(p: Pattern, v: Value): "same" | "within" | false | undefined {
        if (p.p !== "constr" || p.args.length) return undefined;
        const bound = this.builtinType(p.tag) ? { kind: "type", name: p.tag } as Value : this.env.get(p.tag), named = bound && this.reference(bound);
        if (named?.kind !== "type") return undefined;
        const given = this.demand(v);
        if (!(given.kind === "type" || given.kind === "functionType" || this.isList(given)) || !this.isTypeValue(given)) return false;
        return this.equals(given, named) ? "same" : this.within(given, named) ? "within" : false;
    }
    // The type a pattern of a type applied to exactly its parameters, each
    // a type itself ((List Int), (Pairs (List Int)), _ any type), names;
    // undefined where the pattern binds a name or is no such type.
    private closedType(p: Pattern): Value | undefined {
        if (p.p === "wildcard") return { kind: "type", name: "$any" };
        if (p.p !== "constr") return undefined;
        const bound = this.builtinType(p.tag) && !PRELUDE_TYPES.has(p.tag) ? { kind: "type", name: p.tag } as Value : this.env.get(p.tag);
        const head = bound && this.reference(bound);
        if (head?.kind !== "type" || head.arguments?.length) return undefined;
        if (p.args.length && p.args.length !== (head.alias?.parameters.length ?? this.typeParameters(p.tag))) return undefined;
        const args = p.args.map(arg => this.closedType(arg));
        if (args.some(arg => !arg)) return undefined;
        try { return this.reference(args.reduce<Value>((t, arg) => this.apply(t, arg!), head)); }
        catch (error) { if (error instanceof APNError) return undefined; throw error; }
    }
    // How an argument fits a pattern, the first thing clauses are ordered by
    // (see choose): 1 when it is, as it is, a value of the type or literal the
    // pattern names; 0 when the pattern names none, or converts it losslessly;
    // -1 when a to instance converts it; -1000 when it cannot match. Among
    // equals the more specific pattern comes first (clausePlaces): so 0 before
    // (x : Int) before (x : Number), and (x : Int) takes 5 before (x : Int8)
    // would convert it, while (x : Int8) still takes it before _.
    private patternScore(pattern: Pattern, arg: Value): number {
        if (["int", "float", "bool", "string", "char"].includes(pattern.p)) return 1;
        const bare = this.bareType(pattern, arg);
        if (bare !== undefined) return bare ? 1 : -1000;
        // Only a pattern naming a type reads whether its argument is one.
        const closed = pattern.p === "constr" && pattern.args.length ? this.closedType(pattern) : undefined;
        const given = closed && this.reference(arg);
        if (given && (given.kind === "type" || given.kind === "functionType" || this.isList(given) && this.isTypeValue(given))) {
            return this.sameType(closed!, given) || this.within(given, closed!) ? 1 : -1000;
        }
        // Only a constructor pattern looks at its argument. One a program
        // declared converts nothing: a value it does not take fails it when
        // tried, so it counts as taking its argument as it is, which is not
        // read (Box a + b takes Box 1 + boom without forcing boom).
        if (pattern.p !== "constr") return 0;
        const declared = !pattern.typed && !this.builtinType(pattern.tag) ? this.env.get(pattern.tag) : undefined;
        const made = declared && this.reference(declared);
        if (made && made.kind === "native" && made.name === "__constr" && made.tag === pattern.tag) return 1;
        const named = this.reference(arg);
        if (named.kind === "variant" && named.family?.base) {
            if (pattern.tag === named.family.name) return 1;
            if (this.builtinType(pattern.tag)) arg = named.v[0];
        }
        const binding = this.env.get(pattern.tag);
        if (binding && this.counted(this.reference(binding))) return this.isList(this.dataValue(arg)) ? 1 : -1000;
        if (!this.builtinType(pattern.tag)) {
            // A program's own type takes a value of it as it is; a constructor
            // pattern, a value that constructor made.
            const type = binding && this.reference(binding);
            if (pattern.typed && type && type.kind === "type") return this.belongsToType(type, arg) ? 1 : 0;
            const made = this.dataValue(arg);
            return made.kind === "variant" && made.tag === pattern.tag ? 1 : 0;
        }
        // An undecided call fits a typed pattern as an exact type would.
        const undecided = this.reference(arg);
        if (undecided.kind === "pending" && undecided.step.op === "call") return 1;
        const value = pattern.tag === "Mutable" ? this.reference(arg) : pattern.tag === "Type" ? this.demand(arg) : this.dataValue(arg);
        if (SCALAR_TYPES.has(pattern.tag) && this.builtinValue(pattern.tag, value)) return -1;
        if (!NUMERIC_TYPES.includes(pattern.tag)) return this.matchesValueType(pattern.tag, value) ? 1 : -1000;
        if (!isNumeric(value)) return -1000;
        if (matchesType(pattern.tag, value)) return 1;
        if (NUMERIC_CLASSES.has(pattern.tag)) return -1000;
        try { castNumeric(pattern.tag, value); return 0; } catch { return -1000; }
    }
    // Whether a typed (or bare) type pattern takes every value another pattern
    // does, by the types they name (see clausePlaces): a literal of it, or a
    // type within it (Int within Number, Money within Float). undefined for a
    // pattern naming no type.
    private readonly containsPattern = (q: Pattern, p: Pattern): boolean | undefined => {
        const typeOf = (x: Pattern): Value | undefined => {
            if (x.p !== "constr" || !(x.typed && x.args.length === 1 || !x.args.length)) return undefined;
            const bound = this.env.get(x.tag), t = bound && this.reference(bound);
            return t && t.kind !== "variant" && this.isTypeValue(t) ? t : undefined;
        };
        const t = typeOf(q);
        if (!t) return undefined;
        const literal: Value | undefined = p.p === "int" ? mkInt(p.v) : p.p === "float" ? { kind: "float", v: p.v }
            : p.p === "string" ? { kind: "string", v: p.v } : p.p === "char" ? { kind: "char", v: p.v } : p.p === "bool" ? mkBool(p.v) : undefined;
        if (literal) return q.p === "constr" && !!q.args.length && this.belongsToType(t, literal);
        const holds = (q as { args: Pattern[] }).args.length > 0;
        // A constructor's pattern (Circle r, None) is within its type's.
        if (p.p === "constr" && !p.typed) {
            const bound = this.env.get(p.tag), made = bound && this.reference(bound);
            const family = made?.kind === "native" || made?.kind === "variant" ? made.family : undefined;
            if (family) return holds && t.kind === "type" && t.family === family;
        }
        const s = typeOf(p);
        if (!s || holds !== (p as { args: Pattern[] }).args.length > 0) return false;
        // A named type's pattern is within its base's, which takes its values
        // too (Money within Float), as a type within another is.
        for (let x: Value | undefined = s, n = 0; x && n < 32; n++) {
            if (this.sameType(x, t) || this.within(x, t)) return true;
            x = x.kind === "type" && x.family?.base ? this.reference(x.family.base) : undefined;
        }
        return false;
    };
    // How specifically a function given as a match alternative takes a value:
    // as its best clause does.
    private alternativeScore(f: Value, arg: Value): number {
        if (f.kind !== "clauseFn" || f.arity - f.applied.length !== 1) return 0;
        const caller = this.env;
        this.env = f.env;
        try { return Math.max(...f.clauses.map(c => this.patternScore(c.params[f.applied.length], arg))); }
        finally { this.env = caller; }
    }
    // A named subtype's value as its base: Money 1.2 is 1.2 to builtins.
    private baseValue(v: Value): Value {
        return v.kind === "variant" && v.family?.base ? this.dataValue(v.v[0]) : v;
    }

    // Nothing named the type an undecided value should have.
    ambiguous(v: Extract<Value, { kind: "pending" }>): never {
        const step = v.step;
        if (step.op === "bind" || step.op === "do") throw new APNError("runtime", "ambiguous: nothing decides which monad this is", { hint: "name it, as in `Option Int { ... }` or `IO [] { ... }`" });
        const name = step.op === "call" ? step.fn.name : step.op;
        throw new APNError("runtime", `ambiguous: nothing decides which ${name}`, { hint: `name the type it should have, as in \`Int (${name} ...)\`` });
    }

    // An undecided value shows each overload it could become, one per line,
    // as a partly applied overloaded function does: return 123 is Some 123,
    // Ok 123, ... for the instances defined.
    private undecidedText(v: Extract<Value, { kind: "pending" }>, nested = false): string {
        const step = v.step;
        if (step.op === "call") return step.choices.map(c => this.residualText({ ...step.fn, clauses: [c], applied: step.args })).join("\n");
        if (step.op === "bind") {
            const m = this.reference(step.m), f = this.force(step.f);
            const left = m.kind === "pending" ? this.undecidedText(m, true) : this.renderString(m);
            // m >>= (_ -> k), as >> makes it, shows as m >> k.
            const clause = f.kind === "clauseFn" && f.clauses.length === 1 && !f.applied.length ? f.clauses[0] : undefined;
            const ignored = f.kind === "clauseFn" && clause && clause.params.length === 1 && clause.params[0].p === "wildcard" && !clause.guard && clause.body.t === "var" ? f.env.get(clause.body.name) : undefined;
            // The right operand ends the text unless this is nested on the left of another.
            const right = (v: Value) => (v.kind === "closure" || v.kind === "clauseFn" && v.clauses.length === 1) && !nested ? functionSource(v) : argument(v);
            if (ignored) { const k = this.reference(ignored); return `${left} >> ${k.kind === "pending" ? this.undecidedText(k, true) : right(k)}`; }
            return `${left} >>= ${right(f)}`;
        }
        if (step.op === "do") return exprToSource(step.block);
        if (nested) return `${step.op} ${argument(step.value)}`;
        // The list's value first (lists are built in), then each instance's.
        const lines = [this.renderString(mkList(step.op === "throw" ? [] : [step.value])), ...(this.instances.get(step.op) ?? []).map(instance => {
            const fn = this.reference(instance);
            if (fn.kind === "clauseFn") return this.residualText({ ...fn, applied: [...fn.applied, step.value] });
            if (fn.kind === "native") return functionSource({ ...fn, applied: [...fn.applied, step.value] });
            return `${valueToString(fn)} ${argument(step.value)}`;
        })];
        return [...new Set(lines)].join("\n");
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
        const matched: Array<{ clause: DefClause; place: number; score: number; binds: Map<string, Value> }> = [];
        this.env = f.env;
        try {
            const places = clausePlaces(f.clauses, this.containsPattern);
            f.clauses.forEach((clause, index) => {
                const binds = new Map<string, Value>();
                if (!f.applied.every((x, i) => this.matchPattern(clause.params[i], x, binds))) return;
                matched.push({ clause, place: places[index], binds, score: f.applied.reduce((score: number, x, i) => score + this.patternScore(clause.params[i], x), 0) });
            });
        } finally { this.env = caller; }
        matched.sort((a, b) => b.score - a.score || a.place - b.place);
        const lines: string[] = [], catchAll: Array<{ score: number; place: number }> = [];
        for (const m of matched) {
            const rest = m.clause.params.slice(k);
            // The most the rest can add: 1 for each pattern naming a literal or a type.
            const best = m.score + rest.filter(p => LITERAL_PATTERNS.has(p.p) || p.p === "constr" && this.builtinType(p.tag)).length;
            if (catchAll.some(c => c.score > best || c.score === best && c.place < m.place)) continue;
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

    printValue(v: Value, newline = true, raw = true, paint?: Interpreter["paint"]): void {
        const enc = new TextEncoder();
        let buffer = "";
        this.render(v, (s, kind) => {
            buffer += paint ? paint(s, kind) : s;
            if (buffer.length >= 256) {
                Deno.stdout.writeSync(enc.encode(buffer));
                buffer = "";
            }
        }, raw);
        if (newline) console.log(buffer);
        else if (buffer) Deno.stdout.writeSync(enc.encode(buffer));
    }

    // A type function of lists whose length its index makes (Vect, Pairs).
    private counted(v: Value | undefined): Counting | undefined {
        return v?.kind === "type" && !v.family && !v.alias ? v.counts : undefined;
    }
    // Such a type applied: the length it makes and its element type.
    private vectorParts(type: Extract<Value, { kind: "type" }>): [bigint, Value] {
        const [size, element] = type.arguments ?? [], counts = type.counts!;
        if (type.arguments?.length !== 2 || size.kind !== "int" || size.v < 0n) throw new APNError("runtime", `${type.name} needs a nonnegative length and an element type`);
        return [counts.scale * size.v + counts.offset, element];
    }

    private vectorElements(value: Value, size: bigint, name: string): Value[] {
        if (!this.isList(value)) throw new APNError("runtime", `${name} expects a list`);
        const out: Value[] = [];
        let rest = value;
        for (let n = 0n; n < size; n++) {
            checkInterrupt();
            const cell = this.cell(rest);
            if (!cell) throw new APNError("runtime", `${name} length mismatch: expected ${size}, got ${n}`);
            out.push(cell.head); rest = cell.tail;
        }
        if (this.cell(rest)) throw new APNError("runtime", `${name} length mismatch: expected ${size}, got at least ${size + 1n}`);
        return out;
    }

    conform(typeIn: Value, value: Value): Value {
        // A constructor given types (Point Int Int) is the type it names.
        const given = this.reference(typeIn), read = given.kind === "variant" ? this.sharedType(given) ?? given : given;
        // A refinement's value is its base's, for which its condition holds.
        if (read.kind === "type" && read.refine) {
            const member = this.conform(read.choices![0], value);
            if (this.truthy(this.demand(this.apply(read.refine, member)))) return member;
            throw new APNError("runtime", `${this.renderString(member)} is not in ${read.name || "the refinement"}`);
        }
        // A union's value is one of its types' values, as applying it checks.
        if (read.kind === "type" && read.choices && !read.choices.some(c => this.listShaped(this.reference(c)))) return this.typeMember(read, value);
        const written = this.asWritten.get(read);
        if (written) return this.writtenValue(read, this.conform(written.made, value));
        const type = read.kind === "closure" || read.kind === "clauseFn" ? this.asType(read) ?? read : read !== given ? read : typeIn;
        // A type variable not decided by a call takes any value, as does one a
        // pattern read off a list (readElementType).
        if (type.kind === "type" && type.variable || this.readElementTypes.has(read)) return value;
        if (type.kind === "type" && this.counted(type)) {
            const [size, element] = this.vectorParts(type);
            const values = this.vectorElements(this.dataValue(value), size, type.name);
            return { kind: "list", schema: type, v: values.map(x => this.defer(() => this.conform(element, x))) };
        }
        if (type.kind === "type") {
            if (type.name === "IO" && !type.family) return this.actionType(type, value);
            if (type.name === "Dynamic" && !type.family) return this.constructType("Dynamic", value);
            if (type.name === "$any") return value;
            if (type.name === "List" && !type.family) return this.listType(type, value);
            if (type.name === "HashMap" && !type.family) return this.hashMapType(type, value);
            let actual = type.name === "Type" ? this.demand(value) : this.dataValue(value);
            // A pending monadic value takes this type's monad (Option Int { return 42 }).
            if (actual.kind === "pending" && (type.family || actual.step.op === "call")) actual = this.dataValue(this.realize(actual, type));
            if (type.family?.base) {
                // A named refinement's base may be named too (Small = (n : Positive)
                // | n < 10): a value of it, which its refinement takes, is held as
                // the plain value under it.
                const refined = this.reference(type.family.base);
                if (actual.kind === "variant" && actual.family?.base && (actual.family === type.family || !(refined.kind === "type" && refined.refine))) {
                    if (actual.family !== type.family) throw new APNError("runtime", `${type.name} requires explicit unwrapping of ${actual.family.name}`);
                    return actual;
                }
                let held = this.conform(type.family.base, actual);
                while (held.kind === "variant" && held.family?.base) held = this.dataValue(held.v[0]);
                return { kind: "variant", tag: type.family.name, family: type.family, v: [held] };
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
        if (type.kind === "record") return this.buildRecord(type, value);
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
        const repeated = this.repeatedType(t);
        if (repeated) return `[${this.writtenType(repeated)}..]`;
        if (this.isList(t)) return `[${itemsText([...this.elements(t)].map(x => this.writtenType(x)))}]`;
        if (t.kind === "record") return `[${t.v.map(([key, x]) => fieldSource(key, this.writtenType(x), true)).join(", ")}]`;
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
        const shared = this.sharedType(v);
        if (shared) return shared;
        if (v.kind === "closure" || v.kind === "clauseFn") return this.readFunctionType(v, variables);
        if (this.repeatedType(v)) return v;
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
    // The view a name is bound to, if it is one: the binding read only as far
    // as the view itself (a nullary view, used as a value, is what it builds).
    private viewNamed(name: string): Extract<Value, { kind: "native" }> | undefined {
        let v = this.env.get(name);
        if (!v) return undefined;
        v = this.force(v);
        while (v.kind === "closure" && v.params.length === 0 && !v.applied?.length) v = this.force(this.callBlockFn(v));
        if (v.kind === "native" && v.arity === 0 && !v.view) v = this.force(this.reference(v));
        const view = v.kind === "native" && v.view ? v : this.nullaryViews.get(v);
        return view?.kind === "native" ? view : undefined;
    }
    // The prelude's definition of each native it models (see MODELED): what
    // typeOf describes the native as.
    private modeledDefinitions = new Map<string, Value>();
    private describingModeled = new Set<string>();
    // The value each nullary view builds, and the view (see view).
    private nullaryViews = new WeakMap<Value, Value>();
    // A view's pattern, its fields matched against what its matcher gives.
    private matchView(view: Extract<Value, { kind: "native" }>, p: Extract<Pattern, { p: "constr" }>, v: Value, binds: Map<string, Value>): boolean {
        if (p.args.length !== view.arity) {
            throw new APNError("runtime", `${p.tag} takes ${view.arity} field${view.arity === 1 ? "" : "s"}, not ${p.args.length}`);
        }
        const given = this.force(this.apply(view.view!, v, true));
        if (given.kind === "nomatch") return false;
        const fields = this.isList(this.demand(given)) ? this.items(this.demand(given)) : undefined;
        if (!fields || fields.length !== view.arity) {
            throw new APNError("runtime", `${p.tag}'s matcher gives ${fields ? `${fields.length} field${fields.length === 1 ? "" : "s"}` : "no list of fields"}, and ${p.tag} takes ${view.arity}`,
                { hint: "a view's matcher gives a list of the fields its builder takes" });
        }
        return p.args.every((q, i) => this.matchPattern(q, fields[i], binds));
    }
    // Whether a value is a function, as typeOf tells (a type, which converts
    // what it is applied to, is none).
    private isFunction(v: Value): boolean {
        return ["closure", "clauseFn", "native", "contract"].includes(this.reference(v).kind);
    }
    // The type a function accepts (Takes t k's t): its contract's, or the input
    // of the type typeOf describes; any value where that cannot be read.
    private accepted(f: Value): Value {
        const ref = this.reference(f);
        if (ref.kind === "contract") return ref.from;
        const type = this.callNative("typeOf", [ref]);
        const caller = this.env;
        try {
            const [statement] = type.kind === "type" && type.description ? parse(type.description) : [];
            this.env = new Env(this.programEnv);
            const written = statement?.t === "expr" ? this.force(this.eval(statement.value)) : undefined;
            const read = written && (written.kind === "closure" || written.kind === "clauseFn") ? this.readFunctionType(written, new Map()) : undefined;
            if (read?.kind === "functionType") return read.from;
        } catch { /* an input not written as a type accepts any value */ } finally { this.env = caller; }
        return { kind: "type", name: "$any" };
    }
    // A lambda read as the function type it spells: (Int -> Int), (a -> b),
    // (n : Float) -> Float, its typed parameter's type the input; a guard
    // refines it ((n : Float) | n > 0 -> Float), as X = (n : Float) | n > 0 does.
    private readFunctionType(f: Extract<Value, { kind: "closure" | "clauseFn" }>, variables: Map<string, Value>): Value | undefined {
        if (f.kind === "closure" ? f.applied?.length : f.applied.length || f.clauses.length !== 1) return undefined;
        const scope = new Env(f.env);
        const variable = (name: string): Value => {
            if (name === "_") return { kind: "type", name: "_", variable: true };
            const bound = f.env?.get(name), value = bound && this.reference(bound);
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
                        // (n : Float): the type before its value's pattern, which names nothing here.
                        for (const arg of p.typed ? p.args.slice(0, -1) : p.args) {
                            const argument = pattern(arg);
                            if (!argument) return undefined;
                            type = this.reference(this.apply(type, argument));
                        }
                        return type;
                    }
                    case "schema": {
                        // ((f a) e), or (f a e): f a's type applied to e as well.
                        const type = this.typeIn(p.type, scope, variables);
                        if (type?.kind !== "type" || !type.variable || !type.arguments?.length || p.value.p !== "var") return type;
                        const argument = variable(p.value.name);
                        scope.setLocal(p.value.name, argument);
                        return this.reference(this.apply(type, argument));
                    }
                    // f a: a type variable applied to a type.
                    case "typeBind": {
                        const head = variable(p.name), argument = pattern(p.value);
                        scope.setLocal(p.name, head);
                        return argument && this.reference(this.apply(head, argument));
                    }
                    default: return undefined;
                }
            };
            const params = f.kind === "closure" ? f.params.map((name): Pattern => ({ p: "var", name })) : f.clauses[0].params;
            const inputs = params.map(pattern);
            if (!inputs.every(x => x)) return undefined;
            const guard = f.kind === "clauseFn" ? f.clauses[0].guard : undefined;
            if (guard) {
                if (params.length !== 1 || params[0].p !== "constr" || !params[0].typed) return undefined;
                inputs[0] = this.refined(params[0], inputs[0]!, guard, scope);
            }
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
    // The values of a type matching a pattern for which a condition holds,
    // as the refinement X = (p : T) | condition makes them (Parser.refinement).
    private refined(p: Pattern, type: Value, condition: Expr, scope: Env): Value {
        const local = new Env(scope), value = "$refined";
        local.setLocal("$type", type);
        const arms: Expr = { t: "list", v: [
            { t: "patternLambda", params: [p], body: condition },
            { t: "patternLambda", params: [{ p: "wildcard" }], body: { t: "bool", v: false } },
        ] };
        const test: Expr = { t: "lambda", params: [value], body: { t: "app", f: { t: "app", f: { t: "var", name: "~" }, a: { t: "var", name: value } }, a: arms } };
        const refine: Expr = { t: "recordAccess", rec: { t: "var", name: "intrinsics" }, field: "refine" };
        const caller = this.env;
        this.env = local;
        try { return this.reference(this.demand(this.eval({ t: "app", f: { t: "app", f: refine, a: { t: "var", name: "$type" } }, a: test }))); }
        finally { this.env = caller; }
    }
    // Whether a lowercase name in a type is a type variable: it is unless it
    // names a type (a list or record of types too), or a function (which builds one).
    // A name in a length position that keeps its value: one bound to a value.
    // Any other (unbound, or a type or function, which no length is) binds
    // there, as a type position binds a name bound to a value.
    private lengthValue(name: string): Value | undefined {
        const bound = this.env.get(name);
        return bound && this.typeVariableName(name, this.env) ? bound : undefined;
    }
    private typeVariableName(name: string, scope: Env): boolean {
        const bound = scope.get(name);
        if (!bound) return true;
        const value = this.reference(bound);
        return !(value.kind === "type" || value.kind === "functionType" || value.kind === "closure" || value.kind === "clauseFn" || value.kind === "native"
            || (this.isList(value) || value.kind === "record") && this.isTypeValue(value));
    }
    private typeIn(e: Expr, scope: Env, variables: Map<string, Value>): Value | undefined {
        // _ as a type is any type (Int -> _), as it is a type's argument (List _).
        if (e.t === "placeholder") return { kind: "type", name: "$any" };
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

    // Whether every value of type a is one of b (a <= b): a type is the set
    // of its values. A union is within b when each of its types is; a type
    // is within a union one of whose types holds it. List types compare as
    // they unfold: [] within an alternative [], and a :: as within those
    // whose head holds its head, its rest within the union of their rests.
    // A pair met again holds, as its unfoldings never end (List Int <= Seq
    // Int); one that fails is withdrawn.
    within(a: Value, b: Value, met = new Set<string>()): boolean {
        a = this.described(this.reference(a)); b = this.described(this.reference(b));
        a = this.sharedType(a) ?? a; b = this.sharedType(b) ?? b;
        if (this.sameType(a, b)) return true;
        if (b.kind === "type" && !b.family && !b.arguments?.length && (b.name === "$any" || b.name === "Dynamic")) return true;
        // A refinement is within its base; only itself, or a refinement of
        // it, is within it (a condition is not compared with another).
        if (b.kind === "type" && b.refine) {
            for (let t: Value = a; t.kind === "type" && t.refine; t = this.reference(t.choices![0])) if (t.refine === b.refine) return true;
            return false;
        }
        if (a.kind === "type" && a.refine) return this.within(a.choices![0], b, met);
        if (this.listShaped(a) && this.listShaped(b)) {
            const key = `${this.typeKey(a)} <= ${this.typeKey(b)}`;
            if (met.has(key)) return true;
            met.add(key);
            const others = this.unfold(b);
            const holds = this.unfold(a).every(cell => {
                if (!cell) return others.includes(null);
                const head = this.reference(cell.head);
                const heads = head.kind === "type" && head.choices && !head.choices.some(c => this.isList(c)) ? head.choices : [head];
                return heads.every(h => {
                    const fits = others.flatMap(other => other && this.within(h, other.head, met) ? [this.reference(other.tail)] : []);
                    return fits.length > 0 && this.within(cell.tail, fits.length === 1 ? fits[0] : this.unionOf(fits), met);
                });
            });
            if (!holds) met.delete(key);
            return holds;
        }
        if (a.kind === "type" && a.choices) return a.choices.every(choice => this.within(choice, b, met));
        if (b.kind === "type" && b.choices) {
            if (b.choices.some(choice => !this.listShaped(this.reference(choice)) && this.within(a, choice, met))) return true;
            const lists = b.choices.map(choice => this.reference(choice)).filter(choice => this.listShaped(choice));
            return this.listShaped(a) && lists.length > 0 && this.within(a, this.unionOf(lists), met);
        }
        // A type given _ holds it given anything there (Option Int <= Option _).
        if (a.kind === "type" && b.kind === "type" && b.arguments?.length && a.name === b.name && a.family === b.family && !a.alias && !b.alias &&
            a.arguments?.length === b.arguments.length) {
            return b.arguments.every((x, n) => this.isAny(x) || this.sameType(a.arguments![n], x));
        }
        return a.kind === "type" && b.kind === "type" && !a.family && !b.family && !a.arguments?.length && !b.arguments?.length &&
            NUMERIC_TYPES.includes(a.name) && NUMERIC_TYPES.includes(b.name) && numericWithin(a.name, b.name);
    }
    // The type a list's description names (typeOf [1,2] is [Int,Int]), read
    // back as written; a type variable in it (List a) is any type.
    private describedTypes = new Map<string, Value | null>();
    private described(t: Value): Value {
        if (t.kind !== "type" || !t.inspect || !t.description || t.name !== "List") return t;
        let read = this.describedTypes.get(t.description);
        if (read === undefined) {
            read = null;
            const caller = this.env;
            try {
                const scope = new Env(this.programEnv);
                for (const name of t.description.match(/\b[a-z]\w*/g) ?? []) scope.setLocal(name, { kind: "type", name: "$any" });
                const [statement] = parse(t.description);
                this.env = scope;
                if (statement?.t === "expr") read = this.asType(this.eval(statement.value)) ?? null;
            } catch { read = null; } finally { this.env = caller; }
            this.describedTypes.set(t.description, read);
        }
        return read ?? t;
    }
    // A type of lists: a list of types ([], [Int], [Int..]), List a, Vect n
    // a, or a union of them.
    private listShaped(t: Value): boolean {
        return this.isList(t) || t.kind === "type" && (this.isListType(t) || !!this.counted(t) || !!t.choices?.every(c => this.listShaped(this.reference(c))));
    }
    // A list type's alternatives, one step unfolded: null for [], else a
    // head type and the rest's type.
    private unfold(t: Value): Array<{ head: Value; tail: Value } | null> {
        t = this.reference(t);
        if (t.kind === "type" && t.choices) return t.choices.flatMap(c => this.unfold(c));
        if (t.kind === "type" && this.counted(t)) {
            const [size, element] = this.vectorParts(t);
            return this.unfold(mkList(Array.from({ length: Number(size) }, () => element)));
        }
        if (t.kind === "type") return [null, { head: t.arguments?.[0] ?? { kind: "type", name: "$any" }, tail: t }];
        const cell = this.cell(t);
        return [cell && { head: cell.head, tail: cell.tail }];
    }
    // A union made while comparing, known by its types' keys.
    private unionOf(types: Value[]): Value {
        return { kind: "type", name: `(${[...new Set(types.map(t => this.typeKey(t)))].sort().join(" | ")})`, choices: types };
    }
    // What a type is known by while comparing: a named one by its name (an
    // unfolding makes it anew), another by itself.
    private typeKeys = new WeakMap<object, number>();
    private typeKeyCount = 0;
    private typeKey(t: Value): string {
        if (t.kind === "type" && (t.choices ? t.name : this.isListType(t))) return t.choices ? t.name : this.renderString(t);
        if (!this.typeKeys.has(t)) this.typeKeys.set(t, ++this.typeKeyCount);
        return `#${this.typeKeys.get(t)}`;
    }

    sameType(a: Value, b: Value, met = new Map<Value, Set<Value>>()): boolean {
        a = this.reference(a); b = this.reference(b);
        a = this.sharedType(a) ?? a; b = this.sharedType(b) ?? b;
        if (a === b) return true;
        // A counted list type is the positional type it makes: Vect 2 Int is [Int,Int].
        if (this.counted(a) && this.isList(b) || this.isList(a) && this.counted(b)) {
            const [size, element] = this.vectorParts((this.counted(a) ? a : b) as Extract<Value, { kind: "type" }>);
            let rest = this.counted(a) ? b : a;
            for (let n = 0n; n < size; n++) {
                checkInterrupt();
                const cell = this.cell(rest);
                if (!cell || !this.sameType(element, cell.head)) return false;
                rest = cell.tail;
            }
            return this.cell(rest) === null;
        }
        if (a.kind === "type" && b.kind === "type") {
            const other = b.arguments ?? [];
            return a.name === b.name && a.family === b.family && a.alias === b.alias && a.refine === b.refine &&
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
            // Cells met again (endless types, [Int..]) are compared already.
            for (;;) {
                checkInterrupt();
                a = this.reference(a); b = this.reference(b);
                // A rest that is a type of lists (a :: Pairs a) is compared as a type.
                if (!this.isList(a) || !this.isList(b)) return this.isList(a) === this.isList(b) && this.sameType(a, b, met);
                if (met.get(a)?.has(b)) return true;
                if (!met.has(a)) met.set(a, new Set());
                met.get(a)!.add(b);
                const left = this.cell(a), right = this.cell(b);
                if (!left || !right) return left === right;
                if (!this.sameType(left.head, right.head, met)) return false;
                a = left.tail; b = right.tail;
            }
        }
        return false;
    }

    // met: the unions of list types being tested, each with the values it is
    // tested on (see unfolded).
    belongsToType(type: Value, value: Value, met = new Map<unknown, Set<unknown>>()): boolean {
        type = this.reference(type); value = this.reference(value);
        // A record, where a list is asked, is the list of its pairs.
        if (value.kind === "record" && this.listShaped(type)) value = mkList(value.v.map(([key, field]) => mkList([mkStr(key), field])));
        if (value.kind === "hashmap" && this.listShaped(type)) value = mkList([...value.entries.values()].map(([key, field]) => mkList([key, field])));
        // A refinement's values are its base's for which its condition holds.
        if (type.kind === "type" && type.refine) {
            return this.belongsToType(type.choices![0], value, met) && this.truthy(this.demand(this.apply(type.refine, value)));
        }
        if (type.kind === "type" && type.choices) {
            if (!type.choices.some(choice => this.isList(choice))) return type.choices.some(choice => this.belongsToType(choice, value, met));
            // A union of list types unfolds as the value is read: met again on
            // the same value (a list that is its own tail, an endless range,
            // whose elements share one type), it belongs, as its unfoldings
            // never end. An assumption that fails is withdrawn.
            const at = type.name || type, seen = met.get(at) ?? new Set(), key = this.unfolded(value);
            if (seen.has(key)) return true;
            met.set(at, seen.add(key));
            const belongs = type.choices.some(choice => this.belongsToType(choice, value, met));
            if (!belongs) seen.delete(key);
            return belongs;
        }
        if (type.kind === "type" && this.counted(type)) {
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
        // HashMap k v: each key a k and each value a v.
        if (type.kind === "type" && type.name === "HashMap" && !type.family && type.arguments?.length === 2) {
            const map = this.dataValue(value);
            if (map.kind !== "hashmap") return false;
            const [k, v] = type.arguments;
            return [...map.entries.values()].every(([key, item]) => this.belongsToType(k, key, met) && this.belongsToType(v, item, met));
        }
        // List a = [] | a :: List a: each element an a, read as the list
        // unfolds. A cell met again (ones = 1 :: ones) or an endless range,
        // whose elements share one type, belongs: its unfoldings never end.
        if (type.kind === "type" && this.isListType(type) && type.arguments?.length) {
            const [element] = type.arguments, met = new Set<Value>();
            for (value = this.dataValue(value); this.isList(value); value = this.reference(this.cell(value)!.tail)) {
                checkInterrupt();
                if ((value.kind === "range" || value.kind === "floatRange" || value.kind === "rationalRange") && value.hi === null) {
                    return this.belongsToType(element, this.cell(value)!.head);
                }
                if (met.has(value)) return true;
                met.add(value);
                const cell = this.cell(value);
                if (!cell) return true;
                if (!this.belongsToType(element, cell.head)) return false;
            }
            return false;
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
                // (A field of _ or a type variable takes any value, unread.)
                try {
                    return fields.every((field, index) => {
                        const type = this.asType(this.eval(field)) ?? this.eval(field);
                        return type.kind === "type" && (type.variable || this.isAny(type)) || this.belongsToType(type, payloads[index]);
                    });
                }
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
            // An endless range has one type throughout: [1..] is an [Int..].
            const repeated = this.repeatedType(type);
            if (repeated && (value.kind === "range" || value.kind === "floatRange" || value.kind === "rationalRange") && value.hi === null) {
                return this.belongsToType(repeated, this.cell(value)!.head);
            }
            // Cells met again (a list that is its own tail) are checked already.
            // A rest that is no list (a union: a :: Pairs a) tests the rest.
            const cells = new Map<Value, Set<Value>>();
            for (;;) {
                checkInterrupt();
                type = this.reference(type); value = this.reference(value);
                if (!this.isList(type)) return this.belongsToType(type, value, met);
                if (cells.get(type)?.has(value)) return true;
                if (!cells.has(type)) cells.set(type, new Set());
                cells.get(type)!.add(value);
                const field = this.cell(type), element = this.cell(value);
                if (!field || !element) return field === element;
                if (!this.belongsToType(field.head, element.head, met)) return false;
                type = field.tail; value = element.tail;
            }
        }
        return false;
    }

    // A type whose values are lists, which ends a list type as a list does
    // (a :: Pairs a, Int :: List Int): List a, or a union of list types.
    private ofLists(t: Value): boolean {
        return t.kind === "type" && (this.isListType(t) || !!t.choices?.every(c => this.isList(c) || this.ofLists(this.reference(c))));
    }
    // A value as a union of list types meets it again: itself, or for an
    // endless range, whose rests differ only in where they start, its type.
    private unfolded(value: Value): unknown {
        const v = this.dataValue(value);
        return (v.kind === "range" || v.kind === "floatRange" || v.kind === "rationalRange") && v.hi === null
            ? `[${this.typeText(this.cell(v)!.head)}..]` : v;
    }

    // Whether a slot is a Type field's, whose values are types.
    private typeOfTypes(slot: Value | undefined): boolean {
        const type = slot && this.force(slot);
        return type?.kind === "type" && type.name === "Type" && !type.family;
    }

    // Whether a value holds a type (a template: [x : Int, y = 0], [xs = [Int]]),
    // told without evaluating anything, so a record of values is never forced
    // to tell: only what is evaluated, and what a list literal is written with.
    // A list whose first items, read down to a type, are types: [Int],
    // [[Float]] (the empty list too, the type of no items).
    private listOfTypes(list: Value): boolean {
        for (let x = list, depth = 0; depth < 8; depth++) {
            const cell = this.cell(x);
            if (!cell) return true;
            x = this.reference(cell.head);
            if (!this.isList(x)) return this.holdsType(x);
        }
        return false;
    }
    private holdsType(value: Value, depth = 0): boolean {
        while ((value.kind === "thunk" || value.kind === "deferred") && value.value) value = value.value;
        if (value.kind === "type" || value.kind === "functionType" || this.sharedType(value)) return true;
        if (depth > 3) return false;
        if (value.kind === "record") return value.v.some(([key, field]) => !value.bound?.has(key) && this.holdsType(field, depth + 1));
        if (value.kind === "list") return value.v.length > 0 && this.holdsType(value.v[0], depth + 1);
        if (value.kind === "lazyList") {
            if (value.value) return this.holdsType(value.value, depth);
            const first = value.exprs[0], bound = first?.t === "var" ? value.env.get(first.name) : undefined;
            return bound !== undefined && this.holdsType(bound, depth + 1);
        }
        return false;
    }

    // A constructor sharing its type's name (Box x = _) is that type where a
    // type is expected: a field's or a slot's type, isType, a union.
    // Applied to types, one for each of its type's parameters, it is that type
    // applied to them (Box Int, Pair Int String); unbox (Box x) still takes a
    // Box apart, its pattern having as many arguments as it has fields.
    // A constructor is a function that does not evaluate: applied to a type
    // for each field, it is the type of the values it makes from them (Some
    // Int, Box Int); a constructor taking fields, unapplied, is a function, and
    // a nullary one a value (None), unless it is its type's own name (JSON).
    sharedType(v: Value): Extract<Value, { kind: "type" }> | undefined {
        if (v.kind !== "variant" || !v.family || v.family.base) return undefined;
        const type: Extract<Value, { kind: "type" }> = { kind: "type", name: v.family.name, family: v.family };
        if (!v.v.length) return v.family.name === v.tag ? type : undefined;
        let args: Value[];
        try { args = v.v.map(field => this.reference(this.demand(field))); }
        catch (error) { if (error instanceof APNError) return undefined; throw error; }
        if (!args.every(arg => this.isTypeValue(arg))) return undefined;
        // Its type's own constructor given its parameters is that type applied.
        if (v.family.name === v.tag && v.v.length === this.typeArguments(v.family)) return { ...type, arguments: args };
        return this.constructedType(v.family, v.tag, args);
    }
    // The types a constructor's fields are declared with, where they are types.
    private declaredFieldTypes(family: VariantFamily, tag: string): Value[] | undefined {
        const specs = family.fields?.get(tag);
        if (!specs) return undefined;
        const caller = this.env;
        this.env = new Env(family.env);
        try {
            const types = specs.map(spec => this.asType(this.eval(spec)));
            return types.every(Boolean) ? types as Value[] : undefined;
        } catch (error) {
            if (error instanceof APNError) return undefined;
            throw error;
        } finally { this.env = caller; }
    }
    // The type of the values a constructor makes from these types: those of
    // its type it makes whose fields are of them, one type for one spelling.
    private constructedTypes = new Map<string, Extract<Value, { kind: "type" }>>();
    private constructedType(family: VariantFamily, tag: string, args: Value[]): Extract<Value, { kind: "type" }> {
        const key = `${this.familyKey(family)} ${tag} ${args.map(arg => this.typeKey(arg)).join(" ")}`;
        let made = this.constructedTypes.get(key);
        if (!made) {
            const test: Value = { kind: "native", name: "$constructed", arity: 1, applied: [], invoke: ([given]) => {
                const v = this.dataValue(given);
                return mkBool(v.kind === "variant" && v.family === family && v.tag === tag && v.v.length === args.length &&
                    args.every((arg, n) => arg.kind === "type" && (arg.variable || this.isAny(arg)) || this.belongsToType(arg, v.v[n])));
            } };
            const name = this.appliedName(tag, args);
            // It is written as the constructor applied to the types, which a
            // to instance for it takes apart: to (Money Float) (x : Float).
            const written: Value = { kind: "variant", tag, family, v: args };
            made = { kind: "type", name, choices: [{ kind: "type", name: family.name, family }], refine: test, made: written };
            this.constructedTypes.set(key, made);
        }
        return made;
    }
    private familyKeys = new WeakMap<VariantFamily, number>();
    private familyCount = 0;
    private familyKey(family: VariantFamily): number {
        let key = this.familyKeys.get(family);
        if (key === undefined) this.familyKeys.set(family, key = this.familyCount++);
        return key;
    }
    // How many type arguments a constructor sharing its type's name takes
    // where a type is expected: its type's parameters, when its fields are
    // exactly them, in order (Box x = _, Pair a b = _).
    private typeArguments(family: VariantFamily): number {
        const parameters = family.parameters ?? [], fields = family.fields?.get(family.name) ?? [];
        return fields.length === parameters.length && fields.every((f, n) => f.t === "var" && f.name === parameters[n]) ? parameters.length : -1;
    }
    // A range of numbers ([1..], [0,0.5..2]); a type has no step or bound.
    private range(lo: Value, second: Value | null, hi: Value | null): Value {
        if (this.isTypeValue(lo)) throw new APNError("runtime", TYPE_RANGE, { hint: "write [Int..] for Int repeated" });
        const real = (value: Value): Real => {
            const v = this.reference(this.dataValue(value));
            if (v.kind !== "int" && v.kind !== "float" && v.kind !== "rational") throw new APNError("runtime", "range bounds must be real numbers");
            return v;
        };
        return rangeValue(real(lo), second && real(second), hi && real(hi));
    }
    // Whether a type is any (_ given to a type).
    private isAny(t: Value): boolean {
        const x = this.reference(t);
        return x.kind === "type" && x.name === "$any" && !x.description && !x.family;
    }
    // Whether a value is applied to types: a type, or a constructor.
    private takesTypes(head: Value): boolean {
        const f = this.reference(this.force(head));
        return f.kind === "type" || f.kind === "native" && !!f.tag;
    }
    // What a name is bound to here, in the terms the pattern rules use (see
    // Binding): a type a definition with parameters computes is computed.
    private binding(name: string): Binding {
        const bound = this.env.get(name);
        if (bound === undefined) return { kind: "free" };
        const value = this.reference(bound);
        if (value.kind === "native" && value.tag) return { kind: "data", tag: value.tag, fields: value.arity - value.applied.length, made: false };
        if (value.kind === "variant") return { kind: "data", tag: value.tag, fields: value.v.length, made: true };
        if (value.kind === "native" && value.name === "intrinsics.cons" && !value.applied.length) return { kind: "cons" };
        if (this.isList(value) && this.cell(value) === null) return { kind: "nil" };
        if (value.kind === "type") {
            const computed = !!value.alias && !(value.alias.run.kind === "clauseFn" && isUnionBody(value.alias.run.clauses[0].body));
            return { kind: "type", arity: this.typeArity(value), computed };
        }
        const written = value.kind === "functionType" || value.kind === "closure" || value.kind === "clauseFn" || value.kind === "native"
            || (this.isList(value) || value.kind === "record") && this.isTypeValue(value);
        return { kind: written ? "written" : "value" };
    }
    // A statement's patterns read by what their names are bound to here: at
    // the top level, and in a block declaring names, as each statement runs.
    private readPatterns(s: unknown): void {
        if (this.patternsRead.has(s as object)) return;
        this.patternsRead.add(s as object);
        readPatterns(s, name => this.binding(name));
    }
    private patternsRead = new WeakSet<object>();
    // How many parameters a type still takes (List 1, List Int 0).
    private typeArity(t: Extract<Value, { kind: "type" }>): number {
        const takes = t.alias ? t.alias.parameters.length : t.family ? t.family.parameters?.length ?? 0
            : this.counted(t) || t.name === "HashMap" ? 2 : !t.family && (t.name === "List" || t.name === "IO") ? 1 : 0;
        return Math.max(0, takes - (t.arguments?.length ?? 0));
    }
    // A type as the type of values (x : T, isType T x): given all its
    // parameters, Option _ and not Option, a function of types.
    private valuesType(t: Extract<Value, { kind: "type" }>): Extract<Value, { kind: "type" }> {
        const missing = t.variable ? 0 : this.typeArity(t);
        if (!missing) return t;
        const { message, hint } = missingTypeParameters(t.name, (t.arguments ?? []).map(a => this.renderString(a)), missing);
        throw new APNError("runtime", message, { hint });
    }
    // Whether a name is bound to the list's cons (the prelude's Cons).
    // Whether :: here is the prelude's (or not bound yet), so a written list
    // is the list it writes rather than its expansion (a :: b :: []).
    private preludeCons(): boolean {
        const cons = this.loadingPrelude ? undefined : this.env.get("::");
        if (cons === undefined) return true;
        const own = this.reference(cons);
        return own === this.preludeBindings.get("::") || own.kind === "native" && own.name === "intrinsics.cons" && !own.applied.length;
    }
    // [T..], a range of a type: T repeated, a list that is its own tail.
    // Told without evaluating the tail: a computed one, or a name for one
    // (enumFrom's ts = t :: ts), is followed as far as it is known.
    repeatedType(value: Value): Value | undefined {
        const v = this.reference(value);
        if (v.kind !== "cons") return undefined;
        let tail: Value | undefined = v.tail;
        for (let steps = 0; tail && tail !== v && steps < 64; steps++) {
            if (tail.kind === "deferred") tail = tail.value ?? tail.describes;
            else if (tail.kind === "thunk") tail = tail.value ?? (tail.body.t === "var" ? tail.env?.get(tail.body.name) : undefined);
            else break;
        }
        return tail === v && this.isTypeValue(v.head) ? v.head : undefined;
    }
    isTypeValue(value: Value, seen = new Set<Value>()): boolean {
        value = this.reference(value);
        if (value.kind === "type" || value.kind === "functionType" || this.sharedType(value)) return true;
        if (seen.has(value)) return false;
        const path = new Set(seen); path.add(value);
        if (value.kind === "record") return value.v.every(([key, field]) => !value.bound?.has(key) && this.isTypeValue(field, path));
        if (this.isList(value)) {
            const spine = new Set<Value>();
            let rest: Value = value;
            for (;;) {
                rest = this.demand(rest);
                if (spine.has(rest)) return true;
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
                        // Given a type for a field of values, the constructor
                        // makes the type of the values it makes (UserId Int).
                        const given = this.reference(value);
                        if (this.isTypeValue(given) && !(type.kind === "type" && type.name === "Type" && !type.family)) return given;
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
        return value.family?.results ? this.familyArguments(value) : undefined;
    }
    // Any family's value's arguments: those it was given (Option Int), else
    // the ones its fields give, as for an indexed family (Option Int for Some 1).
    private familyArguments(value: Extract<Value, { kind: "variant" }>): Value[] | undefined {
        const family = value.family;
        if (!family) return undefined;
        if (!family.results && value.arguments) return value.arguments;
        const cached = this.indexCache.get(value);
        if (cached) return cached;
        const scope = new Env(family.env);
        const fields = family.fields?.get(value.tag) ?? [];
        const given = (name: string, found: () => Value) => { if (!scope.map.has(name)) scope.setLocal(name, this.defer(found)); };
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
        const result = family.results?.get(value.tag);
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
        if (name === "Type") return this.isTypeValue(value);
        if (name !== "Function" && name !== "Mutable") value = this.dataValue(value);
        if (name === "Pointer") return value.kind === "pointer";
        if (name === "Mutable") return value.kind === "mutable";
        if (isNumeric(value)) return NUMERIC_TYPES.includes(name) && matchesType(name, value);
        if (name === "List") return this.isList(value) || value.kind === "record" || value.kind === "hashmap";
        if (name === "Type" && value.kind === "functionType") return true;
        // A type still taking parameters is a function of types (Option).
        if (name === "Function") return value.kind === "contract" || value.kind === "closure" || value.kind === "clauseFn" || value.kind === "native" || value.kind === "type" && this.typeArity(value) > 0;
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
        // A named subtype's value has its base's truthiness (Money 0 is zero).
        if (v.kind === "variant" && v.family?.base) return this.truthy(v.v[0]);
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
            // Dynamic action: the action whose result is Dynamic.
            if (actual.kind === "io") return { kind: "io", result: "Dynamic", run: () => this.constructType("Dynamic", this.runIO(actual)) };
            return actual;
        }
        if (name === "Bool") {
            const b = this.dataValue(value);
            if (b.kind !== "bool") throw new APNError("runtime", `${this.typeText(b)} is not a Bool`, { hint: "a condition's truth is truthy x" });
            return b;
        }
        if (name === "Type") {
            if (!this.isTypeValue(value)) throw new APNError("runtime", "Type constructor expects a Type value");
            return this.inspectType(value);
        }
        // A cell made from a List T conversion or a record schema's keeps that
        // type: it holds lists of any length.
        const declared = name === "Mutable" ? this.declaredTypes.get(value) ?? this.declaredTypes.get(this.reference(value)) : undefined;
        value = this.dataValue(value);
        if (name === "Mutable") return declared ? { kind: "mutable", v: value, schema: declared } : { kind: "mutable", v: value };
        if (name === "String" && this.isList(value)) return this.callNative("fromChars", [value]);
        if (NUMERIC_TYPES.includes(name)) {
            if (!isNumeric(value)) throw new APNError("runtime", `${name} expects a number`);
            return castNumeric(name, value);
        }
        if (!this.matchesValueType(name, value)) throw new APNError("runtime", `${name} constructor expects a ${name} value`);
        return value;
    }

    // A key's text, equal for keys that are == (the map stores its pairs by it):
    // any value with equality, a list, record or constructor's by its parts.
    hashKey(value: Value): string {
        value = this.dataValue(value);
        if (isNumeric(value)) return "number:" + numericHash(value);
        if (value.kind === "string" || value.kind === "char" || value.kind === "bool") return value.kind + ":" + String(value.v);
        if (this.isList(value) || value.kind === "record" || value.kind === "hashmap") return `list:[${[...this.elements(value)].map(item => this.hashKey(item)).join(",")}]`;
        if (value.kind === "variant") return `variant:${value.tag}(${value.v.map(item => this.hashKey(item)).join(",")})`;
        if (value.kind === "type") return "type:" + this.renderString(value);
        throw new APNError("runtime", `a HashMap's keys are compared: ${this.typeText(value)} has no equality`, { hint: "use numbers, text, lists, records or constructors as keys" });
    }

    associations(value: Value): Array<[Value, Value]> {
        if (value.kind === "hashmap") return [...value.entries.values()];
        // (A record is the association list of its fields.)
        if (value.kind === "record") return value.v.map(([key, field]) => [mkStr(key), field]);
        if (!this.isList(value)) throw new APNError("runtime", "a HashMap is made from an association list", { hint: "write its entries as [key,value] pairs: ([[\"a\", 1]] : HashMap _ _)" });
        const items = this.items(value);
        return items.map((item) => {
            const pair = this.demand(item);
            if (!this.isList(pair)) throw new APNError("runtime", "association entries must be [key,value] pairs");
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
    // A record or association list as a HashMap k v: each key a k, each value
    // a v (converted when read), a type variable or _ checking nothing.
    private hashMapType(type: Extract<Value, { kind: "type" }>, value: Value): Value {
        if (type.arguments?.length !== 2) throw new APNError("runtime", "HashMap takes a key type and a value type", { hint: "write HashMap k v, as (x : HashMap String Int) or (x : HashMap _ _)" });
        const [keyType, valueType] = type.arguments.map(t => this.reference(t));
        const open = (t: Value) => t.kind === "type" && (t.variable || this.isAny(t));
        const entries = new Map<string, [Value, Value]>();
        for (const [key, item] of this.associations(this.dataValue(value))) {
            const k = open(keyType) ? key : this.demand(this.conform(keyType, key));
            entries.set(this.hashKey(k), [k, open(valueType) ? item : this.defer(() => this.conform(valueType, item))]);
        }
        return { kind: "hashmap", entries };
    }

    mapLookup(map: Extract<Value, { kind: "hashmap" }>, key: Value): Value {
        const entry = map.entries.get(this.hashKey(key));
        if (!entry) throw new APNError("runtime", "HashMap key not found");
        return entry[1];
    }

    callNative(name: string, argsIn: Value[], tag?: string, perform = false): Value {
        // Each run evaluates the expressions written in the call again, as a
        // do-block's statements are (set c (c + 1) run twice adds 2); a value
        // passed in (a name, a parameter) is the one it is.
        if (!perform && ACTIONS.has(name)) {
            const fresh = (v: Value): Value => v.kind === "thunk" && v.env ? { kind: "thunk", body: v.body, env: v.env } : v;
            // A module read inside Dynamic is read unchecked wherever it runs.
            if (name === "intrinsics.import" || name === "intrinsics.runFile" || name === "intrinsics.readFileFrom") {
                // (A load finds its file from where it is written, wherever it runs.)
                const depth = this.dynamicDepth, directory = this.runningDir();
                return { kind: "io", result: ACTIONS.get(name), run: () => {
                    const outer = this.dynamicDepth;
                    this.dynamicDepth = depth;
                    try {
                        if (name !== "intrinsics.runFile") return this.callNative(name, argsIn.map(fresh), tag, true);
                        const path = this.force(argsIn[0]);
                        if (path.kind !== "string") throw new APNError("runtime", "load runs one file, named by a path string");
                        return this.runFile(path.v, directory);
                    } finally { this.dynamicDepth = outer; }
                } };
            }
            return { kind: "io", result: ACTIONS.get(name), run: () => this.callNative(name, argsIn.map(fresh), tag, true) };
        }
        if (name === "assert") {
            const argument = argsIn[0];
            const condition = this.demand(argument);
            if (!this.truthy(condition)) {
                const body = argument.kind === "thunk" ? argument.body : undefined;
                const location = body && sourceLocations.get(body);
                const expression = location ? location.source.slice(location.start, location.end).trim() : body ? exprToSource(body) : "False";
                const line = location ? location.source.slice(0, location.start).split("\n").length : undefined;
                const error = new APNError("runtime", `assertion failed: ${expression}${location ? ` (${location.file}:${line})` : ""}`,
                    location ? { pos: location.start, len: Math.max(1, location.end - location.start) } : {});
                if (location) error.src = location.source;
                throw error;
            }
            // assert c x is x, as Haskell's: a value, or an action, checked first.
            return argsIn[1];
        }
        if (name === "intrinsics.match") {
            // The most specific alternative that fits, as among a function's
            // clauses (one scores as its best clause; written order breaks ties).
            // Share the original lazy argument across probes; errors are never
            // treated as mismatches.
            const alternatives = [...this.elements(argsIn[1])].map(candidate => this.demand(candidate));
            for (const f of this.ranked(alternatives, f => this.alternativeScore(f, argsIn[0]))) {
                const arity = f.kind === "clauseFn" || f.kind === "native" ? f.arity - f.applied.length : f.kind === "closure" ? f.params.length : f.kind === "contract" ? 1 : -1;
                if (arity !== 1) throw new APNError("runtime", "match expects alternatives with one remaining argument");
                const result = f.kind === "clauseFn" ? this.apply(f, argsIn[0], true) : this.defer(() => this.apply(f, argsIn[0]));
                if (result.kind !== "nomatch") return result;
            }
            throw new APNError("runtime", "non-exhaustive match: no alternative fits this value");
        }

        const primitive = PRIMITIVE_OPERATORS.get(name);
        if (primitive) return this.operate(primitive, argsIn[0], argsIn[1]);
        if (name === "intrinsics.bind") return this.bind(argsIn[0], argsIn[1]);
        if (name === "intrinsics.negate") return this.arrayNegate(this.dataValue(argsIn[0]));
        if (name === "intrinsics.ap") return this.apValue(argsIn[0], argsIn[1]);
        if (name === "intrinsics.return") return this.pendingReturn(argsIn[0]);
        if (name === "intrinsics.range") {
            // [] is no bound (enumFrom a is intrinsics.range a [] []).
            const given = (v: Value) => { const x = this.reference(this.dataValue(v)); return this.isList(x) && this.cell(x) === null ? null : x; };
            return this.range(this.reference(this.dataValue(argsIn[0])), given(argsIn[1]), given(argsIn[2]));
        }
        if (name === "intrinsics.throw") return { kind: "pending", step: { op: "throw", value: argsIn[0] } };
        // The source a parameter's argument was written as at the call (guard's
        // condition), as assert shows its expression.
        if (name === "intrinsics.source") {
            let argument = argsIn[0];
            if (argument.kind === "thunk" && argument.body.t === "var") argument = argument.env?.get(argument.body.name) ?? argument;
            let body = argument.kind === "thunk" ? argument.body : undefined;
            // Without its grouping parentheses: n > 0, not (n > 0).
            while (body?.t === "block" && body.style === "(" && body.stmts.length === 1) body = body.stmts[0];
            const at = body && sourceLocations.get(body);
            return mkStr(at ? at.source.slice(at.start, at.end).trim() : body ? exprToSource(body) : this.renderString(argument));
        }
        if (name === OPEN) {
            const value = this.dataValue(argsIn[0]);
            // Code is spliced where use stands: an action running its statements.
            // (into the scope use stands in, wherever its action runs).
            if (this.isList(value) && this.codeItems(value)) { const here = this.env; return { kind: "io", result: "[]", run: () => this.spliceCode(value, here) }; }
            // A list of records opens each in turn ([] opens nothing).
            const given = this.isList(value) ? this.items(value).map(v => this.dataValue(v)) : [value];
            const opened: Array<{ bindings: Array<[string, Value]>; module?: { origin?: string; checked?: boolean } }> = [];
            for (const written of given) {
                const record = written;
                if (this.isList(record) && this.codeItems(record)) throw new APNError("runtime", "[..] opens one code, not a list", { hint: "open each in turn: [..] = a; [..] = b" });
                if (record.kind !== "record") throw new APNError("runtime", "[..] opens a record, code, or a list of records");
                const bindings: Array<[string, Value]> = [];
                for (const [key, field] of record.v) {
                    // A field is a name or an operator (a module's <|>).
                    if (!/^[A-Za-z_][A-Za-z0-9_']*$/.test(key) && !isOperatorName(key) || key === "_" || KEYWORDS.has(key)) {
                        throw new APNError("runtime", `[..] cannot bind field ${JSON.stringify(key)}: expected an identifier`);
                    }
                    bindings.push([key, field]);
                }
                opened.push({ bindings, module: this.moduleValues.get(written) });
            }
            // Validate the whole input before publishing; keep the field values lazy.
            // A module's names are published as its own (as the static check typed them).
            for (const { bindings, module } of opened) {
                if (!module) { this.publishForeignBindings(this.env, bindings); continue; }
                this.publishForeignBindings(this.env, bindings, module.origin, module.checked ?? (!!this.checking && !this.dynamicDepth));
            }
            return { kind: "list", v: [] };
        }
        // while [condition] action: runs the code again before each pass, its
        // last item the condition (earlier ones may bind names), and the
        // action while that holds. for [start, condition, step] action: start's
        // bindings, then while the condition holds, the action and the step, an
        // action it runs or a binding the next pass sees (i = i + 1). Each
        // action reads the code's names, as code joined after it does.
        if (name === "while" || name === "for") {
            const [code, action] = argsIn;
            const items = this.items(this.dataValue(code)).map(item => this.written(item));
            const shape = name === "for" ? "[start, condition, step]" : "[condition]";
            if (!items.length || items.some(item => !item) || name === "for" && items.length !== 3) {
                throw new APNError("runtime", `${name} takes code as written: ${shape}`, {
                    hint: name === "for" ? "for [i = 0, i < 10, i = i + 1] { print i }" : "while [n < 10] { ... }" });
            }
            const written = items as Written[];
            const run = (expr: Expr, env: Env): Value => {
                const old = this.env;
                this.env = env;
                try { return this.eval(expr); } finally { this.env = old; }
            };
            const act = (state: CodeState) => {
                if (action.kind !== "thunk" || !action.env) { this.runIO(action); return; }
                const scope = new Env(action.env);
                for (const [name, value] of state.before) scope.setLocal(name, value);
                this.runIO(run(action.body, scope));
            };
            if (name === "while") {
                for (;;) {
                    checkInterrupt();
                    const state: CodeState = { before: new Map(), changed: new Set() };
                    const values = written.map(item => this.runItem(item, state));
                    if (!this.truthy(values.at(-1)!)) return mkList([]);
                    act(state);
                }
            }
            const [start, condition, step] = written;
            const state: CodeState = { before: new Map(), changed: new Set() };
            this.runItem(start, state);
            while (this.truthy(run(condition.expr, state.scope!))) {
                checkInterrupt();
                act(state);
                if (step.expr.t !== "stmDef" && step.expr.t !== "patDef") this.runIO(run(step.expr, state.scope!));
                else {
                    // A step's new binding is computed now, and each pass reads it in a
                    // fresh scope, so a long loop builds no chain of versions.
                    this.written(this.runItem(step, state))?.binds?.forEach(value => this.demand(value));
                    state.scope = new Env(start.env);
                    for (const [name, value] of state.before) state.scope.setLocal(name, value);
                }
            }
            return mkList([]);
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
            target.v = target.schema ? this.conform(target.schema, value)
                : this.checkedExecution ? this.protectDynamicWrite(target.v, value, "Mutable") : value;
            return { kind: "list", v: [] };
        }
        if (name === "intrinsics.seq") { this.demand(argsIn[0]); return argsIn[1]; }
        if (STANDARD_NATIVES.some(([n]) => n === name)) return standardNative(this, name, argsIn);
        if (name === "typeOf") {
            const ref = this.reference(argsIn[0]);
            // A native the prelude models has its definition's type (the
            // definition's own recursive calls, described meanwhile, the native's).
            // (Given some of its arguments, the definition given them: take 2.)
            const definition = ref.kind === "native" && !ref.tag && !this.describingModeled.has(ref.name) ? this.modeledDefinitions.get(ref.name) : undefined;
            if (definition && ref.kind === "native") {
                this.describingModeled.add(ref.name);
                try { return this.callNative("typeOf", [ref.applied.reduce((f: Value, x) => this.apply(f, x), definition)]); }
                finally { this.describingModeled.delete(ref.name); }
            }
            // A view's type is its builder's.
            if (ref.kind === "native" && ref.view && ref.build && !ref.applied.length) return this.callNative("typeOf", [ref.build]);
            if (ref.kind === "closure" || ref.kind === "clauseFn" || ref.kind === "native") {
                return { kind: "type", inspect: true, name: "Function", description: describeType(ref) };
            }
            if (ref.kind === "mutable") return { kind: "type", inspect: true, name: "Mutable" };
            if (ref.kind === "functionType") return { kind: "type", inspect: true, name: "Type" };
            if (ref.kind === "contract") return { kind: "functionType", from: ref.from, to: ref.to };
            const value = this.demand(ref);
            const declared = this.declaredTypes.get(value);
            if (declared && this.asWritten.has(declared)) return declared;
            if (value.kind === "io") return { kind: "type", inspect: true, name: "IO", description: ioTypeText(value) };
            // An undecided value: return x is m T for the monad m the context
            // decides; a call of result overloads is one of their results.
            if (value.kind === "pending") {
                const step = value.step;
                if (step.op === "call") return { kind: "type", inspect: true, name: "Undecided", description: [...new Set(step.choices.map(c => this.clauseHead(c, step.fn.env) ?? "a"))].join(" | ") };
                const held = step.op === "return" ? this.typeText(step.value) : "a";
                return { kind: "type", inspect: true, name: "Undecided", description: `m ${/\s/.test(held) && !/^[[(]/.test(held) ? `(${held})` : held}` };
            }
            // A type named by its one constructor, which unapplied is a function,
            // is that constructor applied to its fields' types (UserId Int).
            if (value.kind === "variant" && value.family && value.family.name === value.tag && value.v.length && this.typeArguments(value.family) < 0) {
                const types = this.declaredFieldTypes(value.family, value.tag);
                if (types) return this.constructedType(value.family, value.tag, types);
            }
            if (value.kind === "variant" && value.family) return { kind: "type", inspect: true, name: value.family.name, family: value.family, arguments: this.variantArguments(value) };
            if (isNumeric(value)) return { kind: "type", inspect: true, name: numericType(value) };
            if (value.kind === "list" && value.schema) return this.inspectType(value.schema);
            // A list's type is its items' types, as a record's is its fields'.
            if (this.isList(value)) return this.itemTypes(value);
            // A map's, its keys' and values' (a and b when it holds none).
            if (value.kind === "hashmap") {
                const entries = [...value.entries.values()];
                const of = (n: 0 | 1, name: string): Value => entries.length
                    ? this.union(entries.map(entry => this.reference(this.callNative("typeOf", [entry[n]]))))
                    : { kind: "type", name, variable: true };
                return { kind: "type", inspect: true, name: "HashMap", arguments: [of(0, "a"), of(1, "b")] };
            }
            // A record's type is its fields' types ([x = 1] is a [x : Int]),
            // each found when shown; a shared object's fields are live.
            if (value.kind === "record" && !value.shared) return { kind: "record", v: value.v.map(([key, field]): [string, Value] => [key, this.defer(() => this.callNative("typeOf", [field]))]) };
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
            if (target.kind === "type") this.valuesType(target);
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
        // Source text read as syntax data (toAST's lists).
        // Code as data: a list's items as written (or source text), as lists
        // (see lib/std/syntax.apn).
        if (name === "intrinsics.syntax") {
            const code = this.code(this.dataValue(argsIn[0]));
            // Source text reads as the program's code does.
            if (code.kind === "string") {
                const stmts = this.readSource(code.v, "<syntax>");
                return this.sexprOf(stmts.length === 1 ? stmts[0] : { t: "block", stmts, style: "{" });
            }
            if (!this.isList(code)) throw new APNError("runtime", "toAST reads code, a list", { hint: "write toAST [x + 1]" });
            return mkList([mkStr("[]"), ...this.items(code).map(item => {
                const written = this.written(item);
                return this.sexprOf(written ? written.expr : this.readSource(this.writtenText(item), "<syntax>")[0]);
            })]);
        }
        if (name === "intrinsics.written") return mkStr(this.writtenText(argsIn[0]));
        // Whether a list's item is a binding (x = 1), unevaluated: code that
        // yields no value (see reduce).
        if (name === "intrinsics.binding") return { kind: "bool", v: !!this.written(argsIn[0])?.binds };
        if (name === "intrinsics.yields") return this.yields(argsIn[0]);
        // An x <- m item (see runItem); bound gives the code x = r, which joined
        // before the items after it binds x to r for them (see appendCode).
        if (name === "intrinsics.runs") return { kind: "bool", v: !!this.written(argsIn[0])?.runs };
        if (name === "intrinsics.bound") {
            const item = this.written(argsIn[0]);
            if (!item?.runs) throw new APNError("runtime", "bound needs an x <- m item");
            const env = new Env(item.env), result = " result";
            env.setLocal(result, argsIn[1]);
            return this.codeList([{ t: "patDef", pattern: (item.expr as Extract<Expr, { t: "patDef" }>).pattern, value: { t: "var", name: result } }], env);
        }
        // An operator's precedence and associativity, as fromAST needs them.
        if (name === "intrinsics.fixity") {
            const op = this.dataValue(argsIn[0]);
            if (op.kind !== "string") throw new APNError("runtime", "fixity needs an operator name");
            const { prec, assoc } = this.valueFixity(op.v);
            return mkList([mkInt(BigInt(prec)), mkStr(assoc)]);
        }
        // eval's source runs at the program's top level, as a group: its
        // bindings stay inside it, and an action is returned, not run.
        if (name === "intrinsics.eval") {
            const source = this.dataValue(argsIn[0]);
            if (source.kind !== "string") throw new APNError("runtime", "eval needs syntax data, as toAST gives");
            const stmts = this.readSource(source.v, "<eval>");
            const caller = this.env;
            this.env = this.live(this.programEnv);
            try { return this.demand(this.eval({ t: "block", stmts, style: "{" })); } finally { this.env = caller; }
        }
        if (name === "step") return this.stepNative(argsIn);
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
        // debug shows a value as code: a list's items as written, any other value
        // as source writes it (strings quoted), highlighted on a terminal.
        if (name === "debug") {
            const text = this.writtenText(argsIn[0]);
            console.log(this.paint ? this.paint(text, "code") : text);
            return mkList([]);
        }
        const args = argsIn.map((x, index) => ["print", "emit", "toString", "format"].includes(name) || (name === "foldl" && index === 0) ? this.demand(x) : this.dataValue(x));
        const a = args[0];
        // An undecided value reaching a builtin that needs a plain value.
        if (!TAKES_UNDECIDED.has(name)) for (const x of args) if (x.kind === "pending") this.ambiguous(x);
        // A named subtype is its base to builtins: sqrt (Money 4.0) is 2.0.
        if (!TAKES_UNDECIDED.has(name)) args.forEach((x, n) => { args[n] = this.baseValue(x); });
        switch (name) {
            // Output actions yield [] (nothing), as print does in Haskell.
            case "print":
                this.printValue(a);
                return mkList([]);
            case "emit":
                this.printValue(a, false);
                return mkList([]);
            case "repl":
                if (!this.interactive) throw new APNError("runtime", "repl needs a terminal: run the program with apn");
                this.session(this.interactive);
                return mkList([]);
            case "intrinsics.tag": return this.tagged(args[0], args[1], args[2]);
            case "intrinsics.get": return this.builtinGet(this.force(args[0]), args[1]);
            case "intrinsics.with": return this.assignItem(this.dataValue(args[0]), this.dataValue(args[1]), args[2]);
            case "intrinsics.union": return this.union([...this.elements(args[0])].map(x => this.reference(x)));
            case "intrinsics.intersection": return this.intersection([...this.elements(args[0])].map(x => this.reference(x)));
            case "intrinsics.truthy": return mkBool(this.truthy(args[0]));
            case "intrinsics.refine": {
                const base = this.reference(this.demand(args[0]));
                if (!this.isTypeValue(base)) throw new APNError("runtime", `a refinement refines a type, and ${this.renderString(base)} is not one`);
                return { kind: "type", name: "", choices: [base], refine: this.reference(args[1]) };
            }
            case "intrinsics.readFileFrom": {
                const path = this.force(args[0]);
                if (path.kind !== "string") throw new APNError("runtime", "readFileFrom expects a file path string");
                const full = sourcePath(path.v, this.runningDir(), this.moduleSources);
                const text = this.moduleSources ? readLoad(full, this.moduleSources) : (() => { try { return Deno.readTextFileSync(full); } catch { return undefined; } })();
                if (text === undefined) {
                    throw new APNError("runtime", this.moduleSources ? `'${path.v}' is not bundled` : `readFileFrom: cannot read '${path.v}' (looked in '${full}')`,
                        this.moduleSources ? { hint: "a browser build bundles only files inside the program's folder" } : {});
                }
                const read = mkStr(text);
                this.sourcePaths.set(read, { path: full, checked: !!this.checking && !this.dynamicDepth });
                return read;
            }
            case "intrinsics.parse": {
                const source = this.force(args[0]);
                if (source.kind !== "string") throw new APNError("runtime", "parse expects source text");
                return this.parseCode(source);
            }
            // compile entry opts writes an executable running entry, a
            // snapshot of it and what it reaches (docs/runtime-compilation.md).
            case "compile": {
                const options = this.reference(this.demand(argsIn[1]));
                const fields = new Map(options.kind === "record" ? options.v : []);
                const text = (key: string): string | undefined => { const v = fields.get(key); const s = v && this.reference(this.demand(v)); return s?.kind === "string" ? s.v : undefined; };
                const snapshot = captureSnapshot(this, argsIn[0]);
                buildExecutable(snapshot, { name: text("name") ?? "main", target: text("target") ?? "native" });
                return mkList([]);
            }
            case "intrinsics.import": {
                const path = this.force(args[0]);
                if (path.kind !== "string") throw new APNError("runtime", IMPORT_ONE.message, { hint: IMPORT_ONE.hint });
                return this.importStandard(path.v);
            }
            case "intrinsics.runFile": {
                const path = this.force(args[0]);
                if (path.kind !== "string") throw new APNError("runtime", "load runs one file, named by a path string");
                return this.runFile(path.v);
            }
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
                if (a.kind === "string") return mkInt(textNatives.length(a.v));
                let n = 0n;
                for (const _ of this.elements(a)) n++;
                return mkInt(n);
            }
            case "null":
                if (a.kind === "hashmap") return mkBool(a.entries.size === 0);
                if (a.kind === "string") return mkBool(a.v.length === 0);
                return mkBool((this.isList(a) || a.kind === "pending") && this.cell(a) === null);
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
            // view build match: a builder whose pattern takes values apart by match.
            case "view": {
                const [match] = [args[1]], arity = this.arity(args[0]) ?? 0;
                // A nullary view is the value it builds wherever it is used, so
                // that value is what its name holds: it remembers the view.
                const build = arity ? args[0] : this.force(args[0]);
                const view: Value = { kind: "native", name: "view", arity, applied: [], view: match, build,
                    invoke: (xs: Value[]) => xs.reduce((f: Value, x) => this.apply(f, x), build) };
                if (!arity) this.nullaryViews.set(build, view);
                return view;
            }
            // The two reads of a value Takes takes a function apart by.
            case "intrinsics.isFunction": return mkBool(this.isFunction(args[0]));
            case "intrinsics.inputOf": return this.accepted(args[0]);
            case "intToString":
                if (a.kind !== "int") throw new Error("Runtime: intToString expects int");
                return mkStr(String(a.v));
            case "pairs":
                if (a.kind === "hashmap") return mkList([...a.entries.values()].map(([key, value]) => mkList([key, value])));
                // [] is the empty record too (it becomes one when a field is assigned).
                if (this.isList(a) && !this.cell(a)) return mkList([]);
                if (a.kind !== "record") throw new APNError("runtime", "pairs expects a record");
                return mkList(a.v.map(([k, v]) => mkList([mkStr(k), v])));
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

        }
        throw new Error(`Runtime: unknown native '${name}'`);
    }

    // [..] = code, run as a statement: the code's statements run where it stands,
    // in this scope, as written there (a loaded file's imports, definitions and
    // effects), reading files beside the code's own file; then what they bound
    // is this scope's, as the file's (see moduleValues). Code whose last
    // statement uses other code (a file loading itself) ends there: the other
    // runs in its place, as a tail call, its bindings joining the first's.
    private spliceCode(code: Value, caller: Env): Value {
        const running = this.env, callerDir = this.sourceDir, module = this.moduleValues.get(code);
        this.env = caller;
        try {
            for (;;) {
                checkInterrupt();
                const program = this.codeItems(code)!.map((expr): TopLevel => expr.t === "stmDef" ? { t: "def", name: expr.name, clauses: expr.clauses }
                    : expr.t === "typeDef" ? { t: "type", def: expr.def } : expr.t === "patDef" ? expr : { t: "expr", value: expr });
                this.env = new Env(this.env);
                const dir = this.codeSources.get(code);
                if (dir !== undefined) this.sourceDir = dir;
                try {
                    this.runDepth++;
                    try { this.run(program, true); } finally { this.runDepth--; }
                }
                catch (step) {
                    if (!(step instanceof TailLoad)) throw step;
                    code = step.code;
                    this.env = step.env;
                    continue;
                }
                break;
            }
            // What it bound, each tail's scope over the one before it.
            const scopes: Env[] = [];
            for (let e: Env | null = this.env; e && e !== caller; e = e.parent) scopes.unshift(e);
            const bindings = new Map<string, Value>();
            for (const scope of scopes) for (const [name, value] of scope.map) bindings.set(name, value);
            this.env = running;
            this.sourceDir = callerDir;
            // The statement running use adopts the scope this publishes.
            this.publishForeignBindings(caller, [...bindings], module?.origin, module?.checked ?? (!!this.checking && !this.dynamicDepth));
            return mkList([]);
        } catch (error) {
            this.env = running;
            this.sourceDir = callerDir;
            throw error;
        }
    }
    // The items of code, as written; undefined for a list that is no code
    // (code binds a name, or parse wrote it).
    private codeItems(code: Value): Expr[] | undefined {
        const items: Expr[] = [];
        for (let rest = code;;) {
            const cell = this.cell(rest);
            if (!cell) return this.codeSources.has(code) || items.some(e => ["stmDef", "patDef", "typeDef"].includes(e.t)) ? items : undefined;
            const item = this.written(cell.head);
            if (!item) return undefined;
            items.push(item.expr);
            rest = cell.tail;
        }
    }

    iterateList(f: Value, value: Value): Value {
        return this.defer(() => ({
            kind: "cons", head: value,
            tail: this.defer(() => this.iterateList(f, this.defer(() => this.apply(this.demand(f), value)))),
        }));
    }

    // (Its last pair with the key, as code's last binding of a name is read.)
    private associationValue(entries: Value, key: string): Value {
        let rest = entries, found: Value | undefined;
        for (;;) {
            checkInterrupt();
            const entry = this.cell(rest);
            if (entry === null) {
                if (found !== undefined) return found;
                throw new APNError("runtime", `association list has no key ${JSON.stringify(key)}`);
            }
            const pair = this.dataValue(entry.head);
            if (!this.isList(pair)) throw new APNError("runtime", "association lookup expects [string,value] pairs");
            const first = this.cell(pair);
            const second = first && this.cell(first.tail);
            if (!first || !second || this.cell(second.tail) !== null) {
                throw new APNError("runtime", "association lookup expects [string,value] pairs");
            }
            const candidate = this.dataValue(first.head);
            if (candidate.kind !== "string") throw new APNError("runtime", "association lookup expects string keys");
            if (candidate.v === key) found = second.head;
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

    // The fields a list or record gives a record: by name, or all of them in order.
    private givenFields(f: Extract<Value, { kind: "record" }>, carg: Value): Array<[string, Value]> {
        if (carg.kind === "list" && carg.v.length !== 0 && carg.v.length !== f.v.length) {
            throw new Error(`Runtime: field count (${f.v.length}) does not match list size (${carg.v.length})`);
        }
        return carg.kind === "record" ? carg.v : (carg as Extract<Value, { kind: "list" }>).v.map((value, i) => [f.v[i][0], value]);
    }
    // A record's value from a list or record of its fields ([1,2] : V, [] :
    // [v : Int]): each given field takes its value as by assignment, the
    // others their defaults (a type's zero value), a field it does not have
    // joining it. A record holding no type is updated instead.
    private buildRecord(f: Extract<Value, { kind: "record" }>, arg: Value): Value {
        const value = this.dataValue(arg);
        const carg = this.isList(value) ? mkList(this.items(value)) : value;
        if (carg.kind !== "list" && carg.kind !== "record") throw new APNError("runtime", `a record is made from a list or record of its fields, not ${this.typeText(carg)}`);
        const given = this.givenFields(f, carg), slots = new Map(f.v);
        // (A given field's slot is forced to tell, as assigning it would; a
        // field bound to a type, x = Int, is a value, not a slot.)
        const typeGiven = (key: string, v: Value) => this.holdsType(v) && !(carg.kind === "record" && carg.bound?.has(key));
        const building = !given.some(([key, v]) => typeGiven(key, v) && !this.typeOfTypes(slots.get(key)))
            && (!given.length || this.holdsType(f) || given.some(([key]) => slots.has(key) && !f.bound?.has(key) && this.holdsType(this.force(slots.get(key)!))));
        if (!building) return this.assignFields(f, given.map(([key, v]) => [key, this.demand(v)]));
        const supplied = new Map(given);
        for (const [key, slot] of f.v) {
            if (slot.kind === "type" && slot.name === "$any" && !supplied.has(key)) {
                throw new APNError("runtime", `missing field '${key}'`);
            }
        }
        const out: [string, Value][] = f.v.map(([key, slot]) => [key, this.defer(() => supplied.has(key)
            ? this.assignSlot(slot, this.reference(supplied.get(key)!)) : this.defaultField(slot, []))]);
        for (const [key, v] of given) if (!slots.has(key)) out.push([key, v]);
        // What it builds holds values: every field is bound.
        const result: Value = { kind: "record", v: out, bound: new Set(out.map(([key]) => key)) };
        // A schema's value is declared its type, as List T's.
        if (this.isTypeValue(f)) this.declaredTypes.set(result, f);
        return result;
    }
    // A value given to a template's slot or item, as ascription gives it.
    // A slot's value: a type's member (as ascription makes it), a record
    // schema's record, or a function's result (a template of functions).
    private filled(target: Value, value: Value): Value {
        if (target.kind === "record") return this.buildRecord(target, value);
        const type = this.reference(target);
        return type.kind === "type" ? this.typeValue(type, value) : this.apply(target, value);
    }
    applyTemplateSlot(template: Value, value: Value): Value {
        const forced = this.force(template), target = this.sharedType(forced) ?? forced;
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
        return this.isList(target) ? this.templateList(target, value, true) : this.filled(target, value);
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
                    // A type variable no call decided takes any value, as conform's does.
                    if (target.kind === "type" && target.variable) return this.reference(value.head);
                    return this.isList(target) ? this.templateList(target, value.head) : this.filled(target, value.head);
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
    // Whether e : T converts a value, which (p : T) in a pattern needs: a
    // positional type ([Int,Float], Vect 2 Int) a list of as many, each item
    // converting; a record type each field; else the conversion itself. An
    // item still to compute (not a literal) is left to convert as it is used,
    // as for List Int.
    private converts(typeIn: Value, value: Value): boolean {
        const literal = value.kind === "thunk" && ["int", "float", "bool", "string", "char", "list", "record"].includes(value.body.t);
        if ((value.kind === "thunk" || value.kind === "deferred") && value.value === undefined && !literal) return true;
        const type = this.reference(typeIn);
        let items: Value[] | undefined;
        if (this.isList(type) && !this.repeatedType(type)) items = [...this.elements(type)];
        else if (type.kind === "type" && this.counted(type)) { const [size, element] = this.vectorParts(type); items = Array.from({ length: Number(size) }, () => element); }
        if (items) {
            let rest = this.dataValue(value);
            if (!this.isList(rest)) return false;
            for (const item of items) {
                const cell = this.cell(rest);
                if (!cell || !this.converts(item, cell.head)) return false;
                rest = cell.tail;
            }
            return this.cell(rest) === null;
        }
        const given = this.demand(value);
        if (type.kind === "record" && this.isTypeValue(type)) {
            const input = this.recordPatternInput(type, given);
            if (input === null) return false;
            const fields = input.kind === "record" ? new Map(input.v) : undefined, positional = fields ? [] : [...this.elements(input)];
            return type.v.every(([key, field], n) => {
                const held = fields ? fields.get(key) : positional[n];
                return held === undefined || this.converts(field, held);
            });
        }
        try { this.demand(this.conform(type, given)); return true; }
        catch (error) { if (error instanceof APNError && error.kind === "runtime") return false; throw error; }
    }
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

    // (F n a xs) for a type function of lists: n is read back from the
    // length, which F makes c * n + d (see countingOf).
    private vectorTypeSources = new WeakMap<Map<string, Value>, Map<string, Value[]>>();
    private matchVectorPattern(family: Extract<Value, { kind: "type" }>, args: Pattern[], input: Value, binds: Map<string, Value>): boolean {
        const value = this.dataValue(input), counts = family.counts!;
        if (!this.isList(value)) return false;
        let size: bigint, element: Value | undefined;
        const sizePattern = args[0];
        const known = sizePattern.p === "var" ? binds.get(sizePattern.name) ?? this.lengthValue(sizePattern.name) : undefined;
        const fixed = sizePattern.p === "int" ? mkInt(sizePattern.v) : known && this.dataValue(known);
        if (fixed && (fixed.kind !== "int" || fixed.v < 0n)) return false;
        const limit = fixed?.kind === "int" ? counts.scale * fixed.v + counts.offset : undefined;
        // Its length and element type both given (Vect 2 Float), it is the
        // positional type it makes, which takes what converts to it.
        const named = args[1].p === "constr" && !args[1].args.length && this.env.get(args[1].tag);
        const requested = named && this.reference(named);
        if (fixed?.kind === "int" && requested && this.isTypeValue(requested)) {
            const type: Value = { ...family, arguments: [fixed, requested] };
            return this.converts(type, value) && this.matchPattern(args[2], this.conform(type, value), binds);
        }
        // A type variable (Vect n a) or _ reads no element, as List a's does:
        // a is the elements' type, computed only if used, and the checker's
        // to compare; a written type (Vect n Int) is every element's.
        const typePattern = args[1], free = typePattern.p === "var" || typePattern.p === "wildcard";
        if (value.kind === "list" && value.schema?.kind === "type" && this.counted(value.schema)) {
            [size, element] = this.vectorParts(value.schema);
        } else {
            size = 0n;
            let rest = value;
            for (;;) {
                checkInterrupt();
                const cell = this.cell(rest);
                if (!cell) break;
                if (limit !== undefined && size >= limit) return false;
                if (!free) {
                    const current = this.callNative("typeOf", [cell.head]);
                    if (element && !this.sameType(element, current)) return false;
                    element = current;
                }
                size++;
                rest = cell.tail;
            }
        }
        if (limit !== undefined && size !== limit || size < counts.offset || (size - counts.offset) % counts.scale) return false;
        const index = (size - counts.offset) / counts.scale;
        if (!this.matchPattern(args[0], mkInt(index), binds)) return false;
        if (typePattern.p === "var") {
            // Of several lists sharing a, the first with elements gives it
            // (inspect [] [1,2] has a = Int).
            const sharing = this.vectorTypeSources.get(binds) ?? new Map<string, Value[]>();
            this.vectorTypeSources.set(binds, sharing);
            if (binds.has(typePattern.name)) sharing.get(typePattern.name)?.push(value);
            else {
                const lists = [value];
                sharing.set(typePattern.name, lists);
                binds.set(typePattern.name, element ?? this.defer(() => {
                    const source = lists.find(list => this.cell(list) !== null) ?? value;
                    return this.readElementType(source.kind === "list" && source.schema?.kind === "type" && this.counted(source.schema) ? this.vectorParts(source.schema)[1] : this.elementType(source));
                }));
            }
            element = undefined;
        } else if (typePattern.p === "constr" && typePattern.args.length === 0) {
            const binding = this.env.get(typePattern.tag);
            if (!binding) return false;
            const requested = this.reference(binding);
            if (!this.isTypeValue(requested) || (element && !this.sameType(requested, element))) return false;
            element = requested;
        } else if (typePattern.p !== "wildcard") {
            if (!element || !this.matchPattern(typePattern, element, binds)) return false;
        }
        const type: Value = { ...family, arguments: [mkInt(index), element ?? { kind: "type", name: "$any" }] };
        return this.matchPattern(args[2], this.conform(type, value), binds);
    }

    // A typed pattern whose type names what it binds: (Vect n a) xs, the same
    // as Vect n a xs, binds the length and element type; (List a) xs binds a
    // to the elements' type, computed only if used. undefined when the type
    // binds nothing (every name in it is bound).
    // A typed pattern headed by a free name, given an applied type, takes the
    // type apart, as (Option t) matches a type value: t1 1 t2 given Vect 1 Int
    // binds t1 to Vect and t2 to Int, and 1 must be its first argument.
    private typeShape(p: Extract<Pattern, { p: "schema" }>, v: Value, binds: Map<string, Value>): boolean | undefined {
        const pieces: Expr[] = [];
        let head = p.type;
        for (; head.t === "app"; head = head.f) pieces.unshift(head.a);
        if (head.t !== "var" || !/^[a-z]/.test(head.name) || binds.has(head.name) || this.env.get(head.name) !== undefined) return undefined;
        const given = this.reference(v);
        if (given.kind !== "type" || !given.arguments?.length) return undefined;
        if (pieces.length + 1 !== given.arguments.length) return false;
        const base = this.env.get(given.name);
        binds.set(head.name, base ? this.reference(base) : { kind: "type", name: given.name, family: given.family });
        const part = (e: Expr): Pattern | undefined => e.t === "var" ? { p: "var", name: e.name } : e.t === "placeholder" ? { p: "wildcard" }
            : e.t === "int" ? { p: "int", v: e.v } : e.t === "float" ? { p: "float", v: e.v } : e.t === "string" ? { p: "string", v: e.v }
            : e.t === "char" ? { p: "char", v: e.v } : undefined;
        for (const [n, piece] of pieces.entries()) {
            const pattern = part(piece);
            if (!pattern || !this.matchPattern(pattern, given.arguments[n], binds)) return false;
        }
        return this.matchPattern(p.value, given.arguments[pieces.length], binds);
    }

    // A capitalized function applied to all its parameters runs its clauses
    // and gives what they give (V n = Vect n Int: V 3 is Vect 3 Int). A type
    // it gives remembers how it was written (Pairs 2 Int), unless a scalar
    // one (a named scalar is Count = Int's kind): it is that type wherever one
    // is used, and the values it makes remember it.
    private construct(f: Extract<Value, { kind: "type" }>, args: Value[]): Value {
        let result: Value = f.alias!.run;
        for (const arg of args) result = this.apply(result, arg);
        return this.remembered(f.name, args.map(arg => this.reference(arg)), this.reference(this.demand(result)));
    }
    // A type a capitalized name gives, remembering how it was written: a
    // type or a schema (a record or list of types), not a scalar (see Count =
    // Int) nor a constructor (an alias of one is that constructor), nor the
    // empty list, a value first (Nil = []).
    // A type's name applied to these (Box Int, Vector3 [x : Int], Pairs (Box Int)).
    private appliedName(name: string, args: Value[]): string {
        return [name, ...args.map(arg => this.renderString(arg)).map(text => /\s/.test(text) && !/^\[.*\]$/.test(text) ? `(${text})` : text)].join(" ");
    }
    private remembered(name: string, args: Value[], made: Value): Value {
        const remembers = made.kind === "type" ? !made.variable && !(OWN_SCALAR_TYPES.has(made.name) && !made.arguments?.length && !made.family)
            : (made.kind === "record" || this.isList(made) && this.cell(made) !== null) && this.isTypeValue(made);
        if (!remembers) return made;
        // A union of list types is known by its name (Pairs Int), not its unread choices.
        const named = (made.kind === "type" && made.choices && !made.name
            ? { ...made, name: this.appliedName(name, args) }
            : { ...made }) as Value;
        this.asWritten.set(named, { name, args, made });
        return named;
    }
    // A type function's arguments read back from a value its clauses
    // describe, by running them backwards: [1,2,3,4] is Pairs 2 Int, through
    // Pairs Z a = [] and Pairs (S k) a = a :: a :: Pairs k a. A clause's
    // result is matched as a pattern ([], [a,b], x :: rest, the function
    // again), its elements' types binding its type variables, and its
    // parameter patterns (Z, S k, a) are built from what they bound.
    private readBack(f: Extract<Value, { kind: "clauseFn" }>, value: Value): Value[] | undefined {
        for (const clause of f.clauses) {
            const variables = new Set(clause.params.flatMap(patternVariables)), binds = new Map<string, Value>();
            if (!this.describes(f, variables, clause.body, value, binds)) continue;
            const scope = new Env(f.env), caller = this.env;
            // A type variable no element decided stays one ([] is Pairs 0 a).
            for (const name of variables) scope.setLocal(name, binds.get(name) ?? { kind: "type", name, variable: true });
            this.env = scope;
            try { return clause.params.map(p => this.reference(this.eval(this.assignmentKey(p)))); }
            catch (error) { if (!(error instanceof APNError)) throw error; }
            finally { this.env = caller; }
        }
        return undefined;
    }
    private describes(f: Extract<Value, { kind: "clauseFn" }>, variables: Set<string>, body: Expr, value: Value, binds: Map<string, Value>): boolean {
        while (body.t === "block" && body.style === "(" && body.stmts.length === 1) body = body.stmts[0];
        const list = this.dataValue(value);
        if (body.t === "list") {
            let rest: Value = list;
            for (const item of body.v) {
                const cell = this.isList(rest) ? this.cell(rest) : null;
                if (!cell || !this.holds(f, variables, item, cell.head, binds)) return false;
                rest = cell.tail;
            }
            return this.isList(rest) && this.cell(rest) === null;
        }
        if (body.t === "binop" && body.op === "::") {
            const cell = this.isList(list) ? this.cell(list) : null;
            return !!cell && this.holds(f, variables, body.l, cell.head, binds) && this.describes(f, variables, body.r, cell.tail, binds);
        }
        // The function again: its arguments, read back from the rest, agree
        // with what the clause names them.
        const args: Expr[] = [];
        let head: Expr = body;
        while (head.t === "app") { args.unshift(head.a); head = head.f; }
        if (head.t !== "var" || head.name !== f.name || args.length !== f.arity) return false;
        const read = this.readBack(f, list);
        return !!read && args.every((arg, n) => {
            if (arg.t !== "var" || !variables.has(arg.name)) return false;
            const known = binds.get(arg.name), given = read[n];
            if (known === undefined || known.kind === "type" && known.variable) { binds.set(arg.name, given); return true; }
            return given.kind === "type" && given.variable || this.sameType(known, given);
        });
    }
    // An element against the type its clause gives it: a type variable takes
    // the element's type (or must already be it); another type must hold it.
    private holds(f: Extract<Value, { kind: "clauseFn" }>, variables: Set<string>, type: Expr, element: Value, binds: Map<string, Value>): boolean {
        const value = this.demand(element);
        if (type.t === "var" && variables.has(type.name)) {
            const known = binds.get(type.name);
            if (known && !(known.kind === "type" && known.variable)) return this.belongsToType(known, value);
            binds.set(type.name, this.reference(this.callNative("typeOf", [value])));
            return true;
        }
        const caller = this.env;
        this.env = new Env(f.env);
        for (const [name, bound] of binds) this.env.setLocal(name, bound);
        try { return this.belongsToType(this.reference(this.eval(type)), value); }
        catch (error) { if (error instanceof APNError) return false; throw error; }
        finally { this.env = caller; }
    }
    // A type as written (Pairs 2 Int), and the one it is (Vect 4 Int).
    private asWritten = new WeakMap<Value, { name: string; args: Value[]; made: Value }>();
    // A value a written type made, remembering it: a copy of its outer part,
    // so the value it was made from keeps its own type.
    private writtenValue(type: Value, made: Value): Value {
        const value = { ...this.reference(this.demand(made)) } as Value;
        this.declaredTypes.set(value, type);
        return value;
    }
    // A variant's type arguments, its narrowest type's: those it was given
    // (Option Int None) or its indices, else what its fields decide (Box 5 is
    // Box Int: a field naming a parameter, or holding it as a type's argument,
    // Option a). One nothing decides is a type variable (None is Option a).
    private typeOfRunning = new Set<Value>();
    private variantArguments(v: Extract<Value, { kind: "variant" }>): Value[] | undefined {
        const parameters = v.family?.parameters ?? [];
        if (v.arguments?.length || !parameters.length) return v.arguments;
        const indices = this.indicesOf(v);
        if (indices) return indices;
        const found = new Map<string, Value>();
        // A value holding itself (xs = Cons 1 xs) decides nothing more inside.
        if (!this.typeOfRunning.has(v)) {
            this.typeOfRunning.add(v);
            try {
                const read = (spec: Expr, type: () => Value): void => {
                    if (!freeTypeNames(spec).some(name => parameters.includes(name) && !found.has(name))) return;
                    const t = this.reference(type());
                    if (spec.t === "var") { if (!(t.kind === "type" && t.variable)) found.set(spec.name, t); return; }
                    const args: Expr[] = [];
                    let head: Expr = spec;
                    while (head.t === "app") { args.unshift(head.a); head = head.f; }
                    if (head.t === "var" && t.kind === "type" && t.name === head.name && t.arguments?.length === args.length) {
                        args.forEach((arg, n) => read(arg, () => t.arguments![n]));
                    }
                };
                (v.family?.fields?.get(v.tag) ?? []).forEach((spec, n) => {
                    if (n < v.v.length) read(spec, () => this.callNative("typeOf", [v.v[n]]));
                });
            } finally { this.typeOfRunning.delete(v); }
        }
        return parameters.map(name => found.get(name) ?? { kind: "type", name, variable: true });
    }
    // A union of types: a value of any of them is one of it. Unions inside
    // flatten and a type given twice counts once. A list type is kept as
    // written, its rest unread (Pairs a = [] | a :: a :: Pairs a holds itself):
    // a type test unfolds it (see belongsToType), and the union is known by
    // the name it is given (see remembered).
    private union(types: Value[]): Value {
        if (!this.typeOperands && this.ofValues(types)) return types.map(t => this.dataValue(t)).reduce((a, b) => this.joined(a, b));
        const choices: Value[] = [];
        let unfolds = false;
        for (const type of types.flatMap(t => t.kind === "type" && t.choices && !t.refine ? t.choices : [t])) {
            if (this.isList(type)) { unfolds = true; choices.push(type); continue; }
            if (!this.isTypeValue(type)) throw new APNError("runtime", `a union lists types, and ${this.renderString(type)} is not one`);
            if (!choices.some(c => !this.isList(c) && this.sameType(c, type))) choices.push(this.sharedType(this.reference(type)) ?? type);
        }
        if (choices.length === 1) return choices[0];
        const name = unfolds ? "" : choices.map(c => this.renderString(c)).join(" | ");
        return { kind: "type", name, choices };
    }
    // Every value is a set, and <=, & and | are inclusion, intersection and
    // union of those sets: a type is its values; a number its cut (the numbers
    // below it), so they are ordered (a Bool is 0 or 1, a Char its code point);
    // a list or a string its (position, element) pairs, so <= is being a
    // prefix; a record or a HashMap its (key, value) pairs.
    private setOf(v: Value): "type" | "ordered" | "sequence" | "graph" | undefined {
        // A list or record is a value; it is read as a type where one is
        // expected (beside a type, or written where a type goes).
        if (this.isList(v)) return "sequence";
        if (v.kind === "record") return "graph";
        if (this.isTypeValue(v)) return "type";
        if (isNumeric(v) || v.kind === "bool" || v.kind === "char") return "ordered";
        if (v.kind === "string") return "sequence";
        if (v.kind === "hashmap") return "graph";
        return undefined;
    }
    // Inside a | or & written where a type is expected (see typeOperators).
    private typeOperands = 0;
    // Whether a union or an intersection is of values, not of types.
    private ofValues(values: Value[]): boolean {
        const kinds = values.map(v => this.setOf(this.dataValue(v)));
        return values.length > 0 && !kinds.includes("type") && kinds.every(Boolean);
    }
    private setKinds(a: Value, b: Value, op: string): "ordered" | "sequence" | "graph" {
        const x = this.setOf(a), y = this.setOf(b);
        const same = x === y && x !== "type" && x && (x !== "sequence" || (a.kind === "string") === (b.kind === "string"));
        if (!same) throw new APNError("runtime", `${op === "<=" ? "cannot compare" : `cannot apply '${op}' to`} ${this.renderString(a)} and ${this.renderString(b)}`, { hint: "both are numbers, lists, strings, records or types" });
        return x as "ordered" | "sequence" | "graph";
    }
    // An ordered value's place (False 0, True 1, a Char its code point).
    private rank(v: Value): Value { return v.kind === "bool" ? mkInt(v.v ? 1n : 0n) : v.kind === "char" ? mkInt(BigInt(v.v.codePointAt(0)!)) : v; }
    // The (position or key, value) pairs of a value read as a set, in order.
    private *pairs(v: Value): Generator<[Value, Value]> {
        if (v.kind === "string") { let n = 0n; for (const c of v.v) yield [mkInt(n++), { kind: "char", v: c }]; return; }
        if (v.kind === "record") { for (const [key, x] of v.v) yield [mkStr(key), x]; return; }
        if (v.kind === "hashmap") { for (const [key, x] of v.entries.values()) yield [key, x]; return; }
        let n = 0n;
        for (let rest: Value = v; ;) {
            checkInterrupt();
            const cell = this.cell(rest);
            if (!cell) return;
            yield [mkInt(n++), cell.head];
            rest = cell.tail;
        }
    }
    // The value a pair holds at a position or key, if any.
    private at(v: Value, key: Value): Value | undefined {
        if (v.kind === "record") return v.v.find(([k]) => k === (key as { v: string }).v)?.[1];
        if (v.kind === "hashmap") return v.entries.get(this.hashKey(key))?.[1];
        let rest: Value = v;
        for (let n = (key as { v: bigint }).v; ; n--) {
            const cell = this.cell(rest);
            if (!cell) return undefined;
            if (n === 0n) return cell.head;
            rest = cell.tail;
        }
    }
    // a <= b: a's set within b's.
    private subset(a: Value, b: Value): boolean {
        // Beside a type, a list or record is read as one ([Int] <= List Int).
        if (this.setOf(a) === "type" || this.setOf(b) === "type") {
            const x = this.asType(a), y = this.asType(b);
            if (x && y) return this.within(x, y);
        }
        const kind = this.setKinds(a, b, "<=");
        if (kind === "ordered") return this.compare(this.rank(a), this.rank(b)) <= 0;
        if (a.kind === "string" && b.kind === "string") return b.v.startsWith(a.v);
        if (kind === "sequence") return this.prefixOf(a, b);
        for (const [key, x] of this.pairs(a)) {
            const y = this.at(b, key);
            if (y === undefined || !this.equals(x, y)) return false;
        }
        return true;
    }
    // a & b: the pairs both have (the longest common prefix, the fields equal
    // in both), the lesser of two ordered values, or both types' values.
    private intersection(values: Value[]): Value {
        if (this.typeOperands || !this.ofValues(values)) {
            const types = values.map(v => this.reference(v));
            const bad = types.find(t => !this.isTypeValue(t));
            if (bad) throw new APNError("runtime", `an intersection is of types or of values, and ${this.renderString(bad)} is not a type`);
            if (types.length === 1) return types[0];
            const [first, ...rest] = types;
            const test: Value = { kind: "native", name: "$intersection", arity: 1, applied: [], invoke: ([given]) => mkBool(rest.every(t => this.refinedMember(t, given) !== undefined)) };
            return { kind: "type", name: types.map(t => this.renderString(t)).join(" & "), choices: [first], refine: test };
        }
        return values.map(v => this.dataValue(v)).reduce((a, b) => {
            const kind = this.setKinds(a, b, "&");
            if (kind === "ordered") return this.compare(this.rank(a), this.rank(b)) <= 0 ? a : b;
            if (a.kind === "string" && b.kind === "string") {
                let n = 0;
                while (n < a.v.length && a.v[n] === b.v[n]) n++;
                return mkStr(a.v.slice(0, n));
            }
            if (kind === "sequence") return mkList(this.commonPrefix(a, b));
            const both = [...this.pairs(a)].filter(([key, x]) => { const y = this.at(b, key); return y !== undefined && this.equals(x, y); });
            if (a.kind === "record") return { kind: "record", v: both.map(([key, x]) => [(key as { v: string }).v, x]) };
            return { kind: "hashmap", entries: new Map(both.map(([key, x]) => [this.hashKey(key), [key, x]])) };
        });
    }
    // The items two lists start with alike, walking both once.
    private commonPrefix(a: Value, b: Value): Value[] {
        const out: Value[] = [];
        for (let x: Value = a, y: Value = b; ;) {
            checkInterrupt();
            const p = this.cell(x), q = this.cell(y);
            if (!p || !q || !this.equals(p.head, q.head)) return out;
            out.push(p.head); x = p.tail; y = q.tail;
        }
    }
    // Whether list a starts list b.
    private prefixOf(a: Value, b: Value): boolean {
        for (let x: Value = a, y: Value = b; ;) {
            checkInterrupt();
            const p = this.cell(x);
            if (!p) return true;
            const q = this.cell(y);
            if (!q || !this.equals(p.head, q.head)) return false;
            x = p.tail; y = q.tail;
        }
    }
    // a | b of values: the greater of two ordered values, else both sets'
    // pairs, which must still make one (a list, of which the other is a
    // prefix; a record or HashMap agreeing on the keys both have).
    private joined(a: Value, b: Value): Value {
        const kind = this.setKinds(a, b, "|");
        if (kind === "ordered") return this.compare(this.rank(a), this.rank(b)) >= 0 ? a : b;
        if (kind === "sequence") {
            if (this.subset(a, b)) return b;
            if (this.subset(b, a)) return a;
            throw new APNError("runtime", `${this.renderString(a)} | ${this.renderString(b)} is no ${a.kind === "string" ? "string" : "list"}: neither starts the other`);
        }
        for (const [key, x] of this.pairs(b)) {
            const y = this.at(a, key);
            if (y !== undefined && !this.equals(x, y)) throw new APNError("runtime", `${this.renderString(a)} | ${this.renderString(b)} disagree at ${this.renderString(key)}`);
        }
        if (a.kind === "record" && b.kind === "record") return { kind: "record", v: [...a.v, ...b.v.filter(([key]) => !a.v.some(([k]) => k === key))] };
        if (a.kind === "hashmap" && b.kind === "hashmap") return { kind: "hashmap", entries: new Map([...b.entries, ...a.entries]) };
        throw new APNError("runtime", `cannot apply '|' to ${this.renderString(a)} and ${this.renderString(b)}`);
    }
    // What a name in X = A | B is bound to here (see unionKind).
    private alternative(name: string, declared: string): Alternative {
        const bound = this.env.get(name), value = bound && this.reference(bound);
        if (!value) return "new";
        if (value.kind === "native" && value.tag || value.kind === "variant") {
            if (value.family?.name === declared) return "new";
            // Declared alone (Circle (r : Float) = _): its own type's.
            const own = value.family && this.declarations.get(value.family);
            if (own && own.variants.length === 1 && own.name === name && !own.extends) return "declared";
            return this.sharedType(value) ? "type" : "constructor";
        }
        return this.isTypeValue(value) ? "type" : "new";
    }
    // Each family's declaration, which a constructor declared into it extends.
    private declarations = new WeakMap<VariantFamily, DataDef>();

    // tag owner ctor fields: a value that remembers the constructor that made
    // it, the type it belongs to and its fields (Some a = tag Option Some [a]).
    // Patterns read the fields back; the value does nothing else.
    private tagged(owner: Value, ctor: Value, fields: Value): Value {
        const name = ctor.kind === "variant" ? ctor.tag : ctor.kind === "native" ? ctor.tag ?? ctor.name : ctor.kind === "clauseFn" || ctor.kind === "type" ? ctor.name : undefined;
        if (!name || !/^[A-Z]/.test(name) && !(ctor.kind === "native" && ctor.tag)) {
            throw new APNError("runtime", "tag's constructor must be a capitalized definition or constructor", { hint: "Some a = tag Option Some [a]" });
        }
        if (!this.isList(fields)) throw new APNError("runtime", "tag's fields must be a list", { hint: `tag ${this.ownerName(owner) ?? "Option"} ${name} [x]` });
        return { kind: "variant", tag: name, v: [...this.elements(fields)], family: this.ownerFamily(owner) };
    }
    // The type a tagged value belongs to: a declared one's family, or one per
    // capitalized definition, so its values share it.
    private owners = new WeakMap<object, VariantFamily>();
    private ownerName(owner: Value): string | undefined {
        return owner.kind === "type" || owner.kind === "clauseFn" ? owner.name : undefined;
    }
    private ownerFamily(given: Value): VariantFamily {
        // A constructor names its type here (Box x = _ is tag Box Box [x]).
        if ((given.kind === "native" && given.tag || given.kind === "variant") && given.family) return given.family;
        const owner = given;
        if (owner.kind === "type" && owner.family && !owner.family.base) return owner.family;
        const key = owner.kind === "type" ? owner.alias : owner.kind === "clauseFn" ? owner.clauses : undefined, name = this.ownerName(owner);
        if (!key || !name || !/^[A-Z]/.test(name)) {
            throw new APNError("runtime", "tag's owner must be a type the program defines", { hint: "Some a = tag Option Some [a]" });
        }
        let family = this.owners.get(key);
        if (!family) {
            // A definition tagging its own values (Box a = tag Box Box [a]) is
            // what Box x = _ declares: its parameters are its type's, each the
            // type of the field in its place (typeOf (Box 3) is Box Int).
            const names = owner.kind === "type" ? owner.alias?.parameters : undefined;
            const run = owner.kind === "type" ? owner.alias?.run : undefined;
            const [clause] = run?.kind === "clauseFn" && run.clauses.length === 1 ? run.clauses : [];
            let body = clause?.body;
            while (body?.t === "block" && body.stmts.length === 1) body = body.stmts[0];
            // Its fields as its tag lists them (tag Pt Pt [y,x]).
            let head = body;
            while (head?.t === "app") head = head.f;
            const tags = head?.t === "var" && head.name === "tag" || head?.t === "recordAccess" && head.field === "tag";
            const listed = tags && body?.t === "app" && body.a.t === "list" ? body.a.v : undefined;
            family = names?.length && listed ? { name, parameters: names, fields: new Map([[name, listed]]), env: new Env(this.env) } : { name };
            this.owners.set(key, family);
        }
        return family;
    }

    // Clauses for a visible function that are for a type this scope declares
    // (see isForTypes) travel with the type's values: they join the function
    // itself, which code anywhere calling it (a library's, a do-block's)
    // sees, and the name here keeps meaning that function (a module exports
    // it as it is). A method's join its instances; any other function's are
    // tried before it.
    private travelling(name: string, clauses: DefClause[]): Value | undefined {
        // (Read only for clauses naming a type at all: a visible value is not run.)
        const previous = isForTypes(clauses, () => true, true) ? this.env.get(name) : undefined;
        const root = previous && this.functionRoot(previous);
        if (!root) return undefined;
        const method = root.kind === "native" ? METHOD_INTRINSICS.get(root.name) : undefined;
        const arity = clauses[0].params.length;
        // (A list's [] and :: name List, which the prelude declares.)
        // (A type's binding, a capitalized name's, is read: a named subtype,
        // G = String, is a field not yet evaluated.)
        const forType = isForTypes(clauses, type => {
            const bound = this.scopeBinding(type);
            let v = bound;
            if (v && (v.kind === "thunk" || v.kind === "deferred")) {
                try { v = this.reference(v); } catch (error) { if (error instanceof APNError) return false; throw error; }
            }
            return !!v && (type === "List" || (v.kind === "native" || v.kind === "variant" || v.kind === "type") && !!v.family);
        }, !!method);
        if (!forType || !method && this.arity(root) !== arity) return undefined;
        const child = new Env(this.env), body = clauses[0].body, scope = this.env.root();
        const make = (all: DefClause[]): Value => arity ? { kind: "clauseFn", name, clauses: all, arity, env: child, applied: [] } : this.defer(() => {
            const caller = this.env;
            this.env = child;
            try { return this.reference(this.eval(body)); } finally { this.env = caller; }
        });
        if (this.scopeBinding(name) === undefined) this.bindNames([[name, previous]]);
        if (method) {
            const fn = make(clauses);
            this.registerInstance(method, fn, clauses);
            return fn;
        }
        // More clauses for it from one scope are one definition, as at home.
        const key = this.functionKey(root)!, joined = this.attachments.get(key) ?? [];
        const last = joined[joined.length - 1];
        const merged = last && last.scope === scope && last.name === name && last.fn.kind === "clauseFn"
            ? mergeClauses(name, last.fn.clauses, clauses, c => this.clauseHead(c, scope)) : undefined;
        const fn = make(merged ?? clauses);
        this.attachments.set(key, [...merged ? joined.slice(0, -1) : joined, { fn, scope, name }]);
        return fn;
    }
    // The function a binding is, through aliases ((+) = intrinsics.add) and
    // scoped extensions to what they extend; undefined for any other value
    // (a thunk not yet known to be a function is not run: x = x never ends).
    private functionRoot(value: Value): Value | undefined {
        let v = value;
        for (let n = 0; n < 64; n++) {
            if (v.kind === "thunk" && v.value === undefined && v.body.t !== "recordAccess") return undefined;
            if (v.kind === "thunk" || v.kind === "deferred") {
                try { v = this.reference(v); } catch (error) { if (error instanceof APNError) return undefined; throw error; }
                continue;
            }
            if (v.kind === "clauseFn" && v.fallback) { v = this.force(v.fallback); continue; }
            break;
        }
        return v.kind === "clauseFn" || v.kind === "native" ? v : undefined;
    }
    // What a function is known by, across its partial applications.
    private functionKey(f: Value): unknown {
        return f.kind === "clauseFn" ? f.clauses : f.kind === "native" ? `native:${f.name}:${f.tag ?? ""}` : undefined;
    }
    // Clauses joined to a function by types declared elsewhere, oldest first.
    private attachments = new Map<unknown, { fn: Value; scope: Env; name: string }[]>();
    // Whether clauses for a type declared elsewhere joined this function.
    private joins(f: Value): boolean {
        if (!this.attachments.size) return false;
        const root = this.functionRoot(f);
        return !!root && this.attachments.has(this.functionKey(root));
    }
    // The first joined clauses taking these arguments, newest first.
    private joinedCall(f: Value, args: Value[]): Value | undefined {
        if (!this.attachments.size) return undefined;
        const joined = this.attachments.get(this.functionKey(f));
        if (!joined) return undefined;
        next: for (let n = joined.length - 1; n >= 0; n--) {
            const first = this.firstForced(joined[n].fn, args);
            if (first) this.force(first);
            let g = joined[n].fn;
            for (const x of args) {
                g = this.apply(g, x, true);
                if (g.kind === "nomatch") continue next;
            }
            return g;
        }
        return undefined;
    }

    // The argument a function joined to another (Glsl a + b = ..., a + Glsl b =
    // ...) would force first, for its caller to force before its clauses are
    // tried: the same value, in a shallower stack, so a recursion through the
    // operator (1 + count (n - 1)) goes as deep as through the builtin. A clause
    // an evaluated argument already rejects (1 is no Glsl) forces nothing; the
    // argument is one only when every other clause would force it first.
    private firstForced(fn: Value, args: Value[]): Value | undefined {
        const f = this.reference(fn);
        if (f.kind !== "clauseFn" || f.applied.length || f.arity !== args.length) return;
        const plain = (p: Pattern) => p.p === "var" || p.p === "wildcard";
        const settled = (x: Value) => x.kind === "thunk" ? x.value !== undefined || ["int", "float", "string", "char", "bool"].includes(x.body.t)
            : x.kind !== "deferred" || x.value !== undefined;
        let first: number | undefined;
        for (const clause of f.clauses) {
            let forces: number | undefined, rejected = false;
            for (let i = 0; i < clause.params.length && forces === undefined && !rejected; i++) {
                const p = clause.params[i];
                if (plain(p)) continue;
                if (!settled(args[i])) { forces = i; break; }
                // (Only a constructor around names is told apart without forcing more.)
                if (p.p !== "constr" || !p.args.every(plain)) return;
                rejected = !this.matchPattern(p, this.force(args[i]), new Map());
            }
            if (rejected) continue;
            if (forces === undefined || first !== undefined && first !== forces) return;
            first = forces;
        }
        return first === undefined ? undefined : args[first];
    }
    // That argument for an operator's newest joined clauses (see joinedCall).
    private joinedFirst(f: Value, args: Value[]): Value | undefined {
        const joined = this.attachments.get(this.functionKey(this.functionRoot(f) ?? f));
        return joined && this.firstForced(joined[joined.length - 1].fn, args);
    }

    // A constructor the name is bound to here (a later Rect w h = r
    // destructures).
    private isConstructorName(name: string): boolean {
        const bound = this.env.get(name);
        return !!bound && ((bound.kind === "native" && !!bound.tag) || bound.kind === "variant" || this.binding(name).kind === "cons");
    }

    // How many parameters the type a name is bound to takes: List a one,
    // Option a one, Vect n a two; none for Int or a record type.
    // A type given one of its parameters: Vect 2, Option Int, an alias's
    // argument, a variable type given a type. Undefined when the argument is
    // instead the value it types (see typeValue).
    private typeParameter(f: Extract<Value, { kind: "type" }>, arg: Value): Value | undefined {
        const plain = !f.family && !f.alias;
        if (plain && (f.name === "$any" || f.name === "Dynamic" || f.name === "Bool" && !f.choices) || f.choices) return undefined;
        if (f.alias) {
            const args = [...f.arguments ?? [], arg];
            return args.length < f.alias.parameters.length ? { ...f, arguments: args } : this.construct(f, args);
        }
        const value = this.demand(arg);
        // List T and IO T: their element and result types (see listType).
        if (plain && (f.name === "List" || f.name === "IO") && !f.arguments?.length && this.isTypeValue(value)) return this.conform(f, value);
        // A type variable applied to a type: f a, any type holding a.
        if (f.variable && f.name !== "_" && this.isTypeValue(value)) return { ...f, arguments: [...f.arguments ?? [], value] };
        // HashMap k v: the types of its keys and values.
        if (plain && f.name === "HashMap" && (f.arguments?.length ?? 0) < 2 && this.isTypeValue(value)) return { ...f, arguments: [...f.arguments ?? [], value] };
        if (this.counted(f) && (f.arguments?.length ?? 0) < 2) {
            const args = [...f.arguments ?? []];
            if (!args.length && (value.kind !== "int" || value.v < 0n)) throw new APNError("runtime", `${f.name} length must be a nonnegative Int`);
            if (args.length === 1 && !this.isTypeValue(value)) throw new APNError("runtime", `${f.name} element must be a type`);
            return { ...f, arguments: [...args, value] };
        }
        const parameters = f.family?.parameters ?? [];
        // An indexed family takes values as arguments too (Vec 2 Int).
        const indexed = !!f.family?.results && !(value.kind === "variant" && value.family === f.family);
        if ((f.arguments?.length ?? 0) < parameters.length && (indexed || this.isTypeValue(value))) {
            return { ...f, arguments: [...f.arguments ?? [], isNumeric(value) ? numericPayload(value) : value] };
        }
        return undefined;
    }
    // A type applied to a value, as e : T is: the value as a member of it,
    // collapsed to it (1.0 : Int is 1), Bool its truthiness, Dynamic a boundary.
    typeValue(f: Extract<Value, { kind: "type" }>, arg: Value): Value {
        try { return this.typeMember(f, arg); }
        catch (error) {
            // A value not of the type converts as its to instance declares.
            const made = error instanceof APNError ? this.declaredConversion(f, arg) : undefined;
            if (made === undefined) throw error;
            return made;
        }
    }
    private typeMember(f: Extract<Value, { kind: "type" }>, arg: Value): Value {
        if (f.name === "$any" && !f.family && !f.alias) return arg;
        if (f.refine) return this.conform(f, arg);
        // Applying a union checks that the value is one of its types.
        if (f.choices) {
            const value = this.demand(arg);
            if (this.belongsToType(f, value)) return value;
            throw new APNError("runtime", `${this.typeText(value)} is not one of ${f.name}`);
        }
        if (f.name === "Dynamic" && !f.family && !f.alias) {
            this.dynamicDepth++;
            try { return this.constructType("Dynamic", this.reference(arg)); }
            finally { this.dynamicDepth--; }
        }
        let value = this.demand(arg);
        // A base type's member made from a named value unwraps it: (Money 1.2 : Float).
        if (!f.family && !f.alias && OWN_SCALAR_TYPES.has(f.name)) value = this.baseValue(value);
        if (!f.family && ["Float", "Float32", "Float64"].includes(f.name)) {
            if (!isNumeric(value)) throw new APNError("runtime", `${f.name} expects a number`);
            return castNumeric(f.name, value, true);
        }
        // A named subtype's member is its base's, as that name: (.1 : F) with
        // F = Float32 is (.1 : Float32), an F.
        if (f.family?.base && !(value.kind === "variant" && value.family?.base)) {
            const base = this.reference(f.family.base);
            return this.conform(f, base.kind === "type" ? this.typeValue(base, value) : this.apply(base, value));
        }
        return this.conform(f, value);
    }
    // A type's pattern around a value is written (x : Int), which the parser
    // marks typed; (Int x), with the type first, is the old spelling. Checked
    // once for each place patterns are written (a clause, a binding).
    private readonly spellingChecked = new WeakSet<object>();
    // Set by an application as written, for the apply it makes (see apply).
    private writtenApplication = false;
    private typesAfterValues(patterns: Pattern[], scope: Env, place: object): void {
        if (this.spellingChecked.has(place)) return;
        this.spellingChecked.add(place);
        const visit = (p: Pattern): void => {
            if (p.p === "constr" && p.args.length && !p.typed) {
                const bound = this.builtinType(p.tag, scope) && !PRELUDE_TYPES.has(p.tag) ? { kind: "type", name: p.tag } as Value : scope.get(p.tag);
                const type = bound && this.reference(bound);
                const count = type?.kind === "type" ? type.alias?.parameters.length ?? this.typeParameters(p.tag, scope) : undefined;
                if (count !== undefined && p.args.length > count) {
                    throw new APNError("runtime", "a typed pattern writes its type after the value", { hint: `write ${patternSource({ ...p, typed: true })}` });
                }
            }
            for (const value of Object.values(p)) {
                if (Array.isArray(value)) value.forEach(x => x && typeof x === "object" && "p" in x && visit(x));
                else if (value && typeof value === "object" && "p" in value) visit(value as Pattern);
            }
        };
        patterns.forEach(visit);
    }
    private typeParameters(name: string, scope = this.env): number {
        const bound = scope.get(name), t = bound && this.reference(bound);
        if (t?.kind !== "type" || t.arguments?.length || t.alias) return 0;
        if (t.family) return t.family.parameters?.length ?? 0;
        return t.name === "List" || t.name === "IO" ? 1 : this.counted(t) || t.name === "HashMap" ? 2 : 0;
    }

    private typeBinding(p: Extract<Pattern, { p: "schema" }>, v: Value, binds: Map<string, Value>): boolean | undefined {
        const args: Expr[] = [];
        let head = p.type;
        while (head.t === "block" && head.stmts.length === 1) head = head.stmts[0];
        while (head.t === "app") { args.unshift(head.a); head = head.f; }
        if (head.t !== "var") return undefined;
        const type = this.env.get(head.name), bound = type && this.reference(type), base = bound && (this.sharedType(bound) ?? bound);
        if (base?.kind === "type" && base.family?.results) return this.indexedPattern(base.family, args, p.value, v, binds);
        // (Option t) x: a free name binds the argument the value's fields give
        // (_ takes any).
        if (base?.kind === "type" && base.family && !base.alias && !base.arguments?.length &&
            args.some(arg => arg.t === "placeholder" || arg.t === "var" && /^[a-z]/.test(arg.name) && !binds.has(arg.name) && this.typeVariableName(arg.name, this.env)))
            return this.indexedPattern(base.family, args, p.value, v, binds);
        // A length is a value: a bound name is that value. A type position keeps
        // a name bound to a type or function; any other name binds here, as
        // does one an empty vector left open (f = Vect n a xs -> Vect m a ys -> ...
        // given [] first binds a from ys, as the clause f (Vect n a xs) (Vect m a ys) does).
        const open = (name: string) => { const bound = this.env.get(name), t = bound && this.reference(bound); return t?.kind === "type" && t.name === "$any" && !!t.description; };
        const free = (e: Expr, n: number) => e.t === "placeholder" || e.t === "var" && /^[a-z]/.test(e.name) && !binds.has(e.name) &&
            (this.counted(base) && n === 0 ? !this.lengthValue(e.name) : this.typeVariableName(e.name, this.env) || open(e.name));
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
        if (this.counted(base) && args.length === 2) {
            const [size, element] = args.map(asPattern);
            return !!size && !!element && this.matchVectorPattern(base, [size, element, p.value], v, binds);
        }
        // (m : HashMap k v): a map, k and v its keys' and values' types (computed
        // if used, as List a's), a written type each key's or value's.
        if (base.name === "HashMap" && !base.family && args.length === 2) {
            const map = this.dataValue(v);
            if (map.kind !== "hashmap") return false;
            for (const [n, arg] of args.entries()) {
                if (arg.t === "placeholder") continue;
                if (arg.t === "var" && /^[a-z]/.test(arg.name) && !binds.has(arg.name) && this.typeVariableName(arg.name, this.env)) {
                    binds.set(arg.name, this.defer(() => this.readElementType((this.reference(this.callNative("typeOf", [map])) as Extract<Value, { kind: "type" }>).arguments![n])));
                    continue;
                }
                const wanted = arg.t === "var" && binds.has(arg.name) ? binds.get(arg.name)! : this.reference(this.eval(arg));
                if (this.readElementTypes.has(this.reference(wanted))) continue;
                if (![...map.entries.values()].every(entry => this.belongsToType(wanted, entry[n]))) return false;
            }
            return this.matchPattern(p.value, map, binds);
        }
        if (base.name === "List" && args.length === 1 && (args[0].t === "var" || args[0].t === "placeholder")) {
            const list = this.dataValue(v);
            if (!this.isList(list)) return false;
            if (args[0].t === "var") {
                const name = args[0].name;
                binds.set(name, this.defer(() => this.readElementType(this.elementType(list))));
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
        const indices = this.familyArguments(actual)!;
        // An index position (one a constructor's result computes: Z, S k) is a
        // value; a type position follows the written-function-type rule.
        const valueAt = (n: number) => [...family.results?.values() ?? []].some(result => {
            const parts: Expr[] = [];
            while (result.t === "app") { parts.unshift(result.a); result = result.f; }
            return parts[n] && !(parts[n].t === "var" && /^[a-z]/.test((parts[n] as { name: string }).name));
        });
        for (const [n, arg] of args.entries()) {
            if (arg.t === "placeholder") continue;
            const free = arg.t === "var" && /^[a-z]/.test(arg.name) && !binds.has(arg.name) && (valueAt(n) ? !this.lengthValue(arg.name) : this.typeVariableName(arg.name, this.env));
            if (free) { binds.set((arg as { name: string }).name, indices[n]); continue; }
            const wanted = arg.t === "var" && binds.has(arg.name) ? binds.get(arg.name)! : this.reference(this.eval(arg));
            if (!this.sameIndex(wanted, indices[n])) return false;
        }
        return this.matchPattern(value, actual, binds);
    }
    // A type a pattern's variable read off a list's elements (List a, Vect n
    // a): what reading the variable gives, which a conversion does not check
    // against (a type variable is the checker's to compare).
    private readElementTypes = new WeakSet<Value>();
    private readElementType(type: Value): Value {
        const copy = { ...type } as Value;
        this.readElementTypes.add(copy);
        return copy;
    }
    // The type typeOf describes for a list's elements: Int for [1,2].
    private elementType(list: Value): Value {
        const value = this.demand(list);
        const text = value.kind === "list" && value.schema ? this.typeText(value).replace(/^List /, "").replace(/^\((.*)\)$/, "$1") : describeElementType(value);
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
        // A type applied to a pattern's types (IO _, IO []).
        if (expression.t === "app") {
            const head = this.schemaPatternType(expression.f, capture), argument = this.schemaPatternType(expression.a, capture);
            if (!expression.types) return this.reference(this.apply(head, argument));
            this.typeOperands++;
            try { return this.reference(this.apply(head, argument)); } finally { this.typeOperands--; }
        }
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
        if (p.p === "constr" && p.head) throw headError(p.tag);
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
        // A type applied to types alone ((List Int), (Pairs Int)) given a
        // type matches each type within the one it makes, as <= compares.
        const closed = p.p === "constr" && p.args.length ? this.closedType(p) : undefined;
        if (closed) {
            const given = this.reference(v);
            if (given.kind === "type" || given.kind === "functionType" || this.isList(given) && this.isTypeValue(given)) {
                return this.sameType(closed, given) || this.within(given, closed);
            }
        }
        if (p.p === "constr" && p.tag === "Dynamic" && p.args.length === 1) {
            const type = this.reference(this.env.get(p.tag)!);
            if (type.kind === "type" && type.name === "Dynamic" && !type.family && !type.alias) {
                return this.matchPattern(p.args[0], this.constructType("Dynamic", v), binds);
            }
        }
        if (p.p === "schema") {
            const shape = this.typeShape(p, v, binds);
            if (shape !== undefined) return shape;
            const bindsType = this.typeBinding(p, v, binds);
            if (bindsType !== undefined) return bindsType;
            const scope = new Env(this.env);
            for (const [name, value] of binds) scope.setLocal(name, value);
            const caller = this.env;
            let type: Value;
            this.env = scope;
            try { type = this.schemaPatternType(p.type, true); } finally { this.env = caller; }
            type = this.asType(type) ?? type;
            // Every typed pattern first asks whether the checker's type for the
            // value fits it, so a run takes the clause the checker chose; then
            // whether e : T converts the value (converts), each kind below.
            if (!this.staticallyFits(p.type, v)) return false;
            if (type.kind === "type" && this.counted(type)) {
                return this.converts(type, v) && this.matchPattern(p.value, this.conform(type, v), binds);
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
                // ((Int | String) x): a value of one of the union's types.
                if (type.refine) return this.refinedPattern(type, p.value, actual, binds);
                if (type.choices) return this.belongsToType(type, actual) && this.matchPattern(p.value, actual, binds);
                // (List Int xs): a list, its elements converted as they are used
                // (as a variant's payload is), so an infinite one matches too.
                if (this.isListType(type)) {
                    const given = this.demand(actual);
                    if (!this.isList(given) && given.kind !== "record" && given.kind !== "hashmap") return false;
                    return this.matchPattern(p.value, this.conform(type, actual), binds);
                }
                // (IO T a): an action, what it yields made a T when it runs; a
                // return no context has decided yet is one.
                if (this.isIOType(type)) {
                    const action = this.demand(actual);
                    if (action.kind !== "io" && action.kind !== "pending") return false;
                    return this.matchPattern(p.value, this.conform(type, this.realize(action, type)), binds);
                }
                if (!type.family) return this.matchPattern({ p: "constr", tag: type.name, args: [p.value] }, actual, binds);
                let variant = this.dataValue(actual);
                // Another value, what a to instance for the type makes of it.
                if (!(variant.kind === "variant" && variant.family === type.family)) {
                    const made = this.declaredConversion(type, variant);
                    if (made) variant = actual = this.dataValue(made);
                }
                if (variant.kind !== "variant" || variant.family !== type.family) return false;
            }
            if (type.kind === "record") {
                const input = this.recordPatternInput(type, this.demand(actual));
                if (input === null || !this.hasSchemaCapture(type) && !this.converts(type, input)) return false;
                const converted = this.conform(type, input);
                const captured = this.hasSchemaCapture(type) ? this.captureSchema(type, converted, binds) : converted;
                return captured !== null && this.matchPattern(p.value, captured, binds);
            }
            if ((this.isList(type) && !this.isList(this.demand(actual))) || (type.kind === "functionType" && !this.matchesValueType("Function", actual))) return false;
            // An endless type ([Int..]) takes no list of written items: what the
            // checker typed the value decides, as for (List Int xs).
            if (this.repeatedType(type) && this.demand(actual).kind === "list") return false;
            // A written list of types ([Int,Int], which is Vect 2 Int) takes what
            // converts to it; another does not match.
            if (this.isList(type) && !this.repeatedType(type) && !this.hasSchemaCapture(type) && !this.converts(type, actual)) return false;
            const converted = this.conform(type, actual);
            const captured = this.hasSchemaCapture(type) ? this.captureSchema(type, converted, binds) : converted;
            return captured !== null && this.matchPattern(p.value, captured, binds);
        }
        // A written type's parameters, and a value it made, are read back from
        // what it remembers: (Pairs n a) given Pairs 2 Int, (Pairs n a xs)
        // given a value Pairs 2 Int made. Another value is read back by
        // running the type function's clauses backwards (see readBack).
        if (p.p === "constr" && p.args.length) {
            const bound = this.env.get(p.tag), alias = bound && this.reference(bound);
            const count = alias?.kind === "type" ? alias.alias?.parameters.length : undefined;
            if (count && (p.args.length === count || p.args.length === count + 1)) {
                const given = this.reference(p.args.length === count ? v : this.demand(v));
                const type = p.args.length === count ? given : this.declaredTypes.get(given);
                const written = type && this.asWritten.get(type);
                const run = alias!.kind === "type" ? alias!.alias!.run : undefined;
                const args = written?.name === p.tag ? written.args
                    : p.args.length > count && run?.kind === "clauseFn" ? this.readBack(run, given) : undefined;
                // A union of list types reads nothing back: given its types
                // ((Pairs Int xs)), the value is tested against it.
                if (!args && p.args.length > count) {
                    const types = p.args.slice(0, count).map(arg => arg.p === "constr" && !arg.args.length ? this.env.get(arg.tag) : undefined);
                    const made = types.every(Boolean) ? this.reference(this.construct(alias as Extract<Value, { kind: "type" }>, types as Value[])) : undefined;
                    if (made?.kind === "type" && made.refine) return this.refinedPattern(made, p.args[count], given, binds);
                    if (made?.kind === "type" && made.choices) return this.belongsToType(made, given) && this.matchPattern(p.args[count], given, binds);
                }
                if (written || args) {
                    return !!args && p.args.slice(0, count).every((arg, n) => this.matchPattern(arg, args[n], binds))
                        && (p.args.length === count || this.matchPattern(p.args[count], given, binds));
                }
            }
        }
        // A type applied to its parameters matches a type value and takes it
        // apart: (Option t) given Option Int binds t to Int, (Vect 1 t) given
        // Vect 1 Int binds t. One more pattern is a value of that type:
        // (Option t x) is ((Option t) x), as (Int x) is a value of Int.
        const parameters = p.p === "constr" && p.args.length ? this.typeParameters(p.tag) : 0;
        if (p.p === "constr" && parameters && p.args.length === parameters) {
            const given = this.reference(v);
            return given.kind === "type" && given.name === p.tag && given.arguments?.length === parameters &&
                p.args.every((arg, n) => this.matchPattern(arg, given.arguments![n], binds));
        }
        if (p.p === "constr" && parameters && p.args.length === parameters + 1) {
            // (Vect n a xs) takes a vector apart: a mismatch fails the match.
            const type = this.reference(this.env.get(p.tag)!);
            if (type.kind === "type" && this.counted(type)) return this.matchVectorPattern(type, p.args, v, binds);
            const flat = flatTypedPattern(p, () => parameters);
            if (flat) return this.matchPattern(flat, v, binds);
        }
        // A typed pattern names the type an undecided call should have:
        // g (Int n) applied to read "3" takes the Int overload.
        // So does a constructor pattern, its family: (Parser p) given return x
        // takes Parser's return.
        if (p.p === "constr" && p.args.length) {
            const undecided = this.reference(v);
            const named = undecided.kind === "pending" ? this.env.get(p.tag) : undefined;
            const found = named && this.reference(named);
            const type: Value | undefined = found?.kind === "type" && undecided.kind === "pending" && undecided.step.op === "call" ? found
                : found?.kind === "native" && found.tag && found.family ? { kind: "type", name: found.family.name, family: found.family } : undefined;
            if (type) {
                try { v = this.realize(undecided, type); }
                catch (error) { if (error instanceof APNError) return false; throw error; }
            }
        }
        // A bare type name matches a type within it, as a value: describe Int.
        if (p.p === "constr" && !p.args.length) {
            const bound = this.env.get(p.tag), named = bound && this.reference(bound);
            if (named && this.isTypeValue(named) && !(named.kind === "type" && named.name === "$any")) {
                const given = this.reference(v);
                return this.isTypeValue(given) && (this.sameType(named, given) || this.within(given, named));
            }
        }
        if (p.p === "constr" && (!this.builtinType(p.tag) || p.tag === "Vect")) {
            const binding = this.env.get(p.tag);
            if (binding) {
                const type = this.reference(binding);
                // A refinement, a union, a counted type, a list or record of
                // types, a function type: the typed pattern of it, matched there.
                if (type.kind === "type" && (type.refine || type.choices) || type.kind === "type" && this.counted(type) || type.kind === "functionType"
                    || (this.isList(type) || type.kind === "record") && this.isTypeValue(type)) {
                    return p.args.length === 1 && this.matchPattern({ p: "schema", type: { t: "var", name: p.tag }, value: p.args[0] }, v, binds);
                }
                if (p.args.length === 1 && type.kind === "type" && !type.family && !type.alias) {
                    return this.matchPattern({ p: "constr", tag: type.name, args: p.args }, v, binds);
                }
                // A named subtype's takes one of its values, or a plain value it
                // converts (as (x : Int32) takes 5 and (x : Float) takes 1),
                // either binding the plain value; never another name's.
                if (type.kind === "type" && type.family?.base && p.args.length === 1 && !parameters) {
                    const actual = this.dataValue(v);
                    if (actual.kind === "variant" && actual.family === type.family) return this.matchPattern(p.args[0], actual.v[0], binds);
                    if (actual.kind === "variant" && actual.family?.base) return false;
                    const member = this.refinedMember(type, v);
                    return member?.kind === "variant" && this.matchPattern(p.args[0], member.v[0], binds);
                }
                // A type without parameters takes its value: (Color c) takes Red,
                // and (b : Box) what a to Box instance makes of another value.
                if (type.kind === "type" && type.family) {
                    let actual = this.dataValue(v);
                    if (!(actual.kind === "variant" && actual.family === type.family) && p.args.length === 1 && !parameters) {
                        const made = this.declaredConversion(type, actual);
                        if (made) actual = this.dataValue(made);
                    }
                    return p.args.length === 1 && !parameters && actual.kind === "variant" && actual.family === type.family &&
                        this.matchPattern(p.args[0], type.family.base ? actual.v[0] : this.conform(type, actual), binds);
                }
            }
        }
        if (p.p === "constr" && p.tag === "Mutable") {
            const ref = this.reference(v);
            return ref.kind === "mutable" && p.args.length === 1 && this.matchPattern(p.args[0], ref, binds);
        }
        // A named subtype matches its base's patterns: (Float x) takes Money 1.2;
        // another type of the program's, what its to instance makes: (Int i) takes East.
        if (p.p === "constr" && this.builtinType(p.tag) && !["Type", "Mutable", "Dynamic"].includes(p.tag)) v = this.baseValue(this.reference(v));
        if (p.p === "constr" && SCALAR_TYPES.has(p.tag)) v = this.builtinValue(p.tag, this.dataValue(v)) ?? v;
        v = p.p === "typeBind" || (p.p === "constr" && p.tag === "Type") ? this.demand(v) : this.dataValue(v);
        switch (p.p) {
            case "typeBind": {
                const type = this.callNative("typeOf", [v]);
                return this.matchPattern(p.name === "_" ? { p: "wildcard" } : { p: "var", name: p.name }, type, binds) && this.matchPattern(p.value, isNumeric(v) ? numericPayload(v) : this.baseValue(v), binds);
            }
            case "int": return isNumeric(v) && equalNumbers(v, integer(p.v));
            case "bool": return v.kind === "bool" && v.v === p.v;
            case "string": return v.kind === "string" && v.v === p.v;
            case "char": return v.kind === "char" && v.v === p.v;
            // Like integer patterns, float patterns compare numerically.
            case "float": return isNumeric(v) && equalNumbers(v, { kind: "float", v: p.v });
            case "list": {
                if (v.kind === "record") {
                    // [] is the empty record, and no other: [a = 1] == [] is False.
                    if (!p.v.length) return v.v.length === 0;
                    // A var-only list pattern destructures a record by field name:
                    //   [x, y]  matches  [x = 1, y = 2]  binding x=1, y=2
                    const fields = new Map<string, Value>();
                    for (const [k, val] of v.v) fields.set(k, val);
                    for (const el of p.v) {
                        if (el.p !== "var") return false;
                        if (!fields.has(el.name)) return false;
                        if (!this.matchPattern(el, fields.get(el.name)!, binds)) return false;
                    }
                    return true;
                }
                // [a, b] is a :: b :: [], with what :: means here.
                if (p.v.length && !this.preludeCons()) return this.matchPattern(listPatternExpansion(p), v, binds);
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
                // Keyed record pattern:  [x = a, y = b]  extracts fields x, y
                // from a record and binds a, b to their values.
                if (v.kind !== "record") return false;
                const fields = new Map<string, Value>();
                for (const [k, val] of v.v) fields.set(k, val);
                const selected = new Set(p.v.filter(([key]) => key !== "_").map(([key]) => key));
                for (const [key, name] of p.v) {
                    const binder: Pattern = name === "_" ? { p: "wildcard" } : { p: "var", name };
                    if (key === "_") {
                        if (!this.matchPattern(binder, { kind: "record", v: v.v.filter(([field]) => !selected.has(field)) }, binds)) return false;
                        continue;
                    }
                    if (!fields.has(key)) return false;
                    if (!this.matchPattern(binder, fields.get(key)!, binds)) return false;
                }
                return true;
            }
            case "cons": {
                // The constructor the operator names: list cons, or one a program
                // bound it to ((::) = Cons makes x :: xs match Cons x xs).
                const op = p.op ?? "::", bound = this.env.get(op), named = bound && this.reference(bound);
                if (named && !(named.kind === "native" && named.name === "intrinsics.cons" && !named.applied.length)) {
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
                const bare = this.bareType(p, v);
                if (bare !== undefined) return !!bare;
                if (this.builtinType(p.tag)) {
                    if (p.args.length !== 1) return false;
                    if (!NUMERIC_TYPES.includes(p.tag)) return this.matchesValueType(p.tag, v) && this.matchPattern(p.args[0], v, binds);
                    if (!isNumeric(v)) return false;
                    // (x : Int32) binds what 5 : Int32 makes, an Int32; an
                    // aggregate ((x : Number)) the value as it is.
                    let converted: Value;
                    try { converted = castNumeric(p.tag, v); } catch { return false; }
                    return this.matchPattern(p.args[0], NUMERIC_CLASSES.has(p.tag) ? v : converted, binds);
                }
                // A view's pattern: its matcher takes the value apart into the
                // fields, or does not match (a variant of the tag is its own).
                const view = v.kind === "variant" && v.tag === p.tag ? undefined : this.viewNamed(p.tag);
                if (view) return this.matchView(view, p, v, binds);
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