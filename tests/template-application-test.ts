import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

function result(source: string): string {
    const i = new Interpreter();
    return i.renderString(i.run(parseDocument(source)));
}
for (const [source, expected] of [
    ['Vector3 = [x : Float, y : Float, z : Float]\nf (v : Vector3) = v\nf [1,2,3]', '[x = 1.0, y = 2.0, z = 3.0]'],
    ['f (v : [x : Float]) = v.x\nf [1]', '1.0'],
    ['V = [x : Float, y : Float]\nf (v : V) = v.x\nf [1,missing]', '1.0'],
    ['V = [x : Float, y : Float]\nf (v : V) = 1\nf _ = 2\n[f [], f [1], f [1,2], f [1,2,3], f [0..]]', '[2,2,1,2,2]'],
    ['A = [x : Float]\nB = [y : Float]\nf (v : A) = 1\nf (v : B) = 2\nf [1]', '1'],

    ['[Char,Char,Char,Char,Char]."hello"', "['h','e','l','l','o']"],
    ['[].""', '[]'],
    ['[Char,Char,Char]."a😀é"', "['a','😀','é']"],
    ['[Char,Char]."hi"', "['h','i']"],
    ['[].""', '[]'],
    ['[c -> 42, c -> 42]."hi"', '[42,42]'],
    ['take 1 [c -> c, missing]."hi"', "['h']"],
    ['Characters = [Char,Char]\nCharacters."hi"', "['h','i']"],
    ['cast [Char,Char] "hi"', "['h','i']"],
    ['typeOf [Char,Char]."hi"', '[Char,Char]'],
    ['[x = 0] [x = 123]', '[x = 123]'], ['[x = (0 : Int)] [x = floor .2]', '[x = 0]'], ['[x = (0 : Int32)] [x = 123]', '[x = 123]'],
    ['[x = "old"] [x = "new"]', '[x = "new"]'], ['[x = False] [x = True]', '[x = True]'], ["[x = 'a'] [x = 'b']", "[x = 'b']"],
    ['(* 2) * [1,2,3,4]', '[2,4,6,8]'],
    ['Int * [1,2,3,4]', '[1,2,3,4]'],
    ['[Int,String].[1,"hi"]', '[1,"hi"]'],
    ['[[(* 2), (* 2)], [(* 2), (* 2)]].[[1,2],[3,4]]', '[[2,4],[6,8]]'],
    ['[x = 0, y = 0] [x = 1, y = 2]', '[x = 1, y = 2]'],
    ['([x = 123] : [x = 0, y : Int])', '[x = 123, y = 0]'],
    ['([x = 123, y = 2] : [x : Int])', '[x = 123, y = 2]'],
    ['([x = [1,2]] : [x : [Int,Int]])', '[x = [1,2]]'],
    ['xs = [Int].[0]\nxs 0 = floor .2\nxs 0 = 123\nxs', '[123]'],
    ['xs = [Int,Float].[0,0]\nxs -1 = 3\nxs', '[0,3.0]'],
    ['v = [] : [x : Int, y : Int]\nv.y = 321\nv', '[x = 0, y = 321]'],
    ['v = [x = 123] : [x : Int, y : Int]\nv.y = 321\nv.y = floor .2\nv', '[x = 123, y = 0]'],
    ['v = [] : [x : Int, y : Int]\nv "y" = 321\nv', '[x = 0, y = 321]'],
    ['v = [] : [x : Int, y : Float]\nv.[x, y] = [floor .2, 3]\nv', '[x = 0, y = 3.0]'],
    ['take 4 (map Int [0..])', '[0,1,2,3]'],
    ['take 2 [Int,Int,Int].[1,2,missing]', '[1,2]'],
    ['head [x -> 42].[missing]', '42'],
    // A record of values is updated as by field assignment: its function is replaced.
    ['length ([x = [0]] [x = [missing]]).x', '1'],
    ['[x = 1.1] [x = 10]', '[x = 10.0]'],
    ['([Int] : [type : Type])', '[type = Int]'],
    // A field bound to a type is a value, not a slot: no template, no type.
    ['([x = 1] : [x = Float])', '[x = 1]'],
    ['[[x = Float], [x : Float]]', '[[x = Float], [x : Float]]'],
    ['[isType Type [x = Float], isType Type [x : Float]]', '[False,True]'],
    ['[use [x : Int], y = Int]', '[x : Int, y = Int]'],
    ['v = [x = Float]\nv.x = Int\nv', '[x = Int]'],
    ['([type : Int] : [type : Type])', '[type = Int]'],
    ['xs = [0,missing]\nxs 0 = 1\nxs 0', '1'],
    ['xs = [0..]\nxs 2 = 99\ntake 4 xs', '[0,1,99,3]'],
    ['[] []', '[]'], ['[].[]', '[]'], ['[Int].[0]', '[0]'], ['[10] 0', '10'],
    ['Count (x : Int) = _\nCount 123', 'Count 123'],
    ['Count (x : Int) = _\nf (Count x) = x\nf (Count 123)', '123'],
    ['Option a = Some a | None\n[(Option Int : Type) == (Option Int : Type), (Option Int : Type) == (Option Float : Type)]', '[True,False]'],
    ['Option a = Some a | None\n[isType (Option Int) (Some 1), isType (Option Int) (Some "hi")]', '[True,False]'],
    ['[isType [Int,Int] [1,2], isType [Int] [1,"hi"], isType [x : Int] [x = 1]]', '[True,False,True]'],
    ['Option a = Some a | None\nf (x : Option Int) = 1\nf _ = 0\nf 123', '0'],
    ['Many a = Packed [a,a] | Empty\n(Packed [1,2] : Many Int)', 'Packed [1,2]'],
    ['Many a = Packed [a,a] | Empty\nPacked [1,2]', 'Packed [1,2]'],
    ['Product a b = | MakeProduct a b\n(MakeProduct 123 "hi" : Product Int String)', 'MakeProduct 123 "hi"'],
    ['Point = [x : Float, y : Float]\nPoints = [Point]\nPoints.[[x = 1, y = 2]]', '[[x = 1.0, y = 2.0]]'],
    ['Option a = Some a | None\n[(Option [Int] : Type) == (Option [Int] : Type), (Option [Int] : Type) == (Option [Float] : Type)]', '[True,False]'],
    ['UserId = | MkUserId Int\n[isType UserId (MkUserId 123), isType UserId 123]', '[True,False]'],

    ['Point = [x : Float, y : Float]\n[Point [x = 1], ([x = 1] : Point)]', '[[x = 1.0, y : Float], [x = 1.0, y = 0.0]]'],
    ['Numbers = [Int]\nNumbers.[1]', '[1]'],
    ['Numbers = [Int]\nf (Numbers xs) = head xs\nf [123]', '123'],
    ['f (xs : [Int]) = head xs\nf [123]', '123'],
    ['f (p : [x : Int]) = p.x\nf [x = 123]', '123'],
    ['cast [Int,Int] [1,2]', '[1,2]'],
    ['[isType Type [Int], isType Type [(*2)], ([Int] : Type)]', '[True,False,[Int]]'],
    ['Option a = Some a | None\nOptional a = Option a\n(Optional Int : Type)', 'Option Int'],
    ['Option a = Some a | None\nOptional a = Option a\n(Some (floor .2) : Optional Int)', 'Some 0'],
    ['Option a = Some a | None\n(None : Option Int)', 'None'],
    ['Option a = Some a | None\nf (x : Option Int) = x ~ [Some v -> v, None -> (0 : Int)]\nf (Some 123)', '123'],
    ['Option a = Some a | None\nSome x = Some 123\nx', '123'],
    ['Option a = Some a | None\nNone = None\n123', '123'],
    ['UserId = | MkUserId Int\nMkUserId 123', 'MkUserId 123'],
    ['UserId = | MkUserId Int\nget (MkUserId x) = x\nget (MkUserId 123)', '123'],
    ['Option a = Some a | None\nx = Some missing : Option Int\nf (v : Option _) = 42\nf x', '42'],
    ['Option a = Some a | None\ntypeOf (None : Option Int)', 'Option Int'],
] as const) Deno.test(`templates: ${source}`, () => {
    const actual = result(source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const [source, error] of [
    ['[x = (0 : Int)] [x = (.2 : Float)]', 'lossy conversion'],
    ['[x = (0 : Int8)] [x = 128]', 'out of range'],
    ['[x = 0] [x = "hi"]', 'cannot use String where Int is required'],
    ['f (t : Type) = t\nf [a = Int]', 'no clause of'],
    ['[x = False] [x = 1]', 'cannot use Int where Bool is required'],
    ['[x = 1] [x = 2.5]', 'lossy conversion'],
    ['([1,2.5] : [x : Int, y = 0])', 'lossy conversion'],
    ['[x = 0, y = (*2)] [x = 1, y = 2]', 'cannot use Int where'],
    ['v = [x = (*2)]\nv.x = 3', 'cannot use Int where'],
    ['[Int,Int].[1]', 'same length'],
    ['[Int,Int].[1,2,3]', 'same length'],
    ['[]. [1]', 'same length'],
    ['[]."hi"', 'same length'],
    ['[Char,Char]."h"', 'same length'],
    ['[Char,Char]."hey"', 'same length'],
    ['[Int]."hi"', 'expects a number'],
    ['xs = [].[]\nxs 0 = 1', 'out of range'],
    ['xs = [Int]\nxs 1 = 1', 'out of range'],
    ['Option a = Some a | None\n(Some (.2 : Float) : Option Int)', 'lossy conversion'],
    ['Option a = Some a | None\n(Some "hi" : Option Int)', 'expects a number'],
    ['Option a = Some a | None\nNone = Some 1', 'pattern'],
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
for (const assignment of ['v.x = .2 : Float', 'v "x" = .2 : Float', 'v.[x,y] = [2, (.2 : Float)]']) {
    Deno.test(`failed template update preserves binding: ${assignment}`, () => {
        const i = new Interpreter();
        i.run(parseDocument('v = [x = (1 : Int), y = (2 : Int)]'));
        let failed = false;
        try { i.run(parseDocument(assignment)); } catch { failed = true; }
        const actual = i.renderString(i.run(parseDocument('v')));
        if (!failed || actual !== '[x = 1, y = 2]') throw new Error(actual);
    });
}
// r [f = v] is { r.f = v; r } for a record of values, and for a type
// given types. Checked and not, the same.
for (const [application, block, expected] of [
    ['model = [name = "a", n = 1]\nmodel [name = "b"]', 'model = [name = "a", n = 1]\n{ model.name = "b"; model }', '[name = "b", n = 1]'],
    ['[x = 1.1] [10]', '{ r = [x = 1.1]; r.x = 10; r }', '[x = 10.0]'],
    ['r = [f = (* 2)]\n(r [f = (+ 1)]).f 1', 'r = [f = (* 2)]\n{ r.f = (+ 1); r }.f 1', '2'],
    ['Vector3 = [x : Float, y : Float, z : Float]\nVector3 [x : Int]', 'Vector3 = [x : Float, y : Float, z : Float]\n{ Vector3.x = Int; Vector3 }', '[x : Int, y : Float, z : Float]'],
    ['Vector3 = [x : Float, y : Float, z : Float]\nV2 = Vector3 [z : Int]\n([x = 1, z = 2] : V2)', 'Vector3 = [x : Float, y : Float, z : Float]\nV2 = { Vector3.z = Int; Vector3 }\n([x = 1, z = 2] : V2)', '[x = 1.0, y = 0.0, z = 2]'],
] as const) Deno.test(`record application is field assignment: ${application}`, () => {
    for (const checked of [false, true]) {
        const run = (source: string) => {
            const i = new Interpreter();
            if (checked) i.enableChecking();
            return i.renderString(i.run(parseDocument(source)));
        };
        const a = run(application), b = run(block);
        if (a !== b || a !== expected) throw new Error(`${checked ? "checked" : "unchecked"}: ${a} vs ${b}`);
    }
});
// A range of a type repeats it, as one of numbers counts: [Int..] is
// [Int,Int,Int..], the type of endless lists of Ints, as typeOf [1..] says.
// Checked and unchecked runs agree.
for (const checked of [true, false]) for (const [source, expected] of [
    ['[[Int..], [Int..] == List Int, typeOf [1..], typeOf [1..] == [Int..]]', '[[Int..],False,[Int..],True]'],
    ['[take 2 [Int..], head [Int..], isType [Int..] [1,2], isType [Int..] [1..], isType [Int..] 5]', '[[Int,Int],Int,False,True,False]'],
    ['f (xs : [Int..]) = "endless"\nf _ = "other"\n[f [1,2], f ["a"], f [1..], f 5]', '["other","other","endless","other"]'],
    ['Point = [x : Float, y : Float]\nps = [x = 1, y = 2] :: ps\ntake 1 (to [Point..] ps)', '[[x = 1.0, y = 2.0]]'],
    ['ones = 1 :: ones\n[typeOf ones, take 2 (to [Float..] ones)]', '[[Int..],[1.0,1.0]]'],
    ['[take 3 [1..], [1,3..9]]', '[[1,2,3],[1,3,5,7,9]]'],
    // A list's type is the list of its items' types, made as it is read.
    ['t = typeOf [1,"a"]\n[t, head t, length t, typeOf (filter (> 0) [1,2])]', '[[Int,String],Int,2,[Int,Int]]'],
    ['[typeOf [], typeOf [[1],[2,3]], typeOf [1,2] <= List Int]', '[[],[[Int],[Int,Int]],True]'],
    // A name in a parameter's type that names a type is that type; a
    // function's argument there is a value.
    ['xs = [1,2]\nf (ys : typeOf xs) = 1\nf _ = 0\n[f [5,6], f 7]', '[1,0]'],
    ['t = [Int,Int]\nf (ys : t) = 1\nf _ = 0\n[f [5,6], f "ab", f 7]', '[1,0,0]'],
    ['a = Int\ng = typeOf\nf (x : a) = 1\nf _ = 0\nh (y : g 1) = 1\nh _ = 0\n[f 1, f "s", h 2, h "s"]', '[1,0,1,0]'],
    ['h = a -> a\nf (g : h) = 1\nf _ = 0\n[f (x -> x), f 2]', '[1,0]'],
    // A typed pattern takes what e : T makes of the value, and fails where it
    // fails: [Int,Int] is Vect 2 Int, a record type converts each field.
    ['f (ys : [Int,Int]) = ys\nf _ = 0\n[f [1], f ["a","b"], f [1,2], f [1.0,2], f [1,2.5]]', '[0,0,[1,2],[1,2],0]'],
    ['f (ys : Vect 2 Int) = ys\nf _ = 0\n[f [1], f ["a","b"], f [1,2], f [1.0,2], f [1,2.5]]', '[0,0,[1,2],[1,2],0]'],
    ['g (ys : [Float,Float]) = ys\nh (ys : Vect 2 Float) = ys\n[g [1,2], h [1,2]]', '[[1.0,2.0],[1.0,2.0]]'],
    ['p = [x : Int]\nf (v : p) = v.x\nf _ = 0\n[f [x = 3], f [x = "a"], f 5, f [x = 2.0]]', '[3,0,0,2]'],
    // A builtin's typing rule is its value's, whatever name it is bound to.
    ['g = typeOf\nhead (g [1,"a"])', 'Int'],
    ['len = length\nf (xs : Vect (len [1,2]) Int) = 1\nf _ = 0\n[f [1,2], f [1]]', '[1,0]'],
    ['w = while\nn = Mutable 0\nw [n < 3] (set n (n + 1))\nn + 0', '3'],
    ['i = isType\n[i (a -> a) (x -> x), i Int 1]', '[True,True]'],
    // Clauses and alternatives are tried most specific first, wherever written.
    ['f xs = "any"\nf [x,y] = "pair"\nf (x :: r) = "cons"\n[f [1,2], f [1], f []]', '["pair","cons","any"]'],
    ['[1,2] ~ [xs -> "any", x :: r -> "cons", [x,y] -> "pair"]', '"pair"'],
    ['f x y = "free"\nf x x = "same"\n[f 1 1, f 1 2]', '["same","free"]'],
    ['len xs = 0\nlen (x :: r) = 1 + len r\nlen [1,2,3]', '3'],
    ['g [x,0] = "a"\ng [0,y] = "b"\ng [0,0]', '"a"'],
    // A repeated name is a test the run makes, deciding no type.
    ['f x x = True\nf x y = False\n[f 1 1, f 1 2, f 1 "a"]', '[True,False,False]'],
    ['same (x : t) (y : t) = True\nsame x y = False\n[same 1 2, same 1 True]', '[True,False]'],
] as const) Deno.test(`list type ranges (checked=${checked}): ${source}`, () => {
    const i = new Interpreter();
    if (checked) i.enableChecking();
    const actual = i.renderString(i.run(parseDocument(source)));
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const checked of [true, false]) for (const source of ['[Int,String..]', '[Int..String]']) {
    Deno.test(`a range of a type has no step or bound (checked=${checked}): ${source}`, () => {
        const i = new Interpreter();
        if (checked) i.enableChecking();
        try { i.run(parseDocument(source)); } catch (error) {
            if ((error as Error).message.includes("a range of a type repeats it, without a step or bound")) return;
            throw error;
        }
        throw new Error("accepted");
    });
}
