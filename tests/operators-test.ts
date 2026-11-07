import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

// Operators are prelude functions with declared fixities; programs may
// overload them and (though it is discouraged) define new ones.
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

for (const [name, source, expected] of [
    ["operators are functions", "print ((+) 1 2)\nprint (foldl (*) 1 [1..5])\nprint (intrinsics.add 1 2)", ["3", "120", "3"]],
    // Each use of an intrinsic has its own type variables.
    ["intrinsics are polymorphic at each use", "x <- intrinsics.return 1\ny <- intrinsics.return \"s\"\nprint [x + 1]\nprint (y ++ \"!\")\nprint (intrinsics.source 1 ++ intrinsics.source \"a\")",
        ["[2]", "s!", "1\"a\""]],
    ["sections of any operator", "print (map (2 ^) [1,2,3])\nprint (map (++ [0]) [[1],[2]])\nprint (filter (>= 2) [1,2,3])", ["[2,4,8]", "[[1,0],[2,0]]", "[2,3]"]],
    ["prelude fixities", "print (1 + 2 * 3)\nprint (2 ^ 3 ^ 2)\nprint (10 - 3 - 2)\nprint (1 :: 2 :: [3])\nprint (-2 ^ 2)", ["7", "512", "5", "[1,2,3]", "-4"]],
    ["cons stays lazy", "ones = 1::ones\nprint (take 3 ones)", ["[1,1,1]"]],
    ["&& and || short-circuit", "print (False && head [])\nprint (True || head [])", ["False", "True"]],
    ["an overload falls back to the builtin", "Money = | Money Int\nMoney a + Money b = Money (a + b)\nprint (Money 3 + Money 4)\nprint (1 + 2)\nprint (\"a\" + \"b\")",
        ["Money 7", "3", "ab"]],
    ["a literal clause falls back to the builtin for other arguments", "1 + 1 = 3\nprint (1 + 1)\nprint (1 + 2)\nprint (2 + 2)", ["3", "3", "4"]],
    ["a new operator with a fixity", "infixr 5 +|+\nxs +|+ ys = xs ++ [0] ++ ys\nprint ([1] +|+ [2] +|+ [3])", ["[1,0,2,0,3]"]],
    ["an undeclared operator is infixl 9", "a <-> b = a - b\nprint (10 <-> 3 <-> 2)\nprint (2 * 5 <-> 1)", ["5", "8"]],
    ["an operator bound to a function", "(<||>) = max\nprint (3 <||> 7)\nprint ((<||>) 9 1)", ["7", "9"]],
    ["a local operator definition", "f x = {\n    (+) = max\n    x + 1\n}\nprint (f 5)\nprint (5 + 1)", ["5", "6"]],
    ["a local infix definition", "f x = {\n    a <+> b = a * 10 + b\n    x <+> 1 <+> 2\n}\nprint (f 5)", ["512"]],
    ["$ is an operator", "print (head $ tail [1,2,3])\nprint ((+ 1) \\ (* 2) $ 3)", ["2", "7"]],
    // Applying a value that is not a function is get, which clauses extend.
    ["clauses for get index a type", "Grid (cells : List Int) = _\nget (Grid cells) [(r : Int), (c : Int)] = cells (3 * r + c)\n" +
        "g = Grid [1,2,3,4,5,6,7,8,9]\nprint (g [1,2])\nprint (map g [[0,0],[2,2]])\nprint ([10,20] 1)\nprint (get [5,6] 0)",
        ["6", "[1,9]", "20", "5"]],
    // xs i = x binds xs to with xs i x, which clauses extend too; v.x is get v "x".
    ["clauses for with assign to a type", "Grid (cells : List Int) = _\nget (Grid cells) [(r : Int), (c : Int)] = cells (3 * r + c)\n" +
        "with (Grid cells) [(r : Int), (c : Int)] (x : Int) = Grid (with cells (3 * r + c) x)\n" +
        "g = Grid [1,2,3,4,5,6,7,8,9]\nold = g\ng [1,2] = 60\nprint [g [1,2], old [1,2]]\nxs = [1,2]\nxs 0 = 5\nprint [xs, with xs 1 7]",
        ["[60,6]", "[[5,2],[5,7]]"]],
    ["clauses for get and with give a type fields", "Point (x : Float) (y : Float) = _\nget (Point x y) \"x\" = x\nget (Point x y) \"y\" = y\n" +
        "with (Point x y) \"x\" (v : Float) = Point v y\nwith (Point x y) \"y\" (v : Float) = Point x v\n" +
        "p = Point 1 2\nprint (p.x + p.y)\np.x = 5\na = [p = p]\na.p.y = 3\nprint a",
        ["3.0", "[p = Point 5.0 3.0]"]],
    // Clauses taking another number of arguments define a new function.
    ["an overload takes as many arguments", "log b x = b\nprint (log 2 8)\nget k = k\nprint (get 3)\nprint ([4,5] 1)", ["2", "3", "5"]],
] as const) Deno.test(`operators: ${name}`, () => {
    for (const checked of [true, false]) {
        const actual = run(source, checked);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${checked ? "checked" : "unchecked"}: ${JSON.stringify(actual)}`);
    }
});

for (const [source, message, kind] of [
    ["infix 4 =~=\na =~= b = a == b\nprint (1 =~= 1 =~= True)", "is non-associative", "parse"],
    ["infixl 10 <**>", "precedence", "parse"],
    ["print (1 <%%> 2)", "unbound operator '<%%>'", "type"],
    ["print (1+-2)", "unbound operator '+-'", "type"],
    ["print (get (x -> x) 1)", "get takes a value, not a function", "type"],
    ["Grid (cells : List Int) = _\nprint (Grid [1] 0)", "cannot apply Grid", "type"],
] as const) Deno.test(`operators reject: ${source}`, () => fails(source, message, kind));

// An operator written infix, as (op) or as its intrinsic is checked the same
// way, and -x and !x the same as negate x and not x.
for (const [spellings, text] of [
    [['f [a,b] = a\nf ([1] ++ [2,3])', 'f [a,b] = a\nf ((++) [1] [2,3])', 'f [a,b] = a\nf (intrinsics.append [1] [2,3])'], "length mismatch"],
    [['f [a,b] = a\nf (0 :: [2,3])', 'f [a,b] = a\nf ((::) 0 [2,3])'], "length mismatch"],
    [['y = print 1 + 1', 'y = (+) (print 1) 1', 'y = intrinsics.add (print 1) 1'], "cannot use an action"],
    [['foldl (x, y -> x + y) 0 ["a"]', 'foldl (+) 0 ["a"]'], "cannot combine Int and String"],
    [['y = !print 1', 'y = not (print 1)'], "an action is not a condition"],
    [['y = -"a"', 'y = negate "a"'], "cannot negate String"],
] as const) for (const source of spellings) Deno.test(`one typing for each spelling: ${JSON.stringify(source)}`, () => fails(source, text, "type"));
for (const [source, expected] of [
    ["print (not 0)", ["True"]],
    ["Cents = | Cents Int\nCents a + Cents b = Cents (a + b)\nprint ((+) (Cents 1) (Cents 2))\nprint (zipWith (+) [1] [2])", ["Cents 3", "[3]"]],
    ["print (+)\nprint ((+) 1)\nprobe [(+)]", ["(+)", "(1 +)", "[(+)]"]],
] as const) Deno.test(`operators as functions: ${JSON.stringify(source)}`, () => {
    const actual = run(source);
    if (actual.join("\n") !== expected.join("\n")) throw new Error(`${actual} != ${expected}`);
});

// The checker's evaluator knows an operator's result in each spelling: f
// checks only when the take count, and so the list's length, is known, also
// through a take written in APN, which passes the count on.
const TK = 'std <- import "std"\nuse std.function\ntk2 0 _ = []; tk2 _ [] = []; tk2 n (x :: rest) = x :: tk2 (n - 1) rest\n' +
    'tk (n : Int) xs = n < 0 ? fail "negative" : tk2 n xs\n';
for (const count of ["1 + 1", "(+) 1 1", "intrinsics.add 1 1", "(1 +) 1", "($) id 2", "intrinsics.apply id 2",
    "(-) 3 1", "intrinsics.sub 3 1", "length ((++) [1] [2])", "length (intrinsics.cons 1 [5])", "negate -2"]) {
    for (const [take, prefix] of [["take", ""], ["tk", TK]]) Deno.test(`the checker evaluates each spelling (${take}): ${count}`, () => {
        const actual = run(`${prefix}id x = x\nf [a,b] = a\nprint (f (${take} (${count}) [1,2,3]))`);
        if (actual.join() !== "1") throw new Error(actual.join());
    });
}
