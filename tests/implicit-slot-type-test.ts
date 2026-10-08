import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
for (const [source, expected] of [
    ['v = [x: 1]; v.x = 1.0; [v.x,typeOf v.x]', '[1,Int]'],
    ['v = [x: 1.0]; v.x = 2; [v.x,typeOf v.x]', '[2.0,Float]'],
    ['v = [x: 1]; v "x" = 2.0; v.x', '2'],
    ['v = [x: 1, y: 2.0]; v.[x,y] = [3.0,4]; v', '[x: 3, y: 4.0]'],
    ['xs = [1]; i = 0; xs i = 2.0; xs', '[2]'],
    ['v = [x: Float]; v.x = 123; v.x = 456.0; v.x', '456'],
    ['v = [x: 1/3]; v.x = 2; typeOf v.x', 'Fraction'],
    ['v = [x: 1i]; v.x = 2; typeOf v.x', 'Complex'],
] as const) Deno.test(`implicit slot type: ${source}`, () => {
    const i = new Interpreter();
    const actual = i.renderString(i.run(parseDocument(source)));
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const assignment of ['v.x = 1.5', 'v "x" = 1.5', 'v.[x] = [1.5]']) {
    Deno.test(`implicit Int rejects lossy update: ${assignment}`, () => {
        const i = new Interpreter();
        i.run(parseDocument('v = [x: 1]'));
        try { i.run(parseDocument(assignment)); } catch (e) {
            if (!String(e).includes('lossy conversion to Int')) throw e;
            if (i.renderString(i.run(parseDocument('v'))) !== '[x: 1]') throw new Error('changed binding');
            return;
        }
        throw new Error('expected lossy conversion error');
    });
}
