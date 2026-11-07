import { Interpreter } from "../src/interp.ts";
import { parseDocument, exprToSource } from "../src/parser.ts";
function result(i: Interpreter, source: string): string {
    return i.renderString(i.run(parseDocument(source)));
}
// import "path" is an action yielding the module's record: std is the library's
// folder, whose fields are its modules, and use opens records.
for (const [source, expected] of [
    ['std <- import "std"; use std.[function,sequence]\nid (sum [1,2,3])', '6'],
    ['std <- import "std"; use std.function\nid 7', '7'],
    ['sequence <- import "std/sequence"\nsequence.sum [1,2]', '3'],
    ['std <- import "std"\n[id] = std.function\nid 5', '5'],
    ['std <- import "std"\nstd.number.sq 4', '16'],
]) Deno.test(`std import: ${source}`, () => {
    const actual = result(new Interpreter(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
Deno.test('a failed use opens nothing', () => {
    const i = new Interpreter();
    try { result(i, 'std <- import "std"; use std.[function,missing]'); } catch (error) {
        if (!String(error).includes('missing')) throw error;
        if (i.env.get('id') !== undefined) throw new Error('partial use');
        return;
    }
    throw new Error('expected error');
});
for (const [source, message] of [
    ['m = import "std/function"\nm.id 1', 'an action has no fields'],
    ['import "option"', "a standard module is std.option"],
    ['import "std/nothing"', "the standard library has no module 'nothing'"],
] as const) Deno.test(`std import rejects: ${source}`, () => {
    try { result(new Interpreter(), source); } catch (error) {
        if (`${String(error)} ${(error as { hint?: string }).hint ?? ""}`.includes(message)) return;
        throw error;
    }
    throw new Error(`expected ${message}`);
});
for (const source of ['import ["std/option"]', 'import [123]', 'import 123']) {
    Deno.test(`import reads one module: ${source}`, () => {
        try { parseDocument(source); } catch { return; }
        throw new Error('expected parse error');
    });
}
Deno.test('an import round-trips', () => {
    const [ast] = parseDocument('import "std/option"');
    if (ast.t !== 'expr' || exprToSource(ast.value) !== 'import "std/option"') throw new Error('changed syntax');
});
