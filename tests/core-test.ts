import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

// The core's data and matching: tag makes a value that remembers its
// constructor, owner and fields; case matches one level. Checked and
// unchecked runs agree.
function run(source: string, checked: boolean): string {
    const i = new Interpreter();
    if (checked) i.enableChecking();
    return i.renderString(i.run(parse(source)));
}
function failure(source: string, checked: boolean): string {
    try { run(source, checked); } catch (error) { return (error as Error).message; }
    throw new Error(`accepted: ${source}`);
}

const BOX = "Box a = tag Box Box [a]\n";
const OPTION = 'import "option"\n';
for (const checked of [true, false]) {
    for (const [source, expected] of [
        [BOX + "Box 5", "Box 5"],
        [BOX + "typeOf (Box 5)", "Box"],
        [BOX + "unbox (Box x) = x\nunbox (Box 5)", "5"],
        [BOX + "[Box 5 == Box 5, Box 5 == Box 6]", "[true,false]"],
        ["Pt x y = tag Pt Pt [x,y]\ncase (Pt 1 2) [Pt a b -> a + b]", "3"],
        // A declared constructor's tag is its own value.
        [OPTION + "tag Option Some [5] == Some 5", "true"],
        [OPTION + "case (tag Option None []) [None -> 0, Some x -> x]", "0"],
        [OPTION + "f v = case v [Some x -> x + 1, None -> 0]\n[f (Some 1), f None]", "[2,0]"],
        ['g n = case n [0 -> "zero", 1 -> "one", k -> "many"]\n[g 0, g 1, g 5]', '["zero","one","many"]'],
        ["h xs = case xs [[] -> 0, y :: ys -> y]\n[h [], h [7,8]]", "[0,7]"],
        ['case "s" [_ -> 1]', "1"],
    ] as const) Deno.test(`core (checked=${checked}): ${source}`, () => {
        const actual = run(source, checked);
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
    for (const [source, message] of [
        ["case 2 [1 -> 0]", "no alternative fits"],
        [BOX + "unbox (Box x) = x\nunbox 5", checked ? "cannot use Int where Box is required" : "no clause"],
        [BOX + "Box 5 + 1", checked ? "cannot combine Box and Int" : "cannot apply '+'"],
        ["tag Int Int [1]", "tag's owner must be a type the program defines"],
        ["Box a = tag Box (x -> x) [a]\nBox 1", "tag's constructor must be a capitalized definition"],
    ] as const) Deno.test(`core rejects (checked=${checked}): ${source}`, () => {
        const actual = failure(source, checked);
        if (!actual.includes(message)) throw new Error(actual);
    });
}
// A case alternative matches one level; nested patterns and guards are match's.
for (const source of [
    OPTION + "case (Some (Some 1)) [Some (Some x) -> x]",
    "case 1 [Int x -> x]",
    "case 1 [x | x > 0 -> x]",
]) Deno.test(`case matches one level: ${source}`, () => {
    if (!failure(source, false).includes("a case alternative matches one level")) throw new Error(source);
});
Deno.test("case prints as written", async () => {
    const { exprToSource } = await import("../src/parser.ts");
    const [statement] = parse("case v [Some x -> x, None -> 0]");
    const shown = exprToSource((statement as { value: Parameters<typeof exprToSource>[0] }).value);
    if (shown !== "case v [Some x -> x, None -> 0]") throw new Error(shown);
});
