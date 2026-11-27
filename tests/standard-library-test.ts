import { Interpreter } from "../src/interp.ts";
import { parse } from "../main.ts";
import { isForTypes } from "../src/ast.ts";
import { QUALIFIED_MODULES } from "../src/modules.ts";

const decoded = (type: string, json: string) =>
    `std <- import "std"\n[..] = std.[option,decode]\njson = from JSON ${JSON.stringify(json)}\ndecodeValue ${type} json`;
const cases: [string, string][] = [
    // A type decodes each field by name, as it says, wherever a decoder goes.
    [decoded("(list [n : Int])", '[{"n": 1}, {"n": 2}]'), "Ok [[n = 1], [n = 2]]"],
    [decoded('(field "n" Int)', '{"n": "x"}'), 'Err "Expecting an INT"'],
    [decoded('(at ["a","b"] String)', '{"a": {"b": "x"}}'), 'Ok "x"'],
    [decoded("(map (r -> r.n) (fromType [n : Int]))", '{"n": 7}'), "Ok 7"],
    [decoded("[quote : String, year : Int]", '{"year": 1843, "quote": "q", "x": 0}'), 'Ok [quote = "q", year = 1843]'],
    [decoded("[quote : String, year : Int]", '{"quote": "q"}'), 'Err "Expecting an OBJECT with a field named `year`"'],
    [decoded("[quote : String, year : Int]", '{"quote": "q", "year": "1843"}'), 'Err "Expecting an INT"'],
    [decoded("(fromType [at : [x : Float, y : Float], tags = list string])", '{"at": {"x": 1, "y": 2.5}, "tags": ["a"]}'), 'Ok [at = [x = 1.0, y = 2.5], tags = ["a"]]'],
    [decoded("(fromType [tags = list string])", '{"tags": ["a", 1]}'), 'Err "Expecting a STRING"'],
    [decoded("Bool", "true"), "Ok True"],
    // Parsers read their input in order, as do-blocks (Parsec's way).
    ['std <- import "std"; [..] = std.parser\ndate = {\n    y <- number\n    char \'-\'\n    m <- number\n    return [y,m]\n}\nparse date "2026-10"', "Ok [2026,10]"],
    ['std <- import "std"; [..] = std.parser\nparse number "12x"', 'Err "unexpected \'x\'"'],
    ['std <- import "std"; [..] = std.parser\nparse (sepBy number (char \',\')) "1,22,333"', "Ok [1,22,333]"],
    ['std <- import "std"; [..] = std.parser\nparse (string "hi" <|> string "ho") "ho"', 'Ok "ho"'],
    ['std <- import "std"; [..] = std.parser\nparse (some digit) ""', 'Err "expected one of 0123456789, got the end"'],
    ['std <- import "std"; [..] = std.parser\nparse (many (token (some letter))) "ab cd"', "Ok [['a','b'],['c','d']]"],
    // many reads in a loop: long input parses in constant stack.
    ['std <- import "std"; [..] = std.parser\nvalue (Ok x) = x\nlength (value (parse (many digit) (replicate 20000 (head (to (List Char) "7")))))', "20000"],
    // Any list parses, code included.
    ['std <- import "std"; [..] = std.parser\nparse (some (satisfy "an even number" (n -> n % 2 == 0))) [2,4,5]', 'Err "unexpected 5"'],
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
    ['map (*2) (Some 3)', 'Some 6'],
    ['map missing None', 'None'],
    ['map (*2) (Ok 3)', 'Ok 6'],
    ['mapError upper (Err "oops")', 'Err "OOPS"'],
    ['okOr "empty" (Some 1)', 'Ok 1'],
    ['okOr "empty" None', 'Err "empty"'],
    ['map (to Option) [Ok 1, Err "x"]', '[Some 1, None]'],
    ['[to Option (Some 2), to Option None]', '[Some 2, None]'],
    ['[unwrap (Some 1), unwrap (Ok 2), expect "a" (Some 3), expect "b" (Ok 4)]', '[1,2,3,4]'],
    ['typeOf unwrap', 'Option a | Result a b -> a'],
    // A constructor pattern binds in a block as at the top level.
    ['f n = { Some x = safeDiv 6 n; x }; f 2', '3'],
    ['safeDiv 7 2', 'Some 7/2'],
    ['safeDiv 7 0', 'None'],
    ['safeDiv 7.0 0.0', 'None'],
    ['safeDiv 7 0 == None', 'True'],
    ['take 5 (repeat 7)', '[7,7,7,7,7]'],
    ['take 7 (cycle [1,2,3])', '[1,2,3,1,2,3,1]'],
    ['cycle []', '[]'],
    ['take 5 (concatMap (x -> [x,x]) [1..])', '[1,1,2,2,3]'],
    ['take 5 (scanl (+) 0 [1..])', '[0,1,3,6,10]'],
    ['all (x -> x < 10000) [0..9999]', 'True'],
    ['any (==3) [1..]', 'True'],
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
    ['sortOn fst [[2, "b"], [1, "a"], [2, "c"]]', '[[1, "a"], [2, "b"], [2, "c"]]'],
    // Sorting is dictionary order (compare), not inclusion (<=).
    ['sort ["b","ab","a"]', '["a","ab","b"]'],
    ['sort [[2],[1,2],[1]]', '[[1],[1,2],[2]]'],
    ['[compare "ab" "b", compare [1] [1], compare 3 2]', '[-1,0,1]'],
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
    ['length "a😀b"', '3'],
    ['take 2 "a😀b"', '"a😀"'],
    ['drop 1 "a😀b"', '"😀b"'],
    // A function of a parameter's type gives a String back a String.
    ['typeOf (take 2 "abc")', 'String'],
    ['filter (c -> c != \'b\') "abc"', '"ac"'],
    ["'x' :: \"yz\"", '"xyz"'],
    ['splitOn "," "a,b"', '["a","b"]'],
    ['map (c -> c + 1) "ab"', "['b','c']"],
    ['withDefault 0 (Ok 3)', '3'],
    ['withDefault 0 (Err "no")', '0'],
    ['lines "a\\nb\\n"', '["a","b"]'],
    ['lines "a\\n\\nb"', '["a","","b"]'],
    ["[isDigit '7', isDigit 'x', isSpace ' ']", '[True,False,True]'],
    ['words " a\t b\r\n c "', '["a","b","c"]'],
    ['joinWith "/" ["a","b"]', '"a/b"'],
    ['startsWith "ab" "abc"', 'True'],
    ['endsWith "😀" "a😀"', 'True'],
    ['getOr 9 "x" ([] : HashMap _ _)', '9'],
    ['getOption "x" ([] : HashMap _ _)', 'None'],
    ['getOr missing "x" ([["x", 2]] : HashMap _ _)', '2'],
    ['lookup "a" (frequencies ["a","b","a"])', '2'],
    ['lookup "a" (mergeWith (+) ([["a", 2]] : HashMap _ _) ([["a", 3]] : HashMap _ _))', '5'],
    ['lookup 1 (groupBy (x -> x % 2) [1..5])', '[1,3,5]'],
    ['pairs (filterMap (key, value -> value > 2) ([["a", 1], ["b", 3]] : HashMap _ _))', '[["b", 3]]'],
];
for (const [source, expected] of cases) Deno.test(`std: ${source}`, () => {
    const i = new Interpreter();
    i.run(parse('std <- import "std"\n[..] = std.[function,option,sequence,number,text,map]'));
    const actual = i.renderString(i.run(parse(source)));
    if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
});
for (const [source, message] of [
    ['chunksOf 0 [1]', 'positive size'],
    ['sortBy (x, y -> True) [2,1]', 'integer'],
    ['from (List Char) [1]', 'Char'],
    ['factorial -1', 'non-negative'],
    ['import "missing"', 'unknown module'],
    ['import 123', 'string'],
]) Deno.test(`std rejects: ${source}`, () => {
    const i = new Interpreter();
    i.run(parse('std <- import "std"\n[..] = std.[sequence,number,text]'));
    try { i.renderString(i.run(parse(source))); }
    catch (error) {
        if (error instanceof Error && error.message.includes(message)) return;
        throw error;
    }
    throw new Error(`Expected ${message}`);
});
// unwrap and expect fail with what was missing, showing an Err's error.
for (const [source, message] of [
    ['unwrap (safeDiv 1 0)', 'unwrap: None'],
    ['unwrap (Err "oops")', 'unwrap: Err "oops"'],
    ['expect "no items" None', 'no items'],
    ['expect "parsing" (Err "oops")', 'parsing: "oops"'],
    ['f n = { Some x = safeDiv 6 n; x }; f 0', 'binding pattern did not match'],
]) Deno.test(`std fails: ${source}`, () => {
    const i = new Interpreter();
    i.run(parse('std <- import "std"\n[..] = std.[option,number]'));
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
    i.run(parse('sum xs = 999\nstd <- import "std"; [..] = std.number'));
    if (i.renderString(i.run(parse('mean [1,2]'))) !== 'Some 3/2') throw new Error("caller leaked into module");
    const first = i.importStandard("std/sequence");
    if (i.importStandard("std/sequence") !== first) throw new Error("import did not reuse module");
    i.run(parse('s <- import "std/sequence"'));
    if (i.renderString(i.run(parse('s.takeWhile (<3) [1..]'))) !== '[1,2]') throw new Error("native export missing");
});

Deno.test("a bare import does not echo an infinite export record", () => {
    const i = new Interpreter();
    if (i.run(parse('std <- import "std"; [..] = std.function')).kind !== "list") throw new Error("import must be quiet");
});
Deno.test("standard natives require importing their module", () => {
    const i = new Interpreter();
    if (i.env.get("words") !== undefined) throw new Error("stdlib leaked into builtins");
    i.run(parse('std <- import "std"; [..] = std.text'));
    if (i.renderString(i.run(parse('words "a b"'))) !== '["a","b"]') throw new Error("missing export");
});

Deno.test("reverse uses APN typed clauses and is available from either module", () => {
    for (const module of ["sequence", "text"]) {
        const i = new Interpreter();
        i.run(parse(`std <- import "std"; [..] = std.${module}`));
        const fn = i.demand(i.env.get("reverse")!);
        if (fn.kind !== "clauseFn") throw new Error("reverse must use typed APN overloads");
        if (i.renderString(i.run(parse('reverse "a😀b"'))) !== '"b😀a"') throw new Error(module);
        if (i.env.get("textReverse") !== undefined) throw new Error("obsolete prefixed helper");
    }
});

// A pattern takes the module's record apart, as any record's.
for (const cached of [false, true]) {
    Deno.test(`selective import, cached ${cached}`, () => {
        const i = new Interpreter();
        if (cached) i.importStandard('std/system');
        const before = new Set(i.env.map.keys());
        i.run(parse('[halt] <- import "std/system"'));
        const added = [...i.env.map.keys()].filter(name => !before.has(name));
        if (JSON.stringify(added) !== '["halt"]') throw new Error(`leaked exports: ${added}`);
        if (!i.env.get('halt')) throw new Error('missing selected export');
        i.run(parse('std <- import "std"; [..] = std.number'));
        if (!i.env.get('fibonacci')) throw new Error('[..] must still open exports');
    });
}
Deno.test('selective imports rename fields and preserve unselected bindings', () => {
    const i = new Interpreter();
    i.run(parse('fibonacci = 123; [stop = halt] <- import "std/system"'));
    if (!i.env.get('stop') || i.env.get('halt')) throw new Error('wrong selected names');
    if (i.renderString(i.run(parse('fibonacci'))) !== '123') throw new Error('overwrote unselected binding');
});
Deno.test('failed selective imports leave the caller scope intact', () => {
    const i = new Interpreter();
    const before = [...i.env.map.keys()].join(',');
    let failed = false;
    try { i.run(parse('[missingExport] <- import "std/function"')); } catch { failed = true; }
    if (!failed || [...i.env.map.keys()].join(',') !== before) throw new Error('failed import leaked names');
});
// Modules imported qualified may repeat names (see QUALIFIED_MODULES), and
// playground keeps Elm's Playground names: its words draws text, so a program
// using both imports text qualified.
const QUALIFIED = new Set([...QUALIFIED_MODULES, "playground"]);
Deno.test("no two standard modules define the same name", () => {
    // A checked program cannot import two modules that bind one name to
    // different functions (a rebinding must keep its type).
    const owners = new Map<string, string>(), prelude = new Interpreter();
    for (const entry of Deno.readDirSync(new URL("../lib/", import.meta.url))) {
        if (!entry.isFile || !entry.name.endsWith(".apn")) continue;
        const module = entry.name.slice(0, -4);
        const statements = parse(Deno.readTextFileSync(new URL(`../lib/${entry.name}`, import.meta.url)), module);
        const declared = new Set(statements.flatMap(s => s.t === "type" ? [s.def.name, ...s.def.variants.map(v => v.tag)] : []));
        for (const statement of statements) {
            // Clauses for the module's own types join the function they are
            // named after (map f (Some x) = ..., return = Some); they bind no new name.
            const instance = statement.t === "def" && prelude.env.get(statement.name) !== undefined &&
                isForTypes(statement.clauses, name => declared.has(name), true);
            const names = instance ? [] : statement.t === "def" ? [statement.name]
                : statement.t === "type" ? [statement.def.name, ...statement.def.variants.map(v => v.tag)]
                : statement.t === "patDef" && statement.pattern.p === "var" ? [statement.pattern.name] : [];
            for (const name of names) {
                const owner = owners.get(name);
                if (QUALIFIED.has(module)) continue;
                if (owner && owner !== module) throw new Error(`'${name}' is defined by both ${owner} and ${module}`);
                owners.set(name, module);
            }
        }
    }
});
Deno.test("html and text import together, in either order", () => {
    for (const source of ['std <- import "std"\n[..] = std.[html,text]', 'std <- import "std"\n[..] = std.[text,html]']) {
        const i = new Interpreter();
        i.enableChecking();
        i.run(parse(source));
        if (i.renderString(i.run(parse('[words "a b", upper "a"]'))) !== '[["a","b"], "A"]') throw new Error(source);
    }
});
