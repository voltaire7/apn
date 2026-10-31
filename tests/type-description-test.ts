import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

for (const [source, expected] of [
    ['typeOf (x, y -> x)', 'a -> b -> a'],
    ['typeOf (x -> x)', 'a -> a'],
    ['typeOf (x, y -> y)', 'a -> b -> b'],
    ['typeOf (f, x -> f x)', '(a -> b) -> a -> b'],
    ['typeOf (f, g, x -> f (g x))', '(a -> b) -> (c -> a) -> c -> b'],
    ['typeOf (x -> y -> x)', 'a -> b -> a'],
    ['typeOf (x -> x -> x)', 'a -> b -> b'],
    ['typeOf (x -> [x,x])', 'a -> [a,a]'],
    ['f (x::xs) = x; typeOf f', 'List a -> a'],
    ['typeOf (map (x -> x))', 'f a -> f a'],
    ['typeOf (xs -> map (x -> [x]) xs)', 'f a -> f [a]'],
    ['typeOf (x -> x x)', 'a -> b'],
    ['Option a = Some a | None; f (Some x) = x; f None = None; typeOf f', 'Option (Option a) -> Option a'],
    ['f x = { y = x; y }; typeOf f', 'a -> a'],
    ['f x = { g y = x; g }; typeOf f', 'a -> b -> a'],
    ['f x = x; typeOf (y -> f y)', 'a -> a'],
    ['f (Int32 x) = x; typeOf f', 'Int32 -> Int'],
    // A list's type is exact: its items, as written.
    ['typeOf [1,2,3,4]', '[Int,Int,Int,Int]'],
    ['typeOf []', '[]'],
    ['typeOf [1,"hello"]', '[Int,String]'],
    ['typeOf [[1,2],[3]]', '[[Int,Int],[Int]]'],
    // A list built with '::' is described as its literal would be, without forcing its tail.
    ['typeOf ([1,2]::[3,4])', '[[Int,Int],Int,Int]'],
    ['typeOf (1::["a"])', '[Int,String]'],
    ['typeOf ("a"::1::[2])', '[String,Int,Int]'],
    ['typeOf ([1]::[[3,4]])', '[[Int],[Int,Int]]'],
    ['typeOf (1::[2,3])', '[Int,Int,Int]'],
    // An endless list is endlessly many; one of unknown length a List.
    ['xs = 1::xs; typeOf xs', '[Int..]'],
    ['typeOf (1::missing)', 'List Int'],
    ['typeOf [1,missing]', '[Int,a]'],
    ['typeOf [1..]', '[Int..]'],
    ['typeOf [.1,.2..]', '[Float..]'],
    ['f (Int x) = x; typeOf f', 'Int -> Int'],
    ['f (Int x) (String y) = y; typeOf f', 'Int -> String -> String'],
    ['f (Int x) (String y) = y; typeOf (f 1)', 'String -> String'],
    ['typeOf (x -> print x)', 'a -> IO []'],
    ['f 0 = 1; f 1 = 2; typeOf f', 'Int -> Int'],
    ['f 0 = 1; f 1 = "no"; typeOf f', 'Int -> Int | String'],
    ['Option a = Some a | None; f (Some x) = x; f None = 0; typeOf f', 'Option Int -> Int'],
    ['f x = f x; typeOf f', 'a -> b'],
    ['typeOf (typeOf [1])', 'Type'],
    ['[typeOf [1] == List, isType (typeOf [1]) ["hi"]]', '[True,True]'],
    ['f x = x; [typeOf f == Function, isType (typeOf f) (x -> 1)]', '[True,True]'],
    ['count = Mutable 0; action x = set count 1; t <- return (typeOf action); count', '0'],
    ['count = Mutable 0; t <- return (typeOf [set count 1]); count', '0'],
    ['f x = fail "do not call"; typeOf f', 'a -> b'],
    ['xs = 1::xs; typeOf xs', '[Int..]'],
] as const) Deno.test(`type description: ${source}`, () => {
    const i = new Interpreter();
    const actual = i.renderString(i.run(parseDocument(source)));
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
