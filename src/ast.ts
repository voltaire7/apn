import type { DefClause } from "./types.ts";

// ---------------- AST ----------------

export type BinOp = "+" | "-" | "*" | "/" | "%" | "==" | "!=" | "<" | ">" | "<=" | ">="
    | "&&" | "||" | "++" | ":";

export type UnOp = "neg" | "not";

export type Expr =
    | { t: "int"; v: bigint }
    | { t: "float"; v: number }
    | { t: "bool"; v: boolean }
    | { t: "string"; v: string }
    | { t: "char"; v: string }
    | { t: "unit" }
    | { t: "placeholder" }
    | { t: "var"; name: string }
    | { t: "binop"; op: BinOp; l: Expr; r: Expr }
    | { t: "unop"; op: UnOp; e: Expr }
    | { t: "app"; f: Expr; a: Expr }
    | { t: "lambda"; params: string[]; body: Expr }
    | { t: "ternary"; cond: Expr; then: Expr; els: Expr }
    | { t: "match"; scrut: Expr; alts: Alt[] }
    | { t: "list"; v: Expr[] }
    | { t: "record"; v: Array<[string, Expr]> }
    | { t: "recordAccess"; rec: Expr; field: string | Expr }
    | { t: "pluck"; rec: Expr; entries: Array<string | [string, string]> }
    | { t: "setFields"; rec: Expr; entries: string[]; value: Expr }
    | { t: "floatRange"; lo: number; step: number; hi: number | null }
    | { t: "range"; lo: bigint; step: bigint; hi: bigint | null }
    | { t: "pipe"; x: Expr; f: Expr }
    | { t: "block"; stmts: Expr[]; style?: "(" | "{" }
    | { t: "stmDef"; name: string; clauses: { params: Pattern[]; body: Expr }[] }
    | { t: "patDef"; pattern: Pattern; value: Expr };

export interface Alt {
    pattern: Pattern;
    guard?: Expr;
    body: Expr;
}

export type Pattern =
    | { p: "wildcard" }
    | { p: "var"; name: string }
    | { p: "int"; v: bigint }
    | { p: "bool"; v: boolean }
    | { p: "string"; v: string }
    | { p: "list"; v: Pattern[] }
    | { p: "cons"; head: Pattern; tail: Pattern }
    | { p: "constr"; tag: string; args: Pattern[] }
    | { p: "recPat"; v: Array<[string, string]> }
    | { p: "range"; lo: bigint; hi: bigint };

interface DataDef { name: string; variants: { tag: string; arity: number }[]; }

export type TopLevel = { t: "def"; name: string; clauses: DefClause[] } | { t: "expr"; value: Expr }
    | { t: "data"; def: DataDef }
    | { t: "patDef"; pattern: Pattern; value: Expr };

// ---------------- Lexer ----------------

