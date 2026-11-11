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
// Name params = _ declares a constructor: an application that stands for
// nothing but itself, one field per parameter.
const CTOR = "Box x = _\nRect (w : Float) (h : Float) = _\nNothing = _\n";
// A union of such constructors claims them: one type, as a declaration makes.
const MAYBE = "Just x = _\nNada = _\nMaybe a = Just a | Nada\n";
const SHAPE = "Circle (r : Float) = _\nSquare (s : Float) = _\nShape = Circle | Square\n";
const OPTION = 'std <- import "std"; use std.option\n';
// A union of existing types is a type of its own values: made of nothing new.
const MIXED = "Mixed = (Int | String)\n";
const ID = "UserId (x : Int) = _\n";
// A body holding _ is the constructor's logic: it runs whenever one is made,
// and its _ is the value itself, the fields as the parameters bound them.
const PERCENT = "Percent (x : Float) = x > 100 ? Percent 100.0 : _\n";
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
        [CTOR + '[Box 5, Box "a"]', '[Box 5, Box "a"]'],
        [CTOR + "unbox (Box x) = x\nunbox (Box 5)", "5"],
        [CTOR + "area (Rect w h) = w * h\n[Rect 3 4, area (Rect 3 4)]", "[Rect 3.0 4.0, 12.0]"],
        [CTOR + "[Nothing, Nothing == Nothing]", "[Nothing,True]"],
        [CTOR + "Rect a b = Rect 3 4\n[a,b]", "[3.0,4.0]"],
        ["Pair a b = _\nPair 1 \"x\" ~ [Pair n s -> s]", '"x"'],
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
        [CTOR + "map (Rect 1) [2,3]", "[Rect 1.0 2.0, Rect 1.0 3.0]"],
        [CTOR + 'f (Rect w h) = "rect"\nf _ = "other"\n[f (Rect 1 2), f [1,2]]', '["rect","other"]'],
        [ID + "[UserId 5, typeOf (UserId 5), UserId 3 == 3]", "[UserId 5, UserId, False]"],
        [ID + "UserId a + UserId b = UserId (a + b)\nUserId 2 + UserId 3", "UserId 5"],
        // A constructor sharing its type's name is the type where one is
        // expected: a field's or a slot's type, isType, a type's argument.
        [ID + "Order (UserId u) (n : Int) = _\nOrder (UserId 5) 3", "Order (UserId 5) 3"],
        [ID + "[[v : UserId] [], isType UserId (UserId 1), typeOf (UserId 1) == UserId]", "[[v = UserId 0], True, True]"],
        [ID + "v = [id = UserId 1]\nv.id = UserId 2\nv.id", "UserId 2"],
        [CTOR + "([Box 1] : List Box)", "[Box 1]"],
        // Applied to types it is that type applied to them, where a type is
        // expected: a typed pattern (flat too), a field, isType, a slot. Its own
        // pattern, with as many arguments as fields, still takes it apart.
        [CTOR + 'f (b : Box Int) = b\nf _ = 0\ng (Box Int b) = b\ng _ = 0\nunbox (Box x) = x\n[f (Box 5), f (Box "a"), g (Box 5), g (Box "a"), unbox (Box 5)]',
            "[Box 5, 0, Box 5, 0, 5]"],
        [CTOR + "Wrap (Box Int b) = _\n[Wrap (Box 1), isType (Box Int) (Box 1), isType (Box Int) (Box 1.5)]", "[Wrap (Box 1), True, False]"],
        [CTOR + "[[b = Box Int] [], ([Box 1] : List (Box Int)), Box Int, typeOf (Box 1) == Box Int]", "[[b = Box 0], [Box 1], Box Int, True]"],
        [CTOR + "kind (Box t x) = t\nkind (Box 2)", "Int"],
        // typeOf gives the narrowest type: its fields decide its parameters,
        // and one nothing decides is a type variable.
        [OPTION + CTOR + "Pair a b = _\n[typeOf (Box 5), typeOf (Pair 1 \"x\"), typeOf (Some (Some 1)), typeOf None, typeOf (Ok 2)]",
            "[Box Int, Pair Int String, Option (Option Int), Option a, Result Int e]"],
        [OPTION + "Node a = Leaf | Cons a (Node a)\nxs = Cons 1 xs\n[typeOf (Cons 1 Leaf), typeOf xs, typeOf (Some 1) == Option]",
            "[Node Int, Node Int, True]"],
        [PERCENT + "[Percent 150, Percent 50, typeOf (Percent 1)]", "[Percent 100.0, Percent 50.0, Percent]"],
        [PERCENT + "Percent a + Percent b = Percent (a + b)\nPercent 90 + Percent 20", "Percent 100.0"],
        [PERCENT + "g (Percent v) = v\n[g (Percent 150), g (tag Percent Percent [150.0])]", "[100.0,150.0]"],
        [PERCENT + "map Percent [1,200]", "[Percent 1.0, Percent 100.0]"],
        ["Low (x : Int) = x > 5 ? Low 5 : _\n[l : Low] [l = Low 9]", "[l = Low 5]"],
        ["Even (n : Int) = n % 2 == 0 ? _ : Even (n + 1)\n[Even 3, Even 4]", "[Even 4, Even 4]"],
        ["Circle (r : Float) = r < 0 ? Circle (0 - r) : _\nSquare (s : Float) = _\nShape = Circle | Square\n[Circle -2, typeOf (Circle 1)]", "[Circle 2.0, Shape]"],
    ] as const) Deno.test(`core (checked=${checked}): ${source}`, () => {
        const actual = run(source, checked);
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
    for (const [source, message] of [
        [BOX + "unbox (Box x) = x\nunbox 5", checked ? "cannot use Int where Box is required" : "no clause"],
        [BOX + "Box 5 + 1", checked ? "cannot combine Box and Int" : "cannot apply '+'"],
        ["tag Int Int [1]", "tag's owner must be a type the program defines"],
        ["Box a = tag Box (x -> x) [a]\nBox 1", "tag's constructor must be a capitalized definition"],
        [CTOR + 'Rect "a" 2', checked ? "cannot use String where Float is required" : "Float expects a number"],
        [CTOR + "Box 5 + 1", checked ? "cannot combine Box Int and Int" : "cannot apply '+'"],
        ["Bad [x] = _\n1", "a constructor's field is a name or a typed name"],
        [MAYBE + '(Just "a" : Maybe Int)', checked ? "cannot use String where Int is required" : "Int expects a number"],
        ["Just x = _\nMaybe a = Just a | Nope\n1", "Maybe unions constructors declared with _, and Nope is not one"],
        [MIXED + "(2.5 : Mixed)", checked ? "cannot use Float where Int | String is required" : "Float is not one of Int | String"],
        ["Foo = Int | Bar\n1", "Foo mixes a type (Int) and a new constructor (Bar)"],
        [OPTION + "Two = Some | Int\n1", "Two's alternative Some is a constructor of another type"],
        [CTOR + "length (Rect 3 4)", checked ? "Rect" : "expected a list"],
        [CTOR + "area (Rect w h) = w * h\narea 5", checked ? "cannot use Int where Rect is required" : "no clause"],
        // A new type has only the operations its clauses define; a
        // constructor is not a conversion.
        [ID + "(UserId 5 : Int)", checked ? "cannot use UserId where Int is required" : "Int expects a number"],
        [ID + "f (UserId u) = u\nf 5", checked ? "cannot use Int where UserId is required" : "no clause"],
        [ID + "Order (UserId u) (n : Int) = _\nOrder 5 3", checked ? "cannot use Int where UserId is required" : "UserId expects a UserId variant"],
        [PERCENT + "Percent 50 + 1", checked ? "cannot combine Percent and Int" : "cannot apply '+'"],
        ['std <- import "std"; use std.function\nSpan (lo : Int) (hi : Int) = lo > hi ? fail "empty span" : _\n[s : Span] [s = Span 2 1]', "empty span"],
        ["Low (_ : Float) = 1 > 0 ? Low 1 : _\n1", "a constructor with logic names each field"],
        // A lowercase definition's _ stays unfinished.
        ["f x = _\nf 1", "not implemented"],
    ] as const) Deno.test(`core rejects (checked=${checked}): ${source}`, () => {
        const actual = failure(source, checked);
        if (!actual.includes(message)) throw new Error(actual);
    });
}
// A to String instance is how a value shows, wherever it is.
const SHOW = 'std <- import "std"; use std.option\nPoint x y = _\nto String (Point x y) = to String x ++ "@" ++ to String y\n';
for (const checked of [true, false]) for (const [source, expected] of [
    [SHOW + "[Point 1 2, Point 3 4]", "[1@2,3@4]"],
    [SHOW + "Some (Point 1 2)", "Some (1@2)"],
    [SHOW + "to String [Point 1 2]", '"[1@2]"'],
    [SHOW + '"at " ++ to String (Point 1 2)', '"at 1@2"'],
] as const) Deno.test(`to String shows a value (checked=${checked}): ${source}`, () => {
    const actual = run(source, checked);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
// What the checker alone can tell.
for (const [source, message] of [
    [CTOR + "f (Rect w h d) = w\n1", "'Rect' in a pattern takes 2 fields"],
    [CTOR + 'f (Rect w h) = w ++ "x"\nf (Rect 1 2)', "cannot append Float and String"],
    ['Bad (x : Int) = x > 0 ? "no" : _\n1', "cannot use String where Bad is required"],
] as const) Deno.test(`constructors are checked: ${source}`, () => {
    const actual = failure(source, true);
    if (!actual.includes(message)) throw new Error(actual);
});
// The first union listing constructors declared with _ owns them, also where
// they were declared in an earlier input or a module, which the parser cannot
// see: as in one input, typeOf and monads key on the union.
for (const checked of [true, false]) Deno.test(`a later union claims constructors (checked=${checked})`, () => {
    const i = new Interpreter();
    if (checked) i.enableChecking();
    const each = (source: string) => i.renderString(i.run(parseDocument(source)));
    each("Just x = _\nNada = _");
    each("Maybe a = Just a | Nada\nreturn = Just\nJust x >>= f = f x\nNada >>= f = Nada");
    const shown = each("[typeOf (Just 5), typeOf Nada, ({ x <- Just 2; return (x * 3) } : Maybe Int)]");
    if (shown !== "[Maybe Int, Maybe a, Just 6]") throw new Error(shown);
    each("Box x = _");
    let message = "";
    try { each("Mixed = Box | Int"); } catch (error) { message = (error as Error).message; }
    if (!message.includes("Mixed unions constructors declared with _, and Int is not one")) throw new Error(message);
});
