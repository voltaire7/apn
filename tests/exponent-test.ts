import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
import { highlightLine } from "../src/repl.ts";

for (const [source, expected] of [
    ['2 ^ 10', '1024'], ['2 ^ 3 ^ 2', '512'], ['(2 ^ 3) ^ 2', '64'],
    ['-2 ^ 2', '-4'], ['(-2) ^ 2', '4'], ['2 ^ -3', '1/8'],
    ['2 * 3 ^ 2 + 1', '19'], ['2 ^ 3 * 4', '32'], ['2^ .5', '1.4142135623730951'],
    ['(^ 2) 5', '25'], ['(2 ^) 5', '32'], ['(^) 2 5', '32'],
    ['id x = x\nid 2 ^ 3', '8'], ['0 ^ 0', '1'],
    ['(1/2) ^ 3', '1/8'], ['(0+1i) ^ 2', '-1'],
    ['f x = x ^ 2 ^ 3\nf', 'x -> x ^ 2 ^ 3'],
] as const) Deno.test(`exponent: ${source}`, () => {
    const i = new Interpreter();
    const actual = i.renderString(i.run(parseDocument(source)));
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
Deno.test("exponent operator is peach", () => {
    if (!highlightLine('2 ^ 3').includes('\x1b[38;2;239;159;118m^')) throw new Error('Missing operator color');
});
