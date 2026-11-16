import { CheckingSession } from "../src/checking-session.ts";
import { Interpreter, setInterruptFlag } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

function result(source: string): string {
    const i = new Interpreter();
    return i.renderString(i.run(parseDocument(source)));
}
for (const [source, expected] of [
    ['loop 0 = 42; loop n = { unused = missing; loop (n - 1) }; loop 10000', '42'],
    ['loop 0 = 42; loop n = loop (n - 1); loop 10000', '42'],
    ['loop = n -> n == 0 ? 42 : loop (n - 1); loop 10000', '42'],
    ['even n = n == 0 ? True : odd (n - 1); odd n = n == 0 ? False : even (n - 1); even 10001', 'False'],
    ['loop n = n == 0 ? 42 : { next = n - 1; loop $ next }; loop 10000', '42'],
    ['loop n ignored = n == 0 ? 42 : loop (n - 1) missing; loop 10000 missing', '42'],
    ['loop n = n == 0 ? [42,missing] : loop (n - 1); head (loop 10000)', '42'],
    ['loop n = n ~ [0 -> 42, k | k > 0 -> loop (k - 1)]; loop 100000', '42'],
    // A ternary is Bool c a b as written there: clauses for get the program
    // adds for a Bool are the ones it uses.
    ['get True a = _ -> "mine"; f n = n ? "yes" : "no"; [f 0, f [1]]', '["no","mine"]'],
    ['sum n total = n == 0 ? return total : { next <- return (total + n); sum (n - 1) next }\ns <- sum 10000 0\ns', '50005000'],
] as const) Deno.test(`tail call: ${source}`, () => {
    const actual = result(source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
// A long chain of the prelude's operators that take their left operand first
// runs in a loop, parsed and checked alike without nesting with its length; a
// chain of nested calls ($) still nests, and overflows as a call stack overflow.
{
    const chain = (head: string, piece: string, n: number, tail: string) => {
        const out = [head];
        for (let i = 0; i < n; i++) { if (out[out.length - 1].length > 85) out.push("   "); out[out.length - 1] += piece; }
        return out.join("\n") + tail;
    };
    const checked = (source: string) => {
        const i = new Interpreter();
        i.enableChecking();
        return i.renderString(i.run(parseDocument(source)));
    };
    for (const [name, source, expected] of [
        ["+", chain("y = 2", " + 1", 20000, "\ny"), "20002"],
        ["+ and *", chain("y = 2", " + 2 * 3 - 1", 5000, "\ny"), "25002"],
        ["&&", chain("y = True", " && True", 20000, "\ny"), "True"],
        ["++ of strings", chain('y = "a"', ' ++ "a"', 5000, "\nlength y"), "5001"],
        ["++ of lists", chain("y = [1]", " ++ [1,2]", 5000, "\n[length y, y 10000]"), "[10001,2]"],
        // Each list joined sees the bindings of the items before it, as nested.
        ["++ of code", chain("y = [x = 1]", " ++ [x + 1]", 100, "\n[length y, y 100]"), "[101,2]"],
        ["::", chain("y = 1", " :: 1", 20000, " :: []\nlength y"), "20001"],
    ] as const) Deno.test(`a long chain of ${name} runs`, () => {
        const actual = checked(source);
        if (actual !== expected) throw new Error(actual);
    });
    Deno.test("a long chain of nested calls is a call stack overflow", () => {
        let message = "";
        try { checked(chain("inc x = x + 1\ny = inc", " $ inc", 3000, " $ 1\ny")); } catch (error) { message = String(error); }
        if (!message.includes("call stack overflow")) throw new Error(message);
    });
}
// A file's last statement using code runs it in place, as a tail call: what
// each file binds joins the first's, and each file's paths are beside it.
for (const [file, expected] of [['repeat', '[0,42]'], ['outer', '[0,10,20]']] as const) {
    Deno.test(`tail use keeps every file's bindings and relative paths: ${file}`, () => {
        const i = new Interpreter();
        const scope = i.env;
        const directory = new URL('./fixtures/tail-load/', import.meta.url).pathname;
        i.sourceDir = directory;
        const expression = file === 'repeat' ? '[counter,exported]' : '[counter,outerValue,innerValue]';
        const actual = i.renderString(i.run(parseDocument(`counter = Mutable 1500\nmodule <- load "${file}"\nuse module\n${expression}`)));
        if (actual !== expected) throw new Error(actual);
        if (i.env !== scope || i.sourceDir !== directory || i.stack !== 0) throw new Error('execution context leaked');
    });
}
Deno.test('recursive load stays interruptible and restores the REPL context', () => {
    const i = new Interpreter();
    const scope = i.env;
    i.sourceDir = new URL('./fixtures/tail-load/', import.meta.url).pathname;
    const directory = i.sourceDir;
    const flag = new Int32Array(new SharedArrayBuffer(8));
    const log = console.log;
    let lines = 0;
    let interrupted = false;
    console.log = (...args: unknown[]) => {
        const expected = ['x: 1', 'y: 2', 'z: 3'][lines % 3];
        if (args.join(' ') !== expected) throw new Error(`unexpected output: ${args}`);
        if (++lines === 4500) Atomics.store(flag, 0, 1);
    };
    setInterruptFlag(flag);
    try { i.run(parseDocument('forever <- load "forever"; use forever')); }
    catch (error) { if (error instanceof Error && error.message === 'interrupted') interrupted = true; else throw error; }
    finally { setInterruptFlag(null); console.log = log; }
    if (!interrupted || lines !== 4500) throw new Error(`did not reach interruption: ${lines}`);
    if (i.env !== scope || i.sourceDir !== directory || i.stack !== 0) throw new Error('context leaked after interrupt');
    if (i.renderString(i.run(parseDocument('6 * 7'))) !== '42') throw new Error('REPL failed to recover');
});

for (const file of ['function', 'action']) Deno.test(`tail load through ${file}`, () => {
    const i = new Interpreter();
    i.sourceDir = new URL('./fixtures/tail-load/', import.meta.url).pathname;
    const value = i.run(parseDocument(`counter = Mutable 1200; code <- load "${file}"; use code; counter`));
    if (i.renderString(value) !== '0') throw new Error('did not finish');
});
Deno.test('tail load keeps block exports scoped and resumes non-tail loads', () => {
    const i = new Interpreter();
    i.sourceDir = new URL('./fixtures/tail-load/', import.meta.url).pathname;
    i.run(parseDocument('counter = Mutable 3; module <- load "scoped"; use module'));
    if (i.env.get('exported')) throw new Error('block-local export escaped');
    if (i.renderString(i.run(parseDocument('outside'))) !== '1') throw new Error('outer export lost');
    const value = i.run(parseDocument('set counter $ 3; module <- load "non-tail"; use module; after'));
    if (i.renderString(value) !== '7') throw new Error('non-tail continuation lost');
});
Deno.test('tail load failure restores context without publishing unfinished exports', () => {
    const i = new Interpreter();
    const scope = i.env;
    i.sourceDir = new URL('./fixtures/tail-load/', import.meta.url).pathname;
    const directory = i.sourceDir;
    let failed = false;
    try { i.run(parseDocument('counter = Mutable 600; failing <- load "failing"; use failing')); }
    catch (error) {
        if (error instanceof Error && error.message.includes('missing-tail-target.apn')) failed = true;
        else throw error;
    }
    if (!failed || i.env !== scope || i.sourceDir !== directory || i.stack !== 0) throw new Error('context leaked');
    if (i.renderString(i.run(parseDocument('counter'))) !== '0') throw new Error('effects did not run');
});
Deno.test('checking a file that tail-loads itself terminates', () => {
    const directory = new URL('./fixtures/tail-load/', import.meta.url).pathname;
    // A load reads code, so a file loading itself is checked once.
    new CheckingSession().load('forever', directory);
});
Deno.test('a checked run tail-loads itself', () => {
    const i = new Interpreter();
    i.enableChecking();
    i.sourceDir = new URL('./fixtures/tail-load/', import.meta.url).pathname;
    const flag = new Int32Array(new SharedArrayBuffer(8));
    const log = console.log;
    let lines = 0;
    console.log = () => { if (++lines === 30) Atomics.store(flag, 0, 1); };
    setInterruptFlag(flag);
    try { i.run(parseDocument('forever <- load "forever"; use forever')); throw new Error('finished'); }
    catch (error) { if ((error as Error).message !== 'interrupted') throw error; }
    finally { console.log = log; setInterruptFlag(null); }
    if (lines < 30) throw new Error(`stopped after ${lines} lines`);
});
