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

// A family of lists counting its elements, as Vect is in the prelude:
// F n a = [] -> F Z a | a :: F k a -> F (S k) a (Z or 0, S k or k + 1).
// Such a family is the length-indexed list.
export function countingFamily(def: DataDef): boolean {
    const nil = def.variants.find(v => v.tag === "[]"), cons = def.variants.find(v => v.tag === "::");
    if (def.variants.length !== 2 || !nil?.result || !cons?.result || def.parameters?.length !== 2) return false;
    const unwrap = (e: Expr): Expr => e.t === "block" && e.stmts.length === 1 ? unwrap(e.stmts[0]) : e;
    const spine = (e: Expr): [Expr, Expr[]] => {
        e = unwrap(e);
        const args: Expr[] = [];
        while (e.t === "app") { args.unshift(unwrap(e.a)); e = unwrap(e.f); }
        return [e, args];
    };
    const name = (e: Expr | undefined) => e?.t === "var" && /^[a-z]/.test(e.name) ? e.name : undefined;
    const family = (e: Expr | undefined, n: number) => { if (!e) return undefined; const [head, args] = spine(e); return head.t === "var" && head.name === def.name && args.length === n ? args : undefined; };
    const empty = family(nil.result, 2), whole = family(cons.result, 2), tail = family(cons.fields?.[1], 2);
    const element = name(cons.fields?.[0] && unwrap(cons.fields[0])), k = name(tail?.[0]);
    if (!empty || !whole || !tail || !element || !k || !name(empty[1]) || name(tail[1]) !== element || name(whole[1]) !== element) return false;
    const zero = empty[0], next = whole[0];
    const isZero = zero.t === "var" && zero.name === "Z" || zero.t === "int" && zero.v === 0n;
    const one = (e: Expr) => e.t === "int" && e.v === 1n;
    const isNext = next.t === "app" && unwrap(next.f).t === "var" && (unwrap(next.f) as { name: string }).name === "S" && name(unwrap(next.a)) === k ||
        next.t === "binop" && next.op === "+" && (name(unwrap(next.l)) === k && one(unwrap(next.r)) || one(unwrap(next.l)) && name(unwrap(next.r)) === k);
    return isZero && isNext;
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

