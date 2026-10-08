import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

for (const [source, expected] of [
    ['enumerate []', '[]'],
    ['enumerate [10,20,30]', '[[0,10],[1,20],[2,30]]'],
    ['enumerate [10,20] * [i,x] -> i + x', '[10,21]'],
    ['take 3 (enumerate [10..])', '[[0,10],[1,11],[2,12]]'],
    ['head (head (enumerate [missing]))', '0'],
    ['head (enumerate (42:missing))', '[0,42]'],
    ['enumerate [10,20] * [i,x] -> typeOf i', '[Int,Int]'],
    ['(enumerate [10,20]) 1', '[1,20]'],
] as const) Deno.test(`enumerate numeric indices: ${source}`, () => {
    const i = new Interpreter();
    const actual = i.renderString(i.run(parseDocument(source)));
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
