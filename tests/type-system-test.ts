import { parse } from "../main.ts";
import { Interpreter } from "../src/interp.ts";
import { APNError } from "../src/errors.ts";

for (const [source, expected] of [
    ["[Int32 1 + Int64 2, Int8 1 + Int 2]", "[Int64 3, 3]"],
    ["[1,2] * Int", "[1,2]"],
    ['f (Number x) = 1\nf 0 = 2\nf 0', '2'],
    ["typeOf $ true", "Bool"],
    ['typeOf $ "hi"', "String"],
    ["typeOf $ 'a'", "Char"],
    ["typeOf $ []", "List a"],
    ["typeOf $ [1..]", "List Int"],
    ["typeOf $ [x: 1]", "Record"],
    ["typeOf $ sqrt", "Number -> Number"],
    // Builtins show the checker's signatures.
    ["typeOf $ S", "UInt -> UInt"],
    ["typeOf $ print", "a -> IO []"],
    ["typeOf $ foldl", "(a -> b -> a) -> a -> List b -> a"],
    ["typeOf $ take 2", "List a -> List a"],
    ["typeOf $ Int", "Type"],
    ["Bool true", "true"], ['String "hi"', '"hi"'],
    ["Char 'a'", "'a'"], ["[] []", "[]"],
    ["List [1,2]", "[1,2]"], ["take 3 (List [1..])", "[1,2,3]"],
    ["Record [x: 1]", "[x: 1]"],
    ["(Function (x -> x + 1)) 2", "3"], ["Type Int", "Int"],
    ["Choice = | Chosen x\nVariant (Chosen 1)", "Chosen 1"],
    ["[isType Bool true, isType String 1, isType List [1..], isType Type Bool]", "[true,false,true,true]"],
    ['f (Bool x) = "bool"\nf (String x) = "string"\nf (List x) = "list"\n[f true, f "hi", f [1]]', '["bool","string","list"]'],
    ["value = true\ncast Bool $ value", "true"],
    ["myTypeOf (t x) = t\nmyTypeOf true", "Bool"],
    ["myTypeOf (t x) = t\nmyTypeOf (Int32 5)", "Int32"],
    ["identity (t x) = x\nidentity (Int32 5)", "5"],
    ["myTypeOf (t x) = t\nmyTypeOf [missing]", "List a"],
    ["sameType (t x) (t y) = true\nsameType x y = false\n[sameType 1 2, sameType 1 true]", "[true,false]"],
    ["match true [(t x) -> t]", "Bool"],
    ["Int 123", "123"], ["Int32 123", "Int32 123"],
    ["UInt 123", "UInt 123"], ["UInt32 4294967295", "UInt32 4294967295"],
    ["Float 3", "3.0"], ["Float32 .5", "Float32 0.5"],
    ["Fraction (1/3)", "Fraction 1/3"], ["Complex (1+2i)", "Complex 1+2i"],
    ["Int (truncate 3.7)", "3"], ["Int $ truncate $ 3.7", "3"],
    ["Float32 1 / 10", "Float32 0.1"],
    ["Int 3.0", "3"],
    ["typeOf (Int32 123)", "Int32"], ["isType Number (Int32 1)", "true"],
    ["[Int32 1 + Int32 2, Int32 1 + 2]", "[Int32 3, Int32 3]"],
    ["Int32 1 / Int32 2", "Fraction 1/2"],
    ["take 3 (100 * _ -> Int 0)", "[0,0,0]"],
    ["length (100 * _ -> Int 0)", "100"],
    ["take 3 (100 * Int)", "[0,1,2]"],
    ["(100 * Int) (-1)", "99"],
    ["([1..100] * Int) (-1)", "100"],
    ["length (100 * Int)", "100"],
    ["100 * Int 0", "0"],
    ["3 * Int 2", "6"],
    ["Int 3 * Int 2", "6"],
    ['add (Int x) (Int y) = x + y\nadd (Float x) (Float y) = x + y\nadd (Number x) (Number y) = 99\n[add (Int 2) (Int 3), add (Float 2) (Float 3), add (1/3) (1/4)]', '[5,5.0,99]'],
    ['pick (Number x) = "number"\npick (Int32 x) = "int32"\npick (Float x) = "float"\n[pick (Int32 1), pick (Float 1), pick (1/3)]', '["int32","float","number"]'],
    ['f (Float x) = x\nf 2', '2.0'],
    ['f (Int32 x) = x + 1\nf 2', '3'],
    ['same (Number x) (Number x) = true\nsame a b = false\n[same 1 1, same 1 2]', '[true,false]'],
    ['map (Int \\ truncate) [1.5,2.5]', '[1,2]'],
    ['f = Int32\nf 5', 'Int32 5'],
    ['Int64 9223372036854775807', 'Int64 9223372036854775807'],
    ['UInt128 340282366920938463463374607431768211455', 'UInt128 340282366920938463463374607431768211455'],
]) {
    Deno.test(`type system: ${source}`, () => {
        const interp = new Interpreter();
        const actual = interp.renderString(interp.run(parse(source)));
        if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
    });
}
for (const source of ["String 123", "Char true", "List 1", "Record []", "Function 2", "Type 1", "[] 1", "Variant 1", "Int (Float 3.7)", "Int32 2147483648", "UInt (-1)", "UInt32 4294967296", "Int8 127 + Int8 1", "cast UInt (-1)", "cast Int8 128", "1/3 + .5", "f (Float32 x) = x\nf (Float .1)"]) {
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
        new Interpreter().run(parse("myTypeOf (t x) = print t\nmyTypeOf true"));
        if (output.join("\n") !== "Bool") throw new Error("Expected Bool");
    } finally { console.log = original; }
});
