import { type Alternative, claimedDeclaration, LIST_TYPE_RANGE, clauseKey, type DataDef, countingFamily, MATH_FUNCTIONS, METHODS, type Expr, flatTypedPattern, isLoadCall, mentions, rewriteInfixConstructors, mergeClauses, type Pattern, sourceLocations, type TopLevel, typedForm, unionClause, unionKind } from "./ast.ts";
import { proveIndexClaims } from "./index-proofs.ts";
import { RETIRED_NATIVES } from "./native-exports.ts";
import { objectFields, type P5Field, sketchFields } from "./p5.ts";
import { standardModule } from "./modules.ts";
import { parseLiteral, textNatives } from "./text-natives.ts";
import { castNumeric, matchesType, NUMERIC_TYPES, numericType, TYPE_NAMES, typedArithmetic, typedPower } from "./type-system.ts";
import { compareNumbers, equalNumbers, floating, integer, negate, NUMBER_NATIVES, numberText, numericNative, type Numeric } from "./numbers.ts";
import { APNError, didYouMean, formatFileReadError, withArticle } from "./errors.ts";
import { parse, parseDocument, patternSource, rangeExpr, PRIMITIVE_OPERATORS } from "./parser.ts";
import { mkStr, type Value, valueToString } from "./types.ts";
import { itemsText } from "./separators.ts";

const PRELUDE_OPERATORS = new Set(PRIMITIVE_OPERATORS.values());
// The prelude's functions that read a list's code, not its values: an open
// list may go to them (see closed).
const READS_CODE = new Set(["probe", "toAST", "toLambda", "intrinsics.written", "intrinsics.syntax"]);
// IO t: an action yielding t.
function io(t: Ty): Ty { return { k: "variant", name: "IO", args: [t] }; }
function isIO(t: Ty): boolean { return t.k === "variant" && t.name === "IO" && t.args.length === 1; }
// Monad t: a value in a monad not decided yet (return x), which any monad's
// type accepts.
// (Its name is no type a program can declare.)
const PENDING = "$monad";
function pendingTy(t: Ty): Ty { return { k: "variant", name: PENDING, args: [t] }; }
function isPending(t: Ty): boolean { return t.k === "variant" && t.name === PENDING && t.args.length === 1; }
// Scalar types := names a subtype of (Money := Float), as at runtime.
const NAMED_BASES = new Set([...NUMERIC_TYPES.filter(t => !["Number", "Real", "Integer", "Exact", "Inexact"].includes(t)), "String", "Bool", "Char"]);
// A definition that adds an instance instead of binding a name: any
// definition of a method (map f (Some x) = ..., return = Some).
function isInstance(name: string, _clauses: { params: Pattern[] }[]): boolean {
    return METHODS.has(name);
}

type Index = { constant: bigint; terms: Map<string, bigint> };
type Ty =
    // undecided: overloads differing only in result type, whose calls the
    // context decides; a union of their results is one of them, not either.
    | { k: "overload"; choices: Ty[]; undecided?: boolean; name?: string }
    | { k: "union"; choices: Ty[]; undecided?: boolean; name?: string }
    | { k: "mutable"; value: Ty }
    | { k: "map"; key: Ty; value: Ty }
    // entries: what is known about each argument given so far (an operator's
    // operands, as an infix operator's are known).
    | { k: "intrinsic"; name: string; arity?: number; args?: Ty[]; entries?: Entry[] }
    // known: what a deferred call knows about its argument's value (a literal,
    // possibly symbolic in a parameter), so clause ranking can use it later.
    // written: where a call deferred to its enclosing function's calls was written.
    // within: the top-level definition being checked when it was deferred.
    | { k: "operation"; op: string; args: Ty[]; solution?: Ty; known?: Known; written?: Expr; within?: object; decided?: Ty; lossless?: boolean[] }
    | { k: "dynamic"; explicit?: boolean }
    | { k: "var"; link?: Ty }
    | { k: "atom"; name: string }
    // shape describes the full result in terms of the arguments (see Shape); args
    // collects argument types across curried application. Both describe the
    // function's code, so they are trusted only at a direct call by name.
    // shared: a constructor sharing its type's name (Box x = _, Nothing = _),
    // which is that type where a type is expected (sharedType).
    | { k: "fn"; input: Ty; output: Ty; shared?: boolean; binder?: string; coerce?: boolean; checks?: Ty[]; pattern?: Pattern; selfName?: string; shape?: Shape; args?: Ty[]; clauses?: ClauseOrder[]; callArgs?: Entry[]; summary?: Summary }
    // formula: a list literal's code; open: the names its code reads that are
    // bound nowhere yet (a list joined before it may bind them), by where read.
    | { k: "list"; element: Ty; length?: Index; items?: Ty[]; contracted?: boolean; preserve?: Set<number>; formula?: Formula; open?: Map<string, { expr: Expr; within?: Expr }> }
    | { k: "record"; fields: Map<string, Ty>; open?: boolean; preserve?: Set<string>; closed?: boolean }
    // chosen: one of value's choices, picked by a condition known only at runtime.
    // given: an indexed family's index values written so far, by parameter (Vec 2 Int).
    // applied: how many of a family's arguments are given (Pair a, Vec 2).
    | { k: "type"; value: Ty; chosen?: boolean; given?: Map<number, Known>; applied?: number }
    | { k: "factory"; args: Entry[] }
    // A capitalized function (see construct); clauses: when it has patterns
    // or several clauses, chosen by the run.
    | { k: "alias"; name: string; params: string[]; body: Expr; scope: Scope; args: Entry[]; clauses?: { params: Pattern[]; body: Expr }[] }
    // indexed: a family whose constructors say what they make (Vec n a), so
    // an argument may be a value (Vec 2 Int); values decide those, not types.
    // checks: what is still to be checked of the values it holds, as a
    // function's are (Handler (s -> s ++ "!") checks s ++ "!" once a is known).
    // fields: a capitalized function's value (Rect 3 4), its args the fields' types.
    | { k: "variant"; name: string; args: Ty[]; ordinal?: boolean; base?: Ty; indexed?: boolean; checks?: Ty[]; fields?: boolean; shared?: boolean }
    // f a: a type variable applied to types, as written ((a -> b) -> f a -> f b).
    // Its head, once known, is a ctor: a type missing its first parameters
    // (List, Option, Result _ e for f a; Result for f a e), so f a maps the
    // first parameter, as map does.
    | { k: "apply"; head: Ty; args: Ty[] }
    | { k: "ctor"; name: string; args: Ty[] };
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
// about each of its elements (when the whole list is known), cell a lazy
// list's first cell (null when empty, undefined when unknown). fn is a function
// value: an expression evaluated in env and scope, or a local definition's
// clauses with the bindings it closes over and any arguments already applied.
type KnownFunction = { e: Expr; env: [string, Known][]; scope: Scope } | { summary: Summary; env: [string, Known][]; applied: Known[] };
type Cell = { head: Known; tail: Known } | null | undefined;
// What a lazy value (deferred, a lazy list, a block binding) is computed from:
// expressions over env, and values; reachability follows these (see reachable).
type Origin = { exprs: Expr[]; env?: Map<string, Known>; values?: Known[] };
// A Mutable cell's contents, the root evaluation that created it, and the lazy
// region its accesses happened in (see readMutable).
// A top-level value whose body touches top-level cells, kept as its body: an
// action (block, application or pipe body) runs at each use, a thunk is
// remembered from its first use.
type LazyTop = { body: Expr; scope: Map<string, Entry>; action: boolean; forced: boolean; memo?: Known; busy?: boolean; invalid?: boolean };
// A top-level cell (program) persists across statements (see executeTopLevel).
type KnownCell = { value: Known; root: number; program?: boolean; invalid?: boolean; regionRoot?: number; region?: number; written?: boolean; mixed?: boolean };
// An integer range (hi null: endless), indexed and cut arithmetically.
type KnownRange = { lo: bigint; step: bigint; hi: bigint | null };
interface Known {
    index?: Index; size?: bigint; items?: Known[]; cell?: () => Cell; range?: KnownRange; mutable?: KnownCell; deferred?: () => Known | undefined; origin?: Origin; slot?: () => Known | undefined; fn?: KnownFunction; boolean?: boolean; string?: string; char?: string; float?: number; number?: Numeric; tag?: string; ref?: string;
    call?: { summary: Summary; args: Known[] };
    expr?: { e: Expr; env: [string, Known][]; scope: Scope };
    // payload: a constructor application's fields (Some 300).
    payload?: Known[];
    // fields: a record literal's field values ([x: 300]).
    fields?: [string, Known][];
    // action: an IO action, run (statically) where the program runs it.
    action?: () => Known | undefined;
    // actionResult: the type an action yields as it prints (IO []), when known.
    actionResult?: string;
    // type: a type value (Int, or one a type-level function chose).
    type?: Ty;
}
// A function's clauses and defining scope, so a direct call by name can
// evaluate what its result value is from what is known about the arguments.
interface Summary { clauses: (ClauseOrder & { body: Expr })[]; scope: Scope }
interface Entry {
    type: Ty;
    // A constructor's declaration, which a union claiming it reads (also in a
    // later check: a REPL input, a module).
    declaration?: DataDef;
    index?: Index;
    size?: bigint;
    items?: Known[];
    cell?: () => Cell;
    range?: KnownRange;
    mutable?: KnownCell;
    fn?: Known["fn"];
    boolean?: boolean;
    string?: string;
    char?: string;
    float?: number;
    tag?: string;
    number?: Numeric;
    ref?: string;
    call?: Known["call"];
    payload?: Known[];
    fields?: [string, Known][];
    expr?: Known["expr"];
    // A value that is an action (a do-block): run by the check that uses it.
    actionBody?: { body: Expr; scope: Scope };
    clauses?: { params: Pattern[]; body: Expr }[];
    mono?: boolean;
    // inherited: visible from an enclosing scope (blocks mark every outer entry).
    inherited?: boolean;
    // builtin: a native or intrinsic from the checker's own root scope.
    builtin?: boolean;
    // opened: the record expression a use opened this name from.
    opened?: Expr;
    // bound: the expression a pattern binding (x <- e, [a, b] = e) took its value from.
    bound?: Expr;
    // lazyTop: a top-level value that touches top-level cells (see forceLazyTop).
    lazyTop?: LazyTop;
    // recursive: the definition being inferred, referred to from its own body;
    // selfInputs are the current clause's parameter types; selfOpen marks
    // those whose typed pattern binds their length ((Vect n a) xs: any length).
    recursive?: boolean;
    selfInputs?: Ty[];
    selfOpen?: boolean[];
    nonGeneric?: Set<Ty>;
    // definition: the value expression of a value binding (its identity).
    definition?: Expr;
}
export type TypeScope = Map<string, Entry>;
/** A checker's acceptance test, for the runtime to decide typed patterns as it does. */
export interface TypeBridge {
    fits(target: unknown, actual: unknown): boolean;
    concrete(type: unknown): boolean;
}
/** A name of explicit Dynamic type: its uses are checked at run time. */
export const dynamicEntry = (): Entry => ({ type: explicitDynamic });
/** A definition, by name and its clauses (a function) or body (a value). */
interface Definition { name: string; clauses?: { params: Pattern[]; body: Expr }[]; body?: Expr }
type Scope = TypeScope;
// A list literal's code, as the runtime keeps it: each item as written, in
// the scope it was written in, with its type, the names it binds and the open
// names it reads (an item without an expression is a plain list's value), so
// ++ and an item update infer again the items whose names change (codeList).
type Formula = { items: FormulaItem[] };
type FormulaItem = { expr?: Expr; scope?: Scope; type?: Ty; binds?: Map<string, Entry>; open?: Map<string, { expr: Expr; within?: Expr }>; slot?: Ty };
export interface CheckOptions {
    strict?: boolean;
    library?: boolean;
    loads?: (path: string, scope: TypeScope, tail?: boolean) => TypeScope;
    initial?: TypeScope;
    imports?: (module: string | string[]) => TypeScope;
    result?: (scope: TypeScope, exports: TypeScope) => void;
    /** Names bound in the running interpreter; with it, other unknown names are reported as unbound. */
    runtimeNames?: ReadonlySet<string>;
    /** The program's input, when checking right before a run: the files readFile
     * would read (undefined when unreadable) and getArgs. The runtime must see
     * the same snapshot. Lint and editor checks leave it unset. */
    inputs?: { readFile(path: string): string | undefined; args(): string[]; readStdin?(): string | undefined };
    /** Receives the scope before the program's statement at index (see CheckingSession.enter). */
    before?: { index: number; scope: (scope: TypeScope) => void };
    /** The variable names a file loaded by this path mentions, if the session checked it. */
    loadedNames?: (path: string) => Set<string> | undefined;
    /** Whether code checked in this session outside this program used use on
     * a record of unknown fields (the names it opened cannot be traced here). */
    openedElsewhere?: () => boolean;
    // Instance types (map, >>=, <*>, return) shared by a session's checks.
    instances?: Map<string, unknown[]>;
    // Each declared family's parameters a value cannot hold either of two
    // types in (see invariantParameters), shared by a session's checks.
    invariance?: Map<string, Set<number>>;
    /** Each clause's inferred result type (its head: Int, Option, ...) by the
     * source position of its body, for the runtime to choose overloads that
     * differ only in result type. */
    resultHeads?: Map<string, string>;
    /** The type of each list or variant value an expression makes, by source
     * position (null where inferences disagree), and of each typed pattern's
     * type, so a run decides (List Int xs) by a value's type as this does. */
    valueTypes?: Map<string, unknown>;
    /** By the pattern's type expression itself (a flat (List Int xs) has no source position). */
    patternTypes?: WeakMap<Expr, unknown>;
    /** Receives this check's own test of whether a type is accepted where a
     * typed pattern's type is (as a typed parameter accepts it). */
    bridge?: (bridge: TypeBridge) => void;
    /** The statements (by source location) whose value is a module, which the runtime opens. */
    moduleStatements?: Set<string>;
    /** Whether any code in this session may write a Mutable cell (see mayMutate),
     * asked when a cell is read; computed from the program when unset. */
    mutation?: () => boolean;
}
// Code that may write a Mutable cell: set, or code loaded or typed (repl) at
// runtime. (use opens a record's fields, which writes no cell.)
const MUTATING_NAMES = new Set(["set", "load", "repl"]);
const isFunctionExpr = (e: Expr): e is Extract<Expr, { t: "lambda" | "patternLambda" }> => e.t === "lambda" || e.t === "patternLambda";
// A lambda, grouped or not.
const functionExpr = (e: Expr): Extract<Expr, { t: "lambda" | "patternLambda" }> | undefined =>
    isFunctionExpr(e) ? e : e.t === "block" && e.style === "(" && e.stmts.length === 1 ? functionExpr(e.stmts[0]) : undefined;
export function mayMutate(program: unknown): boolean {
    return mentionsAny(program, MUTATING_NAMES);
}
export function mentionsAny(program: unknown, names: ReadonlySet<string>): boolean {
    const walk = (x: unknown): boolean => {
        if (!x || typeof x !== "object") return false;
        if (Array.isArray(x)) return x.some(walk);
        const node = x as Record<string, unknown>;
        if (node.t === "var" && typeof node.name === "string" && names.has(node.name)) return true;
        return Object.values(node).some(value => value && typeof value === "object" && walk(value));
    };
    return walk(program);
}
// Each name's types are copied when first read: a module's scope is large and
// a program uses few of its names. One map of variables and nodes makes names
// that share a variable share its copy, in whatever order they are read.
export function copyTypeScope(scope: TypeScope): TypeScope {
    const nodes = new Map<Ty, Ty>(), vars = new Map<Ty, Ty>();
    const copied = (t: Ty) => copy(t, vars, undefined, nodes);
    return new Map([...scope].map(([name, entry]) => {
        const lazy: Entry = { ...entry };
        let type: Ty | undefined, nonGeneric: Set<Ty> | undefined, done = false;
        Object.defineProperties(lazy, {
            type: { enumerable: true, get: () => type ??= copied(entry.type), set: (t: Ty) => { type = t; } },
            nonGeneric: {
                enumerable: true,
                get: () => done ? nonGeneric : (done = true, nonGeneric = entry.nonGeneric && new Set([...entry.nonGeneric].map(copied))),
                set: (set: Set<Ty> | undefined) => { done = true; nonGeneric = set; },
            },
        });
        return [name, lazy];
    }));
}
// A block's scope: what it binds, over the enclosing scope's names marked
// inherited, each marked when first read (a scope holds every builtin and
// import, so copying it for each block would cost more than the block).
// It iterates as the copy would: enclosing names first, in their order.
class BlockScope extends Map<string, Entry> {
    private readonly marked = new Map<string, Entry>();
    private readonly removed = new Set<string>();
    constructor(private readonly outer: Scope) { super(); }
    private inherited(name: string): Entry | undefined {
        if (this.removed.has(name)) return undefined;
        let entry = this.marked.get(name);
        if (!entry) {
            const outer = this.outer.get(name);
            if (!outer) return undefined;
            this.marked.set(name, entry = { ...outer, inherited: true });
        }
        return entry;
    }
    override get size() { let n = 0; for (const _ of this.keys()) n++; return n; }
    override get(name: string) { return super.has(name) ? super.get(name) : this.inherited(name); }
    override has(name: string) { return super.has(name) || !this.removed.has(name) && this.outer.has(name); }
    override set(name: string, entry: Entry): this { this.removed.delete(name); return super.set(name, entry); }
    override delete(name: string): boolean {
        const had = this.has(name);
        super.delete(name);
        if (this.outer.has(name)) this.removed.add(name);
        return had;
    }
    override clear(): void { super.clear(); for (const name of this.outer.keys()) this.removed.add(name); }
    override *keys(): MapIterator<string> {
        for (const name of this.outer.keys()) if (super.has(name) || !this.removed.has(name)) yield name;
        for (const name of super.keys()) if (!this.outer.has(name)) yield name;
    }
    override *entries(): MapIterator<[string, Entry]> { for (const name of this.keys()) yield [name, this.get(name)!]; }
    override *values(): MapIterator<Entry> { for (const name of this.keys()) yield this.get(name)!; }
    override [Symbol.iterator]() { return this.entries(); }
    override forEach(f: (value: Entry, key: string, map: Map<string, Entry>) => void) { for (const [k, v] of this.entries()) f(v, k, this); }
}
// The names a module type holds, for a record a module made.
function moduleOf(t: Ty): TypeScope | undefined {
    const module = resolve(t);
    return module.k === "record" && module.fields instanceof ModuleFields ? module.fields.scope : undefined;
}
// A module's record: each field's type is its scope entry's, read when needed.
class ModuleFields extends Map<string, Ty> {
    constructor(readonly scope: TypeScope) { super(); }
    override get size() { return this.scope.size; }
    override get(name: string) { return this.scope.get(name)?.type; }
    override has(name: string) { return this.scope.has(name); }
    override set(): this { throw new Error("a module's record is closed"); }
    override delete(): boolean { throw new Error("a module's record is closed"); }
    override *entries(): MapIterator<[string, Ty]> { for (const [name, entry] of this.scope) yield [name, entry.type]; }
    override *keys(): MapIterator<string> { yield* this.scope.keys(); }
    override *values(): MapIterator<Ty> { for (const entry of this.scope.values()) yield entry.type; }
    override [Symbol.iterator]() { return this.entries(); }
    override forEach(f: (value: Ty, key: string, map: Map<string, Ty>) => void) { for (const [k, v] of this.entries()) f(v, k, this); }
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
    /** Whether the program used use on a record of unknown fields. */
    opaqueUse?: boolean;
}
const dynamic: Ty = { k: "dynamic" };
const explicitDynamic: Ty = { k: "dynamic", explicit: true };
const isExplicit = (t: Ty): boolean => { const value = resolve(t); return value.k === "dynamic" && !!value.explicit; };
const variable = (): Ty => ({ k: "var" });
const atom = (name: string): Ty => name === "Dynamic" ? explicitDynamic : { k: "atom", name };
// The payload a numeric constructor pattern binds: the number without its
// type annotation (Int for UInt8, Float for Float32); aggregates stay as written.
function untypedPayload(t: Ty): Ty {
    if (t.k !== "atom") return t;
    if (/^U?Int(8|16|32|64|128)?$/.test(t.name)) return atom("Int");
    if (/^Float(32|64)?$/.test(t.name)) return atom("Float");
    if (t.name === "ComplexExact") return atom("Complex");
    return t;
}
// A sized or unsigned integer type with a plain integer keeps its type, as at
// runtime (UInt 5 - 1 is UInt 4; a result it cannot hold is a runtime error).
function integerResult(a: Ty, b: Ty): Ty | undefined {
    if (a.k !== "atom" || b.k !== "atom") return undefined;
    const sized = (name: string) => /^U?Int(8|16|32|64|128)?$/.test(name) && name !== "Int";
    if (a.name === "Int" && sized(b.name)) return b;
    if (b.name === "Int" && sized(a.name)) return a;
    return undefined;
}
const fn = (input: Ty, output: Ty, binder?: string, coerce = false): Ty => ({ k: "fn", input, output, binder, coerce });
const list = (element: Ty, length?: Index): Ty => ({ k: "list", element, length });
// A list taken whole, whatever its elements: (List _ xs), (List a xs).
function wholeList(p: Pattern): p is Extract<Pattern, { p: "schema" }> {
    return p.p === "schema" && p.type.t === "app" && p.type.f.t === "var" && p.type.f.name === "List" &&
        (p.type.a.t === "placeholder" || p.type.a.t === "var" && /^[a-z]/.test(p.type.a.name));
}
// How many parameters a type takes: List a one, Option a one, Vect n a two;
// none for Int, a record type or a type already applied.
function typeParameters(type: Ty): number {
    const t = resolve(type);
    if (t.k === "factory") return 2;
    if (t.k !== "type" || t.applied) return 0;
    const value = resolve(t.value);
    return value.k === "variant" && !value.base ? value.args.length : value.k === "atom" && value.name === "List" ? 1 : 0;
}
const constant = (n: bigint): Index => ({ constant: n, terms: new Map() });
const resolve = (t: Ty): Ty => t.k === "var" && t.link ? resolve(t.link) : t.k === "apply" ? appliedType(t) : t;
// f a once f is known: the type itself (List a, Result a e); else f a.
const appliedTypes = new WeakMap<Ty, Ty>();
function appliedType(t: Extract<Ty, { k: "apply" }>): Ty {
    const known = appliedTypes.get(t);
    if (known) return resolve(known);
    const head = resolve(t.head);
    if (head.k !== "ctor") return t;
    const made: Ty = head.name === "List" && !head.args.length && t.args.length === 1 ? { k: "list", element: t.args[0] } : { k: "variant", name: head.name, args: [...t.args, ...head.args] };
    appliedTypes.set(t, made);
    return made;
}
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
// An index as APN writes it: n0 - 1, 2 * n0 + m1.
function indexText(n: Index): string {
    const parts: string[] = [];
    for (const [key, value] of [...n.terms].sort(([a], [b]) => a.localeCompare(b))) {
        const size = value < 0n ? -value : value, term = size === 1n ? key : `${size} * ${key}`;
        parts.push(parts.length ? `${value < 0n ? "-" : "+"} ${term}` : value < 0n ? `-${term}` : term);
    }
    if (n.constant || !parts.length) {
        const size = n.constant < 0n ? -n.constant : n.constant;
        parts.push(parts.length ? `${n.constant < 0n ? "-" : "+"} ${size}` : String(n.constant));
    }
    return parts.join(" ");
}
// A type as an argument of another: List (Option Int), List (a -> b).
function argument(type: string): string {
    return /\s/.test(type) && !/^[[(]/.test(type) ? `(${type})` : type;
}
// Unresolved types are named a, b, ... in order of appearance, as typeOf names
// them (an unsolved operation's result, x * 2 of an unknown x, is one too);
// an applied one is named f, g, ...: f a.
function text(
    t: Ty,
    active = new Map<Ty, string>(),
    recursive = new Set<Ty>(),
    names = new Map<Ty, string>(),
): string {
    if (active.size > 96) return "a deeply nested type";
    t = resolve(t);
    if (active.has(t)) {
        recursive.add(t);
        return active.get(t)!;
    }
    const nested = new Map(active);
    nested.set(t, `rec${active.size}`);
    const show = (x: Ty) => text(x, nested, recursive, names);
    // A function inside another type is parenthesized: (a -> b) -> c, List (a -> b).
    const operand = (x: Ty) => { const shown = show(x); return resolve(x).k === "fn" ? `(${shown})` : shown; };
    const name = (x: Ty, letters = "abcdeijklnopqrstuvwxyz") => {
        if (!names.has(x)) {
            const used = new Set(names.values());
            names.set(x, [...letters].find(l => !used.has(l)) ?? `t${names.size}`);
        }
        return names.get(x)!;
    };
    const render = (): string => {
        switch (t.k) {
            case "overload":
            case "union":
                return t.choices.map(operand).join(" | ");
            case "map": return `HashMap ${argument(show(t.key))} ${argument(show(t.value))}`;
            case "intrinsic": return t.name;
            case "operation":
                return name(t);
            case "dynamic":
                return "Dynamic";
            case "var":
                return name(t);
            case "atom":
                return t.name;
            case "fn":
                return `${operand(t.input)} -> ${show(t.output)}`;
            // [Int,Float] is a positional type; a list of any length is List Int.
            case "list":
                // The empty list's type is written []: IO [], m [].
                if (t.length && !t.length.terms.size && t.length.constant === 0n) return "[]";
                return t.length ? `Vect ${argument(indexText(t.length))} ${argument(show(t.element))}` : `List ${argument(show(t.element))}`;
            case "record":
                return `[${[...t.fields].map(([k, v]) => `${k}: ${operand(v)}`).join(", ")}]`;
            case "type":
                return `Type (${show(t.value)})`;
            // An undecided return: m T, for the monad a context will name.
            case "variant":
                if (isPending(t)) return `m ${argument(show(t.args[0]))}`;
                if (t.fields) return t.name;
                return t.name + t.args.map((x) => " " + argument(show(x))).join("");
            case "apply":
                return [resolve(t.head).k === "var" ? name(resolve(t.head), "fghm") : argument(show(t.head)),
                    ...t.args.map(x => argument(show(x)))].join(" ");
            case "ctor":
                return t.name + t.args.map((x) => " " + argument(show(x))).join("");
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
            return [...t.args, ...t.base ? [t.base] : [], ...t.checks ?? []];
        case "apply":
            return [t.head, ...t.args];
        case "ctor":
            return t.args;
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
const LIST_NATIVES = ["filter", "map", "take", "drop", "zipWith"];
// Builtins the checker evaluates on known values (all return).
const EVALUATED_NATIVES = new Set([
    ...LIST_NATIVES, "length", "head", "tail", "null", "foldl", "foldr", "iterate", "enumerate",
    "chars", "fromChars", "upper", "lower", "toString", "intToString", "seq", "parse",
    "print", "echo", "emit", "debug", "assert", "set", "readFile", "use",
]);
// Builtins that demand their arguments when called.
const STRICT_NATIVES = new Set([
    "head", "tail", "null", "length", "chars", "fromChars", "upper", "lower", "toString", "intToString",
    "parse", "print", "echo", "emit", "debug", "assert", "set", "seq", "readFile", "use",
]);
// Static evaluation limits: nesting (recursion) depth, and work per root value.
const EVALUATION_DEPTH = 5000;
const EVALUATION_BUDGET = 300000;
const SYMBOLIC_BUDGET = 200;
// A value no check has asked for yet is computed now only if it is quick.
const QUICK_BUDGET = 2000;
// Inference work (unification steps) per top-level statement.
const STATEMENT_BUDGET = 250000;
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
// A value that refers to itself (a recursive function in its own env) is
// substituted once: a repeat visit returns the value as it was.
function substituteKnown(known: Known, subst?: [string, Index], value?: [string, Known], visiting = new Set<Known>()): Known {
    if (visiting.has(known)) return known;
    visiting.add(known);
    try { return substituteOnce(known, subst, value, visiting); } finally { visiting.delete(known); }
}
function substituteOnce(known: Known, subst: [string, Index] | undefined, value: [string, Known] | undefined, visiting: Set<Known>): Known {
    const go = (k: Known) => substituteKnown(k, subst, value, visiting);
    let result = known;
    if (result.index && subst && result.index.terms.has(subst[0])) result = { ...result, index: substituteIndex(result.index, subst) };
    if (result.ref && value && result.ref === value[0]) {
        const v = value[1];
        // The whole value is the argument's, its index included (none for a non-integer).
        result = { index: subst && known.index?.terms.has(subst[0]) ? result.index : v.index, size: v.size, items: v.items, cell: v.cell, range: v.range, mutable: v.mutable, fn: v.fn, boolean: v.boolean, string: v.string, char: v.char, float: v.float, number: v.number, tag: v.tag, ref: v.ref, call: v.call, expr: v.expr, payload: v.payload, fields: v.fields };
    }
    if (result.call) result = { ...result, call: { ...result.call, args: result.call.args.map(go) } };
    if (result.items) result = { ...result, items: result.items.map(go) };
    if (result.payload) result = { ...result, payload: result.payload.map(go) };
    if (result.fields) result = { ...result, fields: result.fields.map(([key, k]) => [key, go(k)]) };
    if (result.fn) result = { ...result, fn: { ...result.fn, env: result.fn.env.map(([n, k]) => [n, go(k)]) } };
    if (result.expr) result = { ...result, expr: { ...result.expr, env: result.expr.env.map(([n, k]) => [n, go(k)]) } };
    return result;
}
// The names a pattern binds.
function patternNames(p: Pattern): string[] {
    switch (p.p) {
        case "var": return [p.name];
        case "as": return [...patternNames(p.left), ...patternNames(p.right)];
        case "typeBind": return [p.name, ...patternNames(p.value)];
        case "schema": return patternNames(p.value);
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
            Object.assign(result, { args: t.args.map(go), solution: t.solution && go(t.solution), decided: t.decided && go(t.decided), known: t.known && substituteKnown(t.known, subst, value) });
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
                // A module's fields are its own generic names: copied as an import copies them.
                fields: t.fields instanceof ModuleFields ? new ModuleFields(copyTypeScope(t.fields.scope))
                    : new Map([...t.fields].map(([k, v]) => [k, go(v)])),
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
            Object.assign(result, { args: t.args.map(go), base: t.base && go(t.base), checks: t.checks?.map(go) });
            break;
        case "apply":
            Object.assign(result, { head: go(t.head), args: t.args.map(go) });
            break;
        case "ctor":
            Object.assign(result, { args: t.args.map(go) });
            break;
    }
    return result;
}

// Inference never evaluates APN. Dependency callbacks provide static module
// interfaces; unsupported operations require an explicit Dynamic boundary.
export function checkTypes(program: TopLevel[], options: CheckOptions = {}): CheckResult {
    const issues: TypeIssue[] = [];
    // How often each name is bound: a top-level value bound once can keep its
    // body to run where it is used (see LazyTop).
    const writes = new Map<string, number>();
    const note = (name: string) => writes.set(name, (writes.get(name) ?? 0) + 1);
    const scan = (node: unknown): void => {
        if (!node || typeof node !== "object") return;
        const value = node as Record<string, any>;
        if ((value.t === "def" || value.t === "stmDef") && value.clauses?.[0]?.params.length === 0) note(value.name);
        if (value.t === "patDef" && value.pattern?.p === "var") note(value.pattern.name);
        for (const child of Object.values(value)) scan(child);
    };
    scan(program);
    let dynamicBoundaries = 0, runtimeChecks = 0, serial = 0, budget = STATEMENT_BUDGET;
    let activeExpression: Expr | undefined, checkingExpression: Expr | undefined;
    // The innermost expression being inferred that has a source location.
    let locatedExpression: Expr | undefined;
    let firstUnknown: Expr | undefined, unknownLength = false;
    type Unbound = { expr: Expr; name: string; hint?: string; inPattern?: boolean; within?: Expr };
    let firstUnbound: Unbound | undefined;
    // The names bound nowhere that the list item being inferred reads, by
    // where it reads them: code may read a name a list joined before binds.
    let openNames: Map<string, Unbound> | undefined;
    // Callee positions of application chains, where a function's shape is trusted.
    const callees = new WeakSet<Expr>();
    // An expression to report at: this one, or the innermost with a location.
    const located = (e?: Expr) => e && sourceLocations.has(e) ? e : locatedExpression;
    const unknown = (): Ty => {
        firstUnknown ??= located(activeExpression ?? checkingExpression);
        dynamicBoundaries++;
        return dynamic;
    };
    const problem = (message: string, e?: Expr, hint?: string): never => {
        // A deferred check (a placeholder) reports at the call being checked.
        const expression = (e?.t === "placeholder" ? undefined : e) ?? activeExpression ?? checkingExpression;
        const loc = expression && sourceLocations.get(expression);
        throw {
            message,
            pos: loc?.start ?? 0,
            len: Math.max(1, (loc?.end ?? 1) - (loc?.start ?? 0)),
            source: loc?.source, file: loc?.file, ...hint ? { hint } : {},
        } satisfies TypeIssue;
    };
    function spend(e?: Expr): void {
        if (--budget < 0) {
            problem("type checking limit exceeded; cannot establish the type", e);
        }
    }
    let requirements: Ty[] = [];
    // Checks a value's type carried to where it is used (a variant's checks).
    const carried = new Set<Ty>();
    // Inside deferred code, and the definition being checked.
    let deferred = 0, defining: Definition | undefined;
    // The top-level definition being checked (see the operation's within).
    let outermost: Definition | undefined;
    const resolving = new Set<Ty>();
    function resolve(t: Ty): Ty {
        if (t.k === "var" && t.link) return resolve(t.link);
        if (t.k === "apply") { const made = appliedType(t); return made === t ? t : resolve(made); }
        if (t.k !== "operation") return t;
        if (t.decided) return resolve(t.decided);
        if (resolving.has(t)) return t.solution ?? t;
        spend();
        if (resolving.size > 96) return problem("type checking limit exceeded; recursive operator constraints need an explicit type pattern");
        resolving.add(t);
        try {
            const result = evaluateOperation(t);
            if (result === t) return t.solution ?? t;
            // Decided once: an operation whose operands are known has one value,
            // which later resolves reuse rather than evaluating it again.
            if (result.k !== "operation") t.decided = result;
            return result;
        }
        finally { resolving.delete(t); }
    }
    // The length of a list derived element-for-element from xs.
    function sameLength(xs: Extract<Ty, { k: "list" }>): { length?: Index } {
        return xs.length ? { length: xs.length } : {};
    }
    function pair(key: Ty, value: Ty): Ty { return { k: "list", element: union([key, value]), items: [key, value], length: constant(2n) }; }
    // The type of a choice between values (a ternary's branches, a match's
    // arms, a function's clauses): one type when they unify, else either
    // one, as a list's items are ([1,"a"] is List (Int | String)).
    function either(a: Ty, b: Ty, e?: Expr): Ty {
        // They unify unless that breaks what is still to be checked of their
        // variables: in x > 0 ? Some x : Some "neg", x is not made a String.
        const free = new Set([...variables(a), ...variables(b)]);
        const pending = requirements.filter(r => r.k === "operation" && [...variables(r)].some(v => free.has(v)));
        const fits = succeeds(() => {
            const vars = new Map<Ty, Ty>();
            const checks = pending.map(r => copy(r, vars));
            unify(copy(a, vars), copy(b, vars), e);
            for (const check of checks) if (check.k === "operation") evaluateOperation(check);
        });
        if (!fits) return union([a, b]);
        unify(a, b, e);
        return a;
    }
    function union(types: Ty[]): Ty {
        const choices = types.flatMap(t => { const r = resolve(t); return r.k === "union" ? r.choices : [t]; });
        const unique: Ty[] = [];
        for (const choice of choices) {
            const value = resolve(choice);
            // The same type twice: an atom, or a closed structure (no type variables) written alike.
            const closed = value.k === "atom" || value.k === "list" && !variables(value).size;
            if (unique.some(old => old === choice || closed && resolve(old).k === value.k && !variables(old).size && text(old) === text(value))) continue;
            // The same constructor where one side does not know an argument
            // (None's beside Some x's), or holds another type (Some 1's beside
            // Some "a"'s): one type, Option X or Option (Int | String), as data
            // holds either. An indexed family's arguments are indexes, kept apart,
            // as is a parameter a function takes or a cell holds: a Handler Int
            // or a Handler String takes one of them, not either.
            const same = value.k === "variant" && !isPending(value) ? unique.findIndex(old => {
                const o = resolve(old);
                return o.k === "variant" && o.name === value.name && o.args.length === value.args.length && o.args.every((x, n) => {
                    const p = resolve(x), q = resolve(value.args[n]);
                    return p === q || p.k === "var" || q.k === "var" || !o.indexed && !value.indexed && !invariance.get(o.name)?.has(n);
                });
            }) : -1;
            if (same >= 0) {
                const o = resolve(unique[same]) as Extract<Ty, { k: "variant" }>, v = value as Extract<Ty, { k: "variant" }>;
                unique[same] = { ...o, args: o.args.map((x, n) => {
                    const p = resolve(x), q = resolve(v.args[n]);
                    return p.k === "var" ? v.args[n] : p === q || q.k === "var" ? x : union([x, v.args[n]]);
                }) };
                continue;
            }
            // Lists of one known length (c ? [x,y,z] : [0.0,0.0,0.0]): one list
            // whose items are either side's.
            const sized = (t: Ty) => t.k === "list" && t.length && !t.length.terms.size ? t.length.constant : undefined;
            const length = sized(value);
            const sibling = length === undefined ? -1 : unique.findIndex(old => sized(resolve(old)) === length);
            if (sibling >= 0) {
                const o = resolve(unique[sibling]) as Extract<Ty, { k: "list" }>, v = value as Extract<Ty, { k: "list" }>;
                const items = o.items && v.items && o.items.length === v.items.length ? o.items.map((x, n) => union([x, v.items![n]])) : undefined;
                unique[sibling] = { k: "list", element: union([o.element, v.element]), length: o.length, ...items ? { items } : {} };
                continue;
            }
            unique.push(choice);
        }
        // An undecided value (return x, empty) beside one monad's value is in
        // that monad: c ? return [] : Err e is a Result.
        const decided = unique.filter(t => !isPending(resolve(t)));
        if (decided.length === 1 && unique.length > 1) {
            const m = resolve(decided[0]);
            if (isIO(m) || m.k === "list" || m.k === "variant" && instanceFor(">>=", [m])) return decided[0];
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
        return !!k.ref || !!k.index?.terms.size || !!k.call?.args.some(symbolic) || !!k.expr?.env.some(([, v]) => symbolic(v)) || !!k.fn?.env.some(([, v]) => symbolic(v));
    }
    // Trying an overload's choices, which defers a call on its own (see application).
    let choosing = 0;
    // An argument whose value, or an element's, depends on an enclosing parameter.
    function symbolicArgument(argument: Known): boolean {
        return symbolic({ index: argument.index, ref: argument.ref, call: argument.call, expr: argument.expr, fn: argument.fn }) ||
            !!argument.items?.some(symbolicArgument) || !!argument.payload?.some(symbolicArgument) ||
            !!argument.fields?.some(([, k]) => symbolicArgument(k));
    }
    // A type still waiting for an unknown type, at its top or in a part ([x,-x]).
    function waitingWithin(type: Ty, seen = new Set<Ty>()): boolean {
        if (waiting(type)) return true;
        const t = resolve(type);
        if (seen.has(t) || t.k === "fn" || t.k === "operation") return false;
        seen.add(t);
        return children(t).some(child => waitingWithin(child, seen));
    }
    // Set while deciding leftover checks at the end: symbolic values no longer wait.
    let deciding = false;
    // The deferred call being evaluated, so deferring it again keeps the same node.
    let evaluatingCall: Extract<Ty, { k: "operation" }> | undefined;
    function deferredCall(f: Ty, argument: Entry): Ty {
        const result: Ty = { k: "operation", op: "call", args: [f, argument.type], known: { index: argument.index, size: argument.size, items: argument.items, cell: argument.cell, range: argument.range, mutable: argument.mutable, fn: argument.fn, boolean: argument.boolean, string: argument.string, char: argument.char, float: argument.float, number: argument.number, tag: argument.tag, ref: argument.ref, call: argument.call, expr: argument.expr, payload: argument.payload, fields: argument.fields } };
        requirements.push(result);
        return resolve(result);
    }
    function operation(op: string, args: Ty[], lossless?: boolean[]): Ty {
        // written: where, for a check decided far from it (see carried).
        const at = located(activeExpression);
        const result: Ty = { k: "operation", op, args, ...lossless ? { lossless } : {}, ...at ? { written: at } : {} };
        requirements.push(result);
        return resolve(result);
    }
    // map, <*>, >>=, >>, =<<, sequence and mapM over an action, a list, or
    // an Option-like variant (mapping its first type parameter).
    function monadicType(op: string, a: Ty, b: Ty): Ty {
        const at = { t: "placeholder" } as Expr;
        // A Mutable cell is read for its contents, as everywhere a value is used.
        if (a.k === "mutable") a = resolve(a.value);
        if (b?.k === "mutable") b = resolve(b.value);
        if (op === "bindFlip") return monadicType("bind", b, a);
        // m >>= k needs a function k; a value to run after m is m >> k.
        if (op === "bind" && ["list", "variant", "atom", "record", "map"].includes(resolve(b).k)) {
            return problem(`'>>=' needs a function on its right, not ${text(b)}`, undefined, "to run it after the left side, discarding that value, use `>>`");
        }
        // What the checker cannot decide is checked when it runs.
        if ((op === "mapM" ? b : a).k === "dynamic") return isExplicit(op === "mapM" ? b : a) ? (runtimeChecks++, explicitDynamic) : unknown();
        if (op === "mapM") {
            if (b.k !== "list") return problem("mapM expects a list");
            return monadicType("sequence", list(application(a, { type: b.element }, at)), b);
        }
        if (op === "sequence") {
            if (a.k !== "list") return problem("sequence expects a list of monadic values");
            if (a.items && !a.items.length) return pendingTy(list(variable(), constant(0n)));
            // A list of m x is m (List x), in its elements' monad (an action's
            // when none is known yet); undecided ones (return x) join it.
            const choices = (t: Ty): Ty[] => { const r = resolve(t); return r.k === "union" ? r.choices.flatMap(choices) : [r]; };
            const elements = a.items ? a.items.flatMap(choices) : choices(a.element);
            const m = elements.find(t => !isPending(t) && t.k !== "var") ?? elements[0];
            const holding = (inner: Ty): Ty | undefined => isIO(m) || m.k === "var" ? io(inner) : isPending(m) ? pendingTy(inner)
                : m.k === "list" ? list(inner)
                : m.k === "variant" && instanceFor(">>=", [m]) ? { k: "variant", name: m.name, args: [inner, ...m.args.slice(1)] }
                : m.k === "apply" ? { k: "apply", head: m.head, args: [inner, ...m.args.slice(1)] } : undefined;
            if (!holding(variable())) return problem(`sequence needs a list of actions or monadic values, not ${text(m)}`);
            // Each holds its own type, as a list's items may differ.
            const held = elements.map(element => {
                const each = variable();
                unify(isPending(element) ? pendingTy(each) : holding(each)!, element);
                return each;
            });
            return holding({ k: "list", element: union(held), ...sameLength(a) })!;
        }
        const container = op === "map" ? b : a, other = op === "map" ? a : b;
        if (isExplicit(container) || isExplicit(other)) { runtimeChecks++; return explicitDynamic; }
        // A monad the checker does not know (an unbound name's) stays unknown.
        if (resolve(container).k === "dynamic") return unknown();
        const name = op === "map" ? "map" : op === "ap" ? "'<*>'" : op === "then" ? "'>>'" : "'>>='";
        // f a with f unknown (a written signature's): map and >>= keep f.
        if (container.k === "apply") {
            const value = container.args[0], holding = (t: Ty): Ty => ({ k: "apply", head: container.head, args: [t, ...container.args.slice(1)] });
            if (op === "map") return holding(application(other, { type: value }, at));
            if (op === "then") { unify(holding(variable()), other); return other; }
            if (op === "bind") { const result = application(other, { type: value }, at); unify(holding(variable()), result); return result; }
            return holding(application(value, { type: monadHeld(other) ?? variable() }, at));
        }
        // A monad not decided yet (return x).
        if (isPending(container)) {
            const value = (container as Extract<Ty, { k: "variant" }>).args[0];
            if (op === "map") return pendingTy(application(other, { type: value }, at));
            if (op === "then") return other;
            if (op === "bind") return application(other, { type: value }, at);
            const input = monadHeld(other) ?? variable();
            return pendingTy(application(value, { type: input }, at));
        }
        // A variant monad: through its instances (map and <*> derive from >>=).
        if (container.k === "variant" && !isIO(container)) {
            const method = op === "map" ? "map" : op === "ap" ? "<*>" : ">>=";
            const k = op === "then" ? fn(variable(), other) : other;
            const direct = viaInstance(method, op === "map" ? [other, container] : [container, k]);
            // m >>= k and m >> k stay in m's monad (f a -> (a -> f b) -> f b),
            // whatever the instance's own clauses give: every choice k gives.
            if (direct && (op === "bind" || op === "then")) unify({ k: "variant", name: container.name, args: container.args.map(() => variable()) }, direct);
            if (direct) return direct;
            // The instance takes m but not k: report why, rather than no instance.
            const instance = (op === "bind" || op === "then") && instanceFor(">>=", [container]);
            if (instance) return application(application(copy(instance), { type: container }, at), { type: k }, at);
            if (op !== "bind" && op !== "then" && instanceFor(">>=", [container])) {
                return { k: "variant", name: container.name, args: container.args.map(() => variable()) };
            }
            return problem(`no ${name} instance for ${text(container)}`, undefined, "define one, such as `map f (Some x) = Some (f x)`");
        }
        const held = (m: Ty): Ty => isIO(m) ? (m as Extract<Ty, { k: "variant" }>).args[0] : m.k === "list" ? m.element
            : problem(`${name} needs an action, a list or a monadic value, not ${text(m)}`);
        const rebuild = (m: Ty, inner: Ty): Ty => isIO(m) ? io(inner) : m.k === "list" ? list(inner)
            : { k: "variant", name: (m as Extract<Ty, { k: "variant" }>).name, args: [inner, ...(m as Extract<Ty, { k: "variant" }>).args.slice(1)] };
        const value = held(container);
        if (op === "map") {
            const out = application(other, { type: value }, at);
            return container.k === "list" ? { k: "list", element: out, ...sameLength(container) } : rebuild(container, out);
        }
        if (op === "ap") {
            const input = held(resolve(other));
            // A list of different functions applies each one.
            if (container.k === "list" && container.items) return list(union(container.items.map(f => application(f, { type: input }, at))));
            return rebuild(container, application(value, { type: input }, at));
        }
        // m >>= f: f's result is a container of the same kind; m >> k is k.
        const next = op === "then" ? other : application(other, { type: value }, at);
        const shape = rebuild(container, variable());
        if (container.k === "list") { unify(list((shape as Extract<Ty, { k: "list" }>).element), next); return list(monadHeld(next) ?? variable()); }
        unify(shape, next);
        return isPending(resolve(next)) ? io(monadHeld(next) ?? variable()) : next;
    }
    // What running a value of type t yields: an action's result, or the
    // value itself (x <- 5 binds 5); decided once t is known.
    // What x <- m binds: what the action yields, or what another monad holds
    // (an Option's value, a list's element), once m's type is known.
    function runType(t: Ty): Ty {
        const v = resolve(t);
        if (isIO(v) || isPending(v)) return (v as Extract<Ty, { k: "variant" }>).args[0];
        if (v.k === "var" || v.k === "operation") return operation("run", [v]);
        const held = monadHeld(v);
        return held === undefined ? v : held ?? variable();
    }
    function evaluateOperation(t: Extract<Ty, { k: "operation" }>): Ty {
        const operands = t.args.map(resolve);
        // A Mutable cell is read for its contents, as at runtime.
        if (["+", "-", "*", "/", "%", "^", "++", "compare", "negate", "length", "pairs", "keys", "values", "enumerate"].includes(t.op)) {
            for (let n = 0; n < operands.length; n++) {
                while (operands[n].k === "mutable") operands[n] = resolve((operands[n] as Extract<Ty, { k: "mutable" }>).value);
                if (operands[n].k === "variant" && (operands[n] as Extract<Ty, { k: "variant" }>).ordinal) operands[n] = atom("Int");
            }
        }
        const [a, b] = operands;
        // when c action: in the action's monad, whatever c is.
        if (t.op === "when") return b.k === "var" || b.k === "operation" ? t : monadicType("then", b, pendingTy(list(variable(), constant(0n))));
        if (t.args.some(x => { const v = resolve(x); return v.k === "var" || v.k === "operation"; })) return t;
        if (t.op === "run") return runType(a);
        if (["map", "ap", "bind", "then", "bindFlip", "sequence", "mapM"].includes(t.op)) return monadicType(t.op, a, b);
        if (["map2", "map3", "map4"].includes(t.op)) return operands.slice(2).reduce((mf: Ty, m) => monadicType("ap", mf, m), monadicType("map", a, b));
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
        // An overloaded operator's operands, once known, choose its clauses or
        // its builtin meaning.
        if (t.op.startsWith("overloaded:")) {
            const at: Expr = { t: "placeholder" }, [f, l, r] = operands;
            if (overloadAccepts(f, l, r)) return application(application(f, { type: l }, at), { type: r }, at);
            return operatorApplication(t.op.slice("overloaded:".length), { type: l }, { type: r }, at);
        }
        if (t.op.startsWith("field:")) {
            const name = t.op.slice(6);
            if (a.k !== "record") return problem("field access requires a record");
            return a.fields.get(name) ?? problem(`missing field '${name}'`);
        }
        if (t.op === "pattern") return application(a, { type: b }, activeExpression ?? { t: "placeholder" });
        if (t.op === "load") return unknown();
        if (t.op === "set") {
            // An explicit Dynamic target (such as an FFI Pointer) is checked at runtime.
            if (isExplicit(a)) { runtimeChecks++; return io(list(variable(), constant(0n))); }
            if (a.k !== "mutable") return problem("set expects a Mutable reference", undefined, "a value never changes: make a cell (i = Mutable 0), or bind a new version (i = i + 1)");
            convert(a.value, b, { t: "placeholder" });
            return io(list(variable(), constant(0n)));
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
            // A record schema converts the value once it is known.
            if (a.k === "record") return waiting(b) ? t : application(a, { type: b }, { t: "placeholder" });
            if (a.k !== "type") return problem("expected a type constructor");
            if (resolve(a.value).k === "var") return t;
            return application(a, { type: b }, { t: "placeholder" });
        }
        if (t.op === "template") return template(a, b, { t: "placeholder" });
        // do xs is the block whose statements are the elements, so its type is
        // the last one's ([] for none); a literal list is checked as that block.
        if (t.op === "do") {
            if (a.k !== "list") return problem("do expects a list of statements");
            return a.items ? a.items.at(-1) ?? list(dynamic, constant(0n)) : a.element;
        }
        if (t.op === "to" || t.op === "from") {
            if (a.k === "var") return t;
            // A program's instance first, as at runtime.
            const own = instanceFor(t.op, [a, b]);
            if (own && resolve(own).k !== "var") {
                const placeholder = { t: "placeholder" } as Expr;
                return application(application(copy(own), { type: a }, placeholder), { type: b }, placeholder);
            }
            // A list template ([Char], [Int,String]) converts position by position, as cast does.
            if (a.k === "list" && a.items?.length && a.items.every(item => resolve(item).k === "type")) {
                if (t.op === "to") return template(a, b, activeExpression ?? { t: "placeholder" });
                return problem("no from instance for a list template", undefined, "join characters with `from (List Char) cs`; convert with `to`, as in `to [Char,Char] \"hi\"`");
            }
            // So does a record schema ([quote: String, year: Int]), a type too.
            if (a.k === "record" && describing(a)) {
                if (t.op === "to") return application(a, { type: b }, activeExpression ?? { t: "placeholder" });
                const shown = text(schemaValue(a, { t: "placeholder" }));
                return problem(`no from instance for ${shown}`, undefined, `define one, such as \`from ${shown} x = ...\``);
            }
            if (a.k !== "type") return problem(`${t.op} expects a type, as in ${t.op} String x`);
            const target = resolve(a.value);
            const named = (name: string) => target.k === "variant" && target.name === name && !!target.base;
            const chars = target.k === "list" && !target.items && resolve(target.element).k === "atom" && (resolve(target.element) as { name: string }).name === "Char";
            const string = target.k === "atom" && target.name === "String";
            if (t.op === "to") {
                if (string || named("JSON")) return atom("String");
                if (chars) { unify(atom("String"), b); return list(atom("Char")); }
                return application(a, { type: b }, { t: "placeholder" });
            }
            if (string || named("JSON")) { unify(atom("String"), b); return explicitDynamic; }
            if (chars) { unify(list(atom("Char")), b); return atom("String"); }
            return problem(`no from instance for ${text(target)}`, undefined, `define one, such as \`from ${text(target)} x = ...\``);
        }
        if (t.op === "match") {
            if (b.k !== "list") return problem("match expects a list of alternatives");
            const outputs: Ty[] = [], lengths: (Index | undefined)[] = [];
            for (const candidate of b.items ?? [b.element]) {
                const f = resolve(candidate);
                if (f.k !== "fn") return problem("match alternatives must be functions");
                try {
                    if (f.pattern?.p === "as" || f.pattern?.p === "schema" || f.pattern?.p === "recPat") application(copy(f), { type: copy(a) }, activeExpression ?? { t: "placeholder" });
                    else unify(copy(f.input), copy(a));
                } catch { continue; }
                if (f.pattern?.p === "schema" || f.pattern?.p === "recPat") application(f, { type: a }, activeExpression ?? { t: "placeholder" });
                // An alternative's [] tests the value, it does not make it empty.
                else unify(openEmpty(f.input), a);
                if (!t.solution && f.output.k !== "operation" && f.output.k !== "var") t.solution = f.output;
                for (const check of f.checks ?? []) resolve(check);
                const output = resolve(f.output);
                lengths.push(output.k === "list" ? output.length : undefined);
                // Alternatives give either result, as a ternary's branches do.
                if (outputs.length) outputs[0] = either(outputs[0], output);
                else outputs.push(output.k === "list" ? list(output.element) : output);
            }
            // Alternatives that all have one length (a claim each met) give it.
            const first = resolve(outputs[0] ?? variable()), length = lengths[0];
            if (first.k === "list" && length && lengths.every(x => x && indexText(x) === indexText(length))) return list(first.element, length);
            return outputs[0] ?? variable();
        }
        // A requirement on a call that still waits for an unknown argument waits
        // too, rather than settling for the call's provisional solution.
        if (t.op === "require") { if (t.args.some(x => waiting(x))) return t; unify(a, b); return a; }
        if (isExplicit(a) || b && isExplicit(b)) return explicitDynamic;
        if (a.k === "dynamic" || b?.k === "dynamic") return unknown();
        if (a.k === "union" && a.undecided || b?.k === "union" && b.undecided) return ambiguous((a.k === "union" && a.undecided ? a : b) as Extract<Ty, { k: "union" }>);
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
            // [] is the empty record too.
            else if (a.k === "list" && a.items?.length === 0 && t.op === "pairs") return list(variable(), constant(0n));
            // The pairs of a record not known (Record): its field names and any values.
            else if (a.k === "atom" && a.name === "Record" && t.op === "pairs") { key = atom("String"); value = variable(); }
            else return problem(`${t.op} requires a collection; got ${text(a)}`);
            return list(t.op === "keys" ? key : t.op === "values" ? value : pair(key, value));
        }
        // A named subtype keeps its name through arithmetic with itself or a
        // plain value of its base (Money 1 + 1.0 is a Money); two names do not mix.
        if (a.k === "variant" && a.base || b?.k === "variant" && b.base) {
            const named = (x: Ty | undefined) => x?.k === "variant" && x.base ? x : undefined;
            const [x, y] = [named(a), named(b)];
            if (x && y && x.name !== y.name) return problem(`cannot combine ${x.name} and ${y.name}`);
            const kept = (x ?? y)!;
            if (["<", ">", "<=", ">="].includes(t.op)) return operation(t.op, [x ? kept.base! : a, y ? kept.base! : b!]);
            operation(t.op, [x ? kept.base! : a, y ? kept.base! : b!]);
            return kept;
        }
        const numeric = (x: Ty) => x.k === "atom" && NUMERIC_TYPES.includes(x.name);
        const callable = (x: Ty) => ["fn", "type", "overload"].includes(x.k);
        if (t.op === "call") {
            const outer = evaluatingCall, active = activeExpression;
            evaluatingCall = t;
            // Decided while its own definition is checked (not at a call that
            // supplies the value, which reports there): report where it was written.
            if (t.written && outermost && t.within === outermost) activeExpression = t.written;
            try { return application(a, { type: b, ...resolveKnown(t.known ?? {}) }, { t: "placeholder" }); }
            finally { evaluatingCall = outer; activeExpression = active; }
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
            // Iterating an action (xs * print) is one action yielding the results.
            const action = (each: Ty) => isIO(resolve(each)) || isPending(resolve(each));
            const results = (each: Ty, list: Ty): Ty => action(each) ? io(list) : list;
            // A string supplies its characters.
            if (input.k === "atom" && input.name === "String") {
                const each = application(f, { type: atom("Char") }, { t: "placeholder" });
                return results(each, list(action(each) ? runType(each) : each));
            }
            if (input.k === "list") {
                const each = application(f, { type: input.element }, { t: "placeholder" });
                return results(each, { k: "list", element: action(each) ? runType(each) : each, ...sameLength(input) });
            } else if (input.k === "record") element = { k: "list", element: union([atom("String"), ...input.fields.values()]), items: [atom("String"), union([...input.fields.values()])], length: constant(2n) };
            else if (input.k === "atom" && input.name === "Int") element = input;
            else return problem(`iteration needs a list, string, record, or Int; got ${text(input)}`);
            const each = application(f, { type: element }, { t: "placeholder" });
            return results(each, list(action(each) ? runType(each) : each));
        }
        if (t.op === "\\" && callable(a) && callable(b)) {
            const input = variable();
            const output = application(a, { type: application(b, { type: input }, { t: "placeholder" }) }, { t: "placeholder" });
            return fn(input, output);
        }
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
            if (a.k === "atom" && b.k === "atom") return arithmeticResult(t.op, a, b, t.lossless);
            return t.op === "/" ? atom("Number") : text(a) === text(b) ? a : integerResult(a, b) ?? atom("Number");
        }
        if (t.op === "+" && a.k === "atom" && b.k === "atom" && a.name === "String" && b.name === "String") return a;
        return problem(`operator '${t.op}' cannot combine ${text(a)} and ${text(b)}`);
    }
    let lengthFacts = new Map<string, Index>();
    // match s alternatives: the type of s, and each literal alternative's input.
    const matchScrutinees = new WeakMap<Expr, Ty>(), alternativeInputs = new WeakMap<Expr, Ty[]>();
    // The length a claim around a match (Vect (n + m) a (match ...)) asks of
    // each literal alternative, checked under that alternative's own facts.
    const alternativeClaims = new WeakMap<Expr, Index>();
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
            // An undecided place takes it as it is, checked at runtime.
            if (expected.k === "dynamic") { runtimeChecks++; return; }
            return problem(`Dynamic requires an explicit conversion to ${text(expected)}`, e);
        }
        if (expected.k === "dynamic" || actual.k === "dynamic") {
            firstUnknown ??= located(e);
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
        // An undecided call is decided only where a type is named (a
        // conversion, a typed pattern, an annotation), as at runtime.
        for (const undecided of [actual, expected]) {
            if (undecided.k === "union" && undecided.undecided) return ambiguous(undecided, e);
        }
        if (expected.k === "operation" || actual.k === "operation") {
            if (expected.k === "operation" && actual.k !== "operation") expected.solution = actual.k === "list" ? list(actual.element) : actual;
            if (actual.k === "operation" && expected.k !== "operation") actual.solution = expected.k === "list" ? list(expected.element) : expected;
            requirements.push({ k: "operation", op: "require", args: [expected, actual] });
            return;
        }
        // f a b against a known type: f is that type missing its first parameters.
        if (expected.k === "apply" || actual.k === "apply") {
            const [app, other] = expected.k === "apply" ? [expected, actual] : [actual as Extract<Ty, { k: "apply" }>, expected];
            const n = app.args.length, both = (heads: [Ty, Ty], args: Ty[]) => { unify(heads[0], heads[1], e, seen); app.args.forEach((x, i) => unify(x, args[i], e, seen)); };
            if (other.k === "apply" && other.args.length === n) return both([app.head, other.head], other.args);
            if (other.k === "list" && n === 1) return both([app.head, { k: "ctor", name: "List", args: [] }], [other.element]);
            if (other.k === "variant" && other.args.length >= n) return both([app.head, { k: "ctor", name: other.name, args: other.args.slice(n) }], other.args);
            return problem(`cannot use ${text(actual)} where ${text(expected)} is required`, e);
        }
        if (expected.k === "ctor" || actual.k === "ctor") {
            if (expected.k === "ctor" && actual.k === "ctor" && expected.name === actual.name && expected.args.length === actual.args.length) {
                expected.args.forEach((x, n) => unify(x, actual.args[n], e, seen));
                return;
            }
            return problem(`cannot use ${text(actual)} where ${text(expected)} is required`, e);
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
        // A pending monadic value takes the type of the monad it is used in.
        if (isPending(expected) || isPending(actual)) {
            const pending = (isPending(expected) ? expected : actual) as Extract<Ty, { k: "variant" }>;
            const other = pending === expected ? actual : expected;
            const held = monadHeld(other);
            if (held === undefined) return problem(`cannot use ${text(actual)} where ${text(expected)} is required`, e);
            if (held !== null) unify(pending.args[0], held, e, seen);
            return;
        }

        if (
            expected.k === "atom" && expected.name === "Type" && (actual.k === "type" || describing(actual))
        ) return;
        // A list or record of types ([quote: String, year: Int]) is a type, as at runtime.
        if (expected.k === "type" && (actual.k === "record" || actual.k === "list") && describing(actual)) {
            return unify(expected.value, schemaValue(actual, e ?? { t: "placeholder" }), e, seen);
        }
        // A Function field or parameter accepts any function.
        if (expected.k === "atom" && expected.name === "Function" && ["fn", "overload", "intrinsic"].includes(actual.k)) return;
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
            // A parameter that converts its argument ((UInt k)) accepts any
            // argument that converts, as a call does: toList (k - 1) for an Int k.
            if (actual.coerce && !expected.coerce && resolve(expected.input).k === "atom" && resolve(actual.input).k === "atom") convert(actual.input, expected.input, e ?? { t: "placeholder" });
            else unify(actual.input, expected.input, e, seen);
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
                if (delta.terms.size) { if (!firstUnknown) { firstUnknown = located(e); unknownLength = true; } dynamicBoundaries++; }
            } else if (expected.length) { if (!firstUnknown) { firstUnknown = located(e); unknownLength = true; } dynamicBoundaries++; }
            return;
        }
        if (expected.k === "map" && actual.k === "map") { unify(expected.key, actual.key, e, seen); unify(expected.value, actual.value, e, seen); return; }
        if (expected.k === "record" && actual.k === "record") {
            // An open record (one known only from the fields code reads, such
            // as a parameter's) takes the fields it has not seen yet.
            for (const [key, type] of expected.fields) {
                if (!actual.fields.has(key)) {
                    if (actual.open) { actual.fields.set(key, type); continue; }
                    problem(`missing field '${key}'`, e);
                }
                unify(type, actual.fields.get(key)!, e, seen);
            }
            if (expected.open) for (const [key, type] of actual.fields) if (!expected.fields.has(key)) expected.fields.set(key, type);
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
            // Where a value meets another place, what is still to be checked of it is checked there.
            for (const check of [...expected.checks ?? [], ...actual.checks ?? []]) {
                carried.add(check);
                if (!requirements.includes(check)) requirements.push(check);
            }
            return;
        }
        // A named subtype is its base wherever the base is expected; a plain
        // value is not one (converting makes one: List Count [1]).
        if (actual.k === "variant" && actual.base && expected.k !== "variant") return unify(expected, actual.base, e, seen);
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
        if (e.t === "binop" && ["==", "!=", "<", ">", "<=", ">="].includes(e.op) && builtinAt(e, scope)) {
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
        // Anything else is evaluated as the program would (isEven 4, a call),
        // unless it reads a cell, whose contents depend on when it runs.
        if (e.t === "app" || e.t === "binop" || e.t === "ternary" || e.t === "unop") return peek(() => truth(computed(e, scope)), undefined);
        return undefined;
    }
    // An Int operand the checker knows, small enough to convert to binary64
    // losslessly: arithmetic with a Float then gives a Float (dt / 8).
    function losslessInt(known: Index | undefined): boolean {
        return !!known && !known.terms.size && (known.constant < 0n ? -known.constant : known.constant) <= 2n ** 53n;
    }
    // The result of arithmetic on two numeric types: lossless says which
    // operands are known lossless Ints.
    function arithmeticResult(op: string, x: Extract<Ty, { k: "atom" }>, y: Extract<Ty, { k: "atom" }>, lossless: boolean[] = []): Ty {
        const binary64 = (t: Extract<Ty, { k: "atom" }>) => t.name === "Float" || t.name === "Float64";
        if (binary64(x) && y.name === "Int" && lossless[1]) return x;
        if (binary64(y) && x.name === "Int" && lossless[0]) return y;
        // Floats divide to the same float; other quotients may be exact fractions.
        if (op === "/") return x.name === y.name && ["Float", "Float32", "Float64"].includes(x.name) ? x : atom("Number");
        return x.name === y.name ? x : integerResult(x, y) ?? atom("Number");
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
        if (e.t === "binop" && builtinAt(e, scope)) {
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
        const shared = sharedType(t);
        if (shared) return shared;
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
            const result: Ty = { k: "record", fields: new Map(), closed: true };
            seen.set(t, result);
            for (const [key, value] of t.fields) result.fields.set(key, schemaValue(value, e, seen));
            return result;
        }
        // A lambda (Handler = a -> IO []) where a type is expected is the
        // function type it spells: its parameter any type, its result read as one.
        if (t.k === "fn") return fn(variable(), schemaValue(t.output, e, seen));
        // An unbound name (missing.File) is the problem to report, not its type.
        if (firstUnbound) return unknown();
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
        if (e.t === "lambda" || e.t === "patternLambda") return lambdaType(e, scope, new Map());
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
        // A free name in an applied type binds what the value has there:
        // (Vect n a) xs binds its length n and element type a, (List a) xs
        // its element type, as at runtime.
        if (captures && e.t === "app") {
            let args: Expr[] = [];
            let head: Expr = e;
            while (head.t === "app") { args.unshift(head.a); head = head.f; }
            // _ takes whatever is there and names nothing: a fresh name no one reads.
            if (args.some(arg => arg.t === "placeholder")) {
                args = args.map(arg => arg.t === "placeholder" ? { t: "var", name: `$_${serial++}` } as Expr : arg);
                e = args.reduce<Expr>((f, a) => ({ t: "app", f, a }), head);
            }
            // A value position: Vect's length, or an indexed family's index
            // (a position some constructor's result computes: Z, S k).
            const vector = head.t === "var" && resolve(scope.get(head.name)?.type ?? dynamic).k === "factory";
            const family = head.t === "var" ? indexedFamilies.get(head.name) : undefined;
            const valueAt = (n: number) => vector && n === 0 || !!family?.def.variants.some(v => {
                const args: Expr[] = [];
                let result = v.result;
                while (result?.t === "app") { args.unshift(result.a); result = result.f; }
                return args[n] && !(args[n].t === "var" && /^[a-z]/.test((args[n] as { name: string }).name));
            });
            args.forEach((arg, n) => {
                // A name an earlier parameter bound is that value.
                if (arg.t !== "var" || !/^([a-z]|\$_)/.test(arg.name) || captures.has(arg.name)) return;
                // A type position keeps a name bound to a type or function; any
                // other name is a type variable, as in a written function type.
                // A length, a value, keeps a name bound to a value instead.
                const bound = scope.get(arg.name), kind = bound && resolve(bound.type).k;
                // (A function defined later is declared ahead: forward.)
                const typeLike = kind === "type" || kind === "fn" || kind === "intrinsic" || kind === "factory" || kind === "alias" ||
                    !!bound && bound.type === forward.get(arg.name);
                if (valueAt(n) ? bound && !typeLike : typeLike) return;
                captures.add(arg.name);
                if (vector && n === 0) scope.set(arg.name, { type: atom("Int"), mono: true, index: { constant: 0n, terms: new Map([[`n${serial++}`, 1n]]) } });
                else if (valueAt(n)) scope.set(arg.name, { type: variable(), mono: true });
                else scope.set(arg.name, { type: { k: "type", value: variable() }, mono: true });
            });
        }
        if (e.t === "list") {
            const items = e.v.map(value => typeExpr(value, scope, captures));
            return { k: "list", items, element: items.length ? union(items) : variable(), length: constant(BigInt(items.length)),
                preserve: new Set(e.v.flatMap((value, n) => (schemaWildcard(value) || captures && value.t === "var" && captures.has(value.name)) ? [n] : [])) };
        }
        return schemaValue(infer(e, scope), e);
    }
    // A lambda read as the function type it spells out, as at runtime:
    // (Int -> Int), (a -> a), ((a -> b) -> List a -> List b). A lowercase name
    // is the type it is bound to, or else a type variable, the same one
    // wherever the name appears in the signature.
    function lambdaType(e: Extract<Expr, { t: "lambda" | "patternLambda" }>, scope: Scope, variables: Map<string, Ty>): Ty {
        const local: Scope = new Map(scope);
        const typeVariable = (name: string): Ty => {
            if (name === "_") return variable();
            const bound = scope.get(name), type = bound && resolve(bound.type);
            if (type?.k === "type" && !variables.has(name)) return type.value;
            if (variables.has(name)) { const t = variables.get(name)!; local.set(name, { type: { k: "type", value: t }, mono: true }); return t; }
            if (!variables.has(name)) variables.set(name, variable());
            const t = variables.get(name)!;
            local.set(name, { type: { k: "type", value: t }, mono: true });
            return t;
        };
        const read = (x: Expr): Ty => {
            // A free name is a type variable unless it names a type or a
            // function (which builds one), as at runtime.
            for (const name of freeNames(x)) {
                const bound = local.get(name), type = bound && resolve(bound.type);
                if (!type || type.k !== "type" && type.k !== "fn" && type.k !== "intrinsic") typeVariable(name);
            }
            if (x.t === "block" && x.stmts.length === 1) return read(x.stmts[0]);
            return x.t === "lambda" || x.t === "patternLambda" ? lambdaType(x, local, variables) : typeExpr(lift(x), local);
        };
        // f a with f a type variable: the applied type, under a fresh name.
        const lift = (x: Expr): Expr => {
            if (x.t === "app") {
                const args: Expr[] = [];
                let head: Expr = x;
                while (head.t === "app") { args.unshift(head.a); head = head.f; }
                if (head.t === "var" && variables.has(head.name)) {
                    const name = `$type${local.size}`;
                    local.set(name, { type: { k: "type", value: { k: "apply", head: variables.get(head.name)!, args: args.map(read) } }, mono: true });
                    return { t: "var", name };
                }
                return { ...x, f: lift(x.f), a: lift(x.a) };
            }
            if (x.t === "list") return { ...x, v: x.v.map(lift) };
            if (x.t === "block" && x.stmts.length === 1) return lift(x.stmts[0]);
            return x;
        };
        const pattern = (p: Pattern): Ty => {
            switch (p.p) {
                case "var": return typeVariable(p.name);
                case "wildcard": return variable();
                case "schema": {
                    // ((f a) e), or (f a e): f a's type applied to e as well.
                    const type = read(p.type), applied = resolve(type);
                    return applied.k === "apply" && p.value.p === "var" ? { k: "apply", head: applied.head, args: [...applied.args, typeVariable(p.value.name)] } : type;
                }
                case "list": return { k: "list", items: p.v.map(pattern), element: union(p.v.map(() => variable())), length: constant(BigInt(p.v.length)) };
                case "constr": {
                    const args = p.args.map(arg => {
                        if (arg.p === "var") { typeVariable(arg.name); return { t: "var", name: arg.name } as Expr; }
                        if (arg.p === "wildcard") return { t: "placeholder" } as Expr;
                        const name = `$type${local.size}`;
                        local.set(name, { type: { k: "type", value: pattern(arg) }, mono: true });
                        return { t: "var", name } as Expr;
                    });
                    return typeExpr(args.reduce((f: Expr, a): Expr => ({ t: "app", f, a }), { t: "var", name: p.tag }), local);
                }
                // f a: a type variable applied to a type.
                case "typeBind": return { k: "apply", head: typeVariable(p.name), args: [pattern(p.value)] };
                default: return problem("expected a type description", e);
            }
        };
        const inputs = e.t === "lambda" ? e.params.map(typeVariable) : e.params.map(pattern);
        return inputs.reduceRight((output: Ty, input) => fn(input, output, undefined, true), read(e.body));
    }
    // An undecided call used where no type is named.
    function ambiguous(t: Extract<Ty, { k: "union" }>, e?: Expr): never {
        return problem(`ambiguous: nothing decides which ${t.name ?? "overload"}`, e, `name the type it should have, as in \`Int (${t.name ?? "f"} ...)\``);
    }
    // Whether a check succeeds, without recording what it would unify.
    function succeeds(check: () => unknown): boolean {
        const saved = requirements.length;
        choosing++;
        try { check(); return true; }
        catch (error) {
            if (error && typeof error === "object" && "message" in error) return false;
            throw error;
        } finally { choosing--; requirements.length = saved; }
    }
    // A capitalized name for a scalar type names a subtype (Money = Float), as
    // at runtime; undefined for anything else.
    function namedSubtype(name: string, t: Ty): Ty | undefined {
        const type = resolve(t), base = type.k === "type" ? resolve(type.value) : undefined;
        if (base?.k !== "atom" || !NAMED_BASES.has(base.name)) return undefined;
        return { k: "type", value: { k: "variant", name, args: [], base } };
    }
    // A capitalized function applied to all its parameters, as the run
    // makes it (Interpreter.construct): what its body gives. Clauses with
    // patterns are chosen by the run.
    function construct(f: Extract<Ty, { k: "alias" }>, args: Entry[], e: Expr): Ty {
        if (f.clauses) { runtimeChecks++; return explicitDynamic; }
        const scope = new Map(f.scope);
        f.params.forEach((name, i) => scope.set(name, { ...args[i], mono: true }));
        return infer(f.body, scope);
    }
    // What a name in X = A | B is bound to here, as the run decides (Interpreter.alternative).
    function alternative(name: string, declared: string, scope: Scope): Alternative {
        const entry = scope.get(name);
        if (!entry || name === "[]" || name === "::") return "new";
        if (isConstructor(entry)) {
            let made = resolve(entry.type);
            while (made.k === "fn") made = resolve(made.output);
            if (made.k === "variant" && made.name === declared) return "new";
            // Declared alone with _ (Just x = _): no union owns it yet.
            const own = entry.declaration;
            if (own && own.variants.length === 1 && own.name === name && !own.claims) return "unclaimed";
            // One sharing its type's name is that type (see sharedType).
            return made.k === "variant" && made.name === name ? "type" : "constructor";
        }
        return ["type", "alias", "factory"].includes(resolve(entry.type).k) ? "type" : "new";
    }
    // tag Owner Ctor [fields], as the run makes it: a declared constructor's
    // own value (tag Option Some [5] is Some 5), else a value of Owner whose
    // arguments are its fields' types, which a pattern of Ctor binds.
    function taggedType(e: Extract<Expr, { t: "app" }>, scope: Scope): Ty | undefined {
        if (e.f.t !== "app" || e.f.f.t !== "app") return undefined;
        const head = e.f.f.f, owner = e.f.f.a, ctor = e.f.a;
        const primitive = head.t === "var" && head.name === "tag" ? resolve(scope.get("tag")?.type ?? unknown()).k === "intrinsic"
            : head.t === "recordAccess" && head.field === "tag" && head.rec.t === "var" && head.rec.name === "intrinsics" && !!scope.get("intrinsics")?.builtin;
        if (!primitive || owner.t !== "var" || ctor.t !== "var") return undefined;
        // As at runtime: an owner and a constructor the program defines.
        if (TYPE_NAMES.includes(owner.name) || !/^[A-Z]/.test(owner.name)) return problem("tag's owner must be a type the program defines", e, "Some a = tag Option Some [a]");
        if (TYPE_NAMES.includes(ctor.name) || !/^[A-Z]/.test(ctor.name)) {
            return problem("tag's constructor must be a capitalized definition or constructor", e, "Some a = tag Option Some [a]");
        }
        const fields = resolve(infer(e.a, scope));
        if (fields.k !== "list" || !fields.items) return undefined;
        const declared = scope.get(ctor.name);
        if (isConstructor(declared)) return fields.items.reduce<Ty>((made, field) => application(made, { type: field }, e), declared!.type);
        return { k: "variant", name: owner.name, args: fields.items, fields: true };
    }
    // What a capitalized function makes from any arguments: the type a pattern
    // of it takes ((Rect w h) a Rect, its fields' types fresh where they vary).
    function constructed(f: Extract<Ty, { k: "alias" }>, e: Expr): Ty {
        const args = f.params.map((): Entry => ({ type: variable() }));
        let t: Ty = explicitDynamic;
        if (!f.clauses) succeeds(() => { t = construct(f, args, e); });
        return t;
    }
    // A function type with its result after these parameters left open.
    function withoutResult(t: Ty, arity: number): Ty {
        const x = resolve(t);
        if (arity === 0 || x.k !== "fn") return variable();
        return { ...x, output: withoutResult(x.output, arity - 1) };
    }
    // The head of a function's result after these parameters: Int, Option.
    function resultHead(t: Ty, arity: number): string | undefined {
        let x = resolve(t);
        for (let n = 0; n < arity; n++) {
            if (x.k !== "fn") return undefined;
            x = resolve(x.output);
        }
        if (x.k === "atom") return x.name;
        if (x.k === "variant") return isPending(x) ? undefined : x.name;
        if (x.k === "list") return "List";
        if (x.k === "record") return "Record";
        if (x.k === "fn") return "Function";
        return undefined;
    }
    // A lambda written in place, perhaps in parentheses.
    function lambdaLiteral(e: Expr): Extract<Expr, { t: "lambda" | "patternLambda" }> | undefined {
        if (e.t === "block" && e.stmts.length === 1 && e.style === "(") return lambdaLiteral(e.stmts[0]);
        return e.t === "lambda" || e.t === "patternLambda" ? e : undefined;
    }
    // The lowercase names an expression uses without binding them.
    function freeNames(e: Expr): string[] {
        const names = new Set<string>();
        const walk = (x: unknown, bound: Set<string>): void => {
            if (Array.isArray(x)) { x.forEach(y => walk(y, bound)); return; }
            if (!x || typeof x !== "object" || "p" in (x as object)) return;
            const n = x as Record<string, unknown>;
            if (n.t === "var" && /^[a-z]/.test(n.name as string) && !bound.has(n.name as string)) { names.add(n.name as string); return; }
            if (n.t === "lambda" || n.t === "patternLambda") return;
            for (const value of Object.values(n)) if (value && typeof value === "object") walk(value, bound);
        };
        walk(e, new Set());
        return [...names];
    }
    function schemaWildcard(e: Expr): boolean {
        return e.t === "placeholder" || e.t === "block" && e.stmts.length === 1 && schemaWildcard(e.stmts[0]);
    }
    // A var-only list pattern such as [x,y] selects those fields from a record,
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
    // The type of the value each pattern binding binds (see bindingValue).
    const boundValues = new WeakMap<Expr, Ty>();
    // The value a binding statement gives, as a block's last statement or a
    // list's item: what it binds, when it binds one name.
    function bindingValue(statement: Expr | undefined, scope: Scope): Ty | undefined {
        if (statement?.t === "patDef") return boundValues.get(statement);
        return statement?.t === "stmDef" ? scope.get(statement.name)?.type : undefined;
    }

    // A list's code (see Formula): each item inferred in the scope it was
    // written in after the bindings of the items before it (a joined list's
    // winning over the names there), as a block's statements are; a binding's
    // item is the value it binds. An item reading a name in changed is
    // inferred again, any other keeps its type. A name bound nowhere is open.
    function codeList(items: FormulaItem[], changed = new Set<string>()): Ty {
        changed = new Set(changed);
        const before = new Map<string, Entry>();
        const local = items.some(item => item.expr && binding(item.expr)) || changed.size > 0;
        let run: { scope: Scope; local: Scope } | undefined;
        // The bindings so far: an item after an x <- m item yields the block of
        // them ending in it (see Interpreter.yields), checked as one.
        const statements: Expr[] = [];
        let runs = false;
        // A list is an unevaluated block: its x <- m items bind as a block's do.
        doBlocks.push({});
        try { return codeItems(); } finally { doBlocks.pop(); }
        function codeItems(): Ty {
        const out = items.map((item): FormulaItem => {
            if (item.expr && binding(item.expr)) {
                statements.push(item.expr);
                runs ||= item.expr.t === "patDef" && !!item.expr.eager;
            }
            if (!item.expr || item.type && !mentions(item.expr, changed)) {
                for (const [name, entry] of item.binds ?? []) { before.set(name, entry); run?.local.set(name, entry); }
                return item;
            }
            if (run?.scope !== item.scope) {
                const scope: Scope = local ? new BlockScope(item.scope!) : item.scope!;
                for (const [name, entry] of before) scope.set(name, entry);
                run = { scope: item.scope!, local: scope };
            }
            const here = run!.local, outer = openNames, open = openNames = new Map();
            let type: Ty;
            try {
                const t = infer(item.expr, here);
                type = binding(item.expr) ? bindingValue(item.expr, here) ?? variable() : item.slot ? slotValue(item.slot, t, item.expr) : t;
                if (runs && !binding(item.expr)) infer({ t: "block", stmts: [...statements, item.expr], style: "{" }, item.scope ?? here);
            } finally { openNames = outer; }
            const names = item.expr.t === "patDef" ? patternNames(item.expr.pattern)
                : item.expr.t === "stmDef" && /^[A-Z]/.test(item.expr.name) && item.expr.clauses[0].params.length ? item.expr.clauses[0].params.flatMap(patternNames)
                : item.expr.t === "stmDef" ? [item.expr.name] : [];
            const binds = names.length ? new Map(names.flatMap(name => { const entry = here.get(name); return entry ? [[name, entry] as const] : []; })) : undefined;
            for (const [name, entry] of binds ?? []) { before.set(name, entry); changed.add(name); }
            return { ...item, type, binds, open: open.size ? open : undefined };
        });
        const types = out.map(item => item.type ?? variable());
        const open = new Map(out.flatMap(item => [...item.open ?? []]));
        return { k: "list", element: types.length ? union(types) : variable(), length: constant(BigInt(types.length)), items: types, formula: { items: out }, open: open.size ? open : undefined };
        }
    }
    const binding = (e: Expr) => e.t === "stmDef" || e.t === "patDef";
    // code n = e: the code with item n replaced by e, written here (see
    // codeList), so code 0 = (x = 10) binds x for the items after it; at known
    // indices only.
    function editCode(rec: Extract<Ty, { k: "list" }>, e: Extract<Expr, { t: "setItem" }>, key: Index | undefined, scope: Scope): Ty | undefined {
        const items = rec.formula!.items;
        const at = (k: Index | undefined) => {
            if (!k || k.terms.size) return undefined;
            const n = Number(k.constant < 0n ? k.constant + BigInt(items.length) : k.constant);
            return n >= 0 && n < items.length ? n : undefined;
        };
        const edits: [number, Expr][] = [];
        if (e.index.t === "list") {
            if (e.value.t !== "list" || e.value.v.length !== e.index.v.length) return undefined;
            for (const [m, slot] of e.index.v.entries()) {
                const n = at(index(slot, scope));
                if (n === undefined) return undefined;
                edits.push([n, e.value.v[m]]);
            }
        } else {
            const n = at(key);
            if (n === undefined) return undefined;
            let expr = e.value;
            while (expr.t === "block" && expr.style === "(" && expr.stmts.length === 1) expr = expr.stmts[0];
            edits.push([n, expr]);
        }
        const changed = new Set<string>(), next = [...items];
        for (const [n, expr] of edits) {
            for (const name of next[n].binds?.keys() ?? []) changed.add(name);
            next[n] = { expr, scope, slot: binding(expr) ? undefined : rec.items?.[n] };
        }
        return codeList(next, changed);
    }
    // Code whose values are needed must name only what is bound: an open
    // list's names are unbound where they are read.
    function closed(t: Ty): void {
        const value = resolve(t);
        if (value.k !== "list" || !value.open) return;
        const [name, at] = value.open.entries().next().value!;
        firstUnbound ??= { ...at, name, hint: unboundHint(name) ?? "bind it in code joined before this: [x = 1] ++ [x + 1]" };
        dynamicBoundaries++;
    }
    // What would bind a name: a retired native's replacement, a module bound
    // to a name (it opens only where that name is a statement), or the standard
    // module defining it.
    function unboundHint(name: string, scope?: Scope): string | undefined {
        const module = standardModule(name), now = RETIRED_NATIVES[name];
        const holder = scope && [...scope].find(([, entry]) => moduleOf(entry.type)?.has(name))?.[0];
        return now ? `write \`${now} x\`` : holder ? `write \`${holder}.${name}\`, or the statement \`${holder}\` to open its names`
            : module ? `add \`import "${module}"\` to use \`${name}\`` : undefined;
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
                const coerce = p.right.p === "schema" || constructor?.k === "type";
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
            case "range": {
                // Compared numerically, as at runtime: in a typed pattern such as
                // (UInt 0) the literal is a value of that type, if it can be one.
                const t = resolve(expected);
                if (t.k === "atom" && t.name !== "Int" && NUMERIC_TYPES.includes(t.name)) {
                    for (const v of p.p === "int" ? [p.v] : [p.lo, p.hi]) {
                        try { castNumeric(t.name, integer(v)); } catch (error) { problem((error as Error).message, e); }
                    }
                    return;
                }
                return unify(expected, atom("Int"), e);
            }
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
                // Headed by a free name (t1 1 t2), the pattern may take a type
                // apart as well as a value of one: its names are types, decided
                // when it runs (t1 1 t2 given Vect 1 Int is Vect, 1, Int).
                const pieces: Expr[] = [];
                let head = p.type;
                for (; head.t === "app"; head = head.f) pieces.unshift(head.a);
                if (head.t === "var" && /^[a-z]/.test(head.name) && !scope.has(head.name)) {
                    for (const piece of [head, ...pieces]) {
                        if (piece.t === "var" && !scope.has(piece.name)) bind({ p: "var", name: piece.name }, { k: "type", value: variable() }, scope, e, bound);
                    }
                    bind(p.value, expected, scope, e, bound);
                    return;
                }
                const t = typeExpr(p.type, scope, bound);
                if (!choosing) options.patternTypes?.set(p.type, t);
                application({ k: "fn", input: t, output: t, coerce: true, pattern: p }, { type: expected }, e);
                bind(p.value, t, scope, e, bound);
                return;
            }
            case "typeBind": {
                const type: Ty = { k: "type", value: expected };
                if (p.name !== "_") bind({ p: "var", name: p.name }, type, scope, e, bound);
                bind(p.value, expected, scope, e, bound);
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
                // An infix pattern's operator names a constructor: list cons, or
                // one a program bound it to (rewritten to that constructor already).
                const op = p.op ?? "::";
                if (p.op || scope.has("::") && builtinOperator(scope.get("::")!.type) !== "::") {
                    problem(`'${op}' is not a constructor, so it cannot take a value apart`, e, `bind it to a two-field constructor, as in \`(${op}) = Cons\``);
                }
                const a = variable(), t = list(a);
                unify(t, expected, e);
                const vector = resolve(expected);
                // A list known to be empty has no head to take.
                if (vector.k === "list" && vector.length && !vector.length.terms.size && vector.length.constant < 1n) {
                    problem(`length mismatch: expected at least 1, got ${vector.length.constant}`, e);
                }
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
                if (!entry && !firstUnbound && options.runtimeNames && !options.runtimeNames.has(p.tag)) {
                    const module = standardModule(p.tag);
                    const near = didYouMean(p.tag, [...scope.keys()].filter(name => /^[A-Z]/.test(name)));
                    firstUnbound = { expr: e, name: p.tag, inPattern: true,
                        hint: module ? `add \`import "${module}"\` to use \`${p.tag}\`` : near ? `did you mean '${near}'?`
                            : `declare a type with \`${p.tag}\` first${p.tag === "Nil" || p.tag === "Cons" ? "; a list's patterns are `[]` and `(x :: xs)`" : ""}` };
                }
                // A bare constructor sharing its type's name is the type there,
                // as a bare type name is: to Money (Float x) = ...
                if (!p.args.length && t.k === "fn" && sharedType(t)) {
                    unify(expected, { k: "type", value: sharedType(t)! }, e);
                    return;
                }
                // A capitalized function that tags its result (Box a = tag Box
                // Box [a]), taken apart: (Box x) binds its fields.
                const made = t.k === "alias" ? resolve(constructed(t, e)) : undefined;
                if (made?.k === "variant" && made.fields) {
                    const count = made.args.length;
                    if (p.args.length !== count) problem(`${p.tag} has ${count} field${count === 1 ? "" : "s"}`, e);
                    unify(made, expected, e);
                    p.args.forEach((x, n) => bind(x, made.args[n] ?? variable(), scope, e, bound));
                    return;
                }
                // Any other's parameters, and a value its type made, are what the
                // run remembers it was written with: (Pairs n a), (Pairs n a xs).
                // Only the run knows them.
                if (t.k === "alias" && (p.args.length === t.params.length || p.args.length === t.params.length + 1)) {
                    p.args.slice(0, t.params.length).forEach(x => bind(x, explicitDynamic, scope, e, bound));
                    if (p.args.length > t.params.length) bind(p.args[t.params.length], expected, scope, e, bound);
                    runtimeChecks++;
                    return;
                }
                // One more pattern than a type's parameters is a value of the type
                // (see typed), wherever the pattern is bound.
                const parameters = typeParameters(t);
                if (parameters && p.args.length === parameters + 1) {
                    const flat = flatTypedPattern(p, () => parameters);
                    if (flat) { bind(flat, expected, scope, e, bound); return; }
                }
                // (Vect n a), a type applied to its parameters, is a type value (as
                // (Option t) is): Vect 1 Int binds a to Int.
                if (t.k === "factory" && p.args.length === 2) {
                    const [size, element] = p.args;
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
                    // A type value's length is read when it runs: a named one is an Int.
                    unify({ k: "type", value: list(item, size.p === "int" ? length : undefined) }, expected, e);
                    return;
                }
                // (Option t), a type applied to exactly its parameters, matches a
                // type value: Option Int binds t to Int.
                if (t.k === "type" && parameters && p.args.length === parameters) {
                    const parts = p.args.map(() => variable()), value = resolve(t.value);
                    unify({ k: "type", value: value.k === "variant" ? { ...value, args: parts } : list(parts[0]) }, expected, e);
                    p.args.forEach((x, n) => bind(x, { k: "type", value: parts[n] }, scope, e, bound));
                    return;
                }
                // Any other count is neither: (Pair x) for Pair a b.
                if (t.k === "type" && parameters && p.args.length) {
                    const value = patternSource(p.args[p.args.length - 1]);
                    problem(`'${p.tag}' in a pattern takes ${parameters} type${parameters === 1 ? "" : "s"}, or ${parameters + 1} patterns for a value`, e,
                        `write (${p.tag} ${"_ ".repeat(parameters)}${value})`);
                }
                if (p.tag === "Type") {
                    const payload: Ty = { k: "type", value: variable() };
                    unify(payload, expected, e);
                    p.args.forEach((x) => bind(x, payload, scope, e, bound));
                    return;
                }
                // A bare type name matches that type itself, as a value: describe Int.
                if (t.k === "type" && !p.args.length && !naturalPattern(p, scope)) {
                    unify(expected, { k: "type", value: t.value }, e);
                    return;
                }
                if (t.k === "type") {
                    const value = t.value.k === "atom" && t.value.name === "List" ? list(variable()) : t.value;
                    unify(value, expected, e);
                    // A numeric constructor pattern binds the untyped payload, as at
                    // runtime: (UInt8 x) binds 5 for UInt8 5, a plain integer. A
                    // literal payload is still a value of the type: (UInt8 300) fails.
                    const payload = value.k === "variant" && value.base ? value.base : value;
                    p.args.forEach((x) => bind(x, x.p === "int" || x.p === "range" ? payload : untypedPayload(payload), scope, e, bound));
                    return;
                }
                if ((t.k === "record" || t.k === "list") && p.args.length === 1) {
                    const schema = typeExpr({ t: "var", name: p.tag }, scope);
                    unify(schema, expected, e);
                    bind(p.args[0], schema, scope, e, bound);
                    return;
                }
                // A constructor pattern takes all its fields: f Some x = ... is the
                // function Some, then x, which no value matches.
                const missing = (ty: Ty): number => { const f = resolve(ty); return f.k === "fn" ? 1 + missing(f.output) : 0; };
                const taking = (count: number) => problem(`'${p.tag}' in a pattern takes ${count} field${count === 1 ? "" : "s"}`, e,
                    `write (${p.tag} ${[...p.args.slice(0, count).map(patternSource), ..."xyzuvw".slice(0, count - p.args.length)].join(" ")})`);
                if (entry && p.args.length > missing(t) && isConstructor(entry)) taking(missing(t));
                let rest: Ty = t;
                for (const arg of p.args) {
                    const f = resolve(rest);
                    if (f.k !== "fn") {
                        bind(arg, unknown(), scope, e, bound);
                        continue;
                    }
                    // A converting payload pattern on a concrete field (UInt8 y
                    // for an Int field) converts that field's value.
                    if (!variables(f.input).size && patternConverts(arg, scope)) {
                        const local = variable();
                        bind(arg, local, scope, e, bound);
                        convert(local, f.input, e, false, new Map(), true);
                    } else bind(arg, f.input, scope, e, bound);
                    rest = f.output;
                }
                if (entry && missing(rest)) taking(p.args.length + missing(rest));
                // Matching a Dynamic value against a constructor checks it at runtime.
                if (isExplicit(resolve(expected))) runtimeChecks++;
                else unify(rest, expected, e);
                return;
            }
        }
    }
    // A value the checker knows (k * 2, 0 - 1, -k) converts now, as a literal
    // does in convert.
    // The expression that gives a record literal's field its value: the last
    // entry for it, unless a later spread (_) may replace it.
    function fieldExpr(e: Expr, key: string): Expr {
        if (e.t !== "record") return e;
        let found: Expr = e;
        for (const [k, x] of e.v) {
            if (k === key) found = x;
            else if (k === "_") found = e;
        }
        return found;
    }
    // Whether x and y unify, tried on copies (nothing is bound or required).
    function fits(x: Ty, y: Ty): boolean {
        const vars = new Map<Ty, Ty>(), pending = requirements, saved = pending.length;
        try { unify(copy(x, vars), copy(y, vars)); return true; }
        catch (error) {
            if (error && typeof error === "object" && "message" in error && "pos" in error) return false;
            throw error;
        } finally { pending.length = saved; }
    }
    // A record literal's known fields, in order: later entries win, a spread
    // (_) contributes its known fields, and a spread of unknown fields may
    // replace any field before it.
    function recordFields(entries: [string, () => Known][]): [string, Known][] {
        const fields = new Map<string, Known>();
        for (const [key, value] of entries) {
            if (key !== "_") { fields.set(key, value()); continue; }
            const spread = demand(value()) ?? {};
            if (!spread.fields) { fields.clear(); continue; }
            for (const [name, field] of spread.fields) fields.set(name, field);
        }
        return [...fields];
    }
    // A pending compound value ([x,-x]) whose parameters are now known: its facts afresh.
    function freshKnown(known: Known): Known {
        if (!known.expr || symbolic(known)) return known;
        const fresh = resolveKnown({ expr: known.expr });
        return { ...known, ...Object.fromEntries(Object.entries(fresh).filter(([, value]) => value !== undefined)) };
    }
    // A known value against the pattern that matches it, part by part: each
    // typed part (Int n) converts its known value, inside variant payloads
    // (any number of fields), list elements and cons cells.
    function castPattern(p: Pattern, known: Known, e: Expr): void {
        known = freshKnown(known);
        switch (p.p) {
            case "as": castPattern(p.left, known, e); castPattern(p.right, known, e); return;
            case "typeBind": castPattern(p.value, known, e); return;
            case "list":
                if (known.items?.length === p.v.length) p.v.forEach((item, n) => castPattern(item, known.items![n], e.t === "list" ? e.v[n] ?? e : e));
                return;
            case "cons":
                if (known.items?.length) {
                    castPattern(p.head, known.items[0], e.t === "list" ? e.v[0] ?? e : e);
                    castPattern(p.tail, { items: known.items.slice(1) }, e);
                }
                return;
            case "constr": {
                if (NUMERIC_TYPES.includes(p.tag) && p.args.length === 1) {
                    const number = knownNumberOf(known);
                    if (number) try { castNumeric(p.tag, number); } catch (error) { problem((error as Error).message, e); }
                    return;
                }
                if (known.tag !== p.tag || !known.payload) return;
                const args = payloadExprs(e, p.args.length);
                p.args.forEach((arg, n) => { if (known.payload![n]) castPattern(arg, known.payload![n], args[n] ?? e); });
                return;
            }
            default: return;
        }
    }
    function knownNumberOf(known: Known): Numeric | undefined {
        return known.number ?? (known.index && !known.index.terms.size ? integer(known.index.constant) : undefined) ??
            (known.float !== undefined ? floating(known.float) : undefined);
    }
    // The field expressions of a constructor applied in e (P2 1 300, or in parentheses).
    function payloadExprs(e: Expr, count: number): Expr[] {
        let call = e;
        while (call.t === "block" && call.style === "(" && call.stmts.length === 1 && call.stmts[0].t !== "stmDef" && call.stmts[0].t !== "patDef") call = call.stmts[0] as Expr;
        const args: Expr[] = [];
        while (call.t === "app") { args.unshift(call.a); call = call.f; }
        return args.length === count ? args : [];
    }
    function castKnown(target: Ty, known: Known, e: Expr): void {
        const t = resolve(target);
        known = freshKnown(known);
        // Choosing a clause ignores elements' values (see asUsed).
        if (choosing && (known.items && t.k === "list" || t.k === "variant")) return;
        // A list's elements, or a list converted to a record schema's fields, in order.
        if (known.items && (t.k === "list" || t.k === "record")) {
            const fields = t.k === "record" ? [...t.fields.values()] : undefined;
            known.items.forEach((item, n) => {
                const part = t.k === "list" ? t.items?.[n] ?? t.element : fields![n];
                if (part) castKnown(part, item, e.t === "list" ? e.v[n] ?? e : e);
            });
            return;
        }
        // A record's fields, by name ([x: 300] for [x: UInt8]).
        if (t.k === "record" && known.fields) {
            for (const [key, value] of known.fields) {
                const type = t.fields.get(key);
                const field = fieldExpr(e, key);
                if (type) castKnown(type, demand(value) ?? value, field);
            }
            return;
        }
        // One payload of a variant (Some 300).
        if (t.k === "variant" && t.args.length === 1 && known.payload?.length === 1) {
            castKnown(t.args[0], known.payload[0], e.t === "app" ? e.a : e);
            return;
        }
        if (t.k !== "atom" || !NUMERIC_TYPES.includes(t.name) || numericLiteral(e)) return;
        const number = known.number ?? (known.index && !known.index.terms.size ? integer(known.index.constant) : undefined) ??
            (known.float !== undefined ? floating(known.float) : undefined);
        if (!number) return;
        try { castNumeric(t.name, number); } catch (error) { problem((error as Error).message, e); }
    }
    // A numeric literal, negated or parenthesized: -1, (2.5).
    function numericLiteral(e: Expr): Numeric | undefined {
        if (e.t === "numeric") return e.v;
        if (e.t === "int") return { kind: "int", v: e.v };
        if (e.t === "float") return { kind: "float", v: e.v };
        if (e.t === "unop" && e.op === "neg") { const n = numericLiteral(e.e); return n && negate(n); }
        if (e.t === "block" && e.style === "(" && e.stmts.length === 1 && e.stmts[0].t !== "stmDef" && e.stmts[0].t !== "patDef") return numericLiteral(e.stmts[0] as Expr);
        return undefined;
    }
    // A list's element or a variant's payload converts as it is used, so choosing
    // a clause decides by its type alone (as the run does), never by a literal it
    // holds (f (List Int xs) given [1,2.5]).
    function asUsed(e: Expr): Expr {
        return choosing ? { t: "placeholder" } : e;
    }
    function convert(
        target: Ty,
        actual: Ty,
        e: Expr,
        explicitFloat = false,
        seen = new Map<Ty, Set<Ty>>(),
        runtimeProjection = false,
        // A typed parameter's own type, which checks identity: (UserId u)
        // takes only a UserId, as at runtime.
        matching = false,
    ): Ty {
        spend(e);
        const t = resolve(target), a = resolve(actual);
        // Anything converts to Dynamic, without deciding its own type.
        if (isExplicit(t)) return target;
        if (isExplicit(a) && (runtimeProjection || explicitFloat)) { runtimeChecks++; return target; }
        // An undecided call takes the overload this type names.
        if (a.k === "union" && a.undecided) {
            const choice = a.choices.find(c => succeeds(() => convert(target, c, e, explicitFloat, new Map(), runtimeProjection)));
            if (!choice) return problem(`no overload makes ${text(t)}`, e);
            return convert(target, choice, e, explicitFloat, seen, runtimeProjection);
        }
        // A value of one of several types converts when each of them does.
        if (a.k === "union") {
            for (const choice of a.choices) convert(target, choice, e, explicitFloat, seen, runtimeProjection);
            return target;
        }
        if (t.k === "atom" && t.name === "Bool" && explicitFloat) return t;
        // Converting a value of its base to a := type makes one, as applying the
        // type (List UserId [1]) or updating a slot does; a typed parameter
        // only matches (see matching).
        if (t.k === "variant" && t.base && a.k !== "variant" && !matching) {
            convert(t.base, a, e, explicitFloat, seen, runtimeProjection);
            return target;
        }
        if (
            t.k === "atom" && a.k === "atom" && NUMERIC_TYPES.includes(t.name) &&
            NUMERIC_TYPES.includes(a.name)
        ) {
            if (t.name === a.name) return target;
            // Literal conversion is decidable; unknown magnitudes retain runtime losslessness checks.
            const literal = numericLiteral(e);
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
            // An element type still to be found (List a) is the elements' type
            // together, as at runtime: Int | String for [1,"x"].
            if (!t.items && resolve(t.element).k === "var" && a.items) { unify(t.element, a.element, e); return target; }
            if (a.items) {
                a.items.forEach((item, n) =>
                    t.preserve?.has(n) ? unify(t.items?.[n] ?? t.element, item, e) : convert(
                        t.items?.[n] ?? t.element,
                        item,
                        asUsed(e.t === "list" ? e.v[n] ?? e : e),
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
                if (!a.fields.has(key)) {
                    // An open record takes the fields it has not seen yet, as in unify.
                    if (a.open) { a.fields.set(key, type); continue; }
                    problem(`missing field '${key}'`, e);
                }
                if (t.preserve?.has(key)) {
                    unify(type, a.fields.get(key)!, e);
                    continue;
                }
                convert(
                    type,
                    a.fields.get(key)!,
                    fieldExpr(e, key),
                    false,
                    seen,
                    runtimeProjection || explicitFloat,
                );
            }
            return target;
        }
        // A variant's payloads convert as its pattern matches them (Some (Float x)).
        if (t.k === "variant" && a.k === "variant" && t.name === a.name && t.args.length === a.args.length && t.args.length) {
            // One payload applied to a value (Some 300, or (Some 300)): check that value.
            let call = e;
            while (call.t === "block" && call.style === "(" && call.stmts.length === 1 && call.stmts[0].t !== "stmDef" && call.stmts[0].t !== "patDef") call = call.stmts[0] as Expr;
            const payload = asUsed(t.args.length === 1 && call.t === "app" ? call.a : e);
            t.args.forEach((arg, n) => convert(arg, a.args[n], payload, false, seen, runtimeProjection || explicitFloat));
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
    // An operator intrinsic applied as a function ((+) is a section, but
    // add = intrinsics.add; add 1 2 applies the intrinsic).
    // !x and -x, written prefix or called (not x, negate x): one typing for
    // both. ! takes any value's truth; an action has none.
    function prefixApplication(op: "not" | "negate", operand: Ty, e: Expr): Ty {
        if (op === "not") {
            if (isIO(resolve(operand))) return problem("an action is not a condition", e, "bind its result first: `x <- action`");
            return atom("Bool");
        }
        if (isExplicit(operand)) { runtimeChecks++; return explicitDynamic; }
        return operation("negate", [operand]);
    }
    // A prelude operator applied to its operands, written infix (a + b) or
    // called ((+) a b, intrinsics.add a b): one typing for both. An operand
    // known to be an Int a Float holds exactly keeps the arithmetic a Float.
    function operatorApplication(op: string, left: Entry, right: Entry, e: Expr): Ty {
        const a = left.type, b = right.type, lossless = [losslessInt(left.index), losslessInt(right.index)];
        // An undecided return is not a value until its monad is named.
        if (op !== "$" && op !== "::" && op !== ">>=" && op !== ">>" && [a, b].some(x => isPending(resolve(x)))) {
            return problem("ambiguous: nothing decides which return", e, "name the type it should have, as in `Option Int (return ...)`");
        }
        // An action is not the value it yields.
        if (op !== "$" && op !== "::" && [a, b].some(x => isIO(resolve(x)))) {
            return problem(`operator '${op}' cannot use an action (${text(isIO(resolve(a)) ? a : b)}) as a value`, e, "bind its result first: `x <- action`");
        }
        if (isExplicit(a) || isExplicit(b)) {
            runtimeChecks++;
            return ["==", "!=", "<", ">", "<=", ">=", "&&", "||"].includes(op) ? atom("Bool") : explicitDynamic;
        }
        if (op === "$") return application(a, right, e);
        if (["==", "!=", "&&", "||"].includes(op)) return atom("Bool");
        if (["<", ">", "<=", ">="].includes(op)) {
            operation("compare", [a, b]);
            return atom("Bool");
        }
        if (op === "::") {
            // ':' adds one element. One that does not fit the tail's
            // elements makes a mixed list, as in a literal
            // ([1,2]:[3,4] is [[1,2],3,4]; [1]:[[3,4]] is [[1],[3,4]]).
            const before = resolve(b);
            if (before.k === "list" && !fits(list(a), before)) {
                return list(union([a, before.element]), before.length ? indexAdd(before.length, constant(1n)) : undefined);
            }
            unify(list(a), b, e);
            const tail = resolve(b);
            return list(a, tail.k === "list" && tail.length ? indexAdd(tail.length, constant(1n)) : undefined);
        }
        if (op === "++") {
            const x = resolve(a), y = resolve(b);
            // Code joins code: the right's items see the left's bindings.
            if (x.k === "list" && y.k === "list" && x.formula && (y.formula || y.items)) {
                const right = y.formula?.items ?? y.items!.map((type): FormulaItem => ({ type }));
                return codeList([...x.formula.items, ...right], new Set(x.formula.items.flatMap(item => [...item.binds?.keys() ?? []])));
            }
            if (x.k === "list" && y.k === "list") {
                // The left's code is not known here (a function made it, as
                // take 1 code does): whether it binds the right's open names
                // is checked when it runs.
                if (y.open) runtimeChecks++;
                return { k: "list", element: union([x.element, y.element]), length: x.length && y.length ? indexAdd(x.length, y.length) : undefined, open: x.open };
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
                return arithmeticResult(op, x, y, lossless);
            }
            if (op === "+" && x.name === "String" && y.name === "String") return atom("String");
            return problem(`operator '${op}' cannot combine ${text(x)} and ${text(y)}`, e);
        }
        if (op !== "*" && op !== "\\" && (x.k === "type" || y.k === "type")) {
            return problem(`operator '${op}' requires values, not a type constructor`, e);
        }
        return operation(op, [a, b], lossless);
    }
    // The record with these fields set: r.f = v, r.[f, g] = [v, w], and
    // r [f: v, g: w], which is the same update. A field it has converts its new
    // value as its old one requires; a new one is added unless a record type
    // made the record. A copy of an open record stays open.
    function assignFields(rec: Extract<Ty, { k: "record" }>, entries: Array<[string, Ty, Expr]>, e: Expr): Ty {
        const fields = new Map(rec.fields);
        for (const [key, incoming, at] of entries) {
            if (!fields.has(key)) newField(rec, key, e);
            fields.set(key, slotValue(fields.get(key), incoming, at));
        }
        return { k: "record", fields, open: rec.open, closed: rec.closed };
    }
    // A field's new value, as its old one requires (the interpreter's
    // assignSlot): holding a type, given a type (it changes; a Type field
    // takes it as its value) or a value converted to it; holding a value,
    // given one of that value's type.
    function slotValue(previous: Ty | undefined, incoming: Ty, at: Expr): Ty {
        const old = previous && resolve(previous);
        if (!old) return incoming;
        if (holdsTypeTy(old)) return holdsTypeTy(resolve(incoming)) ? incoming : convert(old.k === "type" ? old.value : schemaValue(old, at), incoming, at);
        return ["atom", "variant", "fn"].includes(old.k) ? convert(old, incoming, at) : incoming;
    }
    function holdsTypeTy(t: Ty): boolean { return t.k === "type" || describing(t); }
    function typeOfTypes(field: Ty | undefined): boolean {
        const t = field && resolve(field), value = t?.k === "type" ? resolve(t.value) : undefined;
        return value?.k === "atom" && value.name === "Type";
    }
    function application(f: Ty, argument: Entry, e: Expr): Ty {
        spend(e);
        f = resolve(f);
        if (!valueBlind(f)) argument = { ...argument, ...needed(argument) };
        // A Mutable cell applies as its contents (an index into a list cell).
        while (f.k === "mutable") f = resolve(f.value);
        if (f.k === "intrinsic") {
            const args = [...f.args ?? [], argument.type], entries = [...f.entries ?? [], argument];
            if (args.length < (f.arity ?? 1)) return { ...f, args, entries };
            if (PRELUDE_OPERATORS.has(f.name)) return operatorApplication(f.name, entries[0], entries[1], e);
            if (f.name === "not" || f.name === "negate") return prefixApplication(f.name, args[0], e);
            // set is an action whatever it writes: its target and value are
            // checked (a requirement) once their types are known.
            if (f.name === "set") { operation(f.name, args); return io(list(variable(), constant(0n))); }
            // A union of types (Mixed = Int | String).
            if (f.name === "union") {
                const list = resolve(args[0]), items = list.k === "list" ? list.items?.map(resolve) : undefined;
                const types = items?.map(item => item.k === "type" ? item.value : sharedType(item));
                if (!types?.every(t => t)) { runtimeChecks++; return explicitDynamic; }
                return { k: "type", value: union(types as Ty[]) };
            }
            // A tag whose owner or constructor is computed is decided when it runs.
            if (f.name === "tag") { runtimeChecks++; return explicitDynamic; }
            return operation(f.name, args);
        }
        if (f.k === "operation") return deferredCall(f, argument);
        if (f.k === "dynamic") return f.explicit ? explicitDynamic : unknown();
        // A typed parameter (one that converts: Int n, a schema, a contract)
        // given a value that depends on an enclosing function's parameter
        // (h x = g (-x)): convert it at that function's calls, where the
        // value is known, as for an overload.
        // (A Dynamic parameter takes anything: there is nothing to wait for.)
        if (f.k === "fn" && f.coerce && resolve(f.input).k !== "dynamic" && !deciding && !choosing && symbolicArgument(argument) &&
            (waiting(argument.type) || ["list", "record", "variant"].includes(resolve(f.input).k) && waitingWithin(argument.type))) {
            const deferred = evaluatingCall && resolve(evaluatingCall.args[0]) === f ? evaluatingCall : deferredCall(f, argument);
            if (deferred.k === "operation" && e.t !== "placeholder" && !deferred.written) { deferred.written = e; deferred.within = outermost; }
            return deferred;
        }
        if (f.k === "overload") {
            const input = resolve(argument.type);
            if (input.k === "var" || input.k === "operation") return deferredCall(f, argument);
            // A value of a union of known types is one of them: each takes the
            // clause that accepts it, as the runtime dispatches, and every one must.
            if (input.k === "union" && !input.undecided && input.choices.every(choice => !variables(choice).size && resolve(choice).k !== "operation")) {
                return union(input.choices.map(choice => application(f, { ...argument, type: choice }, e)));
            }
            let outputs: Ty[] = [];
            const accepted: { clauses?: ClauseOrder[]; call?: Entry[] }[] = [];
            for (const choice of f.choices) {
                const instance = copy(choice), node = resolve(instance);
                choosing++;
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
                } finally { choosing--; }
            }
            // A complete call: drop choices none of whose clauses can run, because
            // each definitely fails or comes after a clause that definitely matches.
            if (accepted.length && accepted.every(a => a.clauses && a.call)) {
                const ranked = accepted.flatMap(a => a.clauses!.map(c => ({ clause: c, ...rankClause(c, a.call!) })));
                const sure = ranked.filter(r => r.matches);
                const before = (a: typeof ranked[number], b: typeof ranked[number]) =>
                    a.low > b.high || a.low >= b.high && a.clause.index < b.clause.index;
                // Clauses with the same patterns differ only in result type
                // (an undecided overload): neither hides the other.
                const samePatterns = (a: typeof ranked[number], b: typeof ranked[number]) => !!f.undecided && clauseKey("", a.clause) === clauseKey("", b.clause);
                const runs = (r: typeof ranked[number]) => !r.fails && !sure.some(d => d !== r && before(d, r) && !samePatterns(d, r));
                outputs = outputs.filter((_, n) => accepted[n].clauses!.some(c => runs(ranked.find(r => r.clause === c)!)));
                // Still ambiguous, and the arguments depend on an enclosing function's
                // parameters: decide at that function's calls, where they are known.
                if (!deciding && outputs.length > 1 && outputs.some(x => text(x) !== text(outputs[0])) && accepted.some(a => a.call!.some(symbolic))) {
                    return evaluatingCall && resolve(evaluatingCall.args[0]) === f ? evaluatingCall : deferredCall(f, argument);
                }
            }
            if (!outputs.length) return problem(`no overload accepts ${text(argument.type)}`, e);
            if (outputs.length === 1 || outputs.every((x) => text(x) === text(outputs[0]))) return outputs[0];
            if (outputs.every((x) => resolve(x).k === "fn")) return { k: "overload", choices: outputs, undecided: f.undecided, name: f.name };
            if (f.undecided) return { k: "union", choices: outputs, undecided: true, name: f.name };
            return union(outputs);
        }
        if (f.k === "factory") {
            // A length computed as a typed integer (a UInt) is that integer.
            if (!argument.index && argument.number?.kind === "int" && !f.args.length) argument = { ...argument, index: constant(argument.number.v) };
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
            // A length evaluation could not decide (it depends on input, or ran
            // past the evaluation budget) is checked at runtime.
            if (!args[0].index) runtimeChecks++;
            return { k: "type", value: { k: "list", element: element.k === "type" ? element.value : dynamic, length: args[0].index, contracted: true } };
        }
        if (f.k === "alias") {
            const args = [...f.args, argument];
            if (args.length < f.params.length) return { ...f, args };
            return construct(f, args, e);
        }
        if (f.k === "type") {
            // A type chosen at runtime: the value must fit one of its choices,
            // and the result is checked when the run applies the chosen one.
            if (f.chosen) {
                const t = resolve(f.value), choices = t.k === "union" ? t.choices : [t];
                if (!choices.some(choice => succeeds(() => application({ k: "type", value: choice }, { ...argument, type: copy(argument.type) }, e)))) {
                    return problem(`cannot use ${text(argument.type)} where ${choices.map(c => text(c)).join(" or ")} is required`, e);
                }
                runtimeChecks++;
                return explicitDynamic;
            }
            const t = resolve(f.value);
            let a = resolve(argument.type);
            // A list or record of types (Point = [x: Float, y: Float]) given as a
            // type's argument is the type it describes: List Point, Option Point.
            // (Nested ones too: [x: Float, color: [Float, Float]].)
            const describes = a.k !== "type" && describing(a);
            if (describes && (t.k === "atom" && t.name === "List" || t.k === "variant" && t.args.length > (f.applied ?? 0))) {
                a = { k: "type", value: schemaValue(a, e) };
            }
            // List T: the type of lists of T.
            if (t.k === "atom" && t.name === "List" && a.k === "type") return { k: "type", value: list(a.value) };
            // IO T: the type of actions yielding T.
            if (t.k === "atom" && t.name === "IO") {
                if (a.k === "type") return { k: "type", value: io(a.value) };
                if (a.k === "list" && (a.items ?? []).every(x => resolve(x).k === "type")) return { k: "type", value: io(schemaValue(a, e)) };
                if (a.k === "var") return { k: "type", value: io(variable()) };
                return problem("IO is a type constructor: IO [] is the type of an action yielding []", e, "`return x` is the action yielding `x`");
            }
            // IO T action: the action, its result converted to T.
            if (isIO(t)) {
                if (!isIO(a) && !isPending(a) && a.k !== "var") return problem(`${text(t)} expects an action, not ${text(a)}`, e, "`return x` is the action yielding `x`");
                const result = variable();
                unify(io(result), a, e);
                convert((t as Extract<Ty, { k: "variant" }>).args[0], result, e);
                return t;
            }
            // A base type applied to a named value unwraps it, as at runtime:
            // Float (Money 1.2), Int (Money 1.0) as Int 1.0 would.
            if (t.k === "atom" && NAMED_BASES.has(t.name) && a.k === "variant" && a.base) return application(f, { ...argument, type: a.base }, e);
            // Applying a named subtype applies its base, as at runtime: F .1 with
            // F = Float32 rounds like Float32 .1. Another name must be unwrapped.
            if (t.k === "variant" && t.base) {
                const given = resolve(argument.type);
                if (given.k === "variant" && given.base) { if (given.name !== t.name) problem(`${t.name} requires explicit unwrapping of ${given.name}`, e); return t; }
                application({ k: "type", value: t.base }, argument, e);
                return t;
            }
            if (t.k === "var") {
                requirements.push({ k: "operation", op: "construct", args: [f, argument.type] });
                return t;
            }
            // A numeric conversion of an unknown value (such as a parameter, or
            // arithmetic on one) is checked once the value's type is known, not
            // forced to the target.
            // So is a schema's ((List P) x) of a value still to be decided.
            if (t.k === "atom" && NUMERIC_TYPES.includes(t.name) && (a.k === "var" || a.k === "operation")
                || (t.k === "list" || t.k === "record") && a.k === "operation") {
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
            const measured = measuredList(t, argument);
            if (measured) return application(f, measured, e);
            // An indexed family takes a value for an index (Vec 2 Int): it fills
            // the next parameter, which values, not types, decide.
            if (t.k === "variant" && t.indexed && a.k !== "type" && !(a.k === "variant" && a.name === t.name)) {
                const position = f.applied ?? 0;
                if (position < t.args.length) {
                    unify(t.args[position], atom("Index"), e);
                    return { ...f, applied: position + 1, given: new Map([...f.given ?? [], [position, argument]]) };
                }
            }
            // A value of an indexed family whose indices evaluation knows must
            // have the ones written: Vec 3 Int xs for a two-element xs fails.
            if (t.k === "variant" && t.indexed && f.given?.size && argument.tag !== undefined) {
                const indices = knownIndices(t.name, argument);
                const plain = (k: Known | undefined) => { const n = numericOf(k); return n === undefined ? "?" : numberText({ ...n, typeName: undefined } as Numeric); };
                const written = (pick: (n: number) => string) => [t.name, ...t.args.map((_, n) => { const s = pick(n); return /\s/.test(s) && !/^[[(]/.test(s) ? `(${s})` : s; })].join(" ");
                for (const [position, wanted] of f.given) {
                    const want = numericOf(wanted), have = numericOf(indices?.[position]);
                    if (want !== undefined && have !== undefined && !equalNumbers(want, have)) {
                        const typeAt = (n: number) => text(t.args[n]) === "Index" ? undefined : text(t.args[n]);
                        problem(`expected ${written(n => f.given!.has(n) ? plain(f.given!.get(n)) : typeAt(n) ?? "?")}, got ${written(n => indices?.[n] && numericOf(indices[n]) !== undefined ? plain(indices[n]) : typeAt(n) ?? "?")}`, e);
                    }
                }
            }
            // A type argument fills the next of the family's arguments, by
            // position (Vec k a: k, then a), even when the one before is a variable.
            if (t.k === "variant" && a.k === "type" && (f.applied ?? 0) < t.args.length && (f.applied !== undefined || t.args.some((x) => resolve(x).k === "var"))) {
                const position = f.applied ?? t.args.findIndex((x) => resolve(x).k === "var");
                unify(t.args[position], a.value, e);
                return { ...f, applied: position + 1 };
            }
            return convert(f.value, argument.type, e, true);
        }
        if (f.k === "var") {
            // Given a record literal, the unknown value may be a function or a
            // record it updates (model [name: n]): decided once its type is known.
            // (Any other argument keeps a function being defined inferable.)
            if (e.t === "record") return deferredCall(f, argument);
            const result = variable();
            unify(f, fn(argument.type, result), e);
            return result;
        }
        if (f.k === "fn") {
            const selection = f.pattern?.p === "schema" && resolve(f.input).k === "list" ? f.pattern.value : f.pattern;
            const selected = selection ? recordSelection(selection, argument.type, e) : argument.type;
            if (selected !== argument.type) return application({ ...f, pattern: undefined }, { ...argument, type: selected }, e);
            const expected = resolve(f.input), actual = resolve(argument.type);
            const measured = measuredList(expected, argument);
            if (measured) return application(f, measured, e);
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
                    else convert(instantiated.input, argument.type, e, false, new Map(), !!f.coerce, !!f.coerce);
                    return instantiated.output;
                }
            }
            try {
                if (options.strict && !f.coerce) unify(f.input, argument.type, e);
                else convert(f.input, argument.type, e, false, new Map(), !!f.coerce, !!f.coerce);
                if (f.coerce) castKnown(f.input, argument, e);
                if (f.coerce && f.pattern) castPattern(f.pattern, argument, e);
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
            const value: Known = { index: argument.index, size: argument.size, items: argument.items, cell: argument.cell, range: argument.range, mutable: argument.mutable, fn: argument.fn, boolean: argument.boolean, string: argument.string, char: argument.char, float: argument.float, number: argument.number, tag: argument.tag, ref: argument.ref, call: argument.call, expr: argument.expr, payload: argument.payload, fields: argument.fields };
            const known = argument.index || argument.ref || argument.call || argument.expr || [argument.size, argument.items, argument.cell, argument.range, argument.mutable, argument.fn, argument.boolean, argument.string, argument.char, argument.float, argument.number, argument.tag, argument.payload, argument.fields].some(x => x !== undefined);
            const pending = f.binder && known
                ? checks.map(check => copy(check, new Map([...variables(check)].map(t => [t, t])),
                    argument.index ? [f.binder!, argument.index] : undefined, undefined, [f.binder!, value]))
                : checks;
            const output = resolve(f.output);
            if (output.k === "fn") output.checks = [...output.checks ?? [], ...pending];
            else for (const requirement of pending) {
                // A value built from it (Handler (s -> s ++ "!")) keeps it, for wherever it goes.
                // Only a check on what the value's type names can be decided later.
                if (output.k === "variant" && waiting(requirement) && !output.checks?.includes(requirement)) {
                    const named = new Set(output.args.flatMap(arg => [...variables(arg)]));
                    if ([...variables(requirement)].some(v => named.has(v))) output.checks = [...output.checks ?? [], requirement];
                }
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
            // An index not known yet (a lambda's parameter) waits until it is.
            if (a.k === "var" || a.k === "operation") return deferredCall(f, argument);
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
                    if (item.k !== "list" || item.items && item.items.length !== 2) return problem("association lookup requires a list of pairs", e);
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
            // Given fields, a record is updated exactly as by field assignment:
            // a record of values (model [name: n]), or a type given types
            // (Vector3 [x: Int] is Vector3.x = Int). A type given values builds one.
            // Fields given by name, or all of them in order (r [10] is r [x: 10]).
            const given: Array<[string, Ty, Expr]> | undefined = a.k === "record" ? [...a.fields].map(([key, type]) => [key, type, fieldExpr(e, key)])
                : a.k === "list" && a.items?.length === f.fields.size ? [...f.fields.keys()].map((key, n) => [key, a.items![n], e.t === "list" ? e.v[n] ?? e : e])
                : undefined;
            // A record holding a type, given values (not types, unless for a
            // Type field), builds one; any other is updated exactly as by field
            // assignment (model [name: n]; Vector3 [x: Int] is Vector3.x = Int).
            const building = [...f.fields.values()].some(field => holdsTypeTy(resolve(field)))
                && !(given ?? []).some(([key, type]) => holdsTypeTy(resolve(type)) && !typeOfTypes(f.fields.get(key)));
            if (given && !building) return assignFields(f, given, e);
            // A value not known yet (a parameter, Dynamic, a computed one) is
            // converted at runtime; it is the record the schema describes.
            const unknownValue = a.k === "var" || a.k === "operation" || isExplicit(a);
            if (unknownValue && a.k !== "dynamic") requirements.push({ k: "operation", op: "construct", args: [f, argument.type] });
            else if (unknownValue) runtimeChecks++;
            if (a.k === "record" || a.k === "list" || unknownValue) {
                const supplied = a.k === "record" ? a.fields : a.k !== "list" ? new Map<string, Ty>()
                    : new Map(a.items?.length === 0 ? [] : [...f.fields.keys()].map((k, i) => [k, a.items?.[i] ?? a.element]));
                if (a.k === "list" && a.items && a.items.length && a.items.length !== f.fields.size) {
                    problem(`record needs ${f.fields.size} positional values, got ${a.items.length}`, e);
                }
                // Each given field takes its value as by assignment; the others
                // take their defaults (a type's zero value).
                const fields = new Map(f.fields);
                for (const [key, target] of fields) {
                    const t = resolve(target), value = supplied.get(key);
                    fields.set(key, value ? slotValue(t, value, given?.find(([k]) => k === key)?.[2] ?? e) : t.k === "type" ? t.value : t);
                }
                for (const [key, value] of supplied) if (!fields.has(key)) fields.set(key, value);
                // A record schema's value keeps its fields (see newField); an open
                // record's stays open, keeping the fields it has not seen yet.
                return { k: "record", fields, ...describing(f) ? { closed: true } : f.open ? { open: true } : {} };
            }
        }
        // Numeric defaults are only replaceable inside container templates.
        if (f.k === "atom" && NUMERIC_TYPES.includes(f.name)) {
            return problem("cannot apply a number", e, e.t === "unop" && e.op === "neg" ? "to subtract, space the '-' on both sides (x - 1)" : undefined);
        }
        if (f.k === "atom" && ["String", "Char", "Bool"].includes(f.name)) {
            return problem(`cannot apply ${text(f)}`, e);
        }
        // A value known only as some Function (a Function field): any argument,
        // a result of its own (unknown) type.
        // So is a record known only as some Record (a schema a parameter holds),
        // applied as a template at runtime.
        if (f.k === "atom" && (f.name === "Function" || f.name === "Record")) return variable();
        // One of several functions (c ? inc : bang): each must take the argument.
        if (f.k === "union" && !f.undecided) return union(f.choices.map(choice => application(choice, argument, e)));
        return problem(`cannot apply ${text(f)}`, e);
    }
    // A list or record of types (Point = [x: Float, y: Float]) describes a type.
    // The type a constructor sharing its name stands for, as at runtime
    // (Interpreter.sharedType).
    // Applied to a type for each of its type's parameters (Box Int), it is
    // that type applied to them; given values (Box 5), a value.
    function sharedType(t: Ty): Ty | undefined {
        if (t.k === "variant" && t.shared) {
            const args = t.args.map(resolve);
            if (!args.every(a => a.k === "type")) return undefined;
            return { ...t, shared: undefined, args: args.map(a => (a as Extract<Ty, { k: "type" }>).value) };
        }
        if (t.k !== "fn" || !t.shared) return undefined;
        let out = resolve(t.output);
        while (out.k === "fn") out = resolve(out.output);
        return out.k === "variant" ? { ...out, shared: undefined } : out;
    }
    // How many types a constructor sharing its type's name takes where a type
    // is expected: its type's parameters, when its fields are exactly them
    // (Box x = _), so (Box Int x) is a value of Box Int; 0 otherwise.
    function sharedParameters(t: Ty): number {
        if (t.k !== "fn" || !t.shared) return 0;
        const inputs: Ty[] = [];
        let out: Ty = t;
        for (; out.k === "fn"; out = resolve(out.output)) inputs.push(resolve(out.input));
        return out.k === "variant" && out.args.length === inputs.length && out.args.every((a, n) => resolve(a) === inputs[n]) ? inputs.length : 0;
    }
    function describing(x: Ty): boolean {
        return x.k === "type" || !!sharedType(x)
            || x.k === "list" && !!x.items?.length && x.items.every(item => describing(resolve(item)))
            || x.k === "record" && x.fields.size > 0 && [...x.fields.values()].every(field => describing(resolve(field)));
    }
    // A record a record schema made keeps its fields, as at runtime.
    function newField(rec: Extract<Ty, { k: "record" }>, key: string, e: Expr): void {
        if (!rec.closed) return;
        const near = didYouMean(key, [...rec.fields.keys()]);
        problem(`${text(rec)} has no field '${key}'`, e, near ? `did you mean '${near}'?`
            : `a record its type made keeps its fields; copy it to add one: [_: record, ${key}: value]`);
    }
    let inferenceDepth = 0;
    // The type each expression was last inferred with, for facts read right after.
    const inferred = new WeakMap<Expr, Ty>();
    // The builtin operator an entry's type stands for (the prelude binds
    // each operator to its intrinsic), if any.
    function builtinOperator(type: Ty | undefined): string | undefined {
        const t = type && resolve(type);
        return t?.k === "intrinsic" && !t.args?.length && PRELUDE_OPERATORS.has(t.name) ? t.name : undefined;
    }
    // A user's operator application as the call it is: (op l) r.
    // Whether a binop is the builtin operator in this scope: the prelude's,
    // or an overload of it whose clauses do not accept the operands' types.
    function builtinAt(e: Extract<Expr, { t: "binop" }>, scope: Scope): boolean {
        const bound = scope.get(e.op);
        if (builtinOperator(bound?.type) === e.op) return true;
        if (!bound || !PRELUDE_OPERATORS.has(e.op)) return false;
        const l = inferred.get(e.l), r = inferred.get(e.r);
        return !!l && !!r && ![l, r].some(x => ["var", "operation", "dynamic"].includes(resolve(x).k)) && !overloadAccepts(bound.type, l, r);
    }
    const operatorCalls = new WeakMap<Expr, Expr>();
    function operatorCall(e: Extract<Expr, { t: "binop" }>): Expr {
        const cached = operatorCalls.get(e);
        if (cached) return cached;
        const partial: Expr = { t: "app", f: { t: "var", name: e.op }, a: e.l };
        const call: Expr = { t: "app", f: partial, a: e.r };
        const loc = sourceLocations.get(e);
        if (loc) { sourceLocations.set(partial, loc); sourceLocations.set(call, loc); sourceLocations.set((partial as Extract<Expr, { t: "app" }>).f, loc); }
        operatorCalls.set(e, call);
        written.add(call).add((partial as Extract<Expr, { t: "app" }>).f);
        return call;
    }
    // A prelude operator written as a function is typed as it is written
    // infix: (+) a b as a + b, and (+) alone as x, y -> x + y. (The calls
    // operatorCall writes for a program's own operator clauses are not.)
    const written = new WeakSet<Expr>(), asInfix = new WeakMap<Expr, Expr>();
    function infixSpelling(e: Expr, scope: Scope): Expr | undefined {
        const name = (x: Expr) => x.t === "var" && PRELUDE_OPERATORS.has(x.name) && !constructorOperators.has(x.name) && scope.has(x.name) ? x.name : undefined;
        if (written.has(e)) return undefined;
        let infix = asInfix.get(e);
        if (!infix && e.t === "app" && e.f.t === "app" && name(e.f.f)) infix = { t: "binop", op: name(e.f.f)!, l: e.f.a, r: e.a };
        if (!infix && name(e)) {
            const [l, r]: Expr[] = [{ t: "var", name: "$L" }, { t: "var", name: "$R" }];
            infix = { t: "lambda", params: ["$L", "$R"], body: { t: "binop", op: name(e)!, l, r } };
        }
        if (!infix) return undefined;
        const loc = sourceLocations.get(e);
        if (loc && !asInfix.has(e)) sourceLocations.set(infix, loc);
        asInfix.set(e, infix);
        return infix;
    }
    // Whether an operator overload's clauses accept operands of these
    // (known) types, tried on copies.
    // The do-blocks being inferred, innermost last, each with its monad once
    // a statement decides it (IO, a list, or a monadic variant).
    const doBlocks: { monad?: Ty }[] = [];
    // What x <- m binds: m's value in the enclosing do-block's monad (top
    // level and IO blocks: an action's result).
    function boundBy(v: Ty, rhs: Expr): Ty {
        const block = doBlocks[doBlocks.length - 1];
        if (isPending(v)) return (v as Extract<Ty, { k: "variant" }>).args[0];
        if (["var", "operation", "dynamic", "intrinsic"].includes(v.k) || rhs.t === "import" || isLoadCall(rhs)) return runType(v);
        const mixed = (m: Ty) => block?.monad && monadKind(block.monad) !== monadKind(m);
        if (isIO(v)) {
            if (block && mixed(v)) return problem(`<- needs a ${text(block.monad!)} here, not ${text(v)}`, rhs);
            if (block) block.monad ??= v;
            return (v as Extract<Ty, { k: "variant" }>).args[0];
        }
        const held = block ? monadHeld(v) : undefined;
        if (held === undefined) return problem(`<- runs an action, not ${text(v)}`, rhs, "bind a value with `=`");
        if (mixed(v)) return problem(`<- needs a ${text(block!.monad!)} here, not ${text(v)}`, rhs);
        block!.monad ??= v;
        return held ?? variable();
    }
    function monadKind(t: Ty): string {
        const r = resolve(t);
        return r.k === "list" ? "List" : r.k === "variant" ? r.name : r.k;
    }
    // The value a monadic type holds: IO t and Monad t hold t, a list its
    // element, a variant what its >>= instance passes on (null: unknown);
    // undefined for a type that is not monadic.
    function monadHeld(type: Ty): Ty | null | undefined {
        const t = resolve(type);
        if (isIO(t) || isPending(t)) return (t as Extract<Ty, { k: "variant" }>).args[0];
        if (t.k === "list") return t.element;
        if (t.k === "apply") return t.args[0];
        if (t.k === "variant") return boundType(t);
        return undefined;
    }
    // What m >>= f passes to f, from m's >>= instance.
    function boundType(m: Ty): Ty | null {
        const inst = instanceFor(">>=", [m]);
        if (!inst) return null;
        const continuation = resolve(application(copy(inst), { type: m }, { t: "placeholder" }));
        if (continuation.k !== "fn") return null;
        const k = resolve(continuation.input);
        return k.k === "fn" ? k.input : null;
    }
    // A value of a type the program defines, met by one of another type,
    // converts the other through a to instance (Interpreter.promote): with
    // to Money (Float x) = Money x, Money 1.0 + 2.5 adds two Moneys.
    function promotedOperands(op: string, l: Ty, r: Ty, e: Expr): [Ty, Ty] | undefined {
        if (!["+", "-", "*", "/", "%", "^", "<", ">", "<=", ">="].includes(op)) return undefined;
        const a = resolve(l), b = resolve(r);
        const own = (x: Ty) => x.k === "variant" && !x.base ? x : undefined;
        const [x, y] = [own(a), own(b)];
        if (!x && !y || x && y && x.name === y.name) return undefined;
        const to = (value: Ty, target?: Ty): Ty | undefined => {
            if (!target) return undefined;
            const type: Ty = { k: "type", value: target }, instance = instanceFor("to", [type, value]);
            if (!instance || resolve(instance).k === "var") return undefined;
            return application(application(copy(instance), { type }, e), { type: value }, e);
        };
        const left = to(a, y), right = to(b, x);
        if (left && right) return problem(`ambiguous: '${op}' could convert ${x!.name} to ${y!.name} or ${y!.name} to ${x!.name}`, e, `convert one explicitly, as in \`to ${y!.name} x\``);
        if (!left && !right) return undefined;
        return [left ?? a, right ?? b];
    }
    // The newest instance of a method whose clauses accept these arguments
    // (still being inferred: unknown).
    function instanceFor(method: string, args: Ty[]): Ty | undefined {
        const types = (options.instances?.get(method) ?? []) as Ty[];
        for (let n = types.length - 1; n >= 0; n--) {
            const t = resolve(types[n]);
            if (t.k === "var") return t;
            if (acceptsAll(t, args)) return t;
        }
        return undefined;
    }
    function acceptsAll(f: Ty, args: Ty[]): boolean {
        if (args.some(x => ["var", "operation", "dynamic"].includes(resolve(x).k))) return false;
        const vars = new Map<Ty, Ty>(), pending = requirements, saved = pending.length;
        choosing++;
        try {
            let r = copy(f, vars);
            for (const a of args) r = application(r, { type: copy(a, vars) }, { t: "placeholder" });
            return true;
        } catch (error) {
            if (error && typeof error === "object" && "message" in error && "pos" in error) return false;
            throw error;
        } finally { choosing--; pending.length = saved; }
    }
    // A method applied through its instance (a copy of its type).
    function viaInstance(method: string, args: Ty[]): Ty | undefined {
        const inst = instanceFor(method, args);
        if (!inst) return undefined;
        if (resolve(inst).k === "var") return variable();
        let r = copy(inst);
        for (const a of args) r = application(r, { type: a }, { t: "placeholder" });
        return r;
    }
    function overloadAccepts(f: Ty, l: Ty, r: Ty): boolean {
        if ([f, l, r].some(x => ["var", "operation", "dynamic"].includes(resolve(x).k))) return false;
        const vars = new Map<Ty, Ty>(), pending = requirements, saved = pending.length;
        choosing++;
        try {
            const partial = application(copy(f, vars), { type: copy(l, vars) }, { t: "placeholder" });
            application(partial, { type: copy(r, vars) }, { t: "placeholder" });
            return true;
        } catch (error) {
            if (error && typeof error === "object" && "message" in error && "pos" in error) return false;
            throw error;
        } finally { choosing--; pending.length = saved; }
    }
    // A statement whose value is a module (what import or load gives) opens its
    // names into its block, however it gets it (see Interpreter.opens).
    function opensModule(statement: Expr, scope: Scope, t: Ty): void {
        // An action yielding a module opens it when the statement runs it.
        const ran = resolve(t), module = moduleOf(isIO(ran) ? (ran as Extract<Ty, { k: "variant" }>).args[0] : ran);
        if (!module) return;
        for (const [name, entry] of copyTypeScope(module)) scope.set(name, entry);
        const at = sourceLocations.get(statement);
        if (at && !choosing) options.moduleStatements?.add(`${at.file}:${at.start}`);
    }
    // A call whose type is a choice of types, and whose value the checker can
    // compute, has the type of that value: func true is a String when
    // func x = x ? "yes" : false.
    function narrowed(e: Expr, scope: Scope, t: Ty): Ty {
        const r = resolve(t);
        if (r.k !== "union" || r.undecided || e.t !== "app" && e.t !== "pipe") return t;
        const k = demand(budgeted(() => evaluateKnown(e, new Map(), scope, 0), SYMBOLIC_BUDGET));
        const name = !k ? undefined : k.boolean !== undefined ? "Bool" : k.string !== undefined ? "String"
            : k.char !== undefined ? "Char" : k.number ? numericType(k.number)
            : k.index && !k.index.terms.size ? "Int" : undefined;
        return r.choices.find(choice => { const x = resolve(choice); return x.k === "atom" && x.name === name; }) ?? t;
    }
    function infer(e: Expr, scope: Scope, expected?: Ty): Ty {
        spend(e);
        if (++inferenceDepth > 256) {
            inferenceDepth--;
            return problem(
                "type checking depth limit exceeded; cannot establish the type",
                e,
            );
        }
        const previousExpression = activeExpression, previousLocated = locatedExpression;
        activeExpression = e;
        if (sourceLocations.has(e)) locatedExpression = e;
        try {
            const t = narrowed(e, scope, inferExpression(e, scope, expected));
            inferred.set(e, t);
            recordValueType(e, t);
            // A >>= chain or a call in a monad: its value may be undecided at
            // run time (unless c (Err e) >> return x when c holds).
            if (e.t === "binop" || e.t === "app" || e.t === "pipe") {
                const r = resolve(t);
                if (r.k === "list" ? e.t !== "binop" || ["=<<", ">>=", ">>"].includes(e.op) : r.k === "variant" && !isIO(r) && !isPending(r) && !!instanceFor(">>=", [r])) recordMonad(e, monadKind(r));
            }
            return t;
        } finally {
            activeExpression = previousExpression;
            locatedExpression = previousLocated;
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
                const infix = infixSpelling(e, scope);
                if (infix) return infer(infix, scope, expected);
                let entry = scope.get(e.name);
                const declaration = forwardDefinitions.get(e.name);
                if (declaration && entry?.type === forward.get(e.name)) {
                    define(declaration.name, declaration.clauses, rootScope, declaration.clauses[0].body);
                    analyzed.add(declaration);
                    entry = rootScope.get(e.name);
                    if (entry) scope.set(e.name, entry);
                }
                if (!entry && openNames && !options.runtimeNames?.has(e.name)) {
                    if (!openNames.has(e.name)) openNames.set(e.name, { expr: e, name: e.name, within: locatedExpression ?? checkingExpression });
                    return variable();
                }
                if (!entry && !firstUnbound && options.runtimeNames && !options.runtimeNames.has(e.name)) {
                    const near = didYouMean(e.name, [...scope.keys(), ...options.runtimeNames]);
                    firstUnbound = { expr: e, within: locatedExpression ?? checkingExpression, name: e.name,
                        hint: unboundHint(e.name, scope) ?? (near ? `did you mean '${near}'?` : undefined) };
                }
                if (!entry) return unknown();
                const type = instantiate(entry);
                return callees.has(e) && trustsShape(entry) ? type : withoutShapes(type);
            }
            case "placeholder":
                return variable();
            case "import":
                if (!options.imports) return unknown();
                return { k: "record", fields: new ModuleFields(copyTypeScope(options.imports(e.module))) };
            case "list": {
                const code = codeList(e.v.map(expr => ({ expr, scope })));
                for (const [name, at] of (code as Extract<Ty, { k: "list" }>).open ?? []) openNames?.set(name, { ...at, name });
                return code;
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
                if (!e.lo) return { k: "type", value: list(variable()) };
                const start = infer(e.lo, scope), type = resolve(start);
                // A range of a type is the list type, as at runtime: [Int..] is List Int.
                if (describing(type)) {
                    if (e.second || e.hi) return problem(LIST_TYPE_RANGE, e, "write [Int..] for any number of Ints");
                    return { k: "type", value: list(schemaValue(type, e)) };
                }
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
                return functionType(e.params, e.body, scope, undefined, e.guard, alternativeInputs.get(e), alternativeClaims.get(e));
            case "app":
            case "pipe": {
                const infix = infixSpelling(e, scope);
                if (infix) return infer(infix, scope, expected);
                const tagged = e.t === "app" ? taggedType(e, scope) : undefined;
                if (tagged) return tagged;
                if (e.t === "pipe" && builtinOperator(scope.get("$")?.type) !== "$") {
                    const call: Expr = { t: "binop", op: "$", l: e.f, r: e.x };
                    const loc = sourceLocations.get(e);
                    if (loc) sourceLocations.set(call, loc);
                    return infer(call, scope, expected);
                }
                const a = e.t === "app" ? e.a : e.x;
                // isType's first argument is a type: a lambda there is read as one.
                const typeArgument = e.t === "app" && e.f.t === "var" && e.f.name === "isType" && scope.get("isType")?.builtin ? lambdaLiteral(a) : undefined;
                if (typeArgument) {
                    const isType = scope.get("isType")!;
                    lambdaType(typeArgument, scope, new Map());
                    return application(copy(isType.type), { type: variable() }, e);
                }
                // while [condition] action and for [start, condition, step] action:
                // code as written; the action reads the names it binds (as code joined
                // after it does), and the condition is a Bool.
                const loop = e.t === "app" && e.f.t === "app" && e.f.f.t === "var" && ["while", "for"].includes(e.f.f.name) && scope.get(e.f.f.name)?.builtin ? e.f.f.name : undefined;
                if (loop && e.t === "app" && e.f.t === "app") {
                    const shape = loop === "for" ? "[start, condition, step]" : "[condition]";
                    const hint = loop === "for" ? "for [i = 0, i < 10, i = i + 1] { print i }" : "while [n < 10] { ... }";
                    if (e.f.a.t !== "list") return problem(`${loop} takes code as written: ${shape}`, e.f.a, hint);
                    const code = resolve(infer(e.f.a, scope)) as Extract<Ty, { k: "list" }>;
                    const items = code.formula?.items ?? [];
                    if (!items.length || loop === "for" && items.length !== 3) return problem(`${loop} takes code as written: ${shape}`, e.f.a, hint);
                    closed(code);
                    const at = loop === "for" ? 1 : items.length - 1;
                    unify(items[at].type ?? variable(), bool, e.f.a.v[at]);
                    const inner: Scope = new BlockScope(scope);
                    for (const item of loop === "for" ? items.slice(0, 1) : items) for (const [name, entry] of item.binds ?? []) inner.set(name, entry);
                    infer(e.a, inner);
                    return io(list(variable(), constant(0n)));
                }
                callees.add(e.f);
                let callee = infer(e.f, scope), resolved = resolve(callee);
                // A type one of several, chosen by code (elemType flag): evaluate
                // the code to learn which, as the program would.
                if (resolved.k === "type" && resolved.chosen && e.f.t !== "var") {
                    const chosen = peek(() => computed(e.f, scope).type, undefined);
                    if (chosen) { callee = chosen; resolved = resolve(chosen); }
                }
                if (resolved.k === "intrinsic" && resolved.name === "load" && a.t === "string" && options.loads) {
                    return { k: "record", fields: new ModuleFields(options.loads(a.v, scope, e === tailStatement)) };
                }
                if (resolved.k === "intrinsic" && resolved.name === "do" && a.t === "list") {
                    return infer({ t: "block", stmts: a.v, style: "{" }, scope);
                }
                // debug reads its argument unevaluated (unchecked).
                if (resolved.k === "intrinsic" && resolved.name === "debug") return list(variable(), constant(0n));
                if (resolved.k === "intrinsic" && resolved.name === "intrinsics.eval") {
                    infer(a, scope);
                    runtimeChecks++;
                    return explicitDynamic;
                }
                if (resolved.k === "intrinsic" && resolved.name === "use") {
                    const open = (type: Ty): void => {
                        const t = resolve(type);
                        if (t.k === "record") for (const [name, type] of t.fields) scope.set(name, { type, opened: a });
                        else if (t.k === "list" && t.items) t.items.forEach(open);
                        else if (isExplicit(t)) { runtimeChecks++; opaqueUse = true; }
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
                // A match's alternatives meet its scrutinee as a clause's patterns
                // meet its parameters: x :: xs takes a length n list's tail as n - 1.
                const scrutinee = e.f.t === "app" ? matchScrutinees.get(e.f) : undefined;
                if (scrutinee && a.t === "list") {
                    for (const alternative of a.v) if (alternative.t === "patternLambda" && alternative.params.length === 1) alternativeInputs.set(alternative, [patternInput(alternative.params[0], scrutinee)]);
                }
                // A length claim around a match asks it of each alternative.
                const claimed = resolved.k === "type" ? resolve(resolved.value) : undefined;
                if (claimed?.k === "list" && claimed.length) {
                    let inner: Expr = a;
                    while (inner.t === "block" && inner.stmts.length === 1) inner = inner.stmts[0];
                    const alternatives = inner.t === "app" && inner.f.t === "app" && inner.f.f.t === "var" && inner.f.f.name === "match" && inner.a.t === "list" ? inner.a.v : [];
                    for (const alternative of alternatives) if (alternative.t === "patternLambda") alternativeClaims.set(alternative, claimed.length);
                }
                let argumentType = infer(a, scope);
                if (e.f.t === "var" && e.f.name === "match" && scope.get("match")?.builtin) matchScrutinees.set(e, argumentType);
                // A recursive call does not fix the length of a parameter whose
                // pattern leaves it open (go xs = ... go [] ...).
                let head: Expr = e.f, position = 0;
                while (head.t === "app") { head = head.f; position++; }
                const self = head.t === "var" ? scope.get(head.name) : undefined;
                if (self?.selfInputs && position < self.selfInputs.length) {
                    const parameter = resolve(self.selfInputs[position]), argument = resolve(argumentType);
                    // A parameter whose pattern binds its length takes the argument's.
                    if (self.selfOpen?.[position] && parameter.k === "list" && argument.k === "list") argumentType = list(argument.element, parameter.length);
                    else argumentType = withoutOpenLengths(copy(argumentType, new Map([...variables(argumentType)].map(v => [v, v]))), parameter);
                }
                // Nor does a call to a function known only from its uses: a
                // parameter (g [1] and g [1,2,3]) or one read from a parameter's
                // record (p.call).
                else if (head.t === "var" && self?.mono && !self.selfInputs || head.t === "recordAccess" && (() => {
                    const holder = resolve(inferred.get(head.rec) ?? dynamic);
                    return holder.k === "record" && !!holder.open;
                })()) argumentType = withoutLengths(copy(argumentType, new Map([...variables(argumentType)].map(v => [v, v]))), true);
                if (!(head.t === "var" && READS_CODE.has(head.name))) closed(argumentType);
                closed(callee);
                const result = application(callee, { type: argumentType, ...valueEntry(a, scope) }, a);
                if (!callees.has(e)) noClauseMatches(e, scope);
                // A partial application that leaves its call chain is an ordinary function value.
                return callees.has(e) ? result : withoutShapes(result);
            }
            case "setFields": {
                let rec = resolve(infer(e.rec, scope));
                const value = infer(e.value, scope);
                let v = resolve(value);
                if (isExplicit(rec)) { runtimeChecks++; return explicitDynamic; }
                const parents: Array<[Map<string, Ty>, string, boolean | undefined]> = [];
                // A parameter's record is known only from the fields code uses.
                const opened = (t: Ty, key?: string): Ty => {
                    unify(t, { k: "record", fields: new Map(key === undefined ? [] : [[key, variable()]]), open: true }, e);
                    return resolve(t);
                };
                for (const key of e.path ?? []) {
                    if (rec.k === "dynamic") return unknown();
                    if (rec.k === "var") rec = opened(rec, key);
                    if (rec.k !== "record") return problem("nested field assignment requires a record", e);
                    if (!rec.fields.has(key) && rec.open) rec.fields.set(key, variable());
                    const child = rec.fields.get(key);
                    if (!child) return problem(`missing field '${key}'`, e);
                    parents.push([rec.fields, key, rec.open]);
                    rec = resolve(child);
                }
                if (rec.k === "dynamic") return unknown();
                if (rec.k === "list" && rec.items?.length === 0) rec = { k: "record", fields: new Map() };
                if (rec.k === "var") rec = opened(rec);
                if (rec.k !== "record") return problem("field assignment requires a record", e);
                const fields = new Map(rec.fields);
                if (e.entries.length === 1 && e.entries[0] === "_") {
                    const spread = resolve(v.k === "list" ? v.items?.[0] ?? v.element : value);
                    if (spread.k !== "record") return problem("record flattening expects a record", e);
                    for (const key of spread.fields.keys()) if (!fields.has(key)) newField(rec, key, e);
                    let merged: Ty = { k: "record", fields: new Map([...fields, ...spread.fields]), open: rec.open, closed: rec.closed };
                    for (let n = parents.length - 1; n >= 0; n--) {
                        const [parent, key, open] = parents[n];
                        merged = { k: "record", fields: new Map([...parent, [key, merged]]), open };
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
                let result = assignFields(rec, e.entries.map((key, n) => [key, v.k === "list" ? v.items?.[n] ?? v.element : dynamic,
                    e.value.t === "list" ? e.value.v[n] ?? e.value : e.value]), e);
                for (let i = parents.length - 1; i >= 0; i--) {
                    const [parent, key, open] = parents[i];
                    result = { k: "record", fields: new Map([...parent, [key, result]]), open };
                }
                return result;
            }
            case "setItem": {
                const rec = resolve(infer(e.rec, scope)), key = index(e.index, scope);
                const edited = rec.k === "list" && rec.formula ? editCode(rec, e, key, scope) : undefined;
                if (edited) return edited;
                const value = infer(e.value, scope);
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
                        if (incoming.k !== "list") { firstUnknown ??= located(e); dynamicBoundaries++; return rec; }
                        if (keys.items && incoming.items && keys.items.length !== incoming.items.length) problem("index count does not match value count", e);
                        const slots = e.index.t === "list" ? e.index.v : [];
                        slots.forEach((slot, n) => {
                            const k = index(slot, scope);
                            if (k && !k.terms.size && rec.length && !rec.length.terms.size &&
                                (k.constant >= rec.length.constant || k.constant < -rec.length.constant)) problem("list index out of range", slot);
                            convert(rec.element, incoming.items?.[n] ?? incoming.element, e.value.t === "list" ? e.value.v[n] ?? e.value : e.value);
                        });
                        if (!slots.length) { firstUnknown ??= located(e); dynamicBoundaries++; }
                        return rec;
                    }
                    if (
                        key && !key.terms.size && rec.length && !rec.length.terms.size &&
                        (key.constant >= rec.length.constant || key.constant < -rec.length.constant)
                    ) problem("list index out of range", e.index);
                    if (rec.items && key && !key.terms.size) {
                        const n = Number(key.constant < 0n ? key.constant + BigInt(rec.items.length) : key.constant);
                        if (n >= 0 && n < rec.items.length) {
                            const items = [...rec.items];
                            items[n] = slotValue(items[n], value, e.value);
                            return { ...rec, items, element: union(items) };
                        }
                    }
                    // An item of a list built from bindings, at an index known only
                    // at run time, may change the items reading it.
                    if (rec.formula?.items.some(item => item.binds)) { convert(rec.element, value, e.value); return { k: "list", element: unknown(), length: rec.length }; }
                    if (holdsTypeTy(resolve(rec.element))) { runtimeChecks++; return rec; }
                    convert(rec.element, value, e.value);
                    return rec;
                }
                const field = e.index.t === "string" ? e.index.v : e.index.t === "var" ? scope.get(e.index.name)?.string : undefined;
                // v 0 = ["x1",22]: entry n replaced by a [key,value] pair, as v 0 reads it.
                if (rec.k === "record" && field === undefined && key && !key.terms.size) {
                    const entries = [...rec.fields], n = Number(key.constant < 0n ? key.constant + BigInt(entries.length) : key.constant);
                    if (n < 0 || n >= entries.length) return problem(`the record has no entry ${key.constant}`, e.index, `it has ${entries.length}`);
                    let written = e.value;
                    while (written.t === "block" && written.style === "(" && written.stmts.length === 1) written = written.stmts[0];
                    const incoming = resolve(value);
                    const entry: [string, Ty] | undefined = written.t === "list" && written.v.length === 2 && written.v[0].t === "string" && incoming.k === "list"
                        ? [written.v[0].v, incoming.items?.[1] ?? incoming.element] : undefined;
                    if (!entry) {
                        // A pair whose key is known only when it runs is checked then.
                        if (incoming.k !== "record" && !(incoming.k === "list" && incoming.items && incoming.items.length !== 2)) {
                            runtimeChecks++;
                            return { k: "record", fields: new Map(), closed: false };
                        }
                        return problem(`an entry is a [key,value] pair, as reading it gives: ["x1",22], not ${text(incoming)}`, e.value);
                    }
                    const [name, type] = entry, [old, held] = entries[n];
                    if (name !== old && rec.fields.has(name)) return problem(`the record already has a field '${name}'`, e.value);
                    if (name !== old) newField(rec, name, e);
                    entries[n] = [name, name === old ? slotValue(held, type, e.value) : type];
                    return { k: "record", fields: new Map(entries), closed: rec.closed };
                }
                if (rec.k === "record" && field !== undefined) {
                    const fields = new Map(rec.fields), old = fields.get(field);
                    if (!old) newField(rec, field, e);
                    fields.set(field, slotValue(old, value, e.value));
                    return { k: "record", fields, closed: rec.closed };
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
                // (a -> a).(+ 1): a function read as a type converts the value,
                // like [Int].[1].
                const lambda = e.rec.t === "block" && e.rec.stmts.length === 1 ? e.rec.stmts[0] : e.rec;
                if (e.scoped && e.argument && (lambda.t === "lambda" || lambda.t === "patternLambda")) {
                    const t = lambdaType(lambda, scope, new Map());
                    return application({ k: "fn", input: t, output: t, coerce: true }, { type: infer(e.argument, scope) }, e);
                }
                let rec = resolve(infer(e.rec, scope));
                // A Mutable cell's fields are its contents' (as it applies as them).
                while (rec.k === "mutable") rec = resolve(rec.value);
                if (isExplicit(rec)) { runtimeChecks++; return explicitDynamic; }
                if (rec.k === "list") return template(rec, infer(e.argument ?? { t: "var", name: e.field }, scope), e.argument ?? e);
                if (e.scoped && e.argument) {
                    if (rec.k === "dynamic" || rec.k === "var") return unknown();
                    // A function held in a name, read as a type at runtime.
                    if (rec.k === "fn") { runtimeChecks++; infer(e.argument, scope); return unknown(); }
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
                if (isIO(rec)) return problem("an action has no fields", e, "bind its result first: `x <- action; x.field`");
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
                if (known !== undefined) {
                    // Only the taken branch is checked; a return taken still
                    // takes its monad from the other, when that one has a type.
                    const taken = infer(known ? e.then : e.els, scope);
                    if (!isPending(resolve(taken))) return taken;
                    let other: Ty | undefined;
                    if (!succeeds(() => { other = infer(known ? e.els : e.then, scope); })) return taken;
                    return returnIn(e, taken, other!);
                }
                const a = infer(e.then, scope), b = infer(e.els, scope, a);
                if (isPending(resolve(a)) !== isPending(resolve(b))) { unify(a, b, e); return returnIn(e, a, b); }
                // A type chosen by a condition known only when it runs: one of
                // the two, checked against the value at runtime.
                if (resolve(a).k === "type" && resolve(b).k === "type" && text(a) !== text(b)) {
                    runtimeChecks++;
                    return { k: "type", value: union([(resolve(a) as Extract<Ty, { k: "type" }>).value, (resolve(b) as Extract<Ty, { k: "type" }>).value]), chosen: true };
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
                return either(a, b, e);
            }
            case "binop": {
                // Against a type, a lambda written in place is read as one, as
                // at runtime: (a -> b) == typeOf f.
                if (e.op === "==" || e.op === "!=") {
                    const [l, r] = [lambdaLiteral(e.l), lambdaLiteral(e.r)];
                    if (l || r) {
                        const other = l ? infer(e.r, scope) : infer(e.l, scope);
                        const t = resolve(other);
                        if (l && r || t.k === "type" || t.k === "atom" && t.name === "Type") {
                            if (l) lambdaType(l, scope, new Map());
                            if (r) lambdaType(r, scope, new Map());
                            return atom("Bool");
                        }
                    }
                }
                const bound = scope.get(e.op);
                if (!bound) return problem(`unbound operator '${e.op}'`, e);
                let op = builtinOperator(bound.type), operands: [Ty, Ty] | undefined;
                if (op === undefined) {
                    // A user's operator is applied like any function. One that
                    // overloads a prelude operator falls back to its builtin
                    // meaning for operands its clauses do not accept.
                    const call = operatorCall(e);
                    // (::) = Cons rebinds the operator; it does not overload it.
                    if (!PRELUDE_OPERATORS.has(e.op) || constructorOperators.has(e.op)) return infer(call, scope, expected);
                    const l = infer(e.l, scope), r = infer(e.r, scope);
                    // Operands not known yet (a parameter's) choose when they are.
                    if ([l, r].some(x => ["var", "operation"].includes(resolve(x).k))) return operation(`overloaded:${e.op}`, [bound.type, l, r]);
                    if (overloadAccepts(bound.type, l, r)) return infer(call, scope, expected);
                    // An operand converted through a to instance, as at runtime.
                    const promoted = promotedOperands(e.op, l, r, e);
                    if (promoted && overloadAccepts(bound.type, ...promoted)) {
                        return application(application(copy(bound.type), { type: promoted[0] }, e.l), { type: promoted[1] }, e.r);
                    }
                    op = e.op;
                    operands = [l, r];
                }
                // A numeric result constraint disambiguates arithmetic from
                // callable iteration. Do not guess numeric inputs otherwise.
                const resultConstraint = expected && resolve(expected);
                const constrain = (value: Ty): Ty => {
                    if (["+", "-", "*"].includes(op) && resultConstraint?.k === "atom" &&
                        NUMERIC_TYPES.includes(resultConstraint.name) && resolve(value).k === "var") {
                        unify(value, resultConstraint, e);
                    }
                    return value;
                };
                const [a, b] = operands ?? [constrain(infer(e.l, scope)), constrain(infer(e.r, scope))];
                if (op !== "++") { closed(a); closed(b); }
                if (op === "$" && !isExplicit(a) && !isExplicit(b)) return application(a, { type: b, ...valueEntry(e.r, scope) }, e.r);
                return operatorApplication(op, { type: a, index: index(e.l, scope) }, { type: b, index: index(e.r, scope) }, e);
            }
            case "unop": return prefixApplication(e.op === "not" ? "not" : "negate", infer(e.e, scope), e);
            case "block": {
                const child: Scope = new BlockScope(scope);
                let result: Ty = list(dynamic, constant(0n)), action = false;
                const block: { monad?: Ty } = {};
                const discards: Array<[Expr, Ty]> = [];
                doBlocks.push(block);
                try {
                    for (const [n, s] of e.stmts.entries()) {
                        result = infer(s, child);
                        if (s.t !== "patDef" && s.t !== "stmDef") opensModule(s, child, result);
                        // A <- binding, or a discarded statement in a monad, makes the
                        // block a do-block: its last statement is the action (or the
                        // Option, ...) whose result it yields, in the block's monad.
                        // A discarded list is pure ([] is also the unit value) unless
                        // the block is a list block.
                        const discarded = s.t !== "patDef" && s.t !== "stmDef" && n < e.stmts.length - 1 ? resolve(result) : undefined;
                        if (discarded) discards.push([s, discarded]);
                        const monadic = !!discarded && discarded.k === "variant" && !isIO(discarded) && !isPending(discarded) && !!instanceFor(">>=", [discarded]);
                        if (s.t === "patDef" ? s.eager : discarded && (isIO(discarded) || isPending(discarded) || monadic)) action = true;
                        if (discarded && isIO(discarded)) {
                            if (block.monad && !isIO(resolve(block.monad))) problem(`an IO action cannot run in ${withArticle(monadKind(block.monad))} do-block`, s);
                            block.monad ??= discarded;
                        }
                        if (monadic) {
                            if (block.monad && monadKind(block.monad) !== monadKind(discarded)) problem(`${withArticle(monadKind(discarded))} value cannot run in ${withArticle(monadKind(block.monad))} do-block`, s);
                            block.monad ??= discarded;
                        }
                    }
                } finally { doBlocks.pop(); }
                // As in Haskell (do { e; ss } = e >> do { ss }), each statement
                // that binds nothing, but the last, is in the block's monad, in
                // any block: a plain value would be computed and dropped. [] is
                // the unit (what print yields); a module opens names.
                for (const [s, type] of discards) {
                    const fits = (t: Ty): boolean => {
                        const v = resolve(t);
                        if (["var", "operation", "dynamic", "intrinsic"].includes(v.k) || isIO(v) || isPending(v) || moduleOf(v)) return true;
                        // The block picks an overload (undecided); a value is any of its
                        // choices, each one in the block's monad.
                        if (v.k === "union") {
                            if (v.undecided) return v.choices.some(fits);
                            const monads = new Set(v.choices.map(resolve).filter(c => isIO(c) || c.k === "list" || c.k === "variant").map(monadKind));
                            if (block.monad) monads.add(monadKind(block.monad));
                            return monads.size <= 1 && v.choices.every(fits);
                        }
                        if (v.k === "list") return !!block.monad && resolve(block.monad).k === "list" || v.items?.length === 0 || !!v.length && !v.length.terms.size && v.length.constant === 0n;
                        return v.k === "variant" && !!instanceFor(">>=", [v]);
                    };
                    if (fits(type)) continue;
                    const monad = block.monad ? resolve(block.monad) : undefined;
                    const wanted = !monad || isIO(monad) ? "an action" : `${withArticle(monadKind(monad))} value`;
                    problem(`a statement in a do-block must be ${wanted}, not ${text(type)}: its value would be dropped`, s,
                        resolve(type).k === "atom" && text(type) === "Bool" ? "to check a condition here, use `guard c`" : "bind it (`x = ...`), or remove it");
                }
                if (!action) return bindingValue(e.stmts[e.stmts.length - 1], child) ?? result;
                // The block's monad, for the run: a block of returns and guards
                // takes it from here, as types decide in Haskell.
                if (block.monad) recordMonad(e, monadKind(block.monad));
                const last = e.stmts[e.stmts.length - 1];
                if (last.t === "patDef" || last.t === "stmDef") return problem("the last statement of a do-block must be an action, not a binding", last, "end the block with an action, such as `return x`");
                const final = resolve(result), monad = block.monad && resolve(block.monad);
                if (isExplicit(final)) return final;
                const notAction = () => final.k === "variant" && monad && (isIO(final) || !!instanceFor(">>=", [final]))
                    ? problem(`${withArticle(monadKind(final))} value cannot run in ${withArticle(monadKind(monad))} do-block`, last)
                    : problem(`the last statement of a do-block must be an action, not ${text(final)}`, last, "`return x` is the action yielding `x`");
                // A list or variant monad: the last value is one, or return.
                if (monad && !isIO(monad)) {
                    const held = isPending(final) ? (final as Extract<Ty, { k: "variant" }>).args[0] : undefined;
                    if (monad.k === "list") {
                        if (held) return list(held);
                        if (final.k === "list" || final.k === "var") { unify(list(variable()), final, last); return final; }
                        return notAction();
                    }
                    if (held || final.k === "var") return { k: "variant", name: (monad as Extract<Ty, { k: "variant" }>).name, args: (monad as Extract<Ty, { k: "variant" }>).args.map(() => variable()) };
                    if (monadKind(final) === monadKind(monad)) return final;
                    return notAction();
                }
                if (isIO(final)) return final;
                // Undecided (a block of returns): pending until used.
                if (isPending(final)) return monad ? io((final as Extract<Ty, { k: "variant" }>).args[0]) : final;
                if (final.k === "var") { const t = monad ? io(variable()) : pendingTy(variable()); unify(t, final, last); return t; }
                return notAction();
            }
            case "stmDef":
                define(e.name, e.clauses, scope, e);
                return list(dynamic, constant(0n));
            case "patDef": {
                if (e.update && scope.has(e.update.name)) {
                    if (e.update.error) return problem(e.update.error, e);
                    return infer({ t: "patDef", pattern: { p: "var", name: e.update.name }, value: e.update.value }, scope);
                }
                // x <- action binds the action's result.
                let valueType: Ty | undefined;
                const t = inferDefinition(e.pattern.p === "var" ? { name: e.pattern.name, body: e.value } : undefined, !e.eager,
                    () => {
                        const value = valueType = infer(e.value, scope);
                        if (!e.eager) return value;
                        return boundBy(resolve(value), e.value);
                    });
                boundValues.set(e, t);
                // A top-level x <- action knows what the action yields, run statically.
                const ran = e === eagerResult?.statement ? eagerResult.known
                    ?? (valueType && resolve(valueType).k !== "mutable" ? runLocally(e.value, scope) : undefined) : undefined;
                // A pattern its known value can never match (1 = 2, None = Some 1)
                // fails whenever it runs: report it now, as a call no clause matches.
                if (e.pattern.p !== "var" && !e.eager && decidedByShape(e.pattern, scope)) {
                    const entry = { type: t, ...valueEntry(e.value, scope) };
                    if (peek(() => definitelyFails(e.pattern, entry, 0, 0), false)) problem("this pattern can never match its value", e, "a binding's pattern must match the value it is given");
                }
                if (e.pattern.p === "var") {
                    scope.set(e.pattern.name, {
                        type: t,
                        // Each binding is a version of its own: what it is known to
                        // hold stays true, whatever later rebinds the name.
                        index: index(e.value, scope),
                        boolean: boolean(e.value, scope),
                        // An eager binding of a cell (counter <- Mutable 0) keeps the cell.
                        mutable: e.eager && e.value.t !== "setFields" && e.value.t !== "setItem"
                            ? valueEntry(e.value, scope).mutable : undefined,
                        nonGeneric: captured(scope),
                        bound: e.value,
                        // An eager binding's value is fixed where it runs: never re-derived.
                        definition: e.eager ? undefined : e.value,
                        ...ran ? factsOf(ran) : {},
                    });
                } else if (e.pattern.p === "constr" && resolve(scope.get(e.pattern.tag)?.type ?? dynamic).k === "type" ||
                    ["list", "cons", "constr"].includes(e.pattern.p) && patternConverts(e.pattern, scope)) {
                    // A type pattern (Int x = 1, Float y = 1, [UInt8 a,UInt8 b] = ...)
                    // converts its value as a parameter pattern converts an argument.
                    const target = variable();
                    bind(e.pattern, target, scope, e);
                    convert(target, t, e.value, false, new Map(), true);
                    const known = valueEntry(e.value, scope);
                    castKnown(target, known, e.value);
                    castPattern(e.pattern, known, e.value);
                    for (const name of patternNames(e.pattern)) { const entry = scope.get(name); if (entry) entry.bound = e.value; }
                } else {
                    bind(e.pattern, recordSelection(e.pattern, t, e.value), scope, e);
                    for (const name of patternNames(e.pattern)) { const entry = scope.get(name); if (entry) entry.bound = e.value; }
                }
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
        const tag = wholeList(p) ? "List" : p.p === "constr" ? p.tag : "";
        if (!TYPE_NAMES.includes(tag)) return [0, 0];
        const c = category(argument.type);
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
    // The indices a known value of an indexed family has, as the runtime
    // computes them: its fields give names (k from the tail's own indices),
    // and its constructor's result type is evaluated with them.
    const indexedFamilies = new Map<string, { def: Extract<TopLevel, { t: "type" }>["def"]; scope: Scope }>();
    const invariance = options.invariance ?? new Map<string, Set<number>>();
    // A family's parameters named where a value is not simply held: a field's
    // function takes it (Handler (a -> String)), a cell holds it (Mutable a),
    // or another family's such parameter does. (A function's input of an
    // input is held, but is kept apart too: separate is never wrong.)
    function invariantParameters(d: Extract<TopLevel, { t: "type" }>["def"]): Set<number> {
        const parameters = d.parameters ?? [], out = new Set<number>();
        const named = (x: unknown): void => {
            if (!x || typeof x !== "object") return;
            if (Array.isArray(x)) { x.forEach(named); return; }
            const node = x as { t?: string; p?: string; name?: string };
            if ((node.t === "var" || node.p === "var") && node.name && parameters.includes(node.name)) out.add(parameters.indexOf(node.name));
            Object.values(node).forEach(named);
        };
        const held = (e: Expr): void => {
            if (e.t === "lambda") { e.params.forEach(p => named({ t: "var", name: p })); held(e.body); return; }
            if (e.t === "patternLambda") { named(e.params); held(e.body); return; }
            if (e.t === "app") {
                const args: Expr[] = [];
                let head: Expr = e;
                while (head.t === "app") { args.unshift(head.a); head = head.f; }
                const kept = head.t === "var" ? head.name === "Mutable" ? new Set(args.keys()) : invariance.get(head.name) : undefined;
                args.forEach((arg, n) => kept?.has(n) ? named(arg) : held(arg));
                return;
            }
            for (const child of Object.values(e)) {
                for (const x of Array.isArray(child) ? child.flat() : [child]) if (x && typeof x === "object" && "t" in x) held(x as Expr);
            }
        };
        for (const v of d.variants) for (const field of v.fields ?? []) held(field);
        return out;
    }
    // Operators a program bound to a constructor: (::) = Cons.
    const constructorOperators = new Map<string, string>();
    const provenClaims = new Map<string, { params: Pattern[]; body: Expr }[]>();
    function knownIndices(family: string, value: Known, depth = 0): (Known | undefined)[] | undefined {
        const declared = indexedFamilies.get(family);
        const variant = declared?.def.variants.find(v => v.tag === value.tag);
        if (!declared || !variant || depth > 64) return undefined;
        const env = new Map<string, Known>();
        (variant.fields ?? []).forEach((spec, n) => {
            while (spec.t === "block" && spec.stmts.length === 1) spec = spec.stmts[0];
            const args: Expr[] = [];
            let head = spec;
            while (head.t === "app") { args.unshift(head.a); head = head.f; }
            const field = value.payload?.[n];
            if (head.t !== "var" || head.name !== family || !field) return;
            const inner = knownIndices(family, demand(field) ?? {}, depth + 1);
            args.forEach((arg, i) => { if (arg.t === "var" && /^[a-z]/.test(arg.name) && inner?.[i] && !env.has(arg.name)) env.set(arg.name, inner[i]!); });
        });
        if (!variant.result) return (declared.def.parameters ?? []).map(name => env.get(name));
        const args: Expr[] = [];
        let head = variant.result;
        while (head.t === "app") { args.unshift(head.a); head = head.f; }
        return args.map(arg => arg.t === "var" && /^[a-z]/.test(arg.name) && !env.has(arg.name) ? undefined
            : peek(() => budgeted(() => evaluateKnown(arg, env, declared.scope, 0)), undefined));
    }
    // A complete call of a named function none of whose clauses can match what
    // is known of its arguments (first Nil for first (Cons x _) = x) fails
    // whenever it runs: report it now.
    // Whether only a value's shape decides a pattern: literals, constructors,
    // list shapes. A typed pattern (Int n) is left to its conversion.
    function decidedByShape(p: Pattern, scope: Scope): boolean {
        return p.p === "constr" ? (isConstructor(scope.get(p.tag)) || naturalPattern(p, scope)) && p.args.every(q => decidedByShape(q, scope))
            : p.p === "list" ? p.v.every(q => decidedByShape(q, scope)) : p.p === "cons" ? decidedByShape(p.head, scope) && decidedByShape(p.tail, scope)
            : p.p !== "schema" && p.p !== "typeBind" && p.p !== "as";
    }
    function noClauseMatches(e: Expr, scope: Scope): void {
        const args: Expr[] = [];
        let head: Expr = e;
        while (head.t === "app") { args.unshift(head.a); head = head.f; }
        if (head.t !== "var") return;
        // An overloaded prelude operator falls back to its builtin (1 + 1 = 3
        // leaves 1 + 2 to +), so no clause matching is no failure.
        if (PRELUDE_OPERATORS.has(head.name)) return;
        const entry = scope.get(head.name);
        if (!entry || entry.builtin || !trustsShape(entry)) return;
        const summary = summaryAt(entry.type, args.length);
        if (!summary) return;
        const entries = args.map(a => ({ type: inferred.get(a) ?? dynamic, ...needed(valueEntry(a, scope)) }));
        const fails = (c: ClauseOrder) => peek(() => c.params.some((p, n) => decidedByShape(p, scope) && definitelyFails(p, entries[n], 0, 0)), false);
        if (summary.clauses.length && summary.clauses.every(fails)) problem(`no clause of '${head.name}' matches these arguments`, e, "the definition's patterns don't cover this input");
    }
    // A value computed left waiting (over no parameters) is computed when a
    // check depends on it, as computed would have.
    function needed(k: Known): Known {
        if (!k.expr || k.expr.env.length) return k;
        const { e, scope } = k.expr;
        return { ...k, expr: undefined, ...budgeted(() => evaluateKnown(e, new Map(), scope, 0)) };
    }
    // A function of any value with nothing to check on it (print): what the
    // value is cannot change the call's type.
    function valueBlind(f: Ty): boolean {
        return f.k === "fn" && resolve(f.input).k === "var" && !f.binder && !f.coerce && !f.pattern && !f.shape && !f.clauses && !f.checks?.length && !f.selfName && !f.summary;
    }
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
    function isFunction(type: Ty): boolean {
        const t = resolve(type);
        return t.k === "fn" || t.k === "overload" || t.k === "intrinsic";
    }
    function hasFacts(k: Known | undefined): boolean {
        return !!k && Object.values(k).some(v => v !== undefined);
    }
    // Static evaluation is bounded per root (a pending value being decided);
    // recursion deeper than the JavaScript stack (a RangeError) leaves it unknown.
    let budgetDepth = 0;
    let evaluationLimit = EVALUATION_BUDGET;
    function budgeted<T>(f: () => T, limit = EVALUATION_BUDGET): T | undefined {
        const outermost = budgetDepth++ === 0;
        if (outermost) {
            evaluations = 0; evaluationLimit = limit;
            root++; cellRead = reordered = unknownWrite = incomplete = exhausted = false;
        }
        try {
            const result = f();
            // The run's order of cell accesses is known only if nothing was
            // skipped or uncertain, and no access sat in a lazy position.
            if (outermost && cellRead && (unknownWrite || incomplete || reordered)) return undefined;
            return result;
        } catch (error) { if (error instanceof RangeError) return undefined; throw error; } finally { budgetDepth--; }
    }
    // Mutable cells. When no code in the session can write a cell, every cell
    // keeps its first contents. Otherwise a cell's contents are tracked within
    // the root evaluation that created it, in evaluation order. Each lazily
    // evaluated computation (a call argument, a list element, a lazy list's
    // cell) is a region the run may evaluate at another time; within one
    // region the order is the run's. So a cell is trusted while all its
    // accesses share a region, and budgeted discards any value that read a
    // cell when a written cell was accessed across regions, a write hit an
    // unknown target, or evaluation skipped code or an uncertain branch.
    const programMutates = options.mutation ? undefined : mayMutate(program);
    let root = 0, cellRead = false, reordered = false, unknownWrite = false, incomplete = false, exhausted = false;
    let regions: number[] = [], regionCount = 0, cellEvents = 0;
    // Top-level cells: created by a top-level definition, followed through the
    // statements that may write them, executed statically in program order.
    const programCells = new Set<KnownCell>(), lazyTops = new Set<LazyTop>();
    // The values a statement's static run gave its parts (see executeTopLevel).
    const executedParts = new Map<Expr, Known | undefined>();
    const unforced = new Set<Known>();
    let touchedTopLevel = false, opaqueUse = false;
    // The program's last statement, where a load replaces the running file (a tail load).
    const lastStatement = program[program.length - 1];
    const tailStatement = lastStatement?.t === "expr" ? lastStatement.value : undefined;
    function bodiesOf(clauses: { params: Pattern[]; body: Expr }[] | undefined): Expr[] {
        return (clauses ?? []).map(c => c.body);
    }
    // executed: the last executeTopLevel ran its statement statically.
    let executed = false, eagerResult: { statement: TopLevel; known?: Known } | undefined;
    let topLevelDefinition = false, creatingTopLevel = false, executing = false, statementWrote = false, programWrote = false, programValid = true;
    // The program's definitions by name, to tell which code can reach set.
    const programDefinitions = new Map<string, Expr[]>();
    for (const statement of program) if (statement.t === "def") programDefinitions.set(statement.name, bodiesOf(statement.clauses));
    const lazyDefinitions = new Set(program.flatMap(st => st.t === "def" && !st.clauses[0].params.length ? [st.name] : []));
    // What evaluating e may reach through the definitions it names: write a
    // cell (set, load, use); force a top-level value kept as its body
    // (forces); or write through a top-level value that is not (lazy), whose
    // effects run when it is first used rather than where it is named.
    function mayWrite(e: Expr, scope: Scope): { write: boolean; lazy: boolean; forces: boolean } {
        const result = { write: false, lazy: false, forces: false };
        const seen = new Set<Expr>();
        const walk = (x: Expr, through?: string): void => {
            if (seen.has(x)) return;
            seen.add(x);
            const visit = (name: string): void => {
                if (MUTATING_NAMES.has(name)) {
                    result.write = true;
                    if (through && !scope.get(through)?.lazyTop) result.lazy = true;
                    return;
                }
                const opened = scope.get(name)?.opened;
                if (opened) walk(opened, through);
                // A value bound by a pattern holds what its expression gave (a function's body runs when called).
                const bound = scope.get(name)?.bound;
                if (bound) walk(bound, through);
                if (scope.get(name)?.lazyTop) result.forces = true;
                const bodies = programDefinitions.get(name) ?? bodiesOf(scope.get(name)?.clauses);
                for (const body of bodies) walk(body, through ?? (lazyDefinitions.has(name) ? name : undefined));
            };
            mentionedNames(x).forEach(visit);
        };
        walk(e);
        return result;
    }
    // Use a top-level value kept as its body, where the program uses it: an
    // action runs again; a thunk runs once, remembered when a statement's
    // static run first uses it (any other use computes it without keeping it).
    function forceLazyTop(lazy: LazyTop, depth: number): Known | undefined {
        // Its value depends on when it is used: a result using it is not cached.
        cellEvents++;
        if (lazy.invalid) return undefined;
        if (!lazy.action && lazy.forced) return lazy.memo;
        if (topLevelDefinition) { touchedTopLevel = true; return undefined; }
        if (lazy.busy) return undefined;
        lazy.busy = true;
        let value: Known | undefined;
        try { value = evaluateKnown(lazy.body, new Map(), lazy.scope, depth + 1); } finally { lazy.busy = false; }
        if (!lazy.action && executing && !trial) { lazy.forced = true; lazy.memo = value; }
        return value;
    }
    // Run a top-level statement for its effects on top-level cells, before
    // checking it, so later statements see the contents it leaves. Anything
    // uncertain in that run (skipped code, an uncertain branch, a write to an
    // unknown target, accesses out of order) stops following top-level cells.
    function executeTopLevel(e: Expr, scope: Scope): Known | undefined {
        statementWrote = false;
        if (!programCells.size || !programValid || !(programMutates ?? options.mutation!())) return;
        const reach = mayWrite(e, scope);
        // A statement that can reach a value an earlier statement left unforced
        // runs statically too, so the value is forced where the program forces it.
        let reachesPending = false;
        if (pendingValues.size) {
            const holders = pendingHolders();
            if (!holders.cells.size && !holders.lazies.size) pendingValues.clear();
            else {
                const r = reachable(e, scope);
                reachesPending = r.all || [...holders.cells].some(c => r.cells.has(c)) || [...holders.lazies].some(l => r.lazies.has(l));
            }
        }
        if (!reach.write && !reach.forces && !reachesPending) return;
        if (reach.lazy) { forgetReachable(e, scope); return; }
        programWrote = false;
        executedParts.clear();
        unforced.clear();
        executing = true;
        let result: Known | undefined;
        try { result = budgeted(() => demand(runKnown(evaluateKnown(e, new Map(), scope, 0)))); } finally { executing = false; }
        // Uncertainty only affects what the statement can reach. A value the run
        // left unforced matters only if later code can still reach it.
        const persists = unforced.size > 0 && unforcedPersists();
        if (persists) for (const value of unforced) pendingValues.add(value);
        if (incomplete || unknownWrite || reordered) forgetReachable(e, scope);
        statementWrote = programWrote;
        executed = true;
        return result;
    }
    // Stop following the top-level cells and kept values a statement can reach:
    // those its names (and the definitions they name, transitively) refer to,
    // and those held in the values of those names. Anything opaque (a lazy list
    // not yet computed, a deferred value) means all of them.
    function forgetReachable(e: Expr, scope: Scope): void {
        const { cells, lazies, all } = reachable(e, scope);
        if (all) { programValid = false; return; }
        for (const cell of cells) cell.invalid = true;
        for (const lazy of lazies) lazy.invalid = true;
    }
    function reachable(e: Expr, scope: Scope): { cells: Set<KnownCell>; lazies: Set<LazyTop>; all: boolean } {
        const cells = new Set<KnownCell>(), lazies = new Set<LazyTop>();
        let all = false;
        const seenExpr = new Map<Expr, Set<Map<string, Known> | undefined>>(), seenKnown = new Set<Known>();
        const walkKnown = (k: Known | undefined): void => {
            if (!k || seenKnown.has(k) || all) return;
            seenKnown.add(k);
            // A lazy value reaches what it is computed from; without a record of
            // that it is opaque. An integer range holds only numbers.
            if (k.deferred || k.cell && !k.range || k.slot) {
                if (!k.origin) { all = true; return; }
                k.origin.exprs.forEach(x => walkExpr(x, k.origin!.env));
                k.origin.values?.forEach(walkKnown);
            }
            if (k.mutable) { cells.add(k.mutable); walkKnown(k.mutable.value); }
            k.items?.forEach(walkKnown);
            if (k.fn) {
                const env = new Map(k.fn.env);
                env.forEach(walkKnown);
                if ("summary" in k.fn) { k.fn.applied.forEach(walkKnown); bodiesOf(k.fn.summary.clauses).forEach(body => walkExpr(body, env)); }
                else walkExpr(k.fn.e, env);
            }
        };
        const walkName = (name: string): void => {
            const entry = scope.get(name);
            if (entry?.lazyTop) { lazies.add(entry.lazyTop); walkExpr(entry.lazyTop.body); walkKnown(entry.lazyTop.memo); }
            if (entry) walkKnown(entry);
            if (entry?.opened) walkExpr(entry.opened);
            if (entry?.bound) walkExpr(entry.bound);
            for (const body of programDefinitions.get(name) ?? bodiesOf(entry?.clauses)) walkExpr(body);
        };
        const walkExpr = (x: Expr, env?: Map<string, Known>): void => {
            if (all) return;
            const envs = seenExpr.get(x) ?? new Set();
            if (envs.has(env)) return;
            envs.add(env);
            seenExpr.set(x, envs);
            for (const name of mentionedNames(x)) {
                if (env?.has(name)) { walkKnown(env.get(name)); continue; }
                if (name === "load") {
                    // A file loaded by a literal path reaches what its source names.
                    const names = loadedNames(x);
                    if (!names) { all = true; return; }
                    names.forEach(walkName);
                    continue;
                }
                if (MUTATING_NAMES.has(name)) continue;
                // A name a Dynamic use may have opened has no visible origin.
                if ((opaqueUse || options.openedElsewhere?.()) && !scope.has(name)) { all = true; return; }
                walkName(name);
            }
        };
        walkExpr(e);
        return { cells, lazies, all };
    }
    // The names the files x loads mention, when every load in x names its
    // file literally and the session checked that file (and it loads nothing,
    // nor uses use).
    function loadedNames(x: Expr): Set<string> | undefined {
        const names = new Set<string>();
        let loads = 0, literal = 0, ok = true;
        const walk = (node: unknown): void => {
            if (!node || typeof node !== "object") return;
            if (Array.isArray(node)) { node.forEach(walk); return; }
            const n = node as Record<string, unknown>;
            if (n.t === "var" && n.name === "load") loads++;
            if (n.t === "app" && (n.f as Record<string, unknown>)?.t === "var" && (n.f as Record<string, unknown>).name === "load" && (n.a as Record<string, unknown>)?.t === "string") {
                literal++;
                const mentioned = options.loadedNames?.((n.a as { v: string }).v);
                if (!mentioned || ["load", "use"].some(name => mentioned.has(name))) ok = false;
                else mentioned.forEach(name => names.add(name));
            }
            Object.values(n).forEach(value => value && typeof value === "object" && walk(value));
        };
        walk(x);
        return ok && loads === literal ? names : undefined;
    }
    // Values left unforced by earlier statements, still held by top-level
    // cells or kept values; the cells and values holding them.
    const pendingValues = new Set<Known>();
    function pendingHolders(): { cells: Set<KnownCell>; lazies: Set<LazyTop> } {
        const cells = new Set<KnownCell>(), lazies = new Set<LazyTop>();
        for (const cell of programCells) if (holdsPending(cell.value)) cells.add(cell);
        for (const lazy of lazyTops) if (holdsPending(lazy.memo)) lazies.add(lazy);
        return { cells, lazies };
    }
    function holdsPending(k: Known | undefined, seen = new Set<Known>()): boolean {
        if (!k || seen.has(k)) return false;
        seen.add(k);
        if (pendingValues.has(k)) return true;
        if (k.mutable && holdsPending(k.mutable.value, seen)) return true;
        if (k.items?.some(x => holdsPending(x, seen))) return true;
        return !!k.fn && (k.fn.env.some(([, v]) => holdsPending(v, seen)) || "summary" in k.fn && k.fn.applied.some(x => holdsPending(x, seen)));
    }
    // Can a deferred value the run left unforced still be forced later: is it
    // held by a top-level cell or a kept top-level value?
    function unforcedPersists(): boolean {
        const seen = new Set<Known>();
        const holds = (k: Known | undefined): boolean => {
            if (!k || seen.has(k)) return false;
            seen.add(k);
            if (unforced.has(k) || k.cell && !k.range || k.slot) return true;
            if (k.mutable && holds(k.mutable.value)) return true;
            if (k.items?.some(holds)) return true;
            if (k.fn && (k.fn.env.some(([, v]) => holds(v)) || "summary" in k.fn && k.fn.applied.some(holds))) return true;
            return !!k.deferred;
        };
        for (const cell of programCells) if (holds(cell.value)) return true;
        for (const lazy of lazyTops) if (holds(lazy.memo)) return true;
        return false;
    }
    function lazily<T>(f: () => T): T {
        regions.push(++regionCount);
        try { return f(); } finally { regions.pop(); }
    }
    function accessCell(cell: KnownCell, write: boolean): void {
        cellEvents++;
        if (cell.regionRoot !== root) { cell.regionRoot = root; cell.region = undefined; cell.written = cell.mixed = false; }
        const region = regions.length ? regions[regions.length - 1] : 0;
        if (cell.region === undefined) cell.region = region;
        else if (cell.region !== region) cell.mixed = true;
        if (write) cell.written = true;
        if (cell.mixed && cell.written) reordered = true;
    }
    function readMutable(k: Known | undefined): Known | undefined {
        k = demand(k);
        if (!k?.mutable) return k;
        if (!(programMutates ?? options.mutation!())) return k.mutable.value;
        if (trial) throw CELL_TOUCHED;
        // Any access, even one that stays unknown, makes a value uncacheable.
        cellEvents++;
        const cell = k.mutable;
        if (cell.program) {
            // A top-level cell holds its contents as of this statement, unless a
            // lazy definition reads it (its timing is unknown) or the statement
            // itself writes it; while executing, reads follow the usual order.
            if (topLevelDefinition) touchedTopLevel = true;
            if (!programCells.has(cell) || !programValid || cell.invalid || topLevelDefinition || budgetDepth === 0) return undefined;
            cellEvents++;
            if (!executing) return statementWrote ? undefined : cell.value;
            cellRead = true;
            accessCell(cell, false);
            return cell.value;
        }
        if (k.mutable.root !== root || budgetDepth === 0) return undefined;
        cellRead = true;
        accessCell(k.mutable, false);
        return k.mutable.value;
    }
    function writeMutable(target: Known | undefined, value: () => Known | undefined): void {
        if (trial) throw CELL_TOUCHED;
        // A write, applied or not, must run again wherever it is evaluated.
        cellEvents++;
        const cell = target?.mutable;
        if (cell?.program) {
            if (topLevelDefinition) touchedTopLevel = true;
            if (cell.invalid) return;
            if (executing && programValid && programCells.has(cell)) {
                cell.value = value() ?? {};
                accessCell(cell, true);
                programWrote = true;
            } else unknownWrite = true;
            return;
        }
        if (!cell || cell.root !== root || budgetDepth === 0) { unknownWrite = true; return; }
        cell.value = value() ?? {};
        accessCell(cell, true);
    }
    // A value in a lazy position (a list element, a call argument). When cells
    // can change, it is first evaluated in a trial that stops at any cell
    // access: without one its value does not depend on when it is computed.
    // Otherwise it is deferred and computed where the program first needs it
    // (demand), as the run computes it.
    const CELL_TOUCHED = { cellTouched: true };
    let trial = 0;
    function lazyValue(compute: () => Known | undefined, origin?: Origin): Known {
        if (!(programMutates ?? options.mutation!())) return compute() ?? {};
        const flags = [cellRead, reordered, unknownWrite, incomplete] as const;
        trial++;
        try { return compute() ?? {}; }
        catch (error) {
            if (error !== CELL_TOUCHED) throw error;
            [cellRead, reordered, unknownWrite, incomplete] = flags;
        } finally { trial--; }
        // Kept once forced where its value cannot depend on timing (see keeps);
        // one made while a statement runs statically and never forced may still
        // be forced later (unforced).
        let forced = false, result: Known | undefined, busy = false;
        const tracked = executing;
        const pending: Known = { origin, deferred: () => {
            if (forced) return result;
            if (busy) return undefined;
            busy = true;
            const events = cellEvents;
            let value: Known | undefined;
            try { value = compute(); } finally { busy = false; }
            if (keeps(events)) {
                forced = true;
                result = value;
                unforced.delete(pending);
                pendingValues.delete(pending);
            }
            return value;
        } };
        if (tracked) unforced.add(pending);
        return pending;
    }
    // Look without forcing anything that touches a cell (fallback if it would).
    function peek<T>(look: () => T, fallback: T): T {
        if (!(programMutates ?? options.mutation!())) return look();
        const flags = [cellRead, reordered, unknownWrite, incomplete] as const;
        trial++;
        try { return look(); }
        catch (error) {
            if (error !== CELL_TOUCHED) throw error;
            [cellRead, reordered, unknownWrite, incomplete] = flags;
            return fallback;
        } finally { trial--; }
    }
    // A value where the program needs it: arithmetic, conditions, printing,
    // demanding builtins and application force a deferred value.
    function demand(k: Known | undefined): Known | undefined {
        while (k?.deferred) k = k.deferred();
        return k;
    }
    // Run an action statically outside the program's statement order: cells
    // it creates are its own, not top-level cells.
    function runLocally(e: Expr, scope: Scope): Known | undefined {
        const creating = creatingTopLevel;
        creatingTopLevel = false;
        try { return budgeted(() => demand(runKnown(evaluateKnown(e, new Map(), scope, 0)))); }
        finally { creatingTopLevel = creating; }
    }
    // The facts a binding keeps from a known value.
    function factsOf(k: Known): Partial<Entry> {
        const d = demand(k);
        if (!d || d.action) return {};
        return { size: d.size, items: d.items, cell: d.cell, range: d.range, boolean: d.boolean, string: d.string, char: d.char, float: d.float, number: d.number, tag: d.tag, payload: d.payload, fields: d.fields,
            ...d.index && !d.index.terms.size ? { index: d.index } : {} };
    }
    // Run an action as a statement or <- runs it: its result; other values are themselves.
    function runKnown(k: Known | undefined): Known | undefined {
        const d = demand(k);
        return d?.action ? d.action() : k;
    }
    // A computation's result, and whether the budget or the depth cut it short
    // (then it is no value to keep: a later evaluation may finish it).
    function finishing<T>(compute: () => T): [T, boolean] {
        const outer = exhausted;
        exhausted = false;
        try { const result = compute(); return [result, exhausted]; } finally { exhausted ||= outer; }
    }
    function spendEvaluation(depth: number): boolean {
        if (depth <= EVALUATION_DEPTH && ++evaluations <= evaluationLimit) return true;
        incomplete = exhausted = true;
        return false;
    }
    // Apply a known function value to known arguments, as the runtime does:
    // too few arguments give a function value, extra ones apply its result.
    let applications = 0;
    function applyKnown(f: KnownFunction, args: Known[], depth: number): Known | undefined {
        if (!spendEvaluation(depth)) return undefined;
        if ("summary" in f) {
            const all = [...f.applied, ...args], arity = f.summary.clauses[0].params.length;
            if (all.length < arity) return { fn: { ...f, applied: all } };
            const result = evaluateCall(f.summary, all.slice(0, arity), depth, new Map(f.env));
            if (all.length === arity) return result;
            return result?.fn && applyKnown(result.fn, all.slice(arity), depth + 1);
        }
        const env = new Map(f.env), names = args.map(() => `$arg${applications++}`);
        names.forEach((name, n) => env.set(name, args[n]));
        const e = names.reduce<Expr>((g, name) => ({ t: "app", f: g, a: { t: "var", name } }), f.e);
        return evaluateKnown(e, env, f.scope, depth + 1);
    }
    // A list whose elements are all known.
    function known(items: Known[]): Known {
        return { size: BigInt(items.length), items };
    }
    // A lazy list: its first cell (head and tail, null when empty, undefined
    // when unknown) is computed once, on demand, as the runtime's cell() does.
    function lazyList(compute: () => Cell, origin?: Origin): Known {
        let done = false, cell: Cell;
        return { origin, cell: () => {
            if (done) return cell;
            const events = cellEvents;
            const [result, cut] = finishing(() => budgeted(compute));
            if (keeps(events) && !cut) { done = true; cell = result; }
            return result;
        } };
    }
    // A lazily computed value is kept when computing it touched no cell, or
    // when a statement's static run computed it (at the run's moment); checking
    // otherwise recomputes it, as it may be forced later, at another moment.
    function keeps(events: number): boolean {
        return cellEvents === events || executing && !trial;
    }
    // The first cell of a known list.
    function cellOf(k: Known | undefined): Cell {
        if (!k) return undefined;
        if (k.cell) return k.cell();
        if (k.items) return k.items.length ? { head: k.items[0], tail: known(k.items.slice(1)) } : null;
        if (k.size !== undefined) return k.size > 0n ? { head: {}, tail: { size: k.size - 1n } } : null;
        return undefined;
    }
    // Element n of a known list: null past its end, {} when it exists but its
    // value is unknown, undefined when even that is unknown. Walks cells
    // iteratively, so long lists need no deep recursion.
    function element(k: Known | undefined, n: number): Known | null | undefined {
        let current = k;
        for (let i = 0; ; i++) {
            if (!current) return undefined;
            if (current.items) return n - i < current.items.length ? current.items[n - i] : null;
            if (current.range) return rangeElement(current.range, BigInt(n - i));
            if (!current.cell && current.size !== undefined) return BigInt(n - i) < current.size ? {} : null;
            const cell = cellOf(current);
            if (!cell) return cell;
            if (i === n) return cell.head;
            current = cell.tail;
        }
    }
    // Every element of a finite known list (bounded).
    function elementsOf(k: Known | undefined): Known[] | undefined {
        if (!k) return undefined;
        if (k.items) return k.items;
        if (k.range?.hi === null) return undefined;
        if (!k.cell && k.size === undefined) return undefined;
        // Each element walked spends from the work budget.
        return budgeted(() => {
            const items: Known[] = [];
            let current: Known | undefined = k;
            while (spendEvaluation(0)) {
                if (current?.items) return [...items, ...current.items];
                const cell = cellOf(current);
                if (cell === null) return items;
                if (cell === undefined) return undefined;
                items.push(cell.head);
                current = cell.tail;
            }
            return undefined;
        });
    }
    // Does a known list have exactly n elements? Walks at most n + 1 cells.
    function hasLength(k: Known, n: number): boolean {
        return budgeted(() => {
            if (k.range || k.size !== undefined || k.items) return knownLength(k) === BigInt(n);
            let current: Known = k;
            for (let i = 0; i < n; i++) {
                if (!spendEvaluation(0)) return false;
                const cell = cellOf(current);
                if (!cell) return false;
                current = cell.tail;
            }
            return cellOf(current) === null;
        }) ?? false;
    }
    // The length of a finite known list.
    // A list argument whose type has no length, where one is required, given
    // the length its value has when evaluation knows it (toList 3 for a
    // recursive toList): undefined when nothing changes.
    function measuredList(required: Ty, argument: Entry): Entry | undefined {
        const t = resolve(required), a = resolve(argument.type);
        if (t.k !== "list" || !t.length && !t.items || a.k !== "list" || a.length || a.items) return undefined;
        const n = peek(() => knownLength(argument), undefined);
        return n === undefined ? undefined : { ...argument, type: { ...a, length: constant(n) } };
    }
    function knownLength(k: Known | undefined): bigint | undefined {
        if (k?.size !== undefined || k?.range) return k.size;
        const items = elementsOf(k);
        return items && BigInt(items.length);
    }
    function isList(k: Known | undefined): boolean {
        return !!k && (!!k.items || !!k.cell || !!k.range || k.size !== undefined);
    }
    // The list after its first count elements.
    function dropKnown(k: Known, count: number): Known {
        if (k.items) return known(k.items.slice(count));
        let current: Known = k;
        for (let n = 0; n < count; n++) {
            if (current.items) return known(current.items.slice(count - n));
            if (current.range) return rangeKnown(current.range.lo + BigInt(count - n) * current.range.step, current.range.step, current.range.hi) ?? {};
            if (!spendEvaluation(0)) return {};
            const cell = cellOf(current);
            if (cell === null) return known([]);
            if (cell === undefined) return {};
            current = cell.tail;
        }
        return current;
    }
    // A list built cell by cell from a step: each cell's head, and the state
    // its tail continues from (null ends the list, undefined is unknown).
    function unfold<S>(state: S, step: (state: S) => { head: Known; next: S } | null | undefined, origin?: Origin): Known {
        return lazyList(() => {
            const result = step(state);
            return result && { head: result.head, tail: unfold(result.next, step, origin) };
        }, origin);
    }
    // An integer range, as the runtime enumerates it (hi null: endless).
    function rangeKnown(lo: bigint, step: bigint, hi: bigint | null): Known | undefined {
        if (step === 0n) return undefined;
        const range = { lo, step, hi };
        const size = hi === null ? undefined : (step > 0n ? hi >= lo : hi <= lo) ? (hi - lo) / step + 1n : 0n;
        if (size !== undefined && size <= 64n) return known(Array.from({ length: Number(size) }, (_, n) => ({ index: constant(lo + BigInt(n) * step) })));
        return { range, size, cell: () => rangeElement(range, 0n) && { head: { index: constant(lo) }, tail: rangeKnown(lo + step, step, hi) ?? {} } };
    }
    function rangeElement(range: KnownRange, n: bigint): Known | null {
        const v = range.lo + n * range.step;
        if (range.hi !== null && (range.step > 0n ? v > range.hi : v < range.hi)) return null;
        return { index: constant(v) };
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
        // A record literal's fields, a spread (_: other) contributing its own;
        // over parameters, decided again at each call (see computed).
        if (e.t === "record") return computed(e, scope);
        if (e.t === "float") return { float: e.v };
        if (e.t === "unop" && e.op === "neg" && e.e.t === "float") return { float: -e.e.v };
        if (e.t === "block" && e.stmts.length === 1) return literalOf(e.stmts[0], scope);
        if (e.t === "block") return computed(e, scope);
        if (e.t === "var") {
            const entry = scope.get(e.name);
            if (!entry) return {};
            if (/^[A-Z]/.test(e.name) && resolve(entry.type).k === "variant") return { tag: e.name };
            if (!entry.mono && isFunction(entry.type)) return { fn: { e, env: [], scope } };
            return { size: entry.size, items: entry.items, cell: entry.cell, range: entry.range, mutable: entry.mutable, char: entry.char, float: entry.float, number: entry.number, tag: entry.tag, payload: entry.payload, fields: entry.fields };
        }
        if (e.t === "app") {
            const args: Expr[] = [];
            let head: Expr = e;
            while (head.t === "app") { args.unshift(head.a); head = head.f; }
            if (head.t !== "var") return {};
            const entry = scope.get(head.name);
            if ((NUMERIC_TYPES.includes(head.name) || EVALUATED_NATIVES.has(head.name) || ["Bool", "Mutable", "to", "from", "S"].includes(head.name)) && entry?.builtin) return computed(e, scope);
            if (/^[A-Z]/.test(head.name)) {
                // A constructor applied to all its fields.
                let t = resolve(entry?.type ?? dynamic);
                for (let n = 0; n < args.length && t.k === "fn"; n++) t = resolve(t.output);
                return t.k === "variant" ? { tag: head.name, ...args.length ? { payload: args.map(a => valueEntry(a, scope)) } : {} } : {};
            }
            if (!trustsShape(entry)) return {};
            const summary = summaryAt(entry!.type, args.length);
            // A builtin with a result shape (map keeps its list's length).
            if (!summary) return shapeAt(entry!.type, args.length) ? computed(e, scope) : {};
            const values = args.map(a => valueEntry(a, scope));
            // Over no parameters, evaluate (and cache) the whole application.
            if (!values.some(symbolic)) return computed(e, scope);
            return resolveKnown({ call: { summary, args: values } });
        }
        if (["binop", "unop", "ternary", "numeric", "list", "range", "computedRange", "lambda"].includes(e.t)) return computed(e, scope);
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
            else if (x.t === "record") x.v.forEach(([, y]) => collect(y));
            else if (x.t === "computedRange") [x.lo, x.second, x.hi].forEach(y => y && collect(y));
            else if (x.t === "lambda") collect(x.body);
            else if (x.t === "block") for (const st of x.stmts) {
                if (st.t === "patDef") collect(st.value);
                else if (st.t === "stmDef") st.clauses.forEach(c => collect(c.body));
                else collect(st);
            }
        };
        collect(e);
        // Over parameters, the value is decided again at each call; evaluating it
        // now (with the parameters unknown) rarely tells more, so spend little.
        // Over none, a quick value is known now; a longer one waits until a check
        // needs it (see needed), so code that only passes it on (print (fib 24))
        // does not compute it before the run does.
        const quick = !names.size && !budgetDepth;
        const facts = budgeted(() => evaluateKnown(e, new Map(), scope, 0), names.size ? SYMBOLIC_BUDGET : quick ? QUICK_BUDGET : EVALUATION_BUDGET);
        if (!names.size) return quick && exhausted ? { expr: { e, scope, env: [] } } : facts ?? {};
        // Function values and lazy lists over parameters are only known at their calls.
        return { ...facts, fn: undefined, cell: undefined, expr: { e, scope, env: [...names].map(n => [n, valueEntry({ t: "var", name: n }, scope)]) } };
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
        const facts = budgeted(() => known.call
            ? evaluateCall(known.call.summary, known.call.args.map(resolveKnown), 0)
            : evaluateKnown(known.expr!.e, new Map(known.expr!.env.map(([n, v]) => [n, resolveKnown(v)])), known.expr!.scope, 0),
            symbolic(known) ? SYMBOLIC_BUDGET : EVALUATION_BUDGET);
        const result: Known = { ...known };
        for (const key of ["index", "size", "items", "cell", "range", "mutable", "fn", "boolean", "string", "char", "float", "number", "tag", "payload", "fields"] as const) {
            if (result[key] === undefined && facts?.[key] !== undefined) (result as Record<string, unknown>)[key] = facts[key];
        }
        return result;
    }
    // Evaluate a call statically: rank its clauses as the runtime would, and
    // meet the results of every clause that might run. Bounded in depth and work.
    // base holds the bindings a local function closes over.
    let evaluations = 0;
    function evaluateCall(summary: Summary, args: Known[], depth: number, base = new Map<string, Known>()): Known | undefined {
        if (!spendEvaluation(depth)) return undefined;
        // Matching a pattern that inspects an argument forces it, as at runtime.
        const inspects = (p: Pattern) => p.p !== "var" && p.p !== "wildcard";
        args = args.map((k, i) => summary.clauses.some(c => c.params[i] && inspects(c.params[i])) ? demand(k) ?? {} : k);
        const entries: Entry[] = args.map(k => ({ type: knownType(k), ...k }));
        // Ranking looks at every clause; the run forces only what the clause it
        // tries inspects, so ranking does not force anything that touches a cell.
        const ranked = summary.clauses.map(c => ({ clause: c, ...peek(() => rankClause(c, entries), { low: -1000, high: Infinity, matches: false, fails: false }) }));
        const sure = ranked.filter(r => r.matches);
        const before = (a: typeof ranked[number], b: typeof ranked[number]) =>
            a.low > b.high || a.low >= b.high && a.clause.index < b.clause.index;
        const candidates = ranked.filter(r => !r.fails && !sure.some(d => d !== r && before(d, r)));
        if (candidates.length !== 1) incomplete = true;
        if (!candidates.length) return undefined;
        let result: Known | undefined;
        for (const [n, { clause }] of candidates.entries()) {
            // Pattern-bound names shadow outer variables; refutable (repeated) names stay unknown.
            const env = new Map(base);
            clause.params.forEach((p, i) => bindKnown(p, args[i], env, clause.refutable));
            const value = evaluateKnown(clause.body, env, summary.scope, depth + 1);
            result = n === 0 ? value : meetValues(result, value);
            if (!result || candidates.length > 1 && !hasFacts(result)) return undefined;
        }
        return result;
    }
    // Bind what a pattern takes from a known value: plain names, list elements,
    // a cons cell's head and tail, and a typed pattern's (converted) payload.
    function bindKnown(p: Pattern, value: Known, env: Map<string, Known>, refutable: Set<string>): void {
        for (const name of patternNames(p)) env.set(name, {});
        const plain = (q: Pattern): q is Extract<Pattern, { p: "var" }> => q.p === "var" && !refutable.has(q.name);
        if (plain(p)) env.set(p.name, value);
        else if (p.p === "cons") {
            const first = element(value, 0);
            if (first) {
                bindKnown(p.head, first, env, refutable);
                bindKnown(p.tail, dropKnown(value, 1), env, refutable);
            }
        } else if (p.p === "list") {
            p.v.forEach((q, n) => { const item = element(value, n); if (item) bindKnown(q, item, env, refutable); });
        } else if (p.p === "constr" && value.tag === p.tag && value.payload?.length === p.args.length) {
            // A constructor's fields, as the value was built (rest in Cons x rest).
            p.args.forEach((q, n) => bindKnown(q, demand(value.payload![n]) ?? {}, env, refutable));
        } else if (p.p === "constr" && p.tag === "S" && p.args.length === 1) {
            const n = naturalArgument(p, value);
            if (n !== undefined && n > 0n) bindKnown(p.args[0], { number: { kind: "int", v: n - 1n, typeName: "UInt" } }, env, refutable);
        } else if (wholeList(p)) {
            bindKnown(p.value, value, env, refutable);
        } else if (p.p === "constr" && TYPE_NAMES.includes(p.tag) && p.args.length === 1 && plain(p.args[0])) {
            if (!NUMERIC_TYPES.includes(p.tag)) { env.set(p.args[0].name, value); return; }
            const n = numericOf(value);
            if (n) try { env.set(p.args[0].name, knownNumber(castNumeric(p.tag, n)) ?? {}); } catch { /* no match */ }
        }
    }
    // The runtime type a known value certainly has, for ranking typed clauses.
    function knownType(k: Known): Ty {
        if (k.number?.typeName) return atom(k.number.typeName);
        if (k.float !== undefined) return atom("Float");
        if (k.index && !k.index.terms.size) return atom("Int");
        if (k.boolean !== undefined) return atom("Bool");
        if (k.string !== undefined) return atom("String");
        if (k.char !== undefined) return atom("Char");
        if (isList(k)) return list(dynamic);
        return dynamic;
    }
    // Whether two known values are equal, as the runtime compares them.
    function equalKnown(a: Known | undefined, b: Known | undefined): boolean | undefined {
        a = readMutable(a); b = readMutable(b);
        if (!a || !b) return undefined;
        const x = numericOf(a), y = numericOf(b);
        if (x !== undefined && y !== undefined) {
            try { return equalNumbers(x, y); } catch { return undefined; }
        }
        for (const key of ["string", "char", "boolean"] as const) {
            if (a[key] !== undefined && b[key] !== undefined) return a[key] === b[key];
        }
        // Distinct nullary constructors differ; equal tags with fields may not be equal.
        if (a.tag !== undefined && b.tag !== undefined && a.tag !== b.tag) return false;
        if (!isList(a) || !isList(b) || a.string !== undefined || b.string !== undefined) return undefined;
        if (a.items && b.items) {
            for (let n = 0; n < Math.min(a.items.length, b.items.length); n++) {
                const same = equalKnown(a.items[n], b.items[n]);
                if (same !== true) return same;
            }
            return a.items.length === b.items.length;
        }
        // Cell by cell, comparing heads, and stopping at the first difference.
        let left: Known | undefined = a, right: Known | undefined = b;
        while (spendEvaluation(0)) {
            const x = cellOf(left), y = cellOf(right);
            if (x === undefined || y === undefined) return undefined;
            if (x === null || y === null) return x === y;
            const same = equalKnown(x.head, y.head);
            if (same !== true) return same;
            left = x.tail;
            right = y.tail;
        }
        return undefined;
    }
    // A known value as toString renders it (primitives and lists of them).
    function renderKnown(k: Known | undefined): string | undefined {
        k = readMutable(k);
        if (!k) return undefined;
        // An action renders as its type (IO []), when that is known.
        const act = demand(k);
        if (act?.action) return act.actionResult === undefined ? undefined : `IO ${act.actionResult}`;
        const n = numericOf(k);
        if (n !== undefined) return valueToString(n as Value);
        if (k.string !== undefined) return valueToString(mkStr(k.string));
        if (k.char !== undefined) return valueToString({ kind: "char", v: k.char });
        if (k.boolean !== undefined) return String(k.boolean);
        if (!isList(k)) return undefined;
        if (k.items) {
            const shown: string[] = [];
            for (const item of k.items) {
                const part = renderKnown(item);
                if (part === undefined) return undefined;
                shown.push(part);
            }
            return `[${itemsText(shown)}]`;
        }
        // Cell by cell, rendering each element as it is reached.
        const parts: string[] = [];
        for (let rest: Known | undefined = k; spendEvaluation(0);) {
            const cell = cellOf(rest);
            if (cell === undefined) return undefined;
            if (cell === null) return `[${itemsText(parts)}]`;
            const part = renderKnown(cell.head);
            if (part === undefined) return undefined;
            parts.push(part);
            rest = cell.tail;
        }
        return undefined;
    }
    // Numbers use the runtime's own arithmetic and comparison (numbers.ts,
    // type-system.ts); an operation the runtime would reject gives no value.
    function attempt(f: () => Numeric | boolean): Known | undefined {
        try { return knownNumber(f()); } catch { return undefined; }
    }
    // Truthiness as the runtime defines it, where the value decides it.
    function truth(k: Known | undefined): boolean | undefined {
        k = readMutable(k);
        if (!k) return undefined;
        if (k.boolean !== undefined) return k.boolean;
        const n = numericOf(k);
        if (n !== undefined) {
            const real = (x: Numeric): boolean => x.kind === "complex" ? real(x.re) || real(x.im) : x.kind === "float" ? x.v !== 0 && !Number.isNaN(x.v) : !equalNumbers(x, integer(0n));
            return real(n);
        }
        if (k.string !== undefined) return k.string.length > 0;
        if (isList(k)) {
            const first = element(k, 0);
            return first === undefined ? undefined : first !== null;
        }
        if (k.tag !== undefined || k.char !== undefined || k.fn) return true;
        return undefined;
    }
    function cachedEvaluation(e: Expr, scope: Scope, depth: number): Known | undefined {
        const names = mentionedNames(e), entries = names.map(name => scope.get(name));
        const cached = evaluated.get(e) ?? [];
        const hit = cached.find(c => c.entries.every((entry, n) => sameBinding(entry, entries[n])));
        if (hit) return hit.result;
        const events = cellEvents;
        const [result, cut] = finishing(() => evaluateKnown(e, new Map(), scope, depth, true));
        // A value that read or wrote a cell depends on this run's order, and one
        // with lazy parts would share their forcing: evaluating the expression
        // again (an action used twice) builds them afresh.
        if (events !== cellEvents || (programMutates ?? options.mutation!()) && hasLazyParts(result)) return result;
        if (cut) return result;
        cached.push({ entries, result });
        evaluated.set(e, cached);
        return result;
    }
    function hasLazyParts(k: Known | undefined, seen = new Set<Known>()): boolean {
        if (!k || seen.has(k)) return false;
        seen.add(k);
        if (k.deferred || k.cell && !k.range || k.slot) return true;
        if (k.items?.some(x => hasLazyParts(x, seen))) return true;
        return !!k.fn && k.fn.env.some(([, v]) => hasLazyParts(v, seen));
    }
    const evaluated = new WeakMap<Expr, { entries: (Entry | undefined)[]; result: Known | undefined }[]>();
    // Copies of a binding (blocks copy outer entries) evaluate alike: the same
    // type and the same facts.
    function sameBinding(a: Entry | undefined, b: Entry | undefined): boolean {
        if (a === b) return true;
        if (!a || !b) return false;
        return a.type === b.type && a.builtin === b.builtin && a.mono === b.mono && a.clauses === b.clauses &&
            (["index", "size", "items", "cell", "range", "mutable", "boolean", "string", "char", "float", "number", "tag", "ref", "call", "expr", "fn"] as const).every(key => a[key] === b[key]);
    }
    // Every variable name an expression mentions (shadowing ignored: more is safe).
    const mentioned = new WeakMap<Expr, string[]>();
    function mentionedNames(e: Expr): string[] {
        let names = mentioned.get(e);
        if (!names) {
            const found = new Set<string>();
            const walk = (x: unknown): void => {
                if (!x || typeof x !== "object") return;
                if (Array.isArray(x)) { x.forEach(walk); return; }
                const node = x as Record<string, unknown>;
                if (node.t === "var" && typeof node.name === "string") found.add(node.name);
                for (const value of Object.values(node)) if (value && typeof value === "object") walk(value);
            };
            walk(e);
            mentioned.set(e, names = [...found]);
        }
        return names;
    }
    // What e evaluates to, given known values of the names in env.
    function evaluateKnown(e: Expr, env: Map<string, Known>, scope: Scope, depth: number, fresh = false): Known | undefined {
        // A compound expression over no local values is evaluated once for the
        // same bindings of the names it mentions: nested arguments (f (g (h x)))
        // are each checked as call arguments, in copies of one scope.
        if (!fresh && env.size === 0 && (e.t === "app" || e.t === "binop" || e.t === "block")) {
            // A part of a statement that writes top-level cells has the value the
            // statement's static run computed for it, in the run's order.
            if (!executing && statementWrote && executedParts.has(e)) { cellEvents++; return executedParts.get(e); }
            const result = cachedEvaluation(e, scope, depth);
            if (executing && !trial && !executedParts.has(e)) executedParts.set(e, result);
            return result;
        }
        const value = (x: Expr) => evaluateKnown(x, env, scope, depth);
        switch (e.t) {
            case "int": return { index: constant(e.v) };
            case "float": return { float: e.v };
            case "numeric": return knownNumber(e.v);
            case "bool": return { boolean: e.v };
            case "string": return { string: e.v };
            case "char": return { char: e.v };
            case "var": {
                // (+) is x, y -> x + y here too.
                const infix = env.has(e.name) ? undefined : infixSpelling(e, scope);
                if (infix) return evaluateKnown(infix, env, scope, depth);
                if (env.has(e.name)) return lookup(env, e.name);
                const entry = scope.get(e.name);
                if (!entry) return undefined;
                if (/^[A-Z]/.test(e.name) && resolve(entry.type).k === "variant") return { tag: e.name };
                if (entry.lazyTop) return forceLazyTop(entry.lazyTop, depth);
                const type = /^[A-Z]/.test(e.name) && resolve(entry.type).k === "type" ? { type: entry.type } : {};
                if (!entry.mono && isFunction(entry.type)) return { fn: { e, env: [], scope }, ...type };
                if (type.type) return type;
                if (entry.actionBody) return evaluateKnown(entry.actionBody.body, new Map(), entry.actionBody.scope, depth + 1);
                // Input read at check time, from the same snapshot the run uses.
                if (entry.builtin && options.inputs) {
                    const inputs = options.inputs;
                    if (e.name === "getArgs") return { action: () => known(inputs.args().map(string => ({ string }))) };
                    if (e.name === "readStdin") return { action: () => {
                        const text = inputs.readStdin?.();
                        return text === undefined ? undefined : { string: text };
                    } };
                }
                const index = entry.index && !entry.index.terms.size ? entry.index : undefined;
                return { index, size: entry.size, items: entry.items, cell: entry.cell, range: entry.range, mutable: entry.mutable, boolean: entry.boolean, string: entry.string, char: entry.char, float: entry.float, number: entry.number, tag: entry.tag, payload: entry.payload, fields: entry.fields };
            }
            case "block": return evaluateBlock(e, env, scope, depth);
            case "ternary": {
                const condition = truth(value(e.cond));
                if (condition === true) return value(e.then);
                if (condition === false) return value(e.els);
                incomplete = true;
                // Only facts both branches share survive; skip the second when the
                // first has none (recursive branches would otherwise multiply).
                const then = value(e.then);
                return hasFacts(then) ? meetValues(then, value(e.els)) : undefined;
            }
            case "unop": {
                const v = readMutable(value(e.e));
                if (e.op === "not") { const t = truth(v); return t === undefined ? undefined : { boolean: !t }; }
                const n = numericOf(v);
                return n === undefined ? undefined : attempt(() => n.typeName ? castNumeric(n.typeName, negate(n)) : negate(n));
            }
            case "list": return known(e.v.map(x => lazyValue(() => value(x), { exprs: [x], env })));
            // A record literal's fields, each computed when demanded, as a list's
            // elements are; a spread is computed now, for its field names.
            case "record":
                return { fields: recordFields(e.v.map(([key, x]) => [key, key === "_" ? () => value(x) ?? {} : () => lazyValue(() => value(x), { exprs: [x], env })])) };
            case "lambda": return { fn: { e, env: [...env], scope } };
            // A pattern lambda (() -> x, [a, b] -> a) is a one-clause local function.
            case "patternLambda": {
                if (e.guard) return undefined;
                const names = e.params.flatMap(patternNames);
                const refutable = new Set(names.filter((x, i) => names.indexOf(x) !== i));
                return { fn: { summary: { scope, clauses: [{ index: 0, params: e.params, body: e.body, refutable }] }, env: [...env], applied: [] } };
            }
            case "range": return rangeKnown(e.lo, e.step, e.hi);
            case "computedRange": {
                const bound = (x: Expr | null) => x && numericOf(value(x));
                if (!e.lo) return undefined;
                const lo = bound(e.lo), second = bound(e.second), hi = bound(e.hi);
                if (!lo || e.second && !second || e.hi && !hi) return undefined;
                if ([lo, second, hi].some(x => x && x.kind !== "int")) return undefined;
                type Real = Parameters<typeof rangeExpr>[0];
                const range = rangeExpr(lo as Real, second as Real | null, hi as Real | null);
                return range.t === "range" ? rangeKnown(range.lo, range.step, range.hi) : undefined;
            }
            case "binop": return evaluateBinop(e, env, scope, depth);
            case "app": {
                // (op) a b is a op b here too.
                const infix = e.f.t === "app" && e.f.f.t === "var" && !env.has(e.f.f.name) ? infixSpelling(e, scope) : undefined;
                if (infix) return evaluateKnown(infix, env, scope, depth);
                const result = evaluateApp(e, env, scope, depth);
                if (result === undefined) incomplete = true;
                return result;
            }
            // f $ x applies f to x.
            case "pipe": return evaluateKnown({ t: "app", f: e.f, a: e.x }, env, scope, depth);
            // Code this evaluator does not follow may have effects: mark it skipped.
            default: incomplete = true; return undefined;
        }
    }
    // A block: its local definitions, then its last expression.
    function evaluateBlock(e: Extract<Expr, { t: "block" }>, env: Map<string, Known>, scope: Scope, depth: number): Known | undefined {
        // As at runtime (bindNames): a name new here is one binding for the
        // whole block, which earlier definitions may read and its value may
        // refer to itself; a name already visible is rebound: a new version
        // from there on, whose value reads the one before. A lazy definition
        // (=) is read when used; an eager one (<-) is evaluated where it stands.
        let local = new Map(env);
        const fresh = new Map<string, { value: () => Known | undefined; bound: boolean }>();
        for (const st of e.stmts) {
            const names = st.t === "patDef" ? patternNames(st.pattern) : st.t === "stmDef" ? [st.name] : [];
            for (const name of names) if (!local.has(name) && !scope.has(name)) {
                const slot = { value: (): Known | undefined => undefined, bound: false };
                fresh.set(name, slot);
                // What the binding can hold: any of the block's statements, over its scope.
                local.set(name, { slot: () => slot.value(), origin: { exprs: e.stmts, env: local } });
            }
        }
        // Bind name to a value: a new name's slot, or a new version.
        const bind = (name: string, value: () => Known | undefined) => {
            const slot = fresh.get(name);
            if (slot && !slot.bound) { slot.bound = true; slot.value = value; return; }
            local = new Map(local);
            local.set(name, { slot: value });
        };
        // A pattern's names take their parts of one shared value.
        const assign = (pattern: Pattern, whole: () => Known | undefined) => {
            const parts = once(() => {
                const bound = new Map<string, Known>();
                bindKnown(pattern, whole() ?? {}, bound, new Set());
                return bound;
            });
            for (const name of patternNames(pattern)) bind(name, () => parts()?.get(name));
        };
        // A <- binding, or a discarded statement that is an action, makes the
        // rest of the block an action, run where the program runs it.
        const steps = (from: number, running: boolean): Known | undefined => {
            for (let n = from; n < e.stmts.length; n++) {
                const st = e.stmts[n], last = n === e.stmts.length - 1, before = local;
                if (st.t === "patDef") {
                    if (last || st.update || st.value.t === "setItem" || st.value.t === "setFields") { incomplete = true; return undefined; }
                    if (st.eager) {
                        if (!running) return { action: () => steps(n, true) };
                        const known = evaluateKnown(st.value, before, scope, depth);
                        // Only IO is followed: a list or Option do-block is not.
                        if (!demand(known)?.action) { incomplete = true; return undefined; }
                        const v = runKnown(known);
                        assign(st.pattern, () => v);
                    } else assign(st.pattern, once(() => evaluateKnown(st.value, before, scope, depth)));
                } else if (st.t === "stmDef") {
                    if (last) { incomplete = true; return undefined; }
                    if (!st.clauses[0].params.length) {
                        bind(st.name, once(() => evaluateKnown(st.clauses[0].body, before, scope, depth)));
                        continue;
                    }
                    const summary: Summary = { scope, clauses: st.clauses.map((c, index) => {
                        const names = c.params.flatMap(patternNames);
                        return { index, params: c.params, body: c.body, refutable: new Set([st.name, ...names.filter((x, i) => names.indexOf(x) !== i)]) };
                    }) };
                    // A function reads itself, the version it defines.
                    const fn: Known = { fn: { summary, env: [], applied: [] } };
                    bind(st.name, () => fn);
                    fn.fn!.env = [...local];
                } else if (last) {
                    const v = evaluateKnown(st, local, scope, depth);
                    return running ? runKnown(v) : v;
                } else {
                    const v = evaluateKnown(st, local, scope, depth);
                    if (demand(v)?.action) {
                        if (!running) return { action: () => { runKnown(v); return steps(n + 1, true); } };
                        runKnown(v);
                    }
                }
            }
            return undefined;
        };
        return steps(0, false);
    }
    // A name's known value in env: a block binding's current value, or a fact.
    function lookup(env: Map<string, Known>, name: string): Known | undefined {
        const k = env.get(name)!;
        return k.slot ? k.slot() : resolveKnown(k);
    }
    // A value computed at most once; a value that needs itself (x = x + 1) is unknown.
    function once<T>(compute: () => T): () => T | undefined {
        let state = 0, result: T | undefined;
        return () => {
            if (state === 2) return result;
            if (state === 1) return undefined;
            state = 1;
            let cut: boolean;
            try { [result, cut] = finishing(compute); } catch (error) { state = 0; throw error; }
            state = cut ? 0 : 2;
            return result;
        };
    }
    // A binary operator on known operands.
    function evaluateBinop(e: Extract<Expr, { t: "binop" }>, env: Map<string, Known>, scope: Scope, depth: number): Known | undefined {
        // A user's operator is a call, as is an overload of a builtin one.
        // An overload of a prelude operator is its builtin for operands of
        // types its clauses do not accept, as inferred.
        if (!env.has(e.op) && !builtinAt(e, scope)) return evaluateKnown(operatorCall(e), env, scope, depth);
        if (env.has(e.op)) { incomplete = true; return undefined; }
        return evaluateOperator(e.op, e.l, e.r, env, scope, depth);
    }
    // A prelude operator's builtin meaning on its operands, written infix
    // (a + b) or called (intrinsics.add a b): one evaluation for both.
    function evaluateOperator(op: string, left: Expr, right: Expr, env: Map<string, Known>, scope: Scope, depth: number): Known | undefined {
        const value = (x: Expr) => evaluateKnown(x, env, scope, depth);
        if (op === "$") return value({ t: "app", f: left, a: right });
        // x :: xs; the tail may be endless (repeat x = x :: repeat x).
        // The tail is evaluated only when an element past the head is needed.
        if (op === "::") {
            const h = lazyValue(() => value(left), { exprs: [left], env });
            return lazyList(() => ({ head: h, tail: value(right) ?? {} }), { exprs: [left, right], env });
        }
        if (op === "++") {
            const l = value(left), r = value(right);
            if (l?.string !== undefined && r?.string !== undefined) return { string: l.string + r.string };
            if (l?.items && r?.items) return known([...l.items, ...r.items]);
            const size = l?.size !== undefined && r?.size !== undefined ? { size: l.size + r.size } : {};
            if (!l?.items && !l?.cell) return l?.size !== undefined && r?.size !== undefined ? size : undefined;
            const append = (rest: Known): Known => lazyList(() => {
                const cell = cellOf(rest);
                return cell === null ? cellOf(r) : cell && { head: cell.head, tail: append(cell.tail) };
            }, { exprs: [left, right], env });
            return { ...append(l), ...size };
        }
        if (op === "&&" || op === "||") {
            const l = truth(value(left));
            if (l === undefined) return undefined;
            if (op === "&&" ? !l : l) return { boolean: l };
            const r = truth(value(right));
            return r === undefined ? undefined : { boolean: r };
        }
        const l = readMutable(value(left)), r = readMutable(value(right));
        const x = numericOf(l), y = numericOf(r);
        if (x !== undefined && y !== undefined) {
            if (["+", "-", "*", "/", "%"].includes(op)) return attempt(() => typedArithmetic(op, x, y));
            if (op === "^") return attempt(() => typedPower(x, y));
            if (op === "==" || op === "!=") return attempt(() => equalNumbers(x, y) === (op === "=="));
            if (["<", ">", "<=", ">="].includes(op)) {
                return attempt(() => {
                    const c = compareNumbers(x, y);
                    // Ordered comparisons involving NaN are false.
                    if (Number.isNaN(c)) return false;
                    return op === "<" ? c < 0 : op === ">" ? c > 0 : op === "<=" ? c <= 0 : c >= 0;
                });
            }
            return undefined;
        }
        if (op === "==" || op === "!=") {
            const same = equalKnown(l, r);
            return same === undefined ? undefined : { boolean: same === (op === "==") };
        }
        if (!["<", ">", "<=", ">="].includes(op)) return undefined;
        let order: number | undefined;
        for (const key of ["string", "char"] as const) {
            if (l?.[key] !== undefined && r?.[key] !== undefined) order = l[key]! < r[key]! ? -1 : l[key]! > r[key]! ? 1 : 0;
        }
        if (order === undefined) return undefined;
        return { boolean: op === "<" ? order < 0 : op === ">" ? order > 0 : op === "<=" ? order <= 0 : order >= 0 };
    }
    // An application: lambdas, function values, pure builtins, and calls by name.
    function evaluateApp(e: Extract<Expr, { t: "app" }>, env: Map<string, Known>, scope: Scope, depth: number): Known | undefined {
        const value = (x: Expr) => evaluateKnown(x, env, scope, depth);
        const apply = (f: Known | undefined, args: Known[]) => { const g = demand(f)?.fn; return g && applyKnown(g, args, depth); };
        const args: Expr[] = [];
        let head: Expr = e;
        while (head.t === "app") { args.unshift(head.a); head = head.f; }
        if (head.t === "block" && head.stmts.length === 1 && head.style === "(") head = head.stmts[0];
        // An operator's intrinsic called (intrinsics.add a b) is its builtin meaning.
        const intrinsic = head.t === "recordAccess" && !head.scoped && (!head.argument || head.argument.t === "var" && head.argument.name === head.field) && head.rec.t === "var" && head.rec.name === "intrinsics"
            && !env.has("intrinsics") && scope.get("intrinsics")?.builtin ? PRIMITIVE_OPERATORS.get(`intrinsics.${head.field}`) : undefined;
        if (intrinsic && args.length === 2) return evaluateOperator(intrinsic, args[0], args[1], env, scope, depth);
        // A lambda (or operator section): too few arguments give a function
        // value, extra ones apply its result.
        if (head.t === "lambda") {
            if (args.length < head.params.length) return { fn: { e, env: [...env], scope } };
            if (!spendEvaluation(depth)) return undefined;
            const inner = new Map(env);
            head.params.forEach((name, n) => inner.set(name, lazyValue(() => value(args[n]), { exprs: [args[n]], env })));
            const result = evaluateKnown(head.body, inner, scope, depth + 1);
            if (args.length === head.params.length) return result;
            return apply(result, args.slice(head.params.length).map(a => value(a) ?? {}));
        }
        if (head.t !== "var") return apply(value(head), args.map(a => value(a) ?? {}));
        // A function value applied to arguments (a parameter holding a lambda,
        // a section, a named or local function).
        if (env.has(head.name)) return apply(lookup(env, head.name), args.map(a => lazyValue(() => value(a), { exprs: [a], env })));
        const entry = scope.get(head.name);
        // A named function applied to fewer arguments than it takes is a function value.
        if (entry && !entry.mono && isFunction(entry.type)) {
            let t: Ty | undefined = resolve(entry.type);
            if (t.k === "overload") t = resolve(t.choices[0]);
            for (let n = 0; n < args.length; n++) t = t?.k === "fn" ? resolve(t.output) : undefined;
            if (t?.k === "fn") return { fn: { e, env: [...env], scope } };
        }
        const builtin = !!entry?.builtin;
        if (builtin && EVALUATED_NATIVES.has(head.name)) {
            // Demanding builtins read their arguments where they stand; the rest
            // (map, filter, folds, ...) only as their results are walked.
            const strict = STRICT_NATIVES.has(head.name);
            // A demanding builtin reads a cell's contents, except set's target.
            return evaluateNative(head.name, args.map((a, n) => () => !strict ? lazily(() => value(a))
                : head.name === "set" && n === 0 ? demand(value(a)) : readMutable(value(a))), depth, { exprs: args, env });
        }
        if (head.name === "Mutable" && builtin && args.length === 1) {
            const cell: KnownCell = { value: value(args[0]) ?? {}, root, program: creatingTopLevel };
            if (cell.program) programCells.add(cell);
            return { mutable: cell };
        }
        // match x [alternatives]: a function whose clauses are the alternatives,
        // called with x (a guarded one is not evaluated here).
        if (head.name === "match" && builtin && args.length === 2 && args[1].t === "list") {
            const alternatives = args[1].v;
            if (!alternatives.every(x => x.t === "patternLambda" && !x.guard && x.params.length === 1)) return undefined;
            const clauses = alternatives.map((x, index) => {
                const { params, body } = x as Extract<Expr, { t: "patternLambda" }>;
                const names = params.flatMap(patternNames);
                return { index, params, body, refutable: new Set(names.filter((name, i) => names.indexOf(name) !== i)) };
            });
            return evaluateCall({ scope, clauses }, [value(args[0]) ?? {}], depth, new Map(env));
        }
        // do xs: the block whose statements are the elements. With an action
        // among them it is one, running each in order and yielding the last's
        // result; otherwise it is the last value ([] for none).
        if (head.name === "do" && builtin && args.length === 1) {
            const statements: Known[] = [];
            for (let rest: Known | undefined = value(args[0]); ;) {
                if (!spendEvaluation(depth)) return undefined;
                const cell = cellOf(rest);
                if (cell === undefined) { incomplete = true; return undefined; }
                if (cell === null) break;
                if (cell.head === undefined) return undefined;
                statements.push(cell.head);
                rest = cell.tail;
            }
            if (!statements.some(k => k.action)) return statements.at(-1) ?? known([]);
            const last = statements.at(-1)!;
            if (!last.action) return undefined;
            return { action: () => {
                for (const k of statements.slice(0, -1)) if (k.action && runKnown(k) === undefined) return undefined;
                return runKnown(last);
            } };
        }
        // return x: the action yielding x.
        if (head.name === "return" && builtin && args.length === 1) {
            const inner = value(args[0]);
            return { action: () => inner };
        }
        // to T x and from T x with a builtin T: the native the runtime runs
        // (to (List Char) is chars), unless a program defines its own instances.
        if ((head.name === "to" || head.name === "from") && builtin && args.length === 2) {
            const target = value(args[0])?.type, t = target && resolve(target);
            // A program's own instance for this type runs instead.
            if (t && instanceFor(head.name, [t])) return undefined;
            const inner = t?.k === "type" ? resolve(t.value) : undefined;
            const kind = inner?.k === "atom" && inner.name === "String" ? "String"
                : inner?.k === "list" && !inner.items && resolve(inner.element).k === "atom" && (resolve(inner.element) as { name: string }).name === "Char" ? "List Char" : undefined;
            const native = kind && ({ to: { String: "toString", "List Char": "chars" }, from: { String: "parse", "List Char": "fromChars" } } as const)[head.name][kind];
            if (native) return evaluateNative(native, [() => readMutable(value(args[1]))], depth);
            // to of another type applies it, as at runtime; anything else
            // (an unknown target, JSON, from) is left to the run.
            if (head.name === "to" && t?.k === "type" && !(inner?.k === "variant" && inner.name === "JSON")) return value({ t: "app", f: args[0], a: args[1] });
            return undefined;
        }
        // not x and negate x: the prelude's functions for !x and -x.
        if ((head.name === "not" || head.name === "negate") && builtin && args.length === 1) {
            return value({ t: "unop", op: head.name === "not" ? "not" : "neg", e: args[0] });
        }
        // List T: the type of lists of T (to (List Char) names it).
        if (head.name === "List" && builtin && args.length === 1) {
            const element = value(args[0])?.type, t = element && resolve(element);
            return t?.k === "type" ? { type: { k: "type", value: list(t.value) } } : undefined;
        }
        // S n: the natural after n, as at runtime.
        if (head.name === "S" && builtin && args.length === 1) {
            const n = numericOf(readMutable(value(args[0])));
            if (n === undefined) return undefined;
            return attempt(() => { const k = castNumeric("UInt", n) as { v: bigint }; return { kind: "int", v: k.v + 1n, typeName: "UInt" } as Numeric; });
        }
        if (head.name === "Bool" && builtin && args.length === 1) {
            const b = truth(value(args[0]));
            return b === undefined ? undefined : { boolean: b };
        }
        // A numeric type applied to a number: floating types round, others
        // convert losslessly or fail, as at runtime.
        if (NUMERIC_TYPES.includes(head.name) && builtin && args.length === 1) {
            const n = numericOf(readMutable(value(args[0])));
            return n === undefined ? undefined : attempt(() => castNumeric(head.name, n, ["Float", "Float32", "Float64"].includes(head.name)));
        }
        if (/^[A-Z]/.test(head.name)) {
            let t = resolve(entry?.type ?? dynamic);
            for (let n = 0; n < args.length && t.k === "fn"; n++) t = resolve(t.output);
            return t.k === "variant" ? { tag: head.name, ...args.length ? { payload: args.map(a => value(a) ?? {}) } : {} } : undefined;
        }
        // The runtime's numeric natives, when the name is the builtin itself.
        const native = NUMBER_NATIVES.find(([name]) => name === head.name);
        if (native && builtin && native[1] === args.length) {
            const values = args.map(a => numericOf(readMutable(value(a))));
            if (values.some(v => v === undefined)) return undefined;
            const numbers = values as Numeric[];
            return attempt(() => head.name === "expt" ? typedPower(numbers[0], numbers[1]) : numericNative(head.name, numbers));
        }
        if (!trustsShape(entry)) return undefined;
        const values = args.map(a => lazyValue(() => value(a), { exprs: [a], env }));
        const summary = summaryAt(entry!.type, args.length);
        const result = summary && evaluateCall(summary, values, depth);
        if (isList(result)) return result;
        // A builtin's (or inferred) result shape: an argument itself, or a
        // list as long as a constant or as an argument.
        const shape = shapeAt(entry!.type, args.length);
        const size = shape?.arg !== undefined ? values[shape.arg]?.size
            : shape?.length ? "constant" in shape.length ? shape.length.constant : values[shape.length.param]?.size
            : undefined;
        return size === undefined ? result : { ...result, size };
    }
    // The pure builtins, run on known arguments as the runtime runs them.
    function evaluateNative(name: string, args: (() => Known | undefined)[], depth: number, origin?: Origin): Known | undefined {
        const arity = name === "foldl" || name === "foldr" || name === "zipWith" ? 3 : name === "set" || LIST_NATIVES.includes(name) || name === "iterate" || name === "seq" || name === "assert" ? 2 : 1;
        if (args.length !== arity) return undefined;
        // Folds may apply f at other moments than here: a region. map, zipWith,
        // filter and iterate apply it where the runtime does (lazily for heads).
        const call = (f: Known | undefined, values: Known[]) => { const g = demand(f)?.fn; return g && lazily(() => applyKnown(g, values, depth)); };
        const now = (f: Known | undefined, values: Known[]) => { const g = demand(f)?.fn; return g && applyKnown(g, values, depth); };
        switch (name) {
            case "head": { const item = element(args[0](), 0); return item ?? undefined; }
            case "tail": {
                const list = args[0]();
                const first = element(list, 0);
                return first ? dropKnown(list!, 1) : undefined;
            }
            case "null": {
                const list = args[0]();
                if (list?.string !== undefined) return { boolean: list.string.length === 0 };
                const first = element(list, 0);
                return first === undefined ? undefined : { boolean: first === null };
            }
            case "length": {
                const k = args[0]();
                const n = k?.string !== undefined ? textNatives.length(k.string) : knownLength(k);
                return n === undefined ? undefined : { index: constant(n) };
            }
            // assert c x is x, as Haskell's (c is checked when it runs).
            case "seq": case "assert": args[0](); return args[1]();
            // Effects are actions, run statically where the program runs them;
            // print, echo, emit, debug and set yield []. Printing
            // renders, forcing every element in order.
            case "print": case "echo": case "emit": return { action: () => {
                if (renderKnown(args[0]()) === undefined) incomplete = true;
                return known([]);
            }, actionResult: "[]" };
            // use forces its record and binds its fields (lazily): no other effect.
            case "debug": case "use": args[0](); return known([]);
            case "set": return { action: () => { writeMutable(args[0](), args[1]); return known([]); }, actionResult: "[]" };
            // Input read at check time, from the same snapshot the run uses.
            case "readFile": return { action: () => {
                const path = args[0]()?.string;
                const text = path === undefined ? undefined : options.inputs?.readFile(path);
                return text === undefined ? undefined : { string: text };
            }, actionResult: "String" };
            // Booleans and number literals, as the runtime parses them.
            // The runtime's own functions (text-natives.ts), on known text.
            case "parse": {
                const text = args[0]()?.string;
                const parsed = text === undefined ? null : parseLiteral(text);
                return parsed === null ? undefined : typeof parsed === "boolean" ? { boolean: parsed } : knownNumber(parsed);
            }
            case "chars": {
                const text = args[0]()?.string;
                return text === undefined ? undefined : known(textNatives.chars(text).map(c => ({ char: c })));
            }
            case "fromChars": {
                const items = elementsOf(args[0]())?.map(demand);
                if (!items || items.some(c => c?.char === undefined)) return undefined;
                return { string: textNatives.fromChars(items.map(c => c!.char!)) };
            }
            case "upper": case "lower": {
                const text = args[0]()?.string;
                return text === undefined ? undefined : { string: textNatives[name](text) };
            }
            case "toString": {
                const text = renderKnown(args[0]());
                return text === undefined ? undefined : { string: text };
            }
            case "intToString": {
                const n = numericOf(args[0]());
                return n?.kind === "int" ? { string: String(n.v) } : undefined;
            }
            case "enumerate": {
                const list = args[0]();
                if (!list?.items && !list?.cell) return list?.size === undefined ? undefined : { size: list.size };
                return unfold<[Known, bigint]>([list, 0n], ([rest, n]) => {
                    const cell = cellOf(rest);
                    return cell && { head: known([{ index: constant(n) }, cell.head]), next: [cell.tail, n + 1n] };
                }, origin);
            }
            case "iterate": {
                const f = args[0]();
                return unfold<Known>(args[1]() ?? {}, value => ({ head: value, next: lazyValue(() => now(f, [value]), origin) }), origin);
            }
            case "foldl": case "foldr": {
                const f = args[0](), items = elementsOf(args[2]());
                if (!items) return undefined;
                let acc: Known = args[1]() ?? {};
                if (name === "foldl") for (const item of items) acc = call(f, [acc, item]) ?? {};
                else for (const item of [...items].reverse()) acc = call(f, [item, acc]) ?? {};
                return acc;
            }
            case "take": case "drop": {
                const count = numericOf(readMutable(args[0]())), list = args[1]();
                if (count?.kind !== "int" || count.v < 0n || !list) return undefined;
                if (list.range) {
                    const { lo, step, hi } = list.range, n = count.v;
                    if (name === "drop") return rangeKnown(lo + n * step, step, hi);
                    if (n === 0n) return known([]);
                    const end = lo + (n - 1n) * step;
                    return rangeKnown(lo, step, hi === null ? end : step > 0n ? (end < hi ? end : hi) : (end > hi ? end : hi));
                }
                if (count.v > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
                const c = Number(count.v);
                if (name === "drop") return isList(list) ? dropKnown(list, c) : undefined;
                if (list.items) return known(list.items.slice(0, c));
                if (list.cell) return unfold<[Known, number]>([list, c], ([rest, left]) => {
                    if (left === 0) return null;
                    const cell = cellOf(rest);
                    return cell && { head: cell.head, next: [cell.tail, left - 1] };
                }, origin);
                return list.size === undefined ? undefined : { size: list.size < count.v ? list.size : count.v };
            }
            case "map": {
                const f = args[0](), list = args[1]();
                if (!list?.items && !list?.cell) return list?.size === undefined ? undefined : { size: list.size };
                if (list.items) return known(list.items.map(item => lazyValue(() => now(f, [item]), origin)));
                const mapped = unfold<Known>(list, rest => {
                    const cell = cellOf(rest);
                    return cell && { head: lazyValue(() => now(f, [cell.head]), origin), next: cell.tail };
                }, origin);
                return list.size === undefined ? mapped : { ...mapped, size: list.size };
            }
            case "filter": {
                const f = args[0](), list = args[1]();
                if (!list?.items && !list?.cell) return undefined;
                // Each cell holds the next element the predicate keeps.
                return unfold<Known>(list, rest => {
                    while (spendEvaluation(0)) {
                        const cell = cellOf(rest);
                        if (!cell) return cell;
                        const keep = truth(now(f, [cell.head]));
                        if (keep === undefined) return undefined;
                        if (keep) return { head: cell.head, next: cell.tail };
                        rest = cell.tail;
                    }
                    return undefined;
                }, origin);
            }
            case "zipWith": {
                const f = args[0](), xs = args[1](), ys = args[2]();
                if (!xs?.items && !xs?.cell || !ys?.items && !ys?.cell) {
                    // A list of unknown length decides nothing; skip walking the other.
                    if (!isList(xs) || !isList(ys)) return undefined;
                    const a = knownLength(xs), b = a === undefined ? undefined : knownLength(ys);
                    return a === undefined || b === undefined ? undefined : { size: a < b ? a : b };
                }
                return unfold<[Known, Known]>([xs, ys], ([left, right]) => {
                    const x = cellOf(left), y = cellOf(right);
                    if (x === null || y === null) return null;
                    if (x === undefined || y === undefined) return undefined;
                    return { head: lazyValue(() => now(f, [x.head, y.head]), origin), next: [x.tail, y.tail] };
                }, origin);
            }
        }
        return undefined;
    }
    // The facts both a and b agree on (clauses, ternary branches).
    function meetValues(a: Known | undefined, b: Known | undefined): Known | undefined {
        if (!a || !b) return undefined;
        const result: Known = {};
        const same = (x: unknown, y: unknown) => x !== undefined && x === y;
        if (a.index && b.index && !a.index.terms.size && !b.index.terms.size && a.index.constant === b.index.constant) result.index = a.index;
        // A lazy list meets a list of known length if it has exactly that many
        // elements; only that many cells are walked.
        if ((a.cell || b.cell) && isList(a) && isList(b)) {
            const [fixed, other] = a.cell ? [b, a] : [a, b];
            const n = fixed.cell ? undefined : knownLength(fixed);
            if (n !== undefined && n <= BigInt(Number.MAX_SAFE_INTEGER) && hasLength(other, Number(n))) result.size = n;
        }
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
    // A known number p takes apart as Z or S k: its value as a natural, or -1
    // when it is none (negative or not an integer). Values are the runtime's
    // test, so a program's own Z and S variants are unaffected.
    function naturalArgument(p: Pattern, argument: Known): bigint | undefined {
        if (p.p !== "constr" || !(p.tag === "Z" && !p.args.length || p.tag === "S" && p.args.length === 1) || argument.tag !== undefined) return undefined;
        const number = knownNumberOf(argument);
        if (!number) return undefined;
        try { return (castNumeric("UInt", number) as { v: bigint }).v; } catch { return -1n; }
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
        const n = naturalArgument(p, argument);
        if (n !== undefined) return p.p === "constr" && (p.tag === "Z" ? n === 0n : n > 0n && irrefutable(p.args[0]));
        // A constructor the argument was visibly built with, its fields bound plainly.
        if (p.p === "constr" && !TYPE_NAMES.includes(p.tag)) return argument.tag === p.tag && p.args.every(irrefutable);
        // A certain exact-type (30) or aggregate (10) match, binding the value whole.
        if (p.p === "constr" && TYPE_NAMES.includes(p.tag) && p.tag !== "Vect" && p.args.length === 1) {
            // A lossless conversion (1) is certain only for a known value.
            return (score === 30 || score === 10 || score === 1) && irrefutable(p.args[0]);
        }
        if (wholeList(p)) return score === 30 && irrefutable(p.value);
        if (p.p === "list") return p.v.every(irrefutable) && listLength(argument, p.v.length) === true;
        if (p.p === "cons") return irrefutable(p.head) && irrefutable(p.tail) && listLength(argument, 0) === false;
        return false;
    }
    // Is the argument a list of exactly this length? From its type, or its known value.
    function listLength(argument: Entry, count: number): boolean | undefined {
        const n = sizeOf(argument.type) ?? argument.size;
        if (n !== undefined) return n === BigInt(count);
        if (!argument.items && !argument.cell) return undefined;
        const last = count ? element(argument, count - 1) : {}, next = element(argument, count);
        if (last === null || next) return false;
        return last === undefined || next === undefined ? undefined : true;
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
        const n = naturalArgument(p, argument);
        if (n !== undefined) return p.p === "constr" && (p.tag === "Z" ? n !== 0n : n <= 0n);
        if (p.p === "constr") return argument.tag !== undefined && argument.tag !== p.tag;
        if (p.p === "list") return listLength(argument, p.v.length) === false || p.v.some((q, n) => itemFails(q, argument, n));
        if (p.p === "cons") return listLength(argument, 0) === true || itemFails(p.head, argument, 0);
        return false;
    }
    // Can the argument's nth element never match q? ([[],y] for [[1,2],3])
    function itemFails(q: Pattern, argument: Entry, n: number): boolean {
        const item = peek(() => element(argument, n), undefined);
        if (!item) return false;
        const t = resolve(argument.type), entry: Entry = { type: t.k === "list" ? t.items?.[n] ?? t.element : dynamic, ...item };
        const [low, high] = patternScore(q, entry);
        return definitelyFails(q, entry, low, high);
    }
    // A pattern's type with each empty-list pattern's list ([]) opened to a list
    // of any length, sharing everything else.
    function openEmpty(type: Ty): Ty {
        const t = resolve(type);
        if (t.k !== "list") return type;
        if (t.items?.length === 0) return list(t.element);
        return t.items ? { ...t, items: t.items.map(openEmpty) } : t;
    }
    // Does one type have an empty-list pattern's list ([] in g [[],y]) where
    // the other has a list of any length? Merging would keep the empty one.
    function emptyAgainstOpen(a: Ty, b: Ty, seen = new Set<Ty>()): boolean {
        const x = resolve(a), y = resolve(b);
        if (seen.has(x)) return false;
        seen.add(x);
        if (x.k === "list" && y.k === "list") {
            if ((x.items?.length === 0) !== (y.items?.length === 0)) return true;
            if (x.items && y.items && x.items.length === y.items.length) return x.items.some((item, n) => emptyAgainstOpen(item, y.items![n], seen));
            return emptyAgainstOpen(x.element, y.element, seen);
        }
        if (x.k === "fn" && y.k === "fn") return emptyAgainstOpen(x.input, y.input, seen) || emptyAgainstOpen(x.output, y.output, seen);
        return false;
    }
    // Forget every list length in a (freshly copied) type graph. An
    // argument's data forgets only its own: a function's or an action's (an
    // action's [] result) is its contract, and stays.
    function withoutLengths(type: Ty, data = false, seen = new Set<Ty>()): Ty {
        const t = resolve(type);
        if (seen.has(t) || data && (t.k === "fn" || t.k === "variant" && t.name === "IO")) return type;
        seen.add(t);
        if (t.k === "list") { t.length = undefined; t.items = undefined; }
        children(t).forEach(child => withoutLengths(child, data, seen));
        return type;
    }
    // Forget the list lengths in a parameter's data that its type leaves open
    // (all of them where it says nothing, as a type variable).
    function withoutOpenLengths(type: Ty, parameter: Ty, seen = new Set<Ty>()): Ty {
        const t = resolve(type), p = resolve(parameter);
        if (seen.has(t)) return type;
        seen.add(t);
        if (t.k === "list" && p.k === "list") {
            if (p.length || p.items) return type;
            t.length = undefined;
            t.items = undefined;
            withoutOpenLengths(t.element, p.element, seen);
        } else if (t.k === "record" && p.k === "record") {
            for (const [key, field] of t.fields) withoutOpenLengths(field, p.fields.get(key) ?? variable(), seen);
        } else if (t.k === "variant" && p.k === "variant" && t.name === p.name && t.args.length === p.args.length) {
            t.args.forEach((arg, n) => withoutOpenLengths(arg, p.args[n], seen));
        } else withoutLengths(type, true);
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
                if (!["+", "-", "*", "/", "%", "^"].includes(e.op) || !builtinAt(e, scope)) return undefined;
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
    // Whether a pattern converts the value it matches (Int n, a schema, a
    // contract), in whole or in a part ([UInt8 a,UInt8 b], (Float x):rest).
    // Only real type patterns can project Dynamic arguments.
    // Z or S k taking apart a natural number (the builtin Z and S, not a variant's).
    function naturalPattern(p: Pattern, scope: Scope): boolean {
        return p.p === "constr" && (p.tag === "Z" && !p.args.length || p.tag === "S" && p.args.length === 1) && !!scope.get(p.tag)?.builtin;
    }
    function patternConverts(p: Pattern, scope: Scope): boolean {
        switch (p.p) {
            case "schema": case "int": return true;
            case "constr": {
                if (naturalPattern(p, scope)) return true;
                const constructor = resolve(scope.get(p.tag)?.type ?? dynamic);
                if (constructor.k === "type" && !variables(constructor.value).size || constructor.k === "record" || constructor.k === "list") return true;
                // A variant whose payload patterns convert (Some (Float x)).
                return p.args.some(arg => patternConverts(arg, scope));
            }
            case "list": return p.v.some(item => patternConverts(item, scope));
            case "cons": return patternConverts(p.head, scope) || patternConverts(p.tail, scope);
            case "as": return patternConverts(p.left, scope) || patternConverts(p.right, scope);
            case "typeBind": return patternConverts(p.value, scope);
            default: return false;
        }
    }
    // An index written with the names the program bound to its terms (m for
    // the length a typed pattern bound), as indexText writes the rest.
    function indexIn(index: Index, scope: Scope): string {
        const names = new Map<string, string>();
        for (const [name, entry] of scope) {
            const i = entry.index;
            if (/^[a-z]/.test(name) && i && !i.constant && i.terms.size === 1 && [...i.terms.values()][0] === 1n) names.set([...i.terms.keys()][0], name);
        }
        return indexText({ constant: index.constant, terms: new Map([...index.terms].map(([term, k]) => [names.get(term) ?? term, k])) });
    }
    function functionType(params: Pattern[], body: Expr, parent: Scope, recursiveName?: string, guard?: Expr, given?: Ty[], claim?: Index): Ty {
        const outerFacts = lengthFacts;
        lengthFacts = new Map(outerFacts);
        deferred++;
        try {
            const t = inferFunction(params, body, parent, recursiveName, guard, given);
            // A claimed length holds for this alternative when its own facts
            // ([] makes n zero) make the two equal; then it is its length.
            const f = resolve(t), out = f.k === "fn" ? resolve(f.output) : undefined;
            if (claim && f.k === "fn" && out?.k === "list" && out.length) {
                const delta = indexAdd(refinedIndex(claim), refinedIndex(out.length), -1n);
                if (!delta.terms.size && delta.constant === 0n) f.output = list(out.element, claim);
                else if (!delta.terms.size) problem(`length mismatch: expected ${indexIn(refinedIndex(claim), parent)}, got ${indexIn(refinedIndex(out.length), parent)}`, body);
            }
            return t;
        }
        finally { lengthFacts = outerFacts; deferred--; }
    }
    // The input a match alternative's pattern starts from: the scrutinee's
    // length where the pattern takes a cons (so its tail's is one less), its
    // items where it lists them, and a fresh type elsewhere, as an
    // alternative's patterns test the value rather than constrain it.
    function patternInput(p: Pattern, scrutinee: Ty): Ty {
        const t = resolve(scrutinee);
        if (p.p === "as") return patternInput(p.right, scrutinee);
        if (p.p === "typeBind") return patternInput(p.value, scrutinee);
        // A name takes anything: it is the scrutinee, length included.
        if (p.p === "var") return scrutinee;
        if (t.k !== "list") return variable();
        if (p.p === "cons" && t.length) return list(variable(), t.length);
        // [] tests for empty: within its alternative the length is zero.
        if (p.p === "list" && !p.v.length && t.length && !t.items) return list(variable(), t.length);
        if (p.p === "list" && t.items?.length === p.v.length) {
            const items = p.v.map((item, n) => patternInput(item, t.items![n]));
            return { k: "list", element: union(items), items, length: constant(BigInt(items.length)) };
        }
        return variable();
    }
    // Does a parameter's typed pattern bind its length to a new name (n in
    // (Vect n a) xs), so that it takes a list of any length?
    // A pattern as the checker reads it: (Vec n a xs) is the typed pattern
    // ((Vec n a) xs) for a type with parameters, without rewriting the program
    // (the runtime takes a Vect apart itself: a mismatch fails the match).
    function typed(p: Pattern, scope: Scope): Pattern {
        return typedForm(p, name => {
            const t = resolve(scope.get(name)?.type ?? dynamic);
            return typeParameters(t) || sharedParameters(t);
        });
    }
    function bindsLength(p: Pattern, scope: Scope): boolean {
        while (p.p === "typeBind" || p.p === "as") p = p.p === "as" ? p.left : p.value;
        if (p.p !== "schema") return false;
        let type = p.type;
        while (type.t === "block" && type.stmts.length === 1) type = type.stmts[0];
        const args: Expr[] = [];
        while (type.t === "app") { args.unshift(type.a); type = type.f; }
        const length = args[0];
        return type.t === "var" && resolve(scope.get(type.name)?.type ?? dynamic).k === "factory" &&
            !!length && (length.t === "placeholder" || length.t === "var" && /^[a-z]/.test(length.name) && !scope.has(length.name));
    }
    function inferFunction(params: Pattern[], body: Expr, parent: Scope, recursiveName?: string, guard?: Expr, given?: Ty[]): Ty {
        params = params.map(p => typed(p, parent));
        // A body that is a lambda (f = x -> y -> e is the clause f x = y -> e)
        // is checked with the clause's parameters, as f x y = e is: the same
        // curried function, so a result constructor around e is its signature too.
        const inner = params.length ? functionExpr(body) : undefined;
        if (inner && !(guard && inner.t === "patternLambda" && inner.guard)) {
            const more: Pattern[] = inner.t === "lambda" ? inner.params.map(name => ({ p: "var", name })) : inner.params;
            const names = new Set(params.flatMap(patternNames));
            if (more.length && !more.flatMap(patternNames).some(name => names.has(name))) {
                return inferFunction([...params, ...more], inner.body, parent, recursiveName, guard ?? (inner.t === "patternLambda" ? inner.guard : undefined), given);
            }
        }
        const scope = new Map(parent), inputs: { type: Ty; binder?: string; coerce: boolean }[] = [];
        const bound = new Set<string>(recursiveName ? [recursiveName] : []);
        const patternStart = requirements.length;
        const open: boolean[] = [];
        for (const [n, p] of params.entries()) {
            const t = given?.[n] ?? variable();
            open.push(bindsLength(p, scope));
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
            inputs.push({ type: t, binder, coerce: patternConverts(p, scope) });
        }
        // An explicit result constructor supplies the recursive signature before
        // checking the body. Only inspect its descriptor; never run user code.
        let declared: Ty | undefined;
        if (body.t === "app" && body.f.t === "app" && body.f.f.t === "app" && body.f.f.f.t === "var" &&
            resolve(scope.get(body.f.f.f.name)?.type ?? dynamic).k === "factory") {
            const descriptor = resolve(infer(body.f, scope));
            if (descriptor.k === "type") declared = descriptor.value;
        }
        const self = recursiveName ? scope.get(recursiveName) : undefined;
        if (self?.recursive) scope.set(recursiveName!, { ...self, selfInputs: inputs.map(i => i.type), selfOpen: open });
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
    // A value constructor: a variant, or a function that returns one.
    function isConstructor(entry: Entry | undefined): boolean {
        if (!entry) return false;
        let t = resolve(entry.type);
        for (const seen = new Set<Ty>(); t.k === "fn" && !seen.has(t); t = resolve(t.output)) seen.add(t);
        return t.k === "variant";
    }
    function define(name: string, clauses: { params: Pattern[]; body: Expr }[], scope: Scope, location: Expr): void {
        clauses = clauses.map(c => ({ ...c, params: c.params.map(p => typed(p, scope)) }));
        // Index claims (Vec (n + m) a ys) are proven by induction where they
        // can be; a wrong one is an error here, whether or not it is called.
        if (indexedFamilies.size) {
            const proof = proveIndexClaims(name, clauses, new Map([...indexedFamilies].map(([family, { def }]) => [family, def])), provenClaims, constructorOperators);
            if (typeof proof === "object") problem(proof.message, proof.at, "a clause's claim must follow from its patterns and its body; a recursive call meets the claim of the clause it takes");
            if (proof === true) provenClaims.set(name, clauses); else provenClaims.delete(name);
        }
        // Definitions of map, >>=, <*> or return define an instance: inferred on
        // their own and recorded for the session; the method stays as it is.
        if (isInstance(name, clauses) && options.instances) {
            const forward = variable();
            options.instances.set(name, [...options.instances.get(name) ?? [], forward]);
            const own: Scope = new Map(scope);
            defineClauses(name, clauses, own, location);
            (forward as Extract<Ty, { k: "var" }>).link = own.get(name)!.type;
            // return is chosen by its result type: record it for the runtime.
            if (name === "return") {
                const head = resultHead(own.get(name)!.type, 1);
                if (head) for (const c of clauses) recordHead(c.body, head);
            }
            return;
        }
        // Clauses for a math function overload it: arguments they do not take
        // keep its previous meaning.
        const previous = MATH_FUNCTIONS.has(name) && clauses[0].params.length ? scope.get(name) : undefined;
        defineClauses(name, clauses, scope, location);
        const entry = scope.get(name);
        if (previous && entry) scope.set(name, { ...entry, type: { k: "overload", choices: [entry.type, previous.type], name } });
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
        // An existing constructor destructures (Some v = Some 123), also one
        // imported, which the parser cannot see; as at runtime (evalDef).
        if (/^[A-Z]/.test(name) && isConstructor(scope.get(name))) {
            for (const c of clauses) infer({ t: "patDef", pattern: { p: "constr", tag: name, args: c.params }, value: c.body }, scope);
            return;
        }
        if (/^[A-Z]/.test(name) && clauses[0].params.length) {
            const [c] = clauses, simple = clauses.length === 1 && c.params.every(p => p.p === "var");
            scope.set(name, { type: {
                k: "alias", name, params: c.params.map((p, n) => p.p === "var" ? p.name : `$${n}`), body: c.body,
                scope: new Map(scope), args: [], ...simple ? {} : { clauses },
            } });
            return;
        }
        defineBinding(name, clauses, scope, location, scope.get(name));
        const defined = /^[A-Z]/.test(name) && scope.get(name), named = defined && namedSubtype(name, defined.type);
        if (defined && named) scope.set(name, { ...defined, type: named });
    }
    // A definition's code, inferred as that definition (deferred when lazy).
    function inferDefinition<T>(definition: Definition | undefined, lazy: boolean, run: () => T): T {
        const outer = defining, top = outermost;
        if (definition) { defining = definition; outermost ??= definition; }
        if (lazy) deferred++;
        try { return run(); } finally { defining = outer; outermost = top; if (lazy) deferred--; }
    }
    // A clause's result type, inferred on its own: its head (Int, Option).
    function clauseHead(c: { params: Pattern[]; body: Expr }, scope: Scope, name: string): string | undefined {
        const saved = requirements.length;
        choosing++;
        try { return resultHead(functionType(c.params, c.body, scope, name), c.params.length); }
        catch (error) {
            if (error && typeof error === "object" && "message" in error) return undefined;
            throw error;
        } finally { choosing--; requirements.length = saved; }
    }
    // A value's type for the run (see CheckOptions.valueTypes): a list's or a
    // variant's, whose element or arguments typed patterns decide by.
    function recordValueType(e: Expr, t: Ty): void {
        if (!options.valueTypes) return;
        const r = resolve(t);
        if (r.k === "list" || r.k === "variant" && r.args.length && !isIO(r) && !isPending(r)) recordType(options.valueTypes, e, t);
    }
    // Recorded once per source position; a position inferred as two types
    // (a generic body at different calls) decides nothing (null).
    function recordType(types: Map<string, unknown>, e: Expr, t: Ty): void {
        const at = sourceLocations.get(e), key = at && `${at.file}:${at.start}`;
        if (!key || choosing) return;
        const known = types.get(key) as Ty | null | undefined;
        types.set(key, known === undefined || known === t || known && text(known) === text(t) ? t : null);
    }
    function recordHead(body: Expr, head: string): void {
        const at = sourceLocations.get(body);
        if (at && options.resultHeads) options.resultHeads.set(`${at.file}:${at.start}`, head);
    }
    // The monad an expression is in (a do-block, a >>= chain, a call), for a
    // run that would leave its value undecided; "?" when inferences disagree
    // (a generic function's body at different calls), which decides nothing.
    // A ternary whose one branch is a return in the monad of the other: its
    // type is that monad's, which the runtime realizes the return in.
    function returnIn(e: Expr, a: Ty, b: Ty): Ty {
        const decided = isPending(resolve(a)) ? b : a, r = resolve(decided);
        if (isPending(r) || !monadic(r)) return a;
        recordMonad(e, monadKind(r));
        return decided;
    }
    function monadic(r: Ty): boolean {
        return r.k === "list" || r.k === "variant" && !isIO(r) && !!instanceFor(">>=", [r]);
    }
    function recordMonad(e: Expr, head: string): void {
        const at = sourceLocations.get(e), key = at && `${at.file}:${at.start}`;
        if (!key || !options.resultHeads || choosing) return;
        const known = options.resultHeads.get(key);
        options.resultHeads.set(key, known === undefined || known === head ? head : "?");
    }
    function defineBinding(name: string, clauses: { params: Pattern[]; body: Expr }[], scope: Scope, location: Expr, previous: Entry | undefined): void {
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
        // As at runtime: more clauses extend a function of this scope. One with
        // an equivalent pattern rebinds its clause when its result type is the
        // same, and overloads it when the result type differs.
        if (clauses[0].params.length) {
            const extended = previous?.clauses && !previous.inherited && clauses[0].params.length === previous.clauses[0].params.length;
            const earlier = extended ? previous!.clauses! : [];
            const keys = [...earlier, ...clauses].map(c => clauseKey(name, c));
            const repeated = new Set(keys.filter((k, i) => keys.indexOf(k) !== i));
            const heads = new Map<object, string | undefined>();
            for (const c of [...earlier, ...clauses]) if (repeated.has(clauseKey(name, c))) heads.set(c, clauseHead(c, scope, name));
            clauses = mergeClauses(name, earlier, clauses, c => heads.get(c));
        }
        if (!clauses[0].params.length) {
            // A fresh lazy definition can refer to itself. Reassignments still
            // inspect their previous binding under APN's existing rules.
            const pending = previous ? undefined : variable();
            if (pending) scope.set(name, { type: pending, mono: true });
            const body = clauses[0].body;
            touchedTopLevel = false;
            // A value definition is lazy: it reads its names when first used.
            const t = inferDefinition({ name, body }, true, () => infer(body, ["app", "pipe"].includes(body.t) ? new Map(scope) : scope));
            if (pending) unify(pending, t, location);
            const value = valueEntry(body, scope);
            // An action (readInput = { ... }) is run where it is used, with that check's inputs.
            const facts: Partial<Entry> = value.action ? { actionBody: { body, scope } } : value;
            // A top-level value touching top-level cells keeps its body instead,
            // to be used where the program uses it (see forceLazyTop).
            // (Also one that can write a cell: its effects run where it is used.)
            const writer = topLevelDefinition && programCells.size > 0 && !!(programMutates ?? options.mutation!()) && mayWrite(body, scope).write;
            // A block is an action, run at each use; so is an application or
            // pipe whose value is one (an action's type), while another is a
            // value, kept. One whose type is not known yet cannot be followed.
            const result = resolve(t), applied = ["app", "pipe"].includes(body.t);
            const lazyTop: LazyTop | undefined = topLevelDefinition && (touchedTopLevel || writer) && (writes.get(name) ?? 0) <= 1 ? {
                body, scope, forced: false,
                action: body.t === "block" || applied && (isIO(result) || isPending(result)),
                invalid: applied && ["var", "operation", "dynamic"].includes(result.k),
            } : undefined;
            if (lazyTop) lazyTops.add(lazyTop);
            touchedTopLevel = false;
            scope.set(name, {
                type: t,
                // A name written more than once can change under a closure that captured it.
                ...lazyTop ? { lazyTop } : facts,
                nonGeneric: captured(new Map([...scope].filter(([key]) => key !== name))),
                definition: body,
            });
            return;
        }
        forwardDefinitions.delete(name);
        const nonGeneric = captured(scope);
        const pending = forward.get(name) ?? variable();
        forward.delete(name);
        // Its clauses' own calls of an overloaded math function may take the
        // previous meaning too (sin (Dual a b) = Dual (sin a) ...).
        const fallback = MATH_FUNCTIONS.has(name) && previous && !previous.recursive ? previous.type : undefined;
        scope.set(name, { type: fallback ? { k: "overload", choices: [pending, fallback], name } : pending, mono: true, recursive: true });
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
                case "schema": return bindsSelf(p.value);
                case "list": return p.v.some(bindsSelf);
                case "cons": return bindsSelf(p.head) || bindsSelf(p.tail);
                case "constr": return p.args.some(bindsSelf);
                case "recPat": return p.v.some(([, binding]) => binding === name);
                default: return false;
            }
        };
        const orders = new Map<string, ClauseOrder[]>();
        const definition: Definition = { name, clauses };
        const firstKey = new Map<string, string>();
        for (const [index, c] of clauses.entries()) {
            const t = inferDefinition(definition, false, () => functionType(c.params, c.body, scope, name));
            const head = resultHead(t, c.params.length);
            if (head) recordHead(c.body, head);
            let key = `${c.params.some(bindsSelf) ? "self:" : ""}${domain(t)}`, existing = groups.get(key);
            // A clause with an earlier one's patterns but another result type
            // overloads it: the context of each call chooses between them.
            const patterns = clauseKey(name, c), same = firstKey.get(patterns);
            if (!same) firstKey.set(patterns, key);
            else if (groups.has(same)) {
                const fits = (a: Ty, b: Ty) => {
                    try { unify(a, b, c.body); return true; }
                    catch (error) {
                        if (!error || typeof error !== "object" || !("message" in error)) throw error;
                        return false;
                    }
                };
                const group = groups.get(same)!;
                if (!fits(copy(group), copy(t)) && fits(withoutResult(copy(group), c.params.length), withoutResult(copy(t), c.params.length))) {
                    key = `${key}#result${index}`;
                    existing = undefined;
                }
            }
            // A clause whose type differs from its group's only in list lengths
            // (f (Int n) = [1, 2]; f 0 = [0]) becomes its own overload choice;
            // clause ranking then decides between them at each call. Any other
            // conflict stays an error when the group is merged below.
            if (existing) {
                // A merge that leaves lengths unresolved (a known length against
                // an unknown one) does not merge cleanly either.
                const merges = (a: Ty, b: Ty) => {
                    const boundaries = dynamicBoundaries;
                    try { unify(a, b, c.body); return dynamicBoundaries === boundaries; }
                    catch (error) {
                        if (!error || typeof error !== "object" || !("message" in error)) throw error;
                        return false;
                    } finally { dynamicBoundaries = boundaries; }
                };
                // So does one whose result has another type (g true = "yes";
                // g false = false): a call gives the result of each clause that
                // may run, either of them where it cannot tell, as a ternary does.
                const arity = c.params.length;
                if ((!merges(copy(existing), copy(t)) || emptyAgainstOpen(existing, t)) && (merges(withoutLengths(copy(existing)), withoutLengths(copy(t)))
                    || arity && merges(withoutResult(copy(existing), arity), withoutResult(copy(t), arity)))) {
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
        const type: Ty = alternatives.length === 1 ? alternatives[0] : { k: "overload", choices: alternatives, undecided: [...groups.keys()].some(k => k.includes("#result")), name };
        if (alternatives.length === 1) {
            unify(pending, alternatives[0], location);
            // The definition's own type keeps its summary and shape; a recursive
            // call may have resolved pending to the call site's function node.
            scope.set(name, { type, nonGeneric, clauses });
        } else {
            if (pending.k === "var" && !pending.link) pending.link = type;
            scope.set(name, { type, nonGeneric, clauses });
        }
    }
    const scope: Scope = new Map(TYPE_NAMES.map((name) => [name, { type: { k: "type", value: atom(name) } }]));
    // The prelude declares Vect as the family of lists counting their elements.
    scope.set("Vect", { type: { k: "factory", args: [] } });
    const a = variable(), b = variable();
    for (
        const [name, type] of Object.entries({
            print: fn(a, io(list(variable(), constant(0n)))),
            head: fn(list(a), a),
            tail: fn(list(a), list(a)),
            filter: fn(fn(a, b), fn(list(a), list(a))),
            length: fn(dynamic, atom("Int")),
            typeOf: fn(a, atom("Type")),
            cast: fn({ k: "type", value: a }, fn(explicitDynamic, a)),
        })
    ) scope.set(name, { type });
    // fail, like the other standard natives, reaches programs through import "function".
    if (options.library) scope.set("fail", { type: fn(atom("String"), variable()) });
    const standardOnly = new Set(["seq", "chars", "fromChars", "upper", "lower", "readFile", "readStdin", "getArgs", "fetch", "toJson", "prettyJson", "fromJson", "entropy", "currentTime", "zoneOffset", "p5Object", "p5SketchType"]);
    const native = (name: string, inputs: Ty[], output: Ty) => {
        if (name in RETIRED_NATIVES) return;
        if (!standardOnly.has(name) || options.library) scope.set(name, { type: inputs.reduceRight((result, input) => fn(input, result), output) });
    };
    const int = atom("Int"), str = atom("String"), bool = atom("Bool"), num = atom("Number");
    const empty = list(variable(), constant(0n));
    for (const name of ["print", "echo", "emit"]) native(name, [variable()], io(empty));
    native("repl", [], io(empty));
    { const held = variable(); native("assert", [variable(), held], held); }
    native("isType", [variable(), variable()], bool);
    native("parse", [str], explicitDynamic);
    native("step", [int, variable()], explicitDynamic);
    for (const name of ["debug", "intrinsics.eval", "use", "load"]) scope.set(name, { type: { k: "intrinsic", name } });
    // A list's code: probe shows it, toAST gives it as lists; reduce gives
    // the values alone (a plain list, not code).
    native("intrinsics.written", [variable()], str);
    native("intrinsics.binding", [variable()], bool);
    native("intrinsics.runs", [variable()], bool);
    native("intrinsics.yields", [variable()], list(variable()));
    native("intrinsics.bound", [variable(), variable()], list(variable()));
    native("intrinsics.syntax", [variable()], explicitDynamic);
    scope.set("toAST", { type: fn(variable(), explicitDynamic) });
    scope.set("probe", { type: fn(variable(), io(empty)) });
    { const item = variable(); scope.set("reduce", { type: fn(list(item), list(item)) }); }
    native("exit", [int], io(empty));
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
    native("toString", [variable()], str);
    native("intToString", [int], str);
    native("format", [str, list(variable())], str);
    native("chars", [str], list(atom("Char")));
    native("fromChars", [list(atom("Char"))], str);
    for (const name of ["upper", "lower"]) native(name, [str], str);
    native("readFile", [str], io(str));
    native("readStdin", [], io(str));
    native("getArgs", [], io(list(str)));
    for (const name of ["entropy", "currentTime", "zoneOffset"]) native(name, [], io(int));
    // An operator's [precedence,associativity] (lib/syntax.apn's fromAST).
    native("intrinsics.fixity", [str], { k: "list", element: { k: "union", choices: [int, str] }, items: [int, str], length: constant(2n) });
    // p5's Sketch (a callback's p) and its objects: records whose methods are
    // Dynamic (their arguments are checked as they run).
    // A method's Dynamic parameters convert their arguments (as a (Dynamic x) parameter does).
    const p5Field = (field: P5Field): Ty => typeof field === "object"
        ? Array.from({ length: field.arity }).reduce<Ty>(output => fn(explicitDynamic, output, undefined, true), io(field.result ? explicitDynamic : unitList))
        : field === "Number" ? num : field === "Bool" ? bool : field === "String" ? str : field === "action" ? io(explicitDynamic) : explicitDynamic;
    // The [] a method without a result yields: one type, so the record converts to itself.
    const unitList: Ty = { k: "list", element: explicitDynamic, length: constant(0n), items: [] };
    const p5Record = (fields: Array<[string, P5Field]>): Ty => ({ k: "record", fields: new Map(fields.map(([name, field]) => [name, p5Field(field)])) });
    native("p5Object", [str, list(variable())], p5Record(objectFields()));
    native("p5SketchType", [], { k: "type", value: p5Record(sketchFields()) });
    // HTTP and JSON (the http and json modules): a response is a record; decoded JSON is Dynamic.
    native("fetch", [str, variable()], io({ k: "record", fields: new Map<string, Ty>([
        ["status", int], ["ok", bool], ["statusText", str], ["url", str], ["headers", { k: "map", key: str, value: str }], ["body", str],
    ]) }));
    for (const name of ["toJson", "prettyJson"]) native(name, [variable()], str);
    native("fromJson", [str], explicitDynamic);
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
    // The prelude's operators and their intrinsics (one per operator).
    for (const [name, op] of PRIMITIVE_OPERATORS) {
        const t: Ty = { k: "intrinsic", name: op, arity: 2 };
        scope.set(name, { type: t });
        scope.set(op, { type: t });
    }
    // The prelude's Functor/Applicative/Monad functions (see lib/prelude.apn).
    for (const [names, op, arity] of [[["map", "<$>"], "map", 2], [["<*>", "intrinsics.ap"], "ap", 2], [[">>=", "intrinsics.bind"], "bind", 2],
        [[">>"], "then", 2], [["=<<"], "bindFlip", 2], [["sequence"], "sequence", 1], [["mapM"], "mapM", 2]] as const) {
        for (const name of names) scope.set(name, { type: { k: "intrinsic", name: op, arity } });
    }
    for (const name of ["return", "intrinsics.return"]) { const t = variable(); scope.set(name, { type: fn(t, pendingTy(t)) }); }
    scope.set("empty", { type: pendingTy(variable()) });
    for (const name of ["throw", "intrinsics.throw"]) { const t = variable(); scope.set(name, { type: fn(t, pendingTy(variable())) }); }
    scope.set("intrinsics.source", { type: fn(variable(), atom("String")) });
    // Prefix - and ! as the prelude's functions (toAST writes -x as ["negate","x"]).
    for (const name of ["negate", "not"]) scope.set(name, { type: { k: "intrinsic", name, arity: 1 } });
    // map2 f a b ... map4: map then <*>, in any monad (the prelude's).
    for (const [name, arity] of [["map2", 3], ["map3", 4], ["map4", 5]] as const) scope.set(name, { type: { k: "intrinsic", name, arity } });
    // when and unless: action >> return [], in the action's monad.
    for (const name of ["when", "unless"]) scope.set(name, { type: { k: "intrinsic", name: "when", arity: 2 } });
    // loop action never finishes: its result is the action's monad.
    { const action = variable(); scope.set("loop", { type: fn(action, action) }); }
    native("while", [list(variable()), variable()], io(empty));
    native("for", [list(variable()), variable()], io(empty));
    // guard condition: return [] or empty, in the monad the context decides.
    scope.set("guard", { type: fn(variable(), pendingTy(list(variable(), constant(0n)))) });
    scope.set("cast", { type: { k: "intrinsic", name: "cast", arity: 2 } });
    // Natural numbers are UInt: Z is UInt 0, S n the next one (converting n as UInt n does).
    scope.set("Z", { type: atom("UInt"), number: { kind: "int", v: 0n, typeName: "UInt" } });
    scope.set("S", { type: fn(atom("UInt"), atom("UInt"), undefined, true) });
    scope.set("do", { type: { k: "intrinsic", name: "do" } });
    scope.set("match", { type: { k: "intrinsic", name: "match", arity: 2 } });
    for (const name of ["tag", "intrinsics.tag"]) scope.set(name, { type: { k: "intrinsic", name: "tag", arity: 3 } });
    scope.set("intrinsics.union", { type: { k: "intrinsic", name: "union", arity: 1 } });
    // to T x writes x as a T, from T x reads it back (to String, to JSON, to (List Char)).
    for (const name of ["to", "from"]) scope.set(name, { type: { k: "intrinsic", name, arity: 2 } });
    scope.set("JSON", { type: { k: "type", value: { k: "variant", name: "JSON", args: [], base: atom("String") } } });
    if (options.library) {
        const a = variable(), b = variable(), c = variable();
        native("bracket", [a, fn(a, b), fn(a, c)], io(runType(c)));
        for (const name of ["withLibrary", "allocate", "peek", "poke", "offset", "nullPointer", "withFile"]) scope.set(name, { type: explicitDynamic });
    }
    // The intrinsics (intrinsics.add, ...) are the fields of one record.
    const intrinsics = [...scope].filter(([name]) => name.startsWith("intrinsics."));
    for (const [name] of intrinsics) scope.delete(name);
    scope.set("intrinsics", { type: { k: "record", fields: new Map(intrinsics.map(([name, entry]) => [name.slice("intrinsics.".length), entry.type])) } });
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
    options.bridge?.({
        // Accepted as a typed parameter of the target type accepts it.
        fits: (target, actual) => {
            budget = STATEMENT_BUDGET;
            const t = resolve(target as Ty), a = resolve(actual as Ty);
            return succeeds(() => convert(copy(t.k === "type" ? t.value : t), copy(a), { t: "placeholder" }, false, new Map(), true));
        },
        concrete: type => !variables(resolve(type as Ty)).size,
    });
    for (const [index, written] of program.entries()) {
        if (options.before?.index === index) options.before.scope(new Map(scope));
        // Constructors declared with _ where the parser could not see them are
        // claimed here, as at runtime.
        let statement = written;
        if (statement.t === "type") {
            const def = statement.def;
            if (unionKind(def, name => alternative(name, def.name, scope)) === "claim") {
                statement = { t: "type", def: claimedDeclaration(def, tag => scope.get(tag)!.declaration!.variants[0]) };
            }
        }
        // Each top-level statement gets the same bounded work, so a long module
        // is not limited by its length.
        budget = STATEMENT_BUDGET;
        // (::) = Cons names a constructor: from here on, x :: xs is Cons x xs.
        if (statement.t === "def" && !/^[A-Za-z_]/.test(statement.name) && statement.clauses.length === 1 && !statement.clauses[0].params.length) {
            const body = statement.clauses[0].body;
            let t = body.t === "var" && /^[A-Z]/.test(body.name) ? resolve(scope.get(body.name)?.type ?? dynamic) : undefined;
            while (t?.k === "fn") t = resolve(t.output);
            if (t?.k === "variant" && body.t === "var") constructorOperators.set(statement.name, body.name);
            else constructorOperators.delete(statement.name);
        }
        rewriteInfixConstructors(statement, op => constructorOperators.get(op));
        checkingExpression = statement.t === "expr" || statement.t === "patDef" ? statement.value : statement.t === "def" ? statement.clauses[0].body : undefined;
        try {
            statementWrote = false;
            if (statement.t === "def") {
                if (!analyzed.has(statement)) {
                    // A top-level value is lazy: it runs when first used, so a cell
                    // it creates is a top-level cell, and it reads no top-level cell.
                    topLevelDefinition = creatingTopLevel = !statement.clauses[0].params.length;
                    try { define(statement.name, statement.clauses, scope, statement.clauses[0].body); }
                    finally { topLevelDefinition = creatingTopLevel = false; }
                }
            }
            else if (statement.t === "type" && unionKind(statement.def, name => alternative(name, statement.def.name, scope)) !== "declaration") {
                // X = A | B of existing types is their union (see unionKind), as at runtime.
                const kind = unionKind(statement.def, name => alternative(name, statement.def.name, scope));
                if (kind !== "union") problem(kind);
                const clause = unionClause(statement.def);
                define(statement.def.name, [clause], scope, clause.body);
            }
            else if (statement.t === "type" && countingFamily(statement.def)) {
                // A family of lists counting its elements is the length-indexed list.
                scope.set(statement.def.name, { type: { k: "factory", args: [] } });
            }
            else if (statement.t === "type") {
                const d = statement.def, parameters = new Map((d.parameters ?? []).map((p) => [p, variable()]));
                const indexed = d.variants.some(v => v.result);
                if (indexed) indexedFamilies.set(d.name, { def: d, scope });
                invariance.set(d.name, invariantParameters(d));
                const result: Ty = { k: "variant", name: d.name, args: [...parameters.values()], ordinal: d.variants.every(v => !v.fields?.length), ...indexed ? { indexed } : {} };
                scope.set(d.name, { type: { k: "type", value: result } });
                const fieldsScope = new Map(scope);
                for (const [name, t] of parameters) {
                    fieldsScope.set(name, { type: { k: "type", value: t }, mono: true });
                }
                for (const v of d.variants) {
                    // One sharing the type's name makes values whose type is marked
                    // shared too: applied to types it is that type (see sharedType).
                    let t = (v.tag === d.name ? { ...result, shared: true } : result) as Ty;
                    // An indexed constructor's own names (k in Cons a (Vec k a)) are
                    // fresh for it; its result keeps the family's parameters it
                    // names, and leaves a computed index (S k) to values.
                    const own: Scope = indexed ? new Map(fieldsScope) : fieldsScope, captures = indexed ? new Set<string>() : undefined;
                    if (v.result) {
                        const args: Expr[] = [];
                        let head = v.result;
                        while (head.t === "app") { args.unshift(head.a); head = head.f; }
                        t = { k: "variant", name: d.name, indexed, args: (d.parameters ?? []).map((_, n) => {
                            const arg = args[n];
                            return arg?.t === "var" && parameters.has(arg.name) ? parameters.get(arg.name)! : variable();
                        }) };
                    }
                    // A field of a concrete type converts its value as a typed
                    // parameter does (Circle 2 holds 2.0); a type parameter does not.
                    for (const field of [...v.fields ?? []].reverse()) {
                        const type = typeExpr(field, own, captures);
                        t = fn(type, t, undefined, !variables(type).size);
                    }
                    if (v.tag === d.name) t = { ...t, shared: true } as Ty;
                    scope.set(v.tag, { type: t, declaration: d });
                }
                // A constructor's logic is a clause of its fields giving a value
                // of its type (Percent (Float x) = x > 100 ? Percent 100.0 : _).
                for (const v of d.variants) {
                    if (!v.logic) continue;
                    let made = resolve(infer({ t: "patternLambda", params: v.logic.params, body: v.logic.body }, scope));
                    let own = resolve(scope.get(v.tag)!.type);
                    while (made.k === "fn" && own.k === "fn") { made = resolve(made.output); own = resolve(own.output); }
                    unify(own, made, v.logic.body);
                }
            } else if (statement.t === "expr") {
                executeTopLevel(statement.value, scope);
                const type = infer(statement.value, scope);
                validate(type);
                opensModule(statement.value, scope, type);
            } else {
                // An eager binding (<-) runs where it stands; a lazy one when first used.
                const eager = statement.t === "patDef" && !!statement.eager;
                // What a top-level x <- action binds: the action's known result.
                eagerResult = undefined;
                if (eager) {
                    executed = false;
                    const ran = executeTopLevel(statement.value, scope);
                    eagerResult = { statement, known: executed ? ran : undefined };
                }
                topLevelDefinition = statement.t === "patDef" && !eager;
                creatingTopLevel = statement.t === "patDef";
                try { validate(infer(statement, scope)); }
                finally { topLevelDefinition = creatingTopLevel = false; }
            }
        } catch (error) {
            if (error && typeof error === "object" && "pos" in error && "message" in error) {
                issues.push(error as TypeIssue);
            } else throw error;
        }
    }
    // A check that still waits only because a value was symbolic must not be
    // skipped: decide it now, treating that value as unknown.
    // So must one whose operands became known after it was last seen (a check
    // a value carried, met where its type was decided: Handler (s -> s ++ "!")).
    const leftover = requirements.filter(r => { deciding = false; const waits = waiting(r); deciding = true; return !waiting(r) && (waits || carried.has(r)); });
    for (const requirement of leftover) {
        if (requirement.k === "operation" && requirement.op !== "call" && requirement.written) activeExpression = requirement.written;
        try { resolve(requirement); }
        catch (error) {
            if (error && typeof error === "object" && "pos" in error && "message" in error) issues.push(error as TypeIssue);
            else throw error;
        }
    }
    deciding = false;
    if (options.strict && dynamicBoundaries && !issues.length && firstUnbound) {
        // An unknown name is the usual cause; report it rather than the boundary count.
        const own = sourceLocations.get(firstUnbound.expr);
        const loc = own ?? (firstUnbound.within && sourceLocations.get(firstUnbound.within));
        let pos = loc?.start ?? 0, len = Math.max(1, (loc?.end ?? 1) - pos);
        const name = firstUnbound.name, word = /[A-Za-z0-9_$']/;
        const whole = (at: number) => !word.test(loc!.source![at - 1] ?? " ") && !word.test(loc!.source![at + name.length] ?? " ");
        // A pattern has no location of its own; it comes before the code it
        // matches, so the constructor is the name's last use before that.
        if (firstUnbound.inPattern && loc?.source) {
            for (let at = loc.source.lastIndexOf(name, pos - name.length); at >= 0; at = at ? loc.source.lastIndexOf(name, at - 1) : -1) {
                if (whole(at)) { pos = at; len = name.length; break; }
            }
        } else if (!own && loc?.source) {
            // A name without a location of its own: its first use in the code being checked.
            for (let at = loc.source.indexOf(name, pos); at >= 0 && at < (loc.end ?? 0); at = loc.source.indexOf(name, at + 1)) {
                if (whole(at)) { pos = at; len = name.length; break; }
            }
        }
        issues.push({ message: firstUnbound.inPattern ? `unknown constructor '${firstUnbound.name}' in a pattern` : `unbound variable '${firstUnbound.name}'`, hint: firstUnbound.hint, pos, len, source: loc?.source, file: loc?.file });
    } else if (options.strict && dynamicBoundaries && !issues.length) {
        const loc = firstUnknown && sourceLocations.get(firstUnknown);
        issues.push({ message: `cannot establish static types: ${dynamicBoundaries} unresolved dynamic boundaries; mark runtime code with Dynamic`,
            ...unknownLength ? { hint: "the checker cannot find this list's length: mark it `Dynamic`, or write a clause per pattern so each clause's length follows" } : {}, pos: loc?.start ?? 0, len: Math.max(1, (loc?.end ?? 1) - (loc?.start ?? 0)), source: loc?.source, file: loc?.file });
    }
    options.result?.(scope, new Map([...scope].filter(([name, entry]) => originalScope.get(name) !== entry)));
    return { issues, dynamicBoundaries, runtimeChecks, opaqueUse };
}
// A builtin's type as APN writes one (a -> List a), or undefined when it has
// parts APN cannot write. Type variables are named a, b, ... in order.
function signatureText(type: Ty): string | undefined {
    const names = new Map<Ty, string>();
    // level: 0 anywhere, 1 left of an arrow (arrows need parentheses), 2 an
    // argument (applications do too).
    const write = (x: Ty, level: number): string | undefined => {
        const t = resolve(x);
        const wrap = (s: string, needs: number) => level >= needs ? `(${s})` : s;
        switch (t.k) {
            case "var": {
                if (!names.has(t)) names.set(t, String.fromCharCode(97 + names.size));
                return names.get(t);
            }
            case "atom": return t.name;
            case "dynamic": return "Dynamic";
            case "fn": {
                const input = write(t.input, 1), output = write(t.output, 0);
                return input && output && wrap(`${input} -> ${output}`, 1);
            }
            case "list": {
                if (t.items?.length === 0 || t.length && !t.length.terms.size && t.length.constant === 0n) return "[]";
                const element = write(t.element, 2);
                return element && wrap(`List ${element}`, 2);
            }
            case "variant": {
                const args = t.args.map(a => write(a, 2));
                if (args.some(a => a === undefined)) return undefined;
                const name = t.name === PENDING ? "m" : t.name;
                return args.length ? wrap(`${name} ${args.join(" ")}`, 2) : name;
            }
            case "type": return "Type";
            default: return undefined;
        }
    };
    return write(type, 0);
}
// The builtin functions' types as the checker writes them (S is UInt -> UInt),
// read once from its initial scope: what typeOf shows for them.
let signatures: Map<string, string> | undefined;
export function builtinSignature(name: string): string | undefined {
    if (!signatures) {
        const found = signatures = new Map<string, string>();
        checkTypes([], { result: scope => {
            for (const [key, entry] of scope) {
                const written = entry.builtin && resolve(entry.type).k === "fn" ? signatureText(entry.type) : undefined;
                if (written) found.set(key, written);
            }
        } });
    }
    return signatures.get(name);
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
    const { Interpreter } = await import("./interp.ts");
    const { formatError } = await import("./repl.ts");
    for (const file of files) {
        let source: string;
        try { source = await Deno.readTextFile(file); }
        catch (error) { failed = true; console.error(formatFileReadError(file, error)); continue; }
        try {
            const slash = file.lastIndexOf("/");
            new Interpreter().checkingSession().prepare(parse(source, file), slash < 0 ? "." : file.slice(0, slash));
            console.log(`${file}: checked`);
        } catch (error) {
            failed = true;
            console.error(formatError(error, Deno.stderr.isTerminal()));
        }
    }
    return failed ? 1 : 0;
}
