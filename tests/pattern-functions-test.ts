import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

function result(code: string): string {
    const i = new Interpreter();
    return i.renderString(i.run(parse('import "std"; ' + code)));
}
for (const [code, expected] of [
    ['(Some x -> x) (Some 123)', '123'],
    ['cases = [Some x -> x,None -> 0]; match (Some 123) cases', '123'],
    ['cases = [Some x -> x,None -> 0]; match None cases', '0'],
    ['dispatch = match; dispatch 3 [n | n < 0 -> 0,n -> n + 1]', '4'],
    ['match x handlers = 42; match 123 []', '42'],
    ['match missing [_ -> 42,x -> missing]', '42'],
    ['match 2 [0 -> missing,2 -> 42,x -> missing]', '42'],
    ['match None [Some x -> missing,_ -> 42]', '42'],
    ['match (Some 3) [Some x -> x]', '3'],
    ['match 0 [x | x > 0 -> x,_ -> 42]', '42'],
    ['match 3 ((_ -> 42):missing)', '42'],
    ['dispatch = match 3; dispatch [(+ 1)]', '4'],
    ['match [3] [head]', '3'],
    ['f 0 = 9; f 1 = 8; match 1 [f,_ -> 0]', '8'],
    ['func ((Int -> Int) f) = Int { f 123 }; func (*2)', '246'],
    ['((Int -> Int) identity) <- (x -> x); Transform = typeOf identity; func (Transform f) = Int { f 123 }; func (*2)', '246'],
    ['func ((Int -> Int) f) = 42; func (x -> missing)', '42'],
    ['func ((Int -> Int) f) = f 2.0; func (*2)', '4'],
    ['func ((Int -> Int -> Int) f) = f 2 3; func (x y -> x + y)', '5'],
    ['match 1 [((Int -> Int) f) -> f 0,x -> x]', '1'],
]) Deno.test(`pattern functions: ${code}`, () => {
    const actual = result(code);
    if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
});
for (const [code, error] of [
    ['(None -> missing) (Some 123)', 'no clause'],
    ['match 2 [1 -> 0]', 'non-exhaustive match'],
    ['match 1 [_ -> missing,_ -> 42]', 'unbound variable'],
    ['match 1 [x | missing -> 0,_ -> 42]', 'unbound variable'],
    ['match 1 [_ -> _,_ -> 42]', 'not implemented'],
    ['match 1 [42]', 'one remaining argument'],
    ['match 1 [x y -> x]', 'one remaining argument'],
    ['match missing []', 'non-exhaustive match'],
    ['match 1 42', 'expected a list'],
    ['func ((Int -> Int) f) = f (Float .5); func (*2)', 'lossy conversion'],
    ['func ((Int -> Int) f) = f 1; func (x -> "bad")', 'expects a number'],
]) Deno.test(`pattern functions reject: ${code}`, () => {
    try { result(code); } catch (e) {
        if (String(e).includes(error)) return;
        throw e;
    }
    throw new Error('expected error');
});
Deno.test("pattern functions parse independently of prior constructor imports", () => {
    const i = new Interpreter();
    const code = 'FreshOption = FreshSome a | FreshNone; handlers = [FreshSome x -> x,FreshNone -> 0]; match FreshNone handlers';
    if (i.renderString(i.run(parse(code))) !== '0') throw new Error('nullary constructor treated as variable');
});

Deno.test("constructor lambdas accept nested patterns", () => {
    if (result('match (Some 3) [Some (Int x) -> x]') !== '3') throw new Error('nested type pattern');
    if (result('match (Some "no") [Some (Int x) -> x,_ -> 42]') !== '42') throw new Error('nested mismatch');
    if (result('(Some [a,b] -> a + b) (Some [1,2])') !== '3') throw new Error('nested list pattern');
});

Deno.test("guards can use nested lambda arguments", () => {
    if (result('match [1,2] [xs | all (n -> n > 0) xs -> 42,_ -> 0]') !== '42') throw new Error('nested lambda in guard');
});

Deno.test("match is intrinsic and has no public attempt protocol", () => {
    const i = new Interpreter();
    if (i.env.get("match")?.kind !== "native") throw new Error("match must be intrinsic");
    for (const name of ["tryMatch", "MatchAttempt", "Matched", "Unmatched"]) {
        if (i.env.get(name)) throw new Error(`unexpected builtin ${name}`);
    }
});

Deno.test("match traverses many rejected alternatives without recursive dispatch", () => {
    if (result('match 1 ((map (n -> (0 -> 0)) [1..10000]) ++ [_ -> 42])') !== '42') throw new Error('dispatch failed');
});

Deno.test("guards accept truthy numbers", () => {
    if (result("match 1 [x | 1 -> 0,_ -> 42]") !== "0") throw new Error("guard did not match");
});
