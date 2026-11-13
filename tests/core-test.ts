import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

// The core's data: tag makes a value that remembers its constructor, owner
// and fields, which patterns read back. Checked and unchecked runs agree.
function run(source: string, checked: boolean): string {
    const i = new Interpreter();
    if (checked) i.enableChecking();
    return i.renderString(i.run(parseDocument(source)));
}
function failure(source: string, checked: boolean): string {
    try { run(source, checked); } catch (error) { return (error as Error).message; }
    throw new Error(`accepted: ${source}`);
}

const BOX = "Box a = tag Box Box [a]\n";
// A type's constructors are declared in its union, each named apart from it.
const CTOR = "Box a = | MkBox a\nRect = | MkRect Float Float\n";
const MAYBE = "Maybe a = Just a | Nada\n";
const SHAPE = "Shape = Circle Float | Square Float\n";
const OPTION = 'std <- import "std"; use std.option\n';
// A union of existing types is a type of its own values: made of nothing new.
const MIXED = "Mixed = (Int | String)\n";
const ID = "UserId = | MkUserId Int\n";
// A value that must keep a condition is a refinement's, made by a function.
const PERCENT = "Percent = (x : Float) | x <= 100\npercent x = min x 100 : Percent\n";
for (const checked of [true, false]) {
    for (const [source, expected] of [
        [BOX + "Box 5", "Box 5"],
        [BOX + "typeOf (Box 5)", "Box"],
        [BOX + "unbox (Box x) = x\nunbox (Box 5)", "5"],
        [BOX + "[Box 5 == Box 5, Box 5 == Box 6]", "[True,False]"],
        ["Pt x y = tag Pt Pt [x,y]\nPt 1 2 ~ [Pt a b -> a + b]", "3"],
        // A declared constructor's tag is its own value.
        [OPTION + "tag Option Some [5] == Some 5", "True"],
        [OPTION + "tag Option None [] ~ [None -> 0, Some x -> x]", "0"],
        [CTOR + '[MkBox 5, MkBox "a"]', '[MkBox 5, MkBox "a"]'],
        [CTOR + "unbox (MkBox x) = x\nunbox (MkBox 5)", "5"],
        [CTOR + "area (MkRect w h) = w * h\n[MkRect 3 4, area (MkRect 3 4)]", "[MkRect 3.0 4.0, 12.0]"],
        [CTOR + "MkRect a b = MkRect 3 4\n[a,b]", "[3.0,4.0]"],
        ["Pair a b = | MkPair a b\nMkPair 1 \"x\" ~ [MkPair n s -> s]", '"x"'],
        [MAYBE + "[Just 5, Nada, typeOf (Just 5)]", "[Just 5, Nada, Maybe Int]"],
        [MAYBE + "f (Just x) = x\nf Nada = 0\n[f (Just 3), f Nada]", "[3,0]"],
        [MAYBE + "(Just 2 : Maybe Int)", "Just 2"],
        [MAYBE + "return = Just\nJust x >>= f = f x\nNada >>= f = Nada\n({ x <- Just 2; return (x * 3) } : Maybe Int)", "Just 6"],
        [SHAPE + "area (Circle r) = 3 * r * r\narea (Square s) = s * s\nmap area [Circle 1, Square 2]", "[3.0,4.0]"],
        [SHAPE + 'g (s : Shape) = "shape"\n[typeOf (Circle 1), g (Square 1)]', '[Shape,"shape"]'],
        [MIXED + "[Mixed, (Mixed : Type)]", "[Mixed, Int | String]"],
        [MIXED + 'f (m : Mixed) = "mixed"\nf _ = "other"\n[f 1, f "a", f 2.5]', '["mixed","mixed","other"]'],
        [MIXED + '[(5 : Mixed), isType Mixed "s"]', "[5,True]"],
        [OPTION + "OptOrList a = (Option a | List a)\n[OptOrList Int, isType (OptOrList Int) [1]]", "[OptOrList Int, True]"],
        [CTOR + "map (MkRect 1) [2,3]", "[MkRect 1.0 2.0, MkRect 1.0 3.0]"],
        [CTOR + 'f (MkRect w h) = "rect"\nf _ = "other"\n[f (MkRect 1 2), f [1,2]]', '["rect","other"]'],
        [ID + "[MkUserId 5, typeOf (MkUserId 5), MkUserId 3 == 3]", "[MkUserId 5, UserId, False]"],
        [ID + "MkUserId a + MkUserId b = MkUserId (a + b)\nMkUserId 2 + MkUserId 3", "MkUserId 5"],
        // A type is the type where one is expected: a field's or a slot's
        // type, isType, a type's argument.
        [ID + "Order = | MkOrder UserId Int\nMkOrder (MkUserId 5) 3", "MkOrder (MkUserId 5) 3"],
        [ID + "[([] : [v : UserId]), isType UserId (MkUserId 1), typeOf (MkUserId 1) == UserId]", "[[v = MkUserId 0], True, True]"],
        [ID + "v = [id = MkUserId 1]\nv.id = MkUserId 2\nv.id", "MkUserId 2"],
        [CTOR + "([MkBox 1] : List (Box Int))", "[MkBox 1]"],
        // So in a typed pattern, a field, isType, a slot; with a type variable
        // it binds the field's type. Its constructor's pattern takes it apart.
        [CTOR + 'f (b : Box Int) = b\nf _ = 0\nunbox (MkBox x) = x\n[f (MkBox 5), f (MkBox "a"), unbox (MkBox 5)]', "[MkBox 5, 0, 5]"],
        [CTOR + "Wrap = | MkWrap (Box Int)\n[MkWrap (MkBox 1), isType (Box Int) (MkBox 1), isType (Box Int) (MkBox 1.5)]", "[MkWrap (MkBox 1), True, False]"],
        [CTOR + "[([] : [b : Box Int]), ([MkBox 1] : List (Box Int)), typeOf (MkBox 1) == Box Int]", "[[b = MkBox 0], [MkBox 1], True]"],
        [CTOR + "kind (x : Box t) = t\nkind (MkBox 2)", "Int"],
        // A constructor given types is the type of the values it makes.
        [OPTION + "[isType (Some Int) (Some 1), isType (Some Int) None, isType (Some Int) (Some 1.5)]", "[True,False,False]"],
        // typeOf gives the narrowest type: its fields decide its parameters,
        // and one nothing decides is a type variable.
        [OPTION + CTOR + "Pair a b = | MkPair a b\n[typeOf (MkBox 5), typeOf (MkPair 1 \"x\"), typeOf (Some (Some 1)), typeOf None, typeOf (Ok 2)]",
            "[Box Int, Pair Int String, Option (Option Int), Option a, Result Int e]"],
        [OPTION + "Node a = Leaf | Branch a (Node a)\nxs = Branch 1 xs\n[typeOf (Branch 1 Leaf), typeOf xs, typeOf (Some 1) == Option]",
            "[Node Int, Node Int, True]"],
        // A refinement keeps its name; a function keeps its condition.
        [PERCENT + "[percent 150, percent 50, typeOf (percent 1)]", "[100.0,50.0,Percent]"],
        [PERCENT + "[percent 90 + 5, typeOf (percent 90 + 5)]", "[95.0,Percent]"],
    ] as const) Deno.test(`core (checked=${checked}): ${source}`, () => {
        const actual = run(source, checked);
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
    for (const [source, message] of [
        [BOX + "unbox (Box x) = x\nunbox 5", checked ? "cannot use Int where Box is required" : "no clause"],
        [BOX + "Box 5 + 1", checked ? "cannot combine Box and Int" : "cannot apply '+'"],
        ["tag Int Int [1]", "tag's owner must be a type the program defines"],
        ["Box a = tag Box (x -> x) [a]\nBox 1", "tag's constructor must be a capitalized definition"],
        [CTOR + 'MkRect "a" 2', checked ? "cannot use String where Float is required" : "Float expects a number"],
        [CTOR + "MkBox 5 + 1", checked ? "cannot combine Box Int and Int" : "cannot apply '+'"],
        // One name means one thing: a constructor is named apart from its
        // type, and has no logic.
        ["Box x = _\n1", "a constructor is declared in its type's union, named apart from it"],
        ["Point = | Point Int Int\n1", "the constructor Point shares its type's name"],
        ["Low (x : Int) = x > 5 ? Low 5 : _\n1", "a constructor has no logic: name its values with a refinement"],
        [MAYBE + '(Just "a" : Maybe Int)', checked ? "cannot use String where Int is required" : "Int expects a number"],
        [MIXED + "(2.5 : Mixed)", checked ? "cannot use Float where Int | String is required" : "Float is not one of Int | String"],
        ["Foo = Int | Bar\n1", "Foo mixes a type (Int) and a new constructor (Bar)"],
        [OPTION + "Two = Some | Int\n1", "Two's alternative Some is a constructor of another type"],
        [CTOR + "length (MkRect 3 4)", checked ? "Rect" : "expected a list"],
        [CTOR + "area (MkRect w h) = w * h\narea 5", checked ? "cannot use Int where Rect is required" : "no clause"],
        // A new type has only the operations its clauses define; a
        // constructor is not a conversion.
        [ID + "(MkUserId 5 : Int)", checked ? "cannot use UserId where Int is required" : "Int expects a number"],
        [ID + "f (MkUserId u) = u\nf 5", checked ? "cannot use Int where UserId is required" : "no clause"],
        [ID + "Order = | MkOrder UserId Int\nMkOrder 5 3", checked ? "cannot use Int where UserId is required" : "UserId expects a UserId variant"],
        [PERCENT + "percent 90 + 20", "is not in Percent"],
        // A lowercase definition's _ stays unfinished.
        ["f x = _\nf 1", "not implemented"],
    ] as const) Deno.test(`core rejects (checked=${checked}): ${source}`, () => {
        const actual = failure(source, checked);
        if (!actual.includes(message)) throw new Error(actual);
    });
}
// A to String instance is how a value shows, wherever it is.
const SHOW = 'std <- import "std"; use std.option\nPoint = | MkPoint Int Int\nto String (MkPoint x y) = to String x ++ "@" ++ to String y\n';
for (const checked of [true, false]) for (const [source, expected] of [
    [SHOW + "[MkPoint 1 2, MkPoint 3 4]", "[1@2,3@4]"],
    [SHOW + "Some (MkPoint 1 2)", "Some (1@2)"],
    [SHOW + "to String [MkPoint 1 2]", '"[1@2]"'],
    [SHOW + '"at " ++ to String (MkPoint 1 2)', '"at 1@2"'],
] as const) Deno.test(`to String shows a value (checked=${checked}): ${source}`, () => {
    const actual = run(source, checked);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
// What the checker alone can tell.
for (const [source, message] of [
    [CTOR + "f (MkRect w h d) = w\n1", "'MkRect' in a pattern takes 2 fields"],
    [CTOR + 'f (MkRect w h) = w ++ "x"\nf (MkRect 1 2)', "cannot append Float and String"],
] as const) Deno.test(`constructors are checked: ${source}`, () => {
    const actual = failure(source, true);
    if (!actual.includes(message)) throw new Error(actual);
});
