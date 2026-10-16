import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

// Indexed families: a constructor says the type it makes
// (Cons a (Vec k a) -> Vec (S k) a), and a value's indices follow.
const VEC = "Vec n a = Nil -> Vec Z a | Cons a (Vec k a) -> Vec (S k) a\nxs = Cons 1 (Cons 2 Nil)\n";
const APPEND = "append Nil ys = ys\nappend (Cons x rest) ys = Cons x (append rest ys)\n";
// Each clause claims its result's index; the checker proves the claims by induction.
const APP = "app ((Vec n a) Nil) ((Vec m a) ys) = Vec (n + m) a ys\napp ((Vec n a) (Cons x r)) ((Vec m a) ys) = ";
const REV = "rev ((Vec n a) Nil) ((Vec m a) acc) = Vec (n + m) a acc\nrev ((Vec n a) (Cons x r)) ((Vec m a) acc) = ";
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
    [VEC + "xs", "Cons 1 (Cons 2 Nil)"],
    [VEC + "typeOf xs", "Vec 2 Int"],
    [VEC + "typeOf Nil", "Vec 0 a"],
    [VEC + "Vec 2 Int xs", "Cons 1 (Cons 2 Nil)"],
    [VEC + APPEND + "typeOf (append xs xs)", "Vec 4 Int"],
    [VEC + APPEND + "Vec 4 Int (append xs xs)", "Cons 1 (Cons 2 (Cons 1 (Cons 2 Nil)))"],
    // A typed pattern binds the indices: n is a value, a a type.
    [VEC + "len ((Vec n _) _) = n\nlen xs + 1", "3"],
    [VEC + "elem ((Vec _ a) _) = a\nelem xs", "Int"],
    [VEC + "first (Cons x _) = x\nfirst xs", "1"],
    // Each clause may state its result's indices.
    [VEC + APP + "Vec (n + m) a (Cons x (app r ys))\ntypeOf (app xs xs)", "Vec 4 Int"],
    // Proven by induction: an accumulator, a doubling, a proven function's claim.
    [VEC + REV + "Vec (n + m) a (rev r (Cons x acc))\nrev xs Nil", "Cons 2 (Cons 1 Nil)"],
    [VEC + "dbl ((Vec n a) Nil) = Vec (2 * n) a Nil\ndbl ((Vec n a) (Cons x r)) = Vec (2 * n) a (Cons x (Cons x (dbl r)))\ntypeOf (dbl xs)", "Vec 4 Int"],
    [VEC + APP + "Vec (n + m) a (Cons x (app r ys))\ntwice ((Vec n a) v) = Vec (n + n) a (app v v)\ntypeOf (twice xs)", "Vec 4 Int"],
    // Recursion that does not shrink proves nothing: its claim is checked when it runs.
    [VEC + "loop ((Vec n a) v) = Vec (n + 1) a (loop v)\n1", "1"],
] as const) {
    Deno.test(`indexed families: ${source}`, () => {
        const actual = run(source);
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
}

for (const [source, kind, message] of [
    // Known values are checked before the run.
    [VEC + "Vec 3 Int xs", "type", "expected Vec 3 Int, got Vec 2 Int"],
    [VEC + APPEND + "Vec 3 Int (append xs xs)", "type", "expected Vec 3 Int, got Vec 4 Int"],
    [VEC + "first (Cons x _) = x\nfirst Nil", "type", "no clause of 'first' matches these arguments"],
    // Others when the program builds them.
    // A wrong claim is an error at its definition, called or not.
    [VEC + APP + "Vec (n + m + 1) a (Cons x (app r ys))", "type", "the claim Vec (n + m + 1) a does not hold: when r is Nil, n + m + 1 is m + 2 but the body's index is m + 1"],
    [VEC + "app ((Vec n a) Nil) ((Vec m a) ys) = Vec (n + m + 1) a ys", "type", "n + m + 1 is m + 1 but the body's index is m"],
    [VEC + REV + "Vec (n + m + 1) a (rev r (Cons x acc))", "type", "when r is Nil, n + m + 1 is m + 2 but the body's index is m + 1"],
    // The wrong clause is the one reported, not one that assumed its claim.
    [VEC + "app ((Vec n a) (Cons x r)) ((Vec m a) ys) = Vec (n + m) a (Cons x (app r ys))\napp ((Vec n a) Nil) ((Vec m a) ys) = Vec (n + m + 1) a ys", "type", "n + m + 1 is m + 1 but the body's index is m"],
    [VEC + APP + "Vec (n + m) a (Cons x (app r ys))\ntwice ((Vec n a) v) = Vec (n + n + 1) a (app v v)", "type", "n + n + 1 is 2 * n + 1 but the body's index is 2 * n"],
    // What the proof cannot decide is checked when it runs.
    [VEC + APP + "Vec (n + m) a (Cons x (app r ys))\nboth ((Vec n a) v) ((Vec m a) w) = Vec (n + m) a (app v v)\nboth xs (Cons 1 Nil)", "runtime", "expected Vec 3 Int, got Vec 4 Int"],
    ["Vec n a = Nil -> List a | Cons a (Vec k a) -> Vec (S k) a", "parse", "Nil must make a Vec"],
] as const) {
    Deno.test(`indexed families reject: ${source}`, () => {
        const error = failure(source);
        if (error.kind !== kind || !error.message.includes(message)) throw new Error(`${error.kind}: ${error.message}`);
    });
}
