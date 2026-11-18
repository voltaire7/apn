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
// Name fields : T = _ declares a constructor into T: one type, as a union
// declaration (Maybe a = Just a | Nada) makes.
const MAYBE = "Just x : Maybe x = _\nNada : Maybe a = _\n";
const SHAPE = "Circle (r : Float) : Shape = _\nSquare (s : Float) : Shape = _\n";
const OPTION = 'std <- import "std"; [..] = std.option\n';
// A union of existing types is a type of its own values: made of nothing new.
const MIXED = "Mixed = (Int | String)\n";
const ID = "UserId (x : Int) = _\n";
// A body holding _ is the constructor's logic: it runs whenever one is made,
// and its _ is the value itself, the fields as the parameters bound them.
const PERCENT = "Percent (x : Float) = x > 100 ? Percent 100.0 : _\n";
for (const checked of [true, false]) {
    for (const [source, expected] of [
        [BOX + "Box 5", "Box 5"],
        // A definition tagging its own values is what Box x = _ declares.
        [BOX + "[typeOf (Box 5), typeOf (Box \"a\")]", "[Box Int, Box String]"],
        ["Pt x y = tag Pt Pt [y,x]\ntypeOf (Pt 1 \"a\")", "Pt Int String"],
        // A type taking parameters is a function of types.
        [OPTION + "f (g : Type -> Type) = g Int\n[f Option, map Option [Int,String], map (t -> List t) [Int,String]]",
            "[Option Int, [Option Int, Option String], [List Int, List String]]"],
        [OPTION + "[isType Function Option, isType Function Int, isType (Type -> Type) List]", "[True,False,True]"],
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
        [MIXED + '[(5 : Mixed), isType Mixed "s"]', "[5, True]"],
        [OPTION + "OptOrList a = (Option a | List a)\n[OptOrList Int, isType (OptOrList Int) [1]]", "[OptOrList Int, True]"],
        [CTOR + "map (Rect 1) [2,3]", "[Rect 1.0 2.0, Rect 1.0 3.0]"],
        [CTOR + 'f (Rect w h) = "rect"\nf _ = "other"\n[f (Rect 1 2), f [1,2]]', '["rect","other"]'],
        [ID + "[UserId 5, typeOf (UserId 5), UserId 3 == 3]", "[UserId 5, UserId Int, False]"],
        [ID + "UserId a + UserId b = UserId (a + b)\nUserId 2 + UserId 3", "UserId 5"],
        // A constructor given a type for each field is the type of the values
        // it makes: a field's or a slot's type, isType, a type's argument.
        [ID + "Order (u : UserId Int) (n : Int) = _\nOrder (UserId 5) 3", "Order (UserId 5) 3"],
        [ID + "[([] : [v : UserId Int]), isType (UserId Int) (UserId 1), typeOf (UserId 1) == UserId Int]", "[[v = UserId 0], True, True]"],
        [ID + "v = [id = UserId 1]\nv.id = UserId 2\nv.id", "UserId 2"],
        [CTOR + "([Box 1] : List (Box Int))", "[Box 1]"],
        // So in a typed pattern, a field, isType, a slot; with a type variable
        // it binds the field's type. Its own pattern still takes it apart.
        [CTOR + 'f (b : Box Int) = b\nf _ = 0\nunbox (Box x) = x\n[f (Box 5), f (Box "a"), unbox (Box 5)]', "[Box 5, 0, 5]"],
        [CTOR + "Wrap (b : Box Int) = _\n[Wrap (Box 1), isType (Box Int) (Box 1), isType (Box Int) (Box 1.5)]", "[Wrap (Box 1), True, False]"],
        [CTOR + "[([] : [b = Box Int]), ([Box 1] : List (Box Int)), Box Int, typeOf (Box 1) == Box Int]", "[[b = Box 0], [Box 1], Box Int, True]"],
        [CTOR + "kind (x : Box t) = t\nkind (Box 2)", "Int"],
        // typeOf gives the narrowest type: its fields decide its parameters,
        // and one nothing decides is a type variable.
        [OPTION + CTOR + "Pair a b = _\n[typeOf (Box 5), typeOf (Pair 1 \"x\"), typeOf (Some (Some 1)), typeOf None, typeOf (Ok 2)]",
            "[Box Int, Pair Int String, Option (Option Int), Option a, Result Int e]"],
        [OPTION + "Node a = Leaf | Branch a (Node a)\nxs = Branch 1 xs\n[typeOf (Branch 1 Leaf), typeOf xs, typeOf (Some 1) == Option, typeOf (Some 1) == Option Int]",
            "[Node Int, Node Int, False, True]"],
        [PERCENT + "[Percent 150, Percent 50, typeOf (Percent 1)]", "[Percent 100.0, Percent 50.0, Percent Float]"],
        [PERCENT + "Percent a + Percent b = Percent (a + b)\nPercent 90 + Percent 20", "Percent 100.0"],
        [PERCENT + "g (Percent v) = v\n[g (Percent 150), g (tag Percent Percent [150.0])]", "[100.0,150.0]"],
        [PERCENT + "map Percent [1,200]", "[Percent 1.0, Percent 100.0]"],
        ["Low (x : Int) = x > 5 ? Low 5 : _\n[([l = Low 9] : [l : Low Int]), Low Int]", "[[l = Low 5], Low Int]"],
        ["Even (n : Int) = n % 2 == 0 ? _ : Even (n + 1)\n[Even 3, Even 4]", "[Even 4, Even 4]"],
        // _ given to a type is any, as in a pattern; <= asks for a type within it.
        [OPTION + CTOR + "[List _, Option _, Box _]", "[List _, Option _, Box _]"],
        [OPTION + CTOR + "[typeOf [1,2] <= List _, typeOf 3 <= List _, typeOf (Some 1) <= Option _, typeOf (Box 1) <= Box _]",
            "[True,False,True,True]"],
        [OPTION + "[isType (List _) [1, \"a\"], ([1] : List _), Option _ <= Option Int, typeOf [1,2] == List _]", "[True, [1], False, False]"],
        // Every value is a set: <= is inclusion, & intersection, | union.
        ["[[1] <= [1,2], [2] <= [1,2], [1,2] <= [1,3], [1] < [1,2], [1] < [1], [] <= [1]]", "[True,False,False,True,False,True]"],
        ['["ab" <= "b", "a" <= "ab", False < True, 2 <= 3, Int <= Number]', "[False,True,True,True,True]"],
        ["[[x = 1] <= [x = 1, y = 2], [x = 2] <= [x = 1, y = 2]]", "[True,False]"],
        ['[[1,2] & [1,3], ["abc" & "abd"], [3 & 5], [3 | 5], [1] | [1,2]]', '[[1],["ab"],[3],[5],[1,2]]'],
        ["[[x = 1, y = 2] & [x = 1, y = 3], [x = 1] | [y = 2]]", "[[x = 1], [x = 1, y = 2]]"],
        ["Big = (n : Int) | n > 2\n[(5 : Int & Big), Int & Big <= Int, Int <= Int & Big]", "[5, True, False]"],
        // Rules written before a constructor's declaration run first; the
        // declaration is the otherwise.
        ['Var (s : String) : Expr = _\nNum (n : Int) : Expr = _\nAdd x (Num 0) = x\nAdd (Num a) (Num b) = Num (a + b)\nAdd (x : Expr) (y : Expr) : Expr = _\n'
            + '[Add (Var "a") (Num 0), Add (Num 2) (Num 3), Add (Var "a") (Var "b"), typeOf (Add (Var "a") (Var "b"))]', '[Var "a", Num 5, Add (Var "a") (Var "b"), Expr]'],
        ["Frac n 0 = Frac 0 1\nFrac (n : Int) (d : Int) = _\n[Frac 1 2, Frac 3 0, Frac 1.0 2]", "[Frac 1 2, Frac 0 1, Frac 1 2]"],
        ["f = {\n    Lit (n : Int) : Term = _\n    Neg (Neg x) = x\n    Neg (x : Term) : Term = _\n    [Neg (Neg (Lit 3)), Neg (Lit 2)]\n}\nf", "[Lit 3, Neg (Lit 2)]"],
        // A type is a constructor declared into Type; its constructors are
        // declared into it, and with none it is empty.
        ["Opt x : Type = _\nSome a : Opt a = _\nNone : Opt a = _\n[typeOf (Some 1), typeOf None, Opt Int, typeOf (Opt Int)]", "[Opt Int, Opt x, Opt Int, Type]"],
        ["Void : Type = _\n[isType Void 3, Void]", "[False,Void]"],
        // Without : T a constructor is its own type; one shadows a built-in type.
        ["Type = _\n[Type, typeOf Type, isType Type Type, isType Type Int]", "[Type,Type,True,False]"],
        ["Type : Type = _\nT : T = _\n[typeOf Type, typeOf T, isType Type Int]", "[Type,T,False]"],
        // left : T = body for any name: T is the type of the left, a call's
        // result where it has parameters.
        ["func (x : Int) (y : Int) : Int = x + y\n[func 2 3, typeOf func]", "[5, Int -> Int -> Int]"],
        ["adder n : Int -> Int = x -> x + n\nfunc Int Int : Int = 123\n[adder 2 3, func Int Int]", "[5,123]"],
        ["Twice t : Type = [t,t]\nPi : Float = 3\n[([1,2] : Twice Int), Pi]", "[[1,2], 3.0]"],
        ["g = {\n    h (x : Int) : Int = x * 2\n    Box x : Box x = _\n    [h 4, Box 1]\n}\ng", "[8, Box 1]"],
        // _ makes data for any name; a name applied in a pattern means what it
        // is bound to: data matches its terms, a free name binds.
        ["sin 0 = 0\nsin x = _\ncos x = _\nd (sin x) = cos x\n[sin 0, sin 2, sin 2 == sin 2, d (sin 3)]", "[0, sin 2, True, cos 3]"],
        ["sin 0 = 0\nsin x = _\ng y = sin y\ntypeOf (g 2)", "sin Int"],
        ["f x = _\nk = _\n[f 2, k, typeOf (f 2)]", "[f 2, k, f Int]"],
        ["sin x = _\nsin 5 ~ [(sin y) -> y, _ -> 0]", "5"],
        ["pos x = x + 1\nxs = [10,20,30]\nxs (pos 0) = 99\nshape (t1 1 t2) = [t1,t2]\n[xs, shape (Vect 1 Int)]", "[[10,99,30],[Vect,Int]]"],
        // A definition names the type it gives, whatever its case.
        ["meters = Int\npos = (n : Int) | n > 0\n[typeOf (3 : meters), typeOf (3 : pos), (3 : meters) + 1]", "[meters,pos,4]"],
        // A name for a constructor is it; a block's patterns read its names.
        ["Box x = _\nNewBox = Box\nfunc (NewBox x) = x\n[func (NewBox 123), NewBox 1 == Box 1, func (Box 5)]", "[123, True, 5]"],
        ["g = {\n    sin x = _\n    Pair a b = _\n    d (sin x) = x\n    f (p : Pair Int _) = 1\n    [d (sin 3), f (Pair 1 2)]\n}\ng", "[3,1]"],
        ["func = [x, y] -> [x + x, y + y]\nh [x, y] = [x + x, y + y]\n[func [1,2], h [3,4]]", "[[2,4],[6,8]]"],
        // The checker types set operations on records and numeric types exactly.
        ["r = [x = 1] | [y = 2]\ns = [x = 1, y = 2] & [x = 1, y = 3]\nf (n : Number & Int) = n + 1\n[r.y + 1, s.x, f 2]", "[3,1,3]"],
        // A list or record is a value; it is read as a type where one is expected.
        ["[[1] | [1,2], [Int] <= [Int,Int], [Int] | [Int,Int], [Int] <= List Int, [Int,Int] == typeOf [1,2]]", "[[1,2], True, [Int,Int], True, True]"],
        ["Two = [Int] | [Int,Int]\nf (x : [Int] | [Int,Int]) = 1\n[isType Two [1,2], isType Two [1,2,3], f [1], f [1,2]]", "[True, False, 1, 1]"],
        // A conversion instance takes a constructor's own type as written.
        [CTOR + "to (Box Int) (n : Int) = Box n\nf (b : Box Int) = b\n[(3 : Box Int), f 4]", "[Box 3, Box 4]"],
        [MAYBE + "[typeOf Nada, typeOf (Just Nada)]", "[Maybe x, Maybe (Maybe x)]"],
        ["Pos (x : Int) : Num = x < 0 ? Pos (0 - x) : _\n[Pos -2, typeOf (Pos 1)]", "[Pos 2, Num]"],
        ["N : V Z a = _\nC a (xs : V k a) : V (S k) a = _\ntypeOf (C 1 (C 2 N))", "V 2 Int"],
        ["f = {\n    Lo : Lvl = _\n    Hi : Lvl = _\n    [Lo, typeOf Hi]\n}\nf", "[Lo,Lvl]"],
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
        ["Bad [x] = _\n1", "a constructor's field is a name, a typed name or a record of typed fields"],
        ["[1,2] | [1,3]", "[1,2] | [1,3] is no list: neither starts the other"],
        ["r = [x = 1] & [y = 2]\nr.y", checked ? "missing field 'y'" : "record has no field 'y'"],
        // A type is given types; a value is ascribed.
        [OPTION + "f t = Option t\nf 3", checked ? "cannot use Int where Type (a) is required" : "Option is a type, not a function"],
        ["Big = (n : Int) | n > 2\n(1 : Int & Big)", "is not in Int & Big"],
        ["Add x 0 = x\nAdd (x : Int) = _\n1", "every clause of Add takes 1 parameters, as its declaration"],
        ["Opt a : _\n1", "a type is declared into Type"],
        ["pos x = x + 1\ng (pos 0) = 1\ng 1", "pos is a function, not data: a pattern cannot call it"],
        ["sin 0 = 0\nsin x = _\nd (sin x) = x\nd (sin 0)", checked ? "cannot use Int where sin Int is required" : "no clause of 'd' matches"],
        ["f x : Int = \"no\"\nf 1", checked ? "cannot use String where Int is required" : "Int expects a number"],
        ["f x : Int\n1", "f with parameters is typed in its definition"],
        ["Box x : _ = _\n1", "a constructor is its own type without : T"],
        ["Opt (a : Int) : Type = _\n1", "a type's parameters are names"],
        // A name keeps its arity: a type is given all its parameters.
        ["f (xs : List) = xs\nf [1]", "List takes 1 type parameter; a type is given all of them"],
        [MAYBE + "f (m : Maybe) = m\nf Nada", "Maybe takes 1 type parameter; a type is given all of them"],
        [SHAPE + "Circle (d : Float) : Shape = _\n1", "Circle is already a constructor of Shape"],
        ["Some a : Opt a = _\nNone : Opt = _\n1", "Opt takes 1 type parameter, as declared"],
        [MAYBE + '(Just "a" : Maybe Int)', checked ? "cannot use String where Int is required" : "Int expects a number"],
        // A union declares its constructors: one declared before is not taken in.
        ["Circle (r : Float) = _\nSquare (s : Float) = _\nShape = Circle | Square\n1", "Circle is declared already; declare it into Shape where it is: Circle ... : Shape = _"],
        ["Just x = _\nMaybe a = Just a | Nope\n1", "declare it into Maybe where it is: Just ... : Maybe a = _"],
        [MIXED + "(2.5 : Mixed)", checked ? "cannot use Float where Int | String is required" : "Float is not one of Int | String"],
        ["Foo = Int | Bar\n1", "Foo mixes a type (Int) and a new constructor (Bar)"],
        [OPTION + "Two = Some | Int\n1", "Two's alternative Some is a constructor of another type"],
        [CTOR + "length (Rect 3 4)", checked ? "Rect" : "expected a list"],
        [CTOR + "area (Rect w h) = w * h\narea 5", checked ? "cannot use Int where Rect is required" : "no clause"],
        // A new type has only the operations its clauses define; a
        // constructor is not a conversion.
        [ID + "(UserId 5 : Int)", checked ? "cannot use UserId where Int is required" : "Int expects a number"],
        [ID + "f (UserId u) = u\nf 5", checked ? "cannot use Int where UserId is required" : "no clause"],
        [ID + "Order (u : UserId Int) (n : Int) = _\nOrder 5 3", checked ? "cannot use Int where UserId is required" : "UserId expects a UserId variant"],
        [PERCENT + "Percent 50 + 1", checked ? "cannot combine Percent and Int" : "cannot apply '+'"],
        ['Span (lo : Int) (hi : Int) = lo > hi ? fail "empty span" : _\n([s = Span 2 1] : [s : Span Int Int])', "empty span"],
        ["Low (_ : Float) = 1 > 0 ? Low 1 : _\n1", "a constructor with logic names each field"],
        // A lowercase definition's _ stays unfinished.
        // _ as an argument means nothing; as a body it makes data.
        ["g x = x + 1\ng _", "_ stands for nothing here"],
    ] as const) Deno.test(`core rejects (checked=${checked}): ${source}`, () => {
        const actual = failure(source, checked);
        if (!actual.includes(message)) throw new Error(actual);
    });
}
// A to String instance is how a value shows, wherever it is.
const SHOW = 'std <- import "std"; [..] = std.option\nPoint x y = _\nto String (Point x y) = to String x ++ "@" ++ to String y\n';
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
// A constructor declared into a type from another input joins that type.
for (const checked of [true, false]) Deno.test(`core (checked=${checked}): declared into a type across inputs`, () => {
    const i = new Interpreter();
    if (checked) i.enableChecking();
    for (const source of ["Circle (r : Float) : Shape = _", "Square (s : Float) : Shape = _", "f (Circle r) = r\nf (Square s) = s"]) i.run(parseDocument(source));
    const actual = i.renderString(i.run(parseDocument("[typeOf (Square 2), f (Circle 3), f (Square 4)]")));
    if (actual !== "[Shape,3.0,4.0]") throw new Error(actual);
    i.run(parseDocument("Nada : Maybe a = _"));
    i.run(parseDocument("Just x : Maybe x = _\nreturn = Just\nJust x >>= f = f x\nNada >>= f = Nada"));
    const shown = i.renderString(i.run(parseDocument("[typeOf (Just 5), typeOf Nada, ({ x <- Just 2; return (x * 3) } : Maybe Int)]")));
    if (shown !== "[Maybe Int, Maybe a, Just 6]") throw new Error(shown);
});
