import { Interpreter, checkInterrupt, setInterruptFlag } from "../src/interp.ts";
import { parseDocument, parse } from "../src/parser.ts";
import { lint } from "../src/lint.ts";
import { APNError } from "../src/errors.ts";

function result(source: string): string {
    const i = new Interpreter();
    return i.renderString(i.run(parseDocument(source)));
}
for (const [source, expected] of [
    ['UserId = | MkUserId Int\n[UserId, MkUserId 3, typeOf (MkUserId 3)]', '[UserId, MkUserId 3, UserId]'],
    // A new type has only the operations its clauses define.
    ['Distance = | MkDistance Float\nMkDistance a + MkDistance b = MkDistance (a + b)\nMkDistance 2 + MkDistance 3', 'MkDistance 5.0'],
    ['UserId = | MkUserId Int\nf (x : t) = [t,x]\nf (MkUserId 3)', '[UserId, MkUserId 3]'],
    ['UserId = | MkUserId Int\nAlias = MkUserId\n[Alias == MkUserId, Alias 3 == MkUserId 3]', '[True,True]'],
    ['UserId = | MkUserId Int\nOrderId = | MkOrderId Int\n[UserId == OrderId, MkUserId 3 == MkOrderId 3, MkUserId 3 == 3]', '[False,False,False]'],
    ['Money = | MkMoney Float\nf (x : Float) = "Float"\nf (MkMoney x) = "Money"\n[f 1.2, f (MkMoney 1.2)]', '["Float","Money"]'],
    ['UserId = | MkUserId Int\nunpack (MkUserId n) = n\nunpack (MkUserId 123)', '123'],
    ['UserId = | MkUserId Int\nOrderId = | MkOrderId Int\nf (MkUserId n) = n\nf _ = 0\nf (MkOrderId 3)', '0'],
    ['UserId = | MkUserId Int\n([] : [v : UserId])', '[v = MkUserId 0]'],
    ['v = [y = 2] : [x : Int]\nv', '[x = 0, y = 2]'],
    ['assert True "kept"', '"kept"'],
    ['std <- import "std"; use std.function\ncount = Mutable 0\nbracket 42 (_ -> set count 1) (x -> x + 1)\ncount', '1'],
    ['std <- import "std"; use std.function\nbracket 42 (_ -> []) (x -> [x,x+1])', '[42,43]'],
    ['std <- import "std"; use std.function\ncount = Mutable 0\nv <- bracket 1 (_ -> set count 9) (_ -> [count + 1])\n[v,count]', '[[1],9]'],
]) Deno.test(`Odin-inspired rule: ${source}`, () => {
    const actual = result(source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const [source, error] of [
    ['UserId = | MkUserId Int\nMkUserId .2', 'lossy conversion'],
    ['UserId = | MkUserId Int\nOrderId = | MkOrderId Int\nMkUserId (MkOrderId 3)', 'Int expects a number'],
    ['Money = | MkMoney Float\nDistance = | MkDistance Float\nMkMoney 1 + MkDistance 2', "cannot apply '+'"],
    ['Distance = | MkDistance Int\nMkDistance 2 + 3', "cannot apply '+'"],
    ['Distance = | MkDistance Int\n-MkDistance 2', 'negation expects numbers'],
    ['Distance = | MkDistance Int\nMkDistance 2 < MkDistance 3', 'cannot compare'],
    ['Money = | MkMoney Float\nsqrt (MkMoney 4.0)', 'sqrt expects numbers'],
    ['Distance = | MkDistance Int8\nMkDistance 128', 'out of range'],
    ['assert (1 == 2) 0', 'assertion failed: (1 == 2)'],
    ['check = assert\ncheck False 0', 'assertion failed: False'],
    ['std <- import "std"; use std.function\nbracket 1 (_ -> []) (x -> y -> x)', 'must return data'],
    ['std <- import "std"; use std.function\nbracket 1 (x, y -> []) (x -> x)', 'release must take one remaining argument'],
    ['std <- import "std"; use std.io\nwithFile "lib/std/io.apn" 123', 'callback must take one remaining argument'],
]) Deno.test(`Odin-inspired rejection: ${source}`, () => {
    try { result(source); } catch (e) { if (String(e).includes(error)) return; throw e; }
    throw new Error('expected rejection');
});
Deno.test('assert captures its original source file and line', () => {
    const i = new Interpreter();
    try { i.run(parse('x = 1\nassert (x == 2) []', 'original.apn')); }
    catch (e) {
        if (!(e instanceof APNError) || !e.message.includes('original.apn:2') || e.src !== 'x = 1\nassert (x == 2) []') throw e;
        return;
    }
    throw new Error('expected assertion failure');
});
Deno.test('resource release runs when a lazy result fails', () => {
    const i = new Interpreter();
    i.run(parseDocument('std <- import "std"; use std.function\ncount = Mutable 0'));
    try { i.renderString(i.run(parseDocument('bracket 1 (_ -> set count 7) (_ -> [missing])'))); } catch { /* expected */ }
    if (i.renderString(i.run(parseDocument('count'))) !== '7') throw new Error('cleanup skipped');
});
Deno.test('withFile evaluates a lazy read before closing', () => {
    const source = 'std <- import "std"; use std.io\nwithFile "lib/std/io.apn" (f -> f.read)';
    const actual = result(source);
    if (!actual.includes('readInput')) throw new Error(actual);
});
Deno.test('withFile closes handles even when saved outside the scope', () => {
    const i = new Interpreter();
    i.run(parseDocument('std <- import "std"; use std.io\nsaved = Mutable []\nwithFile "lib/std/io.apn" (f -> set saved f)'));
    try { i.run(parseDocument('saved.read')); } catch (e) { if (String(e).includes('resource is closed')) return; throw e; }
    throw new Error('escaped live handle');
});
for (const [code, warnings] of [
    ['Option a = Some a | None\nf (value : Option _) = value ~ [Some x -> x]', 1],
    ['Option a = Some a | None\nf (value : Option _) = value ~ [Some x -> x, None -> 0]', 0],
    ['Option a = Some a | None\nf (value : Option _) = value ~ [Some x | x > 0 -> x, None -> 0]', 1],
    ['Option a = Some a | None\nf (value : Option _) = value ~ [Some x -> x, _ -> 0]', 0],
    ['Option a = Some a | None\nf (value : Option _) = value ~ handlers', 0],
    ['Option a = Some a | None\nf (value : Option _) = value ~ [handler]', 0],
    ['Option a = Some a | None\nf (value : Option _) = value -> value ~ [Some x -> x]', 0],
    ['Option a = Some a | None\nf (value : Option _) = {\n    x ~ alternatives = 0\n    value ~ [Some x -> x]\n}', 0],
    ['std <- import "std"; use std.option\nf (value : Option _) = value ~ [None -> 0]', 1],
] as const) Deno.test(`exhaustiveness diagnostic: ${code}`, () => {
    const ds = lint(code).filter(d => d.code !== 'unused');
    if (ds.length !== warnings || ds.some(d => d.code !== 'non-exhaustive-match' || d.severity !== 2)) throw new Error(JSON.stringify(ds));
});

Deno.test('bracket releases in reverse order on interruption', () => {
    const i = new Interpreter();
    i.run(parseDocument('std <- import "std"; use std.function; order = Mutable ""'));
    const signal = new Int32Array(new SharedArrayBuffer(8));
    setInterruptFlag(signal);
    i.env.setLocal('interruptNow', { kind: 'native', name: 'interruptNow', arity: 1, applied: [], invoke: () => {
        Atomics.store(signal, 0, 1);
        checkInterrupt();
        return { kind: 'list', v: [] };
    } });
    try {
        i.run(parseDocument('bracket 1 (_ -> set order (order ++ "outer"))\n    (_ -> bracket 2 (_ -> set order (order ++ "inner")) interruptNow)'));
        throw new Error('expected interruption');
    } catch (e) { if (!String(e).includes('interrupted')) throw e; }
    finally { setInterruptFlag(null); }
    if (i.renderString(i.run(parseDocument('order'))) !== '"innerouter"') throw new Error('wrong cleanup order');
});
Deno.test('bracket does not release a resource that failed to acquire', () => {
    const i = new Interpreter();
    i.run(parseDocument('std <- import "std"; use std.function; released = Mutable False'));
    try { i.run(parseDocument('bracket missing (_ -> set released True) (x -> x)')); } catch { /* expected */ }
    if (i.renderString(i.run(parseDocument('released'))) !== 'False') throw new Error('released absent resource');
});
Deno.test('assert reports its source with a piped value', () => {
    const i = new Interpreter();
    i.run(parseDocument('counter = Mutable 0'));
    try { i.run(parse('assert (counter == 1) $ []', 'pipe.apn')); throw new Error('accepted'); }
    catch (e) { if (!String(e).includes('pipe.apn:1')) throw e; }
});

Deno.test("assert accepts a truthy number", () => {
    if (result("assert 1 2") !== "2") throw new Error("expected 2");
});
