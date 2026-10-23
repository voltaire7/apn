import { parse } from "../main.ts";
import { Interpreter } from "../src/interp.ts";

for (const [source, expected] of [
    ["take 5 [0,0.5..100]", "[0.0,0.5,1.0,1.5,2.0]"],
    ["length [0,0.5..100]", "201"],
    ["[0,0.5..100] -1", "100.0"],
    ["[2,1.5..0]", "[2.0,1.5,1.0,0.5,0.0]"],
    ["[0,0.5..-1]", "[]"],
    ["[.5..2.5]", "[0.5,1.5,2.5]"],
    ["[2.5..0.5]", "[2.5,1.5,0.5]"],
    ["take 4 [0,.5..]", "[0.0,0.5,1.0,1.5]"],
    ["take 3 (drop 2 [0,.5..])", "[1.0,1.5,2.0]"],
    ["map (+ .5) [0,.5..1]", "[0.5,1.0,1.5]"],
    ["[0,.1..0.3]", "[0.0,0.1,0.2,0.3]"],
    ["length [0,.3..1]", "4"],
    ["[0,1..2.5]", "[0.0,1.0,2.0]"],
    ["head [0,1..2.5] + .5", "0.5"],
    ["[0,1/2.0..2]", "[0.0,0.5,1.0,1.5,2.0]"],
    ["[9007199254740993..9007199254740995]", "[9007199254740993,9007199254740994,9007199254740995]"],
]) {
    Deno.test(`float range: ${source}`, () => {
        const interp = new Interpreter();
        const actual = interp.renderString(interp.run(parse(source)));
        if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
    });
}

Deno.test("float range precision exhaustion reports a runtime error", () => {
    const interp = new Interpreter();
    try { interp.renderString(interp.run(parse("take 2 [10000000000000000.0..]"))); }
    catch (error) {
        if (error instanceof Error && error.message.includes("cannot advance")) return;
        throw error;
    }
    throw new Error("Expected a precision error instead of repeating a value");
});
