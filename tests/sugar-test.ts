import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

// Sugar is its expansion, as if written in its place: each form gives what
// its expansion gives, run and checked alike (docs/semantics.md, Sugar).
function result(source: string, checked: boolean): string {
    const i = new Interpreter();
    if (checked) i.enableChecking();
    try { return i.renderString(i.run(parse(source))); }
    catch (error) { return `error: ${(error as Error).message.split("\n")[0]}`; }
}
for (const [sugar, expansion] of [
    ["1 + 2", "(+) 1 2"],
    ['1 + "a"', '(+) 1 "a"'],
    ["V = | V Int\n(V a) + (V b) = V (a + b)\nV 1 + V 2", "V = | V Int\n(V a) + (V b) = V (a + b)\n(+) (V 1) (V 2)"],
    ["head (1 :: missing)", "head ((::) 1 missing)"],
    ["0 && missing", "(&&) 0 missing"],
    ["(x -> x + 1) $ 2", "($) (x -> x + 1) 2"],
    ["map (+ 2) [1]", "map (x -> x + 2) [1]"],
    ["x = 3\n-x", "x = 3\nnegate x"],
    ["!0", "not 0"],
    ['3 > 2 ? "y" : "n"', 'Bool (3 > 2) "y" "n"'],
    ["b = True\nFloat (b ? 1 : 2.5)", "b = True\nFloat (Bool b 1 2.5)"],
    ['r = [x: 1]\nr.x', 'r = [x: 1]\nget r "x"'],
    ['P = | P Int Int\nget (P a b) "x" = a\np = P 1 2\np.x', 'P = | P Int Int\nget (P a b) "x" = a\np = P 1 2\nget p "x"'],
    ["xs = [1,2,3]\nxs 1 = 9\nxs", "xs = [1,2,3]\nxs = with xs 1 9\nxs"],
    ['r = [x: 1]\nr.x = 5\nr', 'r = [x: 1]\nr = with r "x" 5\nr'],
    ["f x = x + 1\nf 2", "f = x -> x + 1\nf 2"],
    ['f 0 = "z"\nf n = "n"\n[f 0, f 1]', 'f = n -> match n [0 -> "z", m -> "n"]\n[f 0, f 1]'],
    ["add 0 y = y\nadd x y = x + y\nadd 0 5 + add 2 3", "add = x -> y -> match [x,y] [[0,b] -> b, [a,b] -> a + b]\nadd 0 5 + add 2 3"],
] as const) for (const checked of [false, true]) {
    Deno.test(`sugar is its expansion${checked ? ", checked" : ""}: ${JSON.stringify(sugar)}`, () => {
        const a = result(sugar, checked), b = result(expansion, checked);
        if (a !== b) throw new Error(`${a} != ${b}`);
    });
}
