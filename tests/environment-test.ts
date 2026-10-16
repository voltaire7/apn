import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
function result(source: string): string {
    const i = new Interpreter();
    return i.renderString(i.run(parseDocument(source)));
}
for (const [source, expected] of [
    ['x = 1; e <- env; e.x', '1'],
    ['x = 1; e <- env; e "x"', '1'],
    ['x = 1; e <- env; e.x = 2; x', '2'],
    ['x = 1; e <- env; e "x" = 2; x', '2'],
    ['x = 1; key = "x"; e <- env; e (key) = 2; x', '2'],
    ['e <- env; e.newName = 42; newName', '42'],
    ['scope <- env; x = 1; scope.x', '1'],
    ['x = 1; scope <- env; x = 2; scope.x', '2'],
    ['x = 1; scope <- env; other <- return (scope); other.x = 3; [x, scope.x]', '[3, 3]'],
    ['x = 1; { e <- env; e.x = 2; return [] }; x', '2'],
    ['x = 1; inner <- { x = 3; e <- env; e.x = 4; return x }; [inner, x]', '[4, 1]'],
    ['make x = env; scope <- make 42; scope.x', '42'],
    ['make x = env; scope <- make 42; scope.x = 7; scope.x', '7'],
    ['make x = { get ignored = x; env }; scope <- make 42; scope.x = 7; scope.get []', '7'],
    ['scope <- { local = 42; env }; scope.local', '42'],
    ['a = 1; b = 2; e <- env; e.[a, b] = e.[b, a]; [a, b]', '[2, 1]'],
    ['x = 1; e <- env; e.[x]', '[1]'],
    ['scope <- env; again <- env; [scope == again, typeOf scope]', '[true, Record]'],
    ['e <- env; e.head [42]', '42'],
    ['scope <- env; { local = 42; e <- env; return e.local }; again <- env; scope == again', 'true'],
] as const) Deno.test(`live environment: ${source}`, () => {
    const actual = result(source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
Deno.test('env is an action: its fields need <- return (first)', () => {
    try { result('x = 1; env.x'); } catch (e) { if (String(e).includes('an action has no fields')) return; throw e; }
    throw new Error('expected failure');
});
Deno.test('environment conversions fail atomically', () => {
    const i = new Interpreter();
    i.run(parseDocument('a = 1; b = 2'));
    try { i.run(parseDocument('e <- env; e.[a, b] = [3, 1.5]')); } catch (e) {
        if (!String(e).includes('lossy conversion')) throw e;
        if (i.renderString(i.run(parseDocument('[a, b]'))) !== '[1, 2]') throw new Error('partial write');
        return;
    }
    throw new Error('expected failure');
});
Deno.test('environment validates new binding names', () => {
    try { result('e <- env; e "bad-name" = 1'); } catch (e) {
        if (String(e).includes('invalid binding name')) return;
        throw e;
    }
    throw new Error('expected failure');
});
Deno.test('resource scopes reject escaping environment references', () => {
    try { result('import "function"; bracket 1 (_ -> []) (_ -> env)'); } catch (e) {
        if (String(e).includes('must return data')) return;
        throw e;
    }
    throw new Error('expected failure');
});

Deno.test('environment renders its bindings without invoking actions', () => {
    const i = new Interpreter();
    i.run(parseDocument('x = 42; action = { missing }; scope <- env'));
    const printed = i.renderString(i.run(parseDocument('env')));
    if (!printed.startsWith('[') || !printed.includes('x: 42') || !printed.includes('scope: env') || printed.includes('<environment>')) throw new Error(printed);
});
