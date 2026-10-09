import { Interpreter } from "../src/interp.ts";
import { parse } from "../main.ts";

const cases: [string, string][] = [
    ["takeWhile (x -> 1) [1]", "[1]"],
    ['head (reverse [1..10000])', '10000'],
    ['length (reverse [1..10000])', '10000'],
    ['reverse (reverse [1,2,3])', '[1,2,3]'],
    ['reverse [1,2,3]', '[3,2,1]'],
    ['reverse []', '[]'],
    ['reverse ""', '""'],
    ['head (reverse [missing,2])', '2'],
    ['lookup 1 (frequencies (replicate 1000 1))', '1000'],
    ['compose (*2) (+1) 4', '10'],
    ['uncurry (+) [2,3]', '5'],
    ['withDefault missing (Some 42)', '42'],
    ['mapOption (*2) (Some 3)', 'Some 6'],
    ['mapOption missing None', 'None'],
    ['mapResult (*2) (Ok 3)', 'Ok 6'],
    ['mapError upper (Err "oops")', 'Err "OOPS"'],
    ['take 5 (repeat 7)', '[7,7,7,7,7]'],
    ['take 7 (cycle [1,2,3])', '[1,2,3,1,2,3,1]'],
    ['cycle []', '[]'],
    ['take 5 (concatMap (x -> [x,x]) [1..])', '[1,1,2,2,3]'],
    ['take 5 (scanl (+) 0 [1..])', '[0,1,3,6,10]'],
    ['all (x -> x < 10000) [0..9999]', 'true'],
    ['any (==3) [1..]', 'true'],
    ['find (==9999) [0..]', 'Some 9999'],
    ['find (==9) [1,2]', 'None'],
    ['findIndex (==8) [4,8,9]', 'Some 1'],
    ['headOption []', 'None'],
    ['lastOption [1,2,3]', 'Some 3'],
    ['atOption 4 [1]', 'None'],
    ['takeWhile (<4) [1..]', '[1,2,3]'],
    ['head (dropWhile (<10000) [0..])', '10000'],
    ['chunksOf 2 [1..5]', '[[1,2],[3,4],[5]]'],
    ['intersperse 0 [1,2,3]', '[1,0,2,0,3]'],
    ['partition isEven [1..5]', '[[2,4],[1,3,5]]'],
    ['unique [3,1,3,2,1]', '[3,1,2]'],
    ['sortOn fst [[2,"b"],[1,"a"],[2,"c"]]', '[[1,"a"],[2,"b"],[2,"c"]]'],
    ['minimum []', 'None'],
    ['factorial 20', '2432902008176640000'],
    ['factorial 3.0', '6'],
    ['mean [1,2]', 'Some 3/2'],
    ['variance [1,2,3]', 'Some 2/3'],
    ['median [9,1,2,8]', 'Some 5'],
    ['mean []', 'None'],
    ['take 10 fibonacci', '[0,1,1,2,3,5,8,13,21,34]'],
    ['take 10 primes', '[2,3,5,7,11,13,17,19,23,29]'],
    ['reverse "a😀b"', '"b😀a"'],
    ['textLength "a😀b"', '3'],
    ['textTake 2 "a😀b"', '"a😀"'],
    ['words " a\t b\r\n c "', '["a","b","c"]'],
    ['joinWith "/" ["a","b"]', '"a/b"'],
    ['startsWith "ab" "abc"', 'true'],
    ['endsWith "😀" "a😀"', 'true'],
    ['getOr 9 "x" (HashMap [])', '9'],
    ['getOption "x" (HashMap [])', 'None'],
    ['getOr missing "x" (HashMap [x: 2])', '2'],
    ['lookup "a" (frequencies ["a","b","a"])', '2'],
    ['lookup "a" (mergeWith (+) (HashMap [a: 2]) (HashMap [a: 3]))', '5'],
    ['lookup 1 (groupBy (x -> x % 2) [1..5])', '[1,3,5]'],
    ['pairs (filterMap (key value -> value > 2) (HashMap [a: 1, b: 3]))', '[["b",3]]'],
];
for (const [source, expected] of cases) Deno.test(`std: ${source}`, () => {
    const i = new Interpreter();
    i.run(parse('import ["function","option","sequence","number","text","map"]'));
    const actual = i.renderString(i.run(parse(source)));
    if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
});
for (const [source, message] of [
    ['chunksOf 0 [1]', 'positive size'],
    ['sortBy (x y -> true) [2,1]', 'integer'],
    ['fromChars [1]', 'Char'],
    ['factorial (-1)', 'non-negative'],
    ['import "missing"', 'unknown module'],
    ['import 123', 'string'],
]) Deno.test(`std rejects: ${source}`, () => {
    const i = new Interpreter();
    i.run(parse('import ["sequence","number","text"]'));
    try { i.renderString(i.run(parse(source))); }
    catch (error) {
        if (error instanceof Error && error.message.includes(message)) return;
        throw error;
    }
    throw new Error(`Expected ${message}`);
});
Deno.test("imports are cached, isolated from caller bindings, and independent of source directory", () => {
    const i = new Interpreter();
    i.sourceDir = "/unrelated/directory";
    i.run(parse('sum xs = 999\nimport "number"'));
    if (i.renderString(i.run(parse('mean [1,2]'))) !== 'Some 3/2') throw new Error("caller leaked into module");
    const first = i.importStandard("sequence");
    if (i.importStandard("sequence") !== first) throw new Error("import did not reuse module");
    i.run(parse('s = import "sequence"'));
    if (i.renderString(i.run(parse('s.takeWhile (<3) [1..]'))) !== '[1,2]') throw new Error("native export missing");
});

Deno.test("a bare import does not echo an infinite export record", () => {
    const i = new Interpreter();
    if (i.run(parse('import "function"')).kind !== "list") throw new Error("import must be quiet");
});
Deno.test("standard natives require importing their module", () => {
    const i = new Interpreter();
    if (i.env.get("words") !== undefined) throw new Error("stdlib leaked into builtins");
    i.run(parse('import "text"'));
    if (i.renderString(i.run(parse('words "a b"'))) !== '["a","b"]') throw new Error("missing export");
});

Deno.test("reverse uses APN typed clauses and is available from either module", () => {
    for (const module of ["sequence", "text"]) {
        const i = new Interpreter();
        i.importStandard(module);
        const fn = i.demand(i.env.get("reverse")!);
        if (fn.kind !== "clauseFn") throw new Error("reverse must use typed APN overloads");
        if (i.renderString(i.run(parse('reverse "a😀b"'))) !== '"b😀a"') throw new Error(module);
        if (i.env.get("textReverse") !== undefined) throw new Error("obsolete prefixed helper");
    }
});

for (const eager of ['=', '<-']) {
    for (const cached of [false, true]) Deno.test(`selective import ${eager}, cached ${cached}`, () => {
        const i = new Interpreter();
        if (cached) i.importStandard('system', false);
        const before = new Set(i.env.map.keys());
        i.run(parse(`[halt] ${eager} import "system"`));
        const added = [...i.env.map.keys()].filter(name => !before.has(name));
        if (JSON.stringify(added) !== '["halt"]') throw new Error(`leaked exports: ${added}`);
        if (!i.env.get('halt')) throw new Error('missing selected export');
        i.run(parse('import "number"'));
        if (!i.env.get('fibonacci')) throw new Error('bare import must still open exports');
    });
}
Deno.test('selective imports rename fields and preserve unselected bindings', () => {
    const i = new Interpreter();
    i.run(parse('fibonacci = 123; [halt: stop] = import "system"'));
    if (!i.env.get('stop') || i.env.get('halt')) throw new Error('wrong selected names');
    if (i.renderString(i.run(parse('fibonacci'))) !== '123') throw new Error('overwrote unselected binding');
});
Deno.test('failed selective imports leave the caller scope intact', () => {
    const i = new Interpreter();
    const before = [...i.env.map.keys()].join(',');
    let failed = false;
    try { i.run(parse('[missingExport] = import "function"')); } catch { failed = true; }
    if (!failed || [...i.env.map.keys()].join(',') !== before) throw new Error('failed import leaked names');
});
Deno.test("no two standard modules define the same name", () => {
    // A checked program cannot import two modules that bind one name to
    // different functions (a rebinding must keep its type).
    const owners = new Map<string, string>();
    for (const entry of Deno.readDirSync(new URL("../lib/", import.meta.url))) {
        if (!entry.isFile || !entry.name.endsWith(".apn")) continue;
        const module = entry.name.slice(0, -4);
        for (const statement of parse(Deno.readTextFileSync(new URL(`../lib/${entry.name}`, import.meta.url)), module)) {
            // Instances (fmap, >>=, <*>, return clauses) join a method; they bind no name.
            const instance = statement.t === "def" && ["fmap", ">>=", "<*>", "return"].includes(statement.name) && statement.clauses[0].params.length > 0;
            const names = instance ? [] : statement.t === "def" ? [statement.name]
                : statement.t === "type" ? [statement.def.name, ...statement.def.variants.map(v => v.tag)]
                : statement.t === "patDef" && statement.pattern.p === "var" ? [statement.pattern.name] : [];
            for (const name of names) {
                const owner = owners.get(name);
                if (owner && owner !== module) throw new Error(`'${name}' is defined by both ${owner} and ${module}`);
                owners.set(name, module);
            }
        }
    }
});
Deno.test("html and text import together, in either order", () => {
    for (const source of ['import "html"\nimport "text"', 'import "text"\nimport "html"']) {
        const i = new Interpreter();
        i.enableChecking();
        i.run(parse(source));
        if (i.renderString(i.run(parse('[splitWhile (< 3) [1,2,3],upper "a"]'))) !== '[[[1,2],[3]],"A"]') throw new Error(source);
    }
});
