import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

// toAST gives code, a list's items as written, as lists; lib/std/syntax.apn's
// fromAST gives its source back, and eval evaluates it at the program's top
// level.
function session(): Interpreter {
    const i = new Interpreter();
    i.enableChecking();
    i.run(parse('std <- import "std"; use std.syntax'));
    return i;
}
const shown = (i: Interpreter, source: string, raw = false) => i.renderString(i.run(parse(source)), raw);
// f applied to source, in parentheses only where they are needed.
function applied(f: string, source: string): string {
    const grouped = `${f} (${source})`;
    try { parse(grouped); } catch (e) { if (/unnecessary parentheses/.test(String(e))) return `${f} ${source}`; }
    return grouped;
}

for (const [source, expected] of [
    ["[f x + 1]", '["[]",["+",["f","x"],1]]'],
    ['[f "x"]', '["[]",["f","\\"x\\""]]'],
    ["[f x y]", '["[]",["f","x","y"]]'],
    ["[_]", '["[]","_"]'],
    ["[-x]", '["[]",["negate","x"]]'],
    ["[x = 1, x + 1]", '["[]",["=","x",1],["+","x",1]]'],
    ["[f n = n * 2]", '["[]",["=",["f","n"],["*","n",2]]]'],
    ["[Some v = Some 1]", '["[]",["=",["Some","v"],["Some",1]]]'],
    ["[(x, y -> x)]", '["[]",["->",["x","y"],"x"]]'],
    ["[[1..]]", '["[]",["..",1,[]]]'],
    ["[r.x]", '["[]",[".","r","x"]]'],
    ["[[x = 1]]", '["[]",["[:]",["x",1]]]'],
    ["[(+)]", '["[]","+"]'],
    ["[(+ 1)]", '["[]",["()","+",1]]'],
    ["[(2 +)]", '["[]",["+",2]]'],
    ["[1 + missing]", '["[]",["+",1,"missing"]]'],
    // An ascription, and a typed pattern, is [":", value, type]: no application.
    ["[(x : Int)]", '["[]",[":","x","Int"]]'],
    ["[f (Some (n : Int)) = n]", '["[]",["=",["f",["Some",[":","n","Int"]]],"n"]]'],
    ["[((x -> x) : Int -> Int) 1]", '["[]",[[":",["->",["x"],"x"],["->",["Int"],"Int"]],1]]'],
] as const) Deno.test(`toAST: ${source}`, () => {
    const actual = shown(session(), `std <- import "std"; use std.option\ntoAST ${source}`);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});

// fromAST writes source that reads back as the same Expr, with parentheses
// only where they are needed (it parses with every rule on).
for (const source of [
    "f x + 1", "1 + 2 * 3", "(1 + 2) * 3", "a - (b - c)", "a - b - c", "(a :: b) :: c", "a ^ b ^ c",
    "(a ^ b) ^ c", "f (g x) -1", '"a\\"b\\n"', "'c'", "[1,2,[3]]", "[1 + 1, 2]", "[x = 1, y = [2,3]]",
    "r.x.y", "xs.(i + 1)", "r.[a,b]", "(f x).y", "[1,3..9]", "[0..]", "[a + 1..b]",
    "c ? 1 : 2", "c ? (d ? 1 : 2) : 3", "c ? 1 : (d ? 2 : 3)", "f (c ? 1 : 2)", "a $ b ? c : d",
    "c ? (a $ b) : d", "x, y -> x * y", "(n : Int), [a,b] | n > 0 -> a", "{ a <- return 1; print a }",
    "[x = 1, x + 1]", "f n = n * 2", "x :: xs = ys", "!b", "map (+ 1) xs", "head $ [1,2]", "f $ g $ x",
    "{}", 'std <- import "std"; use std.[option,map]', "Some (Some 1)", "-x ^ 2", "n -> n ~ [0 -> 1, _ -> 2]", "(+)",
    "(- 2)", "(10 -)", "xs >>= x -> f x", "xs >>= (x -> f x) >>= g", "(x -> x) 1", "f (x -> x) y",
    "run (x -> x)", "withFile path (file -> file.read)", 'withFile "notes" $ file -> file.read',
    "bracket 1 (_ -> []) (x -> y -> x)", "[(x, y -> x)]", "[x -> x]", "foo Bar (x -> x)",
    "a && (b || c)", "a == (b == c)", "-(a + b)", "f \\ g \\ h", "(f \\ g) \\ h", "1 + (x -> x)",
    "(x : Int)", "f (Some (n : Int)) = n", "(m : HashMap _ _)", "((x -> x) : Int -> Int) 1",
]) Deno.test(`fromAST round trip: ${source}`, () => {
    const i = session(), text = JSON.stringify(source);
    const written = shown(i, `fromAST (intrinsics.syntax ${text})`, true);
    parse(written);
    const again = shown(i, `intrinsics.syntax ${JSON.stringify(written)}`), original = shown(i, `intrinsics.syntax ${text}`);
    if (again !== original) throw new Error(`${written}: ${again} != ${original}`);
});

for (const [source, expected] of [
    ["eval (toAST [1 + 2 * 3])", "[7]"],
    ["eval (toAST [(1.0 : Int), ((x -> x + 1) : Int -> Int) 41])", "[1,42]"],
    ['eval ["+",1,2]', "3"],
    ['double e = ["*",e,2]\neval (double (toAST [3 + 1]))', "[8]"],
    ["square n = n * n\neval (toAST [square 7])", "[49]"],
    ["eval (toAST [x = 1, x + 1])", "[2]"],
    ["y = eval (toAST [x = 1])\nx = 5\n[y,x]", "[[x = 1], 5]"],
    ["action = eval (toAST [print 1])\n2", "2"],
    ['eval "head" [4,5]', "4"],
] as const) Deno.test(`eval: ${JSON.stringify(source)}`, () => {
    const actual = shown(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});

Deno.test("eval runs at the top level, not in the caller's scope", () => {
    const i = session();
    i.run(parse("y = 10\nf y = eval (toAST [y + 1])"));
    if (shown(i, "f 1") !== "[11]") throw new Error(shown(i, "f 1"));
});

Deno.test("toAST does not evaluate its code", () => {
    if (shown(session(), "toAST [undefinedName 1]") !== '["[]",["undefinedName",1]]') throw new Error("evaluated");
});

// toLambda desugars code to lambdas and application, as code: probe shows
// it, and its values are the original's (a binding's item aside: its name is
// a lambda's parameter).
for (const [source, expected] of [
    ["[{ x = 10; y = 20; x }]", "[(x -> (y -> x) 20) 10]"],
    ["[{ x = 10; y = x + 1; y }]", "[(x -> (y -> y) (x + 1)) 10]"],
    ["[{ x = 1; x = x + 1; x }]", "[(x -> (x -> x) (x + 1)) 1]"],
    ["[(x, y -> x + y)]", "[x -> y -> x + y]"],
    ["[map (+ 1) xs]", "[map (_1 -> _1 + 1) xs]"],
    ["[f $ g x]", "[f (g x)]"],
    ["[{ a <- return 1; print a; return (a + 1) }]", "[return 1 >>= a -> print a >> return (a + 1)]"],
    ["[{ [a,b] = [1,2]; a + b }]", "[([a,b] -> a + b) [1,2]]"],
    ["[{ ones = 1 :: ones; take 2 ones }]",
        "[(ones -> take 2 ones) ((f -> (x -> f (x x)) (x -> f (x x))) (ones -> 1 :: ones))]"],
    ["[{ first (x :: _) d = x; first [] d = d; first [] 0 }]",
        "[(first -> first [] 0) (_1 -> _2 -> [_1,_2] ~ [[x :: _, d] -> x, [[],d] -> d])]"],
    // A list's bindings scope over its later items, as a block's do.
    ["[x = 1, x + 1]", "[(x -> x + 1) 1]"],
    ["[x = 1, y = 2, x + y]", "[(x -> (y -> x + y) 2) 1]"],
    ["[[a,b] = [1,2], a + b]", "[([a,b] -> a + b) [1,2]]"],
] as const) Deno.test(`toLambda: ${source}`, () => {
    const actual = shown(session(), `intrinsics.written (toLambda ${source})`, true);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const [source, expected] of [
    ["[{ fact n = n == 0 ? 1 : n * fact (n - 1); fact 5 }]", "[120]"],
    ["[{ len [] = 0; len (_ :: rest) = 1 + len rest; len [7,8,9] }]", "[3]"],
    ["[{ ones = 1 :: ones; take 3 ones }]", "[[1,1,1]]"],
    ["[{ first (x :: _) d = x; first [] d = d; first [] 7 }]", "[7]"],
    ["[{ x = 1; x = x + 1; [x, x * 10] }]", "[[2,20]]"],
    ["[[a,b] = [3,4], double n = n * 2, double (a * b)]", "[24]"],
] as const) Deno.test(`toLambda runs as written: ${source}`, () => {
    const actual = shown(session(), `toLambda ${source}`);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
