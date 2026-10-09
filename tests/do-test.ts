import { Interpreter, NATIVES, setInterruptFlag } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

for (const [source, expected, effects] of [
    ['do []', '[]', []],
    ['do [print "hi"]', '[]', ['hi']],
    ['do [print "hi",print "there",42]', '42', ['hi', 'there']],
    ['greet = do [print "hi"]; greet; greet', '[]', ['hi', 'hi']],
    ['xs = [print "hi"]; do xs; do xs', '[]', ['hi', 'hi']],
    ['say = print "hi"; do [say,say]', '[]', ['hi', 'hi']],
    ['do (map (n -> print n) [1,2,3])', '[]', ['1', '2', '3']],
    ['do [1..10000]', '10000', []],
    ['v <- do [print "hi",[42,missing]]; head v', '42', ['hi']],
    ['f = import "function"; f.do [1,42]', '42', []],
    ['import "function"; do [42]', '42', []],
    ['apply f x = f x; apply do [42]', '42', []],
] as const) Deno.test(`do: ${source}`, () => {
    const i = new Interpreter();
    const log = console.log;
    const output: string[] = [];
    console.log = (...args: unknown[]) => output.push(args.join(' '));
    try {
        const actual = i.renderString(i.run(parseDocument(source)));
        if (actual !== expected || JSON.stringify(output) !== JSON.stringify(effects)) throw new Error(JSON.stringify({ actual, output }));
    } finally { console.log = log; }
});
Deno.test('do stops at the first error', () => {
    const i = new Interpreter();
    let failed = false;
    try { i.run(parseDocument('cell = Mutable 0; do [set cell $ 1,missing,set cell $ 2]')); }
    catch (e) { if (e instanceof Error && e.message.includes('missing')) failed = true; else throw e; }
    if (!failed || i.renderString(i.run(parseDocument('cell'))) !== '1') throw new Error('wrong effect order');
});
Deno.test('do is an APN function, not a native or keyword', () => {
    const i = new Interpreter();
    if (i.env.get('do')?.kind !== 'clauseFn' || NATIVES.some(([name]) => name === 'do')) throw new Error('not APN');
    if (i.renderString(i.run(parseDocument('do x = x; do 42'))) !== '42') throw new Error('not shadowable');
});
Deno.test('do streams an infinite sequence until interrupted', () => {
    const i = new Interpreter();
    const flag = new Int32Array(new SharedArrayBuffer(8));
    const log = console.log;
    let count = 0, interrupted = false;
    console.log = () => { if (++count === 1000) Atomics.store(flag, 0, 1); };
    setInterruptFlag(flag);
    try { i.run(parseDocument('do (map print [0..])')); }
    catch (e) { if (e instanceof Error && e.message === 'interrupted') interrupted = true; else throw e; }
    finally { setInterruptFlag(null); console.log = log; }
    if (!interrupted || count !== 1000) throw new Error('did not stream');
});
