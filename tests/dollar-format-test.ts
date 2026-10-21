import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

function result(source: string): string {
    const i = new Interpreter();
    return i.renderString(i.run(parseDocument(source)));
}
for (const [source, expected] of [
    ['(+ 1) $ (* 2) $ 3', '7'],
    ['(+ 1) $ 2 * 3', '7'],
    ['(x -> 42) $ missing', '42'],
    ['head $ [42,missing]', '42'],
    ['format "vec = %" [[x: 1]]', '"vec = [x: 1]"'],
    ['format "100%%" []', '"100%"'],
    ['format "%%%" [42]', '"%42"'],
    ['format "" []', '""'],
    ['format "%/%" [1..2]', '"1/2"'],
    ['format "%" ["50%"]', '"50%"'],
    ['import "syntax"\ntoAST (head $ [1,2])', 'Apply (Apply (Name "$") (Name "head")) (Items [Numeral 1, Numeral 2])'],
] as const) Deno.test(`application and format: ${source}`, () => {
    const actual = result(source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const [source, error] of [
    ['format "% %" [1]', 'expected 2 arguments, got 1'],
    ['format "%" [1,2]', 'expected 1 arguments, got at least 2'],
    ['format "%%" [1]', 'expected 0 arguments'],
    ['format "%" [1..]', 'expected 1 arguments'],
    ['format "%" [x: 1]', 'expects a list'],
    ['format "%" 1', 'expects a list'],
    ['format "%" [missing,missing]', 'expected 1 arguments'],
] as const) Deno.test(`format rejects: ${source}`, () => {
    try { result(source); } catch (e) {
        if (String(e).includes(error)) return;
        throw e;
    }
    throw new Error('expected rejection');
});
Deno.test('print accepts a dollar-applied formatted value', () => {
    const log = console.log;
    const output: unknown[] = [];
    console.log = value => { output.push(value); };
    try { new Interpreter().run(parseDocument('vec = [x: 1]; print $ format "vec = %" [vec]')); }
    finally { console.log = log; }
    if (JSON.stringify(output) !== '["vec = [x: 1]"]') throw new Error(String(output));
});

Deno.test('printed dollar function reparses with the same grouping', () => {
    const i = new Interpreter();
    i.run(parseDocument('f x = head $ tail $ x'));
    const source = i.renderString(i.env.get('f')!);
    const actual = result(`g = ${source}; g [1,2,3]`);
    if (actual !== '2') throw new Error(`${source}: ${actual}`);
});
