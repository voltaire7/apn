import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

// A type applied to its parameters and one more pattern is a typed pattern,
// for every type: (Vec n a xs) is ((Vec n a) xs), as (Vect n a xs) is. A
// match's alternatives meet its scrutinee as clauses meet their parameters.
const VEC = "Vec n a = Nil -> Vec Z a | Cons a (Vec k a) -> Vec (S k) a\n";
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
    [VEC + "len (Vec n a xs) = n\nlen (Cons 1 (Cons 2 Nil))", "2"],
    [VEC + "app (Vec n a xs) (Vec m a ys) = Vec (n + m) a\n    (match [xs,ys] [[Nil,r] -> r, [(Cons x rest), r] -> Cons x (app rest r)])\ntypeOf (app (Cons 1 Nil) (Cons 2 Nil))", "Vec 2 Int"],
    // A typed pattern binds its length, so a recursive call may pass any length.
    ["f ((Vect n a) (x::rest)) = f rest\n1", "1"],
    ["f ((Vect n a) xs) = null xs ? 0 : 1 + f (tail xs)\nf [1,2,3]", "3"],
    // x:xs in an alternative takes the scrutinee's tail, one shorter.
    ["count (Vect n a xs) = match xs [[] -> 0, (x::rest) -> 1 + count rest]\ncount [1,2]", "2"],
    ["app (Vect n a xs) (Vect m a ys) = match [xs,ys] [[[],r] -> r, [(x::rest),r] -> x :: app rest r]\napp [1] [2,3]", "[1,2,3]"],
] as const) {
    Deno.test(`typed pattern forms: ${source}`, () => {
        const actual = run(source);
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
}

Deno.test("flat typed patterns match the same without checking", () => {
    const actual = run(VEC + "len (Vec n a xs) = n\nlen (Cons 1 (Cons 2 Nil))", false);
    if (actual !== "2") throw new Error(actual);
});

Deno.test("an unknown constructor in a match alternative is reported where it is written", () => {
    const source = "f xs ys = match [xs,ys] [[Nil,r] -> r]\n1";
    const error = failure(source);
    if (error.pos !== source.indexOf("Nil") || !error.hint?.includes("`(x :: xs)`")) throw new Error(`${error.pos}: ${error.hint}`);
});

Deno.test("x:xs as a list item is cons written the old way, and the error says so", () => {
    const error = failure("f [x:xs,ys] = x\n1");
    if (!error.message.includes("cons is '::'")) throw new Error(error.message);
});

Deno.test("a length the checker cannot find is located and explained", () => {
    const source = "keep (Vect n a xs) = Vect n a (filter (_ -> true) xs)\n1";
    const error = failure(source);
    if (!error.hint?.includes("mark it `Dynamic`") || error.pos !== source.indexOf("(filter")) throw new Error(`${error.pos}: ${error.message} ${error.hint}`);
});

// A claim around a match is checked in each alternative, under its own facts:
// [] makes n zero, x :: rest gives rest n - 1.
const APPEND = "append (Vect n a xs) (Vect m a ys) = Vect (n + m) a {\n    match xs [\n        [] -> ys\n        x :: rest -> x :: append rest ys\n    ]\n}\n";
for (const [source, expected] of [
    [APPEND + "typeOf (append [1,2] [3])", "Vect 3 Int"],
    ["app (Vect n a xs) (Vect m a ys) = Vect (n + m) a\n    (match [xs,ys] [[[],r] -> r, [(x::rest),r] -> x :: app rest r])\ntypeOf (app [1] [2,3])", "Vect 3 Int"],
] as const) {
    Deno.test(`a claim around a match: ${JSON.stringify(source)}`, () => {
        const actual = run(source);
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
}
for (const [source, message] of [
    [APPEND.replace("Vect (n + m) a", "Vect (n + m + 1) a") + "1", "length mismatch: expected m + 1, got m"],
    [APPEND.replace("x :: append", "x :: x :: append") + "1", "length mismatch: expected m + n, got m + n + 1"],
] as const) {
    Deno.test(`a claim around a match rejects: ${JSON.stringify(source)}`, () => {
        const error = failure(source);
        if (!error.message.includes(message)) throw new Error(error.message);
    });
}

// (List Int xs) takes a list, its elements converted as they are used; length
// counts a string's characters (code points), as chars gives them.
for (const checked of [false, true]) for (const [source, expected] of [
    ['f (List Int xs) = "ints"\nf _ = "other"\n[f [1,2], f 5]', '["ints","other"]'],
    ["f (List Float xs) = xs\nf [1,2]", "[1.0,2.0]"],
    ["f (List Int xs) = take 2 xs\nf [1..]", "[1,2]"],
    ['[length "é", length "a😀b", length (to (List Char) "a😀b")]', "[1,3,3]"],
    ['Vect (length "😀") Int [1]', "[1]"],
] as const) Deno.test(`list types and string lengths (checked=${checked}): ${source}`, () => {
    const actual = run(source, checked);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});

// A typed list or variant pattern decides by the type the checker gave the
// value, never by what its elements hold, so the run takes the clause the
// checker chose: where it rules a clause out (f ARG ++ "!" then checks as a
// String), the run skips it. Elements convert as they are used. A run without
// checking infers the same types, so it means the same.
const CHOICE = 'import "option"\nUserId := Int\ng x = x\n';
for (const [pattern, argument, chosen] of [
    ["List Int xs", '["a"]', false],
    ["List Int xs", '(map (x -> "s") [1])', false],
    ["List Int xs", "(map (x -> x) [[1]])", false],
    ["List Int xs", '(g ["a"])', false],
    ["List Int xs", "[1,2.5]", true],
    ["List Int xs", "[]", true],
    ["List Float xs", "[1,2]", true],
    ["List Float xs", "(List UserId [1])", false],
    ["Option Int x", '(Some "a")', false],
    ["Option Int x", '(g (Some "a"))', false],
    ["Option Int x", "None", true],
    ["Option Float x", "(Some 1)", true],
] as const) Deno.test(`typed clauses choose by static type: (${pattern}) ${argument}`, () => {
    const call = `${CHOICE}f (${pattern}) = "typed"\nf _ = "other"\nf ${argument}`;
    const expected = chosen ? '"typed"' : '"other"';
    for (const checked of [true, false]) {
        const actual = run(call, checked);
        if (actual !== expected) throw new Error(`checked=${checked}: ${actual} != ${expected}`);
    }
    if (!chosen && run(`${call} ++ "!"`) !== '"other!"') throw new Error("the checker did not rule the clause out");
});
for (const checked of [false, true]) Deno.test(`a typed list's elements convert as used (checked=${checked})`, () => {
    const actual = run("f (List Int xs) = take 1 xs\nf _ = []\nf [1,2.5]", checked);
    if (actual !== "[1]") throw new Error(actual);
});
