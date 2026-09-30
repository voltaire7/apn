import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

for (const [source, expected] of [
    ['obj = []; obj.[x,y] = 123; [obj.[x,y], obj "[x,y]"]', '[123, 123]'],
    ['obj = [[x,y]: 123]; obj.[x,y]', '123'],
    ['obj = [[x,y]: 1, [x, y]: 2]; [obj.[x,y], obj.[x, y]]', '[1, 2]'],
    ['obj = [[missing + other]: 7]; obj.[missing + other]', '7'],
    ['obj = [[x: renamed]: 7]; obj.[x: renamed]', '7'],
    ['obj = [[(x),[y]]: [z: 9]]; obj.[(x),[y]].z', '9'],
    ['obj = [[]: 4]; obj.[]', '4'],
    ['obj = [[x,y]: 1]; obj "[x,y]" = 2; obj.[x,y]', '2'],
    ['obj = [[x,y]: 1]; [[x,y]: n] = obj; n', '1'],
    ['obj = [x: 1,y: 2]; map obj ["y", "x", "y"]', '[2, 1, 2]'],
    ['obj = [x: 1]; head (map obj ["x", "missing"])', '1'],
    ['Person = [name: String, city: String]; Person ["Alice", "Paris"]', '[name: "Alice", city: "Paris"]'],
    ['obj = [x: 1,y: 2]; obj []', '[x: 1, y: 2]'],
] as const) Deno.test(`bracket keys: ${source}`, () => {
    const i = new Interpreter();
    const actual = i.renderString(i.run(parseDocument(source)));
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of ['obj.[x,y', 'obj.[x)', 'obj.[(x]]']) {
    Deno.test(`reject malformed bracket key: ${source}`, () => {
        try { parseDocument(source); } catch { return; }
        throw new Error('expected parse failure');
    });
}
Deno.test('old pluck spelling accesses only its literal key', () => {
    const i = new Interpreter();
    try { i.run(parseDocument('obj = [x: 1,y: 2]; obj.[x,y]')); } catch (error) {
        if (!String(error).includes('[x,y]')) throw error;
        return;
    }
    throw new Error('expected missing key');
});
