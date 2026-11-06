import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
for (const [source, expected] of [
    ['(+ 1) * [1,2,3]', '[2,3,4]'],
    ['increment x = x + 1\nincrement * [1,2,3]', '[2,3,4]'],
    ['Int * 3', '[0,1,2]'],
    ['Int * -3', '[0,-1,-2]'],
    ['Int * []', '[]'],
    ['(entry -> entry 1) * [x: 1, y: 2]', '[1,2]'],
    ['((+ 1) \\ (* 2)) * [1,2,3]', '[3,5,7]'],
    ['(increment : Int -> Int) <- return (+ 1); increment * [1,2]', '[2,3]'],
    ['[1,2,3] * 2', '[2,4,6]'],
    ['2 * [1,2,3]', '[2,4,6]'],
]) Deno.test(`function-left iteration: ${source}`, () => {
    const i = new Interpreter();
    const actual = i.renderString(i.run(parseDocument(source)));
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
Deno.test('function-left print runs immediately in element order', () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
    try {
        const i = new Interpreter();
        const value = i.run(parseDocument('print * [1,2,3,4]'));
        if (lines.join(',') !== '1,2,3,4') throw new Error(JSON.stringify(lines));
        if (i.renderString(value) !== '[[],[],[],[]]') throw new Error('lost results');
        if (lines.length !== 4) throw new Error('repeated effects');
    } finally { console.log = original; }
});
