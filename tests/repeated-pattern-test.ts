import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
function run(source: string): string {
    const i = new Interpreter();
    return i.renderString(i.run(parseDocument(source)));
}
for (const source of [
    'f x x = x; f 1 1',
    '(x, x -> x) 1 1',
    'f [x,x] = x; f [1,1]',
    'f [a: x, b: x] = x; f [a: 1, b: 1]',
    'f x [x] = x; f 1 [x: 1]',
    '(x -> x -> x) 2 1',
    'x = 2; f x x = x; f 1 1',
    'f _ _ = 1; f 2 3',
    '(_, _ -> 1) 2 3',
]) Deno.test(`repeated patterns accept: ${source}`, () => {
    if (run(source) !== '1') throw new Error(source);
});
for (const source of [
    'f x x = x; f 1 2',
    '(x, x -> x) 1 2',
    'f [x,x] = x; f [1,2]',
    'f [a: x, b: x] = x; f [a: 1, b: 2]',
    'f x [x] = x; f 1 [x: 2]',
]) Deno.test(`repeated patterns reject: ${source}`, () => {
    try { run(source); } catch (e) {
        if (String(e).includes('no clause')) return;
        throw e;
    }
    throw new Error('expected mismatch');
});

for (const checked of [false, true]) {
    for (const [source, expected] of [
        ['x x = x; x x == x', 'True'],
        ['x x = x; alias = x; x alias == x', 'True'],
        ['x x = x; x x x == x', 'True'],
        ['x n x = 42; partial = x 1; partial x', '42'],
        ['x [x] = 42; x [x]', '42'],
        ['x [self: x] = 42; x [self: x]', '42'],
        ['x (x::xs) = 42; x [x]', '42'],
        ['x x = 1; x other = 2; x x', '1'],
        ['x x = 1; x other = 2; x 0', '2'],
        ['x = 10; f x = x; f 1', '1'],
        ['x = x -> x; x 1', '1'],
        ['fact n = n == 0 ? 1 : n * fact (n - 1); fact 5', '120'],
    ]) Deno.test(`definition-name equality (checked=${checked}): ${source}`, () => {
        const i = new Interpreter();
        if (checked) i.enableChecking();
        const actual = i.renderString(i.run(parseDocument(source)));
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
    for (const source of [
        'x x = x; x 1',
        'x x = x; y y = y; x y',
        'x n x = 42; partial = x 1; partial partial',
        'x [x] = 42; x [1]',
    ]) Deno.test(`definition-name mismatch (checked=${checked}): ${source}`, () => {
        const i = new Interpreter();
        if (checked) i.enableChecking();
        try { i.run(parseDocument(source)); } catch (error) {
            if (/no clause|cannot use|must equal the function/.test(String(error))) return;
            throw error;
        }
        throw new Error('Expected equality mismatch');
    });
}
Deno.test('REPL extension keeps self-equality and ordinary clauses distinct', () => {
    const i = new Interpreter();
    i.enableChecking();
   
    i.run(parseDocument('x x = 1'));
    i.run(parseDocument('x other = 2'));
    const actual = i.renderString(i.run(parseDocument('[x x, x 0]')));
    if (actual !== '[1,2]') throw new Error(actual);
});

for (const [definition, call, name] of [
    ['x x = x', 'x 1', 'x'],
    ['x x = x; alias = x', 'alias 1', 'x'],
    ['f first f = f; partial = f 0', 'partial 1', 'f'],
]) Deno.test(`self-name diagnostic: ${call}`, () => {
    const i = new Interpreter();
    i.enableChecking();
    i.run(parseDocument(definition));
    try { i.run(parseDocument(call)); } catch (error) {
        const message = String(error);
        if (!message.includes(`argument '${name}' must equal the function '${name}'; got Int`) || message.includes('mu rec')) {
            throw new Error(message);
        }
        return;
    }
    throw new Error('Expected a type error');
});
