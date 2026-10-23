import { parse, setLooseSpacing } from "../src/parser.ts";

// Parentheses that do not change how an expression reads are an error.
for (const source of [
    "print (5)",
    "list >>= (x -> x * 2)",
    "f ((g x))",
    "(a * b) + c",
    "a + (b * c)",
    "(f x) y",
    "print (-1)",
    "print (r.x)",
    "-(f x)",
    "y = (a + b)",
    "c ? (a ? 1 : 2) : 3",
    'withFile "notes" (file -> file.read)',
    "(x -> x) (y -> y)",
]) Deno.test(`unnecessary parentheses: ${source}`, () => {
    try { parse(source); } catch (error) {
        if (String(error).includes("unnecessary parentheses")) return;
        throw error;
    }
    throw new Error("accepted");
});

for (const source of [
    "(a + b) * c",
    "a - (b - c)",
    "(a :: b) :: c",
    "a == (b == c)",
    "f (g x)",
    "(-2) ^ 2",
    "-(a + b)",
    "-(-x)",
    "!(!b)",
    "(x -> x) 1",
    "xs >>= (x -> f x) >>= g",
    // f = x -> e is a clause of f; f = (x -> e) binds a value.
    "f = (x -> x)",
    // f x -> e would read f x as the lambda's typed parameter.
    "run (x -> x)",
    "[(x, y -> x)]",
    "xs (i) = 2",
    "obj.[(key)]",
    "(r.1).2",
    "c ? (a $ b) : d",
]) Deno.test(`necessary parentheses: ${source}`, () => { parse(source); });

Deno.test("--loose accepts unnecessary parentheses", () => {
    setLooseSpacing(true);
    try { parse("print (5)"); } finally { setLooseSpacing(false); }
});
