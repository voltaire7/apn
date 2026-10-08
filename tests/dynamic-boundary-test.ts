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
    ['((Int -> Int) f) <- (Dynamic (x -> x + 1)); f 2', '3'],
    ['((Int -> Int) f) <- (x -> x); f (Dynamic 2)', '2'],
    ['Vect 2 Int (Dynamic [1,2])', '[1,2]'],
    ['xs <- Vect 2 Int (Dynamic [1,missing]); head xs', '1'],
    ['xs = 1:xs; scope <- Dynamic env; scope.xs = Dynamic [2..]; head xs', '2'],
    ['Vect 2 Int [Dynamic 1,Dynamic 2]', '[1,2]'],
    ['xs <- Vect 2 Int [1,2]; scope <- Dynamic env; scope.xs = [3,4]; typeOf xs', 'Vect 2 Int'],
    ['x = 1; scope <- Dynamic env; scope.x = 2; x', '2'],
    ['x = 1; scope <- Dynamic env; key = "x"; Int (scope key)', '1'],
    ['scope <- Dynamic env; scope.newName = 42; Int scope.newName', '42'],
    ['x = [name: "old", age: 1]; scope <- Dynamic env; scope.x = [name: "new", age: 2]; x.name', '"new"'],
    ['xs = [1,2]; scope <- Dynamic env; scope.xs = [3,4]; xs', '[3,4]'],
    ['((Int -> Int) f) <- (x -> x); scope <- Dynamic env; scope.f = Dynamic (x -> x + 1); f 1', '2'],
    ['Dynamic (import ["type","function","option","sequence","array","number","text","map","combinator","io","system","search"]); 123', '123'],
    ['Dynamic (import ["text","type"]); 123', '123'],
    ['x = 1; Dynamic $ use [x: 2]; x', '2'],
    ['Option a = Some a | None; x <- Some 1; scope <- Dynamic env; scope.x = None; x', 'None'],
] as const) Deno.test(`explicit Dynamic boundary: ${source}`, () => {
    const result = requireChecked(source);
    if (result.dynamicBoundaries || !result.runtimeChecks) throw new Error(JSON.stringify(result));
    const actual = run(source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});

for (const source of [
    'x = env',
    'x = Dynamic 1; missing',
    'f x = x == 0 ? 1 : x * x; f (Dynamic 2)',
    'x = 1; x = Dynamic "bad"',
    'f (Dynamic x) = missing x',
    'Option a = Some a | None; f (Some x) = x == 0 ? 0 : x * x; f (Dynamic (Some "bad"))',
]) Deno.test(`Dynamic does not silence unrelated static checks: ${source}`, () => {
    if (!checkSource(source, '<test>', { strict: true }).issues.length) throw new Error('unexpectedly checked');
});

for (const [source, message] of [
    ['Int (Dynamic "bad")', 'Int expects a number'],
    ['((Int -> Int) f) <- (x -> x); f (Dynamic "bad")', 'Int expects a number'],
    ['((Int -> Int) f) <- (Dynamic (x -> "bad")); f 1', 'Int expects a number'],
    ['Vect 2 Int (Dynamic [1])', 'length mismatch'],
    ['Vect 2 Int (Dynamic [1,"bad"])', 'Int expects a number'],
    ['x = "old"; scope <- Dynamic env; scope.x = 123; x', 'cannot replace string with int'],
    ['x = true; scope <- Dynamic env; scope.x = "bad"; x', 'cannot replace bool with string'],
    ['x = [name: "old"]; scope <- Dynamic env; scope.x = [name: 2]; x.name', 'cannot replace string with int'],
    ['x = [name: "old"]; scope <- Dynamic env; scope.x.name = 2; x.name', 'cannot replace string with int'],
    ['xs = [1,2]; scope <- Dynamic env; scope.xs = [3]; xs', 'list length changed'],
    ['xs = ["old"]; scope <- Dynamic env; scope.xs = [123]; xs', 'cannot replace string with int'],
    ['f x = x; scope <- Dynamic env; scope.f = Dynamic (x -> "bad")', 'explicit function contract'],
    ['((Int -> Int) f) <- (x -> x); scope <- Dynamic env; scope.f = Dynamic (x -> "bad"); f 1', 'Int expects a number'],
    ['x = "old"; Dynamic (use [x: 123]); x', 'cannot replace string with int'],
    ['scope <- Dynamic env; scope.Int = String', 'cannot change an established type descriptor'],
    ['Option a = Some a | None; x <- Some 1; scope <- Dynamic env; scope.x = Some "bad"; x', 'cannot convert String to Int'],
]) Deno.test(`Dynamic runtime boundary rejects: ${source}`, () => {
    requireChecked(source);
    try { run(source); } catch (error) {
        if (String(error).includes(message)) return;
        throw error;
    }
    throw new Error('missing runtime error');
});

Deno.test('reflected batch writes validate before publishing scalar changes', () => {
    const source = 'a = 1; b = "old"; scope <- Dynamic env; scope.[a,b] = [2,123]';
    requireChecked(source);
    const i = new Interpreter(); i.checkedExecution = true;
    try { i.run(parseDocument(source)); } catch (error) {
        if (!String(error).includes('cannot replace string with int')) throw error;
        if (i.renderString(i.run(parseDocument('[a,b]'))) !== '[1,"old"]') throw new Error('partial write');
        return;
    }
    throw new Error('missing runtime error');
});

Deno.test('Dynamic construction and patterns preserve Mutable identity', () => {
    const actual = run('x <- Mutable 1; f (Dynamic v) = v; d <- Dynamic x; alias <- f d; set alias 2; x', false);
    if (actual !== '2') throw new Error(actual);
});

Deno.test('Dynamic environment guards also work in ordinary execution', () => {
    try { run('x = "old"; scope <- Dynamic env; scope.x = 1', false); } catch (error) {
        if (String(error).includes('cannot replace string with int')) return;
        throw error;
    }
    throw new Error('missing runtime error');
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
        i.moduleSources = { function: 'x = 123', type: '' };
        try { i.run(parseDocument(source)); } catch (error) {
            if (!String(error).includes('cannot replace string with int')) throw error;
            if (i.renderString(i.run(parseDocument('x'))) !== '"old"') throw new Error('binding changed');
            return;
        }
        throw new Error('missing runtime error');
    });
}
Deno.test('guarding an action does not execute it to discover its result type', () => {
    const i = new Interpreter(); i.checkedExecution = true;
    i.run(parseDocument('action = { fail "must not run" }; scope <- Dynamic env'));
    try { i.run(parseDocument('scope.action = 1')); } catch (error) {
        if (String(error).includes('explicit function contract')) return;
        throw error;
    }
    throw new Error('missing runtime error');
});
Deno.test("set on an explicit Dynamic target is checked at runtime", () => {
    const value = run("cell = Dynamic (Mutable 1); set cell 2; Int (Dynamic cell) + 1");
    if (value !== "3") throw new Error(`expected 3, got ${value}`);
});
