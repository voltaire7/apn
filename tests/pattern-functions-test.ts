import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

function result(code: string, checked = false): string {
    const i = new Interpreter();
    if (checked) i.enableChecking();
    return i.renderString(i.run(parse('import ["option","sequence"]; ' + code)));
}
for (const [code, expected] of [
    ['(Some x -> x) (Some 123)', '123'],
    ['cases = [Some x -> x, None -> 0]; Some 123 ~ cases', '123'],
    // A type's bare name matches that type, as == compares it.
    ['typeOf 5 ~ [Int -> "INT", _ -> "other"]', '"INT"'],
    ['d Int = "int"; d (n : Int) = "num"; d _ = "o"; [d Int, d (typeOf 5), d 5, d "s"]', '["int","int","num","o"]'],
    ['Shape = Circle Float | Square Float\nd Shape = 1\nd _ = 0\n[d (typeOf (Circle 1)), d Int]', '[1,0]'],
    ['cases = [Some x -> x, None -> 0]; None ~ cases', '0'],
    ['dispatch = (~); dispatch 3 [n | n < 0 -> 0, n -> n + 1]', '4'],
    ['x ~ handlers = 42; 123 ~ []', '42'],
    ['missing ~ [_ -> 42, x -> missing]', '42'],
    ['2 ~ [0 -> missing, 2 -> 42, x -> missing]', '42'],
    ['None ~ [Some x -> missing, _ -> 42]', '42'],
    ['Some 3 ~ [Some x -> x]', '3'],
    ['0 ~ [x | x > 0 -> x, _ -> 42]', '42'],
    // The most specific alternative that fits wins, as among clauses; written
    // order breaks ties.
    ['0 ~ [n -> "any", 0 -> "zero"]', '"zero"'],
    ['1 ~ [(x : Float) -> "float", (x : Int) -> "int"]', '"int"'],
    ['cases = [n -> "any", 0 -> "zero"]; 0 ~ cases', '"zero"'],
    ['f 0 = "zero"; f n = "any"; 0 ~ [n -> "name", f]', '"zero"'],
    // A function matching its parameters is described as its clauses.
    ['d = x -> x ~ [(n : Int) -> n + 1, (s : String) -> s ++ "!"]; typeOf d', 'Int | String -> Int'],
    ['dispatch = (3 ~); dispatch [(+ 1)]', '4'],
    ['[3] ~ [head]', '3'],
    ['f 0 = 9; f 1 = 8; 1 ~ [f, _ -> 0]', '8'],
    ['func (f : Int -> Int) = { f 123 } : Int; func (*2)', '246'],
    ['(identity : Int -> Int) <- return (x -> x)\nTransform = typeOf identity\nfunc (Transform f) = { f 123 } : Int\nfunc (*2)', '246'],
    ['func (f : Int -> Int) = 42; func (x -> missing)', '42'],
    ['func (f : Int -> Int) = f 2.0; func (*2)', '4'],
    ['func (f : Int -> Int -> Int) = f 2 3; func (x, y -> x + y)', '5'],
    ['1 ~ [(f : Int -> Int) -> f 0, x -> x]', '1'],
    // An alternative's parameter is one pattern, as everywhere: t x binds the type.
    ['1 ~ [t x -> [t,x]]', '[Int,1]'],
    ['(t x -> t) "a"', 'String'],
]) Deno.test(`pattern functions: ${code}`, () => {
    const actual = result(code);
    if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
});
for (const [code, error] of [
    ['(None -> missing) (Some 123)', 'no clause'],
    ['2 ~ [1 -> 0]', 'non-exhaustive match'],
    ['1 ~ [_ -> missing, _ -> 42]', 'unbound variable'],
    ['1 ~ [x | missing -> 0, _ -> 42]', 'unbound variable'],
    ['1 ~ [_ -> _, _ -> 42]', 'not implemented'],
    ['1 ~ [42]', 'one remaining argument'],
    // Ranking reads every alternative (not the bodies).
    ['3 ~ (_ -> 42)::missing', 'unbound variable'],
    // A two-parameter lambda needs parentheses in a list; ~ gives it one argument.
    ['1 ~ [(x, y -> x)]', 'one remaining argument'],
    ['missing ~ []', 'non-exhaustive match'],
    ['1 ~ 42', 'expected a list'],
    ['func (f : Int -> Int) = f (.5 : Float); func (*2)', 'lossy conversion'],
    ['func (f : Int -> Int) = f 1; func (x -> "bad")', 'expects a number'],
]) Deno.test(`pattern functions reject: ${code}`, () => {
    try { result(code); } catch (e) {
        if (String(e).includes(error)) return;
        throw e;
    }
    throw new Error('expected error');
});
Deno.test("pattern functions parse independently of prior constructor imports", () => {
    const i = new Interpreter();
    const code = 'FreshOption = FreshSome a | FreshNone\nhandlers = [FreshSome x -> x, FreshNone -> 0]\nFreshNone ~ handlers';
    if (i.renderString(i.run(parse(code))) !== '0') throw new Error('nullary constructor treated as variable');
});

Deno.test("constructor lambdas accept nested patterns", () => {
    if (result('Some 3 ~ [Some (x : Int) -> x]') !== '3') throw new Error('nested type pattern');
    if (result('Some "no" ~ [Some (x : Int) -> x, _ -> 42]') !== '42') throw new Error('nested mismatch');
    if (result('(Some [a,b] -> a + b) (Some [1,2])') !== '3') throw new Error('nested list pattern');
});

Deno.test("guards can use nested lambda arguments", () => {
    if (result('[1,2] ~ [xs | all (n -> n > 0) xs -> 42, _ -> 0]') !== '42') throw new Error('nested lambda in guard');
});

// A type known only when it runs may be the one a bare type name names: the
// checker leaves that to the run, which takes the alternative or fails.
for (const [code, expected] of [
    ['typeOf 123 ~ [Int -> "INT"]', '"INT"'],
    ['f x = typeOf x ~ [Int -> "INT", _ -> "other"]\n[f 5, f "a"]', '["INT","other"]'],
    ['d Int = 1\nd (typeOf 5)', '1'],
    ['typeOf "s" ~ [Int -> "INT"]', 'non-exhaustive match'],
    ['g (n : Int) = n\ng (typeOf 5)', 'cannot use Type where Int is required'],
]) Deno.test(`a bare type name, checked: ${code}`, () => {
    let actual: string;
    try { actual = result(code, true); } catch (error) { actual = (error as Error).message; }
    if (!actual.includes(expected)) throw new Error(`Expected ${expected}, got ${actual}`);
});

Deno.test("~ is intrinsic and has no public attempt protocol", () => {
    const i = new Interpreter();
    const match = i.env.get("~");
    if (match?.kind !== "native" || match.name !== "intrinsics.match" || i.env.get("match")) throw new Error("~ must be intrinsics.match, and match unbound");
    for (const name of ["tryMatch", "MatchAttempt", "Matched", "Unmatched"]) {
        if (i.env.get(name)) throw new Error(`unexpected builtin ${name}`);
    }
});

Deno.test("~ traverses many rejected alternatives without recursive dispatch", () => {
    if (result('1 ~ map (n -> 0 -> 0) [1..10000] ++ [_ -> 42]') !== '42') throw new Error('dispatch failed');
});

Deno.test("guards accept truthy numbers", () => {
    if (result("1 ~ [x | 1 -> 0, _ -> 42]") !== "0") throw new Error("guard did not match");
});
