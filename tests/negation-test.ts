import { parse } from "../main.ts";
import { Interpreter } from "../src/interp.ts";
import { APNError } from "../src/errors.ts";

// A '-' against its operand negates it; one spaced before and not after
// passes a negated argument (f -x is f (-x)); a spaced one always subtracts.
for (const [source, expected] of [
    ["sqrt -1", "0+1i"], ["10 - 1", "9"], ["10-1", "9"], ["1/2 - 1/3", "1/6"],
    ["(x -> x * 2) -3", "-6"],
    ["f x = x + 1\nf -3", "-2"],
    ["add x y = x + y\nadd 10 -3", "7"],
    ["add x y = x + y\nadd -3 -2", "-5"],
    ["abs -.5", "0.5"], ["abs -(1/3)", "1/3"],
    ["realPart -1i", "0"], ["imagPart -1i", "-1"],
    ["sqrt -1 + 2", "2+1i"],
    ["sqrt -1 * 4", "0+4i"],
    ["x = 3\n[-x,-(1/3),-[1,2,3]]", "[-3,-1/3,[-1,-2,-3]]"],
    ["-2 ^ 2", "-4"], ["(-2)", "-2"],
    ["map (- 1) [5,6]", "[4,5]"], ["(-) 5 1", "4"], ["(10 -) 3", "7"],
]) {
    Deno.test(`negation: ${source}`, () => {
        const interp = new Interpreter();
        const actual = interp.renderString(interp.run(parse(source)));
        if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
    });
}
for (const [source, message] of [
    ["x = 5\nx -1", "cannot apply a number"],
    ["sqrt - 1", "'-'"],
    ["y = - 3", "write a negation against its operand"],
]) {
    Deno.test(`negation rejects: ${source}`, () => {
        try { new Interpreter().run(parse(source)); }
        catch (e) { if (e instanceof APNError && e.message.includes(message)) return; throw e; }
        throw new Error("Expected an error");
    });
}
