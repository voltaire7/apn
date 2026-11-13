import type { Numeric, Real } from "./numbers.ts";
import type { DefClause } from "./types.ts";
import { APNError } from "./errors.ts";

// ---------------- AST ----------------

// A binary operator's name: a built-in one (+, ==, :, ...) or one a program
// defines; its meaning and fixity come from the prelude or a definition.
export type BinOp = string;

export type UnOp = "neg" | "not";


export type Expr =
    // lo null: [..], the list type of anything.
    | { t: "range"; lo: Expr; second: Expr | null; hi: Expr | null }
    | { t: "numeric"; v: Numeric }
    | { t: "int"; v: bigint }
    | { t: "float"; v: number }
    | { t: "bool"; v: boolean }
    | { t: "string"; v: string }
    | { t: "char"; v: string }
    | { t: "placeholder" }
    | { t: "var"; name: string }
    // reassociate: a chain holding an operator of a fixity its file cannot
    // see, regrouped where it runs (see parser.ts reassociate).
    | { t: "binop"; op: BinOp; l: Expr; r: Expr; reassociate?: true }
    | { t: "unop"; op: UnOp; e: Expr }
    // ascribed: e : T as the parser expands it, the one application of a type to a value.
    | { t: "app"; f: Expr; a: Expr; ascribed?: true }
    | { t: "patternLambda"; params: Pattern[]; body: Expr; guard?: Expr }
    | { t: "lambda"; params: string[]; body: Expr }
    | { t: "ternary"; cond: Expr; then: Expr; els: Expr }
    | { t: "list"; v: Expr[] }
    // items: a record written as a list literal keeps its items as code;
    // declared: its fields written with their type (x : T, x : T = v).
    | { t: "record"; v: Array<[string, Expr]>; items?: Expr[]; declared?: string[] }
    | { t: "recordAccess"; rec: Expr; field: string; argument?: Expr; scoped?: boolean }
    | { t: "pluck"; rec: Expr; entries: Array<string | [string, string]>; values?: Expr; quoted?: boolean }
    | { t: "setItem"; rec: Expr; index: Expr; value: Expr }
    | { t: "setFields"; rec: Expr; entries: string[]; value: Expr; path?: string[]; aliases?: string[] }
    | { t: "pipe"; x: Expr; f: Expr }
    | { t: "block"; stmts: Expr[]; style?: "(" | "{" }
    | { t: "stmDef"; name: string; clauses: { params: Pattern[]; body: Expr }[] }
    // A type declared in a block, as at the top level (Color = Red | Green).
    | { t: "typeDef"; def: DataDef }
    | { t: "patDef"; pattern: Pattern; value: Expr; eager?: boolean; update?: { name: string; value: Expr; error?: string } };

export type Pattern =
    | { p: "as"; left: Pattern; right: Pattern; written?: Pattern }
    | { p: "schema"; type: Expr; value: Pattern; written?: Pattern }
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
    // typed: a type's pattern the parser made from (p : T), the one way to write it.
    | { p: "constr"; tag: string; args: Pattern[]; typed?: true; head?: true }
    | { p: "recPat"; v: Array<[string, string]> }
    | { p: "range"; lo: bigint; hi: bigint };

// A variant's result is the type it makes when not the family's own (an
// indexed family: Cons a (Vec k a) -> Vec (S k) a). Its logic, if any, is the
// clauses applying it runs: its rules written before it (Add x Zero = x), then
// the clause declaring it (Percent (Float x) = x > 100 ? Percent 100.0 : _),
// whose _ is already the raw value, intrinsics.tag owner Percent [x].
export interface ConstructorLogic { clauses: DefClause[]; owner: { t: "var"; name: string } }
// extends: constructors declared into a type by name (Square (x : Float) :
// Shape = _), added to it where it is already declared (see extendedDeclaration).
export interface DataDef { name: string; parameters?: string[]; variants: DataVariant[]; extends?: boolean; }
export type DataVariant = { tag: string; arity: number; fields?: Expr[]; result?: Expr; logic?: ConstructorLogic };

// A range of a type repeats it ([Int..]); a type has no step or bound.
export const TYPE_RANGE = "a range of a type repeats it, without a step or bound: [Int..]";
// Whether an expression holds _ as a value (a constructor's logic does), not
// as the any a type is given (List _).
export function holdsPlaceholder(e: unknown): boolean {
    if (!e || typeof e !== "object") return false;
    const node = e as { t?: string; f?: Expr; name?: string };
    if (node.t === "placeholder") return true;
    if (node.t === "app") {
        let head = e as Expr;
        while (head.t === "app") head = head.f;
        if (head.t === "var" && /^[A-Z]/.test(head.name)) return false;
    }
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
// declared: a constructor declared alone (Circle (r : Float) = _), its own type.
export type Alternative = "new" | "type" | "constructor" | "declared";
export function unionKind(def: DataDef, kind: (name: string) => Alternative): "declaration" | "union" | string {
    if (def.extends) return "declaration";
    // A list's own alternatives are list types (Pairs a = [] | a :: a :: Pairs a);
    // in a family of lists, where each says its index, they are its clauses.
    // A constructor that is its own type (Box a = | Box a, Type = _) is new
    // where it is declared, shadowing any type of that name, built-in too.
    const kinds = def.variants.map(v => v.tag === "[]" || v.tag === "::" ? v.result ? "new" : "type" : v.tag === def.name ? "new" : kind(v.tag));
    if (kinds.every(k => k === "new")) return "declaration";
    // A union declares its constructors; one declared alone is its own
    // type's, and is declared into another by naming it there.
    const declared = def.variants.find((_, n) => kinds[n] === "declared");
    if (declared) return `${def.name} = ... declares ${declared.tag}, and ${declared.tag} is declared already; declare it into ${def.name} where it is: ${declared.tag} ... : ${[def.name, ...def.parameters ?? []].join(" ")} = _`;
    // One type is no union: a leading | declares a constructor (Box a = | Box a).
    // Types joined without parentheses declare nothing: their union is an
    // expression, X = (A | B); only a union of list types is written bare.
    if (kinds.every(k => k === "type")) {
        if (kinds.length === 1) return `${def.name} = | ${def.variants[0].tag} declares a constructor, and ${def.variants[0].tag} is a type already (a built-in type cannot be replaced)`;
        if (def.variants.every(v => v.tag === "[]" || v.tag === "::")) return "union";
        return `${def.name} = ${def.variants.map(v => v.tag).join(" | ")} declares constructors, and ${def.variants.find(v => v.tag !== "[]" && v.tag !== "::")!.tag} is a type already; their union is written in parentheses: ${def.name}${def.parameters?.length ? " " + def.parameters.join(" ") : ""} = (${def.variants.map(v => v.tag).join(" | ")})`;
    }
    const owned = def.variants.find((_, n) => kinds[n] === "constructor");
    if (owned) return `${def.name}'s alternative ${owned.tag} is a constructor of another type; a union lists types`;
    const [type, fresh] = [def.variants.find((_, n) => kinds[n] === "type")!, def.variants.find((_, n) => kinds[n] === "new")!];
    return `${def.name} mixes a type (${type.tag}) and a new constructor (${fresh.tag}): its alternatives are all types (a union) or all new (a declaration)`;
}
// Nil and Cons a (X a) in a union, by what their names are bound to (the
// empty list and the list's cons, as the prelude names them), are the list's
// own alternatives, as [] and a :: X a are: List a = Nil | Cons a (List a).
export function listAlternatives(def: DataDef, bound: (tag: string) => "nil" | "cons" | undefined): DataDef {
    if (def.extends) return def;
    let changed = false;
    const variants = def.variants.map(v => {
        const kind = v.tag === "[]" || v.tag === "::" ? undefined : bound(v.tag);
        if (!(kind === "nil" && !v.arity || kind === "cons" && v.arity === 2)) return v;
        changed = true;
        return { ...v, tag: kind === "nil" ? "[]" : "::" };
    });
    return changed ? { ...def, variants } : def;
}
// A family of lists (after listAlternatives) is a type function's clauses: each
// alternative, [] -> Vect Z a or a :: Vect k a -> Vect (S k) a, is the
// clause its result names, Vect Z a = [] or Vect (S k) a = a :: Vect k a.
export function listClauses(variants: DataVariant[]): DefClause[] {
    const pattern = (e: Expr): Pattern => {
        while (e.t === "block" && e.stmts.length === 1) e = e.stmts[0];
        if (e.t === "int") return { p: "int", v: e.v };
        // k + 1 is the natural after k, as S k is.
        if (e.t === "binop" && e.op === "+" && e.l.t === "var" && e.r.t === "int" && e.r.v === 1n) return { p: "constr", tag: "S", args: [pattern(e.l)] };
        if (e.t === "var") return e.name === "_" ? { p: "wildcard" } : /^[A-Z]/.test(e.name) ? { p: "constr", tag: e.name, args: [] } : { p: "var", name: e.name };
        const args: Expr[] = [];
        let head: Expr = e;
        while (head.t === "app") { args.unshift(head.a); head = head.f; }
        if (head.t === "var" && /^[A-Z]/.test(head.name)) return { p: "constr", tag: head.name, args: args.map(pattern) };
        throw new APNError("parse", "a family's index is a pattern: a name, a number, Z, S k or k + 1");
    };
    return variants.map(v => {
        const args: Expr[] = [];
        let head: Expr = v.result!;
        while (head.t === "app") { args.unshift(head.a); head = head.f; }
        const body: Expr = v.tag === "[]" ? { t: "list", v: [] } : { t: "binop", op: "::", l: v.fields![0], r: v.fields![1] };
        return { params: args.map(pattern), body };
    });
}

// A union of a list's own alternatives is a union of list types, unfolded as
// a value is read (see Interpreter.belongsToType). One of this shape,
// X a = [] | a :: X a, is the type of lists of a, endless ones among them (its
// unfoldings never end): the runtime and the checker read it as their list
// type, as countingOf reads a family's lengths. The prelude declares List so;
// any of this shape is the same type.
export function listUnion(def: DataDef): boolean {
    const [element] = def.parameters ?? [], unwrap = (e?: Expr): Expr | undefined => e?.t === "block" && e.stmts.length === 1 ? unwrap(e.stmts[0]) : e;
    const is = (e: Expr | undefined, name: string) => unwrap(e)?.t === "var" && (unwrap(e) as { name: string }).name === name;
    const empty = def.variants.find(v => v.tag === "[]"), cons = def.variants.find(v => v.tag === "::");
    const rest = unwrap(cons?.fields?.[1]);
    return def.parameters?.length === 1 && def.variants.length === 2 && !!empty && !!cons && def.variants.every(v => !v.result) &&
        is(cons.fields?.[0], element) && rest?.t === "app" && is(rest.f, def.name) && is(rest.a, element);
}
// An enumeration (constructors without fields) gives each value its position
// as an Int: Direction = North | East declares to Int North = 0 and
// to Int East = 1 with it, so a value indexes and counts as that Int.
export function enumerationPositions(def: DataDef): DefClause[] | undefined {
    if (!def.variants.length || def.parameters?.length || def.variants.some(v => v.arity || v.result || v.logic)) return undefined;
    return def.variants.map((v, n) => ({
        params: [{ p: "constr", tag: "Int", args: [] }, { p: "constr", tag: v.tag, args: [] }],
        body: { t: "int", v: BigInt(n) },
    }));
}
// A type with constructors declared into it (Circle (x : Float) : Shape = _
// after Shape's other constructors): its variants and the new ones, which
// replace any of the same name; the new ones' type parameters are renamed to
// the type's (Some x : Option x = _ after None : Option a = _).
export function extendedDeclaration(existing: DataDef, added: DataDef): DataDef {
    const ours = existing.parameters ?? [], theirs = added.parameters ?? [];
    if (ours.length !== theirs.length) throw new APNError("parse", `${added.name} takes ${ours.length} type parameter${ours.length === 1 ? "" : "s"}, as declared`, { hint: `${added.variants[0].tag} ... : ${[added.name, ...ours].join(" ")} = _` });
    const names = new Map(theirs.map((name, n) => [name, ours[n]]));
    const rename = <T>(e: T): T => {
        if (!e || typeof e !== "object") return e;
        if (Array.isArray(e)) return e.map(rename) as T;
        const node = e as Record<string, unknown>;
        if (node.t === "var" && typeof node.name === "string" && names.has(node.name)) return { ...node, name: names.get(node.name) } as T;
        return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, key === "logic" ? value : rename(value)])) as T;
    };
    const variants = added.variants.map(rename);
    const tags = new Set(variants.map(v => v.tag));
    return { ...existing, variants: [...existing.variants.filter(v => !tags.has(v.tag)), ...variants], extends: true };
}
// Whether a definition's body is a union of types (see unionClause): a union
// of list types declared with parameters (Pairs a = [] | a :: a :: Pairs a)
// is read from a value, not computed from known arguments.
export function isUnionBody(e: Expr): boolean {
    return e.t === "app" && e.f.t === "recordAccess" && e.f.field === "union" && e.f.rec.t === "var" && e.f.rec.name === "intrinsics";
}
// A union of existing types, as the definition X params = intrinsics.union [A, B];
// a list's own alternatives are the list types they write ([], a :: X a).
export function unionClause(def: DataDef): DefClause {
    const alternatives = def.variants.map((v): Expr => v.tag === "[]" ? { t: "list", v: [] }
        : v.tag === "::" ? { t: "binop", op: "::", l: v.fields![0], r: v.fields![1] }
        : (v.fields ?? []).reduce<Expr>((f, a) => ({ t: "app", f, a }), { t: "var", name: v.tag }));
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

// The types a clause is written for, as the names it writes them with: each
// constructor or type its parameters' patterns name (a list's [] and :: name
// List), and, for a clause overloaded on its result (return x = Parser (...),
// throw = Err), the constructor its body makes. A definition for a type its
// own scope declares joins the function it is named after wherever the
// type's values go.
export function clauseTypeNames(clause: { params: Pattern[]; body: Expr }): { params: string[]; result?: string } {
    const params: string[] = [];
    const head = (e: Expr): string | undefined => {
        while (e.t === "app") e = e.f;
        return e.t === "var" && /^[A-Z]/.test(e.name) ? e.name : undefined;
    };
    const walk = (p: Pattern): void => {
        if (p.p === "constr") { params.push(p.tag); p.args.forEach(walk); }
        else if (p.p === "list") { params.push("List"); p.v.forEach(walk); }
        else if (p.p === "cons") { params.push(p.op && p.op !== "::" ? p.op : "List"); walk(p.head); walk(p.tail); }
        else if (p.p === "as") { walk(p.left); walk(p.right); }
        else if (p.p === "typeBind") walk(p.value);
        else if (p.p === "schema") { const name = head(p.type); if (name) params.push(name); walk(p.value); }
    };
    clause.params.forEach(walk);
    return { params, result: head(clause.body) };
}
// Whether a definition is for one of these types (declared, by name): a
// parameter names one, or, for a function overloaded on its result (a
// method: return x = Parser ...), its body makes one.
export function isForTypes(clauses: { params: Pattern[]; body: Expr }[], declared: (name: string) => boolean, byResult = false): boolean {
    return clauses.some(clause => {
        const { params, result } = clauseTypeNames(clause);
        return params.some(declared) || byResult && !!result && declared(result);
    });
}
// The intrinsics that are methods, by the name each is bound to: a type's
// instances of one are found by the type (its value's, or the one a context
// expects for return and throw).
export const METHOD_INTRINSICS = new Map([["map", "map"], ["intrinsics.return", "return"], ["intrinsics.throw", "throw"],
    ["intrinsics.bind", ">>="], ["intrinsics.ap", "<*>"], ["to", "to"], ["from", "from"]]);
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
        // A list of types is a type ([] the empty list's, as in IO []).
        if (q.p === "list") { const items = q.v.map(typeArg); return items.every(a => a) ? { t: "list", v: items as Expr[] } : undefined; }
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
    // [a, b] is a :: b :: [] in a pattern too.
    if (n.p === "list" && (n.v as Pattern[]).length && tagOf("::")) {
        const expanded = listPatternExpansion(n as Extract<Pattern, { p: "list" }>);
        for (const key of Object.keys(n)) delete n[key];
        Object.assign(n, expanded);
        rewriteInfixConstructors(n, tagOf);
        return;
    }
    if (n.p !== "cons") return;
    const tag = tagOf((n.op as string | undefined) ?? "::");
    if (!tag) return;
    const args = [n.head, n.tail];
    for (const key of Object.keys(n)) delete n[key];
    Object.assign(n, { p: "constr", tag, args });
}
// Whether a block declares names: its statements' patterns are read in its
// scope, as it runs (see withinScope).
export function declaresNames(e: unknown): boolean {
    const b = e as { t?: string; stmts?: Expr[] };
    return b.t === "block" && !!b.stmts?.some(s => s.t === "stmDef" || s.t === "typeDef" || s.t === "patDef");
}
// Runs passes over a statement's patterns, but not into the blocks within it
// that declare names: each reads its own when it runs, in its scope.
export function withinScope(node: unknown, passes: () => void): void {
    const hidden: Array<[{ stmts: Expr[] }, Expr[]]> = [];
    const seen = new Set<object>();
    const hide = (x: unknown): void => {
        if (!x || typeof x !== "object" || seen.has(x)) return;
        seen.add(x);
        if (Array.isArray(x)) { x.forEach(hide); return; }
        if (declaresNames(x)) { const b = x as { stmts: Expr[] }; hidden.push([b, b.stmts]); b.stmts = []; return; }
        Object.values(x).forEach(hide);
    };
    hide(node);
    try { passes(); } finally { for (const [block, stmts] of hidden) block.stmts = stmts; }
}
// A head no value matches: a pattern calling a function.
export function headError(name: string): APNError {
    return new APNError("runtime", `${name} is a function, not data: a pattern cannot call it`, { hint: `declare data with _: ${name} x = _` });
}
// A lowercase name applied in a pattern, (sin x), is a head: it means what it
// is bound to where it runs (resolveHeads), as a capitalized one does.
// data: the constructor's own tag (NewBox = Box matches Box terms).
export type HeadKind = { data: string } | "free" | "other";
// Data (sin x = _) matches its terms; a name bound to nothing is the typed run
// it was written as ((t1 1 t2): a type taken apart; (t x) the old spelling of
// (x : t), an error); bound to anything else it stays a head, which no value
// matches (an index where the definition assigns an item: xs (pos 0) = 9).
export function resolveHeads(node: unknown, kind: (name: string) => HeadKind): void {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(x => resolveHeads(x, kind)); return; }
    const n = node as Record<string, unknown>;
    for (const value of Object.values(n)) if (value && typeof value === "object") resolveHeads(value, kind);
    if (n.p !== "constr" || n.typed) return;
    const tag = n.tag as string, args = n.args as Pattern[], k = kind(tag);
    // A name bound to a constructor matches its terms (NewBox = Box: Box ones).
    if (typeof k === "object") { n.tag = k.data; delete n.head; return; }
    if (!n.head) return;
    if (k !== "free") return;
    const piece = (q: Pattern): Expr | undefined => q.p === "var" ? { t: "var", name: q.name } : q.p === "int" ? { t: "int", v: q.v }
        : q.p === "float" ? { t: "float", v: q.v } : q.p === "string" ? { t: "string", v: q.v } : q.p === "char" ? { t: "char", v: q.v } : undefined;
    const value = args[args.length - 1], pieces = args.slice(0, -1).map(piece);
    if (args.length === 1 && value.p === "var") throw new APNError("parse", "a typed pattern writes its type after the value", { hint: `write (${value.name} : ${tag})` });
    if (value?.p !== "var" || !pieces.every(Boolean)) throw new APNError("parse", `${tag} in a pattern is not data`, { hint: `declare it: ${tag} x = _` });
    const type = (pieces as Expr[]).reduce<Expr>((f, a) => ({ t: "app", f, a }), { t: "var", name: tag });
    for (const key of Object.keys(n)) delete n[key];
    Object.assign(n, { p: "schema", type, value });
}
// What the name a typed pattern (p : T args) is written with is where it
// runs: a type taking so many parameters, a constructor with so many fields,
// or another value read as a type (a function type: Handler = a -> Int).
export type PatternHead = { kind: "type"; arity: number } | { kind: "constructor"; fields: number } | { kind: "schema" };
// (p : T args), written as the typed pattern {T args p, typed}, by what T is
// where it runs (head). A type is given every argument it takes ((xs : List
// _), not (xs : List): unapplied, it is a function). A constructor is a function that
// does not evaluate: given a type for each field it is the values it makes,
// (b : Box Int) the pattern b.(Box (_ : Int)) and (x : None) x.None; given
// fewer, the function type of the rest, (x : Some) is (x : a -> Some a).
// Another value is the schema (p : T args).
export function rewriteTypedPatterns(node: unknown, head: (tag: string) => PatternHead | undefined): void {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(x => rewriteTypedPatterns(x, head)); return; }
    const n = node as Record<string, unknown>;
    for (const value of Object.values(n)) if (value && typeof value === "object") rewriteTypedPatterns(value, head);
    if (n.p !== "constr" || !n.typed) return;
    const tag = n.tag as string, args = n.args as Pattern[], kind = head(tag);
    if (!kind || !args.length) return;
    const given = args.slice(0, -1), value = args[args.length - 1], written = { ...n } as Pattern;
    const replace = (pattern: Pattern) => { for (const key of Object.keys(n)) delete n[key]; Object.assign(n, pattern, { written }); };
    if (kind.kind === "type") {
        if (given.length < kind.arity) {
            const written = (q: Pattern): string => q.p === "var" ? q.name : q.p === "int" ? String(q.v) : q.p === "constr" && !q.args.length ? q.tag : "_";
            const all = [tag, ...given.map(written), ...Array.from({ length: kind.arity - given.length }, () => "_")].join(" ");
            throw new APNError("type", `${tag} takes ${kind.arity + given.length} type parameter${kind.arity + given.length === 1 ? "" : "s"}; a type is given all of them`, { hint: `(x : ${all})` });
        }
        return;
    }
    if (kind.kind === "schema") {
        const type = typeOfArguments(tag, given);
        if (type) replace({ p: "schema", type, value });
        return;
    }
    // Given types for its fields, the schema (b : Box Int), which converts a
    // value as ascription does; with _ among them (b : Box _), or none to give
    // (x : None), the pattern of what it makes: b.(Box _), x.None.
    // A type variable among them (b : Box t) binds the field's type instead.
    const type = given.length === kind.fields && given.length ? typeOfArguments(tag, given) : undefined;
    if (type && !typeVariables(type).length) { replace({ p: "schema", type, value }); return; }
    if (given.length === kind.fields) {
        // Each field's type is a typed pattern around _: Int is (_ : Int).
        const field = (q: Pattern): Pattern => {
            if (q.p === "var") return { p: "typeBind", name: q.name, value: { p: "wildcard" } };
            if (q.p !== "constr") return q;
            const typed: Pattern = { ...q, args: [...q.args, { p: "wildcard" }], typed: true };
            rewriteTypedPatterns(typed, head);
            return typed;
        };
        replace({ p: "as", left: value, right: { p: "constr", tag, args: given.map(field) } });
        return;
    }
    if (given.length > kind.fields) return;
    // The function type of the fields not given: a -> Some a.
    const rest = Array.from({ length: kind.fields - given.length }, (_, i) => String.fromCharCode(97 + i));
    const applied = typeOfArguments(tag, [...given, ...rest.map((name): Pattern => ({ p: "var", name }))]);
    if (applied) replace({ p: "schema", type: rest.reduceRight<Expr>((body, name) => ({ t: "lambda", params: [name], body }), applied), value });
}
// A type argument written as a pattern, as the expression it is.
function patternAsType(q: Pattern): Expr | undefined {
    if (q.p === "var") return { t: "var", name: q.name };
    if (q.p === "int") return { t: "int", v: q.v };
    if (q.p !== "constr") return undefined;
    return typeOfArguments(q.tag, q.args);
}
// T args, written as patterns, as the type expression they write.
function typeOfArguments(tag: string, args: Pattern[]): Expr | undefined {
    const types = args.map(patternAsType);
    return types.every(Boolean) ? (types as Expr[]).reduce<Expr>((f, a) => ({ t: "app", f, a }), { t: "var", name: tag }) : undefined;
}
// (xs : Sized n), Sized a type a definition with parameters computes
// (computed, where it runs), with every argument known (bound by an earlier
// parameter, or written as a literal: copy n (xs : Sized n)), is the schema of
// the type they compute; one with an argument to bind reads it back from the
// value ((xs : Pairs n a)). Each parameter list, left to right, in place.
export function knownTypeArguments(node: unknown, computed: (tag: string) => boolean): void {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(x => knownTypeArguments(x, computed)); return; }
    const record = node as Record<string, unknown>;
    if (Array.isArray(record.params) && record.params.every(p => p && typeof p === "object" && "p" in p)) {
        const bound = new Set<string>();
        for (const p of record.params as Pattern[]) {
            knownArguments(p, bound, computed);
            for (const name of patternNames(p)) bound.add(name);
        }
    }
    for (const value of Object.values(record)) knownTypeArguments(value, computed);
}
function knownArguments(p: Pattern, bound: Set<string>, computed: (tag: string) => boolean): void {
    const n = p as Record<string, unknown>;
    for (const value of Object.values(n)) {
        if (Array.isArray(value)) value.forEach(x => x && typeof x === "object" && "p" in x && knownArguments(x as Pattern, bound, computed));
        else if (value && typeof value === "object" && "p" in value) knownArguments(value as Pattern, bound, computed);
    }
    if (p.p !== "constr" || !p.typed || p.args.length < 2 || !computed(p.tag)) return;
    const type = typeOfArguments(p.tag, p.args.slice(0, -1));
    if (!type || !typeVariables(type).every(name => bound.has(name))) return;
    const value = p.args[p.args.length - 1];
    for (const key of Object.keys(n)) delete n[key];
    Object.assign(n, { p: "schema", type, value });
}
// The lowercase names a type expression written as patterns holds (Pairs n a).
function typeVariables(e: Expr): string[] {
    if (e.t === "var") return /^[a-z]/.test(e.name) ? [e.name] : [];
    return e.t === "app" ? [...typeVariables(e.f), ...typeVariables(e.a)] : [];
}
// The pattern Name args is when Name is a constructor where it runs (Some x =
// m binds x): a list's cell when Name is the list's cons (Cons x xs = [1,2]).
export function constructorPattern(name: string, args: Pattern[], cons: boolean): Pattern {
    return cons && args.length === 2 ? { p: "cons", head: args[0], tail: args[1], op: name } : { p: "constr", tag: name, args };
}
// A constructor pattern whose constructor is the list's cons (the prelude's
// Cons, by what the name is bound to: isCons) is that list cell, as h :: t
// is; it keeps the name it was written with (see patternSource).
export function rewriteListConstructors(node: unknown, isCons: (tag: string) => boolean): void {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(x => rewriteListConstructors(x, isCons)); return; }
    const n = node as Record<string, unknown>;
    for (const value of Object.values(n)) if (value && typeof value === "object") rewriteListConstructors(value, isCons);
    if (n.p !== "constr" || (n.args as Pattern[]).length !== 2 || !isCons(n.tag as string)) return;
    const [head, tail] = n.args as Pattern[], op = n.tag;
    for (const key of Object.keys(n)) delete n[key];
    Object.assign(n, { p: "cons", head, tail, op });
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

// Sugar is the core code it expands into, as if written in its place: the
// runtime and the checker run and type a sugar node as its expansion, with
// whatever its names (match, Bool) mean there; the written node stays for
// printing and tools, and each part keeps its place in the source.
const sugar = new WeakMap<Expr, Expr>();
const placed = <E extends Expr>(x: E, source: Expr): E => { const place = sourceLocations.get(source); if (place) sourceLocations.set(x, place); return x; };
// c ? a : b is Bool c a b: Bool gives the condition's truthiness, and a Bool
// applied to two values is one of them.
export function ternaryExpansion(e: Extract<Expr, { t: "ternary" }>): Expr {
    let core = sugar.get(e);
    if (core) return core;
    const truth = placed({ t: "app", f: { t: "var", name: "truthy" }, a: e.cond }, e.cond);
    core = placed({ t: "app", f: placed({ t: "app", f: truth, a: e.then }, e), a: e.els }, e);
    sugar.set(e, core);
    return core;
}
// [a, b] is a :: b :: [], with whatever :: means where it is written.
export function listExpansion(e: Extract<Expr, { t: "list" }>): Expr {
    let core = sugar.get(e);
    if (core) return core;
    core = e.v.reduceRight<Expr>((tail, item) => placed({ t: "binop", op: "::", l: item, r: tail }, item), placed({ t: "list", v: [] }, e));
    sugar.set(e, core);
    return core;
}
// [a..] is enumFrom a, [a,b..c] enumFromThenTo a b c, and so on.
export function rangeName(e: Extract<Expr, { t: "range" }>): string {
    return e.second ? e.hi ? "enumFromThenTo" : "enumFromThen" : e.hi ? "enumFromTo" : "enumFrom";
}
export function rangeExpansion(e: Extract<Expr, { t: "range" }>): Expr {
    let core = sugar.get(e);
    if (core) return core;
    core = [e.second, e.hi].reduce<Expr>((f, a) => a ? placed({ t: "app", f, a }, e) : f, placed({ t: "app", f: placed({ t: "var", name: rangeName(e) }, e), a: e.lo }, e));
    sugar.set(e, core);
    return core;
}
export function listPatternExpansion(p: Extract<Pattern, { p: "list" }>): Pattern {
    return p.v.reduceRight<Pattern>((tail, head) => ({ p: "cons", head, tail }), { p: "list", v: [] });
}
// A match of a value against written one-parameter alternatives.
export type PatternLambda = Extract<Expr, { t: "patternLambda" }>;
export type CoreMatch = { value: Expr; alternatives: PatternLambda[] };
const expansions = new WeakMap<Expr, CoreMatch>();
// A Bool applied to two values (truthy c a b, True a b), which the prelude's
// clauses for get make a match on it: [True -> a, False -> b]. The caller
// finds that Bool and get are the prelude's.
export function boolSelection(e: Expr): CoreMatch | undefined {
    if (e.t !== "app" || e.f.t !== "app") return undefined;
    const head = e.f.f;
    if (head.t !== "bool" && !(head.t === "app" && head.f.t === "var" && head.f.name === "truthy")) return undefined;
    let core = expansions.get(e);
    if (core) return core;
    const branch = (v: boolean, body: Expr): PatternLambda => placed({ t: "patternLambda", params: [{ p: "bool", v }], body }, body);
    core = { value: head, alternatives: [branch(true, e.f.a), branch(false, e.a)] };
    expansions.set(e, core);
    return core;
}
// x ~ [alternatives] (or (~) x [alternatives], or f x [...] for an f the
// caller has found to be the builtin ~) written with one-parameter lambdas. A
// lambda's parameter is a pattern that is a name (n -> n + 1).
const namedAlternatives = new WeakMap<Expr, PatternLambda>();
export function matchOperands(e: Expr): { head: string; value: Expr; alternatives: Expr } | undefined {
    if (e.t === "binop" && e.op === "~") return { head: "~", value: e.l, alternatives: e.r };
    if (e.t === "app" && e.f.t === "app" && e.f.f.t === "var") return { head: e.f.f.name, value: e.f.a, alternatives: e.a };
    return undefined;
}
export function writtenMatch(e: Expr): CoreMatch | undefined {
    const operands = matchOperands(e);
    if (!operands || operands.alternatives.t !== "list" || !operands.alternatives.v.length) return undefined;
    if (expansions.has(e)) return expansions.get(e);
    const alternatives: PatternLambda[] = [];
    for (const x of operands.alternatives.v) {
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
    const core = { value: operands.value, alternatives };
    expansions.set(e, core);
    return core;
}

// A function whose body matches its parameters in order (x -> x ~
// alternatives, or [x, y] ~ ... for two) is the function of the
// alternatives as clauses: clauses are a match on the arguments. Not when
// an alternative is guarded or reads a parameter, nor when two have
// equivalent patterns (the later never runs; as clauses they would overload).
// builtinMatch: whether ~ there is the builtin one.
export function matchedClauses(params: Pattern[], body: Expr, builtinMatch: boolean): { params: Pattern[]; body: Expr }[] | undefined {
    const names = params.map(p => p.p === "var" ? p.name : "");
    if (!names.length || names.includes("") || new Set(names).size !== names.length) return undefined;
    while (body.t === "block" && body.stmts.length === 1) body = body.stmts[0];
    const written = builtinMatch && matchOperands(body)?.head === "~" ? writtenMatch(body) : undefined;
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
    // A name a pattern binds is renamed in order; a name a type in it reads
    // (Int in (List Int xs)) is kept.
    return JSON.stringify([clause.params, clause.guard ?? null], function (this: Record<string, unknown>, field, value) {
        if (value && typeof value === "object" && value.p === "wildcard") return { p: "var", name: `\0${unused++}` };
        if (field === "name" && (typeof this.p === "string" || names.has(value))) { if (!names.has(value)) names.set(value, names.size); return names.get(value); }
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
// Whether an expression reads a module: an import or a load, also ascribed
// (load "f" : Dynamic). A module leaves a name bound to one out of its record.
export function readsModule(e: Expr): boolean {
    if (e.t === "block" && e.style === "(" && e.stmts.length === 1) return readsModule(e.stmts[0]);
    if (e.t === "app" && e.ascribed) return readsModule(e.a);
    return isLoadCall(e) || (e.t === "app" || e.t === "pipe") && e.f.t === "var" && e.f.name === "import";
}
// A use (use r): it binds the names it opens and yields nothing, as = does,
// so in code it is a binding's item.
export function isUse(e: Expr): e is Extract<Expr, { t: "app" }> {
    return e.t === "app" && e.f.t === "var" && e.f.name === "use";
}
// The path an import written with a literal one reads (import "std/text").
export function importedPath(e: Expr): string | undefined {
    if (e.t === "block" && e.style === "(" && e.stmts.length === 1) return importedPath(e.stmts[0]);
    const path = e.t === "app" ? e.a : e.t === "pipe" ? e.x : undefined;
    return (e.t === "app" || e.t === "pipe") && e.f.t === "var" && e.f.name === "import" && path?.t === "string" ? path.v : undefined;
}

