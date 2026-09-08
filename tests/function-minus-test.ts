import { parse } from "../main.ts";
import { Interpreter } from "../src/interp.ts";
import { APNError } from "../src/errors.ts";

for (const [source, expected] of [
    ["sqrt -1", "0+1i"], ["sqrt - 1", "0+1i"],
    ["10 - 1", "9"], ["1/2 - 1/3", "1/6"],
    ["(x -> x * 2) -3", "-6"],
    ["f x = x + 1\nf -3", "-2"],
    ["add x y = x + y\nadd 10 -3", "7"],
    ["abs -.5", "0.5"], ["abs -(1/3)", "1/3"],
    ["realPart -1i", "0"], ["imagPart -1i", "-1"],
    ["sqrt -1 + 2", "2+1i"],
    ["sqrt -1 * 4", "0+2i"],
    ["f x = x\nf -3 -2", "-5"],
]) {
    Deno.test(`function minus: ${source}`, () => {
        const interp = new Interpreter();
        const actual = interp.renderString(interp.run(parse(source)));
        if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
    });
}
Deno.test("function minus rejects nonnumeric operands", () => {
    try { new Interpreter().run(parse('sqrt - "hi"')); }
    catch (e) { if (e instanceof APNError) return; throw e; }
    throw new Error("Expected numeric operand error");
});
