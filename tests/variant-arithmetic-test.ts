import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

const direction = 'Direction = North | East | South | West\n';
function result(source: string): string {
    const i = new Interpreter();
    return i.renderString(i.run(parseDocument(direction + source)));
}
for (const [source, expected] of [
    ['[North + 1,1 + East,West - East,10 - South]', '[1,2,2,8]'],
    ['[South * West,2 * East,West / South,West % South,South ^ West]', '[6,2,3/2,1,8]'],
    ['[-North,-East,-West]', '[0,-1,-3]'],
    ['[East + .5,South * .5,South ^ 3]', '[1.5,1.0,8]'],
    ['[typeOf (East + 1),typeOf North,North == 0]', '[Int,Direction,false]'],
    ['Other = First | Second\nWest + Second', '4'],
    ['[North,East,South] + 1', '[1,2,3]'],
    ['2 * [East,South]', '[2,4]'],
    ['-[East,South]', '[-1,-2]'],
    ['[x: East, y: South] + 1', '[x: 2, y: 3]'],
    ['xs = [10,20,30,40]\nxs (East + 1)', '30'],
    ['xs = [10,20,30,40]\nxs (East + 1) = 99\nxs South', '99'],
    ['[1,2] * (+ East)', '[2,3]'],
] as const) Deno.test(`variant arithmetic: ${source}`, () => {
    const actual = result(source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'Maybe a = Some a | None\nNone + 1',
    'Maybe a = Some a | None\nSome 1 + 1',
    'Direction + 1',
    'West / North',
    'UserId = distinct Int\nUserId 1 + East',
]) Deno.test(`variant arithmetic rejects: ${source}`, () => {
    try { result(source); } catch { return; }
    throw new Error('expected rejection');
});
