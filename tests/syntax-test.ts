import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

// toAST gives an expression as lists, as written; lib/syntax.apn's fromAST
// gives its source back, and eval evaluates it at the program's top level.
function session(): Interpreter {
    const i = new Interpreter();
    i.enableChecking();
    i.run(parse('import "syntax"'));
    return i;
}
const shown = (i: Interpreter, source: string, raw = false) => i.renderString(i.run(parse(source)), raw);

for (const [source, expected] of [
    ["f x + 1", '["+",["f","x"],1]'],
    ['f "x"', '["f","\\"x\\""]'],
    ["f x y", '["f","x","y"]'],
    ["_", '"_"'],
    ["-x", '["negate","x"]'],
    ["[x = 1, x + 1]", '["[]",["=","x",1],["+","x",1]]'],
    ["f n = n * 2", '["=",["f","n"],["*","n",2]]'],
    ["Some v = m", '["=",["Some","v"],"m"]'],
    ["x, y -> x", '["->",["x","y"],"x"]'],
    ["[1..]", '["..",1,[]]'],
    ["r.x", '[".","r","x"]'],
    ["[x: 1]", '["[:]",["x",1]]'],
    ["(+)", '"+"'],
    ["(+ 1)", '["()","+",1]'],
    ["(2 +)", '["+",2]'],
    ["1 + missing", '["+",1,"missing"]'],
] as const) Deno.test(`toAST: ${source}`, () => {
    const actual = shown(session(), `toAST (${source})`);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});

// fromAST writes source that reads back as the same Expr.
for (const source of [
    "f x + 1", "1 + 2 * 3", "(1 + 2) * 3", "f (g x) (-1)", '"a\\"b\\n"', "'c'", "[1,2,[3]]", "[1 + 1, 2]",
    "[x: 1, y: [2,3]]", "r.x.y", "xs.(i + 1)", "r.[a,b]", "[1,3..9]", "[0..]", "c ? 1 : 2",
    "x, y -> x * y", "(Int n), [a,b] | n > 0 -> a", "{ a <- return 1; print a }", "[x = 1, x + 1]",
    "f n = n * 2", "x :: xs = ys", "!b", "map (+ 1) xs", "head $ [1,2]", "{}", 'import ["option","map"]',
    "Some (Some 1)", "-x ^ 2", "n -> match n [0 -> 1, _ -> 2]", "(+)", "(- 2)", "(10 -)",
]) Deno.test(`fromAST round trip: ${source}`, () => {
    const i = session();
    const written = shown(i, `fromAST (toAST (${source}))`, true);
    const again = shown(i, `toAST (${written})`), original = shown(i, `toAST (${source})`);
    if (again !== original) throw new Error(`${written}: ${again} != ${original}`);
});

for (const [source, expected] of [
    ["eval (toAST (1 + 2 * 3))", "7"],
    ['eval ["+",1,2]', "3"],
    ['double e = ["*",e,2]\neval (double (toAST (3 + 1)))', "8"],
    ["square n = n * n\neval (toAST (square 7))", "49"],
    ["eval (toAST [x = 1, x + 1])", "[1,2]"],
    ["eval (toAST (x = 1))\nx = 5\nx", "5"],
    ["action = eval (toAST (print 1))\n2", "2"],
    ['eval "head" [4,5]', "4"],
] as const) Deno.test(`eval: ${JSON.stringify(source)}`, () => {
    const actual = shown(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});

Deno.test("eval runs at the top level, not in the caller's scope", () => {
    const i = session();
    i.run(parse("y = 10\nf y = eval (toAST (y + 1))"));
    if (shown(i, "f 1") !== "11") throw new Error(shown(i, "f 1"));
});

Deno.test("toAST does not evaluate or check its argument", () => {
    if (shown(session(), "toAST (undefinedName 1)") !== '["undefinedName",1]') throw new Error("unchecked");
});

// A (Quote q) parameter takes its argument as written: q is its source text.
for (const [source, expected] of [
    ['shown (Quote q) = q ++ " ="\nshown $ undefinedName + 1', '"undefinedName + 1 ="'],
    ["quote (1 + 1)", '"(1 + 1)"'],
    ["quote (+ 1)", '"(+ 1)"'],
    ["x = 5\nquote x", '"x"'],
    ["wrap y = quote y\nwrap (1 + 2)", '"y"'],
    ["both (Quote q) n = [q,n]\nboth (n + 1) 3", '["(n + 1)",3]'],
    ['Quote = [quote: String, year: Int]\nf (Quote q) = q.year\nf [quote: "a", year: 3]', "3"],
] as const) Deno.test(`Quote: ${JSON.stringify(source)}`, () => {
    const actual = shown(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});

Deno.test("Quote is a parameter pattern, not a function", () => {
    try { shown(session(), "Quote (1 + 1)"); } catch (error) {
        if (String(error).includes("Quote is a parameter pattern")) return;
        throw error;
    }
    throw new Error("accepted");
});

// toLambda desugars code to lambdas and application, and the result runs as
// the original does.
for (const [source, expected] of [
    ["{ x = 10; y = 20; x }", "(x -> (y -> x) 20) 10"],
    ["{ x = 10; y = x + 1; y }", "(x -> (y -> y) (x + 1)) 10"],
    ["{ x = 1; x = x + 1; x }", "(x -> (x -> x) (x + 1)) 1"],
    ["x, y -> x + y", "x -> y -> x + y"],
    ["map (+ 1) xs", "map (_1 -> _1 + 1) xs"],
    ["f $ g x", "f (g x)"],
    ["{ a <- return 1; print a; return (a + 1) }", "return 1 >>= (a -> print a >> return (a + 1))"],
    ["{ [a,b] = [1,2]; a + b }", "([a,b] -> a + b) [1,2]"],
    ["{ ones = 1 :: ones; take 2 ones }",
        "(ones -> take 2 ones) ((f -> (x -> f (x x)) (x -> f (x x))) (ones -> 1 :: ones))"],
    ["{ first (x :: _) d = x; first [] d = d; first [] 0 }",
        "(first -> first [] 0) (_1 -> _2 -> match [_1,_2] [[x :: _, d] -> x, [[],d] -> d])"],
] as const) Deno.test(`toLambda: ${source}`, () => {
    const actual = shown(session(), `fromAST (toLambda ${source.startsWith("{") ? source : `(${source})`})`, true);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const [source, expected] of [
    ["{ fact n = n == 0 ? 1 : n * fact (n - 1); fact 5 }", "120"],
    ["{ len [] = 0; len (_ :: rest) = 1 + len rest; len [7,8,9] }", "3"],
    ["{ ones = 1 :: ones; take 3 ones }", "[1,1,1]"],
    ["{ first (x :: _) d = x; first [] d = d; first [] 7 }", "7"],
    ["{ x = 1; x = x + 1; [x, x * 10] }", "[2,20]"],
] as const) Deno.test(`toLambda runs as written: ${source}`, () => {
    const i = session();
    const actual = shown(i, `eval (toLambda ${source})`), original = shown(i, source);
    if (actual !== expected || original !== expected) throw new Error(`${actual}, ${original} != ${expected}`);
});
