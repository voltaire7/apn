import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

// Vect is the prelude's family of lists counting their elements:
// Vect n a = [] -> Vect Z a | a :: Vect k a -> Vect (S k) a. Any family of
// lists of that shape is the same, length-indexed list.
function run(source: string): string {
    const i = new Interpreter();
    i.enableChecking();
    return i.renderString(i.run(parse(source)));
}
function failure(source: string): string {
    try { run(source); } catch (error) { return (error as Error).message; }
    throw new Error(`accepted: ${source}`);
}
const LST = "Lst n a = [] -> Lst 0 a | a :: Lst k a -> Lst (k + 1) a\n";
for (const [source, expected] of [
    ["typeOf (Vect 2 Int [1,2])", "Vect 2 Int"],
    [LST + "Lst 2 Int [1,2]", "[1,2]"],
    [LST + "typeOf (Lst 2 Int [1,2])", "Vect 2 Int"],
    [LST + "len (Lst n _ _) = n\nlen [7,8,9]", "3"],
    [LST + "f (Lst n Int xs) = [n,xs]\nf [1,2]", "[2,[1,2]]"],
    [LST + "app (Lst n a []) (Lst m a ys) = Lst (n + m) a ys\napp (Lst n a (x :: r)) (Lst m a ys) = Lst (n + m) a (x :: app r ys)\ntypeOf (app [1] [2,3])", "Vect 3 Int"],
] as const) {
    Deno.test(`families of lists: ${JSON.stringify(source)}`, () => {
        const actual = run(source);
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
}
for (const [source, message] of [
    [LST + "Lst 3 Int [1,2]", "length mismatch: expected 3, got 2"],
    // A list's fields are types: a family of lists can only count its elements.
    ["Even n = [] -> Even Z | a :: Even k -> Even (S (S k))", "a family of lists counts its elements, as Vect does"],
    ["Mixed n a = [] -> Mixed Z a | Other -> Mixed Z a", "a family of lists counts its elements"],
] as const) {
    Deno.test(`families of lists reject: ${JSON.stringify(source)}`, () => {
        const actual = failure(source);
        if (!actual.includes(message)) throw new Error(actual);
    });
}
