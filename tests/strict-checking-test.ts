import { requireChecked, checkSource } from "../src/type-checker.ts";
import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";
for (const source of ['std <- import "std"; use std.function', 'env', 'missing', 'load "file"']) {
    Deno.test(`checked execution rejects unknowns: ${source}`, () => {
        try { requireChecked(source); } catch (e) {
            if (String(e).includes('cannot establish static types')) return;
            throw e;
        }
        throw new Error('accepted dynamic boundary');
    });
}
Deno.test('gradual editor analysis remains available', () => {
    const result = checkSource('std <- import "std"; use std.function');
    if (result.issues.length || !result.dynamicBoundaries) throw new Error(JSON.stringify(result));
});
for (const source of ['id x = x; [id 1, id True]', 'loop x = loop x', 'self f = f f; self (x -> 123)', 'x = x']) {
    Deno.test(`checked recursion and inference: ${source}`, () => { requireChecked(source); });
}
Deno.test('inferred arguments are not silently converted without runtime wrappers', () => {
    const source = 'f x = x == 0 ? 1 : x * x; f 1.0';
    if (!checkSource(source, '<test>', {strict: true}).issues.length) throw new Error('inferred Int argument accepted Float');
});

for (const source of ['!missing', '-"hello"', '1 < "hello"']) {
    Deno.test(`strict operators reject invalid or unresolved operands: ${source}`, () => {
        if (!checkSource(source, '<test>', { strict: true }).issues.length) throw new Error('invalid operand escaped checking');
    });
}

for (const source of ['f x = x + 1; f 2', 'f x y = x < y; f 1 2']) {
    Deno.test(`operators infer deferred constraints: ${source}`, () => { requireChecked(source); });
}
for (const source of ['f x = x + 1; f "bad"', 'f x y = x < y; f 1 "bad"']) {
    Deno.test(`inferred operator constraints reject incompatible calls: ${source}`, () => {
        if (!checkSource(source, '<test>', { strict: true }).issues.length) throw new Error('invalid call escaped checking');
    });
}
for (const [source, module] of [['seq 1 2', "function"], ['upper "x"', "text"]]) {
    Deno.test(`standard natives need their module: ${source}`, () => {
        const [issue] = checkSource(source, '<test>', { strict: true, runtimeNames: new Set(["print"]) }).issues;
        if (issue?.message !== `unbound variable '${source.split(" ")[0]}'` || issue.hint !== `add \`std <- import "std"; use std.${module}\` to use \`${source.split(" ")[0]}\``) throw new Error(JSON.stringify(issue));
    });
}
Deno.test("fail is the prelude's", () => {
    const i = new Interpreter();
    i.enableChecking();
    const result = i.renderString(i.run(parse('f x = x > 0 ? x : fail "negative"; f 1')));
    if (result !== "1") throw new Error(result);
});
// A record's pairs keep their keys: each is a String key and a value of one
// of the fields' types, however different those types are.
for (const source of [
    'f o = h (pairs (o : [a : String, l : List [String,String], t : Int]))\nh [] = "none"\nh ([name,_] :: _) = fail name\nf []',
    'r = [a = "x", b = 1, c = [1]]\nmap ([name,_] -> name ++ "!") (pairs r)',
    'r = [a = "x", b = 1, c = [1]]\n[k,v] = head (pairs r)\nk ++ "!"',
]) Deno.test(`record pairs keep String keys: ${source}`, () => {
    const issues = checkSource(source, "<test>", { strict: true }).issues;
    if (issues.length) throw new Error(issues.map(i => i.message).join("; "));
});
// Taking apart a list whose items are known (head and tail, a function of one
// clause doing it as they are defined, a :: pattern) keeps each item's type;
// a typed part takes its item converted, as an argument is.
for (const [source, error] of [
    ['"k" ++ head (head (pairs [a = "x", b = 1, c = [1]]))', ""],
    ['r = [a = "x", b = 1]\n1 + head (tail (head (tail (pairs r))))', ""],
    ['first (x :: _) = x\nr = [a = "x", b = 1]\n"k" ++ first (first (pairs r))', ""],
    ['xs = [1, "a"]\nx :: rest = xs\n[x + 1, "k" ++ head rest]', ""],
    ['1 + head ["a", 1]', "cannot combine Int and String"],
    ['g ((x : Float) :: rest) = x + head rest\ng [1,2] + 0.5', ""],
    ['g ((x : Float) :: _) = x\n"k" ++ g [1,2]', "cannot append String and Float"],
    ['g ((s : String) :: (n : Int) :: _) = s ++ to String n\ng ["a", 2]', ""],
    ['g ((s : String) :: (n : Int) :: _) = s ++ to String n\ng [2, "a"]', "cannot use Int where String is required"],
] as const) Deno.test(`taking apart known items keeps their types: ${source}`, () => {
    const issues = checkSource(source, "<test>", { strict: true }).issues.map(i => i.message).join("; ");
    if (error ? !issues.includes(error) : issues) throw new Error(issues || "accepted");
});
