import { Interpreter, setInterruptFlag, resetInterrupt } from "../src/interp.ts";
import { parse } from "../main.ts";

// Exercise APN source and observable output, without dependencies or runtime mocks.
function execute(source: string): string[] {
    const output: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
    try {
        new Interpreter().run(parse(source));
    } finally {
        console.log = log;
    }
    return output;
}

function example(name: string, source: string, expected: string[]) {
    Deno.test(name, () => {
        const actual = execute(source);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        }
    });
}

function failure(name: string, source: string, message: string) {
    Deno.test(name, () => {
        try {
            execute(source);
        } catch (error) {
            if (error instanceof Error && error.message.includes(message)) return;
            throw error;
        }
        throw new Error(`Expected error containing: ${message}`);
    });
}

example("definitions defer their bodies", `
unused = missing + 1
action = print "unexpected"
print 42
`, ["42"]);

example("separate native calls share memoized value bindings", `
value = (print 2) + 1
print value
print value
`, ["2", "3", "3"]);

example("actions repeat when demanded", `
action = { print "run"; 3 }
print action
print action
`, ["run", "3", "run", "3"]);

example("application and pipe bodies are repeatable actions", `
action = print 3
piped = print $ 4
action
action
piped
piped
`, ["3", "3", "4", "4"]);

example("bare value statements share the cached value", `
value = (print 2) + 1
print value
value
print value
`, ["2", "3", "3"]);

example("unforced values see later bindings in their lexical environment", `
n = 1
value = n + 1
n = 10
print value
`, ["11"]);

example("block bindings shadow their parent scope", `
n = 1
action = { n = 10; n + 1 }
print action
print n
`, ["11", "1"]);

example("unused variable arguments remain unevaluated", `
first x y = x
other = x y -> x
print (first 7 missing)
print (other 8 missing)
`, ["7", "8"]);

example("pattern fallthrough demands a side-effecting argument once", `
choose 0 = 0
choose 1 = 10
choose x = x
print (choose (print 2))
`, ["2", "2"]);

example("ternary evaluates only the selected branch", `
print (true ? 7 : missing)
print (false ? missing : 8)
`, ["7", "8"]);

example("quote and toAST do not evaluate their arguments", `
print (quote missing)
print (toAST (1 + missing))
`, ["missing", '["+", 1, "missing"]']);

example("debug inspects an action without calling its body", `
action = print "unexpected"
debug action
`, ["action"]);

example("finite and infinite ranges support head", `
print (head [3..5])
print (head [3..])
`, ["3", "3"]);

example("head leaves unused list elements deferred",
    "print (head [1, missing])", ["1"]);
example("head leaves unused nested lists deferred",
    "print (head [1, [missing]])", ["1"]);
example("a pattern clause does not demand unrelated variable arguments",
    "first 0 y = 7\nprint (first 0 missing)", ["7"]);
example("mixed arithmetic becomes inexact",
    "print (1 + 2.0)", ["3.0"]);

example("memoized values retain their result after later rebinding", `
n = 1
value = n + 1
print value
n = 10
print value
`, ["2", "2"]);

example("recursive ones produce a finite prefix", `
x = 1:x
print (take 5 x)
print (x 10000)
`, ["[1, 1, 1, 1, 1]", "1"]);

example("the recursive Fibonacci definition is productive", `
fibs = 0 : 1 : zipWith (+) fibs (tail fibs)
print (take 12 fibs)
print (fibs 20)
`, ["[0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89]", "6765"]);

example("mutually recursive lists share productive cells", `
a = 1:b
b = 2:a
print (take 6 a)
`, ["[1, 2, 1, 2, 1, 2]"]);

example("cons does not evaluate unused heads or tails", `
print (head (1:missing))
print (head (tail (missing:2:missing)))
print (take 1 (3:missing))
`, ["1", "2", "[3]"]);

example("take zero and an empty map do not demand unused arguments", `
print (take 0 missing)
print (map missing [])
print (zipWith missing [] missing)
`, ["[]", "[]", "[]"]);

example("map filter zipWith and drop consume infinite ranges incrementally", `
print (take 4 (map (+ 1) [0..]))
print (take 4 (filter (x -> x % 2 == 0) [0..]))
print (take 4 (zipWith (+) [0..] [10..]))
print (take 3 (drop 10000 [0..]))
print (take 3 (tail [5..]))
`, ["[1, 2, 3, 4]", "[0, 2, 4, 6]", "[10, 12, 14, 16]", "[10000, 10001, 10002]", "[6, 7, 8]"]);

example("map delays mapped heads until a consumer needs them", `
print (length (map (x -> missing) [1, 2, 3]))
print (head (map (x -> x) [7, missing]))
`, ["3", "7"]);

example("list elements and function arguments share their effects", `
xs = [print 2, missing]
print (head xs)
print (head xs)
double x = x + x
print (double (print 3))
`, ["2", "2", "2", "3", "6"]);

example("cons and exact-list patterns inspect only needed structure", `
first (x:xs) = x
print (first (8:missing))
print (match [1, missing] [ [x, y] -> x ])
print (match (1:missing) [ [] -> 0, x:xs -> x ])
print (match [1..] [ [x] -> 0, x:xs -> x ])
`, ["8", "1", "1", "1"]);

example("variant fields are lazy", `
Pair a b = | Pair a b
getFirst (Pair a b) = a
print (getFirst (Pair 7 missing))
`, ["7"]);

example("foldr can return without traversing an infinite tail", `
first x rest = x
print (foldr first missing [9..])
print (foldr (+) 0 [1, 2, 3])
print (foldl (+) 0 [1, 2, 3])
`, ["9", "6", "6"]);

example("append is lazy in its right argument", `
print (take 4 ([1..] ++ missing))
print (take 5 ([1, 2] ++ [3..]))
print ([] ++ [1, 2])
print ("a" ++ "b")
`, ["[1, 2, 3, 4]", "[1, 2, 3, 4, 5]", "[1, 2]", "ab"]);

example("positive indexing and length do not evaluate unrelated heads", `
print ([missing, 7, missing] 1)
print (length [missing, missing])
print (null (missing:missing))
print ([1, 2, 3] (-1))
print (map ([1..]) [0, 2, 4])
`, ["7", "2", "false", "3", "[1, 3, 5]"]);

example("equality compares list representations and stops at a mismatch", `
print ((1:2:[]) == [1, 2])
print ([1..3] == [1, 2, 3])
print ((1:missing) == (2:missing))
`, ["true", "true", "false"]);

example("partial applications do not mutate other uses of a function", `
add a b = a + b
plusOne = add 1
plusTwo = add 2
print (plusOne 10)
print (plusTwo 10)
print (zipWith add [1, 2] [10, 20])
`, ["11", "12", "[11, 22]"]);

example("finite formatting still resolves nested list data", `
print (enumerate [10, 20])
proto = [x: 0, y: 0]
print (proto [1, 2])
print (toString [[1 + 1], [3]])
print (format "% %" [1 + 2, [4 + 5]])
`, ["[[0, 10], [1, 20]]", "[x: 1, y: 2]", "[[2], [3]]", "3 [9]"]);

failure("a demanded invalid tail reports a list error",
    "print (take 2 (1:2))", "expected a list");
failure("take rejects negative counts", "print (take (-1) [])", "non-negative int");
failure("drop rejects non-integer counts", "print (drop 1.0 [])", "non-negative int");
failure("head still rejects empty lists", "print (head [])", "head of empty list");
failure("finite indexing still checks bounds", "print ([1, 2] 2)", "out of range");

Deno.test("evaluation errors leave the interpreter usable", () => {
    const interp = new Interpreter();
    interp.run(parse("x = missing + 1"));
    for (let i = 0; i < 250; i++) {
        try { interp.run(parse("x")); }
        catch (error) {
            if (!(error instanceof Error) || !error.message.includes("unbound variable")) throw error;
        }
    }
    const value = interp.run(parse("1 + 2"));
    if (value.kind !== "int" || value.v !== 3n || interp.stack !== 0) {
        throw new Error("evaluation did not recover after failed thunk evaluation");
    }
});

for (const [name, source, prefix] of [
    ["ones", "x = 1:x\nx", "[1, 1, 1, 1"],
    ["Fibonacci", "fibs = 0 : 1 : zipWith (+) fibs (tail fibs)\nfibs", "[0, 1, 1, 2, 3, 5, 8"],
    ["infinite range", "[0..]", "[0, 1, 2, 3"],
]) {
    Deno.test(`${name} rendering streams and recovers after interruption`, () => {
        const interp = new Interpreter();
        const flag = new Int32Array(new SharedArrayBuffer(8));
        setInterruptFlag(flag);
        let output = "";
        let interrupted = false;
        try {
            const value = interp.run(parse(source));
            try {
                interp.render(value, (part) => {
                    output += part;
                    if (output.length > 120) Atomics.store(flag, 0, 1);
                });
            } catch (error) {
                if (!(error instanceof Error) || error.message !== "interrupted") throw error;
                interrupted = true;
            }
            if (!interrupted || !output.startsWith(prefix)) throw new Error(`Unexpected streaming output: ${output}`);
            resetInterrupt();
            const prefixAgain = interp.renderString(interp.takeList(4n, value));
            if (!output.startsWith(prefixAgain.slice(0, -1))) throw new Error("Interrupted stream cannot be read again");
        } finally {
            setInterruptFlag(null);
        }
    });
}

example("a wildcard match does not evaluate its scrutinee",
    "print (match missing [_ -> 7])", ["7"]);

example("cached partial applications can be interleaved and reused", `
add a b = a + b
partials = [add 1, add 2]
print (partials 0 10)
print (partials 1 10)
print (partials 0 20)
`, ["11", "12", "21"]);

example("a recursive function can construct an infinite list", `
numbers n = n : numbers (n + 1)
print (take 5 (numbers 10))
`, ["[10, 11, 12, 13, 14]"]);


failure("a recursive head cannot hide a literal non-list tail",
    "x = x:1\nx", "cons tail expected a list, got int");
failure("computed non-list tails are rejected when consumed",
    "x = 1:(1 + 1)\ntail x", "cons tail expected a list, got int");
failure("nested recursive heads report a rendering error",
    "x = x:(1 + 1)\nprint x", "cannot display a cyclic nested value");
failure("self-containing list literals report a rendering error",
    "x = [x]\nprint x", "cannot display a cyclic nested value");
example("sharing a finite list between siblings is not a rendering cycle",
    "x = [1, 2]\nprint [x, x]", ["[[1, 2], [1, 2]]"]);

example("type declarations construct and match variants", `
Switch = Enabled | Disabled
Wrapped a = | Wrapped a
unwrap (Wrapped x) = x
choose Enabled = 1
choose Disabled = 0
print (unwrap (Wrapped 42))
print (choose Disabled)
print (choose Enabled)
`, ["42", "0", "1"]);
example("data is now an ordinary identifier", 'data = 42; print data', ["42"]);
Deno.test("data no longer introduces a type declaration", () => {
    const program = parse("data Legacy = LegacyValue");
    if (program.some(statement => statement.t === "type")) throw new Error("data remained a declaration keyword");
});

example("type and data are ordinary identifiers", 'type = 20; data = 22; print (type + data)', ["42"]);
example("single constructor declaration preserves destructuring", `
Parcel a = | Parcel a
Parcel contents = Parcel 42
print contents
`, ["42"]);
failure("constructor alternatives require a name", 'InvalidAlternatives = OneAlternative |', "expected a capitalized constructor");

example("multiline constructor declarations allow leading bars", `
MultiChoice a =
    | MultiSome a
    | MultiNone
readMulti (MultiSome x) = x
readMulti MultiNone = 0
print (readMulti (MultiSome 42))
print (readMulti MultiNone)
SingleBar a = | SingleBar a
print (SingleBar 7)
`, ["42", "0", "SingleBar 7"]);


failure("backtick infix syntax is rejected", "1 `add` 2", "unexpected character");
failure("unterminated backtick syntax is rejected", "1 `add", "unexpected character");
example("ordinary named calls replace backtick infix", "add a b = a + b\nprint (add 1 2)", ["3"]);
example("operator precedence and associativity", `
print (2 + 3 * 4)
print ((2 + 3) * 4)
print (10 - 3 - 2)
print (24 / 4 * 2)
print (1 : 2 : [])
print (1 < 2 == true)
print (false ? 1 : true ? 2 : 3)
print ((* 2) $ (+ 1) $ 3)
print (-head [2, 3])
`, ["14", "20", "5", "12", "[1, 2]", "true", "2", "8", "-2"]);
example("minus sections: (10 -) and (-) are sections, (- 2) stays negation", `
print ((10 -) 3)
print ((-) 10 3)
print (foldl (-) 100 [1, 2, 3])
print (map (100 -) [1, 2])
print (- 2)
print (-2)
print (10 - 2)`, ["7", "7", "94", "[99, 98]", "-2", "-2", "8"]);
example("types come from constructor patterns, not annotations", `
f (Int x) = x + 1
h ((Int -> Int) k) = k 2
lam = (Int x) -> x + 1
v = Int 5
print [f 1, h (+ 1), lam 5, v]`, ["[2, 3, 6, 5]"]);
for (const source of ["x: Int = 5", "f x: Int = x", "f (x: Int) = x", "g = (x: Int) -> x", "f x y : Int = x + y", "print { x: Int = 20; x }"]) {
    failure(`':' is not a type annotation: ${source}`, source, "not a type annotation");
}
failure("type signatures are not supported", "f :: Int -> Int\nf x = x", "type signatures are not supported");
example("cons parameters still parse", `
f x:rest = rest
g (x:rest) = rest
one (x:[]) = x
lam = (x:rest) -> rest
print [f [1, 2], g [3, 4], one [5], lam [6, 7]]`, ["[[2], [4], 5, [7]]"]);
example("boolean literal patterns", `
h x = match x [false -> "f", true -> "t"]
f true = 1
f b = 2
print [h false, h true, f true, f false]`, ['["f", "t", 1, 2]']);
