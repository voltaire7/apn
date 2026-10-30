import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

// Vect is the prelude's function counting a list's elements:
// Vect Z a = [] and Vect (S k) a = a :: Vect k a. Any function of that shape
// is the same, length-indexed list; another type function of lists is read
// back by running its clauses backwards.
function run(source: string): string {
    const i = new Interpreter();
    i.enableChecking();
    return i.renderString(i.run(parse(source)));
}
function failure(source: string): string {
    try { run(source); } catch (error) { return (error as Error).message; }
    throw new Error(`accepted: ${source}`);
}
const LST = "Lst 0 a = []\nLst (S k) a = a :: Lst k a\n";
// The family form is sugar for the same clauses.
const SUGAR = "Lst n a = [] -> Lst 0 a | a :: Lst k a -> Lst (k + 1) a\n";
const PAIRS = "Pairs Z a = []\nPairs (S k) a = a :: a :: Pairs k a\n";
for (const [source, expected] of [
    ["typeOf (Vect 2 Int [1,2])", "Vect 2 Int"],
    [LST + "Lst 2 Int [1,2]", "[1,2]"],
    [LST + "typeOf (Lst 2 Int [1,2])", "Vect 2 Int"],
    [LST + "len (Lst n _ _) = n\nlen [7,8,9]", "3"],
    [LST + "f (Lst n Int xs) = [n,xs]\nf [1,2]", "[2,[1,2]]"],
    [LST + "app (Lst n a []) (Lst m a ys) = Lst (n + m) a ys\napp (Lst n a (x :: r)) (Lst m a ys) = Lst (n + m) a (x :: app r ys)\ntypeOf (app [1] [2,3])", "Vect 3 Int"],
    [SUGAR + "len (Lst n _ _) = n\nlen [7,8,9]", "3"],
    ["Pairs n a = [] -> Pairs Z a | a :: a :: Pairs k a -> Pairs (S k) a\nf (Pairs n a xs) = n\nf [1,2,3,4]", "UInt 2"],
    [PAIRS + "Pairs 1 Float [3,4]", "[3.0,4.0]"],
    [PAIRS + "f (Pairs n a xs) = [n,a]\n[f [1,2,3,4], f []]", "[[UInt 2, Int], [UInt 0, a]]"],
    [PAIRS + "g (Pairs n a xs) = \"pairs\"\ng xs = \"other\"\n[g [1,2,3], g [\"a\",\"b\"], g [1,\"b\"]]", '["other","pairs","other"]'],
] as const) {
    Deno.test(`families of lists: ${JSON.stringify(source)}`, () => {
        const actual = run(source);
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
}
for (const [source, message] of [
    [LST + "Lst 3 Int [1,2]", "length mismatch: expected 3, got 2"],
    // A family of lists has only the list's own alternatives, each with its index.
    ["Mixed n a = [] -> Mixed Z a | Other -> Mixed Z a", "a family of lists has only [] and x :: rest"],
    ["Lst n a = [] | a :: Lst k a -> Lst (S k) a", "a family of lists has only [] and x :: rest"],
] as const) {
    Deno.test(`families of lists reject: ${JSON.stringify(source)}`, () => {
        const actual = failure(source);
        if (!actual.includes(message)) throw new Error(actual);
    });
}
