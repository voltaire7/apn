import { Interpreter, setInterruptFlag } from "../src/interp.ts";
import { NATIVES } from "../src/natives.ts";
import { parseDocument } from "../src/parser.ts";

for (const [source, expected, effects] of [
    ['do []', '[]', []],
    ['do [print "hi"]', '[]', ['hi']],
    ['do [print "hi", print "there", return 42]', '42', ['hi', 'there']],
    ['greet = do [print "hi"]; greet; greet', '[]', ['hi', 'hi']],
    ['xs = [print "hi"]; do xs; do xs', '[]', ['hi', 'hi']],
    ['say = print "hi"; do [say,say]', '[]', ['hi', 'hi']],
    ['do (map (n -> print n) [1,2,3])', '[]', ['1', '2', '3']],
    ['do (map return [1..10000])', '10000', []],
    ['v <- do [print "hi", return [42,missing]]; head v', '42', ['hi']],
    ['f <- import "std/function"; f.do [return 1, return 42]', '42', []],
    ['std <- import "std"; [..] = std.function; do [return 42]', '42', []],
    ['apply f x = f x; apply do [return 42]', '42', []],
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
    try { i.run(parseDocument('cell = Mutable 0; do [set cell $ 1, missing, set cell $ 2]')); }
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
// do statements is their block: the same result, effects or error, checked or not.
for (const [form, block] of [
    ['do []', '{}'],
    ['do [1,2]', '{ 1; 2 }'],
    ['do [print "hi", return 42]', '{ print "hi"; return 42 }'],
    ['x <- do []', 'x <- {}'],
    ['x = do [print 1, 2]', 'x = { print 1; 2 }'],
    ['std <- import "std"; [..] = std.option; do [Some 1, Some 2]', 'std <- import "std"; [..] = std.option; { Some 1; Some 2 }'],
    ['std <- import "std"; [..] = std.option; do [Some 1, None, Some 2]', 'std <- import "std"; [..] = std.option; { Some 1; None; Some 2 }'],
    ['do [[1,2],[3]]', '{ [1,2]; [3] }'],
] as const) Deno.test(`do is its block: ${form}`, () => {
    const outcome = (source: string, checked: boolean) => {
        const i = new Interpreter();
        if (checked) i.enableChecking();
        const log = console.log, output: string[] = [];
        console.log = (...args: unknown[]) => output.push(args.join(' '));
        try { return `${i.renderString(i.run(parseDocument(source)))} ${output.join('|')}`; }
        catch (e) { return `error: ${e instanceof Error ? e.message : e}`; }
        finally { console.log = log; }
    };
    for (const checked of [true, false]) {
        const a = outcome(form, checked), b = outcome(block, checked);
        if (a !== b) throw new Error(`${checked ? 'checked' : 'unchecked'}: ${a} vs ${b}`);
    }
});
