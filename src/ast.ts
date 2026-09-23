import type { Numeric, Real } from "./numbers.ts";
import type { DefClause } from "./types.ts";

// ---------------- AST ----------------

export type BinOp = "+" | "-" | "*" | "/" | "%" | "^" | "==" | "!=" | "<" | ">" | "<=" | ">="
    | "&&" | "||" | "++" | ":";

export type UnOp = "neg" | "not";

export type FunctionSpec = { name: string } | { from: FunctionSpec; to: FunctionSpec };

export type Expr =
    | { t: "functionType"; spec: FunctionSpec }
    | { t: "computedRange"; lo: Expr; second: Expr | null; hi: Expr | null }
    | { t: "import"; module: string }
    | { t: "numeric"; v: Numeric }
    | { t: "rationalRange"; lo: Real; step: Real; hi: Real | null }
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
    | { t: "patternLambda"; params: Pattern[]; body: Expr; guard?: Expr }
    | { t: "lambda"; params: string[]; body: Expr }
    | { t: "ternary"; cond: Expr; then: Expr; els: Expr }
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
    | { t: "patDef"; pattern: Pattern; value: Expr; eager?: boolean };

export type Pattern =
    | { p: "schema"; type: Expr; value: Pattern }
    | { p: "contract"; spec: FunctionSpec; value: Pattern }
    | { p: "wildcard" }
    | { p: "var"; name: string }
    | { p: "int"; v: bigint }
    | { p: "bool"; v: boolean }
    | { p: "string"; v: string }
    | { p: "list"; v: Pattern[] }
    | { p: "cons"; head: Pattern; tail: Pattern }
    | { p: "typeBind"; name: string; value: Pattern }
    | { p: "constr"; tag: string; args: Pattern[] }
    | { p: "recPat"; v: Array<[string, string]> }
    | { p: "range"; lo: bigint; hi: bigint };

interface DataDef { name: string; parameters?: string[]; variants: { tag: string; arity: number; fields?: Expr[] }[]; }

export type TopLevel = { t: "def"; name: string; clauses: DefClause[] } | { t: "expr"; value: Expr }
    | { t: "type"; def: DataDef }
    | { t: "patDef"; pattern: Pattern; value: Expr; eager?: boolean };

// ---------------- Lexer ----------------

