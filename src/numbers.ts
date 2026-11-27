import { checkInterrupt } from "./interrupt.ts";
import { APNError } from "./errors.ts";

export type Real = ({ kind: "int"; v: bigint } | { kind: "rational"; n: bigint; d: bigint } | { kind: "float"; v: number }) & { typeName?: string };
export type Numeric = Real | { kind: "complex"; re: Real; im: Real; typeName?: string };
export const integer = (v: bigint): Real => ({ kind: "int", v });
export const floating = (v: number): Real => ({ kind: "float", v });
const fail = (message: string): never => { throw new APNError("runtime", message); };
export function isNumeric(v: { kind: string }): v is Numeric {
    return ["int", "rational", "float", "complex"].includes(v.kind);
}
export function gcd(a: bigint, b: bigint): bigint {
    a = a < 0n ? -a : a; b = b < 0n ? -b : b;
    while (b) { checkInterrupt(); [a, b] = [b, a % b]; }
    return a;
}
export function rational(n: bigint, d: bigint): Real {
    if (!d) return fail("division by zero");
    if (d < 0n) { n = -n; d = -d; }
    const g = gcd(n, d); n /= g; d /= g;
    return d === 1n ? integer(n) : { kind: "rational", n, d };
}
export function exact(v: Numeric): boolean {
    return v.kind === "complex" ? exact(v.re) && exact(v.im) : v.kind !== "float";
}
export function zero(v: Numeric): boolean {
    return v.kind === "complex" ? zero(v.re) && zero(v.im) : v.kind === "rational" ? v.n === 0n : v.v == 0;
}
export function toReal(v: Numeric): Real {
    if (v.kind !== "complex") return v;
    if (zero(v.im)) return v.re;
    return fail("expected a real number");
}
export function asFloat(v: Real): number {
    if (v.kind !== "rational") return Number(v.v);
    // Round the exact ratio to nearest binary64, ties to even. Handle normal
    // and subnormal values without overflowing either BigInt operand.
    const negative = v.n < 0n, n = negative ? -v.n : v.n;
    if (!n) return negative ? -0 : 0;
    let exponent = n.toString(2).length - v.d.toString(2).length;
    if (exponent >= 0 ? n < (v.d << BigInt(exponent)) : (n << BigInt(-exponent)) < v.d) exponent--;
    const shift = Math.max(exponent - 52, -1074);
    const num = shift < 0 ? n << BigInt(-shift) : n;
    const den = shift > 0 ? v.d << BigInt(shift) : v.d;
    let q = num / den;
    const rem = num % den;
    if (rem * 2n > den || (rem * 2n === den && q % 2n !== 0n)) q++;
    return (negative ? -1 : 1) * Number(q) * 2 ** shift;
}
export function toExact(v: Numeric): Numeric {
    if (v.kind === "complex") return complex(toExact(v.re) as Real, toExact(v.im) as Real);
    if (v.kind !== "float") return v;
    if (!Number.isFinite(v.v)) return fail("cannot make infinity or NaN exact");
    if (v.v === 0) return integer(0n);
    const bits = new DataView(new ArrayBuffer(8)); bits.setFloat64(0, v.v);
    const high = bits.getUint32(0), low = bits.getUint32(4);
    const exp = (high >>> 20) & 2047;
    let mantissa = (BigInt(high & 0xfffff) << 32n) | BigInt(low);
    if (exp) mantissa |= 1n << 52n;
    if (high >>> 31) mantissa = -mantissa;
    const power = (exp || 1) - 1023 - 52;
    return power >= 0 ? integer(mantissa << BigInt(power)) : rational(mantissa, 1n << BigInt(-power));
}
export function toInexact(v: Numeric): Numeric {
    return v.kind === "complex" ? complex(floating(asFloat(v.re)), floating(asFloat(v.im))) : floating(asFloat(v));
}
export function complex(re: Real, im: Real): Numeric {
    if (exact(re) && exact(im)) return zero(im) ? re : { kind: "complex", re, im };
    return { kind: "complex", re: floating(asFloat(re)), im: floating(asFloat(im)) };
}
export function parts(v: Numeric): [Real, Real] {
    return v.kind === "complex" ? [v.re, v.im] : [v, exact(v) ? integer(0n) : floating(0)];
}
function fraction(v: Real): [bigint, bigint] {
    const x = toExact(v) as Real;
    return x.kind === "int" ? [x.v, 1n] : x.kind === "rational" ? [x.n, x.d] : fail("expected finite rational");
}
export function negate(v: Numeric): Numeric {
    return v.kind === "complex" ? complex(negate(v.re) as Real, negate(v.im) as Real)
        : v.kind === "rational" ? rational(-v.n, v.d) : v.kind === "int" ? integer(-v.v) : floating(-v.v);
}
export function arithmetic(op: string, a: Numeric, b: Numeric): Numeric {
    if (a.kind === "complex" || b.kind === "complex") {
        const [x, y] = parts(a), [u, v] = parts(b);
        const calc = (op: string, a: Real, b: Real) => arithmetic(op, a, b) as Real;
        if (op === "+" || op === "-") return complex(calc(op, x, u), calc(op, y, v));
        if (op === "*") return complex(calc("-", calc("*", x, u), calc("*", y, v)), calc("+", calc("*", x, v), calc("*", y, u)));
        if (op === "/") {
            if (!exact(a) || !exact(b)) {
                const ar = asFloat(x), ai = asFloat(y), br = asFloat(u), bi = asFloat(v);
                const scale = Math.max(Math.abs(br), Math.abs(bi));
                if (scale > 0 && Number.isFinite(scale)) {
                    const c = br / scale, d = bi / scale, norm = c * c + d * d;
                    return complex(floating(((ar / scale) * c + (ai / scale) * d) / norm), floating(((ai / scale) * c - (ar / scale) * d) / norm));
                }
            }
            const d = calc("+", calc("*", u, u), calc("*", v, v));
            return complex(calc("/", calc("+", calc("*", x, u), calc("*", y, v)), d), calc("/", calc("-", calc("*", y, u), calc("*", x, v)), d));
        }
        return fail("remainder requires real integers");
    }
    if (op === "%") return integerDivision("remainder", a, b);
    if (a.kind === "float" || b.kind === "float") {
        const x = asFloat(a), y = asFloat(b);
        return floating(op === "+" ? x + y : op === "-" ? x - y : op === "*" ? x * y : x / y);
    }
    const [n, d] = fraction(a), [m, e] = fraction(b);
    if (op === "+" || op === "-") return rational(op === "+" ? n * e + m * d : n * e - m * d, d * e);
    if (op === "*") return times(n, d, m, e);
    if (!m) return fail("division by zero");
    return m < 0n ? times(n, d, -e, -m) : times(n, d, e, m);
}
// n/d times m/e, each in lowest terms with a positive denominator: each
// numerator cancelled against the other's denominator first leaves the
// product in lowest terms, with no gcd of it taken (a product of many
// fractions grows long; its factors stay small).
function times(n: bigint, d: bigint, m: bigint, e: bigint): Real {
    if (!n || !m) return integer(0n);
    const g = gcd(n, e), h = gcd(m, d), den = (d / h) * (e / g);
    return den === 1n ? integer((n / g) * (m / h)) : { kind: "rational", n: (n / g) * (m / h), d: den };
}
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
export function compareNumbers(a: Numeric, b: Numeric): number {
    const x = toReal(a), y = toReal(b);
    // Exactly, without fractions: two floats, or a float and an integer a
    // double holds exactly (NaN compares as NaN).
    const plain = (v: Real) => v.kind === "float" ? v.v : v.kind === "int" && v.v >= -MAX_SAFE && v.v <= MAX_SAFE ? Number(v.v) : undefined;
    if (x.kind === "float" || y.kind === "float") {
        const l = plain(x), r = plain(y);
        if (l !== undefined && r !== undefined) return Number.isNaN(l) || Number.isNaN(r) ? NaN : l === r ? 0 : l < r ? -1 : 1;
    } else if (x.kind === "int" && y.kind === "int") return x.v < y.v ? -1 : x.v > y.v ? 1 : 0;
    if ((x.kind === "float" && !Number.isFinite(x.v)) || (y.kind === "float" && !Number.isFinite(y.v))) {
        const l = asFloat(x), r = asFloat(y);
        return Number.isNaN(l) || Number.isNaN(r) ? NaN : l === r ? 0 : l < r ? -1 : 1;
    }
    const [n, d] = fraction(x), [m, e] = fraction(y);
    const diff = n * e - m * d;
    return diff < 0n ? -1 : diff > 0n ? 1 : 0;
}
export function equalNumbers(a: Numeric, b: Numeric): boolean {
    const [x, y] = parts(a), [u, v] = parts(b);
    return compareNumbers(x, u) === 0 && compareNumbers(y, v) === 0;
}
export function isInteger(v: Numeric): boolean {
    if (v.kind === "complex") return zero(v.im) && isInteger(v.re);
    return v.kind === "int" || (v.kind === "float" && Number.isInteger(v.v));
}
export function integerDivision(name: string, a: Numeric, b: Numeric): Real {
    if (!isInteger(a) || !isInteger(b)) return fail(`${name} expects integers`);
    const x = toReal(a), y = toReal(b);
    const [n] = fraction(x), [d] = fraction(y);
    if (!d) return fail(name === "quotient" ? "division by zero" : "remainder by zero");
    let result = name === "quotient" ? n / d : n % d;
    if (name === "modulo" && result && (result < 0n) !== (d < 0n)) result += d;
    return exact(a) && exact(b) ? integer(result) : floating(Number(result));
}
export function rounding(name: string, value: Numeric): Real {
    const v = toReal(value);
    if (v.kind === "float" && !Number.isFinite(v.v)) return v;
    const [n, d] = fraction(v);
    let q = n / d, rem = n % d;
    if (name === "floor" && rem < 0n) q--;
    if (name === "ceiling" && rem > 0n) q++;
    if (name === "round") {
        rem = rem < 0n ? -rem : rem;
        if (rem * 2n > d || (rem * 2n === d && q % 2n !== 0n)) q += n < 0n ? -1n : 1n;
    }
    return exact(v) ? integer(q) : floating(q === 0n && asFloat(v) < 0 ? -0 : Number(q));
}
function integerSqrt(n: bigint): bigint {
    if (n < 2n) return n;
    let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
    for (;;) { checkInterrupt(); const y = (x + n / x) / 2n; if (y >= x) return x; x = y; }
}
export function sqrt(v: Numeric): Numeric {
    if (v.kind === "complex") {
        const [x, y] = parts(v);
        if (zero(y)) {
            const result = sqrt(x);
            return exact(v) ? result : toInexact(result);
        }
        if (!exact(v)) {
            const a = asFloat(x), b = asFloat(y), scale = Math.max(Math.abs(a), Math.abs(b));
            if (Number.isFinite(scale) && scale > 0) {
                const radius = Math.hypot(a / scale, b / scale);
                const t = Math.sqrt(scale) * Math.sqrt((radius + Math.abs(a / scale)) / 2);
                return a >= 0 ? complex(floating(t), floating(b / (2 * t)))
                    : complex(floating(Math.abs(b) / (2 * t)), floating(b < 0 ? -t : t));
            }
        }
        const magnitude = sqrt(arithmetic("+", arithmetic("*", x, x), arithmetic("*", y, y)));
        const re = sqrt(arithmetic("/", arithmetic("+", magnitude, x), integer(2n))) as Real;
        const im = arithmetic("/", y, arithmetic("*", integer(2n), re)) as Real;
        return complex(re, im);
    }
    if (compareNumbers(v, integer(0n)) < 0) return complex(exact(v) ? integer(0n) : floating(0), sqrt(negate(v)) as Real);
    if (exact(v)) {
        const [n, d] = fraction(v), a = integerSqrt(n), b = integerSqrt(d);
        if (a * a === n && b * b === d) return rational(a, b);
        const halfExponent = Math.floor((n.toString(2).length - d.toString(2).length) / 2);
        const scaled = halfExponent >= 0 ? rational(n, d << BigInt(2 * halfExponent)) : rational(n << BigInt(-2 * halfExponent), d);
        return floating(Math.sqrt(asFloat(scaled)) * 2 ** halfExponent);
    }
    return floating(Math.sqrt(asFloat(v)));
}
// Keep decimal conversion cooperative instead of handing millions of digits to
// one uninterruptible BigInt.toString call. Leaf conversions stay small.
const decimalChunkBase = 10n ** 1024n;
function integerText(value: bigint): string {
    checkInterrupt();
    const negative = value < 0n;
    const n = negative ? -value : value;
    if (n < decimalChunkBase) return String(value);
    const powers = [decimalChunkBase];
    while (n >= powers[powers.length - 1]) {
        checkInterrupt();
        const last = powers[powers.length - 1];
        powers.push(last * last);
    }
    function digits(v: bigint, level: number): string {
        checkInterrupt();
        if (level < 0) return String(v);
        const divisor = powers[level];
        const high = v / divisor;
        const low = v % divisor;
        if (!high) return digits(low, level - 1);
        const prefix = digits(high, level - 1);
        const suffix = digits(low, level - 1);
        checkInterrupt();
        return prefix + suffix.padStart(1024 * 2 ** level, "0");
    }
    const text = digits(n, powers.length - 2);
    checkInterrupt();
    return negative ? "-" + text : text;
}

export function numberText(v: Numeric): string {
    if (v.kind === "rational") return `${integerText(v.n)}/${integerText(v.d)}`;
    if (v.kind === "complex") {
        const im = numberText(v.im);
        return `${numberText(v.re)}${im.startsWith("-") || im.startsWith("+") ? "" : "+"}${im}i`;
    }
    if (v.kind === "int") return integerText(v.v);
    if (Number.isNaN(v.v)) return "+nan.0";
    if (!Number.isFinite(v.v)) return v.v < 0 ? "-inf.0" : "+inf.0";
    if (Object.is(v.v, -0)) return "-0.0";
    let text = String(v.v);
    if (v.typeName === "Float32") {
        // Binary32 needs at most nine significant decimal digits to round-trip.
        // Find the shortest precision that recovers this exact binary32 value.
        for (let precision = 1; precision <= 9; precision++) {
            const candidate = Number(v.v.toPrecision(precision));
            if (Object.is(Math.fround(candidate), v.v)) {
                text = String(candidate);
                break;
            }
        }
    }
    return /[.e]/i.test(text) ? text : text + ".0";
}
export const NUMBER_NATIVES: Array<[string, number]> = [
    ...["isNumber", "isComplex", "isReal", "isRational", "isInteger", "isExact", "isInexact", "isZero", "isPositive", "isNegative", "isOdd", "isEven", "isFinite", "isInfinite", "isNaN", "exact", "inexact", "numerator", "denominator", "floor", "ceiling", "truncate", "round", "sqrt", "abs", "realPart", "imagPart", "magnitude", "angle", "conjugate", "exp", "log", "sin", "cos", "tan", "asin", "acos", "atan"].map((name): [string, number] => [name, 1]),
    ...["quotient", "remainder", "modulo", "gcd", "lcm", "min", "max", "expt", "makeRectangular", "makePolar", "atan2", "rationalize"].map((name): [string, number] => [name, 2]),
];
export const NUMBER_ARITIES = new Map(NUMBER_NATIVES);
export function numericNative(name: string, args: Array<{ kind: string }>): Numeric | boolean {
    const a = args[0];
    if (["isNumber", "isComplex", "isReal", "isRational", "isInteger"].includes(name)) {
        if (!isNumeric(a)) return false;
        if (name === "isNumber" || name === "isComplex") return true;
        if (name === "isInteger") return isInteger(a);
        if (a.kind === "complex" && !zero(a.im)) return false;
        return name === "isReal" || Number.isFinite(asFloat(toReal(a))) || exact(a);
    }
    if (!args.every(isNumeric)) return fail(`${name} expects numbers`);
    const [x, y] = args as Numeric[];
    if (name === "isExact") return exact(x);
    if (name === "isInexact") return !exact(x);
    if (name === "isZero") return zero(x);
    if (name === "exact") return toExact(x);
    if (name === "inexact") return toInexact(x);
    if (name === "makeRectangular") return complex(toReal(x), toReal(y));
    if (name === "realPart") return parts(x)[0];
    if (name === "imagPart") return parts(x)[1];
    if (name === "conjugate") { const [a, b] = parts(x); return complex(a, negate(b) as Real); }
    if (name === "sqrt") return sqrt(x);
    if (name === "magnitude") { const [a, b] = parts(x); return sqrt(arithmetic("+", arithmetic("*", a, a), arithmetic("*", b, b))); }
    if (name === "angle") { const [a, b] = parts(x); return floating(Math.atan2(asFloat(b), asFloat(a))); }
    if (name === "expt") {
        if (y.kind === "int") {
            let count = y.v < 0n ? -y.v : y.v, base = x, result: Numeric = integer(1n);
            while (count) {
                checkInterrupt();
                if (count & 1n) result = arithmetic("*", result, base);
                checkInterrupt();
                count >>= 1n;
                if (count) base = arithmetic("*", base, base);
            }
            checkInterrupt();
            return y.v < 0n ? arithmetic("/", integer(1n), result) : result;
        }
        if (y.kind === "rational" && y.d === 2n) return numericNative("expt", [sqrt(x), integer(y.n)]) as Numeric;
        if (x.kind !== "complex" && y.kind !== "complex" && (asFloat(x) >= 0 || isInteger(y))) return floating(Math.pow(asFloat(x), asFloat(y)));
        return transcendental("exp", arithmetic("*", y, transcendental("log", x)));
    }
    if (["exp", "log", "sin", "cos", "tan", "asin", "acos", "atan"].includes(name)) return transcendental(name, x);
    if (name === "isFinite" || name === "isInfinite" || name === "isNaN") {
        const vals = parts(x).map((v) => exact(v) ? 0 : asFloat(v));
        return name === "isFinite" ? vals.every(Number.isFinite) : name === "isNaN" ? vals.some(Number.isNaN) : vals.some((v) => Math.abs(v) === Infinity);
    }
    const real = toReal(x);
    if (name === "abs") return real.kind === "float" ? floating(Math.abs(real.v)) : compareNumbers(real, integer(0n)) < 0 ? negate(real) : real;
    if (name === "isPositive" || name === "isNegative") return name === "isPositive" ? compareNumbers(real, integer(0n)) > 0 : compareNumbers(real, integer(0n)) < 0;
    if (name === "isOdd" || name === "isEven") {
        if (!isInteger(real)) return fail(`${name} expects an integer`);
        return (fraction(real)[0] % 2n === 0n) === (name === "isEven");
    }
    if (["floor", "ceiling", "truncate", "round"].includes(name)) return rounding(name, real);
    if (name === "numerator" || name === "denominator") {
        const result = fraction(real)[name === "numerator" ? 0 : 1];
        return exact(real) ? integer(result) : floating(Number(result));
    }
    if (["quotient", "remainder", "modulo"].includes(name)) return integerDivision(name, x, y);
    const other = toReal(y);
    if (name === "gcd" || name === "lcm") {
        if (!isInteger(real) || !isInteger(other)) return fail(`${name} expects integers`);
        const n = fraction(real)[0], d = fraction(other)[0], g = gcd(n, d);
        let result = name === "gcd" ? g : g ? (n / g) * d : 0n;
        if (result < 0n) result = -result;
        return exact(x) && exact(y) ? integer(result) : floating(Number(result));
    }
    if (name === "min" || name === "max") {
        const cmp = compareNumbers(real, other);
        if (Number.isNaN(cmp)) return floating(NaN);
        const result = (name === "min" ? cmp <= 0 : cmp >= 0) ? real : other;
        return exact(x) && exact(y) ? result : toInexact(result);
    }
    if (name === "atan2") return floating(Math.atan2(asFloat(real), asFloat(other)));
    if (name === "makePolar") {
        // An exact zero angle needs no trigonometric approximation.
        if (exact(other) && zero(other)) return real;
        return complex(floating(asFloat(real) * Math.cos(asFloat(other))), floating(asFloat(real) * Math.sin(asFloat(other))));
    }
    if (name === "rationalize") {
        const tolerance = compareNumbers(other, integer(0n)) < 0 ? negate(other) : other;
        const lo = arithmetic("-", toExact(real), toExact(tolerance)), hi = arithmetic("+", toExact(real), toExact(tolerance));
        const result = simplest(lo as Real, hi as Real);
        return exact(x) && exact(y) ? result : toInexact(result);
    }
    return fail(`unknown numeric function ${name}`);
}
function simplest(lo: Real, hi: Real): Real {
    if (compareNumbers(lo, hi) === 0) return lo;
    if (compareNumbers(lo, integer(0n)) <= 0 && compareNumbers(hi, integer(0n)) >= 0) return integer(0n);
    if (compareNumbers(hi, integer(0n)) < 0) return negate(simplest(negate(hi) as Real, negate(lo) as Real)) as Real;
    const floor = rounding("floor", lo), ceiling = rounding("ceiling", lo);
    if (compareNumbers(ceiling, hi) <= 0) return ceiling;
    const next = simplest(arithmetic("/", integer(1n), arithmetic("-", hi, floor)) as Real, arithmetic("/", integer(1n), arithmetic("-", lo, floor)) as Real);
    return arithmetic("+", floor, arithmetic("/", integer(1n), next)) as Real;
}
function transcendental(name: string, z: Numeric): Numeric {
    const [re, im] = parts(z), x = asFloat(re), y = asFloat(im);
    if (zero(im)) {
        if (exact(z) && ((zero(re) && ["sin", "tan", "asin", "atan"].includes(name)) || (equalNumbers(re, integer(1n)) && ["log", "acos"].includes(name)))) return integer(0n);
        if (exact(z) && zero(re) && ["exp", "cos"].includes(name)) return integer(1n);
        if (name !== "log" || x >= 0) {
            const fn = ({ exp: Math.exp, log: Math.log, sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan } as Record<string, (x: number) => number>)[name];
            const result = fn(x);
            if (!Number.isNaN(result) || Number.isNaN(x)) return floating(result);
        }
    }
    if (name === "exp") return complex(floating(Math.exp(x) * Math.cos(y)), floating(Math.exp(x) * Math.sin(y)));
    if (name === "log") return complex(floating(Math.log(Math.hypot(x, y))), floating(Math.atan2(y, x)));
    if (name === "sin") return complex(floating(Math.sin(x) * Math.cosh(y)), floating(Math.cos(x) * Math.sinh(y)));
    if (name === "cos") return complex(floating(Math.cos(x) * Math.cosh(y)), floating(-Math.sin(x) * Math.sinh(y)));
    if (name === "tan") return arithmetic("/", transcendental("sin", z), transcendental("cos", z));
    const i = complex(integer(0n), integer(1n)), one = integer(1n);
    if (name === "asin") return arithmetic("*", negate(i), transcendental("log", arithmetic("+", arithmetic("*", i, z), sqrt(arithmetic("-", one, arithmetic("*", z, z))))));
    if (name === "acos") return arithmetic("-", floating(Math.PI / 2), transcendental("asin", z));
    return arithmetic("*", arithmetic("/", i, integer(2n)), arithmetic("-", transcendental("log", arithmetic("-", one, arithmetic("*", i, z))), transcendental("log", arithmetic("+", one, arithmetic("*", i, z)))));
}

// Numeric text only: never evaluate a string as APN source.
export function parseNumberText(text: string): Numeric | null {
    const s = text.trim();
    if (/^[+-](inf|nan)\.0$/i.test(s)) return floating(/nan/i.test(s) ? NaN : s[0] === "-" ? -Infinity : Infinity);
    if (/^[+-]?(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+)$/.test(s)) {
        const negative = s.startsWith("-");
        return integer((negative ? -1n : 1n) * BigInt(s.replace(/^[+-]/, "")));
    }
    const ratio = s.match(/^([+-]?\d+)\/([+-]?\d+)$/);
    if (ratio) return rational(BigInt(ratio[1]), BigInt(ratio[2]));
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) return floating(Number(s));
    if (s.includes("@")) {
        const pieces = s.split("@");
        if (pieces.length !== 2) return null;
        const radius = parseNumberText(pieces[0]), angle = parseNumberText(pieces[1]);
        if (!radius || !angle || radius.kind === "complex" || angle.kind === "complex") return null;
        return numericNative("makePolar", [radius, angle]) as Numeric;
    }
    if (s.endsWith("i")) {
        const body = s.slice(0, -1);
        for (let i = 1; i < body.length; i++) {
            if (!"+-".includes(body[i]) || /[eE/]/.test(body[i - 1])) continue;
            const re = parseNumberText(body.slice(0, i)), im = parseNumberText(body.slice(i));
            if (re && im && re.kind !== "complex" && im.kind !== "complex") return complex(re, im);
        }
    }
    return null;
}
