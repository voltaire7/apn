import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
function result(source: string): string {
    const i = new Interpreter();
    return i.renderString(i.run(parseDocument(source)));
}
for (const [source, expected] of [
    ['Vector3 = [x: Float, y: Float, z: Float]; CustomVector = Vector3; CustomVector.x = 123; CustomVector []', '[x: 123, y: 0.0, z: 0.0]'],
    ['v = [x: Float]; v.x = Int; v []', '[x: 0]'],
    ['v = [x: Float]; v.x = 123; v.x = 456.0; v.x', '456'],
    ['v = [x: Float]; v.x = Float 123; v.x = 456; v', '[x: 456.0]'],
    ['v = [nested: [x: 1]]; v.nested = [y: 2]; v', '[nested: [y: 2]]'],
    ['v = [f: x -> missing]; v.f = 123; v.f', '123'],
    ['count = Mutable 0; action = { set count 1 }; v = [f: action]; v.f = 123; count', '0'],
    ['v = [type: Float, value: 123]; v.type = Int; v', '[type: Int, value: 123]'],
    ['xs = [Float]; xs 0 = .2; xs 0 = 1; xs', '[1.0]'],
    ['v = [x: Float] []; v "x" = 123; v.[x] = [456]; v.x', '456.0'],
    ['Id = distinct Int; v = [id: Id 1]; v.id = 2; v.id', 'Id 2'],
    ['((Int -> Int) identity) <- pure ((x -> x)); v = [f: identity]; v.f = (x -> x + 1); v.f 2', '3'],
    ['[x: 1] [y: 2]', '[x: 1, y: 2]'],
] as const) Deno.test(`slot replacement: ${source}`, () => {
    const actual = result(source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
Deno.test('typed slot rejects Type with a conversion error and preserves its value', () => {
    const i = new Interpreter();
    i.run(parseDocument('v = [x: Float] []'));
    try { i.run(parseDocument('v.x = Int')); }
    catch (e) {
        if (!String(e).includes('cannot convert Type to Float')) throw e;
        if (i.renderString(i.run(parseDocument('v.x'))) !== '0.0') throw new Error('changed value');
        return;
    }
    throw new Error('expected conversion failure');
});
