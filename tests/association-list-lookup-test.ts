import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
import { checkSource } from "../src/type-checker.ts";

for (const [source, expected] of [
    ['[["x", 1]] "x"', '1'],
    ['entries = [["x", 1], ["y", 2]]; key = "y"; entries key', '2'],
    ['[["x", 1], ["x", 2]] "x"', '1'],
    ['[["other", missing], ["x", 42]] "x"', '42'],
    ['([["x", 42]] ++ missing) "x"', '42'],
    ['[["x", 42], missing] "x"', '42'],
    ['[["x", [1, 2]]] "x"', '[1, 2]'],
    ['[["x", (* 2)]] "x" 3', '6'],
    ['entries = [["0", 42]]; [entries "0", entries 0, entries [0]]', '[42, ["0", 42], [["0", 42]]]'],
    ['entries = map (n -> [to String n, n]) [0..]; entries "3"', '3'],
    ['[["", 7]] ""', '7'],
] as const) Deno.test(`association lookup: ${source}`, () => {
    const i = new Interpreter();
    const actual = i.renderString(i.run(parseDocument(source)));
    if (actual !== expected) throw new Error(actual);
});
for (const [source, message] of [
    ['[] "x"', 'no key'],
    ['[["y", 1]] "x"', 'no key'],
    ['[1] "x"', 'pairs'],
    ['[["x"]] "x"', 'pairs'],
    ['[["x", 1, 2]] "x"', 'pairs'],
    ['[[1, 2]] "x"', 'string keys'],
] as const) Deno.test(`invalid association lookup: ${source}`, () => {
    const i = new Interpreter();
    try { i.renderString(i.run(parseDocument(source))); } catch (e) {
        if (!String(e).includes(message)) throw e;
        return;
    }
    throw new Error('expected failure');
});
Deno.test('association lookup remains valid at a gradual boundary', () => {
    const result = checkSource('entries = [["x", 1]]; entries "x"');
    if (result.issues.length) throw new Error(JSON.stringify(result.issues));
});
