import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

// Functor and Monad instances, return in any monad, and do-blocks over any
// monad (see docs/semantics.md, "Monads and instances").
function run(source: string, checked = true): string[] {
    const output: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
    try {
        const i = new Interpreter();
        if (checked) i.enableChecking();
        i.run(parse(source));
    } finally {
        console.log = log;
    }
    return output;
}
function fails(source: string, text: string, kind?: string): void {
    try { run(source); } catch (error) {
        const e = error as { message: string; kind?: string };
        if (e.message.includes(text) && (!kind || e.kind === kind)) return;
        throw error;
    }
    throw new Error(`accepted: ${source}`);
}

const counter = `Counter s a = | MkCounter Function
runCounter (MkCounter f) s = f s
(MkCounter g) >>= f = MkCounter (s -> {
    [a,s1] = g s
    runCounter (f a) s1
})
return ((Counter s a) x) = MkCounter (s -> [x,s])
tick = MkCounter (s -> [s,s + 1])`;

for (const [name, source, expected] of [
    ["return takes the monad its annotation names", 'import "option"\nprint (Option Int { return 42 })\nprint (List Int { return 43 })\nx <- IO Int { return 44 }\nprint x',
        ["Some 42", "[43]", "44"]],
    ["return is undecided until used", 'import "option"\nr = return 7\nprint (Option Int r)\nprint (List Int r)\nz <- r\nprint z', ["Some 7", "[7]", "7"]],
    ["run as a statement, return is IO", "x <- return 5\nprint x", ["5"]],
    [">>= decides return's monad", 'import "option"\nprint (Some 3 >>= (v -> return (v * 2)))\nprint ([1,2] >>= (v -> return (v + 1)))', ["Some 6", "[2,3]"]],
    ["a list do-block", "pairs = List Int {\n    a <- [1,2]\n    b <- [10,20]\n    return (a + b)\n}\nprint pairs", ["[11,21,12,22]"]],
    ["an Option do-block stops at None", 'import "option"\nfound = Option Int {\n    a <- Some 1\n    b <- None\n    return (a + b)\n}\nprint found\nboth = Option Int {\n    a <- Some 1\n    b <- Some 2\n    return (a + b)\n}\nprint both',
        ["None", "Some 3"]],
    ["Result instances", 'import "option"\nprint (fmap (+ 1) (Ok 1))\nprint (fmap (+ 1) (Err "bad"))\nprint (Ok 3 >>= (x -> Ok (x + 1)))', ["Ok 2", 'Err "bad"', "Ok 4"]],
    ["<*> derives from >>=", 'import "option"\nprint (Some (+ 1) <*> Some 41)\nprint ([(+ 1),(* 2)] <*> [10,20])', ["Some 42", "[11,21,20,40]"]],
    ["a user-defined monad", `${counter}\ncounted = Counter Int Int {\n    a <- tick\n    b <- tick\n    return (a * 100 + b)\n}\nprint (runCounter counted 5)\nprint (runCounter (fmap (* 2) tick) 3)`,
        ["[506,7]", "[6,4]"]],
    ["a user instance keeps the others", "Tree = Leaf Int | Node Tree Tree\nfmap f (Leaf x) = Leaf (f x)\nfmap f (Node l r) = Node (fmap f l) (fmap f r)\nprint (fmap (+ 1) (Node (Leaf 1) (Leaf 2)))\nprint (fmap (+ 1) [1,2])",
        ["Node (Leaf 2) (Leaf 3)", "[2,3]"]],
    ["Functor and Monad patterns", 'import "option"\ndouble (Functor m) = fmap (* 2) m\nprint (double [1,2])\nprint (double (Some 3))\nx <- double (return 4)\nprint x\nisMonad (Monad m) = true\nisMonad x = false\nprint [isMonad [1],isMonad 1]',
        ["[2,4]", "Some 6", "8", "[true,false]"]],
    ["undecided values and actions print without running", 'print $ return 123\nprint [return "a"]\nprint (return 1 >>= (x -> return x))\nprint (print 1)\nprint (IO Int { return 1 })\nprint (typeOf (print 1))\nprint (typeOf (return 1))',
        ["Monad 123", '[Monad "a"]', "Monad", "IO []", "IO Int", "IO []", "Monad Int"]],
    ["constructor arguments print as source writes them", 'import "option"\nprint (return (Some 1))\nprint (Some (Some (-1)))\nprint (Some [1,2])',
        ["Monad (Some 1)", "Some (Some (-1))", "Some [1,2]"]],
    ["partly applied functions show their arguments", "addOp = (+)\nprint (addOp 1)\nprint (+ 1)\nf a b = a + b\nprint (f 1)\ng = x y z -> x * y * z\nprint (g 2 3)",
        ["(1 +)", "(+ 1)", "(a b -> a + b) 1", "(x y z -> x * y * z) 2 3"]],
] as const) Deno.test(`monads: ${name}`, () => {
    for (const checked of [true, false]) {
        const actual = run(source, checked);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${checked ? "checked" : "unchecked"}: ${JSON.stringify(actual)}`);
    }
});

for (const [source, message, kind] of [
    ["Tree = Leaf Int | Node Tree Tree\nprint (fmap (+ 1) (Leaf 1))", "no fmap instance for Tree", "type"],
    ["double (Functor m) = fmap (* 2) m\nprint (double 5)", "where Functor is required", "type"],
    ['import "option"\nx = Option Int {\n    a <- Some 1\n    a + 1\n}', "the last statement of a do-block must be an action", "type"],
    ["xs = List Int {\n    a <- [1,2]\n    print a\n    return a\n}", "an IO action cannot run in a List do-block", "type"],
    ["return a b = a", "return takes one argument", "parse"],
    ["return x = x", "a return instance names its monad", "parse"],
    ["return x = Option t { Some x }", "a return instance names its monad", "parse"],
] as const) Deno.test(`monads reject: ${JSON.stringify(source)}`, () => fails(source, message, kind));
Deno.test("monads: a type without a return instance cannot take return", () => {
    try { run("Tree = Leaf Int | Node Tree Tree\nprint (Tree { return 1 })", false); }
    catch (e) { if (String(e).includes("no return instance for Tree")) return; throw e; }
    throw new Error("accepted");
});
