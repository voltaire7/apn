import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

// Indexed families: a constructor says the type it makes
// (VCons a (Vec k a) -> Vec (S k) a), and a value's indices follow.
const VEC = "Vec n a = VNil -> Vec Z a | VCons a (Vec k a) -> Vec (S k) a\nxs = VCons 1 (VCons 2 VNil)\n";
const APPEND = "append VNil ys = ys\nappend (VCons x rest) ys = VCons x (append rest ys)\n";
// Each clause claims its result's index; the checker proves the claims by induction.
const APP = "app (VNil : Vec n a) (ys : Vec m a) = ys : Vec (n + m) a\napp (VCons x r : Vec n a) (ys : Vec m a) = ";
const REV = "rev (VNil : Vec n a) (acc : Vec m a) = acc : Vec (n + m) a\nrev (VCons x r : Vec n a) (acc : Vec m a) = ";
function run(source: string): string {
    const i = new Interpreter();
    i.enableChecking();
    return i.renderString(i.run(parse(source)));
}
function failure(source: string): { kind?: string; message: string } {
    try { run(source); } catch (error) { return error as { kind?: string; message: string }; }
    throw new Error(`accepted: ${source}`);
}

for (const [source, expected] of [
    [VEC + "xs", "VCons 1 (VCons 2 VNil)"],
    [VEC + "typeOf xs", "Vec 2 Int"],
    [VEC + "typeOf VNil", "Vec 0 a"],
    [VEC + "(xs : Vec 2 Int)", "VCons 1 (VCons 2 VNil)"],
    [VEC + APPEND + "typeOf (append xs xs)", "Vec 4 Int"],
    [VEC + APPEND + "(append xs xs : Vec 4 Int)", "VCons 1 (VCons 2 (VCons 1 (VCons 2 VNil)))"],
    // A typed pattern binds the indices: n is a value, a a type.
    [VEC + "len (_ : Vec n _) = n\nlen xs + 1", "3"],
    [VEC + "elem (_ : Vec _ a) = a\nelem xs", "Int"],
    [VEC + "first (VCons x _) = x\nfirst xs", "1"],
    // Each clause may state its result's indices.
    [VEC + APP + "VCons x (app r ys) : Vec (n + m) a\ntypeOf (app xs xs)", "Vec 4 Int"],
    // Proven by induction: an accumulator, a doubling, a proven function's claim.
    [VEC + REV + "rev r (VCons x acc) : Vec (n + m) a\nrev xs VNil", "VCons 2 (VCons 1 VNil)"],
    [VEC + "dbl (VNil : Vec n a) = VNil : Vec (2 * n) a\ndbl (VCons x r : Vec n a) = VCons x (VCons x (dbl r)) : Vec (2 * n) a\ntypeOf (dbl xs)", "Vec 4 Int"],
    [VEC + APP + "VCons x (app r ys) : Vec (n + m) a\ntwice (v : Vec n a) = app v v : Vec (n + n) a\ntypeOf (twice xs)", "Vec 4 Int"],
    // Recursion that does not shrink proves nothing: its claim is checked when it runs.
    [VEC + "loop (v : Vec n a) = loop v : Vec (n + 1) a\n1", "1"],
] as const) {
    Deno.test(`indexed families: ${source}`, () => {
        const actual = run(source);
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
}

for (const [source, kind, message] of [
    // Known values are checked before the run.
    [VEC + "(xs : Vec 3 Int)", "type", "expected Vec 3 Int, got Vec 2 Int"],
    [VEC + APPEND + "(append xs xs : Vec 3 Int)", "type", "expected Vec 3 Int, got Vec 4 Int"],
    [VEC + "first (VCons x _) = x\nfirst VNil", "type", "no clause of 'first' matches these arguments"],
    // Others when the program builds them.
    // A wrong claim is an error at its definition, called or not.
    [VEC + APP + "VCons x (app r ys) : Vec (n + m + 1) a", "type", "the claim Vec (n + m + 1) a does not hold: when r is VNil, n + m + 1 is m + 2 but the body's index is m + 1"],
    [VEC + "app (VNil : Vec n a) (ys : Vec m a) = ys : Vec (n + m + 1) a", "type", "n + m + 1 is m + 1 but the body's index is m"],
    [VEC + REV + "rev r (VCons x acc) : Vec (n + m + 1) a", "type", "when r is VNil, n + m + 1 is m + 2 but the body's index is m + 1"],
    // The wrong clause is the one reported, not one that assumed its claim.
    [VEC + "app (VCons x r : Vec n a) (ys : Vec m a) = VCons x (app r ys) : Vec (n + m) a\napp (VNil : Vec n a) (ys : Vec m a) = ys : Vec (n + m + 1) a", "type", "n + m + 1 is m + 1 but the body's index is m"],
    [VEC + APP + "VCons x (app r ys) : Vec (n + m) a\ntwice (v : Vec n a) = app v v : Vec (n + n + 1) a", "type", "n + n + 1 is 2 * n + 1 but the body's index is 2 * n"],
    // What the proof cannot decide is checked when it runs.
    [VEC + APP + "VCons x (app r ys) : Vec (n + m) a\nboth (v : Vec n a) (w : Vec m a) = app v v : Vec (n + m) a\nboth xs (VCons 1 VNil)", "runtime", "expected Vec 3 Int, got Vec 4 Int"],
    ["Vec n a = VNil -> List a | VCons a (Vec k a) -> Vec (S k) a", "parse", "VNil must make a Vec"],
] as const) {
    Deno.test(`indexed families reject: ${source}`, () => {
        const error = failure(source);
        if (error.kind !== kind || !error.message.includes(message)) throw new Error(`${error.kind}: ${error.message}`);
    });
}
