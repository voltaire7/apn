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
const CTOR = "Box x = _\nRect (Float w) (Float h) = _\nNothing = _\n";
const OPTION = 'import "option"\n';
for (const checked of [true, false]) {
    for (const [source, expected] of [
        [BOX + "Box 5", "Box 5"],
        [BOX + "typeOf (Box 5)", "Box"],
        [BOX + "unbox (Box x) = x\nunbox (Box 5)", "5"],
        [BOX + "[Box 5 == Box 5, Box 5 == Box 6]", "[true,false]"],
        ["Pt x y = tag Pt Pt [x,y]\nmatch (Pt 1 2) [Pt a b -> a + b]", "3"],
        // A declared constructor's tag is its own value.
        [OPTION + "tag Option Some [5] == Some 5", "true"],
        [OPTION + "match (tag Option None []) [None -> 0, Some x -> x]", "0"],
        [CTOR + '[Box 5, Box "a"]', '[Box 5, Box "a"]'],
        [CTOR + "unbox (Box x) = x\nunbox (Box 5)", "5"],
        [CTOR + "area (Rect w h) = w * h\n[Rect 3 4, area (Rect 3 4)]", "[Rect 3.0 4.0, 12.0]"],
        [CTOR + "[Nothing, Nothing == Nothing]", "[Nothing,true]"],
        [CTOR + "Rect a b = Rect 3 4\n[a,b]", "[3.0,4.0]"],
        ["Pair a b = _\nmatch (Pair 1 \"x\") [Pair n s -> s]", '"x"'],
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
        // A lowercase definition's _ stays unfinished.
        ["f x = _\nf 1", "not implemented"],
    ] as const) Deno.test(`core rejects (checked=${checked}): ${source}`, () => {
        const actual = failure(source, checked);
        if (!actual.includes(message)) throw new Error(actual);
    });
}
