import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

// A capitalized definition computes: applied, it gives what its body gives (a
// type, or any value). A scalar type keeps the name as a transparent subtype;
// any other type remembers how it was written. Constructors (Name x = _) are in
// core-test.ts. Checked and unchecked runs agree.
function run(source: string, checked: boolean): string {
    const i = new Interpreter();
    if (checked) i.enableChecking();
    return i.renderString(i.run(parseDocument(source)));
}
function failure(source: string, checked: boolean): string {
    try { run(source, checked); } catch (error) { return (error as Error).message; }
    throw new Error(`accepted: ${source}`);
}

const PAIRS = "Pairs n a = Vect (n * 2) a\n";
for (const checked of [true, false]) {
    for (const [source, expected] of [
        // = names a scalar type transparently: a Count is an Int wherever one
        // is accepted, and keeps its name when a result fits.
        ["Count = Int\n[(5 : Count), typeOf (5 : Count)]", "[5,Count]"],
        ["Count = Int\n[(5 : Count) + 1, (5 : Count) * 2 == 10, ((5 : Count) : Int), sqrt (4 : Count)]", "[6, True, 5, 2]"],
        ['Count = Int\nf (c : Count) = "count"\nf (n : Int) = "int"\n[f (1 : Count), f 1]', '["count","int"]'],
        ["Count = Int\ng (n : Int) = n + 1\ng (5 : Count)", "6"],
        // (e : T), to T e and a typed pattern (x : T) are one operation:
        // e if it is a T, else what a to T instance makes of it.
        ["Compass = North | East\nto Int East = 1\nx = East : Int\ni (n : Int) = n\n[x, i East, to Int East]", "[1,1,1]"],
        ["Box (v : Int) = _\nto (Box Int) (n : Int) = Box n\ng (b : Box Int) = b\ny = 3 : Box Int\n[y, g 3, to (Box Int) 3]", "[Box 3, Box 3, Box 3]"],
        // Truth is truthy's: (x : Bool) takes only a Bool.
        ['[truthy 5, 5 ? "y" : "n", !0, (True : Bool)]', '[True, "y", True, True]'],
        // A type of its own is a constructor; a to instance lets it stand
        // where an Int is needed.
        ['Count (n : Int) = _\nto Int (Count n) = n\nf (c : Count Int) = "count"\nf (n : Int) = "int"\ng (n : Int) = n * 2\n[f (Count 1), f 1, g (Count 3), Count 1 + 2]', '["count", "int", 6, 3]'],
        ["Box a = a\n[Box 1, Box Int]", "[1,Int]"],
        ["Twice w h = [w,h]\nTwice 1 2", "[1,2]"],
        ["V n = Vect (n + 0) Int\n([1,2,3] : V 3)", "[1,2,3]"],
        ["Pairs Z a = []\nPairs (S k) a = a :: a :: Pairs k a\nPairs 1 Int", "Pairs 1 Int"],
        // A type a capitalized function gives remembers how it was written,
        // and so do the values it makes; patterns read that back.
        [PAIRS + "xs = [1,2,3,4] : Pairs 2 Int\n[typeOf xs, length xs, map (* 2) xs]", "[Pairs 2 Int, 4, [2,4,6,8]]"],
        [PAIRS + "ys = [1,2,3,4]\nzs = ys : Pairs 2 Int\n[typeOf ys, typeOf zs, ys == zs]", "[[Int,Int,Int,Int], Pairs 2 Int, True]"],
        [PAIRS + "f (xs : Pairs n a) = [n + 1, a, xs]\nf ([1,2,3,4] : Pairs 2 Int)", "[3, Int, [1,2,3,4]]"],
        [PAIRS + "f (xs : Pairs n a) = n\nf _ = 0\n[f [1,2,3,4], f ([5,6] : Pairs 1 Int)]", "[0,1]"],
        [PAIRS + "g (Pairs n a) = n\ng (Pairs 3 Int)", "3"],
        [PAIRS + "map typeOf ([[1,2]] : List (Pairs 1 Int))", "[Pairs 1 Int]"],
        ["P a = [x : a, y : a]\np = [x = 1, y = 2] : P Float\n[typeOf p, p.x]", "[P Float, 1.0]"],
        // So does a name without parameters for a type or a schema; Type shows
        // what it is, and an updated copy keeps the name.
        ["Row = Vect 3 Int\n[Row, typeOf ([1,2,3] : Row), typeOf [1,2,3]]", "[Row,Row,[Int,Int,Int]]"],
        ["Point = [x : Float, y : Float]\np = [x = 1, y = 2] : Point\nq = p\nq.x = 5\n[typeOf p, typeOf q, (Point : Type), p == [x = 1.0, y = 2.0]]",
            "[Point, Point, [x : Float, y : Float], True]"],
        ["Point = [x : Float, y : Float]\ntypeOf ([] : [pt : Point]).pt", "Point"],
        // (c : Count) takes a plain Int as (x : Int32) does, binding it; an
        // Int's own clause, exact, is chosen first.
        ["Count = Int\nf (c : Count) = typeOf c\n[f 5, f (5 : Count)]", "[Int,Int]"],
        ["Count = Int\nk (c : Count) = \"count\"\nk (n : Int) = \"int\"\n[k 5, k (5 : Count)]", '["int","count"]'],
        ["Meters = Float\nd (x : Meters) = x * 2\nd 2", "4.0"],
    ] as const) Deno.test(`capitalized definitions (checked=${checked}): ${source}`, () => {
        const actual = run(source, checked);
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
    for (const [source, message] of [
        // Two names never mix: (c : Count) takes no Age.
        ["Count = Int\nAge = Int\n(1 : Count) + (2 : Age)", "cannot combine Count and Age"],
        ["Count = Int\nAge = Int\nf (c : Count) = c\nf (2 : Age)", checked ? "cannot use Age where Count is required" : "no clause"],
        [PAIRS + "([1,2,3] : Pairs 2 Int)", checked ? "length mismatch: expected 4, got 3" : "Vect length mismatch: expected 4, got 3"],
        ["UserId := Int\n1", "APN defines with =, not :="],
        ["x = 5 : Bool\nx", checked ? "cannot use Int where Bool is required" : "Int is not a Bool"],
        ["y : Bool = Int\ny", checked ? "where Bool is required" : "is not a Bool"],
        ["Box (v : Int) = _\ng (b : Box Int) = b\ng 3", checked ? "cannot use Int where Box is required" : "no clause"],
    ] as const) Deno.test(`capitalized definitions reject (checked=${checked}): ${source}`, () => {
        const actual = failure(source, checked);
        if (!actual.includes(message)) throw new Error(actual);
    });
}
