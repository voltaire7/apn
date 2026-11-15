import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

function result(source: string): string {
    const i = new Interpreter();
    return i.renderString(i.run(parseDocument(source)));
}
for (const [source, expected] of [
    ['[Int,Float,Int8,UInt,Float32,Float64]', '[Int,Float,Int8,UInt,Float32,Float64]'],
    ['[Bool,String,Char,[],List,Record,HashMap,Pointer]', '[Bool,String,Char,[],List,Record,HashMap,Pointer]'],
    ['[Int == 0, Float == 0, Int == Float, Int == Int]', '[False,False,False,True]'],
    ['[isType Int Int, isType Bool Bool, isType Type Int]', '[False,False,True]'],
    ['[typeOf Int, typeOf (1 : Int), typeOf (1 : Float), typeOf (1 : Int32)]', '[Type,Int,Float,Int32]'],
    ['(identity : Int -> Float) <- return (x -> x)\n[(Int : Type), ([Int] : Type), ([x : Float] : Type), typeOf identity]', '[Int, [Int], [x : Float], Int -> Float]'],
    ['Count (x : Int) = _\n[Count, Count 3]', '[Count, Count 3]'],
    ['f (t : Type) = 123 : t\nf Int', '123'],
    ['f (x : t) = [t,x]\nf (7 : Int32)', '[Int32,7]'],
    ['[Int]', '[Int]'],
    ['xs = ([0] : [Int])\nxs 0 = 2\nxs', '[2]'],
    ['to Int * [1,2,3]', '[1,2,3]'],
    ['[].[]', '[]'],
    ['take 2 (map (to Int) [1,2,missing])', '[1,2]'],
    ['[to Int * 3, 3 * to Int, 3 * (0 : Int)]', '[[0,1,2],[0,1,2],0]'],
    ['V = [x : Float, y : Float, z : Float]\nv = [] : V\nv.x = 1\n[v, (V : Type)]', '[[x = 1.0, y = 0.0, z = 0.0], [x : Float, y : Float, z : Float]]'],
    ['V = [x : Float, y : Float]\n([x = 1] : V)', '[x = 1.0, y = 0.0]'],
    ['V = [x : Float, y : Float]\n([1,2] : V)', '[x = 1.0, y = 2.0]'],
    ['v = [] : [x : Float]\nv.x = 2\ntypeOf v.x', 'Float'],
    ['v = [] : [x : Int8]\nv.x = 12\nv', '[x = 12]'],
    ['([] : [x : Float, label = "origin", count = 7])', '[x = 0.0, label = "origin", count = 7]'],
    ['([extra = 3] : [x : Int, y : Int])', '[x = 0, y = 0, extra = 3]'],
    // A declaration no definition follows is its type's zero, as a slot is.
    ['x : Int\ny : [a : Float]\nU (v : Int) = _\nu : U Int\n[x,y,u]', '[0, [a = 0.0], U 0]'],
    ['x = 3\nx : String\nx', '""'],
    ['g n = {\n    y : Int\n    n + y\n}\ng 1', '1'],
    ['([] : [nested : [x : Float], xs : [Int]])', '[nested = [x = 0.0], xs = [0]]'],
    ['v = [] : [x : Int, bad : Function]\nv.x', '0'],
    ['cell = Mutable 1\nv = [cell = cell] []\nset v.cell $ 2\ncell', '2'],
    ['Option a = Some a | None\n[Option, Option Int]', '[Option, Option Int]'],
    ['Option a = Some a | None\n([] : [choice : Option Int])', '[choice = None]'],
    ['User = | MkUser Int String\n([] : [user : User])', '[user = MkUser 0 ""]'],
    ['BoxType a = | MkBox a\n([] : [box = BoxType (BoxType Int)])', '[box = MkBox (MkBox 0)]'],
    ['Node = Next Node | End\n([] : [node : Node])', '[node = End]'],
    ['Node = | Next Node\nNode', 'Node'],
    ['([x -> x] : [fn : Function])', '[fn = x -> x]'],
    ['(v -> v.fn 2) $ [fn = (+ 1)] []', '3'],
    ['[(floor .2 : Int), (truncate -1.7 : Int), (inexact 9007199254740993 : Float)]', '[0,-1,9007199254740992.0]'],
] as const) Deno.test(`construction defaults: ${source}`, () => {
    const actual = result(source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const [type, expected] of [
    ['Int', '0'], ['Float', '0.0'], ['Int8', '0'], ['UInt', '0'],
    ['Float32', '0.0'], ['Float64', '0.0'],
    ['Fraction', '0'], ['Complex', '0'], ['ComplexExact', '0'],
    ['Number', '0'], ['Real', '0'], ['Integer', '0'], ['Exact', '0'], ['Inexact', '0.0'],
    ['Bool', 'False'], ['String', '""'], ['Char', "'\\0'"], ['[]', '[]'],
    ['List', '[]'], ['Record', '[]'], ['HashMap', '([] : HashMap _ _)'], ['Pointer', 'Pointer 0x0'],
]) Deno.test(`omitted ${type} slot initializes`, () => {
    const actual = result(`([] : [value = ${type}])`);
    if (actual !== `[value = ${expected}]`) throw new Error(actual);
});
for (const source of [
    'Int + 1', 'sqrt Float', '-Int', 'Int ^ 2', 'Int < 1',
 'String ++ "hi"', 'length List', '[Int,Float] + [1,2]',
    'f (x : Int) = x + 1\nf Int', 'f (x : Bool) = x\nf Bool',
    '(.2 : Int)', 'to Int .2', '([.2] : [Int])',
    'v = [] : [x : Int]\nv.x = .2',
    'v = [] : [x : Int8]\nv.x = 128',
    '([1,2] : [x : Int])',
    'Node = | Next Node\n([] : [node : Node])',
    'BoxType a = | MkBox a\n([] : [box : BoxType])',
    '([] : [fn : Function])', '([] : [cell : Mutable])', '([] : [ty : Type])',
]) Deno.test(`reject invalid construction or bare-type data: ${source}`, () => {
    try { result(source); } catch { return; }
    throw new Error('Expected error');
});

Deno.test("failed typed-value conversion preserves the record", () => {
    for (const assignment of ['v.x = .2', 'v "x" = .2', 'v.[x,y] = [.2,2]']) {
        const i = new Interpreter();
        i.run(parseDocument('v = [] : [x : Int, y : Int]'));
        let rejected = false;
        try { i.run(parseDocument(assignment)); } catch (e) {
            if (!String(e).includes('lossy conversion')) throw e;
            rejected = true;
        }
        if (!rejected || i.renderString(i.env.get('v')!) !== '[x = 0, y = 0]') throw new Error(assignment);
    }
});

Deno.test("omitted concrete actions stay callable without running during inspection", () => {
    const i = new Interpreter();
    i.run(parseDocument('count = Mutable 0; action = { set count $ count + 1 }; v <- return ([action = action] [])'));
    i.renderString(i.env.get('v')!);
    if (i.renderString(i.run(parseDocument('count'))) !== '0') throw new Error('inspection executed action');
    i.run(parseDocument('v.action'));
    if (i.renderString(i.run(parseDocument('count'))) !== '1') throw new Error('action lost');
});

for (const values of ['[1]', '[1,2]', '[1,2,3,4]']) {
    Deno.test(`positional construction requires all fields: ${values}`, () => {
        try { result(`Vector3 = [x : Float, y : Float, z : Float]\n(${values} : Vector3)`); }
        catch (e) {
            if (String(e).includes('field count')) return;
            throw e;
        }
        throw new Error('expected field count error');
    });
}

for (const [source, expected] of [
    ['Vector3 = [x : Float, y : Float, z : Float]\nvec = Vector3\nvec.x = 123\n[vec, (Vector3 : Type)]', '[[x = 123.0, y : Float, z : Float], [x : Float, y : Float, z : Float]]'],
    ['v = [x : Int]\nv "x" = 1\nv', '[x = 1]'],
    ['v = [x : Int, y : Float]\nv.[x,y] = [1,2]\nv', '[x = 1, y = 2.0]'],
    ['xs = [Int]\nxs 0 = 1\nxs', '[1]'],
    ['xs = [Int,Float]\nxs -1 = 2\nxs', '[Int,2.0]'],
    ['xs = [Int]\ni = 0\nxs (i + 0) = 1\nxs', '[1]'],
    ['UserId (x : Int) = _\nv = [id : UserId Int]\nv.id = UserId 3\nv', '[id = UserId 3]'],
    ['(identity : Int -> Int) <- return (x -> x); v = [f = typeOf identity]\nv.f = (+ 1)\nv.f 2', '3'],
] as const) Deno.test(`assignment gives a type field a default: ${source}`, () => {
    const actual = result(source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
