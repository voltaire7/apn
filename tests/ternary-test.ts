import { parse } from "../main.ts";
import { Interpreter } from "../src/interp.ts";

for (const [source, expected] of [
    ['True ? "yes" : "no"', '"yes"'],
    ['False ? "yes" : "no"', '"no"'],
    ['True ? 1 : missing', '1'],
    ['False ? missing : 2', '2'],
    ['True ? (False ? 1 : 2) : 3', '2'],
    ['False ? 1 : (True ? 2 : 3)', '2'],
    ['True == False', 'False'],
    ['False != True', 'True'],
    ['(x -> !x) $ True', 'False'],
    ['(1 ~ [1 -> 2, _ -> 0]) + 3', '5'],
]) {
    Deno.test(`keyword-led expression: ${source}`, () => {
        const interp = new Interpreter();
        const actual = interp.renderString(interp.run(parse(source)));
        if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
    });
}
