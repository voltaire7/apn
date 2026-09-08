import { parse } from "../main.ts";
import { Interpreter } from "../src/interp.ts";
import { APNError } from "../src/errors.ts";

for (const [source, expected] of [
    ["[Int32 1 + Int64 2, Int8 1 + Int 2]", "[Int64 3, Int 3]"],
    ["[1,2] * Int", "[Int 1, Int 2]"],
    ['f (Number x) = 1\nf 0 = 2\nf 0', '2'],
    ["true $ typeOf", "Bool"],
    ['"hi" $ typeOf', "String"],
    ["'a' $ typeOf", "Char"],
    ["() $ typeOf", "Unit"],
    ["[1..] $ typeOf", "List"],
    ["[x: 1] $ typeOf", "Record"],
    ["sqrt $ typeOf", "Function"],
    ["Int $ typeOf", "Type"],
    ["Int 123", "Int 123"], ["Int32 123", "Int32 123"],
    ["UInt 123", "UInt 123"], ["UInt32 4294967295", "UInt32 4294967295"],
    ["Float 3", "Float 3.0"], ["Float32 .5", "Float32 0.5"],
    ["Fraction (1/3)", "Fraction 1/3"], ["Complex (1+2i)", "Complex 1+2i"],
    ["cast Int 3.7", "Int 3"], ["3.7 $ cast Int", "Int 3"],
    ["cast Float32 .1", "Float32 0.10000000149011612"],
    ["Int 3.0", "Int 3"],
    ["typeOf (Int32 123)", "Int32"], ["isType Number (Int32 1)", "true"],
    ["[Int32 1 + Int32 2, Int32 1 + 2]", "[Int32 3, Int32 3]"],
    ["Int32 1 / Int32 2", "Fraction 1/2"],
    ["take 3 (100 * _ -> Int 0)", "[Int 0, Int 0, Int 0]"],
    ["length (100 * _ -> Int 0)", "100"],
    ["take 3 (100 * Int)", "[Int 0, Int 1, Int 2]"],
    ["(100 * Int) (-1)", "Int 99"],
    ["([1..100] * Int) (-1)", "Int 100"],
    ["length (100 * Int)", "100"],
    ["100 * Int 0", "Int 0"],
    ["3 * Int 2", "Int 6"],
    ["Int 3 * Int 2", "Int 6"],
    ['add (Int x) (Int y) = x + y\nadd (Float x) (Float y) = x + y\nadd (Number x) (Number y) = 99\n[add (Int 2) (Int 3), add (Float 2) (Float 3), add (1/3) (1/4)]', '[Int 5, Float 5.0, 99]'],
    ['pick (Number x) = "number"\npick (Int32 x) = "int32"\npick (Float x) = "float"\n[pick (Int32 1), pick (Float 1), pick (1/3)]', '["int32", "float", "number"]'],
    ['f (Float x) = x\nf 2', 'Float 2.0'],
    ['f (Int32 x) = x + 1\nf 2', 'Int32 3'],
    ['same (Number x) (Number x) = true\nsame a b = false\n[same 1 1, same 1 2]', '[true, false]'],
    ['map (cast Int) [1.5, 2.5]', '[Int 1, Int 2]'],
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
for (const source of ["Int 3.7", "Int32 2147483648", "UInt (-1)", "UInt32 4294967296", "Float32 .1", "Float 9007199254740993", "Int8 127 + Int8 1", "cast UInt (-1)", "cast Int8 128", "1/3 + .5", "f (Float32 x) = x\nf .1"]) {
    Deno.test(`checked type conversion: ${source}`, () => {
        try { const interp = new Interpreter(); interp.renderString(interp.run(parse(source))); }
        catch (e) { if (e instanceof APNError) return; throw e; }
        throw new Error("Expected conversion error");
    });
}
