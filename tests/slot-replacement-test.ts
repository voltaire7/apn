import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
function result(source: string): string {
    const i = new Interpreter();
    return i.renderString(i.run(parseDocument(source)));
}
for (const [source, expected] of [
    ['Vector3 = [x : Float, y : Float, z : Float]\nCustomVector = Vector3\nCustomVector.x = 123\n([] : CustomVector)', '[x = 123.0, y = 0.0, z = 0.0]'],
    ['v = [x : Float]; v.x = Int; [v, ([] : v)]', '[[x : Int], [x = 0]]'],
    ['v = [x : Float]; v.x = 123 : Float; v.x = 456; v', '[x = 456.0]'],
    ['v = [nested = [x = 1]]; v.nested = [y = 2]; v', '[nested = [y = 2]]'],
    ['count = Mutable 0; action = { set count 1 }; v = [f = action]; v.f = { set count 2 }; count', '0'],
    ['v = [type : Float, value = 123]; v.type = Int; v', '[type : Int, value = 123]'],
    ['xs = [Float]; xs 0 = .2; xs 0 = 1; xs', '[1.0]'],
    ['v = [] : [x : Float]; v "x" = 123; v.[x] = [456]; v.x', '456.0'],
    ['Id = Int; v = [id = (1 : Id)]; v.id = 2; [v.id, typeOf v.id]', '[2,Id]'],
    ['(identity : Int -> Int) <- return (x -> x); v = [f = identity]; v.f = x -> x + 1; v.f 2', '3'],
    ['[x = 1] [y = 2]', '[x = 1, y = 2]'],
] as const) Deno.test(`slot replacement: ${source}`, () => {
    const actual = result(source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
Deno.test('typed slot rejects Type with a conversion error and preserves its value', () => {
    const i = new Interpreter();
    i.run(parseDocument('v = [] : [x : Float]'));
    try { i.run(parseDocument('v.x = Int')); }
    catch (e) {
        if (!String(e).includes('cannot use Type where Float is required')) throw e;
        if (i.renderString(i.run(parseDocument('v.x'))) !== '0.0') throw new Error('changed value');
        return;
    }
    throw new Error('expected conversion failure');
});
for (const source of ['v = [f = x -> missing]; v.f = 123', 'v = [f = { print 1 }]; v.f = 123']) {
    Deno.test(`a field keeps its type: ${source}`, () => {
        try { result(source); } catch (e) {
            if (!String(e).includes('cannot use')) throw e;
            return;
        }
        throw new Error('expected a type error');
    });
}
