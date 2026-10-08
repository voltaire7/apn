import { parse } from "../main.ts";
import { Interpreter } from "../src/interp.ts";

for (const [source, expected] of [
    ["0+1i", "0+1i"], ["1i", "0+1i"], ["-1i", "0-1i"],
    ["3-4i", "3-4i"], ["-3+4i", "-3+4i"],
    ["1 + 2i", "1+2i"], ["1.0+0.5i", "1.0+0.5i"],
    [".5i", "0.0+0.5i"], ["2e3i", "0.0+2000.0i"],
    ["(1+2i) * (3+4i)", "-5+10i"],
    ["[0+1i,3-4i]", "[0+1i,3-4i]"],
    ["imagPart 2i", "2"], ["i = 7\ni + 1", "8"],
]) {
    Deno.test(`complex literal: ${source}`, () => {
        const interp = new Interpreter();
        const actual = interp.renderString(interp.run(parse(source)));
        if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
    });
}
