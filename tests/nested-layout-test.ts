import { lex } from "../src/lexer.ts";
import { parseDocument } from "../src/parser.ts";
import { Interpreter } from "../src/interp.ts";

const example = `print $ map (x -> {
    result = x + x
    result * result
}) [1,2,3,4]`;

Deno.test("parenthesized lambda block preserves statement boundaries and prints results", () => {
    const tokens = lex(example);
    if (!tokens.some(t => t.k === "newline" && t.pos === example.indexOf("\n    result *"))) {
        throw new Error("missing statement boundary; evaluating would self-reference result");
    }
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
    try {
        new Interpreter().run(parseDocument(example));
        if (lines.join("\n") !== "[4,16,36,64]") throw new Error(JSON.stringify(lines));
    } finally { console.log = original; }
});

for (const [source, expected] of [
    ["[\n    1,2\n    3\n]", "[1,2,3]"],
    ["[\n    1\n    2\n]", "[1,2]"],
    ["(\n    x -> {\n        y = x + 2\n        y + 3\n    }\n) 0", "5"],
    ["(x -> {\n    y = x +\n        x\n    y * y\n}) 3", "36"],
    ["a = (x -> {\n    x + 1\n}) 2\nb = 4\na + b", "7"],
    ["(x -> {\n    ys = [\n        x\n        x + 1\n    ]\n    ys\n}) 2", "[2,3]"],
    // A deeper line starting an argument continues the application.
    ["(x -> {\n    f = y, z -> y + z\n    f x\n        10\n}) 2", "12"],
]) Deno.test(`nested container layout: ${source}`, () => {
    const interp = new Interpreter();
    const actual = interp.renderString(interp.run(parseDocument(source)));
    if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
});

for (const source of [
    "(x -> {\nresult = x\nresult\n}) 1",
    "(x -> {\n    x\n    }) 1",
    "(x -> {\n  x\n}) 1",
    "([\n    1,\n    2,\n])",
    "([\n    1,\n    2\n])",
]) Deno.test(`reject invalid nested block layout: ${source}`, () => {
    try { parseDocument(source); } catch { return; }
    throw new Error("accepted invalid block indentation");
});
