import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
function result(i: Interpreter, source: string): string {
    return i.renderString(i.run(parseDocument(source)));
}
for (const [source, expected] of [
    ['std = import "std"\nuse std\nidentity 123', '123'],
    ['unused = missing + 1\nuse [x: 1, unused: unused]\nx', '1'],
    ['use [[x: 1],[y: 2, x: 3]]\n[x,y]', '[3,2]'],
    ['use []', '[]'],
    ['open = use\nopen [x: 123]\nx', '123'],
    ['use $ [x: 123]\nx', '123'],
    ['x = 1\n{ use [x: 2]; x }\nx', '1'],
    ['cell = Mutable 1\nuse [alias: cell]\nset alias 2\ncell', '2'],
    ['outer = 10\nf x = outer + x\nuse [outer: 20, add: f]\nadd 1', '21'],
]) Deno.test(`use: ${source}`, () => {
    const actual = result(new Interpreter(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
Deno.test('use exports retain their defining module scope', () => {
    const i = new Interpreter();
    const actual = result(i, 'module = { private = 40; [add: (x -> private + x)] }\nuse module\nadd 2');
    if (actual !== '42' || i.env.get('private') !== undefined) throw new Error(actual);
});
for (const source of ['use 1', 'use [[x: 2],3]', 'use [x: 2, "bad": 3]', 'use [1: 2]', 'use ["_": 2]']) {
    Deno.test(`use rejects input without partially installing bindings: ${source}`, () => {
        const i = new Interpreter();
        result(i, 'x = 1');
        try { result(i, source); } catch (error) {
            if (!String(error).includes('use ')) throw error;
            if (result(i, 'x') !== '1') throw new Error('partially changed scope');
            return;
        }
        throw new Error('expected rejection');
    });
}
