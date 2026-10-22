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
    ['x = Dynamic 123; Int x + 1', '124'],
    ['D = Dynamic; x = D 123; Int x', '123'],
    ['f (Dynamic x) = x x; Int (f (y -> 42))', '42'],
    ['f (Int x) = x + 1; f (Dynamic 2)', '3'],
    ['cast Int (Dynamic 42)', '42'],
    ['((Int -> Int) f) <- return ((Dynamic (x -> x + 1))); f 2', '3'],
    ['((Int -> Int) f) <- return ((x -> x)); f (Dynamic 2)', '2'],
    ['Vect 2 Int (Dynamic [1,2])', '[1,2]'],
    ['xs <- return (Vect 2 Int (Dynamic [1,missing])); head xs', '1'],
    ['Vect 2 Int [Dynamic 1, Dynamic 2]', '[1,2]'],
    ['Dynamic (import "function"); 123', '123'],
    ['Dynamic (import ["text","type"]); 123', '123'],
    ['x = 1; Dynamic $ use [x: 2]; x', '2'],
] as const) Deno.test(`explicit Dynamic boundary: ${source}`, () => {
    const result = requireChecked(source);
    if (result.dynamicBoundaries || !result.runtimeChecks) throw new Error(JSON.stringify(result));
    const actual = run(source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});

for (const source of [
    'x = Dynamic 1; missing',
    'f x = x == 0 ? 1 : x * x; f (Dynamic 2)',
    'f (Dynamic x) = missing x',
    'Option a = Some a | None; f (Some x) = x == 0 ? 0 : x * x; f (Dynamic (Some "bad"))',
]) Deno.test(`Dynamic does not silence unrelated static checks: ${source}`, () => {
    if (!checkSource(source, '<test>', { strict: true }).issues.length) throw new Error('unexpectedly checked');
});

for (const [source, message] of [
    ['Int (Dynamic "bad")', 'Int expects a number'],
    ['((Int -> Int) f) <- return ((x -> x)); f (Dynamic "bad")', 'Int expects a number'],
    ['((Int -> Int) f) <- return (Dynamic (x -> "bad")); f 1', 'Int expects a number'],
    ['Vect 2 Int (Dynamic [1])', 'length mismatch'],
    ['Vect 2 Int (Dynamic [1,"bad"])', 'Int expects a number'],
    ['x = "old"; Dynamic (use [x: 123]); x', 'cannot replace string with int'],
]) Deno.test(`Dynamic runtime boundary rejects: ${source}`, () => {
    requireChecked(source);
    try { run(source); } catch (error) {
        if (String(error).includes(message)) return;
        throw error;
    }
    throw new Error('missing runtime error');
});

Deno.test('Dynamic construction and patterns preserve Mutable identity', () => {
    const actual = run('x <- return (Mutable 1)\nf (Dynamic v) = v\nd <- return (Dynamic x)\nalias <- return (f d)\nset alias 2\nx', false);
    if (actual !== '2') throw new Error(actual);
});

Deno.test('load exports cannot invalidate checked bindings', () => {
    const source = 'x = "old"; Dynamic (load "dynamic-overwrite"); x';
    requireChecked(source);
    const i = new Interpreter(); i.checkedExecution = true;
    i.sourceDir = new URL('./fixtures/', import.meta.url).pathname;
    try { i.run(parseDocument(source)); } catch (error) {
        if (String(error).includes('cannot replace string with int')) return;
        throw error;
    }
    throw new Error('missing runtime error');
});

for (const module of ['"function"', '["type","function"]']) {
    Deno.test(`import protects existing bindings: ${module}`, () => {
        const source = `x = "old"; Dynamic (import ${module}); x`;
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
Deno.test("set on an explicit Dynamic target is checked at runtime", () => {
    const value = run("cell = Dynamic (Mutable 1); set cell 2; Int (Dynamic cell) + 1");
    if (value !== "3") throw new Error(`expected 3, got ${value}`);
});

Deno.test('loading a file again replaces its definitions', () => {
    const fixtures = new URL('./fixtures/', import.meta.url).pathname;
    const i = new Interpreter(); i.enableChecking(); i.sourceDir = fixtures;
    // Each use of h runs the load again; it replaces only what it published.
    i.run(parseDocument('h = load "reload"\nfirst = h.double 1\nsecond = h.double h.limit'));
    if (i.renderString(i.run(parseDocument('[first,second]'))) !== '[2,20]') throw new Error('reload');
    // A checked load replaces a name rebound in between, as a definition would.
    const j = new Interpreter(); j.enableChecking(); j.sourceDir = fixtures;
    j.run(parseDocument('load "reload"\ndouble n = n + 1\nload "reload"'));
    if (j.renderString(j.run(parseDocument('double 5'))) !== '10') throw new Error('rebound reload');
    // An unchecked (Dynamic) load still cannot replace it.
    const k = new Interpreter(); k.enableChecking(); k.sourceDir = fixtures;
    try { k.run(parseDocument('load "reload"\ndouble n = n + 1\nDynamic $ load "reload"')); } catch (error) {
        if (String(error).includes("Dynamic write to 'double'")) return;
        throw error;
    }
    throw new Error('a Dynamic reload replaced a rebound function');
});
