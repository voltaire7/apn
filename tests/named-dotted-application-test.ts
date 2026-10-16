import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
import { checkSource } from "../src/type-checker.ts";

for (const [source, expected] of [
    ['templates = [Int, Float]; values = [1, 2]; templates.values', '[1, 2.0]'],
    ['templates = [(* 2)]; values = [3]; templates.values', '[6]'],
    ['templates = [Char, Char]; values = "hi"; templates.values', "['h', 'i']"],
    ['templates = [Int]; values = [42]; { values = [7]; templates.values }', '[7]'],
    ['values = missing; obj = [values: 42]; obj.values', '42'],
    ['obj = [unbound: 42]; obj.unbound', '42'],
    ['values = [42]; templates = [Int]; templates.values 0', '42'],
    ['obj = [child: [x: 42]]; obj.child.x', '42'],
] as const) Deno.test(`named dot: ${source}`, () => {
    const i = new Interpreter();
    const actual = i.renderString(i.run(parseDocument(source)));
    if (actual !== expected) throw new Error(actual);
});

for (const source of [
    'templates = [Int]; values = [1, 2]; templates.values',
    'templates = [0]; values = [1]; templates.values',
    'templates = [Int]; templates.missing',
]) Deno.test(`named dot rejects invalid input: ${source}`, () => {
    const i = new Interpreter();
    try { i.renderString(i.run(parseDocument(source))); } catch { return; }
    throw new Error('expected failure');
});

Deno.test('checker distinguishes named list application from record fields', () => {
    for (const source of ['templates = [Int]; values = [1]; templates.values', 'obj = [unbound: 42]; obj.unbound']) {
        const result = checkSource(source);
        if (result.issues.length) throw new Error(JSON.stringify(result.issues));
    }
});
