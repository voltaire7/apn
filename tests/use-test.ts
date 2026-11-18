import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
import { givesValue } from "../src/ast.ts";
function result(i: Interpreter, source: string): string {
    return i.renderString(i.run(parseDocument(source)));
}
for (const [source, expected] of [
    ['combinators <- import "std/combinator"\n[..] = combinators\nidentity 123', '123'],
    ['[..] <- import "std/combinator"\nidentity 123', '123'],
    ['c.[..] <- import "std/combinator"\n[c.identity 1, identity 2]', '[1,2]'],
    ['shared.[..] = [a = 1, f x = x * 2]\n[shared.a, f 3]', '[1,6]'],
    ['unused = missing + 1\n[..] = [x = 1, unused = unused]\nx', '1'],
    ['[..] = [x = 1]\n[..] = [y = 2, x = 3]\n[x,y]', '[3,2]'],
    // A list of records opens each in turn.
    ['[..] = [[x = 1], [y = 2, x = 3]]\n[x,y]', '[3,2]'],
    ['std <- import "std"\n[..] = std.[option,number]\n[withDefault 0 None, sq 3]', '[0,9]'],
    ['[..] = []', '[]'],
    ['x = 1\n[{ [..] = [x = 2]; x }, x]', '[2,1]'],
    ['cell = Mutable 1\n[..] = [alias = cell]\nset alias 2\ncell', '2'],
    ['outer = 10\nf x = outer + x\n[..] = [outer = 20, add = f]\nadd 1', '11'],
    // In code, [..] = binds and yields nothing, as = does.
    ['[[..] = [a = 1], a + 1]', '[2]'],
    ['code = [[..] = [a = 1], a + 1]\n[length code, do code, code.a]', '[2,2,1]'],
    // In a record, its names are fields: a module passes them on.
    ['r = [a = 1]\n[[..] = r, b = 2]', '[a = 1, b = 2]'],
]) Deno.test(`[..]: ${source}`, () => {
    const actual = result(new Interpreter(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
Deno.test('[..] = exports retain their defining module scope', () => {
    const i = new Interpreter();
    const actual = result(i, 'module = { private = 40; [add = x -> private + x] }\n[..] = module\nadd 2');
    if (actual !== '42' || i.env.get('private') !== undefined) throw new Error(actual);
});
// [..] is no name: use is unbound, and [..] opens records alone.
for (const source of ['[..] = 1', '[..] = [[x = 2], 3]', '[..] = [x = 1, [..] = 2]', 'use [x = 1]']) {
    Deno.test(`[..] = rejects input without partially installing bindings: ${source}`, () => {
        const i = new Interpreter();
        result(i, 'x = 1');
        try { result(i, source); } catch (error) {
            if (!/\[\.\.\]|use/.test(String(error))) throw error;
            if (result(i, 'x') !== '1') throw new Error('partially changed scope');
            return;
        }
        throw new Error('expected rejection');
    });
}
// [..] = r binds, as every = does: it gives no value (the REPL echoes none,
// and a file ending in it gives []).
Deno.test("[..] = r gives no value", () => {
    if (givesValue(parseDocument("[..] = [a = 1]")[0]) || !givesValue(parseDocument("1 + 1")[0])) throw new Error("givesValue");
    if (givesValue(parseDocument("s.[..] = [a = 1]").at(-1))) throw new Error("s.[..]");
});
