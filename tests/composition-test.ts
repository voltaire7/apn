import { parseDocument } from "../src/parser.ts";
import { Interpreter } from "../src/interp.ts";
import { highlightTokens } from "../src/highlight.ts";

for (const [source, expected] of [
    [String.raw`((x -> x + 1) \ (x -> x * 2)) 3`, "7"],
    [String.raw`((x -> x + 1) \ (x -> x * 2) \ (x -> x - 3)) 5`, "5"],
    [String.raw`(x -> x + 1) \ (x -> x * 2) $ 3`, "7"],
    [String.raw`((x -> 42) \ (x -> missing)) missing`, "42"],
    [String.raw`import "sequence"
even n = n % 2 == 0
calculate bottom top = (sum \ filter even) [bottom..top]
calculate 1 10`, "30"],
    [String.raw`double x = x * 2
increment x = x + 1
h = increment \ double
[h 3, h 4]`, "[7, 9]"],
    [String.raw`((\) (x -> x + 1) (x -> x * 2)) 3`, "7"],
    [String.raw`(Int \ (x -> x + 1)) 3`, "4"],
]) Deno.test(`composition: ${source}`, () => {
    const interp = new Interpreter();
    const actual = interp.renderString(interp.run(parseDocument(source)));
    if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
});

for (const source of [
    String.raw`print \ format "%: %" ["x", 1]`,
    String.raw`import "sequence"
even n = n % 2 == 0
calculate bottom top = sum \ filter even [bottom..top]
calculate 1 10`,
    String.raw`(x -> x) \ 3`,
    String.raw`3 \ (x -> x)`,
]) Deno.test(`composition rejects non-functions: ${source}`, () => {
    const interp = new Interpreter();
    try { interp.renderString(interp.run(parseDocument(source))); }
    catch (error) {
        if (error instanceof Error && error.message.includes("composition expects functions")) return;
        throw error;
    }
    throw new Error("accepted a non-function operand");
});

Deno.test("composition formats record entries in order", () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
    try {
        new Interpreter().run(parseDocument(String.raw`vec = [x: 1, y: 2, z: 3]
vec * [f, v] -> {
    (print \ format "%: %") [f, v]
}`));
        if (lines.join("\n") !== "x: 1\ny: 2\nz: 3") throw new Error(JSON.stringify(lines));
    } finally { console.log = original; }
});

for (const source of ["print \\", "\\ 1"]) {
    Deno.test(`composition requires both operands: ${source}`, () => {
        try { parseDocument(source); } catch { return; }
        throw new Error("accepted missing operand");
    });
}
Deno.test("composition gets operator highlighting", () => {
    const token = highlightTokens(String.raw`print \ 1`, new Set()).find(t => t.start === 6);
    if (token?.type !== "operator") throw new Error(JSON.stringify(token));
});

Deno.test("composition binds tighter than record iteration", () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
    try {
        new Interpreter().run(parseDocument(String.raw`vec = [x: 1, y: 2, z: 3]
vec * print \ format "%: %"`));
        if (lines.join("\n") !== "x: 1\ny: 2\nz: 3") throw new Error(JSON.stringify(lines));
    } finally { console.log = original; }
});
Deno.test("composition binds tighter than numeric iteration", () => {
    const i = new Interpreter();
    const value = i.renderString(i.run(parseDocument(String.raw`[1, 2, 3] * (+ 1) \ (* 2)`)));
    if (value !== "[3, 5, 7]") throw new Error(value);
});
