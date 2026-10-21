import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

// lib/syntax.apn: toAST gives an expression as an Expr, as written; fromAST
// gives its source back; eval evaluates one at the program's top level.
function session(): Interpreter {
    const i = new Interpreter();
    i.enableChecking();
    i.run(parse('import "syntax"'));
    return i;
}
const shown = (i: Interpreter, source: string, raw = false) => i.renderString(i.run(parse(source)), raw);

for (const [source, expected] of [
    ["f x + 1", 'Apply (Apply (Name "+") (Apply (Name "f") (Name "x"))) (Numeral 1)'],
    ['f "x"', 'Apply (Name "f") (Text "x")'],
    ["_", "Hole"],
    ["-x", 'Negate (Name "x")'],
    ["[x = 1, x + 1]", 'Items [Bind (Name "x") (Numeral 1), Apply (Apply (Name "+") (Name "x")) (Numeral 1)]'],
    ["f n = n * 2", 'Bind (Apply (Name "f") (Name "n")) (Apply (Apply (Name "*") (Name "n")) (Numeral 2))'],
    ["Some v = m", 'Bind (Apply (Name "Some") (Name "v")) (Name "m")'],
    ["x,y -> x", 'Lambda [Name "x", Name "y"] None (Name "x")'],
    ["[1..]", "Range (Numeral 1) None None"],
    ["r.x", 'Field (Name "r") "x"'],
    ["(+)", 'Name "+"'],
    ["(+ 1)", 'Section "+" (Numeral 1)'],
    ["(2 +)", 'Apply (Name "+") (Numeral 2)'],
    ["1 + missing", 'Apply (Apply (Name "+") (Numeral 1)) (Name "missing")'],
] as const) Deno.test(`toAST: ${source}`, () => {
    const actual = shown(session(), `toAST (${source})`);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});

// fromAST writes source that reads back as the same Expr.
for (const source of [
    "f x + 1", "1 + 2 * 3", "(1 + 2) * 3", "f (g x) (-1)", '"a\\"b\\n"', "'c'", "[1,2,[3]]", "[1 + 1, 2]",
    "[x: 1, y: [2,3]]", "r.x.y", "xs.(i + 1)", "r.[a,b]", "[1,3..9]", "[0..]", "c ? 1 : 2",
    "x,y -> x * y", "(Int n), [a,b] | n > 0 -> a", "{ a <- return 1; print a }", "[x = 1, x + 1]",
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
    ['eval (Apply (Apply (Name "+") (Numeral 1)) (Numeral 2))', "3"],
    ["square n = n * n\neval (toAST (square 7))", "49"],
    ["eval (toAST [x = 1, x + 1])", "[1,2]"],
    ["eval (toAST (x = 1))\nx = 5\nx", "5"],
    ["action = eval (toAST (print 1))\n2", "2"],
    ['eval (Name "head") [4,5]', "4"],
] as const) Deno.test(`eval: ${JSON.stringify(source)}`, () => {
    const actual = shown(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});

Deno.test("eval runs at the top level, not in the caller's scope", () => {
    const i = session();
    i.run(parse("y = 10\nf y = eval (toAST (y + 1))"));
    if (shown(i, "f 1") !== "11") throw new Error(shown(i, "f 1"));
});

Deno.test("toAST does not evaluate or check its argument; its result is an Expr", () => {
    const i = session();
    if (shown(i, "isType Expr (toAST (undefinedName 1))") !== "true") throw new Error("Expr");
    if (shown(i, 'match (toAST (f 1)) [Apply (Name f) _ -> f, _ -> ""]') !== '"f"') throw new Error("match");
});

Deno.test("toAST needs import \"syntax\"", () => {
    try { new Interpreter().run(parse("toAST 1")); } catch (e) {
        if (String(e).includes("toAST")) return;
        throw e;
    }
    throw new Error("expected an unbound toAST");
});
