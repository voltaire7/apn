import { parseDocument } from "../src/parser.ts";
import { Interpreter } from "../src/interp.ts";
import { highlightTokens } from "../src/highlight.ts";

for (const [source, expected] of [
    [String.raw`(x -> x + 1) \ 3 $ (x -> x * 2) $ (x -> x - 1)`, "6"],
    [String.raw`((x -> x + 1) \ 3) $ (x -> x * 2)`, "8"],
    [String.raw`(x -> x * 2) \ 1 + 2`, "6"],
    [String.raw`(x -> x + 1) \ (x -> x * 2) \ 3`, "7"],
    [String.raw`(x -> x + 1) \ 3 $ (x -> x * 2)`, "7"],
    [String.raw`(x -> 42) \ missing`, "42"],
    [String.raw`(x -> x)\.2`, "0.2"],
    [String.raw`(x -> x) \ true ? 1 : 2`, "1"],
    ["(x -> x + 1) \\\n    2", "3"],
]) Deno.test(`reverse application: ${source}`, () => {
    const interp = new Interpreter();
    const actual = interp.renderString(interp.run(parseDocument(source)));
    if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
});

Deno.test("reverse application formats record entries in order", () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
    try {
        new Interpreter().run(parseDocument(String.raw`vec = [x: 1, y: 2, z: 3]
vec * [f, v] -> {
    print \ format "%: %" [f, v]
}`));
        if (lines.join("\n") !== "x: 1\ny: 2\nz: 3") throw new Error(JSON.stringify(lines));
    } finally { console.log = original; }
});

for (const source of ["print \\", "\\ 1"]) {
    Deno.test(`reverse application requires both operands: ${source}`, () => {
        try { parseDocument(source); } catch { return; }
        throw new Error("accepted missing operand");
    });
}
Deno.test("reverse application gets operator highlighting", () => {
    const token = highlightTokens(String.raw`print \ 1`, new Set()).find(t => t.start === 6);
    if (token?.type !== "operator") throw new Error(JSON.stringify(token));
});

Deno.test("print receives the piped result", () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
    try {
        new Interpreter().run(parseDocument(String.raw`value = 123
add1 x = x + 1
print \ value $ add1`));
        if (lines.join("\n") !== "124") throw new Error(JSON.stringify(lines));
    } finally { console.log = original; }
});
