import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
for (const source of ['["old"].["new"]', '[0].[1]', "['a'].['b']", '[(0 : Int32)].[1]', '[[0]].[[1]]', 'values = [0]; values.([1])']) {
    Deno.test(`dot rejects scalar slots: ${source}`, () => {
        const i = new Interpreter();
        try { i.renderString(i.run(parseDocument(source))); } catch (e) {
            if (!String(e).includes('cannot apply')) throw e;
            return;
        }
        throw new Error('expected application error');
    });
}
for (const [source, expected] of [
    ['[String,Int].["new",1]', '["new",1]'],
    ['[(* 2)].[3]', '[6]'],
    ['[x: "old"] [x: "new"]', '[x: "new"]'],
    ['[x: [0]] [x: [1]]', '[x: [1]]'],
    ['[x: 1, y: 2].[y,x]', '[2,1]'],
] as const) Deno.test(`dot and record distinction: ${source}`, () => {
    const i = new Interpreter();
    const actual = i.renderString(i.run(parseDocument(source)));
    if (actual !== expected) throw new Error(actual);
});
