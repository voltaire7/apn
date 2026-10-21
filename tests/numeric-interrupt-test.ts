import { Interpreter, setInterruptFlag, resetInterrupt } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
import { integer, numberText } from "../src/numbers.ts";

for (const source of ['2 ^ 100000000', 'vec = [x: 1, y: 2, z: 3]; vec.[x,y] ^ 100000000']) {
    Deno.test(`power is interruptible: ${source}`, async () => {
        const i = new Interpreter();
        const flag = new Int32Array(new SharedArrayBuffer(8));
        const worker = new Worker('data:application/javascript,' + encodeURIComponent('self.onmessage = e => { const flag = new Int32Array(e.data); self.postMessage("ready"); setTimeout(() => Atomics.store(flag, 0, 1), 50); };'), { type: 'module' });
        const ready = new Promise<void>(resolve => worker.onmessage = () => resolve());
        worker.postMessage(flag.buffer); await ready;
        setInterruptFlag(flag);
        const started = performance.now();
        try {
            let interrupted = false;
            try { i.renderString(i.run(parseDocument(source))); }
            catch (e) { if (!(e instanceof Error) || e.message !== 'interrupted') throw e; interrupted = true; }
            if (!interrupted) throw new Error('did not interrupt');
            if (performance.now() - started > 5000) throw new Error('interrupt took over five seconds');
            resetInterrupt();
            if (i.renderString(i.run(parseDocument('1 + 2'))) !== '3' || i.stack !== 0) throw new Error('failed to recover');
        } finally { setInterruptFlag(null); worker.terminate(); }
    });
}
Deno.test('chunked numeric formatting preserves exact decimal digits', () => {
    for (const n of [0n, -1n, 10n ** 1024n, 10n ** 4096n + 123n, -(2n ** 15000n)]) {
        if (numberText(integer(n)) !== String(n)) throw new Error('digits changed');
    }
});
Deno.test('numeric formatting observes interruption', () => {
    const flag = new Int32Array(new SharedArrayBuffer(8));
    setInterruptFlag(flag); Atomics.store(flag,0,1);
    try {
        try { numberText(integer(123n)); } catch (e) {
            if (e instanceof Error && e.message === 'interrupted') return;
            throw e;
        }
        throw new Error('did not interrupt');
    } finally { setInterruptFlag(null); }
});
