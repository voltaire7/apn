import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
function result(source: string): string {
    const i = new Interpreter();
    return i.renderString(i.run(parseDocument(source)));
}
for (const [source, expected] of [
    ['[1, 2, 3] + [10, 20, 30]', '[11, 22, 33]'],
    ['[1, 2, 3] * 2', '[2, 4, 6]'],
    ['2 * [1, 2, 3]', '[2, 4, 6]'],
    ['10 - [1, 2, 3]', '[9, 8, 7]'],
    ['[1, 2, 3] - 10', '[-9, -8, -7]'],
    ['[1, 2, 3] / 2', '[1/2, 1, 3/2]'],
    ['12 / [2, 3, 4]', '[6, 4, 3]'],
    ['[5, 6, 7] % 3', '[2, 0, 1]'],
    ['[2, 3] ^ [3, 2]', '[8, 9]'],
    ['2 ^ [1, 2, 3]', '[2, 4, 8]'],
    ['-[1, 2, 3]', '[-1, -2, -3]'],
    ['[[1, 2], [3, 4]] + [[10, 20], [30, 40]]', '[[11, 22], [33, 44]]'],
    ['2 * [[1, 2], [3, 4]]', '[[2, 4], [6, 8]]'],
    ['[] + []', '[]'], ['[] + 2', '[]'],
    ['[1, 2] ++ [3, 4]', '[1, 2, 3, 4]'],
    ['[1, 2] * (+ 1)', '[2, 3]'],
    ['3 * (x -> x + 1)', '[1, 2, 3]'],
    ['[x: 1, y: 2] + [y: 20, x: 10]', '[x: 11, y: 22]'],
    ['2 * [x: 1, y: 2]', '[x: 2, y: 4]'],
    ['-[x: 1, y: 2]', '[x: -1, y: -2]'],
    ['[x: [1, 2]] + [x: [3, 4]]', '[x: [4, 6]]'],
    ['[Int32 1] + [Int32 2]', '[Int32 3]'],
    ['[1/3, 1i] * 2', '[2/3, 0+2i]'],
    ['take 3 ([0..] + [10..])', '[10, 12, 14]'],
    ['take 3 (2 * [0..])', '[0, 2, 4]'],
    ['take 3 (-[0..])', '[0, -1, -2]'],
    ['head ([1, missing] + [2, missing])', '3'],
    ['head ([1, missing] * 2)', '2'],
    ['head ([1] + [2, 3])', '3'],
    ['unused = missing + 1\n([x: 1, y: unused] + [y: 2, x: 3]).x', '4'],
    ['import "array"\ndot [1, 2, 3] [4, 5, 6]', '32'],
    ['import "array"\ntranspose [[1, 2, 3], [4, 5, 6]]', '[[1, 4], [2, 5], [3, 6]]'],
    ['import "array"\nmatmul [[1, 2], [3, 4]] [[5, 6], [7, 8]]', '[[19, 22], [43, 50]]'],
    ['import "array"\n[shape 1, shape [], shape [[1, 2], [3, 4]], transpose [], matmul [[]] []]', '[[], [0], [2, 2], [], [[]]]'],
]) Deno.test(`array arithmetic: ${source}`, () => {
    const actual = result(source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const [source, error] of [
    ['[1, 2] + [3]', 'lengths differ'],
    ['[] + [1]', 'lengths differ'],
    ['[[1, 2]] + [[3]]', 'lengths differ'],
    ['[[1, 2], [3, 4]] + [10, 20]', 'matching shapes'],
    ['[x: 1] + [y: 2]', 'record keys differ'],
    ['[x: 1] + ["x": 2]', 'record keys differ'],
    ['[1] + [x: 1]', 'matching shapes'],
    ['["a"] + ["b"]', 'numeric leaves'],
    ['[Int8 127] + 1', 'out of range'],
    ['[1] / 0', 'zero'],
    ['import "array"\ntranspose [[1], [2, 3]]', 'equal row lengths'],
    ['import "array"\nmatmul [[1]] [[], []]', 'dimensions'],
    ['import "array"\nmatmul [[1], [2, 3]] [[1]]', 'equal lengths'],
    ['import "array"\nshape [[1], [2, 3]]', 'rectangular'],
]) Deno.test(`array arithmetic rejects: ${source}`, () => {
    try { result(source); } catch (e) {
        if (String(e).includes(error)) return;
        throw e;
    }
    throw new Error('expected ' + error);
});
