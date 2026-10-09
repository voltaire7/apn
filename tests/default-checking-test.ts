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
    ['import "sequence"; sum [1,2,3]', '6'],
    ['seqs = import "sequence"; seqs.sum (Int * [1,2,3])', '6'],
    ['import ["function","number"]; id (sq 3)', '9'],
    ['ns = [double: (x -> x * 2)]; use ns; double 3', '6'],
    ['use [[one: 1],[two: 2]]; one + two', '3'],
    ['x = Mutable 1; set x 2; x + 1', '3'],
    ['Direction = North | South; [10,20] South', '20'],
    ['templates = [String,Int]; values = ["x",1]; templates.values', '["x",1]'],
    ['xs = [1]; xs = [2,3]; xs', '[2,3]'],
    ['f x = x + 1; [f 1,f 2.0]', '[2,3.0]'],
    ['factorial = (self -> n -> self self n) (self -> n -> n == 0 ? 1 : n * self self (n - 1)); factorial 5', '120'],
    ['import "type"; cast Float32 (Float64 .2)', 'Float32 0.2'],
] as const) Deno.test(`default checking session: ${source}`, () => {
    const actual = run(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'import "sequence"; sum ["bad"]',
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
    if (run(i, '[func 0,func 1]') !== '[1,0]') throw new Error('lost clause');
    run(i, 'func 0 = 2');
    if (run(i, '[func 0,func 1]') !== '[2,0]') throw new Error('replacement lost clause');
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
    const i = session(); run(i, 'span = 123; html = import "html"');
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
    for (const name of ['type', 'function', 'option', 'sequence', 'array', 'number', 'text', 'map', 'combinator', 'io', 'system', 'search', 'meta', 'html', 'browser', 'p5', 'ffi']) checker.module(name);
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
    const actual = run(session(), 'map length [[1],[2,3]]');
    if (actual !== '[1,2]') throw new Error(actual);
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
    ['import "sequence"; g [a,b] = forceList [b,a + b]; repeatApply 3 g [1,2]', '[5,8]'],
    ['import "sequence"; tick [a,b,c,d,e,f,g,h,i] = forceList [b,c,d,e,f,g,h + a,i,a]; sum (repeatApply 80 tick [0,1,1,2,1,0,0,0,0])', '5934'],
    ['f (List xs) = xs; g [a,b] = f [b,a + b]; g (g [1,2])', '[3,5]'],
    ['import "sequence"; g [a,b] = a + b; g (forceList [1,2])', '3'],
    ['g [a,b] = a + b; g (map (x -> x * 2) [1,2])', '6'],
    ['xs = map (x -> x + 1) [1,2]; ys = map (x -> x * 2) [1,2,3]; g [a,b] = a + b; [g xs,length ys]', '[5,3]'],
    ['x (x:xs) = 42; x [x]', '42'],
] as const) Deno.test(`checker infers recursive steps and list sizes: ${source}`, () => {
    const actual = run(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'import "sequence"; g [a,b] = forceList [b,a ++ "x"]; repeatApply 3 g [1,2]',
    'import "sequence"; g [a,b] = a + b; g (forceList [1,2,3])',
    'g [a,b] = a + b; g (map (x -> x) [1,2,3])',
    'g [a,b] = a + b; g (map (x -> x) (tail [1,2,3]))',
    'g [a,b] = a + b; g (tail [0,1,2])',
    'g [a,b] = tail [0,b,a + b]; h n f s = n == 0 ? s : h (n - 1) f (f s); h 3 g [1,2]',
]) Deno.test(`checker still rejects: ${source}`, () => rejected(session(), source));
// Length-preserving builtins carry their input's length, and separate uses of
// one generic function keep independent lengths.
for (const [source, expected] of [
    ['g [p,q] = p; g (enumerate [10,20])','[0,10]'],
    ['g [p,q] = p + q; g ([1,2] * (x -> x * 10))','30'],
    ['g [p,q] = p + q; g ((x -> x * 10) * [1,2])','30'],
    ['g [p,q] = p + q; g (-[1,2])','-3'],
    ['g [p,q] = p + q; g ([1,2] + [3,4])','10'],
    ['g [p,q] = p + q; g ([1,2] * 3)','9'],
    ['g [[k,v],[k2,w]] = w ++ "!"; g (pairs [x: 1, y: "s"])','"s!"'],
    ['twice xs = xs * (x -> x * 2); g [p,q] = p + q; g (twice [1,2])','6'],
    ['number xs = enumerate xs; g [p,q] = p; [g (number [1,2]),length (number [1,2,3])]','[[0,1],3]'],
    ['h a b = [map (x -> x) a,map (x -> x) b]; h [1] [1,2]','[[1],[1,2]]'],
    ['f (List xs) = xs; h a b = [f a,f b]; h [1] [1,2]','[[1],[1,2]]'],
] as const) Deno.test(`checker keeps builtin list lengths: ${source}`, () => {
    const actual = run(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'g [p,q] = p; g (enumerate [10,20,30])',
    'g [p,q] = p + q; g ([1,2,3] * (x -> x * 10))',
    '[1,2] + [3,4,5]',
    'g [p,q] = p; g (pairs [x: 1])',
    'h a b = [map (x -> x) a,map (x -> x) b]; g [[x],[y,z]] = x + y + z; g (h [1,2] [1])',
    'g [p,q] = p + q; g (tail [1,2,3] * (x -> x))',
]) Deno.test(`checker rejects mismatched builtin list lengths: ${source}`, () => rejected(session(), source));
// Standard-library list functions keep their argument's length; functions that
// change a list's length (folds, cons, append, filter) stay unknown, even when
// their result has the same type as their input.
for (const [source, expected] of [
    ['import "sequence"; g [a,b] = a + b; g (reverse [1,2])','3'],
    ['import "sequence"; g [a,b] = a - b; g (sort [2,1])','-1'],
    ['import "sequence"; g [a,b] = a - b; g (sortBy compare [2,1])','-1'],
    ['import "sequence"; g [a,b] = a - b; g (sortOn (x -> -x) [1,2])','1'],
    ['import "sequence"; g [p,q] = p; g (zipWithIndex [5,6])','[0,5]'],
    ['import "sequence"; reverse "abc" ++ "!"','"cba!"'],
] as const) Deno.test(`stdlib keeps list lengths: ${source}`, () => {
    const actual = run(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'import "sequence"; g [a,b] = a + b; g (reverse [1,2,3])',
    'f xs = foldl (acc x -> x : acc) xs [1,2]; g [a,b] = a + b; g (f [1,2])',
    'f xs = foldl (acc x -> x : acc) xs [1,2]; g [a,b,c,d] = a + b; g (f [1,2])',
    'f xs = 0 : xs; g [a,b] = a + b; g (f [1,2])',
    'f xs = xs ++ xs; g [a,b] = a + b; g (f [1,2])',
    'f xs = filter (x -> x > 0) xs; g [a,b] = a + b; g (f [1,2])',
    'f xs = { xs = [1,2,3]; xs }; g [a,b] = a + b; g (f [1,2])',
]) Deno.test(`length changes stay unknown: ${source}`, () => rejected(session(), source));
// Nested lengths: a function's result shape is described in terms of its
// arguments, and is trusted only where the function is called directly by name.
for (const [source, expected] of [
    ['h a b = [map (x -> x) a,map (x -> x) b]; g [[x],[y,z]] = x + y + z; g (h [1] [1,2])', '4'],
    ['pairUp a b = [a,b]; g [[x],[y,z]] = x + y + z; g (pairUp [1] [2,3])', '6'],
    ['h a b = [map (x -> x) a,map (x -> x) b]; h2 a b = h b a; g [[x,y],[z]] = x + y + z; g (h2 [1] [1,2])', '4'],
    ['import "sequence"; both xs = [sort xs,reverse xs]; g [[a,b],[c,d]] = a + d; g (both [2,1])', '3'],
] as const) Deno.test(`checker tracks nested list lengths: ${source}`, () => {
    const actual = run(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'h a b = [map (x -> x) a,map (x -> x) b]; g [[x],[y,z]] = x + y + z; g (h [1,2] [1])',
    // A function value that flows through a ternary, list, variable, or partial
    // application shares its type with other functions: no length is assumed.
    'keep xs = xs * (x -> x); drop1 xs = tail xs; pick b = b ? keep : drop1; g [a,b,c] = a; g ((pick false) [1,2,3])',
    'keep xs = xs * (x -> x); drop1 xs = tail xs; h = false ? keep : drop1; g [a,b,c] = a; g (h [1,2,3])',
    'keep xs = xs * (x -> x); drop1 xs = tail xs; fs = [keep,drop1]; g [a,b,c] = a; g ((fs 1) [1,2,3])',
    'import "sequence"; p = sortBy compare; g [a,b] = a; g (p [2,1])',
]) Deno.test(`checker does not assume lengths: ${source}`, () => rejected(session(), source));
// An empty-list pattern rejects a list known to be non-empty (it would fail at
// runtime), while lists of unknown length still reach it, as recursion needs.
// Empty-list and cons clauses are separate overload choices.
for (const [source, expected] of [
    ['g [] = 0; g []', '0'],
    ['g [] = 0; g (tail [1])', '0'],
    ['len [] = 0; len (x:rest) = 1 + len rest; len [1,2,3]', '3'],
    ['rev [] = []; rev (x:xs) = rev xs ++ [x]; rev [1,2,3]', '[3,2,1]'],
    ['f [] = 0; f (x:xs) = x; [f [],f [7,8]]', '[0,7]'],
    ['f [] = "e"; f (x:xs) = x; f [5] + 1', '6'],
    ['f [] = "e"; f (x:xs) = x; f [] ++ "!"', '"e!"'],
] as const) Deno.test(`empty-list patterns: ${source}`, () => {
    const actual = run(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'g [] = 0; g [1]',
    'g [] = 0; g (map (x -> x) [1])',
    'f [] = [0]; f xs = [1,2]; g [] = 0; g (f [])',
]) Deno.test(`empty-list pattern rejects a non-empty list: ${source}`, () => rejected(session(), source));
// The runtime tries clauses by literal score, then source order. When a clause
// definitely matches, overload choices made only of later clauses are dropped;
// choices whose clauses all definitely fail are dropped too.
for (const [source, expected] of [
    ['f [] = [0]; f xs = [1,2]; g [a] = a; g (f [])', '0'],
    ['f [] = [0]; f xs = [1,2]; g [a,b] = a; g (f [3])', '1'],
    ['f xs = [1,2]; f [] = [0]; g [a,b] = a; g (f [])', '1'],
    ['f (x:xs) = [x]; f other = [1,2]; g [a] = a; g (f [7,8])', '7'],
    ['f [a,b] = [a]; f other = [1,2]; g [x] = x; g (f [7,8])', '7'],
    ['f [] y = [y]; f xs y = [1,2]; g [a] = a; g (f [] 5)', '5'],
    ['f xs 0 = [0]; f [] n = [1,2]; g [a] = a; g (f [] 0)', '0'],
    ['f xs 0 = [0]; f [] n = [1,2]; g [a,b] = a; g (f [] 1)', '1'],
    ['f n = [1,2]; f 0 = [0]; g [a] = a; g (f 0)', '0'],
    ['f "x" = [0]; f s = [1,2]; g [a] = a; g (f "x")', '0'],
    ['f true = [0]; f b = [1,2]; g [a] = a; g (f true)', '0'],
] as const) Deno.test(`first matching clause wins: ${source}`, () => {
    const actual = run(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'f [] = [0]; f xs = [1,2]; g [a,b] = a; g (f [])',
    'f xs = [1,2]; f [] = [0]; g [a] = a; g (f [])',
    'f [a,b] = [a]; f other = [1,2]; g [x] = x; g (f [7,8,9])',
    'f x x = [0]; f x y = [1,2]; g [a] = a; g (f 1 2)',
    'f xs 0 = [0]; f [] n = [1,2]; g [a] = a; g (f [] 1)',
    'f n = [1,2]; f 0 = [0]; g [a,b] = a; g (f 0)',
    'f true = [0]; f b = [1,2]; g [a] = a; g (f false)',
    // Unknown lengths keep every possible clause.
    // (Static evaluation is bounded in work: this filter scans a million elements.)
    'f [] = [0]; f xs = [1,2]; g [a] = a; g (f (tail (take 1 (filter (> 999999) [0..]))))',
]) Deno.test(`later clauses still count unless a match is definite: ${source}`, () => rejected(session(), source));
// Typed clauses are ranked as the runtime ranks them: an exact type (30)
// before a numeric aggregate (10) before a lossless conversion (1) before other
// patterns (0); literals (40) first. Value-dependent cases keep both clauses.
for (const [source, expected] of [
    ['f (Int n) = [0]; f xs = [1,2]; g [a] = a; g (f 3)', '0'],
    ['f xs = [1,2]; f (Int n) = [0]; g [a] = a; g (f 3)', '0'],
    ['f (Int n) = [0]; f xs = [1,2]; g [a,b] = a; g (f "s")', '1'],
    ['f (Int n) = [0]; f (String s) = [1,2]; g [a] = a; g (f 3)', '0'],
    ['f (Int n) = [0]; f (String s) = [1,2]; g [a,b] = a; g (f "x")', '1'],
    ['f (Number n) = [0]; f xs = [1,2]; g [a] = a; g (f 2.5)', '0'],
    ['f (Exact n) = [0]; f xs = [1,2]; g [a,b] = a; g (f 2.5)', '1'],
    ['f (List xs) = [0]; f other = [1,2]; g [a] = a; g (f [5,6])', '0'],
    ['f (Int n) = [0]; f xs = [1,2]; h x = g (f x); g [a] = a; h 3', '0'],
] as const) Deno.test(`typed clauses rank like the runtime: ${source}`, () => {
    const actual = run(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'f xs = [1,2]; f (Int n) = [0]; g [a,b] = a; g (f 3)',
    'f (Int n) = [0]; f xs = [1,2]; g [a] = a; g (f "s")',
    'f (Int n) = [0]; f xs = [1,2]; h x = g (f x); g [a] = a; h "s"',
    // Whether a Float converts to Int8 depends on its value: 2.5 does not.
    'f (Int8 n) = [0]; f xs = [1,2]; g [a] = a; h x = g (f (x * 1.0)); h 2.5',
]) Deno.test(`typed clauses keep possible clauses: ${source}`, () => rejected(session(), source));
// Clauses of the same input type whose results differ only in list lengths
// become separate overload choices instead of a definition error; any other
// result conflict is still rejected.
for (const [source, expected] of [
    ['f (Int n) = [1,2]; f 0 = [0]; g [a] = a; g (f 0)', '0'],
    ['f (Int n) = [1,2]; f 0 = [0]; g [a,b] = a; g (f 3)', '1'],
    ['f (Int n) = [[1],[2,3]]; f 0 = [[0]]; g [[a]] = a; g (f 0)', '0'],
] as const) Deno.test(`clauses with different result lengths: ${source}`, () => {
    const actual = run(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'f (Int n) = [1,2]; f 0 = [0]; g [a,b] = a; g (f 0)',
    'f (Int n) = [1,2]; f 0 = [0]; g [a] = a; g (f 3)',
    'f (Int n) = "a"; f 0 = 1',
    'f (Int n) = ["a","b"]; f 0 = [1]',
]) Deno.test(`clauses with different results stay checked: ${source}`, () => rejected(session(), source));
// A literal passed through function parameters still selects clauses: a
// deferred call keeps its argument's (symbolic) value, and each call
// substitutes the actual one, through any number of levels.
for (const [source, expected] of [
    ['f (Int n) = [1,2]; f 0 = [0]; h x = g (f x); g [a] = a; h 0','0'],
    ['f (Int n) = [1,2]; f 0 = [0]; h x = g (f x); g [a,b] = a; h 3','1'],
    ['f (Int n) = [1,2]; f 0 = [0]; h x = g (f x); g [a] = a; [h 0,h 0]','[0,0]'],
    ['f (Int n) = [1,2]; f 0 = [0]; h x = g (f (x - 1)); g [a] = a; h 1','0'],
    ['f (Int n) = [1,2]; f 0 = [0]; h s x = g (f x); g [a] = a; h "s" 0','0'],
    ['f (Int n) = [1,2]; f 0 = [0]; h x = g (f x); k y = h y; g [a] = a; k 0','0'],
    ['f (Int n) = [1,2]; f 0 = [0]; h x = g (f x); k y = h y; m z = k z; g [a] = a; m 0','0'],
    ['f (Int n) = [0]; f (String s) = [1]; h x = g (f x); k y = h y; g [a] = a; k 0','0'],
] as const) Deno.test(`literals through parameters: ${source}`, () => {
    const actual = run(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'f (Int n) = [1,2]; f 0 = [0]; h x = g (f x); g [a] = a; h 3',
    'f (Int n) = [1,2]; f 0 = [0]; h x = g (f x); g [a,b] = a; h 0',
    'f (Int n) = [1,2]; f 0 = [0]; h x = g (f x); g [a] = a; [h 0,h 5]',
    'f (Int n) = [1,2]; f 0 = [0]; h x = g (f (x - 1)); g [a] = a; h 2',
    'f (Int n) = [1,2]; f 0 = [0]; h x = g (f x); k y = h y; g [a] = a; k 4',
    'f (Int n) = [0]; f (String s) = [1,2]; h x = g (f x); k y = h y; g [a] = a; k "s"',
    'f (Int n) = 1; h x = (f x) + 1; k y = h y; k "s"',
]) Deno.test(`literals through parameters stay checked: ${source}`, () => rejected(session(), source));
// Boolean and string literals reach clauses through parameters too.
for (const [source, expected] of [
    ['f true = [0]; f b = [1,2]; h x = g (f x); g [a] = a; h true','0'],
    ['f true = [0]; f b = [1,2]; h x = g (f x); g [a,b] = a; h false','1'],
    ['f "x" = [0]; f s = [1,2]; h x = g (f x); g [a] = a; h "x"','0'],
    ['f "x" = [0]; f s = [1,2]; h x = g (f x); g [a,b] = a; h "y"','1'],
    ['f true = [0]; f b = [1,2]; h x = g (f x); k y = h y; g [a] = a; k true','0'],
    ['f "x" = [0]; f s = [1,2]; h x = g (f x); k y = h y; m z = k z; g [a] = a; m "x"','0'],
    ['f "x" = [0]; f s = [1,2]; h n s = g (f s); g [a] = a; h 1 "x"','0'],
    ['f "x" = [0]; f s = [1,2]; h x = { x = "y"; g (f x) }; g [a,b] = a; h "x"','1'],
] as const) Deno.test(`boolean and string literals through parameters: ${source}`, () => {
    const actual = run(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'f true = [0]; f b = [1,2]; h x = g (f x); g [a] = a; h false',
    'f true = [0]; f b = [1,2]; h x = g (f x); g [a,b] = a; h true',
    'f "x" = [0]; f s = [1,2]; h x = g (f x); g [a] = a; h "y"',
    'f true = [0]; f b = [1,2]; h x = g (f x); k y = h y; g [a] = a; k false',
    'f true = [0]; f b = [1,2]; h x = g (f x); g [a] = a; [h true,h false]',
    'f "x" = [0]; f s = [1,2]; h x = { x = "y"; g (f x) }; g [a] = a; h "x"',
]) Deno.test(`boolean and string literals through parameters stay checked: ${source}`, () => rejected(session(), source));
// Characters, floats, integer ranges and constructors select clauses too,
// directly and through parameters.
for (const [source, expected] of [
    ["f 'a' = [0]; f c = [1,2]; h x = g (f x); g [a] = a; h 'a'", '0'],
    ["f 'a' = [0]; f c = [1,2]; h x = g (f x); g [a,b] = a; h 'b'", '1'],
    ["f 'a' = [0]; f c = [1,2]; h x = g (f x); k y = h y; g [a] = a; k 'a'", '0'],
    ["c = 'a'; f 'a' = [0]; f x = [1,2]; g [a] = a; g (f c)", '0'],
    ['f 1.5 = [0]; f x = [1,2]; h x = g (f x); g [a] = a; h 1.5','0'],
    ['f 1.5 = [0]; f x = [1,2]; h x = g (f x); g [a,b] = a; h 2.5','1'],
    ['f 2 = [0]; f x = [1,2]; g [a] = a; g (f 2.0)','0'],
    ['f 2.0 = [0]; f x = [1,2]; g [a] = a; g (f 2)','0'],
    ['f [1..3] = [0]; f x = [1,2]; h x = g (f x); g [a] = a; h 2','0'],
    ['f [1..3] = [0]; f x = [1,2]; h x = g (f x); g [a,b] = a; h 7','1'],
    ['import "option"; f None = [0]; f x = [1,2]; h x = g (f x); g [a] = a; h None','0'],
    ['import "option"; f None = [0]; f x = [1,2]; h x = g (f x); g [a,b] = a; h (Some 1)','1'],
    ['import "option"; f (Some x) = [x]; f other = [1,2]; h v = g (f v); g [a] = a; h (Some 7)','7'],
    ['Light = | Off | On; f On = [1]; f x = [0,0]; h l = g (f l); g [a] = a; h On','1'],
] as const) Deno.test(`more literal kinds select clauses: ${source}`, () => {
    const actual = run(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    "f 'a' = [0]; f c = [1,2]; h x = g (f x); g [a] = a; h 'b'",
    'f 1.5 = [0]; f x = [1,2]; h x = g (f x); g [a] = a; h 2.5',
    'f [1..3] = [0]; f x = [1,2]; h x = g (f x); g [a] = a; h 7',
    'import "option"; f None = [0]; f x = [1,2]; h x = g (f x); g [a] = a; h (Some 1)',
    'Light = | Off | On; f On = [1]; f x = [0,0]; h l = g (f l); g [a] = a; h Off',
]) Deno.test(`more literal kinds stay checked: ${source}`, () => rejected(session(), source));
// A function's result value (a literal or constructor, or one of its
// arguments) is known at direct calls by name, so clause ranking can use it.
for (const [source, expected] of [
    ['import "option"; f None = [0]; f x = [1,2]; g [a] = a; mk x = None; g (f (mk 1))', '0'],
    ['import "option"; f None = [0]; f x = [1,2]; g [a,b] = a; mk x = Some x; g (f (mk 1))', '1'],
    ['import "option"; f None = [0]; f x = [1,2]; g [a] = a; mk x = None; h v = g (f v); h (mk 3)', '0'],
    ['import "option"; f None = [0]; f x = [1,2]; g [a] = a; mk x = None; h v = g (f (mk v)); h 3', '0'],
    ['import "option"; f None = [0]; f x = [1,2]; g [a] = a; pass v = v; g (f (pass None))', '0'],
    ['import "option"; f None = [0]; f x = [1,2]; g [a] = a; mk x = None; mk2 y = mk y; g (f (mk2 1))', '0'],
    ['import "option"; f None = [0]; f x = [1,2]; g [a] = a; pick b = b ? None : None; g (f (pick true))', '0'],
    ['f 0 = [0]; f x = [1,2]; g [a] = a; zero x = 0; g (f (zero 9))', '0'],
    ['f "x" = [0]; f s = [1,2]; g [a] = a; named x = "x"; g (f (named 1))', '0'],
    ["f 'a' = [0]; f s = [1,2]; g [a] = a; letter x = 'a'; g (f (letter 1))", '0'],
] as const) Deno.test(`function results select clauses: ${source}`, () => {
    const actual = run(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'import "option"; f None = [0]; f x = [1,2]; g [a] = a; mk x = Some x; g (f (mk 1))',
    'import "option"; f None = [0]; f x = [1,2]; g [a] = a; pass v = v; g (f (pass (Some 2)))',
    // Results that depend on a value, or calls through a variable, stay unknown.
    'import "option"; f None = [0]; f x = [1,2]; g [a] = a; mk x = None; mk2 x = Some x; mkv = false ? mk : mk2; g (f (mkv 1))',
    'import "option"; f None = [0]; f x = [1,2]; g [a] = a; mk x = None; mkv = mk; g (f (mkv 1))',
    // A rebound variable can change under a closure that captured it.
    "f 'a' = [0]; f x = [1,2]; g [a] = a; c = 'a'; h u = g (f c); c = 'b'; h 0",
]) Deno.test(`function results stay checked: ${source}`, () => rejected(session(), source));
// Results that depend on argument values: the checker evaluates a directly
// called function's clauses and conditions with what is known about the
// arguments, and decides calls through parameters at the enclosing calls.
for (const [source, expected] of [
    ['import "option"; f None = [0]; f x = [1,2]; g [a] = a; pick b = b ? None : Some 1; g (f (pick true))','0'],
    ['import "option"; f None = [0]; f x = [1,2]; g [a,b] = a; pick b = b ? None : Some 1; g (f (pick false))','1'],
    ['import "option"; f None = [0]; f x = [1,2]; g [a] = a; mk 0 = None; mk n = Some n; g (f (mk 0))','0'],
    ['import "option"; f None = [0]; f x = [1,2]; g [a,b] = a; mk 0 = None; mk n = Some n; g (f (mk 5))','1'],
    ['import "option"; f None = [0]; f x = [1,2]; g [a] = a; safe n = n > 0 ? Some n : None; g (f (safe (-3)))','0'],
    ['import "option"; f None = [0]; f x = [1,2]; g [a,b] = a; safe n = n > 0 ? Some n : None; g (f (safe 4))','1'],
    ['import "option"; f None = [0]; f x = [1,2]; g [a] = a; safe n = n - 1 > 0 ? Some n : None; g (f (safe 1))','0'],
    ['import "option"; f None = [0]; f x = [1,2]; g [a] = a; both p q = p && q ? Some 1 : None; g (f (both true false))','0'],
    ['import "option"; f None = [0]; f x = [1,2]; g [a] = a; z n = !n ? None : Some 1; g (f (z 0))','0'],
    ['import "option"; f None = [0]; f x = [1,2]; g [a] = a; is s = s == "x" ? None : Some 1; g (f (is "x"))','0'],
    ['import "option"; f None = [0]; f x = [1,2]; g [a] = a; count 0 = None; count n = count (n - 1); g (f (count 5))','0'],
    ['import "option"; f None = [0]; f x = [1,2]; g [a] = a; safe n = n > 0 ? Some n : None; h v = g (f (safe v)); h 0','0'],
    ['import "option"; f None = [0]; f x = [1,2]; g [a,b] = a; safe n = n > 0 ? Some n : None; h v = g (f (safe v)); h 5','1'],
    ['import "option"; f None = [0]; f x = [1,2]; g [a] = a; safe n = n > 0 ? Some n : None; h v = g (f (safe v)); k w = h w; k (-1)','0'],
    ['import "option"; f None = [0]; f x = [1,2]; g [a] = a; safe n = n > 0 ? Some n : None; h (Int v) = g (f (safe v)); h 0','0'],
    ['fib 0 = 0; fib 1 = 1; fib n = fib (n - 1) + fib (n - 2); f 6765 = [0]; f x = [1,2]; g [a] = a; g (f (fib 20))','0'],
] as const) Deno.test(`value-dependent results: ${source}`, () => {
    const actual = run(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'import "option"; f None = [0]; f x = [1,2]; g [a] = a; pick b = b ? None : Some 1; g (f (pick false))',
    'import "option"; f None = [0]; f x = [1,2]; g [a] = a; mk 0 = None; mk n = Some n; g (f (mk 5))',
    'import "option"; f None = [0]; f x = [1,2]; g [a] = a; safe n = n > 0 ? Some n : None; h v = g (f (safe v)); h 3',
    'import "option"; f None = [0]; f x = [1,2]; g [a] = a; safe n = n > 0 ? Some n : None; h v = g (f (safe v)); k w = h w; k 9',
    'import "option"; f None = [0]; f x = [1,2]; g [a] = a; safe n = n > 0 ? Some n : None; h v = g (f (safe v)); [h 0,h 1]',
]) Deno.test(`value-dependent results stay checked: ${source}`, () => rejected(session(), source));
// Floating-point and exact rational conditions are evaluated with the
// runtime's own arithmetic and comparison, including NaN and lossy-mix rules.
const optionClauses = 'import "option"; f None = [0]; f x = [1,2]';
for (const [source, expected] of [
    ['g [a] = a; small x = x < 0.5 ? None : Some x; g (f (small 0.25))', '0'],
    ['g [a,b] = a; small x = x < 0.5 ? None : Some x; g (f (small 0.75))', '1'],
    ['g [a] = a; small x = x * 2.0 - 0.5 < 0.0 ? None : Some x; g (f (small 0.1))', '0'],
    ['g [a,b] = a; e3 x = x + 0.2 == 0.3 ? None : Some x; g (f (e3 0.1))', '1'],
    ['g [a] = a; half x = x / 2 == 1 / 2 ? None : Some x; g (f (half 1))', '0'],
    ['g [a] = a; third x = x < 1 / 3 ? None : Some x; g (f (third (1 / 4)))', '0'],
    ['g [a] = a; m x = x == 0.5 ? None : Some x; g (f (m (1 / 2)))', '0'],
    ['g [a,b] = a; n x = x < 1.0 ? None : Some x; g (f (n (0.0 / 0.0)))', '1'],
    ['g [a] = a; r x = floor x == 2 ? None : Some x; g (f (r 2.7))', '0'],
    ['g [a] = a; r x y = min (abs x) y < 1 ? None : Some x; g (f (r (-0.5) 4))', '0'],
    ['g [a] = a; r x = x ^ 2 == 1 / 4 ? None : Some x; g (f (r (1 / 2)))', '0'],
    ['g [a] = a; small x = x < 0.5 ? None : Some x; h v = g (f (small v)); h 0.25', '0'],
    ['g [a] = a; small x = x < 0.5 ? None : Some x; h v = g (f (small (v / 4))); h 1', '0'],
] as const) Deno.test(`float and rational conditions: ${source}`, () => {
    const actual = run(session(), `${optionClauses}; ${source}`);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const [source, expected] of [
    ['f 0.5 = [0]; f x = [1,2]; g [a] = a; g (f (1 / 2))', '0'],
    ['f 2 = [0]; f x = [1,2]; g [a] = a; g (f (6 / 3))', '0'],
] as const) Deno.test(`number patterns match computed values: ${source}`, () => {
    const actual = run(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'g [a] = a; small x = x * 2.0 - 0.5 < 0.0 ? None : Some x; g (f (small 0.4))',
    'g [a] = a; e3 x = x + 0.2 == 0.3 ? None : Some x; g (f (e3 0.1))',
    'g [a] = a; n x = x < 1.0 ? None : Some x; g (f (n (0.0 / 0.0)))',
    'g [a] = a; small x = x < 0.5 ? None : Some x; h v = g (f (small v)); h 0.75',
    'g [a] = a; small x = x < 0.5 ? None : Some x; h v = g (f (small (v / 4))); h 3',
    // Operations the runtime rejects give no value: both clauses count.
    'g [a] = a; r x = x + 0.5 < 1.0 ? None : Some x; g (f (r (1 / 3)))',
    'g [a] = a; r x = 1 / x > 0 ? None : Some x; g (f (r 0))',
    // A shadowed builtin is not evaluated as the builtin.
    'g [a] = a; min a b = 99; r x = min x 1 < 1 ? None : Some x; g (f (r 0))',
]) Deno.test(`float and rational conditions stay checked: ${source}`, () => rejected(session(), `${optionClauses}; ${source}`));
// Fixed-width numbers keep their type: Float32 rounds to single precision and
// Int8 overflow is a runtime error, so it gives no value.
for (const [source, expected] of [
    ['g [a] = a; s x = Float32 x < Float32 0.5 ? None : Some x; g (f (s 0.25))', '0'],
    ['g [a] = a; e3 x = Float32 x + Float32 0.2 == Float32 0.3 ? None : Some x; g (f (e3 0.1))', '0'],
    ['g [a] = a; b x = Int8 x + Int8 100 > Int8 0 ? None : Some x; g (f (b 20))', '0'],
    ['g [a,b] = a; b x = -(Int8 x) < Int8 0 ? Some x : None; g (f (b 5))', '1'],
    ['g [a] = a; s x = Float32 x < Float32 0.5 ? None : Some x; h v = g (f (s v)); h 0.25', '0'],
    ['g [a] = a; k (Float32 x) = None; k x = Some x; h v = g (f (k (Float32 v))); h 0.5', '0'],
    ['g [a] = a; z = Int32 7; s x = x == Int32 7 ? None : Some x; g (f (s z))', '0'],
    ['h v = Int8 v; h 5', 'Int8 5'],
] as const) Deno.test(`fixed-width conditions: ${source}`, () => {
    const actual = run(session(), `${optionClauses}; ${source}`);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'g [a] = a; e3 x = Float32 x + Float32 0.2 == Float32 0.3 ? Some x : None; g (f (e3 0.1))',
    'g [a] = a; s x = Float32 x + Float64 0.5 < Float32 1.0 ? None : Some x; g (f (s 0.25))',
    'g [a] = a; b x = Int8 x + Int8 100 > Int8 0 ? None : Some x; g (f (b 100))',
    'g [a] = a; b x = -(Int8 x) > Int8 0 ? None : Some x; g (f (b (-128)))',
    'g [a] = a; b x = UInt8 x - UInt8 1 > UInt8 0 ? None : Some x; g (f (b 0))',
    'g [a] = a; b x = Int8 x > Int8 0 ? None : Some x; g (f (b 2.5))',
    'h v = Int8 v; h "x"',
]) Deno.test(`fixed-width conditions stay checked: ${source}`, () => rejected(session(), `${optionClauses}; ${source}`));
// A known value decides a typed clause as at runtime: its own type (30), a
// lossless conversion (1), or no match.
const intClauses = 'g [a] = a; k (Int x) = None; k x = Some x';
for (const [source, expected] of [
    ['g (f (k (UInt 3)))', '0'],
    ['g (f (k (Int8 3)))', '0'],
    ['g (f (k (Float32 2)))', '0'],
    ['k8 (Int8 x) = None; k8 x = Some x; g (f (k8 2.0))', '0'],
    ['z = UInt 2; g (f (k z))', '0'],
    ['h v = g (f (k (UInt v))); h 4', '0'],
    ['k8 (Int8 x) = None; k8 x = Some x; g (f (k8 4))', '0'],
    ['m (Int8 x) = x + Int8 1; m x = Int8 0; g (f (m 4 > Int8 4 ? None : Some 1))', '0'],
] as const) Deno.test(`lossless typed clauses: ${source}`, () => {
    const actual = run(session(), `${optionClauses}; ${intClauses}; ${source}`);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'g (f (k 2.5))',
    'g (f (k (1 / 2)))',
    'g (f (k "s"))',
    'k8 (Int8 x) = None; k8 x = Some x; g (f (k8 300))',
]) Deno.test(`lossless typed clauses stay checked: ${source}`, () => rejected(session(), `${optionClauses}; ${intClauses}; ${source}`));
// The builtin length of a list or String is known when its size is: from a
// literal, a parameter at its calls, cons, append, shaped builtins (map, sort)
// and recursion over list patterns.
const sizeClauses = 'import ["option","sequence","number"]; g [a] = a; sm n = n < 2 ? None : Some n; q xs = length xs < 2 ? None : Some 1; len [] = 0; len (x:xs) = 1 + len xs';
for (const [source, expected] of [
    ['g (f (sm (length [1])))', '0'],
    ['k (Int x) = None; k x = Some x; g (f (k (length [1])))', '0'],
    ['n = [1]; g (f (sm (length n)))', '0'],
    ['g (f (sm (length "a")))', '0'],
    ['hh xs = g (f (sm (length xs))); hh [5]', '0'],
    ['hh xs = g (f (sm (length xs - 1))); hh [5,6]', '0'],
    ['hh s = g (f (sm (length s))); hh "a"', '0'],
    ['hh ys = g (f (q ys)); hh [1]', '0'],
    ['hh ys = g (f (q (1 : ys))); hh []', '0'],
    ['hh ys = g (f (q (map (+ 1) ys))); hh [1]', '0'],
    ['hh ys = g (f (q (sort ys))); hh [1]', '0'],
    ['g (f (sm (len [1])))', '0'],
    ['hh ys = g (f (sm (len ys))); hh [3]', '0'],
] as const) Deno.test(`length calls: ${source}`, () => {
    const actual = run(session(), `${optionClauses}; ${sizeClauses}; ${source}`);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'g (f (sm (length [1,2,3])))',
    'g (f (sm (length [1] + 1)))',
    'g (f (sm (length "ab")))',
    'hh xs = g (f (sm (length xs))); hh [5,6]',
    'hh ys = g (f (q ys)); hh [1,2]',
    'hh ys = g (f (q (1 : ys))); hh [2]',
    'hh ys = g (f (q (ys ++ ys))); hh [2]',
    'hh ys = g (f (q (map (+ 1) ys))); hh [1,2]',
    'g (f (sm (len [1,2])))',
    // A predicate whose value stays unknown decides nothing: both clauses count.
    'g (f (q (filter (x -> x > sum [1..1000000]) [1,2])))',
]) Deno.test(`length calls stay checked: ${source}`, () => rejected(session(), `${optionClauses}; ${sizeClauses}; ${source}`));
// filter, map, take and drop over lists whose elements are known run as at
// runtime, as do integer ranges.
for (const [source, expected] of [
    ['g (f (q (filter (> 1) [1,2])))', '0'],
    ['g (f (q (filter (> 2) (map (* 2) [1,2]))))', '0'],
    ['big x = x > 1; g (f (q (filter big [1,2])))', '0'],
    ['g (f (q (filter (x -> x % 2 == 0) [1..3])))', '0'],
    ['hh ys = g (f (q (filter (> 1) ys))); hh [1,5]', '0'],
    ['hh n = g (f (q (filter (> n) [1,2,3]))); hh 2', '0'],
    ['g (f (q (take 1 [1,2,3])))', '0'],
    ['hh n = g (f (q (take n [5,6]))); hh 1', '0'],
    ['hh n = g (f (q (drop n [5,6]))); hh 1', '0'],
    ['hh n = g (f (q [1..n])); hh 1', '0'],
    ['g (f (q [3..3]))', '0'],
] as const) Deno.test(`list builtin lengths: ${source}`, () => {
    const actual = run(session(), `${optionClauses}; ${sizeClauses}; ${source}`);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'g (f (q (filter (> 1) [1,2,3])))',
    'g (f (q (filter (x -> x % 2 == 0) [1..5])))',
    'hh ys = g (f (q (filter (> 1) ys))); hh [3,5]',
    'hh n = g (f (q (filter (> n) [1,2,3]))); hh 1',
    'g (f (q (take 2 [1,2,3])))',
    'hh n = g (f (q (drop n [5,6]))); hh 0',
    'hh n = g (f (q [1..n])); hh 0',
    'g (f (q (take (-1) [1])))',
]) Deno.test(`list builtin lengths stay checked: ${source}`, () => rejected(session(), `${optionClauses}; ${sizeClauses}; ${source}`));
// zip, zipWith and takeWhile; functions passed as arguments are applied too.
for (const [source, expected] of [
    ['g (f (q (zip [1] [2,3])))', '0'],
    ['g (f (q (zipWith (+) [1] [2,3])))', '0'],
    ['hh xs = g (f (q (zip xs [7,8]))); hh [1]', '0'],
    ['g (f (q (takeWhile (< 2) [1,2,3])))', '0'],
    ['g (f (q (takeWhile (> 5) [1..20])))', '0'],
    ['hh n = g (f (q (takeWhile (< n) [1,2,3]))); hh 2', '0'],
    ['hh xs = g (f (q (takeWhile (< 2) xs))); hh [1,5,0]', '0'],
    ['g (f (q (takeUntil (> 1) [1,2])))', '0'],
    ['hh p = g (f (q (filter p [1,2]))); hh (> 1)', '0'],
    ['big x = x > 1; hh p = g (f (q (filter p [1,2]))); hh big', '0'],
    ['hh p = g (f (q (takeWhile p [1,2,3]))); hh (< 2)', '0'],
    ['g (f (q (filter (x -> head x > 1) [[1],[2]])))', '0'],
    ['g (f (q (tail [1,2])))', '0'],
    ['f2 [] = [0]; f2 xs = [1,2]; g (f2 (tail [1]))', '0'],
    // A recursive call with a literal list does not fix an open parameter length.
    ['tw xs = null xs ? [] : tw []; length (tw [1,2])', '0'],
] as const) Deno.test(`zip and takeWhile lengths: ${source}`, () => {
    const actual = run(session(), `${optionClauses}; ${sizeClauses}; ${source}`);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'g (f (q (zip [1,2] [2,3])))',
    'g (f (q (takeWhile (< 3) [1,2,3])))',
    'g (f (q (takeWhile (> 0) [1..20])))',
    'hh n = g (f (q (takeWhile (< n) [1,2,3]))); hh 3',
    'hh p = g (f (q (filter p [1,2]))); hh (> 0)',
    // A recursive call still has to fit a parameter whose pattern fixes a length.
    'h [a] = h [a,a]; h [1]',
]) Deno.test(`zip and takeWhile lengths stay checked: ${source}`, () => rejected(session(), `${optionClauses}; ${sizeClauses}; ${source}`));
// The pure builtins and the standard library written in APN (folds, endless
// lists, text, local definitions) are evaluated on known values too.
const textClauses = 'import "text"; r b = b ? None : Some 1';
for (const [source, expected] of [
    ['g (f (q (dropWhile (< 2) [1,2])))', '0'],
    ['g (f (q (words "a")))', '0'],
    ['hh s = g (f (q (words s))); hh "x"', '0'],
    ['g (f (q (splitOn "," "a")))', '0'],
    ['g (f (r (trim "  a " == "a")))', '0'],
    ['g (f (r (toString 12 == "12")))', '0'],
    ['g (f (r (toString [1,2] == "[1,2]")))', '0'],
    ['g (f (r (reverse "ab" == "ba")))', '0'],
    ['g (f (r (upper "a" == "A")))', '0'],
    ['g (f (r (contains 2 [1,2])))', '0'],
    ['g (f (r (all (> 0) [1,2])))', '0'],
    ['g (f (r (isSome (find (> 1) [1,2]))))', '0'],
    ['g (f (r (sum [1,2] == 3)))', '0'],
    ['g (f (r (foldr (x acc -> x + acc) 0 [1,2] == 3)))', '0'],
    ['g (f (q (take 1 (repeat 0))))', '0'],
    ['g (f (q (take 1 [0..])))', '0'],
    ['g (f (q (filter (> 3) (take 5 [0..]))))', '0'],
    ['g (f (r (isPrime 7)))', '0'],
    ['g (f (q (sort [3])))', '0'],
    ['local n = { k = n + 1; twice x = x * 2; twice k }; g (f (r (local 1 == 4)))', '0'],
] as const) Deno.test(`builtins and std evaluated: ${source}`, () => {
    const actual = run(session(), `${optionClauses}; ${sizeClauses}; ${textClauses}; ${source}`);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'g (f (q (dropWhile (< 2) [1,2,3])))',
    'g (f (q (words "a b")))',
    'hh s = g (f (q (words s))); hh "x y"',
    'g (f (r (trim "  a " == "b")))',
    'g (f (r (any (> 5) [1,2])))',
    'g (f (r (isPrime 8)))',
    // enumerate pairs each element with its index: [0, 7] has two elements.
    'g (f (q (head (enumerate [7]))))',
    'g (f (q (sort [3,1])))',
]) Deno.test(`builtins and std evaluated stay checked: ${source}`, () => rejected(session(), `${optionClauses}; ${sizeClauses}; ${textClauses}; ${source}`));
// parse reads booleans and numbers as at runtime; recursion is evaluated as
// deep as the runtime's own stack allows (non-tail recursion to depth 500).
const deepClauses = 'count n = n == 0 ? 0 : 1 + count (n - 1); upto n = n == 0 ? [] : n : upto (n - 1)';
for (const [source, expected] of [
    ['g (f (r (parse "12" == 12)))','0'],
    ['g (f (r (parse " true ")))','0'],
    ['g (f (r (parse "1/2" == 0.5)))','0'],
    ['g (f (q (integers "4")))','0'],
    ['g (f (r (count 500 == 500)))','0'],
    ['g (f (r (length (upto 450) == 450)))','0'],
    ['g (f (r (len [1..400] == 400)))','0'],
    ['g (f (r (sum (map (* 2) [1..5000]) == 25005000)))','0'],
    ['g (f (r (isPrime 7919)))','0'],
    ['g (f (q (take 1 (repeat 0))))','0'],
] as const) Deno.test(`parse and deep recursion: ${source}`, () => {
    const actual = run(session(), `${optionClauses}; ${sizeClauses}; ${textClauses}; ${deepClauses}; ${source}`);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'g (f (r (parse "x" == 1)))',
    'g (f (q (integers "4 5")))',
    'g (f (r (length (upto 450) == 449)))',
    'g (f (q (takeWhile (< 300) [1..])))',
    'g (f (q (take 2 (repeat 0))))',
]) Deno.test(`parse and deep recursion stay checked: ${source}`, () => rejected(session(), `${optionClauses}; ${sizeClauses}; ${textClauses}; ${deepClauses}; ${source}`));
// A name a block binds twice is one binding: lazy definitions and closures
// see its latest value, eager ones (<-) the value where they stand. Long lists
// are walked within the work budget; ranges are cut arithmetically.
for (const [source, expected] of [
    ['local n = { k = n; k = 5; k }; g (f (r (local 1 == 5)))','0'],
    ['k y = { x = 1; h = () -> x; x = 5; h [] }; g (f (r (k 0 == 5)))','0'],
    ['x = 10; k y = { z = x + 1; x = 2; z }; g (f (r (k 0 == 3)))','0'],
    ['k y = { a = 1; b = a; a = 2; b }; g (f (r (k 0 == 2)))','0'],
    ['k y = { a <- 1; b <- a + 1; a <- 5; b }; g (f (r (k 0 == 2)))','0'],
    ['k y = { a <- 1; a <- a + 1; a }; g (f (r (k 0 == 2)))','0'],
    ['k y = { n = 1; h q = q + n; n = 10; h 1 }; g (f (r (k 0 == 11)))','0'],
    ['k y = { a = 1; b <- a; a = 2; [a,b] }; g (f (r (k 0 == [2,1])))','0'],
    ['k y = { xs = 1 : xs; length (take 3 xs) }; g (f (r (k 0 == 3)))','0'],
    ['g (f (r (([a,b] -> a) [1,2] == 1)))','0'],
    ['g (f (r (length [1..1000000] == 1000000)))','0'],
    ['g (f (r (head (drop 1000000 [0..]) == 1000000)))','0'],
    ['g (f (q (tail (take 1 (drop 20000 [0..])))))','0'],
    ['g (f (r (sum [1..20000] == 200010000)))','0'],
    ['g (f (r (length (filter (> 15000) [1..20000]) == 5000)))','0'],
    ['g (f (r ([5,3..0] == [5,3,1])))','0'],
] as const) Deno.test(`rebinding blocks and long lists: ${source}`, () => {
    const actual = run(session(), `${optionClauses}; ${sizeClauses}; ${textClauses}; ${source}`);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'k y = { x = 1; h = () -> x; x = 5; h [] }; g (f (r (k 0 == 1)))',
    'k y = { a = 1; b = a; a = 2; b }; g (f (r (k 0 == 1)))',
    'k y = { a <- 1; b <- a + 1; a <- 5; b }; g (f (r (k 0 == 6)))',
    'g (f (r (length [1..1000000] == 999999)))',
    'g (f (r (sum [1..20000] == 0)))',
]) Deno.test(`rebinding blocks and long lists stay checked: ${source}`, () => rejected(session(), `${optionClauses}; ${sizeClauses}; ${textClauses}; ${source}`));
// Effects are not performed, but their results are known. Mutable cells keep
// their contents unless code in the session can write one (set, load, use, env).
const effectPrelude = `${optionClauses}; ${sizeClauses}; ${textClauses}`;
for (const [source, expected] of [
    ['g (f (r (print 3 == 3)))','0'],
    ['g (f (r (emit 3 == 3)))','0'],
    ['g (f (r (null (assert true))))','0'],
    ['g (f (r (null (debug 4))))','0'],
    ['k y = { c = Mutable 5; c + 1 }; g (f (r (k 0 == 6)))','0'],
    ['c = Mutable 5; g (f (r (c + 1 == 6)))','0'],
] as const) Deno.test(`effects and cells: ${source}`, () => {
    const actual = run(session(), `${effectPrelude}; ${source}`);
    if (actual !== expected.trim()) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'k y = { c = Mutable 5; c + 1 }; g (f (r (k 0 == 7)))',
    'k y = { c = Mutable 1; h = () -> c + 0; set c 2; h [] }; g (f (r (k 0 == 1)))',
    'c = Mutable 5; bump x = set c x; g (f (r (c + 1 == 5)))',
]) Deno.test(`effects and cells stay checked: ${source}`, () => rejected(session(), `${effectPrelude}; ${source}`));
// Writes after reads follow the run's order: block statements, eager
// bindings and operands run in order, and a lazy binding is read when used.
for (const [source, expected] of [
    ['k y = { c = Mutable 1; set c (c + 1); set c (c * 10); c + 0 }; g (f (r (k 0 == 20)))', '0'],
    ['k y = { c = Mutable 1; a <- c + 0; set c 5; a + 0 }; g (f (r (k 0 == 1)))', '0'],
    ['k y = { c = Mutable 1; a = c + 0; set c 5; a + 0 }; g (f (r (k 0 == 5)))', '0'],
    ['bump c = set c (c + 1); k y = { c = Mutable 1; bump c; bump c; c + 0 }; g (f (r (k 0 == 3)))', '0'],
    ['k y = { c = Mutable 1; (c + 0) + { set c 5; c + 0 } }; g (f (r (k 0 == 6)))', '0'],
    ['k y = { c = Mutable 1; h = () -> c + 0; set c 2; h [] }; g (f (r (k 0 == 2)))', '0'],
    ['sw c = { set c 9; c + 0 }; k y = { c = Mutable 1; a = c + 0; sw c + a }; g (f (r (k 0 == 18)))', '0'],
    // List elements and call arguments that read a cell are computed when used.
    ['k y = { c = Mutable 1; xs = [c + 0]; set c 7; head xs }; g (f (r (k 0 == 7)))', '0'],
    ['k y = { c = Mutable 1; xs = [c + 0]; v <- head xs + 0; set c 7; v }; g (f (r (k 0 == 1)))', '0'],
    ['p x c = { set c 3; x + 0 }; k y = { c = Mutable 1; p (c + 0) c }; g (f (r (k 0 == 3)))', '0'],
    // Top-level cells follow the statements that write them, in program order.
    ['counter = Mutable 0; set counter 4; g (f (r (counter + 0 == 4)))', '0'],
    ['counter = Mutable 0; bump x = set counter (counter + 1); bump []; bump []; g (f (r (counter + 0 == 2)))', '0'],
    ['counter = Mutable 0; set counter 4; print (counter + 0); set counter 9; g (f (r (counter + 0 == 9)))', '0'],
    ['counter <- Mutable 2; set counter (counter * 5); g (f (r (counter + 0 == 10)))', '0'],
    // A statement that writes and reads top-level cells: each part has the
    // value the statement's static run gave it, in the run's order.
    ['counter = Mutable 0; k y = { set counter 4; counter + 0 }; g (f (r (k 0 == 4)))', '0'],
    ['counter = Mutable 0; bump x = { set counter (counter + 1); counter + 0 }; g (f (r ((counter + 0) + bump 0 == 1)))', '0'],
    ['counter = Mutable 0; bump x = { set counter (counter + 1); counter + 0 }; g (f (r (bump 0 + (counter + 0) == 2)))', '0'],
    ['counter = Mutable 0; bump x = { set counter (counter + 1); counter + 0 }; print [bump 0,counter + 0]; g (f (r (counter + 0 == 1)))', '0'],
    ['counter = Mutable 0; bump x = { set counter (counter + 1); counter + 0 }; seq (bump 0) []; g (f (r (counter + 0 == 1)))', '0'],
    // Values a statement leaves unforced are harmless unless kept; a kept one
    // is forced (once) where a later statement forces it. An uncertain
    // statement only affects the cells and values it can reach.
    ['counter = Mutable 0; [set counter 9,1]; g (f (r (counter + 0 == 0)))', '0'],
    ['counter = Mutable 0; box = Mutable [[]]; set box [set counter 3]; g (f (r (counter + 0 == 0)))', '0'],
    ['counter = Mutable 0; box = Mutable [[]]; set box [set counter 3]; print box; g (f (r (counter + 0 == 3)))', '0'],
    ['counter = Mutable 0; box = Mutable [[]]; set box [set counter 3]; print box; set counter 8; print box; g (f (r (counter + 0 == 8)))', '0'],
    ['counter = Mutable 0; other = Mutable 7; m = HashMap [["a",1]]; has "a" m ? set counter 5 : []; g (f (r (other + 0 == 7)))', '0'],
    // Lazily computed elements run where the program forces them: map's
    // elements when used, filter's predicate as its cells are reached.
    ['counter = Mutable 0; print (map (x -> set counter x) [1,2]); g (f (r (counter + 0 == 2)))', '0'],
    ['counter = Mutable 0; bump x = set counter (counter + 1); xs = map (x -> bump x) [1,2]; print (length xs); g (f (r (counter + 0 == 0)))', '0'],
    ['counter = Mutable 0; bump x = set counter (counter + 1); print (head (map (x -> bump x) [1,2])); g (f (r (counter + 0 == 1)))', '0'],
    ['counter = Mutable 0; bump x = set counter (counter + 1); print (take 1 (map (x -> bump x) [1..])); g (f (r (counter + 0 == 1)))', '0'],
    ['counter = Mutable 0; bump x = set counter (counter + 1); print (filter (x -> { bump x; true }) [1,2]); g (f (r (counter + 0 == 2)))', '0'],
    ['counter = Mutable 0; bump x = set counter (counter + 1); print ([1,2] == map (x -> { bump x; x }) [5,2]); g (f (r (counter + 0 == 1)))', '0'],
    // A top-level action builds its list afresh at each use; a value keeps it.
    ['counter = Mutable 0; bump x = set counter (counter + 1); xs = map (x -> bump x) [1,2]; print xs; print xs; g (f (r (counter + 0 == 4)))', '0'],
    ['counter = Mutable 0; bump x = set counter (counter + 1); ys = [bump 0,bump 0]; print ys; print ys; g (f (r (counter + 0 == 2)))', '0'],
    // An uncertain statement reaching a lazily computed list follows what it is computed from.
    ['counter = Mutable 0; other = Mutable 7; ys = map (x -> x * 2) [1,2]; m = HashMap [["a",1]]; has "a" m ? set counter (head ys) : []; g (f (r (other + 0 == 7)))', '0'],
    // A load reaches only what the loaded file's source names.
    ['counter = Mutable 0; other = Mutable 7; set other 8; load "examples/advent-of-code/lanternfish"; g (f (r (other + 0 == 8)))','0'],
    // An env view reaches the bindings it names; use, the fields it opened.
    ['counter = Mutable 0; other = Mutable 7; bumpC x = set counter (counter + 1); scope <- Dynamic env; m = HashMap [["a",1]]; has "a" m ? scope.bumpC 0 : []; g (f (r (other + 0 == 7)))','0'],
    ['counter = Mutable 0; other = Mutable 7; ns = [bump: (x -> set counter 3)]; use ns; m = HashMap [["a",1]]; has "a" m ? bump 0 : []; g (f (r (other + 0 == 7)))','0'],
    // A computed key the checker knows names its binding.
    ['counter = Mutable 0; other = Mutable 7; bumpC x = set counter 1; scope <- Dynamic env; key = "bumpC"; m = HashMap [["a",1]]; has "a" m ? (scope key) 0 : []; g (f (r (other + 0 == 7)))','0'],
    ['counter = Mutable 0; bumpC x = set counter 1; scope <- Dynamic env; key = "bumpC"; (scope key) 0; g (f (r (counter + 0 == 1)))','0'],
    ['counter = Mutable 0; bumpC x = set counter 1; key = "bumpC"; (Dynamic env key) 0; g (f (r (counter + 0 == 1)))','0'],
    ['counter = Mutable 0; other = Mutable 7; bumpC x = set counter 1; scope <- Dynamic env; key = "bumpC"; call x = (scope key) x; m = HashMap [["a",1]]; has "a" m ? call 0 : []; g (f (r (other + 0 == 7)))','0'],
    ['counter = Mutable 0; other = Mutable 7; hb <- (x -> 0); hb 0; g (f (r (other + 0 == 7)))','0'],
    // Keys bound locally, and views stored in records, lists and cells or
    // passed to functions, reach the bindings their uses name.
    ['counter = Mutable 0; other = Mutable 7; bumpC x = set counter 1; bumpO x = set other 1; scope <- Dynamic env; m = HashMap [["a",1]]; has "a" m ? { k = "bumpC"; (scope k) 0 } : []; g (f (r (other + 0 == 7)))','0'],
    ['counter = Mutable 0; other = Mutable 7; bumpC x = set counter 1; bumpO x = set other 1; scope <- Dynamic env; m = HashMap [["a",1]]; has "a" m ? { k <- "bump"; j = k ++ "C"; (scope j) 0 } : []; g (f (r (other + 0 == 7)))','0'],
    ['counter = Mutable 0; other = Mutable 7; bumpC x = set counter 1; bumpO x = set other 1; scope <- Dynamic env; m = HashMap [["a",1]]; call y = { k = "bumpC"; (scope k) y }; has "a" m ? call 0 : []; g (f (r (other + 0 == 7)))','0'],
    ['counter = Mutable 0; other = Mutable 7; bumpC x = set counter 1; bumpO x = set other 1; scope <- Dynamic env; m = HashMap [["a",1]]; rr <- [s: scope, t: 5]; has "a" m ? (rr.s "bumpC") rr.t : []; g (f (r (other + 0 == 7)))','0'],
    ['counter = Mutable 0; other = Mutable 7; bumpC x = set counter 1; bumpO x = set other 1; scope <- Dynamic env; m = HashMap [["a",1]]; k = "bumpC"; rr <- [s: scope]; has "a" m ? (rr.s k) 0 : []; g (f (r (other + 0 == 7)))','0'],
    ['counter = Mutable 0; other = Mutable 7; bumpC x = set counter 1; bumpO x = set other 1; scope <- Dynamic env; m = HashMap [["a",1]]; box = Mutable [scope]; has "a" m ? ((head box) "bumpC") 0 : []; g (f (r (other + 0 == 7)))','0'],
    ['counter = Mutable 0; other = Mutable 7; bumpC x = set counter 1; bumpO x = set other 1; scope <- Dynamic env; m = HashMap [["a",1]]; hold = Mutable [scope]; set hold [scope]; has "a" m ? ((head hold) "bumpC") 0 : []; g (f (r (other + 0 == 7)))','0'],
    ['counter = Mutable 0; other = Mutable 7; bumpC x = set counter 1; bumpO x = set other 1; scope <- Dynamic env; m = HashMap [["a",1]]; pick = (v -> v); has "a" m ? ((pick scope) "bumpC") 0 : []; g (f (r (other + 0 == 7)))','0'],
    ['counter = Mutable 0; other = Mutable 7; bumpC x = set counter 1; bumpO x = set other 1; scope <- Dynamic env; m = HashMap [["a",1]]; getV y = scope; has "a" m ? ((getV 0) "bumpC") 0 : []; g (f (r (other + 0 == 7)))','0'],
    ['counter = Mutable 0; other = Mutable 7; bumpC x = set counter 1; bumpO x = set other 1; scope <- Dynamic env; m = HashMap [["a",1]]; via v = ((Dynamic v) "bumpC") 0; has "a" m ? via scope : []; g (f (r (other + 0 == 7)))','0'],
    // A top-level value is computed when first used and kept; a top-level
    // action (block, application or pipe body) runs at each use.
    ['counter = Mutable 0; snap = counter + 0; set counter 4; g (f (r (snap + 0 == 4)))','0'],
    ['counter = Mutable 0; snap = counter + 0; set counter 4; print snap; set counter 9; g (f (r (snap + 0 == 4)))','0'],
    ['counter = Mutable 0; snap = counter + 0; set counter 4; h x = snap + x; set counter 9; g (f (r (h 0 == 9)))','0'],
    ['counter = Mutable 0; a = counter + 0; b = a + 1; set counter 3; print a; set counter 8; g (f (r (b + 0 == 4)))','0'],
    ['counter = Mutable 0; init = set counter 5; init; set counter 1; init; g (f (r (counter + 0 == 5)))','0'],
    ['counter = Mutable 0; init = set counter 5; set counter 1; g (f (r (counter + 0 == 1)))','0'],
    ['counter = Mutable 0; snap = (counter + 0); set counter 2; print snap; set counter 7; g (f (r (snap + 0 == 7)))','0'],
    // A writer passed by value runs where it is called.
    ['counter = Mutable 0; twice h = { h []; h [] }; twice (_ -> set counter (counter + 3)); g (f (r (counter + 0 == 6)))','0'],
] as const) Deno.test(`cells written after reads: ${source}`, () => {
    const actual = run(session(), `${effectPrelude}; ${source}`);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'k y = { c = Mutable 1; set c (c + 1); set c (c * 10); c + 0 }; g (f (r (k 0 == 21)))',
    'k y = { c = Mutable 1; a <- c + 0; set c 5; a + 0 }; g (f (r (k 0 == 5)))',
    'k y = { c = Mutable 1; a = c + 0; set c 5; a + 0 }; g (f (r (k 0 == 1)))',
    'sw c = { set c 9; c + 0 }; k y = { c = Mutable 1; a = c + 0; sw c + a }; g (f (r (k 0 == 10)))',
    'counter = Mutable 0; set counter 4; g (f (r (counter + 0 == 0)))',
    'counter = Mutable 0; bump x = set counter (counter + 1); bump []; bump []; g (f (r (counter + 0 == 1)))',
    'counter = Mutable 0; bump x = { set counter (counter + 1); counter + 0 }; g (f (r ((counter + 0) + bump 0 == 2)))',
    'counter = Mutable 0; bump x = { set counter (counter + 1); counter + 0 }; print [bump 0,counter + 0]; g (f (r (counter + 0 == 0)))',
    'counter = Mutable 0; print (map (x -> set counter x) [1,2]); g (f (r (counter + 0 == 1)))',
    'counter = Mutable 0; bump x = set counter (counter + 1); xs = map (x -> bump x) [1,2]; print xs; print xs; g (f (r (counter + 0 == 2)))',
    'k y = { c = Mutable 1; xs = [c + 0]; set c 7; head xs }; g (f (r (k 0 == 1)))',
    'counter = Mutable 0; k y = { set counter 4; counter + 0 }; g (f (r (k 0 == 0)))',
    'counter = Mutable 0; [set counter 9,1]; g (f (r (counter + 0 == 9)))',
    // A statement whose run is uncertain leaves what it can reach unknown.
    'counter = Mutable 0; m = HashMap [["a",1]]; has "a" m ? set counter 5 : []; g (f (r (counter + 0 == 5)))',
    'counter = Mutable 0; other = Mutable 7; bumpC x = set counter (counter + 1); scope <- Dynamic env; m = HashMap [["a",1]]; has "a" m ? scope.bumpC 0 : []; g (f (r (counter + 0 == 1)))',
    'counter = Mutable 0; other = Mutable 7; bumpO x = set other 1; scope <- Dynamic env; m = HashMap [["a",1]]; has "a" m ? scope.bumpO 0 : []; g (f (r (other + 0 == 7)))',
    // A key names the binding it is, wherever the view is used; one the
    // checker does not know (a parameter, a local, a rebound name, a cell's
    // contents) can name any binding.
    'counter = Mutable 0; other = Mutable 7; bumpO x = set other 1; scope <- Dynamic env; key = "bumpO"; m = HashMap [["a",1]]; has "a" m ? (scope key) 0 : []; g (f (r (other + 0 == 7)))',
    'counter = Mutable 0; other = Mutable 7; bumpC x = set counter 1; bumpO x = set other 1; scope <- Dynamic env; key = "bumpC"; call key = (scope key) 0; m = HashMap [["a",1]]; has "a" m ? call "bumpO" : []; g (f (r (other + 0 == 7)))',
    'counter = Mutable 0; other = Mutable 7; bumpC x = set counter 1; bumpO x = set other 1; scope <- Dynamic env; key = "bumpC"; m = HashMap [["a",1]]; has "a" m ? (key -> (scope key) 0) "bumpO" : []; g (f (r (other + 0 == 7)))',
    'counter = Mutable 0; other = Mutable 7; bumpC x = set counter 1; bumpO x = set other 1; scope <- Dynamic env; key = "bumpC"; m = HashMap [["a",1]]; has "a" m ? { key = "bumpO"; (scope key) 0 } : []; g (f (r (other + 0 == 7)))',
    'counter = Mutable 0; other = Mutable 7; bumpC x = set counter 1; bumpO x = set other 1; scope <- Dynamic env; key = "bumpC"; key = "bumpO"; m = HashMap [["a",1]]; has "a" m ? (scope key) 0 : []; g (f (r (other + 0 == 7)))',
    'counter = Mutable 0; other = Mutable 7; bumpO x = set other 1; scope <- Dynamic env; pick = Mutable "bumpC"; set pick "bumpO"; m = HashMap [["a",1]]; has "a" m ? (scope (pick + "")) 0 : []; g (f (r (other + 0 == 7)))',
    // A function held by a pattern binding runs its body where it is called.
    'counter = Mutable 0; other = Mutable 7; hb <- (x -> { set other 1; 0 }); hb 0; g (f (r (other + 0 == 7)))',
    'counter = Mutable 0; other = Mutable 7; hs <- [x -> { set other 1; 0 }]; (head hs) 0; g (f (r (other + 0 == 7)))',
    'counter = Mutable 0; other = Mutable 7; pick n = n > 0 ? (x -> { set other 1; 0 }) : (x -> 0); hb <- pick 1; m = HashMap [["a",1]]; has "a" m ? hb 0 : 0; g (f (r (other + 0 == 7)))',
    'counter = Mutable 0; other = Mutable 7; [ha,hb] <- [(x -> 0),(x -> { set other 1; 0 })]; hb 0; g (f (r (other + 0 == 7)))',
    // Through local keys and stored or passed views alike; a use the checker
    // cannot follow (a parameter key, computing with or taking apart a value
    // that may be a view, an unknown function given one, a local scope's view
    // used elsewhere) reaches everything.
    'counter = Mutable 0; other = Mutable 7; bumpC x = set counter 1; bumpO x = set other 1; scope <- Dynamic env; m = HashMap [["a",1]]; has "a" m ? { k = "bumpO"; (scope k) 0 } : []; g (f (r (other + 0 == 7)))',
    'counter = Mutable 0; other = Mutable 7; bumpC x = set counter 1; bumpO x = set other 1; scope <- Dynamic env; m = HashMap [["a",1]]; has "a" m ? { k <- "bump"; j = k ++ "O"; (scope j) 0 } : []; g (f (r (other + 0 == 7)))',
    'counter = Mutable 0; other = Mutable 7; bumpC x = set counter 1; bumpO x = set other 1; scope <- Dynamic env; m = HashMap [["a",1]]; k = "bumpO"; has "a" m ? { (scope k) 0; k = "bumpC" } : []; g (f (r (other + 0 == 7)))',
    'counter = Mutable 0; other = Mutable 7; bumpC x = set counter 1; bumpO x = set other 1; scope <- Dynamic env; m = HashMap [["a",1]]; has "a" m ? { k = "bumpC"; k = "bumpO"; (scope k) 0 } : []; g (f (r (other + 0 == 7)))',
    'counter = Mutable 0; other = Mutable 7; bumpC x = set counter 1; bumpO x = set other 1; scope <- Dynamic env; m = HashMap [["a",1]]; has "a" m ? { [k] = ["bumpO"]; (scope k) 0 } : []; g (f (r (other + 0 == 7)))',
    'counter = Mutable 0; other = Mutable 7; bumpC x = set counter 1; bumpO x = set other 1; scope <- Dynamic env; m = HashMap [["a",1]]; rr <- [s: scope]; has "a" m ? (rr.s "bumpO") 0 : []; g (f (r (other + 0 == 7)))',
    'counter = Mutable 0; other = Mutable 7; bumpC x = set counter 1; bumpO x = set other 1; scope <- Dynamic env; m = HashMap [["a",1]]; box = Mutable [scope]; has "a" m ? ((head box) "bumpO") 0 : []; g (f (r (other + 0 == 7)))',
    'counter = Mutable 0; other = Mutable 7; bumpC x = set counter 1; bumpO x = set other 1; scope <- Dynamic env; m = HashMap [["a",1]]; pick = (v -> v); has "a" m ? ((pick scope) "bumpO") 0 : []; g (f (r (other + 0 == 7)))',
    'counter = Mutable 0; other = Mutable 7; bumpC x = set counter 1; bumpO x = set other 1; scope <- Dynamic env; m = HashMap [["a",1]]; fs = [(x -> (scope "bumpO") x)]; has "a" m ? (head fs) 0 : []; g (f (r (other + 0 == 7)))',
    'counter = Mutable 0; other = Mutable 7; bumpC x = set counter 1; bumpO x = set other 1; scope <- Dynamic env; m = HashMap [["a",1]]; via v = ((Dynamic v) "bumpO") 0; has "a" m ? via scope : []; g (f (r (other + 0 == 7)))',
    'counter = Mutable 0; other = Mutable 7; bumpC x = set counter 1; bumpO x = set other 1; scope <- Dynamic env; m = HashMap [["a",1]]; via2 v k = ((Dynamic v) k) 0; has "a" m ? via2 scope "bumpC" : []; g (f (r (counter + 0 == 0)))',
    'counter = Mutable 0; other = Mutable 7; bumpC x = set counter 1; bumpO x = set other 1; scope <- Dynamic env; m = HashMap [["a",1]]; add1 v = v + 1; has "a" m ? add1 scope : []; g (f (r (counter + 0 == 0)))',
    'counter = Mutable 0; other = Mutable 7; bumpC x = set counter 1; bumpO x = set other 1; scope <- Dynamic env; m = HashMap [["a",1]]; m2 v = match v [[bumpO: h] -> h 0]; has "a" m ? m2 scope : []; g (f (r (counter + 0 == 0)))',
    'counter = Mutable 0; other = Mutable 7; bumpC x = set counter 1; bumpO x = set other 1; scope <- Dynamic env; m = HashMap [["a",1]]; rr2 <- [_: scope]; has "a" m ? rr2.bumpC 0 : []; g (f (r (counter + 0 == 0)))',
    'counter = Mutable 0; other = Mutable 7; bumpC x = set counter 1; bumpO x = set other 1; scope <- Dynamic env; m = HashMap [["a",1]]; apply2 h = h scope; has "a" m ? apply2 (v -> ((Dynamic v) "bumpC") 0) : []; g (f (r (counter + 0 == 0)))',
    'counter = Mutable 0; other = Mutable 7; bumpC x = set counter 1; bumpO x = set other 1; scope <- Dynamic env; m = HashMap [["a",1]]; mk y = { bumpL = (x -> set other 1); Dynamic env }; lv <- mk 0; has "a" m ? (lv "bumpL") 0 : []; g (f (r (counter + 0 == 0)))',
    'counter = Mutable 0; other = Mutable 7; scope <- Dynamic env; scope.other = Mutable 1; g (f (r (other + 0 == 7)))',
    'counter = Mutable 0; other = Mutable 7; ns = [bump: (x -> set other 3)]; use ns; m = HashMap [["a",1]]; has "a" m ? bump 0 : []; g (f (r (other + 0 == 7)))',
    'counter = Mutable 0; other = Mutable 7; ns = [bump: (x -> set counter 3)]; use ns; m = HashMap [["a",1]]; has "a" m ? bump 0 : []; g (f (r (counter + 0 == 0)))',
    'counter = Mutable 0; snap = counter + 0; set counter 4; g (f (r (snap + 0 == 0)))',
    'counter = Mutable 0; snap = counter + 0; set counter 4; print snap; set counter 9; g (f (r (snap + 0 == 9)))',
    'counter = Mutable 0; init = set counter 5; init; set counter 1; init; g (f (r (counter + 0 == 1)))',
]) Deno.test(`cells written after reads stay checked: ${source}`, () => rejected(session(), `${effectPrelude}; ${source}`));
// Env views, keys and stored views carry over to later REPL inputs.
Deno.test("an env view from an earlier REPL input reaches the bindings it names", () => {
    const i = session();
    run(i, `${effectPrelude}; scope <- Dynamic env; key = "bumpO"; call x = (scope key) x; []`);
    const later = (call: string) => `counter = Mutable 0; other = Mutable 7; bumpC x = set counter 1; bumpO x = set other 1; m = HashMap [["a",1]]; has "a" m ? ${call} : []; g (f (r (other + 0 == 7)))`;
    if (run(i, later("[]")) !== "0") throw new Error("unrelated statement");
    if (run(i, later("scope.bumpC 0")) !== "0") throw new Error("literal field");
    if (run(i, later('(scope "bumpC") 0')) !== "0") throw new Error("literal key");
    rejected(i, later("(scope key) 0"));
    rejected(i, later("call 0"));
    if (run(i, 'counter = Mutable 0; bumpC x = set counter 1; scope.bumpC 0; g (f (r (counter + 0 == 1)))') !== "0") throw new Error("followed");
    // The key as rebound by the later input.
    run(i, 'key = "bumpC"');
    if (run(i, later("call 0")) !== "0") throw new Error("rebound key");
    run(i, 'key = "bumpO"');
    rejected(i, later("call 0"));
    // Through a name a later input bound using the view.
    run(i, 'callWith k = (scope k) 0; ((Int -> Int) hidden) <- (Dynamic (x -> seq ((scope "bumpO") x) 0))');
    rejected(i, later('callWith "bumpO"'));
    rejected(i, later("hidden 0"));
    // A name rebound to something else is no longer a view.
    run(i, 'scope = [bumpC: (x -> 5)]');
    rejected(i, 'counter = Mutable 0; bumpC x = set counter 1; print (scope.bumpC 0); g (f (r (counter + 0 == 1)))');
});
Deno.test("a view an earlier REPL input stored reaches what its uses name", () => {
    const i = session();
    run(i, `${effectPrelude}; scope <- Dynamic env; []`);
    run(i, "box = Mutable [scope]; []");
    const later = (call: string) => `counter = Mutable 0; other = Mutable 7; bumpO x = set other 1; m = HashMap [["a",1]]; has "a" m ? ${call} : []; g (f (r (other + 0 == 7)))`;
    if (run(i, later("[]")) !== "0") throw new Error("unrelated statement");
    rejected(i, later('((head box) "bumpO") 0'));
    if (run(i, later('((head box) "bumpC") 0').replace("bumpO x", "bumpC x = set counter 1; bumpO x")) !== "0") throw new Error("stored view");
});
for (const source of ['x:xs = []', 'x:y:z = [1]', 'f n = { x:xs = []; x }']) Deno.test(`a cons binding of a list known too short is rejected: ${source}`, () => rejected(session(), source));
Deno.test("an unknown constructor in a pattern is named, with the module that declares it", () => {
    for (const [source, message, hint] of [
        ["func (Some x):xs = print [x,xs]", "unknown constructor 'Some' in a pattern", 'add import "option"'],
        ["print None", "unbound variable 'None'", 'add import "option"'],
        ["Maybe a = Just a | Nothing; k (Jsut x) = x", "unknown constructor 'Jsut' in a pattern", "did you mean 'Just'?"],
    ]) {
        try { run(session(), source); } catch (error) {
            const e = error as { message: string; hint?: string };
            if (e.message !== message || !e.hint?.includes(hint)) throw new Error(`${source}: ${e.message} (${e.hint})`);
            continue;
        }
        throw new Error(`accepted: ${source}`);
    }
    if (run(session(), 'import "option"; func (Some x):xs = [x,xs]; func [Some 1,None]') !== "[1,[None]]") throw new Error("with the import");
});
Deno.test("a set from an earlier REPL input keeps later cell reads unknown", () => {
    const i = session();
    run(i, `${effectPrelude}; bump c = set c 9`);
    rejected(i, 'g (f (r ((Mutable 5) + 1 == 6)))');
});
// When checking right before a run, readFile and getArgs see the program's
// input; the run reads the same snapshot. Lint and editor checks do not.
const fish = "examples/advent-of-code/samples/fish.input", hill = "examples/advent-of-code/samples/hill.input";
const inputPrelude = `import "io"; ${effectPrelude}`;
Deno.test("readFile is read when checking before a run", () => {
    const actual = run(session(), `${inputPrelude}; g (f (q (words (readFile "${fish}"))))`);
    if (actual !== "0") throw new Error(actual);
    rejected(session(), `${inputPrelude}; g (f (q (words (readFile "${hill}"))))`);
});
Deno.test("getArgs and readInput see the program's arguments", () => {
    const one = session();
    one.programArgs = [fish];
    if (run(one, `${inputPrelude}; g (f (q getArgs))`) !== "0") throw new Error("getArgs");
    if (run(one, `${inputPrelude}; g (f (q (words (readInput []))))`) !== "0") throw new Error("readInput");
    const two = session();
    two.programArgs = [hill, "x"];
    rejected(two, `${inputPrelude}; g (f (q getArgs))`);
});
Deno.test("readStdin is read when the run's stdin is not interactive", () => {
    const check = (stdin: string | undefined) => {
        const c = new CheckingSession();
        c.inputs = { readFile: () => undefined, args: () => [], readStdin: () => stdin };
        try { c.prepare(parse(`${inputPrelude}; g (f (q (words (readStdin []))))`), "."); return true; }
        catch { return false; }
    };
    if (!check("one\n")) throw new Error("one word rejected");
    if (check("one two\n")) throw new Error("two words accepted");
    // A terminal is never read ahead: the value stays unknown.
    if (check(undefined)) throw new Error("unknown stdin decided");
});
Deno.test("checking without a run does not read input", () => {
    let accepted = true;
    try { new CheckingSession().prepare(parse(`${inputPrelude}; g (f (q (words (readFile "${fish}"))))`), "."); }
    catch { accepted = false; }
    if (accepted) throw new Error("lint read the input file");
});
Deno.test("the run reads the file contents the checker saw", () => {
    const i = session();
    const text = Deno.readTextFileSync(fish);
    if (run(i, `import "io"; import "text"; words (readFile "${fish}")`) !== `["${text.trim()}"]`) throw new Error("run");
    // One snapshot per run: the checker's read is the one the run used.
    if (i.inputFile(fish) !== text) throw new Error("snapshot");
});
// Code reads names when it runs, so the checker re-derives it after a rebinding.
for (const [source, expected] of [
    ['c n = n * 2; f x = c x; c s = s ++ "?"; f "a"', '"a?"'],
    ['c s = s ++ "?"; f x = c x; c n = n * 2; f 1', '2'],
    ['c n = n * 2; f x = c x; c s = s ++ "?"; c n = n + 1; f 1', '2'],
    ['c n = n * 2; g = x -> c x; c s = s ++ "?"; g "a"', '"a?"'],
    ['c n = n * 2; f x = c x; c s = s ++ "?"; 1', '1'],
    ['c n = n * 2; y <- c 1; c s = s ++ "?"; y', '2'],
    ['h = { c n = n * 2; f x = c x; c s = s ++ "?"; f "a" }; h', '"a?"'],
] as const) Deno.test(`a reader follows a rebound name: ${source}`, () => {
    if (run(session(), source) !== expected) throw new Error(source);
});
for (const source of [
    'c n = n * 2; f x = c x; c s = s ++ "?"; f 1',
    'c n = n * 2; f x = c x; g y = f y + 1; c s = s ++ "?"; g 1',
    'c n = n * 2; y = c 1; c s = s ++ "?"; y',
    'c n = n * 2; ev 0 = c 0; ev n = od (n - 1); od 0 = 1; od n = ev (n - 1); c s = s ++ "?"; od 3',
    'h = { c n = n * 2; f x = c x; c s = s ++ "?"; f 1 }; h',
]) Deno.test(`a reader of a rebound name is checked against it: ${source}`, () => rejected(session(), source));
// A deferred typed numeric call reports at the call that supplies the value,
// or where it was written when its own definition decides it.
for (const [source, line, column] of [
    ['g (UInt n) = n\nh x = g (-x)\nprint (h 2)', 3, 8],
    ['g (UInt n) = n\nh x = g x\nd y = h "a"', 3, 7],
    ['import "text"\ng (UInt n) = n\nh x = {\n    y = g x\n    z = upper x\n    y\n}', 4, 11],
] as const) Deno.test(`a deferred numeric call reports at line ${line}: ${source}`, () => {
    try { run(session(), source); } catch (error) {
        const { pos } = error as { pos: number };
        const before = source.slice(0, pos).split("\n");
        if (before.length !== line || before[before.length - 1].length + 1 !== column) throw new Error(`at ${before.length}:${before[before.length - 1].length + 1}`);
        return;
    }
    throw new Error("accepted");
});
Deno.test("a broken reader of a broken definition reports the original problem", () => {
    try { run(session(), 'c n = n * 2; a = c 1; b x = a + x; d x = b x; c s = s ++ "?"; d 1'); } catch (error) {
        const { message, hint } = error as { message: string; hint?: string };
        if (!message.startsWith("'d' no longer type-checks: cannot append Int and String")) throw error;
        if (hint !== "'d' reads 'b', which reads 'a', which reads 'c', which was rebound after 'd' was defined") throw new Error(hint);
        return;
    }
    throw new Error("accepted");
});
Deno.test("a reader follows a name rebound by a later REPL input or a load", () => {
    const i = session();
    run(i, 'c n = n * 2; f x = c x; []');
    run(i, 'c s = s ++ "?"; []');
    if (run(i, 'f "a"') !== '"a?"') throw new Error("later input");
    rejected(i, 'f 1');
    const j = session();
    j.sourceDir = new URL("./fixtures/", import.meta.url).pathname;
    run(j, 'load "reload"; twice x = double x; []');
    run(j, 'load "reload-text"; []');
    if (run(j, 'twice "a"') !== '"aa"') throw new Error("load");
    rejected(j, 'twice 1');
});
// A built-in type name on the left declares a typed binding.
for (const [source, expected] of [
    ['Int x = 1; x', '1'],
    ['Float y = 1; y', '1.0'],
    ['String s = "hi"; s ++ "!"', '"hi!"'],
    ['Int x <- 5; x + 1', '6'],
    ['Int x = 2.0; x', '2'],
    ['Int n = -1; n', '-1'],
    ['UInt8 n = 2 * 100; n', '200'],
    ['Float x = -1; x', '-1.0'],
    ['g (Int n) = n; g -1', '-1'],
    ['sqrt -1 + 2', '2+1i'],
    ['g (Int n) = n; k = 1; g -k', '-1'],
    ['g (UInt n) = n; k = 1; g k', '1'],
    ['g (UInt n) = n; h x = g -x; h (-2)', '2'],
    ['g (Int n) = n; h x = g -x; h 2', '-2'],
    ['h x = sqrt -x; h 1', '0+1i'],
    ['h x y = x - y; h 5 2', '3'],
    ['g (UInt n) = n; h x = g (-x); h (-2)', '2'],
    ['g (UInt n) = n; h x = g x; h 2', '2'],
    ['g (Int n) = n; h x = g x + 1; h 2', '3'],
    ['g (Float n) = n; h x = g x; h 1', '1.0'],
    ['g (UInt n) = n; h x = g (-x); d y = h y; 1', '1'],
    ['Pt = [x: Float, y: Float]; g (Pt p) = p.x; h x = g x; h [1,2]', '1.0'],
    ['Pt = [x: UInt, y: UInt]; g (Pt p) = p.x; h x = g [x,-x]; h 0', 'UInt 0'],
    ['Pt = [x: Float, y: Float]; g (Pt p) = p.y; h x = g [x,x]; h 2', '2.0'],
    ['g ((Int -> Int) f) = f 1; h x = g x; h (+ 1)', '2'],
    ['f y = { Float x = y; x * 2 }; f 1.5', '3.0'],
] as const) Deno.test(`typed binding: ${source}`, () => {
    if (run(session(), source) !== expected) throw new Error(source);
});
for (const source of ['Int x = "a"', 'Int x = 2.5', 'Int8 x = 300', 'Int x = 1; x = "a"', 'Int x = 1; x = 2.5',
    'UInt n = -1', 'UInt n = (-1)', 'Int n = -2.5', 'UInt n = 0 - 1', 'k = 100; UInt8 n = k * 3', 'g (UInt n) = n; g (-1)',
    'g (UInt n) = n; g -1', 'g (UInt n) = n; g - 1', 'g (Int n) = n; g -2.5',
    'g (UInt8 n) = n; k = 1; g -k', 'g (UInt n) = n; k = 1; g (-k)', 'g (UInt n) = n; g (0 - 1)', 'g (UInt8 n) = n; k = 100; g (k * 3)',
    'g (UInt n) = n; h x = g -x; h 2', 'g (UInt n) = n; h x = g -x; d y = h (y * 2); d 1',
    'g (UInt n) = n; h x = g (-x); h 2', 'g (UInt n) = n; h x = g x; h (-2)', 'g (UInt n) = n; h x = g x; h "a"',
    'g (Int n) = n; h x = g x; h 2.5', 'g (UInt n) = n; h x = g (-x); d y = h (y * 2); d 1',
    'g (UInt n) = n; h x = g (-x); d y = h 2; 1', 'g (UInt n) = n; h x = g x; d y = h "a"; 1',
    'import "text"; g (UInt n) = n; h x = { y = g x; z = upper x; y }; 1',
    'Pt = [x: UInt, y: UInt]; g (Pt p) = p.x; h x = g [x,-x]; h 2', 'Pt = [x: UInt, y: UInt]; g (Pt p) = p.x; h x = g x; h [2,-2]',
    'Pt = [x: Float, y: Float]; g (Pt p) = p.x; h x = g x; h [1]', 'g ((Int -> Int) f) = f 1; h x = g x; h 5', 'g (String s) = s; h x = g x; h 1']) {
    Deno.test(`typed binding rejects: ${source}`, () => rejected(session(), source));
}
for (const source of ['Int = 5', 'Int x y = 5']) Deno.test(`a built-in type name is not redefined: ${source}`, () => {
    try { parse(source); } catch (error) { if (String(error).includes("built-in type names cannot be reassigned")) return; throw error; }
    throw new Error("parsed");
});
