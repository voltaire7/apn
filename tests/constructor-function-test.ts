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
        ["Count = Int\n[Count 5, typeOf (Count 5)]", "[Count 5, Count]"],
        ["Count = Int\n[Count 5 + 1, Count 5 * 2 == 10, Int (Count 5), sqrt (Count 4)]", "[Count 6, True, 5, 2]"],
        ['Count = Int\nf (Count c) = "count"\nf (Int n) = "int"\n[f (Count 1), f 1]', '["count","int"]'],
        ["Count = Int\ng (Int n) = n + 1\ng (Count 5)", "6"],
        ["Box a = a\n[Box 1, Box Int]", "[1,Int]"],
        ["Twice w h = [w,h]\nTwice 1 2", "[1,2]"],
        ["V n = Vect (n + 0) Int\nV 3 [1,2,3]", "[1,2,3]"],
        ["Pairs Z a = []\nPairs (S k) a = a :: a :: Pairs k a\nPairs 1 Int", "Pairs 1 Int"],
        // A type a capitalized function gives remembers how it was written,
        // and so do the values it makes; patterns read that back.
        [PAIRS + "xs = Pairs 2 Int [1,2,3,4]\n[typeOf xs, length xs, map (* 2) xs]", "[Pairs 2 Int, 4, [2,4,6,8]]"],
        [PAIRS + "ys = [1,2,3,4]\nzs = Pairs 2 Int ys\n[typeOf ys, typeOf zs, ys == zs]", "[List Int, Pairs 2 Int, True]"],
        [PAIRS + "f (Pairs n a xs) = [n + 1, a, xs]\nf (Pairs 2 Int [1,2,3,4])", "[3,Int,[1,2,3,4]]"],
        [PAIRS + "f (Pairs n a xs) = n\nf _ = 0\n[f [1,2,3,4], f (Pairs 1 Int [5,6])]", "[0,1]"],
        [PAIRS + "g (Pairs n a) = n\ng (Pairs 3 Int)", "3"],
        [PAIRS + "map typeOf (List (Pairs 1 Int) [[1,2]])", "[Pairs 1 Int]"],
        ["P a = [x: a, y: a]\np = P Float [x: 1, y: 2]\n[typeOf p, p.x]", "[P Float, 1.0]"],
        // So does a name without parameters for a type or a schema; Type shows
        // what it is, and an updated copy keeps the name.
        ["Row = Vect 3 Int\n[Row, typeOf (Row [1,2,3]), typeOf [1,2,3]]", "[Row, Row, List Int]"],
        ["Point = [x: Float, y: Float]\np = Point [x: 1, y: 2]\nq = p\nq.x = 5\n[typeOf p, typeOf q, Type Point, p == [x: 1.0, y: 2.0]]",
            "[Point, Point, [x: Float, y: Float], True]"],
        ["Point = [x: Float, y: Float]\ntypeOf ([pt: Point] []).pt", "Point"],
    ] as const) Deno.test(`capitalized definitions (checked=${checked}): ${source}`, () => {
        const actual = run(source, checked);
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
    for (const [source, message] of [
        // Two names never mix; (Count c) still takes only a Count.
        ["Count = Int\nAge = Int\nCount 1 + Age 2", "cannot combine Count and Age"],
        ["Count = Int\nf (Count c) = c\nf 5", checked ? "cannot use Int where Count is required" : "no clause"],
        [PAIRS + "Pairs 2 Int [1,2,3]", checked ? "length mismatch: expected 4, got 3" : "Vect length mismatch: expected 4, got 3"],
        ["UserId := Int\n1", "APN defines with =, not :="],
    ] as const) Deno.test(`capitalized definitions reject (checked=${checked}): ${source}`, () => {
        const actual = failure(source, checked);
        if (!actual.includes(message)) throw new Error(actual);
    });
}
