import { Interpreter, setInterruptFlag, resetInterrupt } from "../src/interp.ts";
import { parse } from "../main.ts";
function value(i: Interpreter, source: string): string { return i.renderString(i.run(parse(source))); }
Deno.test("REPL submissions extend clauses and replace matching clauses", () => {
    const i = new Interpreter(); i.extendDefinitions = true;
    i.run(parse('func 0 = 1')); i.run(parse('func 1 = 0'));
    if (value(i, 'func 0') !== '1' || value(i, 'func 1') !== '0') throw new Error("clause lost");
    i.run(parse('func 0 = 42'));
    if (value(i, 'func 0') !== '42' || value(i, 'func 1') !== '0') throw new Error("clause replacement failed");
    i.run(parse('f x = x')); i.run(parse('f 0 = 7'));
    if (value(i, 'f 0') !== '7' || value(i, 'f 2') !== '2') throw new Error("new clause priority failed");
    i.run(parse("f y = y + 1"));
    if (value(i, "f 2") !== "3") throw new Error("renamed parameter was not replaced");
});
Deno.test("Existing range patterns and list destructuring work on separate submissions", () => {
    const i = new Interpreter(); i.extendDefinitions = true;
    i.run(parse('within [0..10] = true')); i.run(parse('within x = false'));
    if (value(i, 'within 0') !== 'true' || value(i, 'within 10') !== 'true' || value(i, 'within 11') !== 'false') throw new Error("range pattern failed");
    if (value(i, 'first (x:xs) = x; first [3..]') !== '3') throw new Error("range destructuring failed");
});
for (const [source, expected] of [
    ['n = 5; [1..n]', '[1, 2, 3, 4, 5]'],
    ['a = 2; b = 6; [a..b]', '[2, 3, 4, 5, 6]'],
    ['n = 5; step = 2; [0,step..n]', '[0, 2, 4]'],
    ['n = 3; [n..1]', '[3, 2, 1]'],
    ['end = 1; [0,0.5..end]', '[0.0, 0.5, 1.0]'],
    ['n = 4; take 3 [n..]', '[4, 5, 6]'],
    ['import "std"; factorial 0', '1'],
    ['import "std"; factorial n = product [1..n]; factorial 5', '120'],
]) Deno.test(`range regression: ${source}`, () => {
    const actual = value(new Interpreter(), source);
    if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
});
for (const definitions of ['x = x', 'x = y; y = x', 'x = x + 1']) {
    Deno.test(`cyclic evaluation waits for interruption: ${definitions}`, () => {
        const i = new Interpreter(); i.run(parse(definitions));
        const flag = new Int32Array(new SharedArrayBuffer(8));
        const worker = new Worker('data:application/javascript,' + encodeURIComponent('self.onmessage = e => { const flag = new Int32Array(e.data); setTimeout(() => Atomics.store(flag, 0, 1), 60); };'), { type: "module" });
        setInterruptFlag(flag); worker.postMessage(flag.buffer);
        try {
            try { i.run(parse('x')); throw new Error("unproductive value returned"); }
            catch (error) { if (!(error instanceof Error) || error.message !== 'interrupted') throw error; }
            resetInterrupt();
            if (value(i, 'x = 42; x') !== '42' || i.stack !== 0) throw new Error("failed to recover");
        } finally { setInterruptFlag(null); worker.terminate(); }
    });
}
