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
const modeled = definitionsOf(prelude).filter(d => [...MODELED].some(name => d.startsWith(name + " "))).join("\n");
const definitions = [blocks("Lists")[0], ...blocks("Truth, operators and indexing").slice(0, 2)].map(named).join("\n") + "\n" + modeled;
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
