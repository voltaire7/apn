import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

// A type applied to its parameters and one more pattern is a typed pattern,
// for every type: (Vec n a xs) is ((Vec n a) xs), as (Vect n a xs) is. A
// match's alternatives meet its scrutinee as clauses meet their parameters.
const VEC = "Vec n a = Nil -> Vec Z a | Cons a (Vec k a) -> Vec (S k) a; ";
function run(source: string, checked = true): string {
    const i = new Interpreter();
    if (checked) i.enableChecking();
    return i.renderString(i.run(parse(source)));
}
function failure(source: string): { kind?: string; message: string; hint?: string; pos?: number } {
    try { run(source); } catch (error) { return error as { kind?: string; message: string; hint?: string; pos?: number }; }
    throw new Error(`accepted: ${source}`);
}

for (const [source, expected] of [
    [VEC + "len (Vec n a xs) = n; len (Cons 1 (Cons 2 Nil))", "2"],
    [VEC + "app (Vec n a xs) (Vec m a ys) = Vec (n + m) a (match [xs,ys] [[Nil,r] -> r,[(Cons x rest),r] -> Cons x (app rest r)]); typeOf (app (Cons 1 Nil) (Cons 2 Nil))", "Vec 2 Int"],
    // A typed pattern binds its length, so a recursive call may pass any length.
    ["f ((Vect n a) (x:rest)) = f rest; 1", "1"],
    ["f ((Vect n a) xs) = null xs ? 0 : 1 + f (tail xs); f [1,2,3]", "3"],
    // x:xs in an alternative takes the scrutinee's tail, one shorter.
    ["count (Vect n a xs) = match xs [[] -> 0,(x:rest) -> 1 + count rest]; count [1,2]", "2"],
    ["app (Vect n a xs) (Vect m a ys) = match [xs,ys] [[[],r] -> r,[(x:rest),r] -> x : app rest r]; app [1] [2,3]", "[1,2,3]"],
] as const) {
    Deno.test(`typed pattern forms: ${source}`, () => {
        const actual = run(source);
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
}

Deno.test("flat typed patterns match the same without checking", () => {
    const actual = run(VEC + "len (Vec n a xs) = n; len (Cons 1 (Cons 2 Nil))", false);
    if (actual !== "2") throw new Error(actual);
});

Deno.test("an unknown constructor in a match alternative is reported where it is written", () => {
    const source = "f xs ys = match [xs,ys] [[Nil,r] -> r]; 1";
    const error = failure(source);
    if (error.pos !== source.indexOf("Nil") || !error.hint?.includes("`(x:xs)`")) throw new Error(`${error.pos}: ${error.hint}`);
});

Deno.test("x:xs as a list item needs parentheses, and the error says so", () => {
    const error = failure("f [x:xs,ys] = x; 1");
    if (!error.message.includes("write a list item x:xs in parentheses: [(x:xs),...]")) throw new Error(error.message);
});

Deno.test("a length the checker cannot find is located and explained", () => {
    const source = "app (Vect n a xs) (Vect m a ys) = Vect (n + m) a (match [xs,ys] [[[],r] -> r,[(x:rest),r] -> x : app rest r]); 1";
    const error = failure(source);
    if (!error.hint?.includes("write a clause per pattern") || error.pos !== source.indexOf("(match")) throw new Error(`${error.pos}: ${error.message} ${error.hint}`);
});
