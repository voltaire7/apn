import { Interpreter } from "../src/interp.ts";
import { parse } from "../main.ts";

const cases: [string, string][] = [
    ['combinators.I 42', '42'],
    ['combinators.K 42 missing', '42'],
    ['combinators.KI missing 42', '42'],
    ['combinators.S (x, y -> [x,y]) (+1) 4', '[4,5]'],
    ['combinators.S combinators.K combinators.K 42', '42'],
    ['combinators.B (*2) (+1) 20', '42'],
    ['combinators.C (x, y -> [x,y]) 1 2', '[2,1]'],
    ['combinators.W (x, y -> [x,y]) 4', '[4,4]'],
    ['combinators.M (x -> 42)', '42'],
    ['combinators.T 21 (*2)', '42'],
    ['combinators.V 20 22 (+)', '42'],
    ['combinators.B1 (*2) (+) 10 11', '42'],
    ['combinators.Q (+1) (*2) 20', '42'],
    ['combinators.U (x -> 42)', '42'],
    ['fix (ignored -> 42)', '42'],
    ['take 4 (fix (xs -> 1 :: xs))', '[1,1,1,1]'],
    ['take 4 (combinators.Y (xs -> 1 :: xs))', '[1,1,1,1]'],
    ['take 4 (combinators.Theta (xs -> 1 :: xs))', '[1,1,1,1]'],
    ['(self -> n -> self self n) (self -> n -> n == 0 ? 1 : n * self self (n - 1)) 5', '120'],
];
for (const combinator of ['combinators.Y', 'combinators.Z', 'combinators.Theta', 'fix']) {
    cases.push([`${combinator} (recurse, n -> n == 0 ? 1 : n * recurse (n - 1)) 0`, '1']);
    cases.push([`${combinator} (recurse, n -> n == 0 ? 1 : n * recurse (n - 1)) 6`, '720']);
    cases.push([`${combinator} (recurse, x, y -> x + y) 20 22`, '42']);
}
for (const [source, expected] of cases) Deno.test(`combinator: ${source}`, () => {
    const i = new Interpreter(); i.run(parse('std <- import "std"; use std.combinator'));
    const actual = i.renderString(i.run(parse(source)));
    if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
});
Deno.test("combinators are exported as a record and as module fields", () => {
    const i = new Interpreter(); i.run(parse('module <- import "std/combinator"'));
    if (i.renderString(i.run(parse('module.combinators.I 42'))) !== '42') throw new Error("missing combinators record");
    i.run(parse('c <- import "std/combinator"'));
    if (i.renderString(i.run(parse('c.yCombinator (f, x -> x) 42'))) !== '42') throw new Error("missing module export");
});
