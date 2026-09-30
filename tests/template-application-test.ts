import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

function result(source: string): string {
    const i = new Interpreter();
    return i.renderString(i.run(parseDocument(source)));
}
for (const [source, expected] of [
    ['Vector3 = [x: Float, y: Float, z: Float]\nf (Vector3 v) = v\nf [1,2,3]', '[x: 1.0, y: 2.0, z: 3.0]'],
    ['f ([x: Float] v) = v.x\nf [1]', '1.0'],
    ['V = [x: Float, y: Float]\nf (V v) = v.x\nf [1, missing]', '1.0'],
    ['V = [x: Float, y: Float]\nf (V v) = 1\nf _ = 2\n[f [], f [1], f [1,2], f [1,2,3], f [0..]]', '[2, 2, 1, 2, 2]'],
    ['A = [x: Float]\nB = [y: Float]\nf (A v) = 1\nf (B v) = 2\nf [1]', '1'],

    ['[Char, Char, Char, Char, Char]."hello"', "['h', 'e', 'l', 'l', 'o']"],
    ['[].""', '[]'],
    ['[Char, Char, Char]."a😀é"', "['a', '😀', 'é']"],
    ['[Char, Char]."hi"', "['h', 'i']"],
    ['[].""', '[]'],
    ['[c -> 42, c -> 42]."hi"', '[42, 42]'],
    ['take 1 ([(c -> c), missing]."hi")', "['h']"],
    ['Characters = [Char, Char]\nCharacters."hi"', "['h', 'i']"],
    ['cast [Char, Char] "hi"', "['h', 'i']"],
    ['typeOf ([Char, Char]."hi")', '[a]'],
    ['[0].[123]', '[123]'], ['[Int 0].[floor .2]', '[0]'], ['[Int32 0].[123]', '[Int32 123]'],
    ['"old" "new"', '"new"'], ['false true', 'true'], ["'a' 'b'", "'b'"],
    ['(* 2) * [1,2,3,4]', '[2, 4, 6, 8]'],
    ['Int * [1,2,3,4]', '[1, 2, 3, 4]'],
    ['[Int, String].[1, "hi"]', '[1, "hi"]'],
    ['[[(* 2), (* 2)], [(* 2), (* 2)]].[[1,2],[3,4]]', '[[2, 4], [6, 8]]'],
    ['[x: 0, y: 0] [x: 1, y: 2]', '[x: 1, y: 2]'],
    ['[x: 0, y: Int] [x: 123]', '[x: 123, y: 0]'],
    ['[x: Int] [x: 123, y: 2]', '[x: 123, y: 2]'],
    ['[x: 0, "x": Int] ["x": 123]', '[x: 0, "x": 123]'],
    ['[x: 0, y: (*2)] [1, 2]', '[x: 1, y: 4]'],
    ['[x: [Int, Int]] [x: [1,2]]', '[x: [1, 2]]'],
    ['xs = [Int].[0]\nxs 0 = floor .2\nxs 0 = 123\nxs', '[123]'],
    ['xs = [Int, Float].[0,0]\nxs (-1) = 3\nxs', '[0, 3.0]'],
    ['v = [x: Int, y: Int] []\nv.y = 321\nv', '[x: 0, y: 321]'],
    ['v = [x: Int, y: Int] [x: 123]\nv.y = 321\nv.y = floor .2\nv', '[x: 123, y: 0]'],
    ['v = [x: Int, y: Int] []\nv "y" = 321\nv', '[x: 0, y: 321]'],
    ['v = ["x": Int] []\nv."x" = 123\nv', '["x": 123]'],
    ['v = [x: Int, y: Float] []\nv.[x,y] = [floor .2, 3]\nv', '[x: 0, y: 3.0]'],
    ['v = [x: (*2)]\nv.x = 3\nv.x = 4\nv.x', '4'],
    ['take 4 (map Int [0..])', '[0, 1, 2, 3]'],
    ['take 2 ([Int, Int, Int].[1,2,missing])', '[1, 2]'],
    ['head ([x -> 42].[missing])', '42'],
    ['([x: (value -> 42)] [x: [missing]]).x', '42'],
    ['xs = [0, missing]\nxs 0 = 1\nxs 0', '1'],
    ['xs = [0..]\nxs 2 = 99\ntake 4 xs', '[0, 1, 99, 3]'],
    ['[] []', '[]'], ['[].[]', '[]'], ['[10].[0]', '[0]'], ['[10] 0', '10'],
    ['Count = Int\nCount 123', '123'],
    ['Count = Int\nf (Count x) = x\nf (Int 123)', '123'],
    ['Option a = Some a | None\n[Type (Option Int) == Type (Option Int), Type (Option Int) == Type (Option Float)]', '[true, false]'],
    ['Option a = Some a | None\n[isType (Option Int) (Some 1), isType (Option Int) (Some "hi")]', '[true, false]'],
    ['[isType [Int, Int] [1,2], isType [Int] [1,"hi"], isType [x: Int] [x: 1]]', '[true, false, true]'],
    ['Option a = Some a | None\nf ((Option Int) x) = 1\nf _ = 0\nf 123', '0'],
    ['Many a = Packed [a,a] | Empty\n(Many Int) (Packed [1,2])', 'Packed [1, 2]'],
    ['Many a = Packed [a,a] | Empty\nPacked [1,2]', 'Packed [1, 2]'],
    ['Product a b = | MakeProduct a b\n(Product Int String) (MakeProduct 123 "hi")', 'MakeProduct 123 "hi"'],
    ['Point = [x: Float, y: Float]\nPoints = [Point]\nPoints.[[x: 1,y: 2]]', '[[x: 1.0, y: 2.0]]'],
    ['Option a = Some a | None\n[Type (Option [Int]) == Type (Option [Int]), Type (Option [Int]) == Type (Option [Float])]', '[true, false]'],
    ['UserId = | MkUserId Int\n[isType UserId (MkUserId 123), isType UserId 123]', '[true, false]'],

    ['Point = [x: Float, y: Float]\nPoint [x: 1]', '[x: 1.0, y: 0.0]'],
    ['Numbers = [Int]\nNumbers.[1]', '[1]'],
    ['Numbers = [Int]\nf (Numbers xs) = head xs\nf [123]', '123'],
    ['f ([Int] xs) = head xs\nf [123]', '123'],
    ['f ([x: Int] p) = p.x\nf [x: 123]', '123'],
    ['cast [Int, Int] [1,2]', '[1, 2]'],
    ['[isType Type [Int], isType Type [(*2)], Type [Int]]', '[true, false, [Int]]'],
    ['Option a = Some a | None\nMaybe a = Option a\nType (Maybe Int)', 'Option Int'],
    ['Option a = Some a | None\nMaybe a = Option a\n(Maybe Int) (Some (floor .2))', 'Some 0'],
    ['Option a = Some a | None\n(Option Int) None', 'None'],
    ['Option a = Some a | None\nf ((Option Int) x) = match x [Some v -> v, None -> Int 0]\nf (Some 123)', '123'],
    ['Option a = Some a | None\nSome x = Some 123\nx', '123'],
    ['Option a = Some a | None\nNone = None\n123', '123'],
    ['UserId = | MkUserId Int\nMkUserId 123', 'MkUserId 123'],
    ['UserId = | MkUserId Int\nget (MkUserId x) = x\nget (MkUserId 123)', '123'],
    ['Option a = Some a | None\nx = (Option Int) (Some missing)\nf (Option v) = 42\nf x', '42'],
    ['Option a = Some a | None\ntypeOf ((Option Int) None)', 'Option Int'],
] as const) Deno.test(`templates: ${source}`, () => {
    const actual = result(source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const [source, error] of [
    ['[Int 0].[Float .2]', 'lossy conversion'],
    ['[Int8 0].[128]', 'out of range'],
    ['[0].["hi"]', 'expects a number'],
    ['false 1', 'bool template'],
    ['[Int, Int].[1]', 'same length'],
    ['[Int, Int].[1,2,3]', 'same length'],
    ['[]. [1]', 'same length'],
    ['[]."hi"', 'same length'],
    ['[Char, Char]."h"', 'same length'],
    ['[Char, Char]."hey"', 'same length'],
    ['[Int]."hi"', 'expects a number'],
    ['xs = [].[]\nxs 0 = 1', 'out of range'],
    ['xs = [Int]\nxs 1 = 1', 'out of range'],
    ['Option a = Some a | None\n(Option Int) (Some (Float .2))', 'lossy conversion'],
    ['Option a = Some a | None\n(Option Int) (Some "hi")', 'expects a number'],
    ['Option a = Some a | None\nNone = Some 1', 'pattern'],
    ['Thing = 123\nThing', 'must alias a type'],
    ['Option a = Some a | None\nSome a = | Replacement a', 'cannot redeclare value constructor'],
    ['Bad a a = One a | Two a', 'distinct lowercase'],
    ['Bad = | Int', 'built-in type'],
    ['Bad = One | One', 'duplicate value constructor'],
    ['xs = [missing]\nxs 0 = 1', 'unbound variable'],

] as const) Deno.test(`templates reject: ${source}`, () => {
    try { result(source); } catch (e) {
        if (e instanceof Error && e.message.includes(error)) return;
        throw e;
    }
    throw new Error(`Expected ${error}`);
});
for (const assignment of ['v.x = Float .2', 'v "x" = Float .2', 'v.[x,y] = [2, Float .2]']) {
    Deno.test(`failed template update preserves binding: ${assignment}`, () => {
        const i = new Interpreter();
        i.run(parseDocument('v = [x: Int 1, y: Int 2]'));
        let failed = false;
        try { i.run(parseDocument(assignment)); } catch { failed = true; }
        const actual = i.renderString(i.run(parseDocument('v')));
        if (!failed || actual !== '[x: 1, y: 2]') throw new Error(actual);
    });
}
