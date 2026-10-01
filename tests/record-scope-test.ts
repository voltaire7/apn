import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
import { checkSource } from "../src/type-checker.ts";
for (const [source, expected] of [
    ['obj = [x: 3,y: 4]; obj.(x + y)', '7'],
    ['x = 100; outside = 10; obj = [x: 3]; obj.(x + outside)', '13'],
    ['obj = [x: 3,y: 4]; obj.([x,y])', '[3, 4]'],
    ['obj = [x: 3]; result <- obj.(x = 10; x); [result,obj.x]', '[10, 3]'],
    ['obj = [x: 3]; f = obj.(y -> x + y); f 4', '7'],
    ['obj = [x: 3]; values = obj.([x]); values', '[3]'],
    ['obj = [x: 3]; obj.()', '[]'],
    ['obj = [x: 3]; obj.(sqrt (x ^ 2))', '3'],
    ['values = [1,2]; [Int,Float].(values)', '[1, 2.0]'],
    ['obj = [(x): 9,x: 3]; [obj "(x)",obj.(x)]', '[9, 3]'],
    ['obj = [child: [x: 1]]; result <- obj.(child.x = 10; child.x); [result,obj.child.x]', '[10, 1]'],
    ['obj = [x: 3]; obj.(inner = [x: 4]; inner.(x) + x)', '7'],
] as const) Deno.test(`record scope: ${source}`, () => {
    const i = new Interpreter();
    const actual = i.renderString(i.run(parseDocument(source)));
    if (actual !== expected) throw new Error(actual);
});
Deno.test('record scope restores the caller after failure', () => {
    const i = new Interpreter(); i.run(parseDocument('x = 99; obj = [x: 3]'));
    try { i.run(parseDocument('obj.(fail "oops")')); } catch { /* expected */ }
    if (i.renderString(i.run(parseDocument('x'))) !== '99') throw new Error('scope leaked');
});
Deno.test('scoped expressions are not field assignment targets', () => {
    for (const source of ['obj.(x) = 1', 'obj.(x).y = 1', 'obj.child.(x) = 1']) {
        try { parseDocument(source); } catch { continue; }
        throw new Error(source);
    }
});
Deno.test('static checker resolves record scope fields', () => {
    const result = checkSource('obj = [x: 3,y: 4]; obj.(x + y)');
    if (result.issues.length) throw new Error(JSON.stringify(result.issues));
});
