import { parse } from "../main.ts";
import { Interpreter } from "../src/interp.ts";

for (const [source, expected] of [
    ['true ? "yes" : "no"', '"yes"'],
    ['false ? "yes" : "no"', '"no"'],
    ['true ? 1 : missing', '1'],
    ['false ? missing : 2', '2'],
    ['true ? false ? 1 : 2 : 3', '2'],
    ['false ? 1 : true ? 2 : 3', '2'],
    ['true == false', 'false'],
    ['false != true', 'true'],
    ['true $ x -> !x', 'false'],
    ['match 1 [1 -> 2, _ -> 0] + 3', '5'],
]) {
    Deno.test(`keyword-led expression: ${source}`, () => {
        const interp = new Interpreter();
        const actual = interp.renderString(interp.run(parse(source)));
        if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
    });
}
