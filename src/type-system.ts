import { type Numeric, type Real, isNumeric, integer, floating, toReal, toExact, toInexact, isInteger, exact, equalNumbers, asFloat, rounding, arithmetic, numberText, numericNative } from "./numbers.ts";
import { APNError } from "./errors.ts";
import type { Pattern } from "./ast.ts";

// The numeric classes: sets of numbers of several types, none a value's own
// type (Integer holds an Int and a UInt8).
export const NUMERIC_CLASSES = new Set(["Number", "Real", "Integer", "Exact", "Inexact"]);
// (A Char is a sized integer too: its code point, a Unicode scalar value.)
export const NUMERIC_TYPES = ["Int", "UInt", ...[8, 16, 32, 64, 128].flatMap((n) => [`Int${n}`, `UInt${n}`]), "Char", "Float", "Float32", "Float64", "Fraction", "Complex", "ComplexExact", ...NUMERIC_CLASSES];
// The built-in types a value of a type the program defines converts to through
// its to instance where one is needed: an index, arithmetic, a typed pattern.
export const SCALAR_TYPES = new Set([...NUMERIC_TYPES, "String", "Char", "Bool"]);
// The scalar types a value has as its own (not a class).
export const OWN_SCALAR_TYPES = new Set([...SCALAR_TYPES].filter(t => !NUMERIC_CLASSES.has(t)));
export const TYPE_NAMES: ReadonlySet<string> = new Set([...NUMERIC_TYPES, "Dynamic", "Vect", "Mutable", "Pointer", "HashMap", "Bool", "String", "List", "Record", "Function", "Type", "Variant", "IO"]);
// Types that are their own constructors: Mutable 0 makes a
// cell, Pointer an address. Every other type is given a value only ascribed
// (a HashMap too: ([a = 1] : HashMap String Int)).
export const CONSTRUCTING_TYPES = new Set(["Mutable", "Pointer"]);
const canonical = (name: string) => name === "Float64" ? "Float" : name;
// The numeric types that hold others, each with what it holds of the rest.
const HOLDERS: Record<string, (name: string) => boolean> = {
    Number: () => true,
    Real: name => name !== "Complex" && name !== "ComplexExact",
    Integer: name => /^U?Int\d*$/.test(name) || name === "Char",
    Exact: name => !/^(Float|Complex$)/.test(name),
    Inexact: name => /^(Float|Complex$)/.test(name),
};
// Whether every value of numeric type a is one of b: Int is within Integer,
// Real and Exact; Integer within Real.
export function numericWithin(a: string, b: string): boolean {
    if (canonical(a) === canonical(b) || b === "Number") return true;
    const concrete = NUMERIC_TYPES.filter(name => !HOLDERS[name]);
    if (HOLDERS[a]) return concrete.filter(HOLDERS[a]).every(name => numericWithin(name, b));
    return !!HOLDERS[b]?.(a);
}
// Whether a pattern naming a built-in type takes every value another does
// (see clausePlaces in ast.ts), by the names alone: a literal of the type, or
// a built-in type within it. undefined for a pattern naming no built-in type.
// (The run decides a program's own types too, by their values.)
export function builtinContains(q: Pattern, p: Pattern): boolean | undefined {
    const named = (x: Pattern) => x.p === "constr" && TYPE_NAMES.has(x.tag) && (x.typed && x.args.length === 1 || !x.args.length) ? x : undefined;
    const typed = named(q);
    if (!typed) return undefined;
    const t = typed.tag, holds = typed.args.length > 0;
    if (p.p === "int" || p.p === "float") return holds && NUMERIC_TYPES.includes(t) && matchesType(t, p.p === "int" ? integer(p.v) : floating(p.v));
    if (p.p === "string" || p.p === "char" || p.p === "bool") return holds && t === { string: "String", char: "Char", bool: "Bool" }[p.p];
    const other = named(p), s = other?.tag;
    if (!other || !s || holds !== other.args.length > 0) return false;
    return NUMERIC_TYPES.includes(s) && NUMERIC_TYPES.includes(t) ? numericWithin(s, t) : s === t;
}
export function numericType(value: Numeric): string {
    return value.typeName ?? (value.kind === "int" ? "Int" : value.kind === "float" ? "Float" : value.kind === "rational" ? "Fraction" : "Complex");
}
// Extract the numeric payload without retaining a constructor's type annotation.
export function numericPayload(value: Numeric): Numeric {
    return value.kind === "complex"
        ? { ...value, typeName: undefined, re: numericPayload(value.re) as Real, im: numericPayload(value.im) as Real }
        : { ...value, typeName: undefined };
}
export function matchesType(name: string, value: Numeric): boolean {
    if (name === "Number") return true;
    if (name === "Real") return value.kind !== "complex" || (value.im.kind === "int" ? value.im.v === 0n : value.im.kind === "float" && value.im.v === 0);
    if (name === "Integer") return isInteger(value);
    if (name === "Exact") return exact(value);
    if (name === "Inexact") return !exact(value);
    return canonical(name) === canonical(numericType(value));
}
export function castNumeric(name: string, value: Numeric, explicit = false): Numeric {
    const annotation = name;
    name = canonical(name);
    if (NUMERIC_CLASSES.has(name)) {
        if (!matchesType(name, value)) throw new APNError("runtime", `value does not belong to ${name}`);
        return value;
    }
    let result: Numeric;
    // A Char: a UInt that is a Unicode scalar value (no surrogate).
    const int = name === "Char" ? ["Char", "UInt"] : name.match(/^(U?Int)(8|16|32|64|128)?$/);
    if (int) {
        const real = toReal(value);
        if (!isInteger(real) && !explicit) throw new APNError("runtime", `lossy conversion to ${name}; round explicitly before applying the type`);
        const converted = toExact(explicit ? rounding("truncate", real) : real);
        if (converted.kind !== "int") throw new APNError("runtime", `${name} requires a finite integer`);
        const n = converted.v, unsigned = int[1] === "UInt";
        if (unsigned && n < 0n) throw new APNError("runtime", `${name} cannot represent a negative integer`);
        if (int[2]) {
            const bits = BigInt(int[2]), min = unsigned ? 0n : -(1n << (bits - 1n)), max = unsigned ? (1n << bits) - 1n : (1n << (bits - 1n)) - 1n;
            if (n < min || n > max) throw new APNError("runtime", `value out of range for ${name}`);
        }
        if (name === "Char" && (n > 1114111n || n >= 55296n && n <= 57343n)) throw new APNError("runtime", `${n} is no Char: a Char is a Unicode scalar value`);
        result = integer(n);
    } else if (name === "Float" || name === "Float32") {
        const real = toReal(value), v = asFloat(real);
        result = floating(name === "Float32" ? Math.fround(v) : v);
        // A Float is a Float; anything else must convert without loss.
        if (!explicit && !(name === "Float" && real.kind === "float") && !equalNumbers(real, result) && !(real.kind === "float" && Number.isNaN(real.v) && Number.isNaN((result as { v: number }).v))) {
            throw new APNError("runtime", `lossy conversion to ${name}; round explicitly before applying the type`);
        }
    } else if (name === "Fraction") result = toExact(toReal(value));
    else if (name === "Complex" || name === "ComplexExact") result = name === "ComplexExact" ? toExact(value) : value;
    else throw new APNError("runtime", `unknown numeric type ${name}`);
    return { ...result, typeName: annotation };
}
export function implicitOperands(a: Numeric, b: Numeric): [Numeric, Numeric] {
    if (exact(a) === exact(b)) return [a, b];
    const convert = (v: Numeric) => {
        const result = toInexact(v);
        if (!equalNumbers(v, result)) throw new APNError("runtime", "lossy implicit numeric conversion; use inexact explicitly");
        return result;
    };
    return exact(a) ? [convert(a), b] : [a, convert(b)];
}
// Float (including unannotated floating values) leaves precision flexible.
// A fixed floating operand supplies the precision; two different fixed types
// require an explicit ascription before arithmetic.
function floatingOperands(a: Numeric, b: Numeric): [Numeric, Numeric, string] | undefined {
    if (a.kind !== "float" || b.kind !== "float") return undefined;
    const fixed = (v: Numeric) => v.typeName === "Float32" || v.typeName === "Float64" ? v.typeName : undefined;
    const target = fixed(a) ?? fixed(b) ?? "Float";
    return [castNumeric(target, a, true), castNumeric(target, b, true), target];
}

export function typedPower(a: Numeric, b: Numeric): Numeric {
    mixed(a, b);
    const floats = floatingOperands(a, b);
    const left = floats?.[0] ?? a, right = floats?.[1] ?? b;
    const result = numericNative("expt", [left, right]) as Numeric;
    const target = floats?.[2] ?? (a.kind === "float" ? a.typeName : undefined);
    return target && result.kind === "float" ? castNumeric(target, result, true) : result;
}

// An integer type's result that is no integer (5 / 2): a Fraction or Float.
function integerQuotient(result: Numeric): Numeric {
    return { ...result, typeName: result.kind === "rational" ? "Fraction" : "Float" };
}
// A sized integer type (Int8 ... UInt128, UInt): a type of its own over a
// range of Int (docs/intrinsics.md); Int itself is none.
export function sizedInteger(name: string | undefined): string | undefined {
    return name && name !== "Int" && /^(U?Int(8|16|32|64|128)?|Char)$/.test(name) ? name : undefined;
}
// A fixed-width number type: a sized integer or a fixed-precision float
// (Float32, Float64). Int and Float are flexible: they join any of them.
export function fixedWidth(name: string | undefined): string | undefined {
    return sizedInteger(name) ?? (name === "Float32" || name === "Float64" ? name : undefined);
}
// Two different fixed-width types do not mix: arithmetic on them is an
// error until one is converted ((x : Int64)). The error's message and hint.
export function mixedWidths(a: string | undefined, b: string | undefined): { message: string; hint: string } | undefined {
    const [left, right] = [fixedWidth(a), fixedWidth(b)];
    return left && right && left !== right ? { message: `cannot combine ${left} and ${right}`, hint: `convert one explicitly, as in \`(x : ${right})\`` } : undefined;
}
// As the APN model of the sized integers defines them: the same type keeps
// it, a sized integer with an Int keeps the sized type, the result (not the
// Int) being what must fit, and two different sized types do not mix. Other
// numbers follow the numeric tower.
function mixed(a: Numeric, b: Numeric): void {
    const error = mixedWidths(a.typeName, b.typeName);
    if (error) throw new APNError("runtime", error.message, { hint: error.hint });
}
export function typedArithmetic(op: string, a: Numeric, b: Numeric): Numeric {
    mixed(a, b);
    const floats = floatingOperands(a, b);
    if (floats) return castNumeric(floats[2], arithmetic(op, floats[0], floats[1]), true);
    const sized = sizedInteger(a.typeName) ?? sizedInteger(b.typeName);
    if (sized) {
        const [l, r] = implicitOperands(a, b), result = arithmetic(op, l, r);
        if (a.kind !== "int" || b.kind !== "int") return result;
        return result.kind === "int" ? castNumeric(sized, result) : integerQuotient(result);
    }
    // Another typed number keeps its type with an untyped one or its own
    // ((1 : Float32) / 10 is a Float32), where both convert to it.
    let target = a.typeName && b.typeName ? (a.typeName === b.typeName ? a.typeName : canonical(a.typeName) === canonical(b.typeName) ? canonical(a.typeName) : undefined) : a.typeName ?? b.typeName;
    if (target && !NUMERIC_CLASSES.has(target)) {
        try { a = castNumeric(target, a); b = castNumeric(target, b); } catch { target = undefined; }
    } else target = undefined;
    const [l, r] = implicitOperands(a, b), result = arithmetic(op, l, r);
    if (target && /^U?Int/.test(target) && result.kind !== "int") return integerQuotient(result);
    return target ? castNumeric(target, result, ["Float", "Float32", "Float64"].includes(target)) : result;
}
export function numericHash(v: Numeric): string {
    const x = toExact(v);
    return numberText({ ...x, typeName: undefined });
}
