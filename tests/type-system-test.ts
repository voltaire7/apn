import { parse } from "../main.ts";
import { Interpreter } from "../src/interp.ts";
import { APNError } from "../src/errors.ts";

for (const [source, expected] of [
    // A sized integer with an Int keeps its type; two different ones do not mix.
    ["x = (2 : Int64) : Int32; xs = [(1 : Int32) + 2, (1 : Int8) + (2 : Int), (1 : Int32) + x]\n[xs, map typeOf xs]",
        "[[3,3,3],[Int32,Int8,Int32]]"],
    ["[1,2] * Int", "[1,2]"],
    ['f (x : Number) = 1\nf 0 = 2\nf 0', '2'],
    ["typeOf $ True", "Bool"],
    ['typeOf $ "hi"', "String"],
    ["typeOf $ 'a'", "Char"],
    ["typeOf $ []", "[]"],
    ["typeOf $ [1..]", "[Int..]"],
    // A record's type is its fields' types, found when shown.
    ["typeOf $ [x = 1]", "[x : Int]"],
    ["typeOf [x = 1, y = Float, p = [q = 1.5]]", "[x : Int, y : Type, p : [q : Float]]"],
    ["t = typeOf [x = head [], y = 2]\n[t.y, typeOf [x = 1] == [x : Int]]", "[Int,True]"],
    ["Quote = [quote : String]\ntypeOf ([] : Quote)", "Quote"],
    ["typeOf $ sqrt", "Number -> Number"],
    // Builtins show the checker's signatures.
    ["typeOf $ S", "UInt -> UInt"],
    ["typeOf $ print", "a -> IO []"],
    ["typeOf $ foldl", "(a -> b -> a) -> a -> List b -> a"],
    ["typeOf $ take 2", "List a -> List a"],
    ["typeOf $ Int", "Type"],
    ["to Bool True", "True"], ['("hi" : String)', '"hi"'],
    ["('a' : Char)", "'a'"], ["[] []", "[]"],
    ["([1,2] : List)", "[1,2]"], ["take 3 ([1..] : List)", "[1,2,3]"],
    ["([x = 1] : Record)", "[x = 1]"],
    ["(x -> x + 1 : Function) 2", "3"], ["(Int : Type)", "Int"],
    ["Choice = | Chosen x\n(Chosen 1 : Variant)", "Chosen 1"],
    ["[isType Bool True, isType String 1, isType List [1..], isType Type Bool]", "[True,False,True,True]"],
    ['f (x : Bool) = "bool"\nf (x : String) = "string"\nf (x : List _) = "list"\n[f True, f "hi", f [1]]', '["bool","string","list"]'],
    ["value = True\ncast Bool $ value", "True"],
    ["myTypeOf (x : t) = t\nmyTypeOf True", "Bool"],
    ["myTypeOf (x : t) = t\nmyTypeOf (5 : Int32)", "Int32"],
    ["identity (x : t) = x\nidentity (5 : Int32)", "5"],
    ["myTypeOf (x : t) = t\nhead (myTypeOf [1,missing])", "Int"],
    ["sameType (x : t) (y : t) = True\nsameType x y = False\n[sameType 1 2, sameType 1 True]", "[True,False]"],
    ["True ~ [(x : t) -> t]", "Bool"],
    ["(123 : Int)", "123"], ["x = 123 : Int32; [x, typeOf x]", "[123,Int32]"],
    ["x = 123 : UInt; [x, typeOf x]", "[123,UInt]"], ["x = 4294967295 : UInt32; [x, typeOf x]", "[4294967295,UInt32]"],
    ["(3 : Float)", "3.0"], ["x = .5 : Float32; [x, typeOf x]", "[0.5,Float32]"],
    ["x = 1/3 : Fraction; [x, typeOf x]", "[1/3,Fraction]"], ["x = 1+2i : Complex; [x, typeOf x]", "[1+2i,Complex]"],
    ["(truncate 3.7 : Int)", "3"], ["(truncate $ 3.7 : Int)", "3"],
    ["x = (1 : Float32) / 10; [x, typeOf x]", "[0.1,Float32]"],
    ["(3.0 : Int)", "3"],
    ["typeOf (123 : Int32)", "Int32"], ["isType Number (1 : Int32)", "True"],
    ["xs = [(1 : Int32) + (2 : Int32), (1 : Int32) + 2]; [xs, map typeOf xs]", "[[3,3],[Int32,Int32]]"],
    ["x = (1 : Int32) / (2 : Int32); [x, typeOf x]", "[1/2,Fraction]"],
    // Int and Float are flexible: they join any fixed-width type.
    ["[typeOf ((1 : Float32) + 2.5), typeOf ((1 : Float64) * 2), typeOf ((1 : Int16) + (2 : Int))]", "[Float32,Float64,Int16]"],
    // A sized integer with a plain one keeps its type; the result must fit,
    // whatever the plain operand is.
    ["x = (2000000000 : Int32) - 3000000000; [x, typeOf x]", "[-1000000000,Int32]"],
    ["x = (5 : UInt8) / 2; [x, typeOf x]", "[5/2,Fraction]"],
    ["take 3 (100 * _ -> (0 : Int))", "[0,0,0]"],
    ["length (100 * _ -> (0 : Int))", "100"],
    ["take 3 (100 * Int)", "[0,1,2]"],
    ["(100 * Int) -1", "99"],
    ["([1..100] * Int) -1", "100"],
    ["length (100 * Int)", "100"],
    ["100 * (0 : Int)", "0"],
    ["3 * (2 : Int)", "6"],
    ["(3 : Int) * (2 : Int)", "6"],
    ['add (x : Int) (y : Int) = x + y\nadd (x : Float) (y : Float) = x + y\nadd (x : Number) (y : Number) = 99\n[add (2 : Int) (3 : Int), add (2 : Float) (3 : Float), add (1/3) (1/4)]', '[5,5.0,99]'],
    ['pick (x : Number) = "number"\npick (x : Int32) = "int32"\npick (x : Float) = "float"\n[pick (1 : Int32), pick (1 : Float), pick (1/3)]', '["int32","float","number"]'],
    ['f (x : Float) = x\nf 2', '2.0'],
    ['f (x : Int32) = x + 1\nf 2', '3'],
    ['same (x : Number) (x : Number) = True\nsame a b = False\n[same 1 1, same 1 2]', '[True,False]'],
    ['map (to Int \\ truncate) [1.5,2.5]', '[1,2]'],
    ['f = Int32\nx = 5 : f; [x, typeOf x]', '[5,f]'],
    ['x = 9223372036854775807 : Int64; [x, typeOf x]', '[9223372036854775807,Int64]'],
    ['x = 340282366920938463463374607431768211455 : UInt128; [x, typeOf x]', '[340282366920938463463374607431768211455,UInt128]'],
]) {
    Deno.test(`type system: ${source}`, () => {
        const interp = new Interpreter();
        const actual = interp.renderString(interp.run(parse(source)));
        if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
    });
}
for (const source of ["(123 : String)", "(True : Char)", "List 1", "([] : Record)", "(2 : Function)", "(1 : Type)", "[] 1", "(1 : Variant)", "((3.7 : Float) : Int)", "(2147483648 : Int32)", "(-1 : UInt)", "(4294967296 : UInt32)", "(127 : Int8) + (1 : Int8)", "(1 : Int32) + (2 : Int64)", "(1 : UInt8) * (2 : UInt16)", "(1 : Float32) + (2 : Float64)", "(1 : Int32) + (2.5 : Float32)", "(2 : Float32) ^ (2 : Float64)", "(1233421412 : Int32) + 123512512351245342332", "(1233421412 : Int32) + 1000000000", "cast UInt -1", "cast Int8 128", "1/3 + .5", "f (x : Float32) = x\nf (.1 : Float)"]) {
    Deno.test(`checked type conversion: ${source}`, () => {
        try { const interp = new Interpreter(); interp.renderString(interp.run(parse(source))); }
        catch (e) { if (e instanceof APNError) return; throw e; }
        throw new Error("Expected conversion error");
    });
}

Deno.test("type binding prints the captured type", () => {
    const output: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { output.push(args.join(" ")); };
    try {
        new Interpreter().run(parse("myTypeOf (x : t) = print t\nmyTypeOf True"));
        if (output.join("\n") !== "Bool") throw new Error("Expected Bool");
    } finally { console.log = original; }
});
