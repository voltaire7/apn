import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
import { checkSource } from "../src/type-checker.ts";
for (const [source, expected] of [
    ['Float32 .1', 'Float32 0.1'],
    ['Float32 (Float .1)', 'Float32 0.1'],
    ['cast Float32 (Float .1)', 'Float32 0.1'],
    ['F = Float32; F .1', 'Float32 0.1'],
    ['Float32 .1 + .2', 'Float32 0.3'],
    ['Float32 .1 + Float32 .2', 'Float32 0.3'],
    ['Float 9007199254740993', '9007199254740992.0'],
    ['Float64 (1/3)', 'Float64 0.3333333333333333'],
    ['[Float32].[.1]', '[Float32 0.1]'],
    ['f (Float32 x) = 1; f x = 2; f .1', '2'],
] as const) Deno.test(`explicit float construction: ${source}`, () => {
    const i = new Interpreter();
    const actual = i.renderString(i.run(parseDocument(source)));
    if (actual !== expected) throw new Error(actual);
});
for (const source of ['Int .2', 'Int32 .2', 'Float32 (1+2i)', 'v = [x: Float32 .5]; v.x = .1', 'f (Float32 x) = x; f .1', 'Vector 1 Float32 [.1]']) {
    Deno.test(`float construction preserves strict conversions: ${source}`, () => {
        const i = new Interpreter();
        try { i.renderString(i.run(parseDocument(source))); } catch { return; }
        throw new Error('expected error');
    });
}
Deno.test('checker accepts explicit floating rounding but rejects implicit narrowing', () => {
    for (const source of ['Float32 .1', 'Float 9007199254740993', 'Float32 .1 + .2']) {
        const result = checkSource(source);
        if (result.issues.length) throw new Error(JSON.stringify(result.issues));
    }
    if (!checkSource('v = [x: Float32 .5]; v.x = .1').issues.length) throw new Error('implicit narrowing accepted');
});
