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

// while runs its code again before each pass, its last item the condition;
// loop runs its action until something stops the program.
Deno.test("while and loop", () => {
    const loops = run("n = Mutable 0\nwhile [n < 3] {\n    print n\n    set n (n + 1)\n}\nbig = Mutable 0\nwhile [big < 100000] (set big (big + 1))\nprint big\nnever = false\nwhile [never] (print \"no\")\nm = Mutable 20\nwhile [half = quotient m 2, half > 2] {\n    print half\n    set m half\n}");
    if (loops.join(",") !== "0,1,2,100000,10,5") throw new Error(loops.join(","));
    fails("n = Mutable 0\nwhile (n < 3) (set n (n + 1))", "while takes code as written");
    const output: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
    try {
        const i = new Interpreter();
        i.enableChecking();
        i.run(parse('c = Mutable 0\nloop {\n    set c (c + 1)\n    when (c == 50000) (throw "stop")\n    when (c < 3) (print c)\n}'));
        throw new Error("loop finished");
    } catch (error) {
        if (!String((error as Error).message).includes("stop")) throw error;
    } finally { console.log = log; }
    if (output.join(",") !== "1,2") throw new Error(output.join(","));
});

// for runs its code as written: the step is an action or a new binding.
// sequence passes on what it has so far: a long list of actions runs in constant stack.
Deno.test("mapM over a long list of actions", () => {
    const total = run("c = Mutable 0\nxs <- mapM (x -> { set c (c + x); return x }) [1..30000]\nprint [length xs, c + 0]");
    if (total.join() !== "[30000,450015000]") throw new Error(total.join());
});

Deno.test("for", () => {
    const passes = run("for [i = 0, i < 3, i = i + 1] { print i }\nfor [i = Mutable 5, i < 7, set i $ i + 1] { print i }\nfor [n = 1, n < 9, n = n * 2] (print n)\nfor [i = 0, i < 100000, i = i + 1] {}\nprint \"done\"");
    if (passes.join(",") !== "0,1,2,5,6,1,2,4,8,done") throw new Error(passes.join(","));
    fails("for [i = 0, i < 3, set i $ i + 1] { print i }", "set expects a Mutable reference");
    fails("for [i = 0, i < 3] { print i }", "for takes code as written");
});

const counter = `Counter s a = | MkCounter (s -> [a,s])
runCounter (MkCounter f) s = f s
(MkCounter g) >>= f = MkCounter (s -> {
    [a,s1] = g s
    runCounter (f a) s1
})
return x = MkCounter (s -> [x,s])
tick = MkCounter (s -> [s, s + 1])`;

const mapText = "map\nf, (Some x) -> Some (f x)\n_, None -> None\nf, (Ok x) -> Ok (f x)\n_, (Err error) -> Err error";
for (const [name, source, expected] of [
    // A do-block over a parameter's monad binds what that monad holds, once
    // a call gives it: x is the Option's value, not the Option.
    ["a do-block over a parameter's monad", 'import "option"\nf m = {\n    x <- m\n    return (x + 1)\n}\nprint (f (Some 1))\nprint (f [1,2])',
        ["Some 2", "[2,3]"]],
    ["mutually recursive do-blocks over a parameter's monad", counter + '\npair m = {\n    x <- m\n    y <- other m\n    return [x,y]\n}\nother m = {\n    x <- m\n    return (x * 10)\n}\nprint (runCounter (pair tick) 1)',
        ["[[1,20],3]"]],
    ["return takes the monad its annotation names", 'import "option"\nprint (Option Int { return 42 })\nprint (List Int { return 43 })\nx <- IO Int { return 44 }\nprint x',
        ["Some 42", "[43]", "44"]],
    ["return is undecided until used", 'import "option"\nr = return 7\nprint (Option Int r)\nprint (List Int r)\nz <- r\nprint z', ["Some 7", "[7]", "7"]],
    ["run as a statement, return is IO", "x <- return 5\nprint x", ["5"]],
    [">>= decides return's monad", 'import "option"\nprint (Some 3 >>= v -> return (v * 2))\nprint ([1,2] >>= v -> return (v + 1))', ["Some 6", "[2,3]"]],
    ["a list do-block", "pairs = List Int {\n    a <- [1,2]\n    b <- [10,20]\n    return (a + b)\n}\nprint pairs", ["[11,21,12,22]"]],
    ["an Option do-block stops at None", 'import "option"\nfound = Option Int {\n    a <- Some 1\n    b <- None\n    return (a + b)\n}\nprint found\nboth = Option Int {\n    a <- Some 1\n    b <- Some 2\n    return (a + b)\n}\nprint both',
        ["None", "Some 3"]],
    ["a method prints its builtin and every instance", 'import "option"\nprint map\nprint return\nprint (>>=)\nprint (<$>)',
        [mapText, "return\nSome\nOk", "(>>=)\n(Some x), f -> f x\nNone, _ -> None\n(Ok x), f -> f x\n(Err error), _ -> Err error", mapText]],
    ["Result instances", 'import "option"\nprint (map (+ 1) (Ok 1))\nprint (map (+ 1) (Err "bad"))\nprint (Ok 3 >>= x -> Ok (x + 1))', ["Ok 2", 'Err "bad"', "Ok 4"]],
    ["<*> derives from >>=", 'import "option"\nprint (Some (+ 1) <*> Some 41)\nprint ([(+ 1), (* 2)] <*> [10,20])', ["Some 42", "[11,21,20,40]"]],
    ["a user-defined monad", `${counter}\ncounted = Counter Int Int {\n    a <- tick\n    b <- tick\n    return (a * 100 + b)\n}\nprint (runCounter counted 5)\nprint (runCounter (map (* 2) tick) 3)`,
        ["[506,7]", "[6,4]"]],
    ["a user instance keeps the others", "Tree = Leaf Int | Node Tree Tree\nmap f (Leaf x) = Leaf (f x)\nmap f (Node l r) = Node (map f l) (map f r)\nprint (map (+ 1) (Node (Leaf 1) (Leaf 2)))\nprint (map (+ 1) [1,2])",
        ["Node (Leaf 2) (Leaf 3)", "[2,3]"]],
    // A parameter passed to map takes whatever map has an instance for.
    ["map's argument takes any functor", 'import "option"\ndouble m = map (* 2) m\nprint (double [1,2])\nprint (double (Some 3))\nx <- double (return 4)\nprint x',
        ["[2,4]", "Some 6", "8"]],
    ["return is overloaded on its result", 'import "option"\nWrap a = | MkWrap a\nreturn = MkWrap\n(MkWrap x) >>= f = f x\nprint (Wrap Int { return 5 })\nprint (Option Int { return 6 })\nprint (Result Int String { return 7 })\nprint (List Int { return 8 })',
        ["MkWrap 5", "Some 6", "Ok 7", "[8]"]],
    ["any definition of a method is an instance, curried or not", "Tree = Leaf Int | Node Tree Tree\nmapTree f (Leaf x) = Leaf (f x)\nmapTree f (Node l r) = Node (mapTree f l) (mapTree f r)\nmap = mapTree\ndouble m = map (* 2) m\nprint (double (Node (Leaf 1) (Leaf 2)))\nprint (double [1])",
        ["Node (Leaf 2) (Leaf 4)", "[2]"]],
    ["a curried definition overloads like clauses", "describe = Int _ -> \"Int\"\ndescribe = Float _ -> \"Float\"\nprint [describe 1, describe 1.5]\nalso = x -> x + 1\nalso = x -> x + 2\nprint (also 1)",
        ['["Int","Float"]', "3"]],
    ["undecided values and actions print without running", 'print $ return 123\nprint [return "a"]\nprint (return 1 >>= x -> return x)\nprint (print 1)\nprint (IO Int { return 1 })\nprint (typeOf (print 1))\nprint (typeOf (return 1))',
        ["[123]", '[return "a"]', "return 1 >>= x -> return x", "IO []", "IO Int", "IO []", "m Int"]],
    ["constructor arguments print as source writes them", 'import "option"\nprint (return (Some 1))\nprint (Some (Some -1))\nprint (Some [1,2])',
        ["[Some 1]\nSome (Some 1)\nOk (Some 1)", "Some (Some -1)", "Some [1,2]"]],
    ["overloads chosen by result type", 'f x = 1\nf x = "one"\nprint (f 0)\nprint (Int (f 0))\nprint (String (f 0))\nprint (typeOf (f 0))\ng (Int n) = n + 1\nprint (g (f 0))',
        ["1\n\"one\"", "1", "one", "Int | String", "2"]],
    ["return prints as the list's value, then its overloads applied", 'import "option"\nprint (return 5)\nprint (Option (return 1))',
        ["[5]\nSome 5\nOk 5", "Some 1"]],
    ["partly applied functions show their arguments", "addOp = (+)\nprint (addOp 1)\nprint (+ 1)\nf a b = a + b\nprint (f 1)\ng = x, y, z -> x * y * z\nprint (g 2 3)",
        ["(1 +)", "(+ 1)", "b -> 1 + b", "z -> 2 * 3 * z"]],
    // As in Haskell, a discarded statement in a monad is chained: Err or None stops the block.
    ["a discarded Err or None stops a block", 'import ["option","number"]\nf n = {\n    Err "x"\n    return n\n}\nprint [f 1]\ng n = {\n    n > 0 ? Ok [] : Err "not positive"\n    return (n * 2)\n}\nprint [g 1, g 0]\nh n = {\n    _ <- safeDiv 1 n\n    None\n    return n\n}\nprint (h 1)',
        ['[Err "x"]', '[Ok 2, Err "not positive"]', "None"]],
    ["assert yields true, in a block of values", "double n = {\n    assert (n > 0)\n    n * 2\n}\nprint (double 3)\nprint (assert 1)",
        ["6", "true"]],
    ["guard stops a list, Option or Result block; empty is decided by its context", 'import ["option","number"]\nevens = {\n    x <- [1..6]\n    guard (x % 2 == 0)\n    return x\n}\nprint evens\npositive n = {\n    _ <- Some n\n    guard (n > 0)\n    return n\n}\nprint [positive 3, positive -1]\nprint (Option Int empty)\nprint (List Int empty)\nprint empty\ncheck n = {\n    _ <- Ok n\n    guard (n > 0)\n    return n\n}\nprint [check 1, check 0]\nhalf n = Result Int String {\n    guard (n % 2 == 0)\n    return (n / 2)\n}\nprint [half 4, half 3, Option Int { guard false; return 1 }]',
        ["[2,4,6]", "[Some 3, None]", "None", "[]", '[]\nNone\nErr "empty"', '[Ok 1, Err "guard failed: n > 0"]', '[Ok 2, Err "guard failed: n % 2 == 0", None]']],
    ["when and unless work in any monad", 'import "option"\nprint (unless false (Err "no"))\nprint (Option (when false (Some 1)))\nwhen true (print "ran")',
        ['Err "no"', "Some []", "ran"]],
    // As Haskell's: m (List x) in the elements' monad, each in turn.
    ["sequence and mapM work in any monad", 'import "option"\nprint (sequence [Some 1, Some "a"])\nprint (sequence [Some 1, None])\nprint (sequence [[1,2],[3,4]])\nprint (mapM (x -> x > 0 ? Ok x : Err x) [1,-2,-3])\nxs <- mapM (x -> return (x * 2)) [1,2]\nprint (xs 1 + 1)\nprint (typeOf sequence)',
        ['Some [1,"a"]', "None", "[[1,3],[1,4],[2,3],[2,4]]", "Err -2", "5", "List (f a) -> f (List a)"]],
] as const) Deno.test(`monads: ${name}`, () => {
    for (const checked of [true, false]) {
        const actual = run(source, checked);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${checked ? "checked" : "unchecked"}: ${JSON.stringify(actual)}`);
    }
});

for (const [source, message, kind] of [
    ["Tree = Leaf Int | Node Tree Tree\nprint (map (+ 1) (Leaf 1))", "no map instance for Tree", "type"],
    ["double m = map (* 2) m\nprint (double 5)", "map needs an action, a list or a monadic value, not Int", "type"],
    ["Point = | P Int Int\ndouble m = map (* 2) m\nprint (double (P 1 2))", "no map instance for Point", "type"],
    ["f (Functor m) = m", "unknown constructor 'Functor' in a pattern", "type"],
    // m >>= k needs a function k: a value to run after m is m >> k.
    ['import "option"\nprint (Some 1 >>= 5)', "'>>=' needs a function on its right, not Int", "type"],
    ['import "option"\ncheck n = unless (n > 0) (Err "x") >>= guard (n < 100) >>= return (n * 2)', "'>>=' needs a function on its right, not m []", "type"],
    ['import "option"\nx = Option Int {\n    a <- Some 1\n    a + 1\n}', "the last statement of a do-block must be an action", "type"],
    ["xs = List Int {\n    a <- [1,2]\n    print a\n    return a\n}", "an IO action cannot run in a List do-block", "type"],
    ["return a b = a", "return takes one argument", "parse"],
    ['f x = 1\nf x = "one"\nprint (f 0 + 1)', "ambiguous: nothing decides which f", "type"],
    ["print (return 1 + 1)", "ambiguous: nothing decides which return", "type"],
    ['import "option"\nmixed n = {\n    Some 1\n    Ok n\n}', "a Result value cannot run in an Option do-block", "type"],
    ['import "option"\nmixed n = {\n    _ <- Some n\n    Ok n\n    return n\n}', "a Result value cannot run in an Option do-block", "type"],
    ['Tree = Leaf Int | Node Tree Tree\nprint (Tree empty)', "no throw instance for Tree", "runtime"],
    ['act n = {\n    guard (n > 0)\n    print n\n}\nact 0', "guard failed: n > 0", "runtime"],
    ['import "option"\nprint (sequence [Some 1, [2]])', "cannot use Vect 1 Int where Option a is required", "type"],
    ["print (sequence [1,2])", "sequence needs a list of actions or monadic values, not Int", "type"],
    // As in Haskell, a do-block's statements that bind nothing are in its monad.
    ['func = {\n    123\n    print "hello"\n    return (1 + 1)\n}', "a statement in a do-block must be an action, not Int", "type"],
    ['func = {\n    print "hello"\n    [1,2]\n    return 2\n}', "a statement in a do-block must be an action, not Vect 2 Int", "type"],
    ['import "option"\nf n = {\n    _ <- Some n\n    5\n    return n\n}', "a statement in a do-block must be an Option value, not Int", "type"],
    ["xs = {\n    x <- [1,2]\n    assert (x > 0)\n    return x\n}", "a statement in a do-block must be a List value, not Bool", "type"],
    ['h f = {\n    f []\n    print "a"\n    return 2\n}\nh (_ -> 1)', "a statement in a do-block must be an action, not Int", "runtime"],
] as const) Deno.test(`monads reject: ${JSON.stringify(source)}`, () => fails(source, message, kind));
// A block of returns and guards takes the monad its other statements name, as
// types decide in Haskell: the checker finds it, and the run uses it.
// throw e is the monad's failure, chosen by the context as return is; a
// false guard throws its condition as the call wrote it.
for (const [name, source, expected] of [
    ["throw in each monad", 'import "option"\nprint [Option Int (throw "x"), Result Int String (throw "x"), List Int (throw "x")]\nprint (throw 1)',
        ['[None, Err "x", []]', "[]\nNone\nErr 1"]],
    ["guard names the condition its call wrote", 'import "option"\ng x = guard x\nb = false\nprint [\n    Result Int String { g (1 > 2); return 1 }\n    Result Int String { guard b; return 1 }\n    Result Int String { guard $ 1 == 2; return 1 }\n]',
        ['[Err "guard failed: x", Err "guard failed: b", Err "guard failed: 1 == 2"]']],
] as const) Deno.test(`monads: ${name}`, () => {
    const actual = run(source);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(JSON.stringify(actual));
});
Deno.test("monads: >>= with no function fails when it would apply it", () => {
    for (const [source, expected] of [['import "option"\nprint (Some 1 >>= 5)', "'>>=' needs a function on its right, not a number"], ['import "option"\nprint (None >>= missing)', ""]] as const) {
        try { const out = run(source, false); if (expected || out[0] !== "None") throw new Error(`accepted: ${out}`); }
        catch (e) { if (!expected || !String(e).includes(expected)) throw e; }
    }
});
// As for a do-block, the checker decides a >>= chain's or a call's monad when
// the run would leave its value undecided; a generic function's is not decided.
for (const [name, source, expected] of [
    ["a >> chain", 'import "option"\ncheck n = unless (n > 0) (Err "not positive") >> guard (n < 100) >> return (n * 2)\nprint [check 2, check 0, check 200]',
        ['[Ok 4, Err "not positive", Err "guard failed: n < 100"]']],
    ["a call", 'import "option"\ncheck n = unless (n > 0) (Err "not positive")\nprint [check 1, check 0]', ['[Ok [], Err "not positive"]']],
    ["a list chain", "evens = [1..6] >>= x -> guard (x % 2 == 0) >> return x\nprint evens", ["[2,4,6]"]],
    ["not a generic function", 'import "option"\nwrap x = return x\nprint [Option Int (wrap 1), List Int (wrap 2)]', ["[Some 1, [2]]"]],
] as const) Deno.test(`monads: the checker decides ${name}`, () => {
    const actual = run(source);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(JSON.stringify(actual));
});
Deno.test("monads: an undecided >> chain prints as written", () => {
    for (const checked of [true, false]) {
        const actual = run("print (return 1 >> return 2 >> return 3)\nprint (guard true >> return 5)", checked);
        if (JSON.stringify(actual) !== JSON.stringify(["return 1 >> return 2 >> return 3", "return [] >> return 5"])) throw new Error(JSON.stringify(actual));
    }
});
Deno.test("monads: the checker decides an undecided block's monad", () => {
    const source = 'import ["option","number"]\ncheck n = {\n    unless (n > 0) (Err "not positive")\n    return (n * 2)\n}\nprint [check 2, check 0]';
    const actual = run(source);
    if (JSON.stringify(actual) !== JSON.stringify(['[Ok 4, Err "not positive"]'])) throw new Error(JSON.stringify(actual));
});
Deno.test("monads: a type without a return instance cannot take return", () => {
    try { run("Tree = Leaf Int | Node Tree Tree\nprint (Tree { return 1 })", false); }
    catch (e) { if (String(e).includes("no return instance for Tree")) return; throw e; }
    throw new Error("accepted");
});

Deno.test("monads: an undecided value used as a plain one is ambiguous at runtime", () => {
    for (const source of ['f x = 1\nf x = "one"\nprint (f 0 + 1)', "print (return 1 + 1)"]) {
        try { run(source, false); } catch (e) { if (String(e).includes("ambiguous: nothing decides which")) continue; throw e; }
        throw new Error(`accepted: ${source}`);
    }
});

// A return in one branch of a ternary is in the monad of the other branch, as
// unless c x is, whether the condition is known or not.
for (const [name, source, expected] of [
    ["a do-block statement", 'import "option"\ncheck n = {\n    n > 0 ? return [] : Err "not positive"\n    Ok n\n}\nprint (check 5)\nprint (check -1)', ["Ok 5", 'Err "not positive"']],
    ["a known condition", 'import "option"\nx = 5 > 0 ? return [] : Err "no"\nprint x', ["Ok []"]],
    ["Option and lists", 'import "option"\nhalf n = n % 2 == 0 ? return (n / 2) : None\nprint (half 4)\npick n = n > 0 ? return n : [0,1]\nprint (pick 5)', ["Some 2", "[5]"]],
    ["nested ternaries", 'import "option"\ngrade n = n > 90 ? return "A" : n > 50 ? return "B" : Err "fail"\nprint (grade 60)', ['Ok "B"']],
    ["a bound result", 'import "option"\nsafe n = {\n    k <- n > 0 ? return n : Err "neg"\n    Ok (k * 2)\n}\nprint (safe 4)', ["Ok 8"]],
] as const) Deno.test(`ternary return: ${name}`, () => {
    const actual = run(source);
    if (actual.join("\n") !== expected.join("\n")) throw new Error(`${actual} != ${expected}`);
});
