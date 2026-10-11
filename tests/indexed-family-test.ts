import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

// Indexed families: a constructor says the type it makes
// (Cons a (Vec k a) -> Vec (S k) a), and a value's indices follow.
const VEC = "Vec n a = Nil -> Vec Z a | Cons a (Vec k a) -> Vec (S k) a; xs = Cons 1 (Cons 2 Nil); ";
const APPEND = "append Nil ys = ys; append (Cons x rest) ys = Cons x (append rest ys); ";
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
    [VEC + "len ((Vec n _) _) = n; len xs + 1", "3"],
    [VEC + "elem ((Vec _ a) _) = a; elem xs", "Int"],
    [VEC + "first (Cons x _) = x; first xs", "1"],
    // Each clause may state its result's indices.
    [VEC + "app ((Vec n a) Nil) ((Vec m a) ys) = Vec (n + m) a ys; app ((Vec n a) (Cons x r)) ((Vec m a) ys) = Vec (n + m) a (Cons x (app r ys)); typeOf (app xs xs)", "Vec 4 Int"],
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
    [VEC + "first (Cons x _) = x; first Nil", "type", "no clause of 'first' matches these arguments"],
    // Others when the program builds them.
    [VEC + "app ((Vec n a) Nil) ((Vec m a) ys) = Vec (n + m) a ys; app ((Vec n a) (Cons x r)) ((Vec m a) ys) = Vec (n + m + 1) a (Cons x (app r ys)); app xs xs", "runtime", "expected Vec 4 Int, got Vec 3 Int"],
    ["Vec n a = Nil -> List a | Cons a (Vec k a) -> Vec (S k) a", "parse", "Nil must make a Vec"],
] as const) {
    Deno.test(`indexed families reject: ${source}`, () => {
        const error = failure(source);
        if (error.kind !== kind || !error.message.includes(message)) throw new Error(`${error.kind}: ${error.message}`);
    });
}
