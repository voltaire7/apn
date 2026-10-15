import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

function result(source: string): string {
    const i = new Interpreter();
    return i.renderString(i.run(parseDocument(source)));
}
const direction = 'Direction = North | East | South | West\n';
for (const [source, expected] of [
    ['offsets = [[0,-1],[1,0],[0,1],[-1,0]]\n[offsets North,offsets East,offsets South,offsets West]', '[[0,-1],[1,0],[0,1],[-1,0]]'],
    ['xs = [10,20,30,40]\nd = East\nxs d', '20'],
    ['xs = [10..]\nxs West', '13'],
    ['xs = 10 :: 20 :: []\nxs East', '20'],
    ['xs = [missing,20]\nxs East', '20'],
    ['xs = [10,20]\nold <- return (xs)\nxs East = 30\n[xs,old]', '[[10,30],[10,20]]'],
    ['xs = [[0,-1],[1,0]]\nxs North = [0,0]\nxs North', '[0,0]'],
    ['xs = [Int,Float]\nd = East\nxs (d) = 2\nxs', '[Int,2]'],
    ['Other = First | Second\n[10,20] Second', '20'],
    ['[North == 0,typeOf North]', '[false,Direction]'],
] as const) Deno.test(`variant index: ${source}`, () => {
    const actual = result(direction + source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const [source, error] of [
    ['[10] East', 'out of range'],
    ['xs = [10]\nxs East = 20', 'out of range'],
    ['Option a = Some a | None\n[10] None', 'indexing a list needs'],
    ['Option a = Some a | None\n[10] (Some 0)', 'indexing a list needs'],
    ['xs = [10]\nxs "0" = 20', 'association assignment expects'],
] as const) Deno.test(`variant index rejection: ${source}`, () => {
    try { result(direction + source); } catch (e) {
        if (String(e).includes(error)) return;
        throw e;
    }
    throw new Error('expected rejection');
});
Deno.test('table is no longer an intrinsic', () => {
    if (new Interpreter().env.get('table') !== undefined) throw new Error('table still registered');
});
