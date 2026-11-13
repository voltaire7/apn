import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
import { requireChecked, checkSource } from "../src/type-checker.ts";

function run(source: string, checked = true): string {
    if (checked) requireChecked(source);
    const i = new Interpreter();
    i.checkedExecution = checked;
    return i.renderString(i.run(parseDocument(source)));
}
for (const [source, expected] of [
    ['x = 123 : Dynamic; (x : Int) + 1', '124'],
    ['D = Dynamic; x = 123 : D; (x : Int)', '123'],
    ['f (x : Dynamic) = x x; (f (y -> 42) : Int)', '42'],
    ['f (x : Int) = x + 1; f (2 : Dynamic)', '3'],
    ['cast Int (42 : Dynamic)', '42'],
    ['(f : Int -> Int) <- return (x -> x + 1 : Dynamic); f 2', '3'],
    ['(f : Int -> Int) <- return (x -> x); f (2 : Dynamic)', '2'],
    ['(([1,2] : Dynamic) : Vect 2 Int)', '[1,2]'],
    ['xs <- return (([1,missing] : Dynamic) : Vect 2 Int); head xs', '1'],
    ['([(1 : Dynamic), (2 : Dynamic)] : Vect 2 Int)', '[1,2]'],
    ['(import "std/function" : Dynamic); 123', '123'],
    ['m <- (import "std/text" : Dynamic); use m; 123', '123'],
    ['x = 1; (use [x = 2] : Dynamic); x', '2'],
] as const) Deno.test(`explicit Dynamic boundary: ${source}`, () => {
    const result = requireChecked(source);
    if (result.dynamicBoundaries || !result.runtimeChecks) throw new Error(JSON.stringify(result));
    const actual = run(source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});

for (const source of [
    'x = 1 : Dynamic; missing',
    'f x = x == 0 ? 1 : x * x; f (2 : Dynamic)',
    'f (x : Dynamic) = missing x',
    'Option a = Some a | None; f (Some x) = x == 0 ? 0 : x * x; f (Some "bad" : Dynamic)',
]) Deno.test(`Dynamic does not silence unrelated static checks: ${source}`, () => {
    if (!checkSource(source, '<test>', { strict: true }).issues.length) throw new Error('unexpectedly checked');
});

for (const [source, message] of [
    ['(("bad" : Dynamic) : Int)', 'Int expects a number'],
    ['(f : Int -> Int) <- return (x -> x); f ("bad" : Dynamic)', 'Int expects a number'],
    ['(f : Int -> Int) <- return (x -> "bad" : Dynamic); f 1', 'Int expects a number'],
    ['(([1] : Dynamic) : Vect 2 Int)', 'length mismatch'],
    ['(([1,"bad"] : Dynamic) : Vect 2 Int)', 'Int expects a number'],
    ['x = "old"; (use [x = 123] : Dynamic); x', 'cannot replace string with int'],
]) Deno.test(`Dynamic runtime boundary rejects: ${source}`, () => {
    requireChecked(source);
    try { run(source); } catch (error) {
        if (String(error).includes(message)) return;
        throw error;
    }
    throw new Error('missing runtime error');
});

Deno.test('Dynamic construction and patterns preserve Mutable identity', () => {
    const actual = run('x <- return (Mutable 1)\nf (v : Dynamic) = v\nd <- return (x : Dynamic)\nalias <- return (f d)\nset alias 2\nx', false);
    if (actual !== '2') throw new Error(actual);
});

Deno.test('load exports cannot invalidate checked bindings', () => {
    const source = 'x = "old"; m <- (load "dynamic-overwrite" : Dynamic); use m; x';
    requireChecked(source);
    const i = new Interpreter(); i.checkedExecution = true;
    i.sourceDir = new URL('./fixtures/', import.meta.url).pathname;
    try { i.run(parseDocument(source)); } catch (error) {
        if (String(error).includes('cannot replace string with int')) return;
        throw error;
    }
    throw new Error('missing runtime error');
});

for (const module of ['"std/function"']) {
    Deno.test(`use protects existing bindings: ${module}`, () => {
        const source = `x = "old"; m <- (import ${module} : Dynamic); use m; x`;
        requireChecked(source);
        const i = new Interpreter(); i.checkedExecution = true;
        i.moduleSources = { "/lib/function.apn": 'x = 123', "/lib/type.apn": '' };
        i.sourceDir = "/app/";
        try { i.run(parseDocument(source)); } catch (error) {
            if (!String(error).includes('cannot replace string with int')) throw error;
            if (i.renderString(i.run(parseDocument('x'))) !== '"old"') throw new Error('binding changed');
            return;
        }
        throw new Error('missing runtime error');
    });
}
// An import the static check follows typed what it replaces: random's step
// takes the place of the debugger's.
Deno.test("a checked import replaces a builtin function", () => {
    const i = new Interpreter();
    i.enableChecking();
    const actual = i.renderString(i.run(parseDocument('std <- import "std"; use std.random\nstep (MkGenerator (s -> [1,s])) 0')));
    if (actual !== "[1,0]") throw new Error(actual);
});
Deno.test("set on an explicit Dynamic target is checked at runtime", () => {
    const value = run("cell = Mutable 1 : Dynamic; set cell 2; ((cell : Dynamic) : Int) + 1");
    if (value !== "3") throw new Error(`expected 3, got ${value}`);
});

Deno.test('loading a file again replaces its definitions', () => {
    const fixtures = new URL('./fixtures/', import.meta.url).pathname;
    const i = new Interpreter(); i.enableChecking(); i.sourceDir = fixtures;
    i.run(parseDocument('h <- load "reload"\nfirst = h.double 1\nsecond = h.double h.limit'));
    if (i.renderString(i.run(parseDocument('[first,second]'))) !== '[2,20]') throw new Error('reload');
    // A checked load's names replace a name rebound in between, as a definition would.
    const j = new Interpreter(); j.enableChecking(); j.sourceDir = fixtures;
    j.run(parseDocument('r <- load "reload"\nuse r\ndouble n = n + 1\nagain <- load "reload"\nuse again'));
    if (j.renderString(j.run(parseDocument('double 5'))) !== '10') throw new Error('rebound reload');
    // An unchecked (Dynamic) load still cannot replace it.
    const k = new Interpreter(); k.enableChecking(); k.sourceDir = fixtures;
    try { k.run(parseDocument('r <- load "reload"\nuse r\ndouble n = n + 1\nagain <- (load "reload" : Dynamic)\nuse again')); } catch (error) {
        if (String(error).includes("Dynamic write to 'double'")) return;
        throw error;
    }
    throw new Error('a Dynamic reload replaced a rebound function');
});
