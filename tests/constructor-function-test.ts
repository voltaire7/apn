import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

// A capitalized definition with := is a constructor: with several parameters
// it makes one field each, laid out by the list its body gives; with one, the
// value it gives, named; with none, a named subtype. One with = computes: it
// gives what its body gives (a type, or any value). Checked and unchecked runs
// agree.
function run(source: string, checked: boolean): string {
    const i = new Interpreter();
    if (checked) i.enableChecking();
    return i.renderString(i.run(parse(source)));
}
function failure(source: string, checked: boolean): string {
    try { run(source, checked); } catch (error) { return (error as Error).message; }
    throw new Error(`accepted: ${source}`);
}

const RECT = "Rect w h := [Float w, Float h]\n";
const PERCENT = "Percent x := Float x > 100 ? 100.0 : Float x\n";
for (const checked of [true, false]) {
    for (const [source, expected] of [
        [RECT + "Rect 3 4", "Rect 3.0 4.0"],
        [RECT + "typeOf (Rect 3 4)", "Rect"],
        [RECT + "area (Rect w h) = w * h\narea (Rect 3 4)", "12.0"],
        [RECT + "map (Rect 1) [2,3]", "[Rect 1.0 2.0, Rect 1.0 3.0]"],
        [RECT + "Rect 3 4 == Rect 3 4", "true"],
        [RECT + 'f (Rect w h) = "rect"\nf _ = "other"\n[f (Rect 1 2), f [1,2]]', '["rect","other"]'],
        // Rect is a constructor: Rect a b = r takes r apart, even right after :=.
        [RECT + "Rect a b = Rect 3 4\n[a,b]", "[3.0,4.0]"],
        [PERCENT + "Percent 150", "Percent 100.0"],
        [PERCENT + "typeOf (Percent 50)", "Percent"],
        [PERCENT + "Percent 50 + 1", "Percent 51.0"],
        [PERCENT + "g (Percent v) = v\ng (Percent 150)", "100.0"],
        ["Frac n d := [n,d]\nFrac 1 2", "Frac 1 2"],
        ["Box a := a\nBox [1,2]", "Box [1,2]"],
        ["UserId := Int\n[UserId 5, typeOf (UserId 5)]", "[UserId 5, UserId]"],
        // = computes: a type, or any value, nothing named.
        ["Count = Int\n[Count 5, typeOf (Count 5)]", "[5,Int]"],
        ["Box a = a\n[Box 1, Box Int]", "[1,Int]"],
        ["Twice w h = [w,h]\nTwice 1 2", "[1,2]"],
        ["V n = Vect (n + 0) Int\nV 3 [1,2,3]", "[1,2,3]"],
        ["Pairs Z a = []\nPairs (S k) a = a :: a :: Pairs k a\nPairs 1 Int", "[Int,Int]"],
    ] as const) Deno.test(`capitalized definitions (checked=${checked}): ${source}`, () => {
        const actual = run(source, checked);
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
    // The body's list is the layout, not the value: a Rect is not a list.
    for (const [source, message] of [
        ["Bad w h := [w]\nBad 1 2", "Bad has 2 fields, so its body must give a list of 2 items"],
        [RECT + "length (Rect 3 4)", checked ? "Rect" : "expected a list"],
        [RECT + "area (Rect w h) = w * h\narea 5", checked ? "cannot use Int where Rect is required" : "no clause"],
        ["Point := [x: Float]\nPoint [x: 1]", "Point := needs a scalar type to name"],
    ] as const) Deno.test(`capitalized definitions reject (checked=${checked}): ${source}`, () => {
        const actual = failure(source, checked);
        if (!actual.includes(message)) throw new Error(actual);
    });
}
// A to String instance is how a value shows, wherever it is.
const SHOW = 'import "option"\nFrac n d := [n,d]\nto String (Frac n d) = to String n ++ "/" ++ to String d\n';
for (const checked of [true, false]) for (const [source, expected] of [
    [SHOW + "[Frac 1 2, Frac 3 4]", "[1/2,3/4]"],
    [SHOW + "Some (Frac 1 2)", "Some (1/2)"],
    [SHOW + "to String [Frac 1 2]", '"[1/2]"'],
    [SHOW + '"is " ++ to String (Frac 1 2)', '"is 1/2"'],
] as const) Deno.test(`to String shows a value (checked=${checked}): ${source}`, () => {
    const actual = run(source, checked);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
// What the checker alone can tell.
for (const [source, message] of [
    [RECT + "f (Rect w h d) = w\n1", "Rect has 2 fields"],
    [RECT + 'f (Rect w h) = w ++ "x"\nf (Rect 1 2)', "cannot append Float and String"],
    [RECT + 'Rect "a" 2', "cannot use String where Float is required"],
] as const) Deno.test(`constructors are checked: ${source}`, () => {
    const actual = failure(source, true);
    if (!actual.includes(message)) throw new Error(actual);
});
