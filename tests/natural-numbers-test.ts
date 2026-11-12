import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

// Natural numbers are UInt: Z is UInt 0, S n the next one, and the patterns
// Z and S k take a number apart (k is one less, a UInt).
function run(source: string): string {
    const i = new Interpreter();
    i.enableChecking();
    return i.renderString(i.run(parse(source)));
}
function failure(source: string): { kind?: string; message: string } {
    try { run(source); } catch (error) { return error as { kind?: string; message: string }; }
    throw new Error(`accepted: ${source}`);
}
const FACTORIAL = "factorial Z = 1; factorial (S k) = (k + 1) * factorial k; ";
const TO_LIST = "toList Z = []; toList (S k) = k :: toList k; ";

for (const [source, expected] of [
    ["Z", "0"],
    ["S (S Z)", "2"],
    ["S 5", "6"],
    [FACTORIAL + "factorial 20", "2432902008176640000"],
    [TO_LIST + "toList 3", "[2,1,0]"],
    // A bare Z takes no fields, so a second parameter stays a parameter.
    ["plus Z m = m; plus (S k) m = S (plus k m); plus 2 (3 : UInt)", "5"],
    ["fib Z = 0; fib (S Z) = 1; fib (S (S k)) = fib (S k) + fib k; fib 20", "6765"],
    // The checker evaluates them in types.
    [FACTORIAL + "([1,2,3,4,5,6] : Vect (factorial 3) Int)", "[1,2,3,4,5,6]"],
    // A program's own constructor named Z is its variant.
    ["W = | Z Int; f (Z n) = n; f (Z 3)", "3"],
    // A literal in a typed pattern is a value of that type; a sized integer
    // with a plain one keeps its type in the checker, as at runtime.
    ["h (0 : UInt) = []; h (k : UInt) = [k]; [h 0, h 4]", "[[],[4]]"],
    ["toList (k : UInt) = k == 0 ? [] : k - 1 :: toList (k - 1); toList 3", "[2,1,0]"],
    // A numeric type pattern binds a value of its type, in the checker as at
    // runtime; S k binds the predecessor, a UInt.
    ["widen (x : UInt8) = (x : Int) + 300; widen 5", "305"],
    ["keep (x : UInt8) = typeOf (x + 1); keep 5", "UInt8"],
    ["down (x : UInt8) = x == 0 ? 0 : down (x - 1); down 3", "0"],
    ["pred (S k) = k; pred 5 - 1", "3"],
    // (_ x) takes the payload and discards the type.
    ["payload (x : _) = x; payload (5 : Int32)", "5"],
    // A new type's value is taken apart with its pattern, not by its base type.
    ["Money (x : Float) = _; amount (Money m) = m; (amount $ Money 1.2 : Float)", "1.2"],
    ["Money (x : Float) = _; Cents (x : Int) = _; amount (Money m) = m; Cents (amount (Money 3.0) : Int)", "Cents 3"],
] as const) {
    Deno.test(`natural numbers: ${source}`, () => {
        const actual = run(source);
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
}

for (const [source, kind, message] of [
    [FACTORIAL + "factorial -1", "type", "UInt cannot represent a negative integer"],
    [FACTORIAL + "([1,2] : Vect (factorial 3) Int)", "type", "length mismatch: expected 6, got 2"],
    ["S -1", "type", "UInt cannot represent a negative integer"],
    ["h (-1 : UInt) = 1; h 1", "type", "UInt cannot represent a negative integer"],
    ["h (300 : UInt8) = 1; h 1", "type", "value out of range for UInt8"],
    ["pred (S k) = k; pred 0", "type", "no clause of 'pred' matches these arguments"],
    // x is a UInt8 inside: its sum must fit, and two sized types do not mix,
    // which the check sees from the patterns alone.
    ["widen (x : UInt8) = x + 300; widen 5", "runtime", "value out of range for UInt8"],
    ["f (x : Int32) (y : Int64) = x + y\n1", "type", "cannot combine Int32 and Int64"],
] as const) {
    Deno.test(`natural numbers reject: ${source}`, () => {
        const error = failure(source);
        if (error.kind !== kind || !error.message.includes(message)) throw new Error(`${error.kind}: ${error.message}`);
    });
}
