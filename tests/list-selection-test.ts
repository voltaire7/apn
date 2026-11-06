import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

for (const [source, expected] of [
    ['arr = [10,20,30]; arr [2,1]', '[30,20]'],
    ['arr = [10,20,30]; arr [1,2] = arr [2,1]; arr', '[10,30,20]'],
    ['arr = [10,20,30]; keys = [1,2]; arr keys = arr [2,1]; arr', '[10,30,20]'],
    ['arr = [10,20,30]; arr ([1] ++ [2]) = arr [2,1]; arr', '[10,30,20]'],
    ['arr = [10,20,30]; arr [-1,0] = [40,50]; arr', '[50,20,40]'],
    ['arr = [1,2]; arr [0,0] = [3,4]; arr', '[4,2]'],
    ['arr = [1,2]; arr [] = []; arr', '[1,2]'],
    ['arr = [1,2]; [{ arr [0,1] = [3,4]; arr }, arr]', '[[3,4],[1,2]]'],
    ['head ([missing,42] [1,0])', '42'],
    ['take 3 ([10,20] (0::1::0::missing))', '[10,20,10]'],
    ['take 4 ([0..] [3,2,1,0])', '[3,2,1,0]'],
    ['arr = [0..]; arr [1,3] = [11,33]; take 5 arr', '[0,11,2,33,4]'],
    ['Direction = North | East; [10,20] [East,North]', '[20,10]'],
    ['Direction = North | East; arr = [10,20]; arr [East,North] = [3,4]; arr', '[4,3]'],
    ['[String,Int].["x",1]', '["x",1]'],
    ['[(+ 1), (* 2)].[10,20]', '[11,40]'],
    ['x = 10; [Int,Int].[x,x+1]', '[10,11]'],
    ['templates = [Int,Float]; values = [1,2]; templates.(values)', '[1,2.0]'],
    ['[Char,Char]."hi"', "['h','i']"],
    ['[Int] [0]', '[Int]'],
    ['Vector3 = [x: Float, y: Float, z: Float]; Vector3 [1,2,3]', '[x: 1.0, y: 2.0, z: 3.0]'],
    ['vec = [x: 1, y: 2]; vec.[y,x]', '[2,1]'],
    ['vec = [x: 1, y: 2]; vec.[x,y] = vec.[y,x]; vec', '[x: 2, y: 1]'],
    ['vec = [x: 1, y: 2]; vec.[x: a, y: b]', '[a: 1, b: 2]'],
] as const) Deno.test(`list selection / template: ${source}`, () => {
    const i = new Interpreter();
    const actual = i.renderString(i.run(parseDocument(source)));
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const assignment of [
    'arr [0,2] = [3,4]', 'arr [0,1] = [3]', 'arr [0,1] = [3,4,5]',
    'arr [0,1] = [3,1.5]', 'arr [0,"x"] = [3,4]', 'arr [0,1] = 3',
    'arr [] = [1]', 'arr [0,1] = [3,missing]',
]) Deno.test(`multi-index failure preserves binding: ${assignment}`, () => {
    const i = new Interpreter();
    i.run(parseDocument('arr = [1,2]'));
    let failed = false;
    try { i.run(parseDocument(assignment)); } catch { failed = true; }
    const actual = i.renderString(i.run(parseDocument('arr')));
    if (!failed || actual !== '[1,2]') throw new Error(actual);
});

Deno.test('computed index and replacement from actions run once', () => {
    const i = new Interpreter();
    const actual = i.renderString(i.run(parseDocument(`
keyCalls = Mutable 0
valueCalls = Mutable 0
keys = { set keyCalls (keyCalls + 1); return [0,1] }
values = { set valueCalls (valueCalls + 1); return [3,4] }
arr = [1,2]
k <- keys
v <- values
arr k = v
[arr,keyCalls,valueCalls]
`)));
    if (actual !== '[[3,4],1,1]') throw new Error(actual);
});
Deno.test('vector updates preserve their schema', () => {
    const i = new Interpreter();
    const actual = i.renderString(i.run(parseDocument('arr = [1,2] : Vect 2 Int; arr [0,1] = [3,4]; [arr, typeOf arr]')));
    if (actual !== '[[3,4], Vect 2 Int]') throw new Error(actual);
});
Deno.test('selection rejects nested indices when consumed', () => {
    const i = new Interpreter();
    try { i.renderString(i.run(parseDocument('[10,20] [[0]]'))); } catch (error) {
        if (!String(error).includes('indices')) throw error;
        return;
    }
    throw new Error('expected invalid index');
});

for (const source of ['[Int].[]', '[Int].[1,2]', '[Int]."hi"', 'cast [Int] [1,2]', '[x: [Int]] [x: [1,2]]']) {
    Deno.test(`one template slot never broadcasts: ${source}`, () => {
        const i = new Interpreter();
        try { i.renderString(i.run(parseDocument(source))); } catch { return; }
        throw new Error('expected length or conversion failure');
    });
}
Deno.test('singleton schema membership has exact length', () => {
    const i = new Interpreter();
    const actual = i.renderString(i.run(parseDocument('[isType [Int] [], isType [Int] [1], isType [Int] [1,2]]')));
    if (actual !== '[False,True,False]') throw new Error(actual);
});
Deno.test('cast still requires types, not arbitrary functions', () => {
    const i = new Interpreter();
    try { i.renderString(i.run(parseDocument('cast [(* 2)] [1]'))); } catch { return; }
    throw new Error('expected Type validation error');
});
