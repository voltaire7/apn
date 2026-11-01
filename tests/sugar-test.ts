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
    // A list is its items consed onto [], with what :: means there, in
    // values and patterns alike.
    ['[1,"a"]', '1 :: "a" :: []'],
    // A range is enumFrom and its siblings: numbers count, a type repeats.
    ["[take 3 [1..], [1,3..7], [1..3], [0,0.5..1]]", "[take 3 (enumFrom 1), enumFromThenTo 1 3 7, enumFromTo 1 3, enumFromThenTo 0 0.5 1]"],
    ["take 2 [Int..]", "take 2 (enumFrom Int)"],
    ["enumFrom = x -> [x,x]\n[5..]", "enumFrom = x -> [x,x]\nenumFrom 5"],
    ["f [a,b] = a + b\nf [1,2]", "f (a :: b :: []) = a + b\nf (1 :: 2 :: [])"],
    ["P a b = | MkP a b\n(::) = MkP\nsecond [x,y] = y\n[1,2]", "P a b = | MkP a b\n(::) = MkP\nsecond [x,y] = y\nMkP 1 (MkP 2 [])"],
    ["P a b = | MkP a b\n(::) = MkP\nsecond [x,y] = y\nsecond (MkP 1 (MkP 2 []))", "P a b = | MkP a b\n(::) = MkP\nsecond (x :: y :: []) = y\nsecond (MkP 1 (MkP 2 []))"],
    ["(::) = a, b -> a\n[5,6]", "(::) = a, b -> a\n5 :: 6 :: []"],
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
    ['f 0 = "z"\nf n = "n"\n[f 0, f 1]', 'f = n -> n ~ [0 -> "z", m -> "n"]\n[f 0, f 1]'],
    ["add 0 y = y\nadd x y = x + y\nadd 0 5 + add 2 3", "add = x -> y -> [x,y] ~ [[0,b] -> b, [a,b] -> a + b]\nadd 0 5 + add 2 3"],
    // A block is its statements chained: x <- m is m >>= x -> ..., an action
    // statement m >> ..., a binding x = e (x -> ...) e.
    ["v = {\n    x <- [1,2]\n    return (x * 10)\n}\nv", "v = [1,2] >>= x -> return (x * 10)\nv"],
    ["{\n    print 1\n    print 2\n}", "print 1 >> print 2"],
    ['import "option"\nOption Int {\n    x <- Some 1\n    return (x + 1)\n}', 'import "option"\nOption Int (Some 1 >>= x -> return (x + 1))'],
    ['import "option"\nOption Int {\n    None\n    return 1\n}', 'import "option"\nOption Int (None >> return 1)'],
    ["v = {\n    x <- [1,2,3]\n    guard (x > 1)\n    return x\n}\nv", "v = [1,2,3] >>= x -> guard (x > 1) >> return x\nv"],
    ["xs = {\n    x <- [1,2]\n    y <- [10,20]\n    return (x + y)\n}\nxs", "xs = [1,2] >>= x -> [10,20] >>= y -> return (x + y)\nxs"],
    ["v = {\n    a = 1\n    b = a + 1\n    [a,b]\n}\nv", "v = (a -> (b -> [a,b]) (a + 1)) 1\nv"],
    ["v = {\n    x = 1\n    x = x + 1\n    x\n}\nv", "v = (x -> (x -> x) (x + 1)) 1\nv"],
    // A binding last is followed by {}, which is [].
    ["v = { x = 1 }\nv", "v = (x -> {}) 1\nv"],
    ["a = {\n    print 1\n    y = 5\n}\nr <- a\nr", "a = print 1 >> (y -> {}) 5\nr <- a\nr"],
    ["v = {\n    x <- [1,2]\n    y = x\n}\nv", "v = [1,2] >>= x -> (y -> {}) x\nv"],
    ["c = Mutable 0\n{\n    set c 5\n    print c\n}", "c = Mutable 0\nset c 5 >> print c"],
] as const) for (const checked of [false, true]) {
    Deno.test(`sugar is its expansion${checked ? ", checked" : ""}: ${JSON.stringify(sugar)}`, () => {
        const a = result(sugar, checked), b = result(expansion, checked);
        if (a !== b) throw new Error(`${a} != ${b}`);
    });
}
// What fails as sugar fails as its expansion (in its own words).
for (const [sugar, expansion] of [
    ["v = {\n    x <- [1,2]\n    x\n}\nv", "v = [1,2] >>= x -> x\nv"],
    ["v = {\n    print 1\n    2\n}\nv", "v = print 1 >> 2\nv"],
    ["(::) = a, b -> a\nf [x] = x\nf 1", "(::) = a, b -> a\nf (x :: []) = x\nf 1"],
    ["[Int..3]", "enumFromTo Int 3"],
    ["(::) = a, b -> a\n1 ~ [x -> 2]", "(::) = a, b -> a\nm = (~)\nm 1 [x -> 2]"],
    ['import "option"\nOption Int {\n    x <- Some 1\n    5\n}', 'import "option"\nSome 1 >>= x -> 5'],
] as const) for (const checked of [false, true]) {
    Deno.test(`sugar fails as its expansion does${checked ? ", checked" : ""}: ${JSON.stringify(sugar)}`, () => {
        const a = result(sugar, checked), b = result(expansion, checked);
        if (!a.startsWith("error") || !b.startsWith("error")) throw new Error(`${a} / ${b}`);
    });
}
