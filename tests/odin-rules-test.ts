import { Interpreter, checkInterrupt, setInterruptFlag } from "../src/interp.ts";
import { parseDocument, parse } from "../src/parser.ts";
import { lint } from "../src/lint.ts";
import { APNError } from "../src/errors.ts";

function result(source: string): string {
    const i = new Interpreter();
    return i.renderString(i.run(parseDocument(source)));
}
for (const [source, expected] of [
    ['UserId = distinct Int\n[UserId, UserId 3, typeOf (UserId 3)]', '[UserId, UserId 3, UserId]'],
    ['Distance = distinct Float\nDistance 2 + Distance 3', 'Distance 5.0'],
    ['Distance = distinct Int\n-Distance 2', 'Distance -2'],
    ['Distance = distinct Int\nDistance 2 < Distance 3', 'true'],
    ['UserId = distinct Int\nf (t x) = [t, x]\nf (UserId 3)', '[UserId, 3]'],
    ['UserId = distinct Int\nAlias = UserId\n[Alias == UserId, Alias 3 == UserId 3]', '[true, true]'],
    ['UserId = distinct Int\nOrderId = distinct Int\n[UserId == OrderId, UserId 3 == OrderId 3, UserId 3 == 3]', '[false, false, false]'],
    ['UserId = distinct Int\nunpack (UserId n) = n\nunpack (UserId 123)', '123'],
    ['UserId = distinct Int\nOrderId = distinct Int\nf (UserId n) = n\nf _ = 0\nf (OrderId 3)', '0'],
    ['UserId = distinct Int\n[v: UserId] []', '[v: UserId 0]'],
    ['v = [x: Int] [y: 2]\nv', '[x: 0, y: 2]'],
    ['Direction = North | South\nv = table Direction [[North, 1], [South, 2]]\nv South', '2'],
    ['Direction = North | South\nv = table Direction [[South, missing], [North, 1]]\nv North', '1'],
    ['Direction = North | South\nmake = table Direction\nv = make [[North, 1], [South, 2]]\nv North', '1'],
    ['assert true', '()'],
    ['import "std/function"\ncount = Mutable 0\nbracket 42 (_ -> set 1 count) (x -> x + 1)\ncount', '1'],
    ['import "std/function"\nbracket 42 (_ -> ()) (x -> [x, x+1])', '[42, 43]'],
    ['import "std/function"\ncount = Mutable 0\nv <- bracket 1 (_ -> set 9 count) (_ -> [count + 1])\n[v, count]', '[[1], 9]'],
]) Deno.test(`Odin-inspired rule: ${source}`, () => {
    const actual = result(source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const [source, error] of [
    ['UserId = distinct Int\nUserId .2', 'lossy conversion'],
    ['UserId = distinct Int\nOrderId = distinct Int\nUserId (OrderId 3)', 'explicit unwrapping'],
    ['Distance = distinct Int\nDistance 2 + 3', 'same distinct type'],
    ['Distance = distinct Int8\nDistance 127 + Distance 1', 'out of range'],
    ['distinct 1', 'expects a type'],
    ['Direction = North | South\ntable Direction [[North, 1]]', 'missing table keys: South'],
    ['Direction = North | South\ntable Direction [[North, 1], [North, 2]]', 'duplicate table key'],
    ['Direction = North | South\nOther = Left | Right\ntable Direction [[Left, 1]]', 'Direction key'],
    ['Direction = North | South\nv = table Direction [[North, 1], [South, 2]]\nv "North"', 'Direction key'],
    ['Option a = Some a | None\ntable Option []', 'nullary constructors'],
    ['assert 1', 'expects Bool'],
    ['assert (1 == 2)', 'assertion failed: (1 == 2)'],
    ['check = assert\ncheck false', 'assertion failed: false'],
    ['import "std/function"\nbracket 1 (_ -> ()) (x -> (y -> x))', 'must return data'],
    ['import "std/function"\nbracket 1 (x y -> ()) (x -> x)', 'release must take one remaining argument'],
    ['import "std/io"\nwithFile "lib/io.apn" 123', 'callback must take one remaining argument'],
]) Deno.test(`Odin-inspired rejection: ${source}`, () => {
    try { result(source); } catch (e) { if (String(e).includes(error)) return; throw e; }
    throw new Error('expected rejection');
});
Deno.test('assert captures its original source file and line', () => {
    const i = new Interpreter();
    try { i.run(parse('x = 1\nassert (x == 2)', 'original.apn')); }
    catch (e) {
        if (!(e instanceof APNError) || !e.message.includes('original.apn:2') || e.src !== 'x = 1\nassert (x == 2)') throw e;
        return;
    }
    throw new Error('expected assertion failure');
});
Deno.test('resource release runs when a lazy result fails', () => {
    const i = new Interpreter();
    i.run(parseDocument('import "std/function"\ncount = Mutable 0'));
    try { i.renderString(i.run(parseDocument('bracket 1 (_ -> set 7 count) (_ -> [missing])'))); } catch { /* expected */ }
    if (i.renderString(i.run(parseDocument('count'))) !== '7') throw new Error('cleanup skipped');
});
Deno.test('withFile evaluates a lazy read before closing', () => {
    const source = 'import "std/io"\nwithFile "lib/io.apn" (f -> [f.read])';
    const actual = result(source);
    if (!actual.includes('readInput')) throw new Error(actual);
});
Deno.test('withFile closes handles even when saved outside the scope', () => {
    const i = new Interpreter();
    i.run(parseDocument('import "std/io"\nsaved = Mutable []\nwithFile "lib/io.apn" (f -> set f saved)'));
    try { i.run(parseDocument('saved.read')); } catch (e) { if (String(e).includes('resource is closed')) return; throw e; }
    throw new Error('escaped live handle');
});
for (const [code, warnings] of [
    ['Option a = Some a | None\nf (Option value) = match value [Some x -> x]', 1],
    ['Option a = Some a | None\nf (Option value) = match value [Some x -> x, None -> 0]', 0],
    ['Option a = Some a | None\nf (Option value) = match value [Some x | x > 0 -> x, None -> 0]', 1],
    ['Option a = Some a | None\nf (Option value) = match value [Some x -> x, _ -> 0]', 0],
    ['Option a = Some a | None\nf (Option value) = match value handlers', 0],
    ['Option a = Some a | None\nf (Option value) = match value [handler]', 0],
    ['Option a = Some a | None\nf (Option value) = (value -> match value [Some x -> x])', 0],
    ['Option a = Some a | None\nf match (Option value) = match value [Some x -> x]', 0],
    ['import "std/option"\nf (Option value) = match value [None -> 0]', 1],
] as const) Deno.test(`exhaustiveness diagnostic: ${code}`, () => {
    const ds = lint(code);
    if (ds.length !== warnings || ds.some(d => d.code !== 'non-exhaustive-match' || d.severity !== 2)) throw new Error(JSON.stringify(ds));
});

Deno.test('bracket releases in reverse order on interruption', () => {
    const i = new Interpreter();
    i.run(parseDocument('import "std/function"; order = Mutable ""'));
    const signal = new Int32Array(new SharedArrayBuffer(8));
    setInterruptFlag(signal);
    i.env.setLocal('interruptNow', { kind: 'native', name: 'interruptNow', arity: 1, applied: [], invoke: () => {
        Atomics.store(signal, 0, 1);
        checkInterrupt();
        return { kind: 'unit' };
    } });
    try {
        i.run(parseDocument('bracket 1 (_ -> set (order ++ "outer") order) (_ -> bracket 2 (_ -> set (order ++ "inner") order) interruptNow)'));
        throw new Error('expected interruption');
    } catch (e) { if (!String(e).includes('interrupted')) throw e; }
    finally { setInterruptFlag(null); }
    if (i.renderString(i.run(parseDocument('order'))) !== '"innerouter"') throw new Error('wrong cleanup order');
});
Deno.test('bracket does not release a resource that failed to acquire', () => {
    const i = new Interpreter();
    i.run(parseDocument('import "std/function"; released = Mutable false'));
    try { i.run(parseDocument('bracket missing (_ -> set true released) (x -> x)')); } catch { /* expected */ }
    if (i.renderString(i.run(parseDocument('released'))) !== 'false') throw new Error('released absent resource');
});
Deno.test('assert reports piped source and evaluates the condition once', () => {
    const i = new Interpreter();
    i.run(parseDocument('counter = Mutable 0'));
    try { i.run(parse('{ counter $ set (counter + 1); false } $ assert', 'pipe.apn')); }
    catch (e) { if (!String(e).includes('pipe.apn:1')) throw e; }
    if (i.renderString(i.run(parseDocument('counter'))) !== '1') throw new Error('repeated condition');
});
