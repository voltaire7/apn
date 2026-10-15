import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

// A declaration's layout: one line without a leading '|' (a single
// constructor keeps it), or each constructor on its own line after a '|'.
// Its parameters may also be written as a lambda: Vec = n, a -> ( ... ).
function run(source: string): string {
    const i = new Interpreter();
    i.enableChecking();
    return i.renderString(i.run(parse(source)));
}
function failure(source: string): string {
    try { run(source); } catch (error) { return (error as Error).message; }
    throw new Error(`accepted: ${source}`);
}
const USE = "\n[typeOf (Cons 1 (Cons 2 Nil)),typeOf Nil]";
for (const declaration of [
    "Vec n a = Nil -> Vec 0 a | Cons a (Vec k a) -> Vec (k + 1) a",
    "Vec n a =\n    | Nil -> Vec 0 a\n    | Cons a (Vec k a) -> Vec (k + 1) a",
    "Vec = n -> a -> (Nil -> Vec 0 a | Cons a (Vec k a) -> Vec (k + 1) a)",
    "Vec = n, a -> (Nil -> Vec 0 a | Cons a (Vec k a) -> Vec (k + 1) a)",
    "Vec = n, a -> (\n    | Nil -> Vec 0 a\n    | Cons a (Vec k a) -> Vec (k + 1) a\n)",
]) {
    Deno.test(`one family, however declared: ${JSON.stringify(declaration)}`, () => {
        const actual = run(declaration + USE);
        if (actual !== "[Vec 2 Int,Vec 0 a]") throw new Error(actual);
    });
}
Deno.test("a single constructor marks its one-line declaration with '|'", () => {
    if (run("Box a = | MkBox a\nMkBox 1") !== "MkBox 1") throw new Error("Box");
    if (run("Box = a -> (| MkBox a)\nMkBox 1") !== "MkBox 1") throw new Error("lambda Box");
});
for (const [source, message] of [
    ["Vec n a = | Nil -> Vec 0 a | Cons a (Vec k a) -> Vec (k + 1) a", "a one-line declaration takes no leading '|' (write Vec n a = A | B)"],
    ["Vec n a =\n    Nil -> Vec 0 a\n    | Cons a (Vec k a) -> Vec (k + 1) a", "start each constructor's line with '|'"],
    ["Vec n a = Nil -> Vec 0 a\n    | Cons a (Vec k a) -> Vec (k + 1) a", "starts on the line after '='"],
    ["Light =\n    | Off | On", "put each constructor of a multi-line declaration on its own line"],
] as const) {
    Deno.test(`declaration layout rejects: ${JSON.stringify(source)}`, () => {
        const actual = failure(source);
        if (!actual.includes(message)) throw new Error(actual);
    });
}
