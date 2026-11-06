import { exprToSource, parse, setLooseSpacing } from "../src/parser.ts";

// Parentheses that do not change how an expression reads are an error.
for (const source of [
    "print (5)",
    "list >>= (x -> x * 2)",
    "f ((g x))",
    "(a * b) + c",
    "a + (b * c)",
    "(f x) y",
    "print (-1)",
    "print (!b)",
    "print (r.x)",
    "-(f x)",
    "y = (a + b)",
    "c ? ((a ? 1 : 2)) : 3",
]) Deno.test(`unnecessary parentheses: ${source}`, () => {
    try { parse(source); } catch (error) {
        if (String(error).includes("unnecessary parentheses")) return;
        throw error;
    }
    throw new Error("accepted");
});

// A ternary inside a ternary needs its parentheses, in any of its places.
for (const source of ["c ? a ? 1 : 2 : 3", "c ? 1 : a ? 2 : 3", "c ? 1 : 2 ? 3 : 4", "c\n    ? a ? 1 : 2\n    : 3"]) {
    Deno.test(`a nested ternary needs parentheses: ${JSON.stringify(source)}`, () => {
        try { parse(source); } catch (error) {
            if (String(error).includes("a ternary inside a ternary needs parentheses")) return;
            throw error;
        }
        throw new Error("accepted");
    });
}

for (const source of [
    "c ? (a ? 1 : 2) : 3",
    "c ? 1 : (a ? 2 : 3)",
    "(c ? a : b) ? 1 : 2",
    "(a + b) * c",
    "a - (b - c)",
    "(a :: b) :: c",
    "a == (b == c)",
    "f (g x)",
    "(-2) ^ 2",
    "-(a + b)",
    "-(-x)",
    "!(!b)",
    "(x -> x) 1",
    "xs >>= (x -> f x) >>= g",
    // f = x -> e is a clause of f; f = (x -> e) binds a value.
    "f = (x -> x)",
    // A lambda argument keeps its parentheses: run x -> x is a lambda.
    "run (x -> x)",
    'withFile "notes" (file -> file.read)',
    "(x -> x) (y -> y)",
    "[(x, y -> x)]",
    "xs (i) = 2",
    "obj.[(key)]",
    "(r.1).2",
    "c ? (a $ b) : d",
]) Deno.test(`necessary parentheses: ${source}`, () => { parse(source); });

Deno.test("--loose accepts unnecessary parentheses", () => {
    setLooseSpacing(true);
    try { parse("print (5)"); } finally { setLooseSpacing(false); }
});

// A definition's parameters read as arguments do, so a cons is parenthesized.
for (const source of [
    "len _ :: rest = 1",
    "f x y :: ys = y",
]) Deno.test(`bare cons parameter: ${JSON.stringify(source)}`, () => {
    try { parse(source); } catch (error) {
        if (String(error).includes("is one pattern")) return;
        throw error;
    }
    throw new Error("accepted");
});

for (const source of [
    "Option a = Some a | None\nf (Some x) = x\nf None = 0",
    "len (_ :: rest) = 1",
    "f (x : Int) y = x",
    "Option a = Some a | None\ng = Some x -> x",
    "Option a = Some a | None\nSome v = Some 1",
    "Money = | Money Int\nMoney a + Money b = Money (a + b)",
]) Deno.test(`parenthesized parameter: ${JSON.stringify(source)}`, () => { parse(source); });

// Every constructor pattern takes its fields, so f Some x = ... (the function
// Some, then x) is a static error.
Deno.test("a constructor pattern without its fields is an error", async () => {
    const { Interpreter } = await import("../src/interp.ts");
    for (const source of ['import "option"\nf Some x = x', 'import "option"\ng = Some -> 1']) {
        const i = new Interpreter();
        i.enableChecking();
        try { i.run(parse(source)); } catch (error) {
            const e = error as { message: string; hint?: string };
            if (e.message.includes("'Some' in a pattern takes 1 field") && e.hint === "write (Some x)") continue;
            throw error;
        }
        throw new Error(`accepted: ${source}`);
    }
});

// Juxtaposed words before -> are one typed parameter, as f a e -> ... is (e of
// type f a), literals included: withFile "notes" file -> e is a lambda, not
// withFile "notes" given one, so a lambda argument keeps its parentheses.
Deno.test("a juxtaposed lambda parameter is one typed pattern", () => {
    for (const source of ['withFile "notes" file -> file.read', "t1 1 t2 -> [t1,t2]"]) {
        const [top] = parse(source);
        const e = top.t === "expr" ? top.value : undefined;
        if (e?.t !== "patternLambda" || e.params.length !== 1 || e.params[0].p !== "schema") throw new Error(source);
    }
});

// exprToSource (function text, (Quote q)) writes an expression with
// parentheses only where needed: its text parses strictly to the same tree.
const STATEMENTS = new Set(["stmDef", "patDef", "setItem", "setFields"]);
function tree(x: unknown): unknown {
    if (typeof x === "bigint") return x.toString();
    if (Array.isArray(x)) return x.map(tree);
    if (!x || typeof x !== "object") return x;
    const o = x as Record<string, unknown>;
    if (o.t === "block" && o.style === "(" && Array.isArray(o.stmts) && o.stmts.length === 1 && !STATEMENTS.has((o.stmts[0] as { t: string }).t)) return tree(o.stmts[0]);
    return Object.fromEntries(Object.keys(o).sort().map(k => [k, tree(o[k])]));
}
for (const source of [
    "f x + 1", "(1 + 2) * 3", "a - (b - c)", "(a :: b) :: c", "a ^ b ^ c", "(a ^ b) ^ c", "f (g x) -1",
    "f -(a + b)", "-(-x)", "!f x", "-x ^ 2", "(-x) ^ 2", "r.x.y", "xs.(i + 1)", "(r.1).2", "(f x).y",
    "c ? (d ? 1 : 2) : 3", "c ? 1 : (d ? 2 : 3)", "(c ? 1 : 2) + 3", "a $ b ? c : d", "c ? (a $ b) : d", "f $ g $ x",
    "xs >>= x -> f x", "xs >>= (x -> f x) >>= g", "(x -> x) 1", "f (x -> x) y", "run (x -> x)",
    "[(x, y -> x)]", "[x -> x]", "map (+ 1) xs", "(+)", "(10 -)", "[1 + 1, 2]", "[x: f 1]",
    "x | x > 0 -> y -> y", "{ a <- return 1; print (a + 1) }", "a && (b || c)", "[a + 1..b]",
]) Deno.test(`exprToSource round trip: ${source}`, () => {
    const [top] = parse(source);
    const e = top.t === "expr" ? top.value : undefined;
    if (!e) throw new Error("not an expression");
    const written = exprToSource(e), [again] = parse(written);
    if (again.t !== "expr" || JSON.stringify(tree(again.value)) !== JSON.stringify(tree(e))) throw new Error(`${written} reads differently`);
});
