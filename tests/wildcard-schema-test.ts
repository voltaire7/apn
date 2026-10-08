import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

for (const checked of [false, true]) {
    for (const [source, expected] of [
        ['f ([x: _] v) = v.x; [f [1],f ["hi"],f [true]]', '[1,"hi",true]'],
        ['f ([x: _] v) = v.x; f [x: 2, extra: "yes"]', '2'],
        ['f ([x: _, y: _] v) = [v.x,v.y]; f [1,"hi"]', '[1,"hi"]'],
        ['f ([x: _, y: Float] v) = [v.x,v.y]; f [1,2]', '[1,2.0]'],
        ['f ([x: _] v) = typeOf v.x; f [Int32 1]', 'Int32'],
        ['f ([x: _] v) = v.x 2; f [(n -> n + 1)]', '3'],
        ['f ([x: _] v) = v.x; f [Int]', 'Int'],
        ['f ([child: [x: _]] v) = v.child.x; f [child: [x: "hi"]]', '"hi"'],
        ['f ([items: [_,Int]] v) = v.items; f [items: ["hi",2]]', '["hi",2]'],
        ['f ([x: _] v) = 42; f [Dynamic missing]', '42'],
        ['f ([x: _] v) = v.x; f [x: [1,2]]', '[1,2]'],
        ['f ([x: _] v) = { set v.x 2; 0 }; cell <- Mutable 1; f [cell]; cell', '2'],
        ['([x: _] v) <- [1]; v.x', '1'],
        ['(([x: _] v) -> v.x) [1]', '1'],
        ['f ([x: (_)] v) = v.x; f [1]', '1'],
    ]) Deno.test(`wildcard schema (checked=${checked}): ${source}`, () => {
        const i = new Interpreter();
        if (checked) i.enableChecking();
        const actual = i.renderString(i.run(parseDocument(source)));
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
    for (const source of [
        'f ([x: _] v) = v.x; f []',
        'f ([x: _] v) = v.x; f [1,2]',
        'f ([x: _] v) = v.x; f [y: 1]',
        'f ([x: _, y: Int] v) = v.y; f ["hi",.2]',
        'value = _; value',
        'value = [x: _]; value.x',
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
    i.run(parseDocument('accept n = n == 1 ? n : 1; f ([x: _] v) = accept v.x'));
    try { i.run(parseDocument('f [1.0]')); } catch (error) {
        if (String(error).includes('cannot use Float where Int')) return;
        throw error;
    }
    throw new Error('An inferred wildcard constraint must not convert its field');
});
