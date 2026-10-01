import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
import { checkSource } from "../src/type-checker.ts";

for (const source of ['0 1', '1.5 2', '(1/3) 2', '(0+1i) 2', '(Int 0) 1', '(Int32 0) 1', 'x = 0; x 1', '(x -> x 1) 0', '0 missing']) {
    Deno.test(`numeric application rejects: ${source}`, () => {
        const i = new Interpreter();
        try { i.renderString(i.run(parseDocument(source))); } catch (e) {
            if (!String(e).includes('cannot apply a number')) throw e;
            return;
        }
        throw new Error('expected a numeric application error');
    });
}
for (const [source, expected] of [
    ['[x: 0] [x: 123]', '[x: 123]'],
    ['[x: 0] [123]', '[x: 123]'],
    ['[x: 0] [123]', '[x: 123]'],
    ['[x: Int32 0] [123]', '[x: Int32 123]'],
    ['[x: [0]] [[123]]', '[x: [123]]'],
    ['[x: 0] []', '[x: 0]'],
    ['Int 1', '1'],
] as const) Deno.test(`numeric template default: ${source}`, () => {
    const i = new Interpreter();
    const actual = i.renderString(i.run(parseDocument(source)));
    if (actual !== expected) throw new Error(actual);
});
Deno.test('checker rejects known numeric application', () => {
    if (!checkSource('0 1').issues.some(x => x.message.includes('cannot apply a number'))) throw new Error('missing error');
});
