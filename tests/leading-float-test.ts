import { parse } from "../main.ts";
import { Interpreter } from "../src/interp.ts";

for (const [source, expected] of [
    [".1 + .2", "0.30000000000000004"],
    [".1+.2", "0.30000000000000004"],
    ["-.5", "-0.5"],
    ["x = .25\nx + .5", "0.75"],
    ["[.1, .2]", "[0.1, 0.2]"],
    ["identity x = x\nidentity .5", "0.5"],
    ["r = [1: .5]\nr.1", "0.5"],
    ["r = [1: [2: .5]]\n(r.1).2", "0.5"],
    ["[1..3]", "[1, 2, 3]"],
    ["take 3 [1..]", "[1, 2, 3]"],
]) {
    Deno.test(`leading-dot float syntax: ${source}`, () => {
        const interp = new Interpreter();
        const actual = interp.renderString(interp.run(parse(source)));
        if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
    });
}
