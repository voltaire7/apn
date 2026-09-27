import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

function result(source: string): string {
    const i = new Interpreter();
    return i.renderString(i.run(parseDocument(source)));
}
for (const [source, expected] of [
    ['[Int, Float, Int8, UInt, Float32, Float64]', '[0, 0.0, Int8 0, UInt 0, Float32 0.0, Float64 0.0]'],
    ['[Fraction, Complex, ComplexExact, Number, Real, Integer, Exact, Inexact]', '[Fraction 0, Complex 0, ComplexExact 0, 0, 0, 0, 0, 0.0]'],
    ['[Bool, String, Unit, List, Record, HashMap, Pointer]', '[false, "", (), [], [], HashMap [], Pointer 0x0]'],
    ['Char', "'\\0'"],
    ['[Int + 1, Float + 1, Int32 + 1, Float64 + Float64, -Int, Int ^ 2]', '[1, 1.0, Int32 1, Float64 0.0, 0, 0]'],
    ['[sqrt Float, isZero Int, isInteger Int, floor Float, Int == 0, Float == 0, Int < 1]', '[0.0, true, true, 0.0, true, true, true]'],
    ['[!Bool, Bool ? 1 : 2]', '[true, 2]'],
    ['[String ++ "hi", String + "hi", length List, null List, take Int missing]', '["hi", "hi", 0, true, []]'],
    ['[Int]','[0]'],
    ['[(1:List), [1] ++ List, List ++ [1], pairs Record, format String []]', '[[1], [1], [1], [], ""]'],
    ['r = Record\nr.x = 1\nr', '[x: 1]'],
    ['r = Record\nr "x" = 1\nr', '[x: 1]'],

    ['xs = [Int]\nxs 0 = 2\nxs', '[2]'],
    ['[Int] [1,2,3]', '[1, 2, 3]'],
    ['[Int, Float] + [1,2]', '[1, 2.0]'],
    ['V = [x: Float, y: Float, z: Float]\nv = V\nv.x = 123\n[v, V]', '[[x: 123.0, y: 0.0, z: 0.0], [x: 0.0, y: 0.0, z: 0.0]]'],
    ['V = [x: Float, y: Float]\nV [x: 1]', '[x: 1.0, y: 0.0]'],
    ['V = [x: Float, y: Float]\nV [1,2]', '[x: 1.0, y: 2.0]'],
    ['[x: Float] == [x: 0]', 'true'],
    ['[isType Int Int, isType Float Float, isType Bool Bool, isType List List, isType Type Int]', '[true, true, true, true, true]'],
    ['[typeOf Int, typeOf (Int 1), typeOf (Float 1), typeOf (Int32 1)]', '[Type, Int, Float, Int32]'],
    ['[Type Int, Type [Int], Type [x: Float], Int -> Float]', '[Int, [Int], [x: Float], Int -> Float]'],
    ['[Type Int == Type Float, typeOf 1 == typeOf 1.0]', '[false, false]'],
    ['(Type Int) 123', '123'],
    ['Count = Int\n[Count, Count 3]', '[0, 3]'],
    ['f (Int x) = x + 1\nf Int', '1'],
    ['f (Bool x) = x\nf Bool', 'false'],
    ['f (Type t) = t 123\nf Int', '123'],
    ['f (t x) = [t, x]\nf (Int32 7)', '[Int32, 7]'],
    ['f ((Int -> Int) g) = g Int\nf (+ 1)', '1'],
    ['Option a = Some a | None\n[Option, Option Int]', '[None, None]'],
    ['Option a = Some a | None\nf (Option x) = match x [None -> 1, Some _ -> 2]\nf Option', '1'],
    ['Option a = Some a | None\n[isType Option Option, isType (Option Int) (Option Int)]', '[true, true]'],
    ['Option a = Some a | None\nType (Option [Int])', 'Option [Int]'],
    ['Color = Red | Green | Blue\nColor', 'Red'],
    ['User = | MkUser Int String\nUser', 'MkUser 0 ""'],
    ['BoxType a = | MkBox a\nBoxType Int', 'MkBox 0'],
    ['BoxType a = | MkBox a\nBoxType [x: Float]', 'MkBox [x: 0.0]'],
    ['BoxType a = | MkBox a\nBoxType (BoxType Int)', 'MkBox MkBox 0'],
    ['Node = Next Node | End\nNode', 'End'],
    ['Inner = | MkInner Int\nOuter = | MkOuter Inner Inner\nOuter', 'MkOuter MkInner 0 MkInner 0'],
    ['import "std/text"\n[chars String, fromChars [Char]]', '[[], "\u0000"]'],
    ['insert [["key", 1]] HashMap $ keys', '["key"]'],
    ['x = Mutable Int\nx $ set (x + 1)\nx', '1'],
    ['[Int (floor .2), Int (truncate (-1.7)), Float (inexact 9007199254740993)]', '[0, -1, 9007199254740992.0]'],
    ['take 2 ([Int] [1, 2, missing])', '[1, 2]'],
    ['User = | MkUser Int String\nf (MkUser n _) = n\nf User', '0'],
] as const) Deno.test(`zero initialization: ${source}`, () => {
    const actual = result(source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const [source, error] of [
    ['Int .2', 'lossy conversion'],
    ['cast Int .2', 'lossy conversion'],
    ['[Int] [.2]', 'lossy conversion'],
    ['v = [x: Int]\nv.x = .2', 'lossy conversion'],
    ['xs = [Int]\nxs 0 = .2', 'lossy conversion'],
    ['Node = | Next Node\nNode', 'no finite default'],
    ['BoxType a = | MkBox a\nBoxType', 'explicit default'],
    ['NeedsFunction = | MkNeedsFunction Function\nNeedsFunction', 'explicit default'],
] as const) Deno.test(`zero initialization rejects: ${source}`, () => {
    try { result(source); } catch (e) {
        if (e instanceof Error && e.message.includes(error)) return;
        throw e;
    }
    throw new Error(`Expected ${error}`);
});

Deno.test("printing a default does not replace its constructor or schema", () => {
    const i = new Interpreter();
    i.run(parseDocument('V = [x: Float, y: Float]\nv = V'));
    if (i.renderString(i.env.get('v')!) !== '[x: 0.0, y: 0.0]') throw new Error('default');
    const actual = i.renderString(i.run(parseDocument('v.y = 2\n[V [1,2], v, Type V]')));
    if (actual !== '[[x: 1.0, y: 2.0], [x: 0.0, y: 2.0], [x: Float, y: Float]]') throw new Error(actual);
});
