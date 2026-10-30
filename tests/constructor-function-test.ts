import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

// A capitalized definition computes: applied, it gives what its body gives (a
// type, or any value), except that a scalar type keeps the name as a
// transparent subtype. Constructors (Name x = _) are in core-test.ts. Checked
// and unchecked runs agree.
function run(source: string, checked: boolean): string {
    const i = new Interpreter();
    if (checked) i.enableChecking();
    return i.renderString(i.run(parseDocument(source)));
}
function failure(source: string, checked: boolean): string {
    try { run(source, checked); } catch (error) { return (error as Error).message; }
    throw new Error(`accepted: ${source}`);
}

for (const checked of [true, false]) {
    for (const [source, expected] of [
        // = names a scalar type transparently: a Count is an Int wherever one
        // is accepted, and keeps its name when a result fits.
        ["Count = Int\n[Count 5, typeOf (Count 5)]", "[Count 5, Count]"],
        ["Count = Int\n[Count 5 + 1, Count 5 * 2 == 10, Int (Count 5), sqrt (Count 4)]", "[Count 6, true, 5, 2]"],
        ['Count = Int\nf (Count c) = "count"\nf (Int n) = "int"\n[f (Count 1), f 1]', '["count","int"]'],
        ["Count = Int\ng (Int n) = n + 1\ng (Count 5)", "6"],
        ["Box a = a\n[Box 1, Box Int]", "[1,Int]"],
        ["Twice w h = [w,h]\nTwice 1 2", "[1,2]"],
        ["V n = Vect (n + 0) Int\nV 3 [1,2,3]", "[1,2,3]"],
        ["Pairs Z a = []\nPairs (S k) a = a :: a :: Pairs k a\nPairs 1 Int", "[Int,Int]"],
    ] as const) Deno.test(`capitalized definitions (checked=${checked}): ${source}`, () => {
        const actual = run(source, checked);
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
    for (const [source, message] of [
        // Two names never mix; (Count c) still takes only a Count.
        ["Count = Int\nAge = Int\nCount 1 + Age 2", "cannot combine Count and Age"],
        ["Count = Int\nf (Count c) = c\nf 5", checked ? "cannot use Int where Count is required" : "no clause"],
        ["UserId := Int\n1", "APN defines with =, not :="],
    ] as const) Deno.test(`capitalized definitions reject (checked=${checked}): ${source}`, () => {
        const actual = failure(source, checked);
        if (!actual.includes(message)) throw new Error(actual);
    });
}
