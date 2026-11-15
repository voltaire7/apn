import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
import { checkSource } from "../src/type-checker.ts";
for (const [source, expected] of [
    ['(.1 : Float32)', '0.1 : Float32'],
    ['((.1 : Float) : Float32)', '0.1 : Float32'],
    ['((.1 : Float) : Float32)', '0.1 : Float32'],
    ['F = Float32; (.1 : F)', '0.1 : F'],
    ['(.1 : Float32) + .2', '0.3 : Float32'],
    ['(.1 : Float32) + (.2 : Float32)', '0.3 : Float32'],
    ['(9007199254740993 : Float)', '9007199254740992.0 : Float'],
    ['(1/3 : Float64)', '0.3333333333333333 : Float64'],
    ['[Float32].[.1]', '[0.1] : [Float32]'],
    ['f (x : Float32) = 1; f x = 2; f .1', '2 : Int'],
] as const) Deno.test(`explicit float construction: ${source}`, () => {
    const i = new Interpreter();
    const v = i.run(parseDocument(source)), actual = `${i.renderString(v)} : ${i.typeText(v)}`;
    if (actual !== expected) throw new Error(actual);
});
for (const source of ['(.2 : Int)', '(.2 : Int32)', '(1+2i : Float32)', 'v = [x = (.5 : Float32)]; v.x = .1', 'f (x : Float32) = x; f .1', '([.1] : Vect 1 Float32)']) {
    Deno.test(`float construction preserves strict conversions: ${source}`, () => {
        const i = new Interpreter();
        try { i.renderString(i.run(parseDocument(source))); } catch { return; }
        throw new Error('expected error');
    });
}
Deno.test('checker accepts explicit floating rounding but rejects implicit narrowing', () => {
    for (const source of ['(.1 : Float32)', '(9007199254740993 : Float)', '(.1 : Float32) + .2']) {
        const result = checkSource(source);
        if (result.issues.length) throw new Error(JSON.stringify(result.issues));
    }
    if (!checkSource('v = [x = (.5 : Float32)]; v.x = .1').issues.length) throw new Error('implicit narrowing accepted');
});
