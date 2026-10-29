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
    ["Z", "UInt 0"],
    ["S (S Z)", "UInt 2"],
    ["S 5", "UInt 6"],
    [FACTORIAL + "factorial 20", "UInt 2432902008176640000"],
    [TO_LIST + "toList 3", "[UInt 2, UInt 1, UInt 0]"],
    // A bare Z takes no fields, so a second parameter stays a parameter.
    ["plus Z m = m; plus (S k) m = S (plus k m); plus 2 (UInt 3)", "UInt 5"],
    ["fib Z = 0; fib (S Z) = 1; fib (S (S k)) = fib (S k) + fib k; fib 20", "6765"],
    // The checker evaluates them in types.
    [FACTORIAL + "Vect (factorial 3) Int [1,2,3,4,5,6]", "[1,2,3,4,5,6]"],
    // A program's own constructor named Z is its variant.
    ["W = | Z Int; f (Z n) = n; f (Z 3)", "3"],
    // A literal in a typed pattern is a value of that type; a sized integer
    // with a plain one keeps its type in the checker, as at runtime.
    ["h (UInt 0) = []; h (UInt k) = [k]; [h 0, h 4]", "[[],[4]]"],
    ["toList (UInt k) = k == 0 ? [] : k - 1 :: toList (k - 1); toList 3", "[2,1,0]"],
    // A numeric type pattern binds the untyped payload, in the checker as at
    // runtime; S k binds the predecessor, a UInt.
    ["widen (UInt8 x) = x + 300; widen 5", "305"],
    ["down (UInt8 x) = x == 0 ? 0 : down (x - 1); down 3", "0"],
    ["pred (S k) = k; pred 5 - 1", "UInt 3"],
    // (_ x) takes the payload and discards the type.
    ["payload (_ x) = x; payload (Int32 5)", "5"],
    // A := value is taken apart with its pattern, not by its base type (opaque).
    ["Money := Float; amount (Money m) = m; Float $ amount $ Money 1.2", "1.2"],
    ["Money := Float; Cents := Int; amount (Money m) = m; Cents (Int (amount (Money 3.0)))", "Cents 3"],
] as const) {
    Deno.test(`natural numbers: ${source}`, () => {
        const actual = run(source);
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
}

for (const [source, kind, message] of [
    [FACTORIAL + "factorial -1", "type", "UInt cannot represent a negative integer"],
    [FACTORIAL + "Vect (factorial 3) Int [1,2]", "type", "length mismatch: expected 6, got 2"],
    ["S -1", "type", "UInt cannot represent a negative integer"],
    ["h (UInt (-1)) = 1; h 1", "type", "UInt cannot represent a negative integer"],
    ["h (UInt8 300) = 1; h 1", "type", "value out of range for UInt8"],
    ["pred (S k) = k; pred 0", "type", "no clause of 'pred' matches these arguments"],
] as const) {
    Deno.test(`natural numbers reject: ${source}`, () => {
        const error = failure(source);
        if (error.kind !== kind || !error.message.includes(message)) throw new Error(`${error.kind}: ${error.message}`);
    });
}
