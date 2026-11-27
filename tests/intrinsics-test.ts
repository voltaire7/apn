// docs/intrinsics.md defines natives in APN: each definition, renamed so it
// does not join the native (map f xs becomes myMap f xs), gives what the
// native does on the same inputs, run unchecked.
import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
import { MODELED } from "../src/natives.ts";

const doc = Deno.readTextFileSync(new URL("../docs/intrinsics.md", import.meta.url));
// The APN blocks of a section, by its heading.
const blocks = (heading: string): string[] => {
    const section = doc.split(/^## /m).find(s => s.startsWith(heading + "\n"));
    if (!section) throw new Error(`no section ${heading}`);
    return [...section.matchAll(/```apn\n(.*?)```/gs)].map(m => m[1]);
};
// A block's definitions, each with the lines that continue it.
const definitionsOf = (block: string): string[] => block.split(/\n(?=[^\s\]}])/);
// Its definitions of named functions (not operators, a.b or a type's).
const named = (block: string): string =>
    definitionsOf(block).filter(d => /^[a-z][A-Za-z]* /.test(d) && !/^[a-z]+ (&&|\|\||\$|\+\+|>>=|<\*>) /.test(d)).join("\n");
// The natives the prelude defines (MODELED) are tested by its definitions.
const prelude = Deno.readTextFileSync(new URL("../lib/prelude.apn", import.meta.url));
const modeled = definitionsOf(prelude).filter(d => [...MODELED.keys()].some(name => d.startsWith(name + " "))).join("\n");
const definitions = blocks("Truth, operators and indexing").slice(0, 2).map(named).join("\n") + "\n" + modeled;
const names = [...new Set([...definitions.matchAll(/^([a-z][A-Za-z]*) /gm)].map(m => m[1]))];
const own = new RegExp(`(?<![\\w.])(${names.join("|")})\\b`, "g");
const renamed = (source: string) => source.replace(own, (_, n: string) => `my${n[0].toUpperCase()}${n.slice(1)}`);
const header = 'std <- import "std"\n[..] = std.function\n';
const run = (source: string): string => {
    try { const i = new Interpreter(); return i.renderString(i.run(parseDocument(source))); }
    catch (error) { return `error: ${(error as Error).message.split("\n")[0]}`; }
};

const cases = [
    "head [1,2]", 'head [1, fail "x"]', "tail [1,2]", "null []", "null [1]", 'null ""', "null ([] : HashMap _ _)", "null 5", "null (1 / 2)", "null [a = 1]",
    "length [1,2,3]", 'length "abc"', "length ([[\"a\", 1]] : HashMap _ _)",
    "take 2 [1,2,3]", "take 0 [fail 1]", "take 5 [1,2]", "take 2 (map (* 2) [1..])", "drop 1 [1,2,3]", "drop 5 [1,2]",
    "filter (x -> x > 1) [1,2,3]", "filter (x -> 1) [1,2]", "take 2 (filter (> 2) [1..])",
    "foldl (+) 0 [1,2,3]", "foldl (acc, x -> x :: acc) [] [1,2,3]", "foldr (x, acc -> x :: acc) [] [1,2]", "foldr (x, acc -> x) 0 [1..]",
    "zipWith (+) [1,2,3] [10,20]", "take 2 (zipWith (+) [1..] [1..])", "take 3 (iterate (* 2) 1)",
    "enumerate [5,6]", "take 2 (enumerate [1..])",
    "keys ([[\"a\", 1], [\"b\", 2]] : HashMap _ _)", "values ([[\"a\", 1]] : HashMap _ _)", 'has "a" ([["a", 1]] : HashMap _ _)', 'has "z" ([["a", 1]] : HashMap _ _)',
    'lookup "a" ([["a", 1]] : HashMap _ _)', 'remove "a" ([["a", 1], ["b", 2]] : HashMap _ _)',
    'pairs (insert [[1, "z"], [2, "b"]] ([[1, "a"], [3, "c"]] : HashMap _ _))', "insert [[\"b\", 2]] ([[\"a\", 1]] : HashMap _ _)",
    ...["True", "False", "0", "0.0", "0.5", '""', '"a"', "[]", "[1]", "[a = 1]", "([] : HashMap _ _)", "(1 / 2)", "(0.0 / 0.0)",
        "(makeRectangular 0 1)", "'a'", "Int"].map(x => `truthy ${x}`),
    "negate 5", "negate 1.5",
    "get [1,2,3] 0", "get [1,2,3] 2", "get [1,2,3] -1", "get [1,2,3] -3", "get [1..] 5",
    "with [1,2,3] 1 9", "with [1,2,3] -1 9", "with [1,2,3] 0 9",
];
for (const source of cases) Deno.test(`intrinsics.md defines ${source.split(" ")[0]} as the native: ${source}`, () => {
    const native = run(header + source), defined = run(header + renamed(definitions) + "\n" + renamed(source));
    if (native !== defined) throw new Error(`native ${native}, defined ${defined}`);
});
// The errors agree but for wording.
for (const source of ["head []", "tail []", 'lookup "z" ([["a", 1]] : HashMap _ _)', "get [1,2,3] 3", "get [1,2,3] -4", "with [1,2,3] 3 9"]) {
    Deno.test(`intrinsics.md's ${source.split(" ")[0]} fails where the native does: ${source}`, () => {
        const native = run(header + source), defined = run(header + renamed(definitions) + "\n" + renamed(source));
        if (!native.startsWith("error:") || !defined.startsWith("error:")) throw new Error(`native ${native}, defined ${defined}`);
    });
}

// String = List Char: a String is its characters, run and checked alike.
import { APNError } from "../src/errors.ts";
for (const checked of [false, true]) {
    for (const [source, expected] of [
        ['head "hi"', "'h'"], ['tail "abc"', '"bc"'], ['"hi" 1', "'i'"], ['"hi" -1', "'i'"],
        ['"hi" == [\'h\',\'i\']', "True"], ['"" == []', "True"], ["typeOf \"hi\"", "String"],
        ['f (c :: cs) = cs; f "abc"', '"bc"'], ['f [a,b] = b; f "ab"', "'b'"], ['f [] = 0; f _ = 1; [f "", f "a"]', "[0,1]"],
        ['map (c -> c + 1) "abc"', "['b','c','d']"], ['length "abc"', "3"], ['"ab" ++ "cd"', '"abcd"'],
        // A String joined with Chars is a String; with other items, a list.
        ['"ab" ++ [\'c\']', '"abc"'], ['"ab" ++ [1]', "['a', 'b', 1]"], ['"ab" + 1', "['b','c']"],
        ['x = "abc"; x 0 = \'z\'; x', '"zbc"'], ['f (xs : List Char) = typeOf xs; f "ab"', "String"],
        ['f (s : String) = s ++ "!"; f [\'a\',\'b\']', '"ab!"'], ['([\'h\',\'i\'] : String)', '"hi"'],
        ['f (xs : List a) = a; f "abc"', "Char"], ['isType (List Char) "ab"', "True"],
        // The check runs library code on known Strings as on lists: "" is [].
        ['onlyOne [a] = a; onlyOne (filter (x -> x != "") [[], "a"])', '"a"'],
        ['onlyOne [a] = a; onlyOne (map (c -> c) "a")', "'a'"],
        ['onlyOne [a] = a; [onlyOne (take 1 "ab"), onlyOne (drop 1 "ab")]', "['a','b']"],
    ]) Deno.test(`String (checked=${checked}): ${source}`, () => {
        const i = new Interpreter();
        if (checked) i.enableChecking();
        const shown = i.renderString(i.run(parseDocument(source)));
        if (shown !== expected) throw new Error(`expected ${expected}, got ${shown}`);
    });
    for (const source of ['f [a,b] = b; f "abc"', '"old" "new"', 'x = "abc"; x 0 = True']) {
        Deno.test(`String rejects (checked=${checked}): ${source}`, () => {
            const i = new Interpreter();
            if (checked) i.enableChecking();
            try { i.run(parseDocument(source)); } catch (error) { if (error instanceof APNError) return; throw error; }
            throw new Error("accepted");
        });
    }
}

// A named subtype of String is a String with its name: a list of its
// characters, which ++ keeps the name of (as arithmetic keeps a Count's).
for (const checked of [false, true]) {
    for (const [source, expected] of [
        ['Name = String; n : Name = "ab"; [n ++ "c", typeOf (n ++ "c")]', '["abc",Name]'],
        ['Name = String; n : Name = "ab"; "x" ++ n', '"xab"'],
        ['Name = String; n : Name = "ab"; [head n, length n, n 1]', "['a', 2, 'b']"],
        ['Name = String; f (c :: cs) = cs; n : Name = "ab"; f n', '"b"'],
        // A function whose result has its parameter's type gives the name back;
        // map, whose result is another list type, does not.
        ['Name = String; n : Name = "abc"; [take 2 n, typeOf (take 2 n)]', '["ab",Name]'],
        ['Name = String; n : Name = "abc"; typeOf (filter (c -> c != \'b\') n)', 'Name'],
        ['[take 2 "abc", typeOf (take 2 "abc"), \'x\' :: "yz"]', '["ab",String,"xyz"]'],
        ['map (c -> c) "ab"', "['a','b']"],
        // A value carries its name; ++ takes the first a side carries, left to
        // right, reading no side to find it, so cycle of a String is one.
        ["['h','i']", "['h','i']"],
        ['std <- import "std"; [..] = std.sequence; [take 5 (cycle "ab"), typeOf (take 5 (cycle "ab")), head (cycle "xy")]', '["ababa", String, \'x\']'],
        ['std <- import "std"; [..] = std.sequence; take 20 (cycle "THE END IS NEVER ")', '"THE END IS NEVER THE"'],
        ['[[1] ++ "ab", [\'a\'] ++ "bc"]', "[[1, 'a', 'b'], \"abc\"]"],
        // Any function, written without a type too, gives its argument's name back.
        ['firstTwo s = take 2 s; [firstTwo "abc", typeOf (firstTwo "abc")]', '["ab",String]'],
        // (An argument the call never read gives no name: reverse "ab" is not run.)
        ['std <- import "std"; [..] = std.sequence; pick c xs = c ? [] : xs; pick True (reverse "ab")', "[]"],
        ['Name = String; n : Name = "abc"; f (xs : Vect k a) = k; f n', '3'],
        ['keep (xs : List a) : List a = xs; [keep "ab", typeOf (keep "ab")]', '["ab",String]'],
    ]) Deno.test(`named String (checked=${checked}): ${source}`, () => {
        const i = new Interpreter();
        if (checked) i.enableChecking();
        const shown = i.renderString(i.run(parseDocument(source)));
        if (shown !== expected) throw new Error(`expected ${expected}, got ${shown}`);
    });
    Deno.test(`named Strings of two names do not join (checked=${checked})`, () => {
        const i = new Interpreter();
        if (checked) i.enableChecking();
        try { i.run(parseDocument('Name = String; Tag = String; a : Name = "a"; b : Tag = "b"; a ++ b')); } catch (error) {
            if (String(error).includes("cannot combine")) return;
            throw error;
        }
        throw new Error("accepted");
    });
}
