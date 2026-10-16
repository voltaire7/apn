import { checkSource } from "../src/type-checker.ts";
import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

for (const [source, expected] of [
    ['obj = [x: 1]; obj.[x] = [10]; obj', '[x: 10]'],
    ['obj = [x: 1]; values = [10]; obj.[x] = values; obj', '[x: 10]'],
    ['obj = [x: []]; obj.[x] = [[10]]; obj', '[x: [10]]'],
    ['obj = [x: []]; obj.x = [10]; obj', '[x: [10]]'],
    ['obj = [x: 1]; obj.[] = []; obj', '[x: 1]'],
    ['obj = [x: 1, y: 2]; obj.[x, y] = obj.[y, x]; obj', '[x: 2, y: 1]'],
] as const) Deno.test(`field assignment shape: ${source}`, () => {
    const i = new Interpreter();
    const actual = i.renderString(i.run(parseDocument(source)));
    if (actual !== expected) throw new Error(actual);
});

for (const rhs of ['10', '[]', '[10, 20]']) Deno.test(`invalid single pluck preserves record: ${rhs}`, () => {
    const i = new Interpreter();
    i.run(parseDocument('obj = [x: 1]'));
    let error = '';
    try { i.run(parseDocument(`obj.[x] = ${rhs}`)); } catch (e) { error = String(e); }
    if (!error) throw new Error('expected error');
    if (rhs === '10' && !error.includes('list of values')) throw new Error(error);
    if (i.renderString(i.run(parseDocument('obj'))) !== '[x: 1]') throw new Error('record changed');
});

Deno.test('checker rejects scalar and wrong-length single pluck assignments', () => {
    for (const rhs of ['10', '[]', '[10, 20]']) {
        if (!checkSource(`obj = [x: 1]; obj.[x] = ${rhs}`).issues.length) throw new Error(rhs);
    }
    for (const statement of ['obj.[x] = [10]', 'obj.x = 10']) {
        const result = checkSource(`obj = [x: 1]; ${statement}`);
        if (result.issues.length) throw new Error(JSON.stringify(result.issues));
    }
});
