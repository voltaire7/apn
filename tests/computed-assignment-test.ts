import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
import { lint } from "../src/lint.ts";

for (const [source, expected] of [
    ['arr = [0]\ni = 0\narr i = 2\narr', '[2]'],
    ['arr = [0, 0]\ni = 0\narr (i + 1) = 2\narr', '[0, 2]'],
    ['arr = [0, 0]\ni = -1\narr i = 2\narr', '[0, 2]'],
    ['arr = [0, 0]\ni = 1\narr (-i) = 2\narr', '[0, 2]'],
    ['arr = [0, 0]\nnext x = x + 1\narr (next 0) = 2\narr', '[0, 2]'],
    ['arr = [0, 0]\ni = 1\narr (Int32 i) = 2\narr', '[0, 2]'],
    ['arr = [0, 0]\ni = { 1 }\narr i = 2\narr', '[0, 2]'],
    ['arr = [0, 0]\ni = 0\narr i = 1\narr i = arr i + 1\narr', '[2, 0]'],
    ['arr = [0, 1]\narr (arr 0) = arr 1 + 1\narr', '[2, 1]'],
    ['arr = [0..]\ni = 2\narr i = 9\ntake 4 arr', '[0, 1, 9, 3]'],
    ['arr = [0, missing]\ni = 0\narr i = 9\nhead arr', '9'],
    ['arr = [0, 0]\ni = 0\ninside = { arr (i + 1) = 2; arr }\n[inside, arr]', '[[0, 2], [0, 0]]'],
    ['arr = [0]\ni = 0\nold <- arr\narr i = 2\n[old, arr]', '[[0], [2]]'],
    ['arr = [Int32].[0]\ni = 0\narr i = 2\narr', '[Int32 2]'],
    ['obj = [x: 1]\nkey = "x"\nobj key = 2\nobj', '[x: 2]'],
    ['obj = [x: 1]\nkey = "y"\nobj (key ++ "z") = 2\nobj', '[x: 1, yz: 2]'],
    ['obj = [x: 1]\nkey = "x"\ninside = { obj (key ++ "") = 2; obj }\n[inside, obj]', '[[x: 2], [x: 1]]'],
    ['quote { arr (i + 1) = 2 }', '"{ arr (i + 1) = 2 }"'],
    ['f x = { arr (i + 1) = x; arr }\nf', 'x -> { arr (i + 1) = x; arr }'],
    ['i = 0\nf i = i + 1\nf 4', '5'],
    ['f x = x\ni = 0\nf i = i + 2\nf 4', '6'],
    ['f = _\nf i = i + 2\nf 4', '6'],
] as const) Deno.test(`computed assignment: ${source}`, () => {
    if (lint(source).length) throw new Error('linter rejected assignment');
    const i = new Interpreter();
    const actual = i.renderString(i.run(parseDocument(source)));
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});

for (const [index, error] of [
    ['"0"', 'association assignment expects'], ['.2', 'integer index'], ['true', 'integer index'],
    ['1', 'out of range'], ['-2', 'out of range'], ['missing', 'unbound variable'],
] as const) Deno.test(`invalid computed index preserves binding: ${index}`, () => {
    const i = new Interpreter();
    i.run(parseDocument('arr = [0]'));
    try {
        i.run(parseDocument(`idx = ${index}\narr idx = 2`));
        throw new Error('assignment unexpectedly succeeded');
    } catch (e) {
        if (!(e instanceof Error) || !e.message.includes(error)) throw e;
    }
    if (i.renderString(i.run(parseDocument('arr'))) !== '[0]') throw new Error('binding changed');
});

Deno.test('REPL variable indices stay assignments across submissions', () => {
    const i = new Interpreter(); i.extendDefinitions = true;
    for (const line of ['arr = [0]', 'i = 0', 'arr i = 2', 'arr (i + 0) = 3']) i.run(parseDocument(line));
    if (i.renderString(i.run(parseDocument('arr'))) !== '[3]') throw new Error('not an updated list');
});

Deno.test('computed key runs once and before RHS', () => {
    const i = new Interpreter();
    const source = 'count = Mutable 0\narr = [0]\nkey x = { set count $ (count + 1); x }\narr (key (0 + 0)) = count + 1\n[arr, count]';
    const actual = i.renderString(i.run(parseDocument(source)));
    if (actual !== '[[2], 1]') throw new Error(actual);
});

Deno.test('failed computed slot conversion preserves initialized type', () => {
    const i = new Interpreter();
    i.run(parseDocument('arr = [Int].[0]\ni = 0'));
    try { i.run(parseDocument('arr (i + 0) = .2')); throw new Error('expected failure'); }
    catch (e) { if (!(e instanceof Error) || !e.message.includes('lossy conversion')) throw e; }
    if (i.renderString(i.run(parseDocument('[arr, typeOf (arr 0)]'))) !== '[[0], Int]') throw new Error('lost value or type');
});
