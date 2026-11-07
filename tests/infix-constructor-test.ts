import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

// An infix pattern a op b, with op starting with ':', matches the constructor
// op names: list cons by default, any two-field constructor it is bound to.
function run(source: string, checked = true): string {
    const i = new Interpreter();
    if (checked) i.enableChecking();
    return i.renderString(i.run(parse(source)));
}
function failure(source: string): string {
    try { run(source); } catch (error) { return (error as Error).message; }
    throw new Error(`accepted: ${source}`);
}
const VEC = "Vec n a = Nil -> Vec Z a | Cons a (Vec k a) -> Vec (S k) a\n(::) = Cons\n";
const APP = "app (Nil : Vec n a) (ys : Vec m a) = ys : Vec (n + m) a\napp (x :: r : Vec n a) (ys : Vec m a) = ";
for (const [source, expected] of [
    ["f (x :: _) = x; f [1,2]", "1"],
    [VEC + "first (x :: _) = x\nfirst (1 :: 2 :: Nil)", "1"],
    [VEC + "typeOf (1 :: 2 :: Nil)", "Vec 2 Int"],
    [VEC + APP + "(x :: app r ys : Vec (n + m) a)\ntypeOf (app (1 :: Nil) (2 :: Nil))", "Vec 2 Int"],
    ["P a b = | MkP a b\n(:+) = MkP\nswap (x :+ y) = y :+ x\nswap (1 :+ \"a\")", 'MkP "a" 1'],
    ["P a b = | MkP a b\n(:+) = MkP\n1 :+ 2 ~ [x :+ y -> x + y]", "3"],
] as const) {
    Deno.test(`infix constructor patterns: ${JSON.stringify(source)}`, () => {
        for (const checked of [true, false]) {
            const actual = run(source, checked);
            if (actual !== expected) throw new Error(`checked=${checked}: ${actual} != ${expected}`);
        }
    });
}
for (const [source, message] of [
    // The proofs follow x :: xs as Cons x xs.
    [VEC + APP + "(x :: app r ys : Vec (n + m + 1) a)", "when r is Nil, n + m + 1 is m + 2 but the body's index is m + 1"],
    ["(:-) = 3\nf (x :- _) = x\n1", "':-' is not a constructor"],
    ["f (x :- _) = x\n1", "':-' is not a constructor"],
] as const) {
    Deno.test(`infix constructor patterns reject: ${JSON.stringify(source)}`, () => {
        const actual = failure(source);
        if (!actual.includes(message)) throw new Error(actual);
    });
}
