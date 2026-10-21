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
const USE = "\n[typeOf (Cons 1 (Cons 2 Nil)), typeOf Nil]";
for (const declaration of [
    "Vec n a = Nil -> Vec 0 a | Cons a (Vec k a) -> Vec (k + 1) a",
    "Vec n a =\n    | Nil -> Vec 0 a\n    | Cons a (Vec k a) -> Vec (k + 1) a",
    "Vec = n -> a -> (Nil -> Vec 0 a | Cons a (Vec k a) -> Vec (k + 1) a)",
    "Vec = n,a -> (Nil -> Vec 0 a | Cons a (Vec k a) -> Vec (k + 1) a)",
    "Vec = n,a -> (\n    | Nil -> Vec 0 a\n    | Cons a (Vec k a) -> Vec (k + 1) a\n)",
]) {
    Deno.test(`one family, however declared: ${JSON.stringify(declaration)}`, () => {
        const actual = run(declaration + USE);
        if (actual !== "[Vec 2 Int, Vec 0 a]") throw new Error(actual);
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

// A capitalized name bound to a lambda is that lambda: applied, it runs
// (Sized 2 is Vect 2 Int); where a type is expected, it is a function type.
for (const [source, expected] of [
    ["Sized = n -> Vect n Int\nSized 2 [1,2]", "[1,2]"],
    ["Sized = n -> Vect n Int\ntypeOf (Sized 2 [1,2])", "Vect 2 Int"],
    ["Handler = a -> Int\nrun ((Handler) h) = h 1\nrun (x -> 2)", "2"],
    ["Handler = a -> Int\nisType Handler (x -> 2)", "true"],
] as const) {
    Deno.test(`a lambda-valued type name: ${JSON.stringify(source)}`, () => {
        const actual = run(source);
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
}
for (const [source, message] of [
    ["Sized = n -> Vect n Int\nSized 2 [1,2,3]", "length mismatch: expected 2, got 3"],
    ["Handler = a -> Int\nrun ((Handler) h) = h 1\nrun (x -> \"s\")", "cannot use String where Int is required"],
] as const) {
    Deno.test(`a lambda-valued type name rejects: ${JSON.stringify(source)}`, () => {
        const actual = failure(source);
        if (!actual.includes(message)) throw new Error(actual);
    });
}
Deno.test("a type name bound to a pattern lambda is a lambda too", () => {
    if (run("Maker = _ -> Int\nmake ((Maker) k) = k []\nmake (_ -> 7)") !== "7") throw new Error("Maker");
});
// A left side that is neither a name to define nor a pattern says so; a
// capitalized one with a non-name parameter is a pattern, not a type alias.
for (const [source, message] of [
    ["1 1 = 1", "`1 1` is neither a name to define nor a pattern"],
    ["[1] 0 = 1", "`[1] 0` is neither a name to define nor a pattern"],
    ["Some 1 = Some 1", "unbound variable 'Some'"],
]) Deno.test(`a binding's left side: ${JSON.stringify(source)}`, () => {
    const actual = failure(source);
    if (!actual.includes(message)) throw new Error(actual);
});
Deno.test("a constructor pattern with a literal binds as a pattern", () => {
    if (run('import "option"\nSome 1 = Some 1\nSome x = Some 2\nx') !== "2") throw new Error("Some 1");
});
