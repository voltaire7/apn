import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

// A capitalized function makes values of its own: with several parameters one
// field each, laid out by the list its body gives; with one, the value it
// gives, named. A type it gives is the application, as for an alias. Checked
// and unchecked runs agree.
function run(source: string, checked: boolean): string {
    const i = new Interpreter();
    if (checked) i.enableChecking();
    return i.renderString(i.run(parse(source)));
}
function failure(source: string, checked: boolean): string {
    try { run(source, checked); } catch (error) { return (error as Error).message; }
    throw new Error(`accepted: ${source}`);
}

const RECT = "Rect w h = [Float w, Float h]\n";
const PERCENT = "Percent x = Float x > 100 ? 100.0 : Float x\n";
for (const checked of [true, false]) {
    for (const [source, expected] of [
        [RECT + "Rect 3 4", "Rect 3.0 4.0"],
        [RECT + "typeOf (Rect 3 4)", "Rect"],
        [RECT + "area (Rect w h) = w * h\narea (Rect 3 4)", "12.0"],
        [RECT + "map (Rect 1) [2,3]", "[Rect 1.0 2.0, Rect 1.0 3.0]"],
        [RECT + "Rect 3 4 == Rect 3 4", "true"],
        [RECT + 'f (Rect w h) = "rect"\nf _ = "other"\n[f (Rect 1 2), f [1,2]]', '["rect","other"]'],
        // Once defined, Rect is a constructor: a later Rect a b = r takes r apart.
        [RECT + "r = Rect 3 4\nRect a b = r\n[a,b]", "[3.0,4.0]"],
        [PERCENT + "Percent 150", "Percent 100.0"],
        [PERCENT + "typeOf (Percent 50)", "Percent"],
        [PERCENT + "Percent 50 + 1", "Percent 51.0"],
        [PERCENT + "g (Percent v) = v\ng (Percent 150)", "100.0"],
        ["Ratio n d = [n,d]\nRatio 1 2", "Ratio 1 2"],
        ["Box a = a\nBox [1,2]", "Box [1,2]"],
        // A type is the application: these stay type functions.
        ["V n = Vect (n + 0) Int\nV 3 [1,2,3]", "[1,2,3]"],
        ["Pairs Z a = []\nPairs (S k) a = a :: a :: Pairs k a\nPairs 1 Int", "[Int,Int]"],
    ] as const) Deno.test(`constructor functions (checked=${checked}): ${source}`, () => {
        const actual = run(source, checked);
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
    // The body's list is the layout, not the value: a Rect is not a list.
    for (const [source, message] of [
        ["Bad w h = [w]\nBad 1 2", "Bad has 2 fields, so its body must give a list of 2 items"],
        [RECT + "length (Rect 3 4)", checked ? "Rect" : "expected a list"],
        [RECT + "area (Rect w h) = w * h\narea 5", checked ? "cannot use Int where Rect is required" : "no clause"],
    ] as const) Deno.test(`constructor functions reject (checked=${checked}): ${source}`, () => {
        const actual = failure(source, checked);
        if (!actual.includes(message)) throw new Error(actual);
    });
}
// What the checker alone can tell.
for (const [source, message] of [
    [RECT + "f (Rect w h d) = w\n1", "Rect has 2 fields"],
    [RECT + 'f (Rect w h) = w ++ "x"\nf (Rect 1 2)', "cannot append Float and String"],
    [RECT + 'Rect "a" 2', "cannot use String where Float is required"],
] as const) Deno.test(`constructor functions are checked: ${source}`, () => {
    const actual = failure(source, true);
    if (!actual.includes(message)) throw new Error(actual);
});
