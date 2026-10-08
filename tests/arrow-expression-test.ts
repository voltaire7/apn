import { parseDocument } from "../src/parser.ts";
import { Interpreter } from "../src/interp.ts";

for (const source of [
    "(Int -> Int) function",
    "{ Int -> Int } function",
    "a -> a",
    "Alias = Int; (Alias -> Alias) function",
]) Deno.test(`expression arrows are lambdas: ${source}`, () => {
    const ast = JSON.stringify(parseDocument(source));
    if (ast.includes('"t":"functionType"') || !(/"t":"(?:patternLambda|lambda)"/.test(ast))) {
        throw new Error(`Expected an ordinary lambda: ${ast}`);
    }
});

for (const source of [
    "func ((Int -> Int) f) = f 123; func (+ 1)",
    "func { { Int -> Int } f } = f 123; func { + 1 }",
    "((Int -> Int) f) <- Dynamic (x -> x + 1); f 123",
    "(Int x -> x + 1) 123",
]) Deno.test(`pattern contracts and typed lambdas: ${source}`, () => {
    const i = new Interpreter();
    i.enableChecking();
    const actual = i.renderString(i.run(parseDocument(source)));
    if (actual !== "124") throw new Error(`Expected 124, got ${actual}`);
});

Deno.test("arrow lambda application does not wrap a function", () => {
    const i = new Interpreter();
    try {
        i.run(parseDocument("(Int -> Int) (x -> x)"));
    } catch (error) {
        if (String(error).includes("no clause")) return;
        throw error;
    }
    throw new Error("Expected pattern mismatch, not a function contract");
});
