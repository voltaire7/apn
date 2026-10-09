import { keySource } from "./record-keys.ts";
import { functionSource } from "./function-source.ts";
import { type Numeric, type Real, numberText } from "./numbers.ts";
import type { Expr, Pattern } from "./ast.ts";

// ---------------- Types & values ----------------

export interface VariantFamily { base?: Value; name: string; parameters?: string[]; fields?: Map<string, Expr[]>; env?: Env; }

export type Type = string; // lightweight: we represent types as printable strings

// One equation of a Haskell-style function definition:  f p1 p2 ... = body
export interface DefClause { params: Pattern[]; body: Expr; guard?: Expr; }

// Runtime values (dynamically typed, like JS)
export interface NativePointer {
    kind: "pointer";
    address: Deno.PointerValue;
    bits: bigint;
    owner?: { closed: boolean };
    buffer?: Uint8Array;
    offset: number;
    length?: number;
    elementType?: string;
    roots?: unknown[];
}

export type Value =
    | NativePointer
    | { kind: "functionType"; from: Value; to: Value }
    | { kind: "contract"; target: Value; from: Value; to: Value }
    | { kind: "mutable"; v: Value }
    | { kind: "type"; name: string; inspect?: boolean; description?: string; family?: VariantFamily; arguments?: Value[]; alias?: { parameters: string[]; body: Expr; env: Env } }
    | { kind: "hashmap"; entries: Map<string, [Value, Value]> }
    | Numeric
    | { kind: "rationalRange"; lo: Real; step: Real; hi: Real | null }
    | { kind: "bool"; v: boolean }
    | { kind: "string"; v: string }
    | { kind: "char"; v: string }
    | { kind: "list"; v: Value[]; schema?: Value }
    | { kind: "lazyList"; exprs: Expr[]; env: Env; value?: Value }
    | { kind: "cons"; head: Value; tail: Value }
    // describes: an unevaluated value it will be (a cons tail's thunk), for typeOf.
    | { kind: "deferred"; compute: () => Value; value?: Value; busy?: boolean; describes?: Value }
    | { kind: "record"; v: Array<[string, Value]>; scope?: Env; guarded?: boolean }
    | { kind: "variant"; tag: string; v: Value[]; family?: VariantFamily; arguments?: Value[] }
    | { kind: "closure"; params: string[]; body: Expr; env: Env; mutableValue?: Value }
    | { kind: "native"; name: string; arity: number; applied: Value[]; tag?: string; family?: VariantFamily; invoke?: (args: Value[]) => Value }
    // fallback: an overloaded operator's previous meaning, applied when no clause matches.
    | { kind: "clauseFn"; name: string; clauses: DefClause[]; arity: number; env: Env; applied: Value[]; fallback?: Value }
    | { kind: "floatRange"; lo: number; step: number; hi: number | null; index?: number }
    | { kind: "range"; lo: bigint; step: bigint; hi: bigint | null }
    | { kind: "nomatch" }
    // An IO action: running it performs its effects and yields its result
    // (or an IOTail, the action to continue with, so loops run in constant stack).
    | { kind: "io"; run: () => Value | IOTail; label?: string }
    // A monadic value whose monad is not decided yet (return 42, or a do-block
    // or bind built from one): realized in a monad by an annotation, a >>=
    // with a concrete value, or as IO when run.
    | { kind: "pending"; step: PendingStep }
    | { kind: "thunk"; body: Expr; env: Env; value?: Value; busy?: boolean };

// Numbers are accepted only for bounded host counters such as array lengths.
export function mkInt(v: bigint | number): Value {
    if (typeof v === "number" && !Number.isSafeInteger(v)) {
        throw new RangeError("cannot convert an unsafe host number to an APN integer");
    }
    return { kind: "int", v: BigInt(v) };
}
export function mkBool(v: boolean): Value { return { kind: "bool", v }; }
export function mkStr(v: string): Value { return { kind: "string", v }; }
export function mkList(v: Value[]): Value { return { kind: "list", v }; }

// printf-style rendering for `format`: strings appear WITHOUT quotes.
export function rawString(v: Value): string {
    return v.kind === "string" ? v.v : valueToString(v);
}

export type PendingStep =
    | { op: "return"; value: Value }
    | { op: "bind"; m: Value; f: Value }
    | { op: "do"; block: Expr; env: Env; start: number; first?: Value };

// What an IO action continues with: its last step, run by the caller's loop.
export class IOTail { constructor(public next: Value) {} }

export function valueToString(v: Value): string {
    switch (v.kind) {
        case "int": case "float": case "rational": case "complex": return (v.typeName && v.typeName !== "Int" && v.typeName !== "Float" ? v.typeName + " " : "") + numberText(v);
        case "mutable": return valueToString(v.v);
        case "functionType": return `${v.from.kind === "functionType" ? "(" + typeToString(v.from) + ")" : typeToString(v.from)} -> ${typeToString(v.to)}`;
        case "contract": return `((${valueToString({ kind: "functionType", from: v.from, to: v.to })}) (${valueToString(v.target)}))`;
        case "pointer": return `Pointer 0x${v.bits.toString(16)}`;
        case "type": {
            return (v.description ?? v.name) + (v.arguments?.length ? " " + v.arguments.map(typeToString).join(" ") : "");
        }
        case "hashmap": return `HashMap [${[...v.entries.values()].map(([k, x]) => `[${valueToString(k)},${valueToString(x)}]`).join(",")}]`;
        case "rationalRange": return "<rational range>";
        case "bool": return String(v.v);
        case "string": return `"${v.v}"`;
        case "char": return `'${v.v === "\0" ? "\\0" : v.v}'`;
        case "list": return `[${v.v.map(valueToString).join(",")}]`;
        case "lazyList":
        case "cons": return "<lazy list>";
        case "deferred": return "<thunk>";
        case "floatRange": return `<float range>`;
        case "range": {
            if (v.hi === null) return `[${v.lo}${v.step !== 1n ? `,${v.lo + v.step}` : ""}..]`;
            const out: Value[] = [];
            for (let i = v.lo; v.step > 0 ? i <= v.hi : i >= v.hi; i += v.step) out.push(mkInt(i));
            return `[${out.map(valueToString).join(",")}]`;
        }
        case "record":
            if (v.scope) return "env";
            return `[${v.v.map(([k, val]) => `${keySource(k)}: ${valueToString(val)}`).join(", ")}]`;
        case "variant": {
            const args = v.v.length ? " " + v.v.map(valueToString).join(" ") : "";
            return v.tag + args;
        }
        case "closure": return functionSource(v);
        case "thunk": return "<thunk>";
        case "native": return functionSource(v);
        case "clauseFn": return functionSource(v);
        case "nomatch": return "<nomatch>";
        case "io": return v.label ? `<IO ${v.label}>` : "<IO>";
        case "pending": return "<Monad>";
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


// Render nested type descriptions without constructing data defaults.
export function typeToString(v: Value): string {
    if (v.kind === "type") return valueToString({ ...v, inspect: true });
    if (v.kind === "list") return `[${v.v.map(typeToString).join(",")}]`;
    if (v.kind === "record") return `[${v.v.map(([k, x]) => `${keySource(k)}: ${typeToString(x)}`).join(", ")}]`;
    return valueToString(v);
}
