import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

for (const [source, expected] of [
    ['typeOf [1,2,3,4]', '[Int]'],
    ['typeOf []', '[?]'],
    ['typeOf [1,"hello"]', '[Int | String]'],
    ['typeOf [[1,2],[3]]', '[[Int]]'],
    ['typeOf [1,missing]', '[?]'],
    ['typeOf [1..]', '[Int]'],
    ['typeOf [.1,.2..]', '[Float]'],
    ['f (Int x) = x; typeOf f', 'Int -> Int'],
    ['f (Int x) (String y) = y; typeOf f', 'Int -> String -> String'],
    ['f (Int x) (String y) = y; typeOf (f 1)', 'String -> String'],
    ['typeOf (x -> print x)', '? -> Unit'],
    ['f 0 = 1; f 1 = 2; typeOf f', 'Int -> Int'],
    ['f 0 = 1; f 1 = "no"; typeOf f', 'Int -> Int | String'],
    ['Option a = Some a | None; f (Some x) = x; f None = 0; typeOf f', 'Option -> ?'],
    ['f x = f x; typeOf f', '? -> ?'],
    ['typeOf (typeOf [1])', 'Type'],
    ['[typeOf [1] == List, isType (typeOf [1]) ["hi"]]', '[true, true]'],
    ['f x = x; [typeOf f == Function, isType (typeOf f) (x -> 1)]', '[true, true]'],
    ['count = Mutable 0; action x = set count 1; typeOf action; count', '0'],
    ['count = Mutable 0; typeOf [set count 1]; count', '0'],
    ['f x = fail "do not call"; typeOf f', '? -> ?'],
    ['xs = 1:xs; typeOf xs', '[?]'],
] as const) Deno.test(`type description: ${source}`, () => {
    const i = new Interpreter();
    const actual = i.renderString(i.run(parseDocument(source)));
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
