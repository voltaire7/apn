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
    // Through a parameter: a name given items of different types is typed for them.
    ['f p = "k" ++ head p\nf ["a", 1]', ""],
    ['f p = "k" ++ head p\nf [1, "a"]', "cannot append String and Int"],
    ['f p q = head p ++ q\nf ["a", 1] "!"', ""],
    ['f r = "k" ++ head (head (pairs r))\nf [a = "x", b = 1]', ""],
    ['f r = 1 + head (tail (head (tail (pairs r))))\nf [a = "x", b = 1]', ""],
    // A later argument too, also through a partial application kept as a value.
    ['g p q = p ++ head q\ng "!" ["a", 1]', ""],
    ['g p q = p ++ head q\ng "!" [1, "a"]', "cannot append String and Int"],
    ['g k r = k ++ head (head (pairs r))\ng "k" [a = "x", b = 1]', ""],
    ['g p q r = p ++ head q ++ head (tail r)\nh = g "!" ["a", 1]\nh [2, "b"]', ""],
    ['g p q r = p ++ head q ++ head (tail r)\nh = g "!"\nh ["a", 1] ["b", 2]', "cannot append String and Int"],
    ['f p q = head p ++ q\nmap (f ["a", 1]) ["!"]', ""],
    // A function of several clauses, as the run dispatches it.
    ['f [] = ""\nf (x :: _) = "k" ++ x\nf ["a", 1]', ""],
    ['f [] = ""\nf (x :: _) = "k" ++ x\nf [1, "a"]', "cannot append String and Int"],
    ['g 0 p = ""\ng n p = head p ++ "!"\ng 1 ["a", 1]', ""],
    ['g 0 p = ""\ng n p = head p ++ "!"\ng 1 [1, "a"]', "cannot append Int and String"],
    ['g 0 p = ""\ng n p = head p ++ "!"\nh = g 1\nh ["a", 1]', ""],
    ['k [] = ""\nk ([a,b] :: _) = a ++ "!"\nk (pairs [x = 1, y = "s"])', ""],
    // Typed parts too, each checking its known value as a call does.
    ['g [] = 0.0\ng ((x : Float) :: rest) = x\n"k" ++ g [1, "a"]', "cannot append String and Float"],
    ['g [] = ""\ng ((s : String) :: (n : Int) :: _) = s ++ to String n\ng ["a", 2]', ""],
    ['g [(a : UInt8), (b : String)] = to String a ++ b\ng [3, "x"]', ""],
    ['g [(a : UInt8), (b : String)] = a\ng [300, "x"]', "value out of range for UInt8"],
    ['g [(a : UInt8), (b : String)] = a\ng _ = 0\ng [300, "x"]', ""],
    // A failed typed call is the call's error: where a clause that certainly
    // takes the arguments fails, or every one that may; one the run may pass
    // over (its guard, or a value the run decides) is left out.
    ['f p | length p > 5 = "long"\nf p = head p ++ "!"\nf [1, "a"]', "cannot append Int and String"],
    ['f p | length p > 5 = "long"\nf p = head p ++ "!"\nf ["a", 1]', ""],
    ['f p | isType Int (head p) = head p + 1\nf p = 0\nf ["a", 1]', ""],
    ['g 0 p = head p + 1\ng n p = ""\nh n = g n ["a", 1]\nh 1', ""],
    ['g 0 p = head p + 1\ng n p = head p + 2\nh n = g n ["a", 1]\nh 1', "cannot combine"],
] as const) Deno.test(`taking apart known items keeps their types: ${source}`, () => {
    const issues = checkSource(source, "<test>", { strict: true }).issues.map(i => i.message).join("; ");
    if (error ? !issues.includes(error) : issues) throw new Error(issues || "accepted");
});
// Typing a call for its arguments past the step bound is an error; items of
// one type (List Dynamic) leave them to the run. A recursive call given new
// types is typed for them too: one that takes its list apart ends, exactly
// typed; one whose list grows (p ++ p) reaches the bound. A length it leaves
// unknown is rejected as any other. Code a known condition passes over is
// typed and bounded so too, its recursive calls typed for their arguments.
{
    const body = ["g p = [", ...Array.from({ length: 600 }, () => "    " + Array(4).fill('head p ++ "!"').join(", ")), "]"].join("\n");
    Deno.test("a typed call past the step bound is an error", () => {
        const issues = checkSource(`${body}\ng ["a", 1]`, "<test>", { strict: true }).issues.map(i => i.message).join("; ");
        if (!issues.includes("takes more than 20000 steps")) throw new Error(issues || "accepted");
    });
    Deno.test("a typed call past the step bound in code that never runs is an error", () => {
        const issues = checkSource(`${body}\ny = False ? g ["a", 1] : []\ny`, "<test>", { strict: true }).issues.map(i => i.message).join("; ");
        if (!issues.includes("takes more than 20000 steps")) throw new Error(issues || "accepted");
    });
    Deno.test("items of one type leave a costly call to the run", () => {
        const issues = checkSource(`${body}\ng (["a", 1] : List Dynamic)`, "<test>", { strict: true }).issues;
        if (issues.length) throw new Error(issues.map(i => i.message).join("; "));
    });
}
for (const [source, error] of [
    // A known value decides a conditional, so the recursion follows it: the
    // list doubles eleven times, then n is 0, past which the branch that
    // never runs ends too; with n not known it never ends, nor past n == 0.
    ['f p n = n <= 0 ? head p : f (p ++ p) (n - 1)\nf ["a", 1] 11', ""],
    ['f p n = n <= 0 ? head p : f (p ++ p) (n - 1)\ng n = f ["a", 1] n\ng 3', "takes more than 20000 steps"],
    ['f p n = n == 0 ? head p : f (p ++ p) (n - 1)\nf ["a", 1] 11', "code that never runs"],
    ['f p n = n <= 0 ? head p : f (p ++ p) (n - 1)\nx = True ? "k" : f ["a", 1] 5\nprint x', ""],
    ['g [] = ""\ng (x :: rest) = x ++ g rest\nf p = g p\nf ["a", 1]', "cannot append Int and String"],
    ['g [] = ""\ng (x :: rest) = x ++ g rest\nf p = g p\nf ["a","b"]', ""],
    ['step [x,y] = [y,x]\nf (p : Vect 2 _) n = n == 0 ? "k" ++ head p : f (step p) (n - 1)\nf ["a", 1] 4', ""],
    ['step [x,y] = [y,x]\nf (p : Vect 2 _) n = n == 0 ? "k" ++ head p : f (step p) (n - 1)\nf ["a", 1] 3', "cannot append String and Int"],
    ['g 0 p = head p + 1\ng n p = ""\ng 0 ["a", 1]', "cannot combine"],
    ['g 0 p = head p + 1\ng n p = ""\ng 1 ["a", 1]', ""],
    // A known list's items and a known record's fields decide them too.
    ['f p = length p == 3 ? "k" ++ head p : "none"\nf [1, "a"]', ""],
    ['f p = length p == 2 ? "k" ++ head p : "none"\nf [1, "a"]', "cannot append String and Int"],
    ['f r = r.on ? "k" ++ r.name : "off"\nf [on = False, name = 1]', ""],
    ['f r = r.on ? "k" ++ r.name : "off"\nf [on = True, name = 1]', "cannot append String and Int"],
    // And a known function's results.
    ['f g p = g 1 > 0 ? "k" ++ head p : "none"\nf (x -> x - 5) [1, "a"]', ""],
    ['f g p = g 1 > 0 ? "k" ++ head p : "none"\nf (x -> x + 5) [1, "a"]', "cannot append String and Int"],
    ['neg x = 0 - x\nf g p = g 1 > 0 ? "k" ++ head p : "none"\nf neg [1, "a"]', ""],
    ['f p g = g p ? "k" ++ head p : "none"\nf [1, "a"] (xs -> length xs > 5)', ""],
    // Equality between values of different kinds is False, as at runtime; records
    // compare by their fields, in any order.
    ['f g p = g (head p) ? "k" ++ head p : "none"\nf (x -> x == "a") [1, "a"]', ""],
    ['f g p = g (head p) ? "k" ++ head p : "none"\nf (x -> x != "a") [1, "a"]', "cannot append String and Int"],
    ['f r = r == [a = 1] ? "k" ++ r.a : "none"\nf [b = "x", a = 1]', ""],
    ['f r = r == [a = 1, b = "x"] ? "k" ++ r.a : "none"\nf [b = "x", a = 1]', "cannot append String and Int"],
    // An empty list is an item of its own type beside others.
    ['f p = head p == "" ? "k" ++ head p : "none"\nf [[], "a"]', ""],
    ['f p = "k" ++ head (tail p)\nf [[], "a"]', ""],
    ['f r = null r.xs ? "none" : "k" ++ head r.xs\nf [xs = [], n = 1]', ""],
    // Inside a typed call, a list known empty has no first item to take, and a
    // && or || its left side decides does not run its right.
    ['f p = head (head p)\nf [[], "a"]', "length mismatch: expected at least 1, got 0"],
    ['f r = 1 + head r.xs\nf [xs = [], n = "a"]', "length mismatch: expected at least 1, got 0"],
    ['f r = null r.xs ? 0 : head r.xs\nf [xs = [], n = "a"]', ""],
    ['f p = length (head p) == 0 || head (head p) > 1\nf [[], "a"]', ""],
    ['f p = True && head (head p)\nf [[], "a"]', "length mismatch"],
    // Outside one too: an empty list is known empty, and a known condition,
    // && or || takes its side, the other typed only where it can be.
    ['head []', "length mismatch: expected at least 1, got 0"],
    ['xs = []\nhead xs', "length mismatch: expected at least 1, got 0"],
    ['xs = []\nnull xs ? 0 : head xs', ""],
    ['False ? head [] : 0', ""],
    ['print (False && head [])\nprint (True || head [])', ""],
    ['x = True ? 1 : "a"\nx + 1', ""],
    // A trial evaluates what is known as anywhere: the dead branch's own guard
    // decides its head xs.
    ['xs = []\ny = True ? 0 : (null xs ? 1 : head xs)\ny + 1', ""],
    // Its calls are typed for their arguments: one that fails leaves it out.
    ['g p = "k" ++ head p\ny = True ? g ["a", 1] : g [1, "a"]\ny ++ "!"', ""],
    // Calls a function decided are told apart by it.
    ['f g p = g 1 > 0 ? "k" ++ head p : "none"\n[f (x -> x - 5) [1, "a"], f (x -> x + 5) [1, "a"]]', "cannot append String and Int"],
    // A length a typed call cannot find is unknown, as anywhere: rejected.
    ['f [a,b] = a\ng p = f (filter (x -> True) p)\ng [1, "a"]', "cannot establish static types"],
] as const) Deno.test(`a recursive typed call ends: ${source}`, () => {
    const issues = checkSource(source, "<test>", { strict: true }).issues.map(i => i.message).join("; ");
    if (error ? !issues.includes(error) : issues) throw new Error(issues || "accepted");
});
