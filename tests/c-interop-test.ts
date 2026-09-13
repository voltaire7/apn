import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

const library = Deno.args[0];
const signatures = `[
    add: ffi.function [Int32, Int32] Int32,
    echo_u64: ffi.function [UInt64] UInt64,
    half: ffi.function [Float] Float,
    half_f32: ffi.function [Float32] Float32,
    invert: ffi.function [Bool] Bool,
    answer: ffi.function [] Int32,
    text_length: ffi.function [String] Int32,
    greeting: ffi.function [] String,
    increment: ffi.function [Pointer] Unit,
    echo_pointer: ffi.function [Pointer] Pointer,
    cell_pointer: ffi.function [] Pointer,
    cell_value: ffi.function [] Int32,
    null_pointer: ffi.function [] Pointer
]`;
function run(source: string): string {
    const interpreter = new Interpreter();
    return interpreter.renderString(interpreter.run(parseDocument('ffi = import "std/ffi"\n' + source)));
}
function call(body: string): string {
    return `ffi.withLibrary ${JSON.stringify(library)} ${signatures} c -> {\n${body.split('\n').map((s) => '    ' + s).join('\n')}\n}`;
}
for (const [name, body, expected] of [
    ['signed integers', 'c.add 12 30', 'Int32 42'],
    ['partial application', 'addTen = c.add 10\naddTen 32', 'Int32 42'],
    ['uint64 stays exact', 'c.echo_u64 18446744073709551615', 'UInt64 18446744073709551615'],
    ['float64', 'c.half 5', 'Float 2.5'],
    ['float32', 'c.half_f32 .5', 'Float32 0.25'],
    ['booleans', 'c.invert true', 'false'],
    ['no C arguments', 'c.answer ()', 'Int32 42'],
    ['UTF8 input', 'c.text_length "hé😀"', 'Int32 7'],
    ['UTF8 result', 'c.greeting ()', '"hello from C"'],
    ['null pointer', 'isType Pointer (c.null_pointer ())', 'true'],
    ['managed pointer mutation', 'p = ffi.allocate Int32 1\np $ set 41\nc.increment p\nffi.peek Int32 p', 'Int32 42'],
    ['byte offset', 'p = ffi.allocate Int32 2\nffi.poke Int32 9 (ffi.offset 4 p)\nffi.peek Int32 (ffi.offset 4 p)', 'Int32 9'],
    ['pointer identity through C', 'p = ffi.allocate Int32 1\nc.echo_pointer p == p', 'true'],
    ['external C memory writes', 'p = c.cell_pointer ()\nffi.poke Int32 42 p\nc.cell_value ()', 'Int32 42'],
    ['pointer keeps argument alive', 'p = c.echo_pointer (ffi.allocate Int32 1)\nc.increment p\nffi.peek Int32 p', 'Int32 1'],
] as const) {
    Deno.test({ name: `C interop: ${name}`, ignore: !library, fn() {
        const actual = run(call(body));
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    } });
}
for (const [body, error] of [
    ['c.add 2147483648 0', 'Int32'],
    ['c.add 1.5 0', 'lossy conversion'],
    ['c.half_f32 .1', 'lossy conversion'],
    ['c.invert 1', 'Bool argument expected'],
    ['c.text_length "a\u0000b"', 'embedded NUL'],
    ['c.answer 1', 'takes ()'],
    ['ffi.peek Int32 (c.null_pointer ())', 'null pointer'],
    ['p = ffi.allocate Int32 1\nffi.peek Int64 p', 'exceeds allocated memory'],
    ['p = c.echo_pointer (ffi.allocate Int32 1)\nffi.peek Int64 p', 'exceeds allocated memory'],
    ['p = ffi.allocate Int32 1\nffi.offset 5 p', 'exceeds allocated memory'],
] as const) {
    Deno.test({ name: `C interop rejects ${body}`, ignore: !library, fn() {
        try { run(call(body)); } catch (e) { if (String(e).includes(error)) return; throw e; }
        throw new Error(`Expected ${error}`);
    } });
}
Deno.test({ name: 'escaped C functions cannot call unloaded code', ignore: !library, fn() {
    try { run(`escaped = ${call('c.answer')}\nescaped ()`); }
    catch (e) { if (String(e).includes('library is closed')) return; throw e; }
    throw new Error('Expected closed-library error');
} });
Deno.test({ name: 'escaped C pointers cannot access unloaded storage', ignore: !library, fn() {
    try { run(`escaped = ${call('c.null_pointer ()')}\nffi.peek Int32 escaped`); }
    catch (e) { if (String(e).includes('closed library')) return; throw e; }
    throw new Error('Expected closed-library error');
} });
Deno.test('C interop rejects ambiguous Int ABI before loading a library', () => {
    try { run('ffi.withLibrary "missing" [f: ffi.function [Int] Unit] (c -> ())'); }
    catch (e) { if (String(e).includes('fixed-width')) return; throw e; }
    throw new Error('Expected a fixed-width ABI error');
});
