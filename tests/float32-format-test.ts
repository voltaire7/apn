import { numberText } from "../src/numbers.ts";
import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
Deno.test('Float32 formatting uses its own precision', () => {
    for (const [n, expected] of [[.1, '0.1'], [.2, '0.2'], [.3, '0.3'], [1, '1.0'], [-0, '-0.0'], [Infinity, '+inf.0'], [-Infinity, '-inf.0'], [NaN, '+nan.0'], [2 ** -149, '1e-45']] as const) {
        const actual = numberText({ kind: 'float', v: Math.fround(n), typeName: 'Float32' });
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    }
});
Deno.test('Float32 decimal text preserves sampled bit patterns', () => {
    const bytes = new ArrayBuffer(4), view = new DataView(bytes);
    let bits = 0x12345678;
    for (let i = 0; i < 10000; i++) {
        bits = (Math.imul(bits, 1664525) + 1013904223) >>> 0;
        view.setUint32(0, bits);
        const n = view.getFloat32(0);
        if (!Number.isFinite(n)) continue;
        const text = numberText({ kind: 'float', v: n, typeName: 'Float32' });
        if (!Object.is(Math.fround(Number(text)), n)) throw new Error(`${bits}: ${text}`);
    }
});
Deno.test('widening Float32 still reveals its actual stored value', () => {
    const i = new Interpreter();
    const value = i.renderString(i.run(parseDocument('((.1 : Float32) : Float)')));
    if (value !== '0.10000000149011612') throw new Error(value);
});
