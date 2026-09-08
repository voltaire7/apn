import { type Numeric, type Real, isNumeric, integer, floating, toReal, toExact, toInexact, isInteger, exact, equalNumbers, asFloat, rounding, arithmetic, numberText } from "./numbers.ts";
import { APNError } from "./errors.ts";

export const NUMERIC_TYPES = ["Int", "UInt", ...[8, 16, 32, 64, 128].flatMap((n) => [`Int${n}`, `UInt${n}`]), "Float", "Float32", "Float64", "Fraction", "Complex", "ComplexExact", "Number", "Real", "Integer", "Exact", "Inexact"];
export const TYPE_NAMES = [...NUMERIC_TYPES, "HashMap"];
const canonical = (name: string) => name === "Float64" ? "Float" : name;
export function numericType(value: Numeric): string {
    return value.typeName ?? (value.kind === "int" ? "Int" : value.kind === "float" ? "Float" : value.kind === "rational" ? "Fraction" : "Complex");
}
export function matchesType(name: string, value: Numeric): boolean {
    if (name === "Number") return true;
    if (name === "Real") return value.kind !== "complex" || (value.im.kind === "int" ? value.im.v === 0n : value.im.kind === "float" && value.im.v === 0);
    if (name === "Integer") return isInteger(value);
    if (name === "Exact") return exact(value);
    if (name === "Inexact") return !exact(value);
    return canonical(name) === numericType(value);
}
export function castNumeric(name: string, value: Numeric, explicit = false): Numeric {
    name = canonical(name);
    if (["Number", "Real", "Integer", "Exact", "Inexact"].includes(name)) {
        if (!matchesType(name, value)) throw new APNError("runtime", `value does not belong to ${name}`);
        return value;
    }
    let result: Numeric;
    const int = name.match(/^(U?Int)(8|16|32|64|128)?$/);
    if (int) {
        const real = toReal(value);
        if (!isInteger(real) && !explicit) throw new APNError("runtime", `lossy conversion to ${name}; use cast ${name}`);
        const converted = toExact(explicit ? rounding("truncate", real) : real);
        if (converted.kind !== "int") throw new APNError("runtime", `${name} requires a finite integer`);
        const n = converted.v, unsigned = int[1] === "UInt";
        if (unsigned && n < 0n) throw new APNError("runtime", `${name} cannot represent a negative integer`);
        if (int[2]) {
            const bits = BigInt(int[2]), min = unsigned ? 0n : -(1n << (bits - 1n)), max = unsigned ? (1n << bits) - 1n : (1n << (bits - 1n)) - 1n;
            if (n < min || n > max) throw new APNError("runtime", `value out of range for ${name}`);
        }
        result = integer(n);
    } else if (name === "Float" || name === "Float32") {
        const real = toReal(value), v = asFloat(real);
        result = floating(name === "Float32" ? Math.fround(v) : v);
        if (!explicit && !equalNumbers(real, result) && !(real.kind === "float" && Number.isNaN(real.v) && Number.isNaN((result as { v: number }).v))) {
            throw new APNError("runtime", `lossy conversion to ${name}; use cast ${name}`);
        }
    } else if (name === "Fraction") result = toExact(toReal(value));
    else if (name === "Complex" || name === "ComplexExact") result = name === "ComplexExact" ? toExact(value) : value;
    else throw new APNError("runtime", `unknown numeric type ${name}`);
    return { ...result, typeName: name };
}
export function implicitOperands(a: Numeric, b: Numeric): [Numeric, Numeric] {
    if (exact(a) === exact(b)) return [a, b];
    const convert = (v: Numeric) => {
        const result = toInexact(v);
        if (!equalNumbers(v, result)) throw new APNError("runtime", "lossy implicit numeric conversion; use cast Float or inexact explicitly");
        return result;
    };
    return exact(a) ? [convert(a), b] : [a, convert(b)];
}
export function typedArithmetic(op: string, a: Numeric, b: Numeric): Numeric {
    let target: string | undefined;
    if (a.typeName && b.typeName && canonical(a.typeName) === canonical(b.typeName)) target = canonical(a.typeName);
    else if (a.typeName && b.typeName) {
        const rank = (name: string) => name.startsWith("Complex") ? 1000 : name === "Float" || name === "Float64" ? 900 : name === "Float32" ? 800 : name === "Fraction" ? 700 : name === "Int" || name === "UInt" ? 600 : Number(name.match(/\d+/)?.[0] ?? 0);
        const candidates = [a.typeName, b.typeName].sort((x, y) => rank(y) - rank(x));
        for (const name of candidates) {
            try { castNumeric(name, a); castNumeric(name, b); target = canonical(name); break; } catch { /* try the other operand type */ }
        }
    }
    else if (a.typeName && !b.typeName) target = a.typeName;
    else if (b.typeName && !a.typeName) target = b.typeName;
    if (target && !["Number", "Real", "Integer", "Exact", "Inexact"].includes(target)) {
        try { a = castNumeric(target, a); b = castNumeric(target, b); }
        catch (e) {
            // A broader existing operand type can represent both without loss.
            target = undefined;
        }
    }
    const [left, right] = implicitOperands(a, b);
    const result = arithmetic(op, left, right);
    if (!target) return result;
    if (/^(U?Int)/.test(target) && result.kind !== "int") return { ...result, typeName: result.kind === "rational" ? "Fraction" : "Float" };
    // Floating arithmetic rounds as part of the operation, not an implicit cast.
    return castNumeric(target, result, target === "Float" || target === "Float32");
}
export function numericHash(v: Numeric): string {
    const x = toExact(v);
    return numberText({ ...x, typeName: undefined });
}
