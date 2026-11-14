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
    ["typeOf ([1,2] : Vect 2 Int)", "Vect 2 Int"],
    [LST + "([1,2] : Lst 2 Int)", "[1,2]"],
    [LST + "typeOf ([1,2] : Lst 2 Int)", "Vect 2 Int"],
    [LST + "len (_ : Lst n _) = n\nlen [7,8,9]", "3"],
    [LST + "f (xs : Lst n Int) = [n,xs]\nf [1,2]", "[2,[1,2]]"],
    [LST + "app ([] : Lst n a) (ys : Lst m a) = ys : Lst (n + m) a\napp (x :: r : Lst n a) (ys : Lst m a) = x :: app r ys : Lst (n + m) a\ntypeOf (app [1] [2,3])", "Vect 3 Int"],
    [SUGAR + "len (_ : Lst n _) = n\nlen [7,8,9]", "3"],
    ["Pairs n a = [] -> Pairs Z a | a :: a :: Pairs k a -> Pairs (S k) a\nf (xs : Pairs n a) = n\nf [1,2,3,4]", "2"],
    [PAIRS + "([3,4] : Pairs 1 Float)", "[3.0,4.0]"],
    // Its length, c * n + d, is read off its clauses (Pairs's 2n): n is read back from it.
    [PAIRS + "f (xs : Pairs n a) = [n,a]\n[f [1,2,3,4], f []]", "[[2,Int],[0,a]]"],
    [PAIRS + "h (xs : Pairs n Int) = 0 :: 0 :: xs : Pairs (n + 1) Int\nh [5,6]", "[0,0,5,6]"],
    // Another shape runs its clauses backwards.
    ["Mixed Z a = []\nMixed (S k) a = a :: Int :: Mixed k a\nf (xs : Mixed n a) = [n,a]\nf [\"x\",1,\"y\",2]", "[2,String]"],
    // (a is the checker's to compare: [1,"b"] is a Pairs 1 (Int | String).)
    [PAIRS + "g (xs : Pairs n a) = \"pairs\"\ng xs = \"other\"\n[g [1,2,3], g [\"a\",\"b\"], g [1,\"b\"]]", '["other","pairs","pairs"]'],
] as const) {
    Deno.test(`families of lists: ${JSON.stringify(source)}`, () => {
        const actual = run(source);
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
}
for (const [source, message] of [
    [LST + "([1,2] : Lst 3 Int)", "length mismatch: expected 3, got 2"],
    // A family of lists has only the list's own alternatives, each with its index.
    ["Mixed n a = [] -> Mixed Z a | Other -> Mixed Z a", "a family of lists has only [] and x :: rest"],
    ["Lst n a = [] | a :: Lst k a -> Lst (S k) a", "a family of lists has only [] and x :: rest"],
    [PAIRS + "f (xs : Pairs n a) = n\nf [1,2,3]", "length mismatch: expected 2 * n"],
] as const) {
    Deno.test(`families of lists reject: ${JSON.stringify(source)}`, () => {
        const actual = failure(source);
        if (!actual.includes(message)) throw new Error(actual);
    });
}

// A list is Nil or Cons x xs (the prelude's List a = Nil | Cons a (List a));
// [] and :: only write them another way. A union or a family naming them, by
// what the names are bound to, is one of lists.
for (const [source, expected] of [
    ["Cons 1 (Cons 2 Nil)", "[1,2]"], ["[Cons 1 Nil == [1], Nil == [], 1 :: Nil]", "[True,True,[1]]"],
    ["len Nil = 0\nlen (Cons _ xs) = 1 + len xs\nlen [1,2,3]", "3"],
    ["f (Cons x (Cons y _)) = x + y\nf (5 :: 6 :: [])", "11"], ["g (x :: xs) = xs\ng (Cons 1 Nil)", "[]"],
    ["typeOf (Cons 1 (Cons 2 Nil) : Vect 2 Int)", "Vect 2 Int"],
    ["Seq a = Nil | Cons a (Seq a)\n[Seq Int == List Int, isType (Seq Int) [1,2]]", "[True,True]"],
    ["Pairs a = Nil | Cons a (Cons a (Pairs a))\n[isType (Pairs Int) [1,2,3,4], isType (Pairs Int) [1,2,3]]", "[True,False]"],
    ["Lst n a = Nil -> Lst 0 a | Cons a (Lst k a) -> Lst (k + 1) a\ntypeOf ([1,2] : Lst 2 Int)", "Vect 2 Int"],
    ["Cons x xs = [1,2,3]\nxs", "[2,3]"],
]) Deno.test(`a list is Nil or Cons: ${JSON.stringify(source)}`, () => {
    const actual = run(source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
