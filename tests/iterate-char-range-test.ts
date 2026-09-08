import { parse } from "../main.ts";
import { Interpreter } from "../src/interp.ts";

for (const [source, expected] of [
    ["['a'..'e']", '"abcde"'],
    ["['e'..'a']", '"edcba"'],
    ["['a'..'a']", '"a"'],
    ["['😀'..'😂']", '"😀😁😂"'],
    ["take 6 (iterate (*2) 1)", "[1, 2, 4, 8, 16, 32]"],
    ["take 6 (iterate (x -> x * 2 + 1) 0)", "[0, 1, 3, 7, 15, 31]"],
    ["take 0 (iterate _ _)", "[]"],
    ["take 1 (iterate _ 42)", "[42]"],
    ["take 3 (iterate (x -> x) 7)", "[7, 7, 7]"],

]) {
    Deno.test(`iterate and character ranges: ${source}`, () => {
        const interp = new Interpreter();
        const actual = interp.renderString(interp.run(parse(source)));
        if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
    });
}

Deno.test("iterate streams 10000 successive values", () => {
    const interp = new Interpreter();
    const actual = interp.renderString(interp.run(parse("take 10000 (iterate (+1) 0)")));
    const expected = `[${Array.from({ length: 10000 }, (_, i) => i).join(", ")}]`;
    if (actual !== expected) throw new Error("Incorrect long iterate sequence");
});
