import type { Numeric, Real } from "./numbers.ts";
import type { DefClause } from "./types.ts";

// ---------------- AST ----------------

// A binary operator's name: a built-in one (+, ==, :, ...) or one a program
// defines; its meaning and fixity come from the prelude or a definition.
export type BinOp = string;

export type UnOp = "neg" | "not";


export type Expr =
    | { t: "computedRange"; lo: Expr; second: Expr | null; hi: Expr | null }
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
    | { p: "cons"; head: Pattern; tail: Pattern }
    | { p: "typeBind"; name: string; value: Pattern }
    | { p: "constr"; tag: string; args: Pattern[] }
    | { p: "recPat"; v: Array<[string, string]> }
    | { p: "range"; lo: bigint; hi: bigint };

interface DataDef { name: string; parameters?: string[]; variants: { tag: string; arity: number; fields?: Expr[] }[]; }

export type TopLevel = { t: "def"; name: string; clauses: DefClause[] } | { t: "expr"; value: Expr }
    | { t: "type"; def: DataDef }
    | { t: "patDef"; pattern: Pattern; value: Expr; eager?: boolean; update?: { name: string; value: Expr; error?: string } };

// ---------------- Lexer ----------------


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

