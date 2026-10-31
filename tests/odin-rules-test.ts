import { Interpreter, checkInterrupt, setInterruptFlag } from "../src/interp.ts";
import { parseDocument, parse } from "../src/parser.ts";
import { lint } from "../src/lint.ts";
import { APNError } from "../src/errors.ts";

function result(source: string): string {
    const i = new Interpreter();
    return i.renderString(i.run(parseDocument(source)));
}
for (const [source, expected] of [
    ['UserId (Int x) = _\n[UserId, UserId 3, typeOf (UserId 3)]', '[UserId, UserId 3, UserId]'],
    // A new type has only the operations its clauses define.
    ['Distance (Float x) = _\n(Distance a) + (Distance b) = Distance (a + b)\nDistance 2 + Distance 3', 'Distance 5.0'],
    ['UserId (Int x) = _\nf (t x) = [t,x]\nf (UserId 3)', '[UserId, UserId 3]'],
    ['UserId (Int x) = _\nAlias = UserId\n[Alias == UserId, Alias 3 == UserId 3]', '[True,True]'],
    ['UserId (Int x) = _\nOrderId (Int x) = _\n[UserId == OrderId, UserId 3 == OrderId 3, UserId 3 == 3]', '[False,False,False]'],
    ['Money (Float x) = _\nf (Float x) = "Float"\nf (Money x) = "Money"\n[f 1.2, f (Money 1.2)]', '["Float","Money"]'],
    ['UserId (Int x) = _\nunpack (UserId n) = n\nunpack (UserId 123)', '123'],
    ['UserId (Int x) = _\nOrderId (Int x) = _\nf (UserId n) = n\nf _ = 0\nf (OrderId 3)', '0'],
    ['UserId (Int x) = _\n[v: UserId] []', '[v: UserId 0]'],
    ['v = [x: Int] [y: 2]\nv', '[x: 0, y: 2]'],
    ['assert True "kept"', '"kept"'],
    ['import "function"\ncount = Mutable 0\nbracket 42 (_ -> set count 1) (x -> x + 1)\ncount', '1'],
    ['import "function"\nbracket 42 (_ -> []) (x -> [x,x+1])', '[42,43]'],
    ['import "function"\ncount = Mutable 0\nv <- bracket 1 (_ -> set count 9) (_ -> [count + 1])\n[v,count]', '[[1],9]'],
]) Deno.test(`Odin-inspired rule: ${source}`, () => {
    const actual = result(source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const [source, error] of [
    ['UserId (Int x) = _\nUserId .2', 'lossy conversion'],
    ['UserId (Int x) = _\nOrderId (Int x) = _\nUserId (OrderId 3)', 'Int expects a number'],
    ['Money (Float x) = _\nDistance (Float x) = _\nMoney 1 + Distance 2', "cannot apply '+'"],
    ['Distance (Int x) = _\nDistance 2 + 3', "cannot apply '+'"],
    ['Distance (Int x) = _\n-Distance 2', 'negation expects numbers'],
    ['Distance (Int x) = _\nDistance 2 < Distance 3', 'cannot compare'],
    ['Money (Float x) = _\nsqrt (Money 4.0)', 'sqrt expects numbers'],
    ['Distance (Int8 x) = _\nDistance 128', 'out of range'],
    ['assert (1 == 2) 0', 'assertion failed: (1 == 2)'],
    ['check = assert\ncheck False 0', 'assertion failed: False'],
    ['import "function"\nbracket 1 (_ -> []) (x -> y -> x)', 'must return data'],
    ['import "function"\nbracket 1 (x, y -> []) (x -> x)', 'release must take one remaining argument'],
    ['import "io"\nwithFile "lib/io.apn" 123', 'callback must take one remaining argument'],
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
    i.run(parseDocument('import "function"\ncount = Mutable 0'));
    try { i.renderString(i.run(parseDocument('bracket 1 (_ -> set count 7) (_ -> [missing])'))); } catch { /* expected */ }
    if (i.renderString(i.run(parseDocument('count'))) !== '7') throw new Error('cleanup skipped');
});
Deno.test('withFile evaluates a lazy read before closing', () => {
    const source = 'import "io"\nwithFile "lib/io.apn" (f -> f.read)';
    const actual = result(source);
    if (!actual.includes('readInput')) throw new Error(actual);
});
Deno.test('withFile closes handles even when saved outside the scope', () => {
    const i = new Interpreter();
    i.run(parseDocument('import "io"\nsaved = Mutable []\nwithFile "lib/io.apn" (f -> set saved f)'));
    try { i.run(parseDocument('saved.read')); } catch (e) { if (String(e).includes('resource is closed')) return; throw e; }
    throw new Error('escaped live handle');
});
for (const [code, warnings] of [
    ['Option a = Some a | None\nf (Option _ value) = match value [Some x -> x]', 1],
    ['Option a = Some a | None\nf (Option _ value) = match value [Some x -> x, None -> 0]', 0],
    ['Option a = Some a | None\nf (Option _ value) = match value [Some x | x > 0 -> x, None -> 0]', 1],
    ['Option a = Some a | None\nf (Option _ value) = match value [Some x -> x, _ -> 0]', 0],
    ['Option a = Some a | None\nf (Option _ value) = match value handlers', 0],
    ['Option a = Some a | None\nf (Option _ value) = match value [handler]', 0],
    ['Option a = Some a | None\nf (Option _ value) = value -> match value [Some x -> x]', 0],
    ['Option a = Some a | None\nf match (Option _ value) = match value [Some x -> x]', 0],
    ['import "option"\nf (Option _ value) = match value [None -> 0]', 1],
] as const) Deno.test(`exhaustiveness diagnostic: ${code}`, () => {
    const ds = lint(code).filter(d => d.code !== 'unused');
    if (ds.length !== warnings || ds.some(d => d.code !== 'non-exhaustive-match' || d.severity !== 2)) throw new Error(JSON.stringify(ds));
});

Deno.test('bracket releases in reverse order on interruption', () => {
    const i = new Interpreter();
    i.run(parseDocument('import "function"; order = Mutable ""'));
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
    i.run(parseDocument('import "function"; released = Mutable False'));
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
