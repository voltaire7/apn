import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

for (const checked of [false, true]) {
    for (const [source, expected] of [
        ['f (v : [x : _]) = v.x; [f [1], f ["hi"], f [True]]', '[1, "hi", True]'],
        ['f (v : [x : _]) = v.x; f [x = 2, extra = "yes"]', '2'],
        ['f (v : [x : _, y : _]) = [v.x,v.y]; f [1, "hi"]', '[1, "hi"]'],
        ['f (v : [x : _, y : Float]) = [v.x,v.y]; f [1,2]', '[1,2.0]'],
        ['f (v : [x : _]) = typeOf v.x; f [(1 : Int32)]', 'Int32'],
        ['f (v : [x : _]) = v.x 2; f [n -> n + 1]', '3'],
        ['f (v : [x : _]) = v.x; f [Int]', 'Int'],
        ['f (v : [child : [x : _]]) = v.child.x; f [child = [x = "hi"]]', '"hi"'],
        ['f (v : [items : [_,Int]]) = v.items; f [items = ["hi", 2]]', '["hi", 2]'],
        ['f (v : [x : _]) = 42; f [(missing : Dynamic)]', '42'],
        ['f (v : [x : _]) = v.x; f [x = [1,2]]', '[1,2]'],
        ['f (v : [x : _]) = { set v.x 2; return 0 }; cell <- return (Mutable 1); f [cell]; cell', '2'],
        ['(v : [x : _]) <- return [1]; v.x', '1'],
        ['((v : [x : _]) -> v.x) [1]', '1'],
        ['f (v : [x : _]) = v.x; f [1]', '1'],
    ]) Deno.test(`wildcard schema (checked=${checked}): ${source}`, () => {
        const i = new Interpreter();
        if (checked) i.enableChecking();
        const actual = i.renderString(i.run(parseDocument(source)));
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
    for (const source of [
        'f (v : [x : _]) = v.x; f []',
        'f (v : [x : _]) = v.x; f [1,2]',
        'f (v : [x : _]) = v.x; f [y = 1]',
        'f (v : [x : _, y : Int]) = v.y; f ["hi", .2]',
        'value = [x : _]; value.x',
    ]) Deno.test(`wildcard schema rejects (checked=${checked}): ${source}`, () => {
        const i = new Interpreter();
        if (checked) i.enableChecking();
        try { i.renderString(i.run(parseDocument(source))); } catch { return; }
        throw new Error('Expected an error');
    });
}
Deno.test('wildcard field constraints do not insert numeric conversions', () => {
    const i = new Interpreter();
    i.enableChecking();
    i.run(parseDocument('accept n = n == 1 ? n : 1; f (v : [x : _]) = accept v.x'));
    try { i.run(parseDocument('f [1.0]')); } catch (error) {
        if (String(error).includes('cannot use Float where Int')) return;
        throw error;
    }
    throw new Error('An inferred wildcard constraint must not convert its field');
});
