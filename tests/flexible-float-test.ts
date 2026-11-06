import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
import { checkSource } from "../src/type-checker.ts";
// The value and its type: precision is the subject here.
function result(source: string): string {
    const i = new Interpreter(), v = i.run(parseDocument(source));
    return `${i.renderString(v)} : ${i.typeText(v)}`;
}
for (const source of ['Float32 .1 + .2', '.2 + Float32 .1', 'Float32 .1 + Float .2', 'Float .2 + Float32 .1', 'x = .2; Float32 .1 + x', 'x = Float .2; Float32 .1 + x', 'f x = x + Float32 .1; f .2']) {
    Deno.test(`flexible Float arithmetic: ${source}`, () => {
        if (result(source) !== '0.3 : Float32') throw new Error(result(source));
    });
}
for (const [source, expected] of [
    ['.1 + .2', '0.30000000000000004 : Float'],
    ['Float .1 + Float .2', '0.30000000000000004 : Float'],
    ['Float64 .1 + Float .2', '0.30000000000000004 : Float64'],
    ['Float .2 + Float64 .1', '0.30000000000000004 : Float64'],
    ['[Float32 .1] + [.2]', '[0.3] : [Float32]'],
    ['r = [x: Float32 .1] + [x: Float .2]; r.x', '0.3 : Float32'],
    ['Float32 .5 ^ Float 2', '0.25 : Float32'],
    ['expt (Float32 .5) (Float 2)', '0.25 : Float32'],
    ['Float32 .5 ^ 2', '0.25 : Float32'],
    ['Float32 .1 + Float32 (Float64 .2)', '0.3 : Float32'],
    ['x = .2; ignored <- return (Float32 .1 + x); x', '0.2 : Float'],
] as const) Deno.test(`precision result: ${source}`, () => {
    if (result(source) !== expected) throw new Error(result(source));
});
for (const op of ['+', '-', '*', '/', '%', '^']) for (const [a,b] of [['Float32 .5','Float64 .25'],['Float64 .5','Float32 .25']]) {
    Deno.test(`fixed precision mismatch: ${a} ${op} ${b}`, () => {
        try { result(`${a} ${op} ${b}`); } catch (e) {
            if (!String(e).includes('explicit cast')) throw e;
            return;
        }
        throw new Error('expected mixed precision error');
    });
}
Deno.test('static checker diagnoses fixed precision arithmetic', () => {
    if (!checkSource('Float32 .1 + Float64 .2').issues.length) throw new Error('missing error');
    for (const source of ['Float32 .1 + .2', 'Float32 .1 + Float .2']) {
        const checked = checkSource(source);
        if (checked.issues.length) throw new Error(JSON.stringify(checked.issues));
    }
});
