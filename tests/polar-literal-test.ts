import { parse } from "../main.ts";
import { Interpreter } from "../src/interp.ts";
import { highlightLine } from "../src/repl.ts";
import { APNError } from "../src/errors.ts";

for (const [literal, constructor] of [
    ["2@3", "makePolar 2 3"], ["2@-3", "makePolar 2 (-3)"],
    ["2@+3", "makePolar 2 3"], [".5@.25", "makePolar .5 .25"],
    ["2e1@3e-1", "makePolar 20.0 .3"], ["-2@3", "-(makePolar 2 3)"],
    ["2 @ 3", "makePolar 2 3"], ["2@3 + 1", "(makePolar 2 3) + 1"],
    ["magnitude 2@3", "magnitude (makePolar 2 3)"],
    ['parse "2@3"', "makePolar 2 3"],
]) {
    Deno.test(`polar literal: ${literal}`, () => {
        const interp = new Interpreter();
        if (!interp.equals(interp.run(parse(literal)), interp.run(parse(constructor)))) throw new Error("Incorrect polar value");
    });
}
for (const source of ["2@", "2@x", "2@-", "2@@3"]) {
    Deno.test(`invalid polar literal: ${source}`, () => {
        try { parse(source); } catch (e) { if (e instanceof APNError) return; throw e; }
        throw new Error("Expected syntax error");
    });
}
Deno.test("polar marker is peach", () => {
    if (!highlightLine("2@3").includes("\x1b[38;2;239;159;118m@\x1b[0m")) throw new Error("Wrong marker color");
});
