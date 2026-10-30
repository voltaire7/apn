import { keySource } from "./record-keys.ts";
import { functionSource } from "./function-source.ts";
import { type Numeric, type Real, arithmetic, numberText } from "./numbers.ts";
import type { Expr, Pattern } from "./ast.ts";
import { charLiteral, itemsText, stringLiteral } from "./separators.ts";

// ---------------- Types & values ----------------

// results: an indexed family's constructors' result types (Cons ... -> Vec (S k) a).
// opaque: a := type's, which has none of its base's operations.
export interface VariantFamily { base?: Value; opaque?: boolean; name: string; parameters?: string[]; fields?: Map<string, Expr[]>; env?: Env; results?: Map<string, Expr>; }

export type Type = string; // lightweight: we represent types as printable strings

// One equation of a Haskell-style function definition:  f p1 p2 ... = body
// constructs: written with := (Rect w h := ...), a constructor, not a function.
export interface DefClause { params: Pattern[]; body: Expr; guard?: Expr; constructs?: boolean; }

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
    // variables: the type variables decided so far by a curried call.
    | { kind: "contract"; target: Value; from: Value; to: Value; variables?: Map<string, Value> }
    // schema: a cell holding a List T (Mutable ((List T) xs)) holds lists of any length.
    | { kind: "mutable"; v: Value; schema?: Value }
    // variable: a type variable (the a of a -> a), named by name.
    | { kind: "type"; name: string; inspect?: boolean; description?: string; family?: VariantFamily; arguments?: Value[]; alias?: { parameters: string[]; run: Value; constructs: boolean; family: VariantFamily; named: Map<string, VariantFamily> }; choices?: Value[]; variable?: boolean }
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
    // A deferred value or thunk drops what computes it once it has its value,
    // so a value never keeps the scope that made it alive.
    | { kind: "deferred"; compute?: () => Value; value?: Value; busy?: boolean; describes?: Value }
    // shared: a stateful object (a p5 object), which a definition allocates once, as a Mutable.
    | { kind: "record"; v: Array<[string, Value]>; shared?: boolean }
    | { kind: "variant"; tag: string; v: Value[]; family?: VariantFamily; arguments?: Value[] }
    // A partly applied closure keeps its whole parameter list and the arguments
    // applied so far, for showing it: (a b -> a + b) 1.
    | { kind: "closure"; params: string[]; body: Expr; env?: Env; mutableValue?: Value; whole?: string[]; applied?: Value[] }
    | { kind: "native"; name: string; arity: number; applied: Value[]; tag?: string; family?: VariantFamily; invoke?: (args: Value[]) => Value }
    // fallback: an overloaded operator's previous meaning, applied when no clause matches.
    | { kind: "clauseFn"; name: string; clauses: DefClause[]; arity: number; env: Env; applied: Value[]; fallback?: Value }
    | { kind: "floatRange"; lo: number; step: number; hi: number | null; index?: number }
    | { kind: "range"; lo: bigint; step: bigint; hi: bigint | null }
    | { kind: "nomatch" }
    // An IO action: running it performs its effects and yields its result
    // (or an IOTail, the action to continue with, so loops run in constant stack).
    // result describes the type of what it yields, when known without running it.
    | { kind: "io"; run: () => Value | IOTail; result?: string | (() => string) }
    // A monadic value whose monad is not decided yet (return 42, or a do-block
    // or bind built from one): realized in a monad by an annotation, a >>=
    // with a concrete value, or as IO when run.
    | { kind: "pending"; step: PendingStep }
    | { kind: "thunk"; body: Expr; env?: Env; value?: Value; busy?: boolean };

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
    // return x, and throw e (the monad's failure: [] in a list, None in an Option).
    | { op: "return" | "throw"; value: Value }
    // A call of overloads that differ only in result type: the context chooses.
    | { op: "call"; fn: Extract<Value, { kind: "clauseFn" }>; args: Value[]; choices: DefClause[] }
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
            return (v.description ?? v.name) + (v.arguments?.length ? " " + v.arguments.map(typeArgumentText).join(" ") : "");
        }
        case "hashmap": return `HashMap [${itemsText([...v.entries.values()].map(([k, x]) => `[${itemsText([valueToString(k), valueToString(x)])}]`))}]`;
        case "rationalRange": return rangeText(v.lo, arithmetic("+", v.lo, v.step), v.hi);
        case "bool": return String(v.v);
        case "string": return stringLiteral(v.v);
        case "char": return charLiteral(v.v);
        case "list": return `[${itemsText(v.v.map(valueToString))}]`;
        case "lazyList":
        case "cons": return "[...]";
        case "deferred": return "...";
        case "floatRange": return rangeText({ kind: "float", v: v.lo }, { kind: "float", v: v.lo + v.step }, v.hi === null ? null : { kind: "float", v: v.hi });
        case "range": {
            if (v.hi === null) return `[${v.lo}${v.step !== 1n ? `,${v.lo + v.step}` : ""}..]`;
            const out: Value[] = [];
            for (let i = v.lo; v.step > 0 ? i <= v.hi : i >= v.hi; i += v.step) out.push(mkInt(i));
            return `[${itemsText(out.map(valueToString))}]`;
        }
        case "record":
            return `[${v.v.map(([k, val]) => `${keySource(k)}: ${valueToString(val)}`).join(", ")}]`;
        case "variant": return v.tag + v.v.map(argumentText).join("");
        case "closure": return functionSource(v);
        case "thunk": return "...";
        case "native": return functionSource(v);
        case "clauseFn": return functionSource(v);
        case "nomatch": return "nomatch";
        // An action shows its type: running it is the only way to see its result.
        case "io": return ioTypeText(v);
        // An undecided return shows its value; a >>= or do-block cannot be
        // shown without running it.
        // Undecided: shown fully by the interpreter, which knows the overloads.
        case "pending": return v.step.op === "return" || v.step.op === "throw" ? v.step.op + argumentText(v.step.value) : v.step.op === "call" ? v.step.fn.name + v.step.args.map(argumentText).join("") : "return";
    }
}

// A constructor argument as source writes it: Some (Some 1), Some -1.
export function compoundArgument(v: Value): boolean {
    switch (v.kind) {
        case "variant": return v.v.length > 0;
        case "pending": return v.step.op === "return" || v.step.op === "throw";
        case "io": case "closure": case "clauseFn": case "contract": case "functionType": return true;
        case "native": return v.applied.length > 0;
        case "int": case "float": case "rational": case "complex": return /\s/.test(valueToString(v));
        case "type": return !!v.arguments?.length || /\s/.test(v.description ?? "");
        default: return false;
    }
}
function argumentText(v: Value): string {
    const text = valueToString(v);
    return compoundArgument(v) ? ` (${text})` : ` ${text}`;
}

// An action's type: IO [] for print 1, IO a when its result is not known.
export function ioTypeText(v: Extract<Value, { kind: "io" }>): string {
    const result = typeof v.result === "function" ? v.result() : v.result ?? "a";
    return `IO ${/\s/.test(result) && !/^[[(]/.test(result) ? `(${result})` : result}`;
}

// A range in source form: [lo,next..hi], or [lo,next..] when endless.
function rangeText(lo: Numeric, next: Numeric, hi: Numeric | null): string {
    return `[${itemsText([numberText(lo), `${numberText(next)}..${hi === null ? "" : numberText(hi)}`])}]`;
}

// Environment: a chain of hash maps. Shared mutable object per scope. A
// version continues its parent's scope: a rebinding starts one, so what was
// written before it keeps the scope as it was (see Interpreter.bindNames).
export class Env {
    parent: Env | null;
    map: Map<string, Value>;
    version: boolean;
    // A scope's newest version, for env views, which stay live.
    newest?: Env;

    constructor(parent: Env | null = null, version = false) {
        this.parent = parent;
        this.map = new Map();
        this.version = version;
    }

    // The scope a version continues: where new names are defined.
    root(): Env {
        let e: Env = this;
        while (e.version && e.parent) e = e.parent;
        return e;
    }

    // The scope's own bindings, each as its latest version has it.
    bindings(): Map<string, Value> {
        const out = new Map<string, Value>();
        for (let e: Env | null = this; e; e = e.parent) {
            for (const [name, value] of e.map) if (!out.has(name)) out.set(name, value);
            if (!e.version) break;
        }
        return out;
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
// A type as another's argument: List (Option Int), List (a -> b).
function typeArgumentText(v: Value): string {
    const text = typeToString(v);
    return /\s/.test(text) && !/^[[(]/.test(text) ? `(${text})` : text;
}

// A type's text with its variables named in order of appearance, so types
// differing only in variable names read the same: b -> b is a -> a.
export function canonicalTypeText(text: string): string {
    const names = new Map<string, string>();
    return text.replace(/(?<![A-Za-z0-9_'"$.])([a-z][A-Za-z0-9_']*)(?![A-Za-z0-9_']*\s*:)/g, (name) => {
        if (!names.has(name)) { const n = names.size; names.set(name, String.fromCharCode(97 + n % 26) + (n >= 26 ? Math.floor(n / 26) : "")); }
        return names.get(name)!;
    });
}

export function typeToString(v: Value): string {
    if (v.kind === "type") return valueToString({ ...v, inspect: true });
    if (v.kind === "list") return `[${itemsText(v.v.map(typeToString))}]`;
    if (v.kind === "record") return `[${v.v.map(([k, x]) => `${keySource(k)}: ${typeToString(x)}`).join(", ")}]`;
    return valueToString(v);
}
