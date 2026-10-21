import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
import { checkSource } from "../src/type-checker.ts";
for (const source of ['"old" "new"', "'a' 'b'", 'false true', 'true 1', '"old" missing', "'a' missing", 'false missing', 'x = "old"; x "new"', '(x -> x true) false']) {
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
    ['[x: ["old",false]] [["new",true]]', '[x: ["new",true]]'],
    ['[name: "old", enabled: false] [name: "new", enabled: true]', '[name: "new", enabled: true]'],
    ['[name: "old", enabled: false] ["new",true]', '[name: "new", enabled: true]'],
    ['[name: "old", enabled: false] []', '[name: "old", enabled: false]'],
    ['[String "hi", Char \'x\', Bool 1]', '["hi",\'x\',true]'],
] as const) Deno.test(`scalar template replacement: ${source}`, () => {
    const i = new Interpreter();
    const actual = i.renderString(i.run(parseDocument(source)));
    if (actual !== expected) throw new Error(actual);
});
for (const source of ['[x: false] [1]', '[x: "old"] [1]', "[x: 'a'] [1]"]) {
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
    for (const source of ['"old" "new"', "'a' 'b'", 'false true']) {
        if (!checkSource(source).issues.some(x => x.message.includes('cannot apply'))) throw new Error(source);
    }
});
