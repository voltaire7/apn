import { Interpreter, setInterruptFlag, resetInterrupt } from "../src/interp.ts";
import { parse } from "../main.ts";
import { runSource } from "../src/repl.ts";

// Exercise APN source and observable output, without dependencies or runtime
// mocks: each source is a file, a block run once.
function execute(source: string): string[] {
    const output: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
    try {
        new Interpreter().run(parse(source), false, true);
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

example("an application's value is kept, as any value is", `
c = Mutable 1
xs = map (x -> x + c) [0]
print xs
set c 5
print xs
`, ["[1]", "[1]"]);
example("an application's plain value is kept, as any value is", `
c = Mutable 1
y = abs c
z = c + 0
print [y,z]
set c $ 5
print [y,z]
`, ["[1,1]", "[1,1]"]);
example("an action runs only where a statement or <- runs it", `
value = { print 2; return 2 }
print "defined"
v <- value
print (v + 1)
`, ["defined", "2", "3"]);

example("actions repeat each time they run", `
action = { print "run"; return 3 }
x <- action
y <- action
print (x + y)
`, ["run", "run", "6"]);

example("application and pipe bodies are repeatable actions", `
action = print 3
piped = print $ 4
action
action
piped
piped
`, ["3", "3", "4", "4"]);

example("a block of bindings and the unit stays a value", `
twice x = { []; y = x * 2; y }
print (twice 3 + 1)
`, ["7"]);

example("a rebinding is a new version: unforced values keep the one they saw", `
n = 1
value = n + 1
n = 10
print value
count = 1
count = count + 1
print count
`, ["2", "2"]);

example("block bindings shadow their parent scope", `
n = 1
action = { n = 10; n + 1 }
print action
print n
`, ["11", "1"]);

example("unused variable arguments remain unevaluated", `
first x y = x
other = x, y -> x
print (first 7 missing)
print (other 8 missing)
`, ["7", "8"]);

example("an action is a value: functions pass it along unrun", `
choose 0 = 0
choose x = x
greet = choose (print 2)
greet
greet
`, ["2", "2"]);

example("ternary evaluates only the selected branch", `
print (True ? 7 : missing)
print (False ? missing : 8)
`, ["7", "8"]);

example("probe shows code as written, unevaluated", `
probe [missing + 1]
`, ["[missing + 1]"]);

example("debug inspects an action without calling its body", `
action = print "unexpected"
debug action
`, ["action"]);

example("finite and infinite ranges support head", `
print (head [3..5])
print (head [3..])
`, ["3", "3"]);

example("head leaves unused list elements deferred",
    "print (head [1,missing])", ["1"]);
example("head leaves unused nested lists deferred",
    "print (head [1,[missing]])", ["1"]);
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
x = 1::x
print (take 5 x)
print (x 10000)
`, ["[1,1,1,1,1]", "1"]);

example("the recursive Fibonacci definition is productive", `
fibs = 0 :: 1 :: zipWith (+) fibs (tail fibs)
print (take 12 fibs)
print (fibs 20)
`, ["[0,1,1,2,3,5,8,13,21,34,55,89]", "6765"]);

example("mutually recursive lists share productive cells", `
a = 1::b
b = 2::a
print (take 6 a)
`, ["[1,2,1,2,1,2]"]);

example("cons does not evaluate unused heads or tails", `
print (head (1::missing))
print (head (tail (missing::2::missing)))
print (take 1 (3::missing))
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
`, ["[1,2,3,4]", "[0,2,4,6]", "[10,12,14,16]", "[10000,10001,10002]", "[6,7,8]"]);

example("map delays mapped heads until a consumer needs them", `
print (length (map (x -> missing) [1,2,3]))
print (head (map (x -> x) [7,missing]))
`, ["3", "7"]);

example("lists hold actions; running one runs only it", `
xs = [print 2, missing]
head xs
head xs
double x = x + x
v <- { print 3; return 3 }
print (double v)
`, ["2", "2", "3", "6"]);

example("cons and exact-list patterns inspect only needed structure", `
first (x::xs) = x
print (first (8::missing))
print ([1,missing] ~ [[x,y] -> x])
print (1::missing ~ [[] -> 0, x::xs -> x])
print ([1..] ~ [[x] -> 0, x::xs -> x])
`, ["8", "1", "1", "1"]);

example("variant fields are lazy", `
Pair a b = | Pair a b
getFirst (Pair a b) = a
print (getFirst (Pair 7 missing))
`, ["7"]);

example("foldr can return without traversing an infinite tail", `
first x rest = x
print (foldr first missing [9..])
print (foldr (+) 0 [1,2,3])
print (foldl (+) 0 [1,2,3])
`, ["9", "6", "6"]);

example("append is lazy in its right argument", `
print (take 4 ([1..] ++ missing))
print (take 5 ([1,2] ++ [3..]))
print ([] ++ [1,2])
print ("a" ++ "b")
`, ["[1,2,3,4]", "[1,2,3,4,5]", "[1,2]", "ab"]);

example("positive indexing and length do not evaluate unrelated heads", `
print ([missing,7,missing] 1)
print (length [missing,missing])
print (null (missing::missing))
print ([1,2,3] -1)
print (map [1..] [0,2,4])
`, ["7", "2", "False", "3", "[1,3,5]"]);

example("equality compares list representations and stops at a mismatch", `
print (1::2::[] == [1,2])
print ([1..3] == [1,2,3])
print (1::missing == 2::missing)
`, ["True", "True", "False"]);

example("partial applications do not mutate other uses of a function", `
add a b = a + b
plusOne = add 1
plusTwo = add 2
print (plusOne 10)
print (plusTwo 10)
print (zipWith add [1,2] [10,20])
`, ["11", "12", "[11,22]"]);

example("finite formatting still resolves nested list data", `
print (enumerate [10,20])
proto = [x = 0, y = 0]
print (proto [x = 1, y = 2])
print (to String [[1 + 1], [3]])
print (format "% %" [1 + 2, [4 + 5]])
`, ["[[0,10],[1,20]]", "[x = 1, y = 2]", "[[2],[3]]", "3 [9]"]);

failure("a demanded invalid tail reports a list error",
    "print (take 2 (1::2))", "expected a list");
example("cons patterns bind at statement level", `
x::xs = [1,2,3,4]
print [x,xs]
a::b::rest = [5,6,7]
print [a,b,rest]
h::t <- return [8,9]
print t
`, ["[1,[2,3,4]]", "[5,6,[7]]", "[9]"]);
failure("take rejects negative counts", "print (take -1 [])", "non-negative int");
failure("drop rejects non-integer counts", "print (drop 1.0 [])", "non-negative int");
failure("head still rejects empty lists", "print (head [])", "head of empty list");
failure("finite indexing still checks bounds", "print ([1,2] 2)", "out of range");

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
    ["ones", "x = 1::x\nx", "[1,1,1,1"],
    ["Fibonacci", "fibs = 0 :: 1 :: zipWith (+) fibs (tail fibs)\nfibs", "[0,1,1,2,3,5,8"],
    ["infinite range", "[0..]", "[0,1,2,3"],
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
    "print (missing ~ [_ -> 7])", ["7"]);

example("cached partial applications can be interleaved and reused", `
add a b = a + b
partials = [add 1, add 2]
print (partials 0 10)
print (partials 1 10)
print (partials 0 20)
`, ["11", "12", "21"]);

example("a recursive function can construct an infinite list", `
numbers n = n :: numbers (n + 1)
print (take 5 (numbers 10))
`, ["[10,11,12,13,14]"]);


failure("a recursive head cannot hide a literal non-list tail",
    "x = x::1\nx", "cons tail expected a list, got int");
failure("computed non-list tails are rejected when consumed",
    "x = 1::1 + 1\ntail x", "cons tail expected a list, got int");
failure("nested recursive heads report a rendering error",
    "x = x::1 + 1\nprint x", "cannot display a cyclic nested value");
failure("self-containing list literals report a rendering error",
    "x = [x]\nprint x", "cannot display a cyclic nested value");
example("sharing a finite list between siblings is not a rendering cycle",
    "x = [1,2]\nprint [x,x]", ["[[1,2],[1,2]]"]);

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
failure("constructor alternatives require a name", 'InvalidAlternatives = OneAlternative |', "expected a constructor: a capitalized name, [] or x :: rest");

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


failure("a backticked name is a name, not infix", "1 `add` 2", "cannot apply a number");
failure("an unterminated backticked name is rejected", "1 `add", "ends on its line");
example("ordinary named calls replace backtick infix", "add a b = a + b\nprint (add 1 2)", ["3"]);
example("operator precedence and associativity", `
print (2 + 3 * 4)
print ((2 + 3) * 4)
print (10 - 3 - 2)
print (24 / 4 * 2)
print (1 :: 2 :: [])
print (1 < 2 == True)
print (False ? 1 : (True ? 2 : 3))
print ((* 2) $ (+ 1) $ 3)
print (-head [2,3])
`, ["14", "20", "5", "12", "[1,2]", "True", "2", "8", "-2"]);
// v n = [key,value] writes entry n as v n reads it.
example("a record's entry is written by position as a pair", `
v = [x = 1, y = 2, z = 3]
v 0 = ["x1",22]
print v
v -1 = ["z",30]
print [v 0, v -1]`, ["[x1 = 22, y = 2, z = 3]", '[["x1",22],["z",30]]']);
failure("a record's entry is a pair", "v = [x = 1]\nv 0 = [x1 = 22]", "an entry is a [key,value] pair");
failure("a record's entry keeps keys distinct", 'v = [x = 1, y = 2]\nv 0 = ["y",22]', "the record already has a field 'y'");
example("a list item may be a binding, in scope for the items after it", `
print [x = 1, x + 1]
print (do [x = 1, x + 1])
print [f n = n * 2, f 3]
print [[a,b] = [1,2], a + b]
x = 7
print [x + 1, x = 1, x]
print x
probe [x = 1, x + 1]`, ["[2]", "2", "[6]", "[3]", "[8,1]", "7",
    "[x = 1, x + 1]"]);
// x <- m is a list item as a block's statement: do runs m and binds x for the
// items after it, in any monad; it yields nothing, and x is bound only then.
example("an x <- m item binds when do runs the code", `
print (do [x <- [1,2], y <- [10,20], return (x + y)])
code = [n <- return 5, z = n * 2, print z]
do code
probe code
vw <- do [v <- return 1, w <- return (v + 1), return [v,w]]
print vw
print [x <- [1,2,3], return x]
print (reduce [x <- [1,2], y <- [10], return (x + y)])
print (length [x <- [1,2], return x])
print [x <- return 1, return x]`, ["[11,21,12,22]", "10", "[n <- return 5, z = n * 2, print z]", "[1,2]",
    "[[1,2,3]]", "[[11,12]]", "2", "[1]"]);
failure("an x <- m item's name is bound only when the code runs", "[x <- return 1, x] 1", "'x' is bound when the code runs");
example("minus sections: (10 -), (- 2) and (-) are sections, (-2) a negation", `
print ((10 -) 3)
print ((-) 10 3)
print (foldl (-) 100 [1,2,3])
print (map (100 -) [1,2])
print ((- 2) 10)
print -2
print (10 - 2)`, ["7", "7", "94", "[99,98]", "8", "-2", "8"]);
example("types come from constructor patterns, not annotations", `
f (x : Int) = x + 1
h (k : Int -> Int) = k 2
lam = (x : Int) -> x + 1
v = 5 : Int
print [f 1, h (+ 1), lam 5, v]`, ["[2,3,6,5]"]);
// A declaration or ascription spaces its ':', and a definition's type is
// declared on a line of its own.
for (const source of ["x: Int = 5", "f x: Int = x", "f (x: Int) = x", "g = (x: Int) -> x", "print { x: Int = 20; x }"]) {
    failure(`an unspaced ':' is no declaration: ${source}`, source, "spaces its ':'");
}
failure("a definition's type is declared on its own line", "f x y : Int = x + y", "declare f's type on a line of its own");
failure("a clause takes no more parameters than declared", "f : Int -> Int\nf a b = a\nprint 1", "declared with 1 parameter");
failure("an ascribed ternary is parenthesized", "x = True ? 1 : 2 : Int\nprint x", "parenthesize a ternary");
failure("a declared result is proved per clause", "app : Vect n a -> Vect m a -> Vect (n + m + 1) a\n" +
    "app [] ys = ys\napp (x :: xs) ys = x :: app xs ys\nprint (app [1] [2])", "length mismatch");
failure("':' is not cons", "print (1 : [2])", "cons is '::'");
// A type is given a value only ascribed (e : T), and a typed pattern writes
// its type after the value ((x : Int)); the old spellings are errors.
for (const source of ["print (Int 5)", "print (Dynamic 1)", "print (Int $ 1.0)", "print (List [1])",
        "f t = t 1\nprint (f Int)", "std <- import \"std\"; use std.option\nprint (Option Int None)"]) {
    failure(`a type is not a function: ${source}`, source, "is a type, not a function");
}
for (const source of ["f (Int x) = x\nprint (f 1)", "f ((Int) x) = x\nprint 1", "f (t x) = t\nprint 1",
        "g = (Int x) -> x\nprint (g 1)", "f (Vect n a xs) = n\nprint (f [1])"]) {
    failure(`a typed pattern writes its type after the value: ${source}`, source, "writes its type after the value");
}
example("types that construct, and typed patterns of any parameters", `
m = HashMap [["a",1]]
c = Mutable 0
f (xs : List _) = length xs
g { x : Int } = x + 1
print [m "a", f [1,2], g 2, (2.0 : Int), to Int 3.0]`, ["[1,2,3,2,3]"]);
example("cons parameters parse", `
f (x::rest) = rest
g (x :: rest) = rest
one (x::[]) = x
lam = x::rest -> rest
print [f [1,2], g [3,4], one [5], lam [6,7]]`, ["[[2],[4],5,[7]]"]);
example("boolean literal patterns", `
h x = x ~ [False -> "f", True -> "t"]
f True = 1
f b = 2
print [h False, h True, f True, f False]`, ['["f","t",1,2]']);
example("character and float literal patterns", `
f 'a' = "letter a"
f 1.5 = "one and a half"
f 2.0 = "two"
f x = "other"
print [f 'a', f 'b', f 1.5, f 2, f 2.0, f 7]
print ('z' ~ ['a' -> 1, 'z' -> 2, _ -> 3])`, ['["letter a","other","one and a half","two","two","other"]', "2"]);

// A literal on the left of '=' is a pattern, as inside one; a failed match
// is an error (before the run, when checking knows the value).
example("literal pattern bindings", `
1 = 1
"x" = "x"
[a,1] = [5,1]
print a`, ["5"]);
for (const source of ["1 = 2", "[a,1] = [5,2]", 'std <- import "std"; use std.option\nNone = Some 1']) {
    failure(`a binding that does not match: ${source}`, source, "binding pattern did not match its value");
}

example("a record its type made keeps its fields; a copy takes new ones", `
Quote = [quote : String, year : Int]
q = [] : Quote
q.year = 3
q "quote" = "x"
print q
r = [use q, more = 1]
r.again = 2
print r
Line = [from : [x : Int, y : Int], to : [x : Int, y : Int]]
l = [] : Line
l.from.x = 4
print l`, ['[quote = "x", year = 3]', '[quote = "x", year = 3, more = 1, again = 2]', "[from = [x = 4, y = 0], to = [x = 0, y = 0]]"]);
for (const source of [
    "q = [] : Quote\nq.yaer = 1", 'q = ["a",1] : Quote\nq "yaer" = 1', "q = [] : Quote\nq._ = [yaer = 1]",
    "f (q : Quote) = { q.yaer = 1; q }\nprint (f [quote = \"a\", year = 1])",
    "Line = [from : Quote, to : Quote]\nl = [] : Line\nl.from.yaer = 1",
]) failure(`a new field on a record its type made: ${source}`, `Quote = [quote : String, year : Int]\n${source}`, "has no field 'yaer'");

example("an empty vector's open element type is bound by an inner lambda's pattern", `
f = (xs : Vect n a) -> (ys : Vect m a) -> [n,m,a]
print (f [] [3])
print (f [] [])`, ["[0,1,Int]", "[0,0,a]"]);

example("iterating a string passes its characters", `
"hé" * print
print (print * "")`, ["'h'", "'é'", "[]"]);

// More clauses are a new version: label keeps the clauses of describe it saw.
for (const source of [
    'describe 0 = "zero"\nlabel x = describe x\ndescribe 1 = "one"\nprint (label 1)',
    'h = {\n    describe 0 = "zero"\n    label x = describe x\n    describe 1 = "one"\n    label 1\n}\nprint h',
]) failure(`a function keeps the clauses it saw: ${source}`, source, "no clause of 'describe' matches");
example("a definition's parameters read as arguments", `
std <- import "std"; use std.option
f Int x = x
g x Float = x
to Option (Ok x) = Some x
print [f Int 3, g 2 Float]
print (to Option (Ok 1))`, ["[3,2]", "Some 1"]);
example("a list is code: ++ joins it and an update replaces an item", `
code = [x = 1] ++ [x + 1]
probe code
print code
edited = [x = 1, x + 1] ++ [5]
edited 0 = (x = 10)
print edited
probe edited
edited 1 = x * 3
print edited
y = 100
print ([y = 1] ++ [y + 1])
probe (take 1 edited ++ [x * 5])
print (take 1 edited ++ [x * 5])
cycle xs = xs ++ cycle xs
print (take 5 (cycle [1,2]))
probe (reduce [1 + 1])
print (length edited)`, ["[x = 1, x + 1]", "[2]", "[11,5]", "[x = 10, x + 1, 5]", "[30,5]", "[2]",
    "[x = 10, x * 5]", "[50]", "[1,2,1,2,1]", "[2]", "3"]);
failure("an open list's values need its names", "print [x + 1]", "unbound variable 'x'");
// A list of definition heads = a list of bodies defines each by its own.
example("[f x, g y] = [x, y] defines f and g", `
[f x, g y] = [x, y]
print [f 1, g 2]
[a, h n] = [10, n * a]
print (h 3)
k = {
    [p x, q y] = [x + 1, y * 2]
    p 1 + q 2
}
print k`, ["[1,2]", "30", "6"]);
failure("a list of definitions takes a list of bodies", "pair = [1,2]\n[f x, g y] = pair", "write a list of 2 bodies");
// Code's bindings are its fields: code.x reads the last binding of x, and
// code.x = v replaces it, the items after it seeing the new x.
example("code.x reads a binding and code.x = v replaces it", `
code = [x = 1, x + 1]
print code.x
code.x = 10
probe code
print code
joined = [x = 1] ++ [y = x * 2, y + 1]
print [joined.x,joined.y]
r = [c = [n = 3, n * n]]
r.c.n = 4
print r.c
twice = [x = 1, x = x + 1, x]
print twice.x
print [Int].[1]`, ["1", "[x = 10, x + 1]", "[11]", "[1,2]", "[16]", "2", "[1]"]);
failure("an x <- m item binds when the code runs", "w = [x <- [1,2], return (x * 10)]\nprint w.x",
    "only when it runs");
failure("a binding by a pattern is replaced as an item", "pc = [[a,b] = [3,4], a + b]\npc.a = 9",
    "replace the item");
example("List a = [] | a :: List a: each element an a, endless lists too", `
print [isType (List Int) [], isType (List Int) [1,2], isType (List Int) [1,"a"]]
ones = 1 :: ones
print [isType (List Int) [1..], isType (List Int) ones, isType (List String) ones]
print [isType (List Int) (0 :: [1..]), List Int == [Int], isType (List Int) 5]
Seq a = [] | a :: Seq a
print [Seq Int == List Int, isType (Seq Int) [1,2]]`, ["[True,True,False]", "[True,True,False]",
    "[True,False,False]", "[True,True]"]);
example("types compare as the sets of their values", `
U = (Int | String)
V = (String | Int)
print [U == V, Int <= Number, Number <= Int, Int < Number, Integer <= Real]
print [typeOf [1,2,3] <= List Int, typeOf [1,"a"] <= List Int, List Int <= typeOf [1,2]]
print [[Int..] <= List Int, List Int == typeOf [1,2,3], List Int == [Int]]
Seq a = [] | a :: Seq a
E = [] | Int :: List Int
print [Seq Int == List Int, E == List Int, List Int <= List Number, List Number <= List Int]
Pairs a = [] | a :: a :: Pairs a
print [Pairs Int <= List Int, List Int <= Pairs Int, Pairs Int < List Int]
Two = [Int] | [Int,Int]
print [[Int,Int] <= Two, [Int,Int,Int] <= Two, Two <= List Int]`, ["[True,True,False,True,True]",
    "[True,False,False]", "[True,False,False]", "[True,True,True,False]", "[True,False,True]",
    "[True,False,True]"]);
example("a type pattern matches each type within the one it names", `
print (typeOf [1,2,3] ~ [List Int -> "ints", _ -> "other"])
print (typeOf [1,"a"] ~ [List Int -> "ints", _ -> "other"])
describe Int = "int"
describe Number = "number"
print [describe Int, describe Float, describe Number]
print (typeOf [1] ~ [List -> "list", _ -> "other"])
Pairs a = [] | a :: a :: Pairs a
print (typeOf [1,2] ~ [Pairs Int -> "pairs", _ -> "other"])
IS = (Int | String)
print [typeOf "s" ~ [IS -> "either", _ -> "other"], typeOf 1.5 ~ [IS -> "either", _ -> "other"]]`,
    ["ints", "other", '["int","number","number"]', "list", "pairs", '["either","other"]']);
example("a union in parentheses matches a value of one of its types", `
f (x : Int | String) = x
f _ = "no"
print [f 1, f "a", f 1.5]
kind x = x ~ [(Int | String) -> "either", _ -> "other"]
print [kind 1, kind "a", kind 1.5, typeOf "a" ~ [(Int | String) -> "either", _ -> "other"]]
g (Int | String) = "either"
g _ = "other"
print [g 1, g 1.5]
print g`, ['[1,"a","no"]', '["either","either","other","other"]', '["either","other"]',
    '(Int | String) -> "either"\n_ -> "other"']);
example("| is the union of types, written anywhere", `
print (Int | String)
print [isType (Int | String) "a", (Int | String) == (String | Int)]
print (typeOf [1,2,3] <= ([Int] | [Int,Int] | [Int,Int,Int]))
print (([] | Int :: List Int) == List Int)
f = x | x > 0 -> x
print (f 5)`, ["Int | String", "[True,True]", "True", "True", "5"]);
failure("operators of one level and two associativities need parentheses", "print ([Int] | [Int,Int] == typeOf [1])", "share a level but not an associativity");
example("a union of list types unfolds as a value is read", `
Pairs a = [] | a :: a :: Pairs a
print [isType (Pairs Int) [1,2], isType (Pairs Int) [1,2,3], isType (Pairs Int) [1,"a"]]
ones = 1 :: ones
print [isType (Pairs Int) ones, isType (Pairs Int) [1..], isType (Pairs String) [1..]]
print [Pairs Int == Pairs Int, Pairs Int == Pairs String]
f (xs : Pairs Int) = length xs
print (f [1,2,3,4])
Ints = [] | Int :: Ints
print [isType Ints [1,2], isType Ints ["a"]]
Tree = [] | Tree :: Tree
print [isType Tree [[],[[]]], isType Tree [1]]`, ["[True,False,False]", "[True,True,False]",
    "[True,False]", "4", "[True,False]", "[True,False]"]);
example("a list's bindings name its items", `
code = [x = 1, y = 2, x + y]
before = code
code 0 = (x = 10)
print [before,code]
print (do code)
code [1,2] = [5,0]
print code
f k = { c = [a = 1, a * 2]; c 0 = (a = k); c 1 }
print (f 4)`, ["[[3],[12]]", "12", "[5,0]", "8"]);
example("a typed pattern headed by a free name takes a type apart", `
(t1 1 t2 -> print [t1,t2]) (Vect 1 Int)
(t1 n t2 -> print [t1,n,t2]) (Vect 3 Float)
print (Vect 1 Int ~ [t1 2 t2 -> "two", t1 1 t2 -> "one"])
shape (t1 1 t2) = [t1,t2]
parts (Vect n a) = [n,a]
print [shape (Vect 1 Int), parts (Vect 3 Float)]
print [typeOf shape, typeOf parts]`, ["[Vect,Int]", "[Vect,3,Float]", "one", "[[Vect,Int],[3,Float]]", "[Type -> [Type,a], Type -> [Int,Type]]"]);

// A file is a block, run once: the same statement rules, and a block holds
// everything a file does, its types declared for it alone.
example("a block ending in a binding is followed by {}: it yields []",
    "a = {\n    print 1\n    y = 5\n}\nx <- a\nprint [x, { y = 1 }]", ["1", "[[],[]]"]);
example("a file may end in a binding after its actions",
    "print 1\nx = 5", ["1"]);
failure("a file's statement that binds nothing is an action, as a block's",
    "1 + 1\nprint 2", "its value would be dropped");
failure("a file that ran an action ends in one, as a do-block does",
    "print 1\n5", "its value would be dropped");
example("a block declares types as a file does",
    "f n = {\n    Color = Red | Green\n    n > 0 ? Red : Green\n}\nBox a = _\nb = {\n    Pair a b = _\n    Pair 1 2\n}\nprint [f 1, f 0]\nprint b", ["[Red,Green]", "Pair 1 2"]);
failure("a block's types are its own",
    "f = {\n    Color = Red | Green\n    Red\n}\nprint Red", "unbound variable 'Red'");

// The tour and the former feature showcase (a regression program) check and
// run as whole programs.
for (const path of ["../examples/features.apn", "fixtures/showcase.apn"]) Deno.test(`program runs: ${path}`, () => {
    const url = new URL(path, import.meta.url), i = new Interpreter();
    i.enableChecking();
    i.sourceDir = new URL(".", url).pathname;
    i.sourceFile = url.pathname;
    const [log, write] = [console.log, Deno.stdout.writeSync];
    console.log = () => {};
    Deno.stdout.writeSync = (data: Uint8Array) => data.length;
    try { runSource(Deno.readTextFileSync(url), i, true, true); }
    finally { [console.log, Deno.stdout.writeSync] = [log, write]; }
});
