import type { Numeric, Real } from "./numbers.ts";
import type { DefClause } from "./types.ts";

// ---------------- AST ----------------

// A binary operator's name: a built-in one (+, ==, :, ...) or one a program
// defines; its meaning and fixity come from the prelude or a definition.
export type BinOp = string;

export type UnOp = "neg" | "not";


export type Expr =
    // lo null: [..], the list type of anything.
    | { t: "computedRange"; lo: Expr | null; second: Expr | null; hi: Expr | null }
    | { t: "import"; module: string | string[] }
    | { t: "numeric"; v: Numeric }
    | { t: "rationalRange"; lo: Real; step: Real; hi: Real | null }
    | { t: "int"; v: bigint }
    | { t: "float"; v: number }
    | { t: "bool"; v: boolean }
    | { t: "string"; v: string }
    | { t: "char"; v: string }
    | { t: "placeholder" }
    | { t: "var"; name: string }
    | { t: "binop"; op: BinOp; l: Expr; r: Expr }
    | { t: "unop"; op: UnOp; e: Expr }
    | { t: "app"; f: Expr; a: Expr }
    | { t: "patternLambda"; params: Pattern[]; body: Expr; guard?: Expr }
    | { t: "lambda"; params: string[]; body: Expr }
    | { t: "ternary"; cond: Expr; then: Expr; els: Expr }
    | { t: "list"; v: Expr[] }
    | { t: "record"; v: Array<[string, Expr]> }
    | { t: "recordAccess"; rec: Expr; field: string; argument?: Expr; scoped?: boolean }
    | { t: "pluck"; rec: Expr; entries: Array<string | [string, string]>; values?: Expr; quoted?: boolean }
    | { t: "setItem"; rec: Expr; index: Expr; value: Expr }
    | { t: "setFields"; rec: Expr; entries: string[]; value: Expr; path?: string[]; aliases?: string[] }
    | { t: "floatRange"; lo: number; step: number; hi: number | null }
    | { t: "range"; lo: bigint; step: bigint; hi: bigint | null }
    | { t: "pipe"; x: Expr; f: Expr }
    | { t: "block"; stmts: Expr[]; style?: "(" | "{" }
    | { t: "stmDef"; name: string; clauses: { params: Pattern[]; body: Expr }[] }
    | { t: "patDef"; pattern: Pattern; value: Expr; eager?: boolean; update?: { name: string; value: Expr; error?: string } };

export type Pattern =
    | { p: "as"; left: Pattern; right: Pattern }
    | { p: "schema"; type: Expr; value: Pattern }
    | { p: "wildcard" }
    | { p: "var"; name: string }
    | { p: "int"; v: bigint }
    | { p: "bool"; v: boolean }
    | { p: "string"; v: string }
    | { p: "char"; v: string }
    | { p: "float"; v: number }
    | { p: "list"; v: Pattern[] }
    // An infix constructor pattern: head :: tail, or head op tail for an operator
    // starting with ':' (op, when not ::), matching the constructor op names.
    | { p: "cons"; head: Pattern; tail: Pattern; op?: string }
    | { p: "typeBind"; name: string; value: Pattern }
    | { p: "constr"; tag: string; args: Pattern[] }
    | { p: "recPat"; v: Array<[string, string]> }
    | { p: "range"; lo: bigint; hi: bigint };

// A variant's result is the type it makes when not the family's own (an
// indexed family: Cons a (Vec k a) -> Vec (S k) a). Its logic, if any, is the
// clause applying it runs (Percent (Float x) = x > 100 ? Percent 100.0 : _),
// its _ already the raw value, intrinsics.tag owner Percent [x].
export interface ConstructorLogic { params: Pattern[]; body: Expr; owner: { t: "var"; name: string } }
// claims: a union claiming constructors declared with _ (see claimedDeclaration).
export interface DataDef { name: string; parameters?: string[]; variants: DataVariant[]; claims?: boolean; }
export type DataVariant = { tag: string; arity: number; fields?: Expr[]; result?: Expr; logic?: ConstructorLogic };

// A range of a type is the list type, one type repeated: [Int..], not
// [Int,String..] or [Int..String].
export const LIST_TYPE_RANGE = "a list type is one type repeated, written [Int..]";
// Whether an expression holds _ as a value (a constructor's logic does).
export function holdsPlaceholder(e: unknown): boolean {
    if (!e || typeof e !== "object") return false;
    if ((e as { t?: string }).t === "placeholder") return true;
    return Object.values(e).some(holdsPlaceholder);
}
// The expression with each _ replaced by the given one, in place (so its
// nodes keep their source locations).
export function fillPlaceholders(e: Expr, by: Expr): Expr {
    if (e.t === "placeholder") return by;
    const go = (x: Record<string, unknown>): void => {
        for (const [key, child] of Object.entries(x)) {
            if (!child || typeof child !== "object" || child === by) continue;
            if ((child as { t?: string }).t === "placeholder") x[key] = by;
            else go(child as Record<string, unknown>);
        }
    };
    go(e as unknown as Record<string, unknown>);
    return e;
}

// What X params = A | B is, by what its alternatives' names are bound to
// where it runs: all new, it declares them as constructors; all existing
// types, it is the union of them (unionClause). Anything else is an error,
// worded once here for the runtime and the checker.
// unclaimed: a constructor declared with _ that no union owns yet.
export type Alternative = "new" | "type" | "constructor" | "unclaimed";
export function unionKind(def: DataDef, kind: (name: string) => Alternative): "declaration" | "union" | "claim" | string {
    if (def.claims) return "declaration";
    const kinds = def.variants.map(v => v.tag === "[]" || v.tag === "::" ? "new" : kind(v.tag));
    if (kinds.every(k => k === "new")) return "declaration";
    // The first union listing constructors declared with _ owns them.
    const unclaimed = kinds.filter(k => k === "unclaimed").length;
    if (unclaimed === kinds.length) return "claim";
    if (unclaimed) return unclaimedMix(def.name, def.variants.find((_, n) => kinds[n] !== "unclaimed")!.tag);
    // One type is no union: a leading | declares a constructor (Box a = | Box a).
    if (kinds.every(k => k === "type")) {
        return kinds.length > 1 ? "union" : `${def.name} = | ${def.variants[0].tag} declares a constructor, and ${def.variants[0].tag} is a type already (a built-in type cannot be replaced)`;
    }
    const owned = def.variants.find((_, n) => kinds[n] === "constructor");
    if (owned) return `${def.name}'s alternative ${owned.tag} is a constructor of another type; a union lists types`;
    const [type, fresh] = [def.variants.find((_, n) => kinds[n] === "type")!, def.variants.find((_, n) => kinds[n] === "new")!];
    return `${def.name} mixes a type (${type.tag}) and a new constructor (${fresh.tag}): its alternatives are all types (a union) or all new (a declaration)`;
}
export function unclaimedMix(name: string, other: string): string {
    return `${name} unions constructors declared with _, and ${other} is not one`;
}
// An enumeration (constructors without fields) gives each value its position
// as an Int: Direction = North | East declares to Int North = 0 and
// to Int East = 1 with it, so a value indexes and counts as that Int.
export function enumerationPositions(def: DataDef): DefClause[] | undefined {
    if (def.parameters?.length || def.variants.some(v => v.arity || v.result || v.logic)) return undefined;
    return def.variants.map((v, n) => ({
        params: [{ p: "constr", tag: "Int", args: [] }, { p: "constr", tag: v.tag, args: [] }],
        body: { t: "int", v: BigInt(n) },
    }));
}
// The declaration a union claiming constructors declared with _ makes: each
// takes the fields its alternative gives (Some a), or its own (Some), and its
// logic, whose raw values now belong to this type.
export function claimedDeclaration(def: DataDef, own: (tag: string) => DataVariant): DataDef {
    const variants = def.variants.map(v => {
        const declared = own(v.tag);
        if (declared.logic) declared.logic.owner.name = def.name;
        return { ...v.arity || !declared.arity ? v : { tag: declared.tag, arity: declared.arity, fields: declared.fields ?? [] }, ...declared.logic ? { logic: declared.logic } : {} };
    });
    return { name: def.name, parameters: def.parameters, variants, claims: true };
}
// A union of existing types, as the definition X params = intrinsics.union [A, B].
export function unionClause(def: DataDef): DefClause {
    const alternatives = def.variants.map(v => (v.fields ?? []).reduce<Expr>((f, a) => ({ t: "app", f, a }), { t: "var", name: v.tag }));
    const union: Expr = { t: "recordAccess", rec: { t: "var", name: "intrinsics" }, field: "union" };
    return { params: (def.parameters ?? []).map(name => ({ p: "var", name })), body: { t: "app", f: union, a: { t: "list", v: alternatives } } };
}

// How a type function of lists makes its length from its index n, read off
// its clauses by induction: F Z a = d elements and F (S k) a = c elements
// :: F k a (each of type a) give the length c * n + d. Vect's (Vect Z a = []
// and Vect (S k) a = a :: Vect k a) is n; Pairs's, two elements a step, 2n.
// The runtime and the checker know such a function's lengths everywhere, as
// a list's (see Counting); any other is run as its clauses are.
export type Counting = { scale: bigint; offset: bigint };
export function countingOf(name: string, clauses: { params: Pattern[]; body: Expr }[]): Counting | undefined {
    if (clauses.length !== 2 || clauses.some(c => c.params.length !== 2)) return undefined;
    const unwrap = (e: Expr): Expr => e.t === "block" && e.stmts.length === 1 ? unwrap(e.stmts[0]) : e;
    const zero = (p: Pattern) => p.p === "constr" && p.tag === "Z" && !p.args.length || p.p === "int" && p.v === 0n;
    const base = clauses.find(c => zero(c.params[0])), step = clauses.find(c => c !== base);
    if (!base || !step || base.params[1].p !== "var" || step.params[1].p !== "var") return undefined;
    const [next] = step.params, element = step.params[1].name, is = (e: Expr | undefined, v: string) => e?.t === "var" && e.name === v;
    if (next.p !== "constr" || next.tag !== "S" || next.args.length !== 1 || next.args[0].p !== "var") return undefined;
    // The base's elements, a list of the element type.
    const empty = unwrap(base.body);
    if (empty.t !== "list" || !empty.v.every(x => is(unwrap(x), base.params[1].p === "var" ? base.params[1].name : ""))) return undefined;
    // The step's: elements :: F k a.
    let scale = 0n, rest = unwrap(step.body);
    while (rest.t === "binop" && rest.op === "::" && is(unwrap(rest.l), element)) { scale++; rest = unwrap(rest.r); }
    const args: Expr[] = [];
    while (rest.t === "app") { args.unshift(unwrap(rest.a)); rest = unwrap(rest.f); }
    if (!scale || !is(rest, name) || args.length !== 2 || !is(args[0], next.args[0].name) || !is(args[1], element)) return undefined;
    return { scale, offset: BigInt(empty.v.length) };
}

// Methods: a definition of one adds an instance (map f (Some x) = ...,
// return = Some, throw _ = None) instead of binding the name.
export const METHODS = new Set(["map", ">>=", "<*>", "return", "throw", "to", "from"]);
// The math functions, get and with: clauses for one overload it, as clauses for an
// operator do (sin (Dual a b) = ...); other arguments keep its previous meaning.
export const OVERLOADED_FUNCTIONS = new Set(["sqrt", "exp", "log", "sin", "cos", "tan", "asin", "acos", "atan",
    "atan2", "abs", "floor", "ceiling", "truncate", "round", "min", "max", "get", "with"]);

export type TopLevel = { t: "def"; name: string; clauses: DefClause[] } | { t: "expr"; value: Expr }
    | { t: "type"; def: DataDef }
    | { t: "patDef"; pattern: Pattern; value: Expr; eager?: boolean; update?: { name: string; value: Expr; error?: string } };

// ---------------- Lexer ----------------


// A type applied to its parameters and one more pattern is a typed pattern:
// (Vec n a xs) is ((Vec n a) xs), as (Vect n a xs) is. (Option t), with just
// the parameters, still matches a type value. parameters gives a type name's
// parameter count, or undefined for a name that is not a type.
// Each pattern is read once per parameter count, so the checker and the run
// share one typed pattern (and its type expression) for it.
const flatTyped = new WeakMap<Pattern, Map<number, Pattern | undefined>>();
export function flatTypedPattern(p: Pattern, parameters: (name: string) => number | undefined): Pattern | undefined {
    if (p.p !== "constr") return undefined;
    const count = parameters(p.tag);
    if (!count || p.args.length !== count + 1) return undefined;
    let read = flatTyped.get(p);
    if (!read) flatTyped.set(p, read = new Map());
    if (!read.has(count)) read.set(count, readFlatTyped(p));
    return read.get(count);
}
function readFlatTyped(p: Extract<Pattern, { p: "constr" }>): Pattern | undefined {
    const typeArg = (q: Pattern): Expr | undefined => {
        if (q.p === "var") return { t: "var", name: q.name };
        if (q.p === "wildcard") return { t: "placeholder" };
        if (q.p === "int") return { t: "int", v: q.v };
        if (q.p !== "constr") return undefined;
        const args = q.args.map(typeArg);
        return args.every(a => a) ? args.reduce<Expr>((f, a) => ({ t: "app", f, a: a! }), { t: "var", name: q.tag }) : undefined;
    };
    const args = p.args.slice(0, -1).map(typeArg);
    if (args.some(a => !a)) return undefined;
    return { p: "schema", type: args.reduce<Expr>((f, a) => ({ t: "app", f, a: a! }), { t: "var", name: p.tag }), value: p.args[p.args.length - 1] };
}
// Does an expression read any of these names? Any mention counts, so code
// joined after a list's bindings runs again only where it may read them.
export function mentions(e: unknown, names: Set<string>): boolean {
    if (!e || typeof e !== "object" || !names.size) return false;
    if (Array.isArray(e)) return e.some(x => mentions(x, names));
    const node = e as Record<string, unknown>;
    if ((node.t === "var" && names.has(node.name as string)) || (node.t === "binop" && names.has(node.op as string))) return true;
    return Object.values(node).some(x => x && typeof x === "object" && mentions(x, names));
}
// Rewrite every infix pattern whose operator names a constructor ((::) = Cons)
// to that constructor's pattern (x :: xs is Cons x xs), in place.
export function rewriteInfixConstructors(node: unknown, tagOf: (op: string) => string | undefined): void {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(x => rewriteInfixConstructors(x, tagOf)); return; }
    const n = node as Record<string, unknown>;
    for (const value of Object.values(n)) if (value && typeof value === "object") rewriteInfixConstructors(value, tagOf);
    if (n.p !== "cons") return;
    const tag = tagOf((n.op as string | undefined) ?? "::");
    if (!tag) return;
    const args = [n.head, n.tail];
    for (const key of Object.keys(n)) delete n[key];
    Object.assign(n, { p: "constr", tag, args });
}
// A pattern with every flat typed pattern in it read as its typed form,
// copied where that changes it: the pattern as written stays as it is.
export function typedForm(p: Pattern, parameters: (name: string) => number | undefined): Pattern {
    const read = flatTypedPattern(p, parameters) ?? p;
    const isPattern = (x: unknown): x is Pattern => !!x && typeof x === "object" && "p" in x;
    let changed = read !== p;
    const copy: Record<string, unknown> = { ...read };
    for (const [key, value] of Object.entries(read)) {
        const parts = Array.isArray(value) ? value.map(x => isPattern(x) ? typedForm(x, parameters) : x) : isPattern(value) ? typedForm(value, parameters) : value;
        if (Array.isArray(value) ? (parts as unknown[]).some((x, n) => x !== value[n]) : parts !== value) { copy[key] = parts; changed = true; }
    }
    return changed ? copy as Pattern : p;
}

// Source metadata is kept out of AST serialization and source round-trips.
export interface SourceLocation { source: string; file: string; start: number; end: number; }
export const sourceLocations = new WeakMap<Expr, SourceLocation>();

// A match of a value against written one-parameter alternatives, the core form
// sugar expands into. The runtime and the checker run and type a sugar node as
// its expansion; the written node stays for printing and tools.
export type PatternLambda = Extract<Expr, { t: "patternLambda" }>;
export type CoreMatch = { value: Expr; alternatives: PatternLambda[] };
const expansions = new WeakMap<Expr, CoreMatch>();
// c ? a : b is match (!c) [false -> a, true -> b]: ! gives the condition's
// truthiness, as syntax no binding can shadow, and each part keeps its place
// in the source.
export function ternaryMatch(e: Extract<Expr, { t: "ternary" }>): CoreMatch {
    let core = expansions.get(e);
    if (core) return core;
    const at = (x: Expr, source: Expr) => { const place = sourceLocations.get(source); if (place) sourceLocations.set(x, place); return x; };
    const branch = (v: boolean, body: Expr): PatternLambda => at({ t: "patternLambda", params: [{ p: "bool", v }], body }, body) as PatternLambda;
    core = { value: at({ t: "unop", op: "not", e: e.cond }, e.cond), alternatives: [branch(false, e.then), branch(true, e.els)] };
    expansions.set(e, core);
    return core;
}
// match x [alternatives] written with one-parameter lambdas, whose match the
// caller has found to be the builtin one. A lambda's parameter is a pattern
// that is a name (n -> n + 1).
const namedAlternatives = new WeakMap<Expr, PatternLambda>();
export function writtenMatch(e: Expr): CoreMatch | undefined {
    if (e.t !== "app" || e.f.t !== "app" || e.a.t !== "list" || !e.a.v.length) return undefined;
    if (expansions.has(e)) return expansions.get(e);
    const alternatives: PatternLambda[] = [];
    for (const x of e.a.v) {
        if (x.t === "patternLambda" && x.params.length === 1) alternatives.push(x);
        else if (x.t === "lambda" && x.params.length === 1) {
            let named = namedAlternatives.get(x);
            if (!named) {
                const [name] = x.params;
                named = { t: "patternLambda", params: [name === "_" ? { p: "wildcard" } : { p: "var", name }], body: x.body };
                const place = sourceLocations.get(x);
                if (place) sourceLocations.set(named, place);
                namedAlternatives.set(x, named);
            }
            alternatives.push(named);
        } else return undefined;
    }
    const core = { value: e.f.a, alternatives };
    expansions.set(e, core);
    return core;
}

// A function whose body matches its parameters in order (x -> match x
// alternatives, or match [x, y] for two) is the function of the
// alternatives as clauses: clauses are a match on the arguments. Not when
// an alternative is guarded or reads a parameter, nor when two have
// equivalent patterns (the later never runs; as clauses they would overload).
// builtinMatch: whether match there is the builtin one.
export function matchedClauses(params: Pattern[], body: Expr, builtinMatch: boolean): { params: Pattern[]; body: Expr }[] | undefined {
    const names = params.map(p => p.p === "var" ? p.name : "");
    if (!names.length || names.includes("") || new Set(names).size !== names.length || names.includes("match")) return undefined;
    while (body.t === "block" && body.stmts.length === 1) body = body.stmts[0];
    const written = builtinMatch && body.t === "app" && body.f.t === "app" && body.f.f.t === "var" && body.f.f.name === "match" ? writtenMatch(body) : undefined;
    if (!written) return undefined;
    const { value } = written, parameter = (e: Expr, n: number) => e.t === "var" && e.name === names[n];
    if (!(names.length === 1 && parameter(value, 0)) && !(value.t === "list" && value.v.length === names.length && value.v.every(parameter))) return undefined;
    const clauses: { params: Pattern[]; body: Expr }[] = [];
    for (const { params: [p], body, guard } of written.alternatives) {
        if (guard || mentions(body, new Set(names.filter(name => !patternNames(p).includes(name))))) return undefined;
        if (names.length === 1) clauses.push({ params: [p], body });
        else if (p.p === "list" && p.v.length === names.length) clauses.push({ params: p.v, body });
        else return undefined;
    }
    const keys = clauses.map(c => clauseKey("", c));
    return new Set(keys).size === keys.length ? clauses : undefined;
}
// The names a pattern binds.
export function patternNames(p: Pattern): string[] {
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
// Clauses with equivalent patterns (and guards): parameter names do not
// matter (f (Int x) and f (Int y) are the same), and _ is a name nothing uses.
export function clauseKey(name: string, clause: { params: Pattern[]; guard?: Expr }): string {
    const names = new Map<string, number>([[name, -1]]);
    let unused = 0;
    return JSON.stringify([clause.params, clause.guard ?? null], (field, value) => {
        if (value && typeof value === "object" && value.p === "wildcard") return { p: "var", name: `\0${unused++}` };
        if (field === "name") { if (!names.has(value)) names.set(value, names.size); return names.get(value); }
        return typeof value === "bigint" ? `${value}n` : value;
    });
}

// A function's clauses after more are defined for it: a clause with an
// equivalent pattern and the same result type rebinds that clause in place;
// one with another result type overloads it, as does any other clause, added
// after the existing ones. result gives a clause's result type when known.
export function mergeClauses<C extends { params: Pattern[]; guard?: Expr }>(name: string, existing: C[], added: C[], result: (clause: C) => string | undefined = () => undefined): C[] {
    const out = [...existing];
    for (const clause of added) {
        const k = clauseKey(name, clause);
        const same = out.flatMap((c, i) => clauseKey(name, c) === k ? [i] : []);
        if (!same.length) { out.push(clause); continue; }
        // Only clauses with equal patterns need their result types.
        const head = result(clause);
        const i = same.find(j => head === undefined || result(out[j]) === undefined || result(out[j]) === head);
        if (i === undefined) out.push(clause); else out[i] = clause;
    }
    return out;
}

// A direct load call (load "file", load $ path): <- may bind its exports.
export function isLoadCall(e: Expr): boolean {
    if (e.t === "block" && e.style === "(" && e.stmts.length === 1) return isLoadCall(e.stmts[0]);
    return (e.t === "app" || e.t === "pipe") && e.f.t === "var" && e.f.name === "load";
}

