import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
import { checkSource } from "../src/type-checker.ts";
for (const source of ['"old" "new"', "'a' 'b'", 'False True', 'True 1', '"old" missing', "'a' missing", 'False missing', 'x = "old"; x "new"', '(x -> x True) False']) {
    Deno.test(`reject scalar application: ${source}`, () => {
        const i = new Interpreter();
        try { i.renderString(i.run(parseDocument(source))); } catch (e) {
            if (!String(e).includes('cannot apply')) throw e;
            return;
        }
        throw new Error('expected application failure');
    });
}
for (const [source, expected] of [
    ['[x: ["old",False]] [["new",True]]', '[x: ["new",True]]'],
    ['[name: "old", enabled: False] [name: "new", enabled: True]', '[name: "new", enabled: True]'],
    ['[name: "old", enabled: False] ["new",True]', '[name: "new", enabled: True]'],
    ['[name: "old", enabled: False] []', '[name: "old", enabled: False]'],
    ['[String "hi", Char \'x\', Bool 1]', '["hi",\'x\',True]'],
] as const) Deno.test(`scalar template replacement: ${source}`, () => {
    const i = new Interpreter();
    const actual = i.renderString(i.run(parseDocument(source)));
    if (actual !== expected) throw new Error(actual);
});
for (const source of ['[x: False] [1]', '[x: "old"] [1]', "[x: 'a'] [1]"]) {
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
    for (const source of ['"old" "new"', "'a' 'b'", 'False True']) {
        if (!checkSource(source).issues.some(x => x.message.includes('cannot apply'))) throw new Error(source);
    }
});
