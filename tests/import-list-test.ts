import { Interpreter } from "../src/interp.ts";
import { parseDocument, exprToSource } from "../src/parser.ts";
function result(i: Interpreter, source: string): string {
    return i.renderString(i.run(parseDocument(source)));
}
for (const [source, expected] of [
    ['import ["function", "sequence"]\nid (sum [1, 2, 3])', '6'],
    ['ns = import ["function", "sequence"]\nuse ns\nid (sum [1, 2, 3])', '6'],
    ['import [\n    "function"\n    "sequence"\n]\nid 123', '123'],
    ['length (pairs (import []))', '0'],
    ['use [import "function", import "sequence"]\nid (sum [1, 2, 3])', '6'],
]) Deno.test(`list import: ${source}`, () => {
    const actual = result(new Interpreter(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
Deno.test('list imports select only requested bindings', () => {
    const i = new Interpreter();
    if (result(i, '[id, sum] = import ["function", "sequence"]\nid (sum [1, 2, 3])') !== '6') throw new Error('bad selection');
    if (i.env.get('reverse') !== undefined) throw new Error('leaked unselected export');
});
Deno.test('failed list import does not open earlier modules', () => {
    const i = new Interpreter();
    try { result(i, 'import ["function", "missing"]'); } catch (error) {
        if (!String(error).includes('unknown module')) throw error;
        if (i.env.get('id') !== undefined) throw new Error('partial import');
        return;
    }
    throw new Error('expected error');
});
for (const source of ['import ["function", "function"]', 'import [123]', 'import ["std" "function"]', 'import ["std"', 'import [missing]']) {
    Deno.test(`invalid list import: ${source}`, () => {
        try { parseDocument(source); } catch { return; }
        throw new Error('expected parse error');
    });
}
Deno.test('list import source round-trips', () => {
    const ast = parseDocument('import ["function", "number"]')[0];
    if (ast.t !== 'expr') throw new Error('expected expression');
    if (JSON.stringify(parseDocument(exprToSource(ast.value))) !== JSON.stringify([ast])) throw new Error('changed syntax');
});

Deno.test("a list import names each module once", () => {
    const source = 'import ["option", "text", "option"]';
    try { parseDocument(source); } catch (error) {
        const e = error as { kind?: string; message: string; pos?: number };
        if (e.kind !== "parse" || e.message !== "'option' is imported twice" || e.pos !== source.lastIndexOf('"option"')) throw new Error(`${e.kind} ${e.pos}: ${e.message}`);
        return;
    }
    throw new Error("accepted a duplicate import");
});
