import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";
import { CheckingSession } from "../src/checking-session.ts";

function session(): Interpreter {
    const i = new Interpreter();
    i.extendDefinitions = true;
    i.enableChecking();
    return i;
}
function run(i: Interpreter, source: string): string {
    return i.renderString(i.run(parse(source)));
}
function rejected(i: Interpreter, source: string): void {
    try { run(i, source); } catch (error) {
        if ((error as { kind?: string }).kind === "type") return;
        throw error;
    }
    throw new Error(`accepted: ${source}`);
}
for (const [source, expected] of [
    ['import "std"; sum [1,2,3]', '6'],
    ['std = import "std"; std.sum (Int * [1,2,3])', '6'],
    ['import ["std/function", "std/number"]; id (sq 3)', '9'],
    ['ns = [double: (x -> x * 2)]; use ns; double 3', '6'],
    ['use [[one: 1], [two: 2]]; one + two', '3'],
    ['x = Mutable 1; set x 2; x + 1', '3'],
    ['Direction = North | South; [10,20] South', '20'],
    ['templates = [String, Int]; values = ["x",1]; templates.values', '["x", 1]'],
    ['xs = [1]; xs = [2,3]; xs', '[2, 3]'],
    ['f x = x + 1; [f 1, f 2.0]', '[2, 3.0]'],
    ['factorial = (self -> n -> self self n) (self -> n -> n == 0 ? 1 : n * self self (n - 1)); factorial 5', '120'],
    ['import "std/type"; cast Float32 (Float64 .2)', 'Float32 0.2'],
] as const) Deno.test(`default checking session: ${source}`, () => {
    const actual = run(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'import "std"; sum ["bad"]',
    'f x = x + 1; f "bad"',
    'apply f x = f x; apply (x -> x + 1) "bad"',
    'x | missingGuard -> x',
    'f x = x == 0 ? 1 : x * x; f (Dynamic 2)',
    'Vect 2 Int [1]',
    'xs <- Vect 2 Int [1,2]; xs = [3]',
    'env',
]) Deno.test(`default checking rejects before evaluation: ${source}`, () => rejected(session(), source));

Deno.test("a static error prevents earlier effects and bindings", () => {
    const i = session(), lines: unknown[] = [], oldLog = console.log;
    console.log = (...values: unknown[]) => { lines.push(values); };
    try { rejected(i, 'print "must not print"; newName = 1; 1 + "bad"'); }
    finally { console.log = oldLog; }
    if (lines.length || i.env.get("newName")) throw new Error("rejected source had effects");
});
Deno.test("REPL clauses and polymorphism survive separate submissions", () => {
    const i = session();
    run(i, 'func 0 = 1'); run(i, 'func 1 = 0');
    if (run(i, '[func 0, func 1]') !== '[1, 0]') throw new Error('lost clause');
    run(i, 'func 0 = 2');
    if (run(i, '[func 0, func 1]') !== '[2, 0]') throw new Error('replacement lost clause');
    rejected(i, 'func 2 = "bad"');
    run(i, 'id x = x');
    if (run(i, 'id 1') !== '1' || run(i, 'id true') !== 'true') throw new Error('lost polymorphism');
});
Deno.test("runtime failure restores bindings and their checking state", () => {
    const i = session(); run(i, 'existing = 1');
    try { run(i, 'existing = 2; transient = 3; fail "stop"'); } catch { /* intended */ }
    if (run(i, 'existing') !== '1' || i.env.get('transient')) throw new Error('partial bindings survived');
    rejected(i, 'transient');
    rejected(i, 'existing = "bad"');
});
Deno.test("namespaced import does not open conflicting exports", () => {
    const i = session(); run(i, 'span = 123; html = import "std/html"');
    run(i, 'html.text "hello"');
    if (run(i, 'span') !== '123' || i.env.get('button')) throw new Error('namespace leaked');
});
Deno.test("load checks dependencies with the lexical caller scope", () => {
    const i = session();
    const file = new URL('fixtures/static-checking/local', import.meta.url).pathname;
    const actual = run(i, `f localValue = { module = load "${file}"; module.answer }; f 41`);
    if (actual !== '42') throw new Error(actual);
});
Deno.test("invalid loaded source is rejected before any output", () => {
    const file = new URL('fixtures/static-checking/invalid', import.meta.url).pathname;
    rejected(session(), `load "${file}"`);
});
Deno.test("all standard modules check without evaluation", () => {
    const checker = new CheckingSession();
    for (const name of ['std', 'std/meta', 'std/html', 'std/browser', 'std/p5', 'std/ffi']) checker.module(name);
});

Deno.test("Dynamic writes cannot invalidate a checked Mutable payload", () => {
    const i = session(); run(i, 'cell = Mutable 1');
    try { run(i, 'Dynamic (set cell "bad")'); } catch (error) {
        if (!String(error).includes('cannot convert String to Int')) throw error;
        if (run(i, 'cell + 1') !== '2') throw new Error('cell was corrupted');
        return;
    }
    throw new Error('unchecked Mutable write');
});
for (const source of ['cast (x -> x) 1', 'intToString "bad"', 'isExact "bad"', 'keys [x: 1]', 'values [x: 1]']) {
    Deno.test(`native signatures reject incompatible values: ${source}`, () => rejected(session(), source));
}

Deno.test("unary collection constraints distribute over heterogeneous list shapes", () => {
    const actual = run(session(), 'map length [[1], [2,3]]');
    if (actual !== '[1, 2]') throw new Error(actual);
});
Deno.test("default checking reports an unbound name with a suggestion", () => {
    try { run(session(), "y = 3; yy + 1"); } catch (error) {
        const e = error as { kind?: string; message?: string; hint?: string };
        if (e.kind !== "type" || e.message !== "unbound variable 'yy'" || e.hint !== "did you mean 'y'?") throw error;
        return;
    }
    throw new Error("accepted an unbound name");
});
// A variable bound to a union containing itself (v = v | t) resolves to t,
// and functions that return their list parameter preserve its length.
for (const [source, expected] of [
    ['import "std"; g [a, b] = forceList [b, a + b]; repeatApply 3 g [1, 2]', '[5, 8]'],
    ['import "std"; tick [a,b,c,d,e,f,g,h,i] = forceList [b,c,d,e,f,g,h + a,i,a]; sum (repeatApply 80 tick [0,1,1,2,1,0,0,0,0])', '5934'],
    ['f (List xs) = xs; g [a, b] = f [b, a + b]; g (g [1, 2])', '[3, 5]'],
    ['import "std"; g [a, b] = a + b; g (forceList [1, 2])', '3'],
    ['g [a, b] = a + b; g (map (x -> x * 2) [1, 2])', '6'],
    ['xs = map (x -> x + 1) [1, 2]; ys = map (x -> x * 2) [1, 2, 3]; g [a, b] = a + b; [g xs, length ys]', '[5, 3]'],
    ['x (x:xs) = 42; x [x]', '42'],
] as const) Deno.test(`checker infers recursive steps and list sizes: ${source}`, () => {
    const actual = run(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'import "std"; g [a, b] = forceList [b, a ++ "x"]; repeatApply 3 g [1, 2]',
    'import "std"; g [a, b] = a + b; g (forceList [1, 2, 3])',
    'g [a, b] = a + b; g (map (x -> x) [1, 2, 3])',
    'g [a, b] = a + b; g (map (x -> x) (tail [1, 2, 3]))',
    'g [a, b] = a + b; g (tail [0, 1, 2])',
    'g [a, b] = tail [0, b, a + b]; h n f s = n == 0 ? s : h (n - 1) f (f s); h 3 g [1, 2]',
]) Deno.test(`checker still rejects: ${source}`, () => rejected(session(), source));
// Length-preserving builtins carry their input's length, and separate uses of
// one generic function keep independent lengths.
for (const [source, expected] of [
    ['g [p, q] = p; g (enumerate [10, 20])', '[0, 10]'],
    ['g [p, q] = p + q; g ([1, 2] * (x -> x * 10))', '30'],
    ['g [p, q] = p + q; g ((x -> x * 10) * [1, 2])', '30'],
    ['g [p, q] = p + q; g (-[1, 2])', '-3'],
    ['g [p, q] = p + q; g ([1, 2] + [3, 4])', '10'],
    ['g [p, q] = p + q; g ([1, 2] * 3)', '9'],
    ['g [[k, v], [k2, w]] = w ++ "!"; g (pairs [x: 1, y: "s"])', '"s!"'],
    ['twice xs = xs * (x -> x * 2); g [p, q] = p + q; g (twice [1, 2])', '6'],
    ['number xs = enumerate xs; g [p, q] = p; [g (number [1, 2]), length (number [1, 2, 3])]', '[[0, 1], 3]'],
    ['h a b = [map (x -> x) a, map (x -> x) b]; h [1] [1, 2]', '[[1], [1, 2]]'],
    ['f (List xs) = xs; h a b = [f a, f b]; h [1] [1, 2]', '[[1], [1, 2]]'],
] as const) Deno.test(`checker keeps builtin list lengths: ${source}`, () => {
    const actual = run(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'g [p, q] = p; g (enumerate [10, 20, 30])',
    'g [p, q] = p + q; g ([1, 2, 3] * (x -> x * 10))',
    '[1, 2] + [3, 4, 5]',
    'g [p, q] = p; g (pairs [x: 1])',
    'h a b = [map (x -> x) a, map (x -> x) b]; g [[x], [y, z]] = x + y + z; g (h [1, 2] [1])',
    'g [p, q] = p + q; g (tail [1, 2, 3] * (x -> x))',
    // Lengths inside a freshly built list are not tracked through a function.
    'h a b = [map (x -> x) a, map (x -> x) b]; g [[x], [y, z]] = x + y + z; g (h [1] [1, 2])',
]) Deno.test(`checker rejects mismatched builtin list lengths: ${source}`, () => rejected(session(), source));
// Standard-library list functions keep their argument's length; functions that
// change a list's length (folds, cons, append, filter) stay unknown, even when
// their result has the same type as their input.
for (const [source, expected] of [
    ['import "std"; g [a, b] = a + b; g (reverse [1, 2])', '3'],
    ['import "std"; g [a, b] = a - b; g (sort [2, 1])', '-1'],
    ['import "std"; g [a, b] = a - b; g (sortBy compare [2, 1])', '-1'],
    ['import "std"; g [a, b] = a - b; g (sortOn (x -> -x) [1, 2])', '1'],
    ['import "std"; g [p, q] = p; g (zipWithIndex [5, 6])', '[0, 5]'],
    ['import "std"; reverse "abc" ++ "!"', '"cba!"'],
] as const) Deno.test(`stdlib keeps list lengths: ${source}`, () => {
    const actual = run(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'import "std"; g [a, b] = a + b; g (reverse [1, 2, 3])',
    'f xs = foldl (acc x -> x : acc) xs [1, 2]; g [a, b] = a + b; g (f [1, 2])',
    'f xs = foldl (acc x -> x : acc) xs [1, 2]; g [a, b, c, d] = a + b; g (f [1, 2])',
    'f xs = 0 : xs; g [a, b] = a + b; g (f [1, 2])',
    'f xs = xs ++ xs; g [a, b] = a + b; g (f [1, 2])',
    'f xs = filter (x -> x > 0) xs; g [a, b] = a + b; g (f [1, 2])',
    'f xs = { xs = [1, 2, 3]; xs }; g [a, b] = a + b; g (f [1, 2])',
]) Deno.test(`length changes stay unknown: ${source}`, () => rejected(session(), source));
