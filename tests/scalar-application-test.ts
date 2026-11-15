import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
import { checkSource } from "../src/type-checker.ts";
for (const source of ['"old" "new"', "'a' 'b'", '"old" missing', "'a' missing", 'x = "old"; x "new"', '0 123']) {
    Deno.test(`reject scalar application: ${source}`, () => {
        const i = new Interpreter();
        try { i.renderString(i.run(parseDocument(source))); } catch (e) {
            if (!String(e).includes('cannot apply')) throw e;
            return;
        }
        throw new Error('expected application failure');
    });
}
// A Bool applied to two values is one of them; the other is not evaluated.
for (const [source, expected] of [
    ['True "yes" "no"', '"yes"'],
    ['False missing 7', '7'],
    ['(x -> x 1 2) False', '2'],
    ['map (b -> truthy b "t" "f") [0,1]', '["f","t"]'],
    ['get x k = "http"; True 1 2', '1'],
] as const) Deno.test(`a Bool selects: ${source}`, () => {
    for (const checked of [false, true]) {
        const i = new Interpreter();
        if (checked) i.enableChecking();
        const actual = i.renderString(i.run(parseDocument(source)));
        if (actual !== expected) throw new Error(`${checked}: ${actual}`);
    }
});
for (const [source, expected] of [
    ['[x = ["old", False]] [x = ["new", True]]', '[x = ["new", True]]'],
    ['[name = "old", enabled = False] [name = "new", enabled = True]', '[name = "new", enabled = True]'],
    ['[name = "old", enabled = False] [name = "new", enabled = True]', '[name = "new", enabled = True]'],
    ['[name = "old", enabled = False] []', '[name = "old", enabled = False]'],
    ['[("hi" : String), (\'x\' : Char), truthy 1]', '["hi", \'x\', True]'],
] as const) Deno.test(`scalar template replacement: ${source}`, () => {
    const i = new Interpreter();
    const actual = i.renderString(i.run(parseDocument(source)));
    if (actual !== expected) throw new Error(actual);
});
for (const source of ['[x = False] [x = 1]', '[x = "old"] [x = 1]', "[x = 'a'] [x = 1]"]) {
    Deno.test(`scalar default retains kind: ${source}`, () => {
        const i = new Interpreter();
        try { i.renderString(i.run(parseDocument(source))); } catch (e) {
            if (!String(e).includes('cannot use Int where')) throw e;
            return;
        }
        throw new Error('expected conversion failure');
    });
}
Deno.test('gradual checker rejects scalar calls', () => {
    for (const source of ['"old" "new"', "'a' 'b'", '0 123']) {
        if (!checkSource(source).issues.some(x => x.message.includes('cannot apply'))) throw new Error(source);
    }
});
