import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

// A type applied to its parameters and one more pattern is a typed pattern,
// for every type: (Vec n a xs) is ((Vec n a) xs), as (Vect n a xs) is. A
// match's alternatives meet its scrutinee as clauses meet their parameters.
const VEC = "Vec n a = VNil -> Vec Z a | VCons a (Vec k a) -> Vec (S k) a\n";
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
    [VEC + "len (xs : Vec n a) = n\nlen (VCons 1 (VCons 2 VNil))", "2"],
    [VEC + "app : Vec n a -> Vec m a -> Vec (n + m) a\napp xs ys = [xs,ys] ~ [[VNil,r] -> r, [VCons x rest, r] -> VCons x (app rest r)]\ntypeOf (app (VCons 1 VNil) (VCons 2 VNil))", "Vec 2 Int"],
    // A typed pattern binds its length, so a recursive call may pass any length.
    ["f (x::rest : Vect n a) = f rest\n1", "1"],
    ["f (xs : Vect n a) = null xs ? 0 : 1 + f (tail xs)\nf [1,2,3]", "3"],
    // x:xs in an alternative takes the scrutinee's tail, one shorter.
    ["count (xs : Vect n a) = xs ~ [[] -> 0, x::rest -> 1 + count rest]\ncount [1,2]", "2"],
    ["app (xs : Vect n a) (ys : Vect m a) = [xs,ys] ~ [[[],r] -> r, [x::rest,r] -> x :: app rest r]\napp [1] [2,3]", "[1,2,3]"],
] as const) {
    Deno.test(`typed pattern forms: ${source}`, () => {
        const actual = run(source);
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
}

Deno.test("flat typed patterns match the same without checking", () => {
    const actual = run(VEC + "len (xs : Vec n a) = n\nlen (VCons 1 (VCons 2 VNil))", false);
    if (actual !== "2") throw new Error(actual);
});

Deno.test("an unknown constructor in a match alternative is reported where it is written", () => {
    const source = "f xs ys = [xs,ys] ~ [[Empty,r] -> r]\n1";
    const error = failure(source);
    if (error.pos !== source.indexOf("Empty") || !error.hint?.includes("declare a type with `Empty`")) throw new Error(`${error.pos}: ${error.hint}`);
});

Deno.test("x:xs as a list item is cons written the old way, and the error says so", () => {
    const error = failure("f [x:xs,ys] = x\n1");
    if (!error.message.includes("cons is '::'")) throw new Error(error.message);
});

Deno.test("a length the checker cannot find is located and explained", () => {
    const source = "keep (xs : Vect n a) = filter (_ -> True) xs : Vect n a\n1";
    const error = failure(source);
    if (!error.hint?.includes("mark it `Dynamic`") || error.pos !== source.indexOf("filter")) throw new Error(`${error.pos}: ${error.message} ${error.hint}`);
});

// IO is a type of one parameter, as List is: (IO t) takes the type apart and
// (IO T a) is an action yielding a T, a the action itself, run only where it
// is run. [] is a type there too, the empty list's.
for (const checked of [false, true]) for (const [source, expected] of [
    ['twice (a : IO []) = {\n    a\n    a\n} : IO []\ntwice (print "hi")\n1', "1"],
    ['twice (a : IO _) = {\n    a\n    a\n}\nprint 0\ntwice (return 5)', "5"],
    ["resultOf (IO t) = t\nresultOf (IO Int)", "Int"],
    ['f (a : IO []) = "action"\nf (n : Int) = "int"\n[f (print "not run"), f 3]', '["action","int"]'],
    ["f (a : IO _) = a\nx <- f (return 5)\nx", "5"],
] as const) {
    Deno.test(`IO patterns${checked ? ", checked" : ""}: ${JSON.stringify(source)}`, () => {
        const lines: string[] = [], log = console.log;
        console.log = (...args: unknown[]) => lines.push(args.join(" "));
        let actual: string;
        try { actual = run(source, checked); } finally { console.log = log; }
        const want = source.includes('"hi"') ? ["hi", "hi"] : source.includes("print 0") ? ["0"] : [];
        if (actual !== expected || JSON.stringify(lines) !== JSON.stringify(want)) throw new Error(`${actual} ${JSON.stringify(lines)}`);
    });
}

// A claim around a match (or a ternary, which is one) is checked in each
// alternative, under its own facts: [] makes n zero, x :: rest gives rest n - 1.
const APPEND = "append (xs : Vect n a) (ys : Vect m a) = {\n    xs ~ [\n        [] -> ys\n        x :: rest -> x :: append rest ys\n    ]\n} : Vect (n + m) a\n";
for (const [source, expected] of [
    [APPEND + "typeOf (append [1,2] [3])", "Vect 3 Int"],
    ["app : Vect n a -> Vect m a -> Vect (n + m) a\napp xs ys = [xs,ys] ~ [[[],r] -> r, [x::rest,r] -> x :: app rest r]\ntypeOf (app [1] [2,3])", "Vect 3 Int"],
] as const) {
    Deno.test(`a claim around a match: ${JSON.stringify(source)}`, () => {
        const actual = run(source);
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
}
for (const [source, message] of [
    [APPEND.replace("Vect (n + m) a", "Vect (n + m + 1) a") + "1", "length mismatch: expected m + 1, got m"],
    [APPEND.replace("x :: append", "x :: x :: append") + "1", "length mismatch: expected m + n, got m + n + 1"],
    // Over a value known only at calls too.
    ["two xs ys = xs ~ [[] -> ys, x :: rest -> [x,x,x]] : Vect 2 Int\n1", "length mismatch: expected 2, got 3"],
    ["two b ys = (b ? ys : [1,2,3]) : Vect 2 Int\n1", "length mismatch: expected 2, got 3"],
] as const) {
    Deno.test(`a claim around a match rejects: ${JSON.stringify(source)}`, () => {
        const error = failure(source);
        if (!error.message.includes(message)) throw new Error(error.message);
    });
}

// (List Int xs) takes a list, its elements converted as they are used; length
// counts a string's characters (code points), as chars gives them.
for (const checked of [false, true]) for (const [source, expected] of [
    ['f (xs : List Int) = "ints"\nf _ = "other"\n[f [1,2], f 5]', '["ints","other"]'],
    ["f (xs : List Float) = xs\nf [1,2]", "[1.0,2.0]"],
    ["f (xs : List Int) = take 2 xs\nf [1..]", "[1,2]"],
    ['[length "é", length "a😀b", length (to (List Char) "a😀b")]', "[1,3,3]"],
    ['([1] : Vect (length "😀") Int)', "[1]"],
] as const) Deno.test(`list types and string lengths (checked=${checked}): ${source}`, () => {
    const actual = run(source, checked);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});

// A typed list or variant pattern decides by the type the checker gave the
// value, never by what its elements hold, so the run takes the clause the
// checker chose: where it rules a clause out (f ARG ++ "!" then checks as a
// String), the run skips it. Elements convert as they are used. A run without
// checking infers the same types, so it means the same.
const CHOICE = 'std <- import "std"; use std.option\nUserId = | MkUserId Int\ng x = x\n';
for (const [pattern, argument, chosen] of [
    ["(xs : List Int)", '["a"]', false],
    ["(xs : List Int)", '(map (x -> "s") [1])', false],
    ["(xs : List Int)", "(map (x -> x) [[1]])", false],
    ["(xs : List Int)", '(g ["a"])', false],
    ["(xs : List Int)", "[1,2.5]", true],
    ["(xs : List Int)", "[]", true],
    ["(xs : List Float)", "[1,2]", true],
    ["(xs : List Float)", "[MkUserId 1]", false],
    ["(x : Option Int)", '(Some "a")', false],
    ["(x : Option Int)", '(g (Some "a"))', false],
    ["(x : Option Int)", "None", true],
    ["(x : Option Float)", "(Some 1)", true],
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
    const actual = run("f (xs : List Int) = take 1 xs\nf _ = []\nf [1,2.5]", checked);
    if (actual !== "[1]") throw new Error(actual);
});
