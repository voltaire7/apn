import type { Expr, Pattern } from "./ast.ts";

// ---------------- Types & values ----------------

export type Type = string; // lightweight: we represent types as printable strings

// One equation of a Haskell-style function definition:  f p1 p2 ... = body
export interface DefClause { params: Pattern[]; body: Expr; }

// Runtime values (dynamically typed, like JS)
export type Value =
    | { kind: "int"; v: number }
    | { kind: "float"; v: number }
    | { kind: "bool"; v: boolean }
    | { kind: "string"; v: string }
    | { kind: "char"; v: string }
    | { kind: "unit" }
    | { kind: "list"; v: Value[] }
    | { kind: "lazyList"; exprs: Expr[]; env: Env }
    | { kind: "record"; v: Array<[string, Value]> }
    | { kind: "variant"; tag: string; v: Value[] }
    | { kind: "closure"; params: string[]; body: Expr; env: Env }
    | { kind: "native"; name: string; arity: number; applied: Value[]; tag?: string }
    | { kind: "clauseFn"; name: string; clauses: DefClause[]; arity: number; env: Env; applied: Value[] }
    | { kind: "range"; lo: number; step: number; hi: number | null }
    | { kind: "nomatch" }
    | { kind: "thunk"; body: Expr; env: Env; value?: Value };

export function mkInt(v: number): Value { return { kind: "int", v }; }
export function mkBool(v: boolean): Value { return { kind: "bool", v }; }
export function mkStr(v: string): Value { return { kind: "string", v }; }
export function mkList(v: Value[]): Value { return { kind: "list", v }; }

// printf-style rendering for `format`: strings appear WITHOUT quotes.
export function rawString(v: Value): string {
    return v.kind === "string" ? v.v : valueToString(v);
}

export function valueToString(v: Value): string {
    switch (v.kind) {
        case "int": return String(v.v);
        case "float": return String(v.v);
        case "bool": return String(v.v);
        case "string": return `"${v.v}"`;
        case "char": return `'${v.v}'`;
        case "unit": return "()";
        case "list": return `[${v.v.map(valueToString).join(", ")}]`;
        case "lazyList": return "<lazy>";
        case "range": {
            if (v.hi === null) return `[${v.lo}${v.step !== 1 ? `, ${v.lo + v.step}` : ""}..]`;
            const out: Value[] = [];
            for (let i = v.lo; v.step > 0 ? i <= v.hi : i >= v.hi; i += v.step) out.push(mkInt(i));
            return `[${out.map(valueToString).join(", ")}]`;
        }
        case "record":
            return `[${v.v.map(([k, val]) => `${k}: ${valueToString(val)}`).join(", ")}]`;
        case "variant": {
            const args = v.v.length ? " " + v.v.map(valueToString).join(" ") : "";
            return v.tag + args;
        }
        case "closure": return "<function>";
        case "thunk": return "<thunk>";
        case "native": return `<native:${v.name}>`;
        case "clauseFn": return "<function>";
        case "nomatch": return "<nomatch>";
    }
}

// Environment: a chain of hash maps. Shared mutable object per scope.
export class Env {
    parent: Env | null;
    map: Map<string, Value>;

    constructor(parent: Env | null = null) {
        this.parent = parent;
        this.map = new Map();
    }

    get(name: string): Value | undefined {
        let e: Env | null = this;
        while (e) {
            if (e.map.has(name)) return e.map.get(name);
            e = e.parent;
        }
        return undefined;
    }

    setLocal(name: string, v: Value) {
        this.map.set(name, v);
    }

    // Set in the scope where the variable already exists, else local scope.
    set(name: string, v: Value) {
        // For simplicity (JS-like), assignment operates on the current scope.
        let e: Env | null = this;
        while (e) {
            if (e.map.has(name)) { e.map.set(name, v); return; }
            e = e.parent;
        }
        this.map.set(name, v);
    }
}

