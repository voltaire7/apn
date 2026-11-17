import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";
import { CheckingSession } from "../src/checking-session.ts";

function session(): Interpreter {
    const i = new Interpreter();
   
    i.enableChecking();
    return i;
}
function run(i: Interpreter, source: string): string {
    return i.renderString(i.run(parse(source)));
}
// A take written in APN, and a function of a two-item list.
const TK2 = "tk2 0 _ = []; tk2 _ [] = []; tk2 n (x :: rest) = x :: tk2 (n - 1) rest; f [a,b] = a\n";
// A left fold written in APN, and a function of a two-item list.
const FL = "fl f acc [] = acc; fl f acc (x :: rest) = fl f (f acc x) rest; g [a,b] = a + b\n";
function rejected(i: Interpreter, source: string): void {
    try { run(i, source); } catch (error) {
        if ((error as { kind?: string }).kind === "type") return;
        throw error;
    }
    throw new Error(`accepted: ${source}`);
}
for (const [source, expected] of [
    ['std <- import "std"; use std.sequence; sum [1,2,3]', '6'],
    ['seqs <- import "std/sequence"; seqs.sum (to Int * [1,2,3])', '6'],
    ['std <- import "std"; use std.[function,number]; id (sq 3)', '9'],
    ['ns = [double = x -> x * 2]; use ns; double 3', '6'],
    ['use [[one = 1], [two = 2]]; one + two', '3'],
    ['x = Mutable 1; set x 2; x + 1', '3'],
    ['Direction = North | South; [10,20] South', '20'],
    ['templates = [String,Int]; values = ["x", 1]; (values : templates)', '["x", 1]'],
    ['xs = [1]; xs = [2,3]; xs', '[2,3]'],
    // A union of this shape is the list type, as the prelude's List is.
    ['Seq a = [] | a :: Seq a; f (xs : Seq Int) = length xs; f [1,2]', '2'],
    ['[isType (List Int) [1, "a"], isType (List Int) [1..]]', '[False,True]'],
    // Types compare as the sets of their values.
    ['U = (Int | String); V = (String | Int); [U == V, typeOf [1,2] <= List Int, Int < Number]', '[True,True,True]'],
    // A type pattern matches each type within the one it names, the type itself first.
    ['describe Int = "int"; describe Number = "number"; [describe Int, describe Float]', '["int","number"]'],
    ['typeOf [1,2] ~ [List Int -> 1, _ -> 0]', '1'],
    // An endless list never matches [], also through a call made in a function's body.
    ['z [] = []; z (x :: r) = [x]; w xs = z xs; f [a] = a; f (w [1..])', '1'],
    // An operation reads its operands once its calls are decided: hd x with a
    // fail clause is the element there, compared as one.
    ['hd (x :: _) = x; hd [] = fail "e"; h x = hd x > 1; h [1]', 'False'],
    // A call whose argument holds the call itself stays undecided: left's
    // elements are what hd gives, in a branch of what left is.
    ['hd (x :: _) = x; hd [] = fail "empty"; nl [] = True; nl (_ :: _) = False\n' +
        'm left right = nl left ? right : (nl right ? left : [hd left])\nm [1] [2]', '[1]'],
    // A call no clause ranking decides, its recursive clause's result free,
    // has the definition's type as a whole: fl's is (a -> b -> a) -> a -> List b -> a.
    [`${FL}rv (xs : List _) = fl (acc, x -> x :: acc) [] xs\nf xs = map (x -> x) (rv xs)\nf [1,2]`, '[2,1]'],
    // Its lengths are the run's: a fold that keeps its accumulator keeps [1,2].
    [`${FL}g (fl (acc, x -> acc) [1,2] [3])`, '3'],
    // (m : HashMap _ _) binds a map, of any keys and values.
    ['ks (m : HashMap _ _) = keys m; ks ([["a", 1]] : HashMap _ _)', '["a"]'],
    // Clauses typed by different types recurse through the finished function:
    // ln (keys m) is a List String, ln (to (List Char) s) a List Char.
    ['ln (s : String) = ln (to (List Char) s); ln (m : HashMap _ _) = ln (keys m); ln (xs : List _) = 7\n' +
        '[ln ([["a", 1]] : HashMap _ _), ln "ab", ln [1]]', '[7,7,7]'],
    // Typed clauses recursing at different types (ln [1] beside ln ["a"]):
    // each call takes the clause the run takes, not the first call's type.
    ['ln (n : Int) = ln [1]; ln (s : String) = ln ["a"]; ln (xs : List _) = 7; [ln 5, ln "ab", ln [2]]', '[7,7,7]'],
    // A recursive call has the function's type as a whole: f rest gives what
    // f [] = 0 gives, a number, which a Float element adds to.
    ['f [] = 0; f (x :: rest) = x + f rest; f [1.5,2]', '3.5'],
    // Clauses that differ only in their results' lengths, a call no ranking
    // decides: a list whose length the run finds, never one choice's [].
    ...["(+) 1 1", "negate -2", "2 : Int", "id 2"].map(count => [`id x = x; tk 0 _ = []; tk _ [] = []; tk n (x :: rest) = x :: tk (n - 1) rest\n` +
        `f [a,b] = a\nf (tk (${count}) [1,2,3])`, '1'] as const),
    // Through a wrapper too: (+) 1 1's value is known, as 1 + 1's is.
    ...["(+) 1 1", "1 + 1", "id 2"].map(count => [`id x = x; ${TK2}tk n xs = tk2 n xs\nf (tk (${count}) [1,2,3])`, '1'] as const),
    // A branch beside a call still waiting for its argument is a list of a
    // length the call decides, never the branch's own: [] is not length 0 here.
    ...["n < 0 ? [] : tk2 n xs", "n > 0 ? tk2 n xs : []"].map(body => [`${TK2}tk n xs = ${body}\nf (tk 2 [1,2,3])`, '1'] as const),
    // A result's shape comes from every choice that may take a list, the
    // count before the list too: en2's (Int n) (x :: rest), not [] alone.
    ['en xs = en2 0 xs; en2 _ [] = []; en2 (n : Int) (x :: rest) = [n,x] :: en2 (n + 1) rest\n' +
        'g [p,q] = p\ng (en [10,20])', '[0,10]'],
    // Another union of list types is unfolded when it runs.
    ['Pairs a = [] | a :: a :: Pairs a; f (xs : Pairs Int) = length xs; f [1,2]', '2'],
    // A value of either list type takes each one's clause, [] among them.
    ['nl [] = True; nl (_ :: _) = False; [nl (head [[],[1]]), nl (head [[1],[]])]', '[True,False]'],
    // Clauses typed by their lists' element types are overloads, in either order.
    ['f (xs : List Int) = "ints"; f (xs : List String) = "strings"; [f [1], f ["a"]]', '["ints","strings"]'],
    ['f (xs : List String) = "strings"; f (xs : List Int) = "ints"; [f [1], f ["a"]]', '["ints","strings"]'],
    ['f x = x + 1; [f 1, f 2.0]', '[2,3.0]'],
    ['factorial = (self -> n -> self self n) (self -> n -> n == 0 ? 1 : n * self self (n - 1))\nfactorial 5', '120'],
    ['((.2 : Float64) : Float32)', '0.2'],
    // A parameter's record is known from the fields code uses, also when it assigns them.
    ['f r = { r.a = 5; r }; f [a = 1, b = 2]', '[a = 5, b = 2]'],
    ['g r = { r.p.q = 3; r }; g [p = [q = 1, z = 0]]', '[p = [q = 3, z = 0]]'],
    // A function known only from its uses does not fix its list argument's length.
    ['f g = [g [1], g [1,2,3]]; f length', '[1,3]'],
    ['f r = [r.g [1], r.g [1,2,3]]; f [g = length]', '[1,3]'],
    // A known small Int converts to a Float operand losslessly.
    ['f r = r.y == 0 ? 5.0 : r.vy / 8; f [y = 1.0, vy = 2.0]', '0.25'],
    // Either branch's three numbers: a list of three numbers.
    ['f c = c ? [1.0,2.0,3.0] : [0.0,0.0,0.0]; [1.0,1.0,1.0] + f True', '[2.0,3.0,4.0]'],
    // A record alias is a type argument (List Point, Result Point e); a field
    // may name another module's type (browser.Viewport).
    ['std <- import "std"; use std.option\nPoint = [x : Float, y : Float]\nMsg = | Got (Result Point String)\nGot (Ok [x = 1, y = 2])', 'Got (Ok [x = 1.0, y = 2.0])'],
    ['Point = [x : Float, y : Float]\nShape = | Path (List Point)\nPath [[x = 1, y = 2]]', 'Path [[x = 1.0, y = 2.0]]'],
    ['browser <- import "std/browser"\nMsg = Resized browser.Viewport | Other\nResized [width = 1, height = 2]', 'Resized [width = 1, height = 2]'],
    // A constructor pattern on a Dynamic field is checked when it runs.
    ['std <- import "std"; use std.option\nMsg = More | Got Dynamic\nf msg = msg ~ [More -> 0, Got (Ok q) -> q, Got (Err _) -> 1]\nf (Got (Ok 5))', '5'],
    // More clauses are a new version: label keeps the clauses it saw.
    ['describe 0 = "zero"; label x = describe x; describe 1 = "one"; [describe 1, label 0]', '["one","zero"]'],
    // h keeps the c it was written with; a later c is another version.
    ["f 'a' = [0]; f x = [1,2]; g [a] = a; c = 'a'; h u = g (f c); c = 'b'; h 0", '0'],
    // A rebinding is a new version, of any type: what was written before keeps the old.
    ['xs <- return ([1,2] : Vect 2 Int); xs = [3]; xs', '[3]'],
    ['x : Int = 1; x = "a"; x', '"a"'],
    ['x = 1; y = x + 1; x = "a"; [x,y]', '["a", 2]'],
    // Its value reads the version before it, whatever its value is.
    ['xs = [1,2]; xs = map (+ 1) xs; xs', '[2,3]'],
    ['v = { xs = [1,2]; xs = get xs 1; xs }; v', '2'],
    // A definition written with lambdas is checked as the clause with those parameters.
    ['append = (xs : Vect n a) -> (ys : Vect m a) -> ({\n    xs ~ [\n        [] -> ys\n        x::xs -> x :: append xs ys\n    ]\n} : Vect (n + m) a)\ntypeOf (append [] [3])', 'Vect 1 Int'],
    // A record schema applied to a value not known yet converts it at runtime.
    ['Quote = [quote : String, year : Int]\nconv r = r : Quote\n(conv [year = 2]).year', '2'],
    ['Quote = [quote : String, year : Int]\n(([quote = "q", year = 1] : Dynamic) : Quote).quote', '"q"'],
    // A record type is a type: to applies it, and a Type parameter takes it.
    ['Quote = [quote : String, year : Int]\n(to Quote [year = 1]).year', '1'],
    ['f (t : Type) = t\nisType (f [a : Int]) [a = 3]', 'True'],
    // A string iterates its characters.
    ['"ab" * c -> to String c', '["\'a\'","\'b\'"]'],
    // A selection of fields named nowhere in scope opens a parameter as a record.
    ['f w = w.[first = x]\n(f [x = 1]).first', '1'],
    ['f w = w.[x,y]\nf [x = 1, y = 2]', '[1,2]'],
    // A record its type made takes updates to its fields, and a literal copy new ones.
    ['Quote = [quote : String, year : Int]\nq = [] : Quote\nq.year = 3\nq "quote" = "x"\n[use q, more = 1]', '[quote = "x", year = 3, more = 1]'],
    // A list item may take a value apart with a constructor, as a block's statement may.
    ['std <- import "std"; use std.option\n[Some v = Some 3, v + 1]', '[4]'],
    ['std <- import "std"; use std.option\ncode = [Some v = Some 3] ++ [v]\ncode 0 = (Some v = Some 5)\ncode', '[5]'],
    // use opens a module, however the program got it: a name, a field, a call.
    ['numbers <- import "std/number"\nuse numbers\nsq 3', '9'],
    ['numbers <- import "std/number"\nalias = numbers\n{ use alias; cube 2 }', '8'],
    ['std <- import "std"\nrandom = std.number\nrandom.sq 4', '16'],
    ['numbers <- import "std/number"\nf _ = numbers\nuse (f [])\nsq 3', '9'],
    ['f _ = {\n    print "f"\n    import "std/number"\n}\nm <- f []\nuse m\nsq 3', '9'],
    // A record's fields run as a block's statements do: in scope for the whole
    // record, clauses joined, types declared with their constructors.
    ['r = [\n    fact 0 = 1\n    fact n = n * fact (n - 1)\n    quad x = double (double x)\n    double x = x * 2\n]\n[r.fact 5, r.quad 3]', '[120,12]'],
    ['r = [\n    Shape = Circle Float | Square Float\n    area (Circle r) = 3 * r * r\n    area (Square s) = s * s\n]\nr.area (r.Square 2.0)', '4.0'],
    ['r = [x = 1, x = x + 1, y = x * 10, ones = 1 :: ones]\n[r.x, r.y, head r.ones]', '[2,20,1]'],
    ['r = [\n    Box a = | Box a\n    map f (Box x) = Box (f x)\n    unbox (Box x) = x\n]\nr.unbox (map (+ 1) (r.Box 1))', '2'],
    // A record defines operators and declares their fixity as a block does.
    ['r = [\n    V = | V Int\n    V a + V b = V (a + b)\n    infixr 3 <|>\n    a <|> b = a ++ b\n]\nuse r\n[V 1 + V 2, [1] <|> [2]]', '[V 3, [1,2]]'],
    // A block's functions are defined for the whole block, as the top level's are.
    ['{ f x = g x; g x = x + 1; f 1 }', '2'],
    ['k n = {\n    even 0 = True\n    even m = odd (m - 1)\n    odd 0 = False\n    odd m = even (m - 1)\n    even n\n}\n[k 4, k 5]', '[True,False]'],
    // A record pattern binds a module's names as use opens them: generic.
    ['std <- import "std"\n[sequence] = std\n[sequence.sum [1,2], sequence.sum [0.5]]', '[3,0.5]'],
    ['[sum] <- import "std/sequence"\n[sum [1,2], sum [0.5]]', '[3,0.5]'],
    ['[sum = total] <- import "std/sequence"\n[total [1,2], total [0.5]]', '[3,0.5]'],
] as const) Deno.test(`default checking session: ${source}`, () => {
    const actual = run(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    // (A function defined further on is checked where it is used.)
    'r = [area (s : String) = s ++ "!"]\nr.area 1',
    '{ f x = g x; g (x : String) = x ++ "!"; f 1 }',
    'f x = x + 1; f "bad"',
    'apply f x = f x; apply (x -> x + 1) "bad"',
    'x | missingGuard -> x',
    'f x = x == 0 ? 1 : x * x; f (2 : Dynamic)',
    '([1] : Vect 2 Int)',
    'f g = [g 1, g "a"]; f (x -> 0)',
    'bad = (xs : Vect n a) -> (ys : Vect m a) -> ({\n    xs ~ [\n        [] -> ys\n        x::xs -> x :: bad xs ys\n    ]\n} : Vect (n + m + 1) a)',
    'Quote = [quote : String, year : Int]; from Quote [quote = "q", year = 1]',
    'Quote = [quote : String, year : Int]; to Quote [year = "x"]',
    'f w = w.[x,y]; f [x = 1]',
    // A field bound to a type is a value: the record is no type.
    'f (t : Type) = t; f [a = Int]',
    '"ab" * c -> c + 1',
    // A record its type made keeps its fields.
    'Quote = [quote : String, year : Int]; q = [] : Quote; q.yaer = 1',
    'Quote = [quote : String, year : Int]; q = [] : Quote; q "yaer" = 1',
    'Quote = [quote : String, year : Int]; f (q : Quote) = { q.x = 1; q }',
    'Quote = [quote : String, year : Int]; conv r = r : Quote; (conv [year = "x"]).year',
    // Only use opens a module, in its own block: not a statement, a field of it or a binding.
    'numbers <- import "std/number"\nnumbers.sq 2\nsq 3',
    'numbers <- import "std/number"\n{ use numbers; 1 }\nsq 3',
    'numbers <- import "std/number"\nf _ = numbers\nm = f []\nsq 3',
    'random = { std <- import "std"; use std.number }\nsq 3',
    'std <- import "std"\nstd.number\nsq 3',
    // A record's entry is written as a [key,value] pair, within the record.
    'v = [x = 1]\nv 0 = [x1 = 22]',
    'v = [x = 1]\nv 1 = ["a", 1]',
    'P = [x : Float, y : Float]\np = [1,2] : P\np 1 = ["w", 1]',
    // An item after an x <- m item yields the block ending in it: { x <- m; x } is an error.
    'print [x <- return 1, x]',
    'print [x <- [1,2], 7]',
]) Deno.test(`default checking rejects before evaluation: ${source}`, () => rejected(session(), source));

// A choice between values (a ternary's branches, a match's arms, a function's
// clauses) has either type, as a list's items do: used where every one fits,
// or narrowed by a pattern. Where the checker knows which is taken, it is that.
const choices = 'std <- import "std"; use std.time\nt <- currentTime\nfunc x = x ? "yes" : False\n' +
    'h x = x ~ [\n    0 -> "zero"\n    _ -> False\n]\ng 0 = "zero"\ng _ = False\n';
for (const [source, expected] of [
    ['[func True, func False, h 0, h 1, g 0, g 1]', '["yes", False, "zero", False, "zero", False]'],
    ['[func (t > 0) == "yes", (t > 0 ? 1 : 2.5) + 1 > 0]', '[True,True]'],
    ['func True ++ "!"', '"yes!"'],
    ['d (s : String) = s ++ "!"; d (b : Bool) = b ? "T" : "F"; [d (func (t > 0)), d (h t), d (g t)]', '["yes!","F","F"]'],
    ['func (t > 0) ~ [\n    (s : String) -> s ++ "!"\n    _ -> "no"\n]', '"yes!"'],
    ['[h 0 ++ "!", g 0 ++ "!"]', '["zero!","zero!"]'],
    ['xs = [1, "a"]; d (n : Int) = n + 1; d (s : String) = s ++ "!"; map d xs', '[2, "a!"]'],
    // A held value may be either: Pair 1 "a" or Pair true 'c' is Pair (Int | Bool) (String | Char).
    ["Pair a b = | Pair a b; first (Pair x _) = x; to String (first (t > 0 ? Pair 1 \"a\" : Pair True 'c'))", '"1"'],
    ['inc (n : Int) = n + 1; dbl (n : Int) = n * 2; (t > 0 ? inc : dbl) 5', '6'],
    ['Handler a = | Handler (a -> String)\napply (Handler f) x = f x\napply (Handler (s -> s ++ "!")) "x"', '"x!"'],
    // A function taken from one stays as generic as its lambda, checked at each use.
    ['Handler a = | Handler (a -> String)\nn = Handler (x -> to String (x + 1))\nm = n ~ [Handler g -> g]\n[m 1, m 2.5]', '["2","3.5"]'],
    // The branches do not decide x where its other uses do: x > 0 keeps it a number.
    ['k x = x > 0 ? x : "neg"; [k 1 + 1, k -1]', '[2, "neg"]'],
    // A ternary is a match: a value known to take one alternative checks only it.
    ['True ~ [True -> 1, False -> "a" + 1]', '1'],
    ['x = 2\n(x ~ [1 -> "one", n -> n + 1]) + 1', '4'],
    // The one it takes is the most specific that fits, as among clauses.
    ['(0 ~ [n -> "any", 0 -> 5]) + 1', '6'],
] as const) Deno.test(`a choice has either type: ${source}`, () => {
    const actual = run(session(), choices + source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'func (t > 0) ++ "!"', 'h t ++ "!"', 'g t ++ "!"',
    // Every choice must be accepted where it is used.
    'd (s : String) = s ++ "!"; d (b : Bool) = "b"; d [func (t > 0), 1] 1',
    'xs = [1, "a", True]; d (n : Int) = n + 1; d (s : String) = s ++ "!"; map d xs',
    // A function a field holds takes one type, not either: Handler Int and
    // Handler String stay apart, and a choice of functions takes what all do.
    'Handler a = | Handler (a -> String)\napply (Handler f) x = f x\ninc (n : Int) = to String n\n' +
        'bang (s : String) = s\napply (t > 0 ? Handler inc : Handler bang) 5',
    'inc (n : Int) = n + 1; bang (s : String) = s; (t > 0 ? inc : bang) 5',
    // A lambda a field holds is checked where the field's type is decided,
    // however far the value travels first.
    'Handler a = | Handler (a -> String)\napply (Handler f) x = f x\napply (Handler (s -> s ++ "!")) 5',
    'Handler a = | Handler (a -> String)\nh = Handler (s -> s ++ "!")\nHandler f = h\nf 5',
    'Handler a = | Handler (a -> String)\nh = Handler (s -> s ++ "!")\nf = h ~ [Handler g -> g]\nf 5',
    'Handler a = | Handler (a -> String)\nh = Handler (s -> s ++ "!")\nr = [f = h ~ [Handler g -> g]]\nr.f 5',
    // A function matching its parameters is its alternatives as clauses.
    'd = x -> x ~ [0 -> 1]\nd 5',
    'add x y = [x,y] ~ [[0,b] -> b, [a,b] -> a + b]\nadd 0 "a" + 1',
    // A statement of a do-block is an action whichever branch is taken.
    'f x = x ? print "yes" : False\nk y = {\n    f y\n    print 2\n}',
    // Alternatives' lists of one type keep it, lengths included, as branches' do.
    'pick b a c = b ? [map (x -> x) a, c] : [map (x -> x) a, c]\nsum3 [[x],[y,z]] = x + y + z\n' +
        'k n = sum3 (pick (n > 0) [1,2] [1,2])',
    'pick b a c = b ~ [True -> [map (x -> x) a, c], _ -> [map (x -> x) a, c]]\n' +
        'sum3 [[x],[y,z]] = x + y + z\nk n = sum3 (pick (n > 0) [1,2] [1,2])',
]) Deno.test(`a choice is used as every type it may be: ${source}`, () => rejected(session(), choices + source));

// A ternary's branch is checked as the expression alone is: a lossy mix the
// checker types as Number fails when it runs, in a branch as outside one.
for (const source of [
    'f r = r.vy * 9007199254740993; f [y = 1.0, vy = 2.0]',
    'f r = r.y == 0 ? 5.0 : r.vy * 9007199254740993; f [y = 1.0, vy = 2.0]',
]) Deno.test(`a lossy mix fails when it runs: ${source}`, () => {
    try { run(session(), source); } catch (error) {
        if ((error as Error).message === "lossy implicit numeric conversion; use inexact explicitly") return;
        throw error;
    }
    throw new Error(`accepted: ${source}`);
});

Deno.test("a static error prevents earlier effects and bindings", () => {
    const i = session(), lines: unknown[] = [], oldLog = console.log;
    console.log = (...values: unknown[]) => { lines.push(values); };
    try { rejected(i, 'print "must not print"; newName = 1; 1 + "bad"'); }
    finally { console.log = oldLog; }
    if (lines.length || i.env.get("newName")) throw new Error("rejected source had effects");
});
Deno.test("REPL clauses and polymorphism survive separate submissions", () => {
    const i = session();
    run(i, 'func 0 = 1'); run(i, 'func 1 = 0');
    if (run(i, '[func 0, func 1]') !== '[1,0]') throw new Error('lost clause');
    run(i, 'func 0 = 2');
    if (run(i, '[func 0, func 1]') !== '[2,0]') throw new Error('replacement lost clause');
    // A clause with another result type: either, where the call cannot tell.
    run(i, 'func 2 = "two"');
    if (run(i, '[func 0, func 2]') !== '[2, "two"]') throw new Error('lost the new clause');
    rejected(i, 'std <- import "std"; use std.time; t <- currentTime; func t ++ "!"');
    run(i, 'id x = x');
    if (run(i, 'id 1') !== '1' || run(i, 'id True') !== 'True') throw new Error('lost polymorphism');
});
Deno.test("runtime failure restores bindings and their checking state", () => {
    const i = session(); run(i, 'existing = 1');
    try { run(i, 'existing = 2; transient = 3; fail "stop"'); } catch { /* intended */ }
    if (run(i, 'existing') !== '1' || i.env.get('transient')) throw new Error('partial bindings survived');
    rejected(i, 'transient');
    rejected(i, 'existing ++ "bad"');
});
Deno.test("namespaced import does not open conflicting exports", () => {
    const i = session(); run(i, 'span = 123; html <- import "std/html"');
    run(i, 'html.text "hello"');
    if (run(i, 'span') !== '123' || i.env.get('button')) throw new Error('namespace leaked');
});
Deno.test("load checks dependencies with the lexical caller scope", () => {
    const i = session();
    const file = new URL('fixtures/static-checking/local', import.meta.url).pathname;
    const actual = run(i, `f localValue = {\n    module <- load "${file}"\n    return module.answer\n}\nanswer <- f 41\nanswer`);
    if (actual !== '42') throw new Error(actual);
});
Deno.test("invalid loaded source is rejected before any output", () => {
    const file = new URL('fixtures/static-checking/invalid', import.meta.url).pathname;
    rejected(session(), `load "${file}"`);
});
Deno.test("all standard modules check without evaluation", () => {
    const checker = new CheckingSession();
    for (const name of ['function', 'option', 'sequence', 'array', 'number', 'text', 'map', 'combinator', 'io', 'system', 'search', 'meta', 'html', 'browser', 'p5', 'ffi']) checker.module(`std/${name}`);
});

Deno.test("Dynamic writes cannot invalidate a checked Mutable payload", () => {
    const i = session(); run(i, 'cell = Mutable 1');
    try { run(i, '(set cell "bad" : Dynamic)'); } catch (error) {
        if (!String(error).includes('cannot use String where Int is required')) throw error;
        if (run(i, 'cell + 1') !== '2') throw new Error('cell was corrupted');
        return;
    }
    throw new Error('unchecked Mutable write');
});
for (const source of ['isExact "bad"', 'keys [x = 1]', 'values [x = 1]']) {
    Deno.test(`native signatures reject incompatible values: ${source}`, () => rejected(session(), source));
}

Deno.test("unary collection constraints distribute over heterogeneous list shapes", () => {
    const actual = run(session(), 'map length [[1],[2,3]]');
    if (actual !== '[1,2]') throw new Error(actual);
});
Deno.test("default checking reports an unbound name with a suggestion", () => {
    try { run(session(), "y = 3; yy + 1"); } catch (error) {
        const e = error as { kind?: string; message?: string; hint?: string };
        if (e.kind !== "type" || e.message !== "unbound variable 'yy'" || e.hint !== "did you mean 'y'?") throw error;
        return;
    }
    throw new Error("accepted an unbound name");
});
// A variable bound to a union containing itself (v = v | t) resolves to t,
// and functions that return their list parameter preserve its length.
for (const [source, expected] of [
    ['std <- import "std"; use std.sequence; g [a,b] = forceList [b, a + b]; repeatApply 3 g [1,2]', '[5,8]'],
    ['std <- import "std"; use std.sequence\ntick [a,b,c,d,e,f,g,h,i] = forceList [b, c, d, e, f, g, h + a, i, a]\nsum (repeatApply 80 tick [0,1,1,2,1,0,0,0,0])', '5934'],
    ['f (xs : List _) = xs; g [a,b] = f [b, a + b]; g (g [1,2])', '[3,5]'],
    ['std <- import "std"; use std.sequence; g [a,b] = a + b; g (forceList [1,2])', '3'],
    ['g [a,b] = a + b; g (map (x -> x * 2) [1,2])', '6'],
    ['xs = map (x -> x + 1) [1,2]\nys = map (x -> x * 2) [1,2,3]\ng [a,b] = a + b\n[g xs, length ys]', '[5,3]'],
    ['x (x::xs) = 42; x [x]', '42'],
    // A [] inside a pattern tests that part without making the argument empty.
    ['g [[],y] = y; g [x::_,_] = x; g [[1,2], 3]', '1'],
    ['j xs ys = [xs,ys] ~ [[[],r] -> r, [x::m,r] -> x :: j m r]; j [1,2] [3]', '[1,2,3]'],
    ['f xs = xs ~ [[] -> 0, [_] -> 1, _ -> 2]; [f [], f [1], f [1,2]]', '[0,1,2]'],
    // A free name in a typed pattern binds what the value has there.
    ['f (xs : List _) = xs; f [1,2]', '[1,2]'],
    ['k (xs : List a) = a; k [1, "x"]', 'Int | String'],
    ['first (x::_ : List _) = x; first [1..]', '1'],
    ['len (_ : Vect n _) = n; len [1,2]', '2'],
    ['g (xs : Vect n a) = [n,a]; g [1,2]', '[2,Int]'],
    ['app (xs : Vect n a) (ys : Vect m a) = xs ++ ys : Vect (n + m) a; typeOf (app [1,2] [3])', 'Vect 3 Int'],
    // A length the type leaves open is the one evaluation finds.
    ['g [a,b] = a + b; g (map (x -> x) (tail [1,2,3]))', '5'],
    ['g [a,b] = a + b; g (tail [0,1,2])', '3'],
    ['f xs = foldl (acc, x -> x :: acc) xs [1,2]; g [a,b,c,d] = a + b; g (f [1,2])', '3'],
    ['f xs = filter (x -> x > 0) xs; g [a,b] = a + b; g (f [1,2])', '3'],
    ['toList 0 = []; toList k = k - 1 :: toList (k - 1); xs = toList 3; g [a,_,_] = a; g xs', '2'],
    ['toList Z = []; toList (S k) = k :: toList k; (toList 3 : Vect 3 UInt)', '[2,1,0]'],
] as const) Deno.test(`checker infers recursive steps and list sizes: ${source}`, () => {
    const actual = run(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'std <- import "std"; use std.sequence; g [a,b] = forceList [b, a ++ "x"]; repeatApply 3 g [1,2]',
    'std <- import "std"; use std.sequence; g [a,b] = a + b; g (forceList [1,2,3])',
    'g [a,b] = a + b; g (map (x -> x) [1,2,3])',
    'toList 0 = []; toList k = k - 1 :: toList (k - 1); g [a,_] = a; g (toList 3)',
    'h (_ : Vect n a) (_ : Vect n a) = n; h [1,2] [3]',
    'f (xs : List _) = xs; f 5',
    'toList Z = []; toList (S k) = k :: toList k; (toList 3 : Vect 2 UInt)',
    `${TK2}tk n xs = n < 0 ? [] : tk2 n xs\nf (tk 1 [1,2,3])`,
    `${TK2}tk n xs = n > 0 ? tk2 n xs : []\nf (tk 0 [1,2,3])`,
    'hd (x :: _) = x; hd [] = fail "e"; h x = hd x > 1; h ["a"]',
    // A recursive call has the whole function's type: f rest is a number.
    'f [] = 0; f (x :: rest) = x + f rest; f ["a"]',
    'f [] = 0; f (x :: rest) = f rest + x; f ["a"]',
]) Deno.test(`checker still rejects: ${source}`, () => rejected(session(), source));
// Length-preserving builtins carry their input's length, and separate uses of
// one generic function keep independent lengths.
for (const [source, expected] of [
    ['g [p,q] = p; g (enumerate [10,20])','[0,10]'],
    ['g [p,q] = p + q; g ([1,2] * x -> x * 10)','30'],
    ['g [p,q] = p + q; g ((x -> x * 10) * [1,2])','30'],
    ['g [p,q] = p + q; g -[1,2]','-3'],
    ['g [p,q] = p + q; g ([1,2] + [3,4])','10'],
    ['g [p,q] = p + q; g ([1,2] * 3)','9'],
    ['g [[k,v],[k2,w]] = w ++ "!"; g (pairs [x = 1, y = "s"])','"s!"'],
    ['twice xs = xs * x -> x * 2; g [p,q] = p + q; g (twice [1,2])','6'],
    ['number xs = enumerate xs; g [p,q] = p; [g (number [1,2]), length (number [1,2,3])]','[[0,1], 3]'],
    ['h a b = [map (x -> x) a, map (x -> x) b]; h [1] [1,2]','[[1],[1,2]]'],
    ['f (xs : List _) = xs; h a b = [f a, f b]; h [1] [1,2]','[[1],[1,2]]'],
] as const) Deno.test(`checker keeps builtin list lengths: ${source}`, () => {
    const actual = run(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'g [p,q] = p; g (enumerate [10,20,30])',
    'g [p,q] = p + q; g ([1,2,3] * x -> x * 10)',
    '[1,2] + [3,4,5]',
    'g [p,q] = p; g (pairs [x = 1])',
    'h a b = [map (x -> x) a, map (x -> x) b]; g [[x],[y,z]] = x + y + z; g (h [1,2] [1])',
]) Deno.test(`checker rejects mismatched builtin list lengths: ${source}`, () => rejected(session(), source));
// tail of a list whose items are known is the rest of them, its length one less.
for (const [source, expected] of [
    ['g [a,b] = tail [0, b, a + b]; h n f s = n == 0 ? s : h (n - 1) f (f s); h 3 g [1,2]', '[5,8]'],
    ['g [p,q] = p + q; g (tail [1,2,3] * x -> x)', '5'],
    ['g [p,q] = p + q; g (tail [1,2,3,4])', ''],
] as const) Deno.test(`tail keeps the rest of known items: ${source}`, () => {
    if (!expected) return rejected(session(), source);
    if (run(session(), source) !== expected) throw new Error(source);
});
// Standard-library list functions keep their argument's length; functions that
// change a list's length (folds, cons, append, filter) stay unknown, even when
// their result has the same type as their input.
for (const [source, expected] of [
    ['std <- import "std"; use std.sequence; g [a,b] = a + b; g (reverse [1,2])','3'],
    ['std <- import "std"; use std.sequence; g [a,b] = a - b; g (sort [2,1])','-1'],
    ['std <- import "std"; use std.sequence; g [a,b] = a - b; g (sortBy compare [2,1])','-1'],
    ['std <- import "std"; use std.sequence; g [a,b] = a - b; g (sortOn (x -> -x) [1,2])','1'],
    ['std <- import "std"; use std.sequence; g [p,q] = p; g (zipWithIndex [5,6])','[0,5]'],
    ['std <- import "std"; use std.sequence; reverse "abc" ++ "!"','"cba!"'],
] as const) Deno.test(`stdlib keeps list lengths: ${source}`, () => {
    const actual = run(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'std <- import "std"; use std.sequence; g [a,b] = a + b; g (reverse [1,2,3])',
    'f xs = foldl (acc, x -> x :: acc) xs [1,2]; g [a,b] = a + b; g (f [1,2])',
    // A recursive clause's result is the function's type as a whole, its
    // lengths found by the run: fl's x :: acc makes [1,2] three long.
    `${FL}g (fl (acc, x -> x :: acc) [1,2] [3])`,
    `${FL}h ys = g (fl (acc, x -> x :: acc) [1,2] ys); h [3]`,
    'f xs = 0 :: xs; g [a,b] = a + b; g (f [1,2])',
    'f xs = xs ++ xs; g [a,b] = a + b; g (f [1,2])',
    'f xs = { xs = [1,2,3]; xs }; g [a,b] = a + b; g (f [1,2])',
]) Deno.test(`length changes stay unknown: ${source}`, () => rejected(session(), source));
// A call only one clause may run fails as that clause does, not as a call no
// clause accepts: f [] cannot take ["a"], so f (x :: rest)'s + is the error.
for (const source of ['f [] = 0; f (x :: rest) = x + 1; f ["a"]', `${FL}fl (+) 0 ["a"]`]) {
    Deno.test(`the one clause that may run reports: ${source}`, () => {
        try { run(session(), source); } catch (error) {
            if (/cannot combine (String and Int|Int and String)/.test((error as Error).message)) return;
            throw error;
        }
        throw new Error(`accepted: ${source}`);
    });
}
// Nested lengths: a function's result shape is described in terms of its
// arguments, and is trusted only where the function is called directly by name.
for (const [source, expected] of [
    ['h a b = [map (x -> x) a, map (x -> x) b]; g [[x],[y,z]] = x + y + z; g (h [1] [1,2])', '4'],
    ['pairUp a b = [a,b]; g [[x],[y,z]] = x + y + z; g (pairUp [1] [2,3])', '6'],
    ['h a b = [map (x -> x) a, map (x -> x) b]\nh2 a b = h b a\ng [[x,y],[z]] = x + y + z\ng (h2 [1] [1,2])', '4'],
    ['std <- import "std"\nuse std.sequence\nboth xs = [sort xs, reverse xs]; g [[a,b],[c,d]] = a + d; g (both [2,1])', '3'],
] as const) Deno.test(`checker tracks nested list lengths: ${source}`, () => {
    const actual = run(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'h a b = [map (x -> x) a, map (x -> x) b]; g [[x],[y,z]] = x + y + z; g (h [1,2] [1])',
    // A function value that flows through a ternary, list, variable, or partial
    // application shares its type with other functions: no length is assumed.
    'keep xs = xs * x -> x\ndrop1 xs = tail xs\npick b = b ? keep : drop1\ng [a,b,c] = a\ng (pick False [1,2,3])',
    'keep xs = xs * x -> x\ndrop1 xs = tail xs\nh = False ? keep : drop1\ng [a,b,c] = a\ng (h [1,2,3])',
    'keep xs = xs * x -> x\ndrop1 xs = tail xs\nfs = [keep,drop1]\ng [a,b,c] = a\ng (fs 1 [1,2,3])',
]) Deno.test(`checker does not assume lengths: ${source}`, () => rejected(session(), source));
// A length a type declares is the function's, applied partially too.
Deno.test("a declared length survives partial application", () => {
    const actual = run(session(), 'std <- import "std"; use std.sequence; p = sortBy compare; g [a,b] = a; g (p [2,1])');
    if (actual !== "1") throw new Error(actual);
});
// An empty-list pattern rejects a list known to be non-empty (it would fail at
// runtime), while lists of unknown length still reach it, as recursion needs.
// Empty-list and cons clauses are separate overload choices.
for (const [source, expected] of [
    ['g [] = 0; g []', '0'],
    ['g [] = 0; g (tail [1])', '0'],
    ['len [] = 0; len (x::rest) = 1 + len rest; len [1,2,3]', '3'],
    ['rev [] = []; rev (x::xs) = rev xs ++ [x]; rev [1,2,3]', '[3,2,1]'],
    ['f [] = 0; f (x::xs) = x; [f [], f [7,8]]', '[0,7]'],
    ['f [] = "e"; f (x::xs) = x; f [5] + 1', '6'],
    ['f [] = "e"; f (x::xs) = x; f [] ++ "!"', '"e!"'],
] as const) Deno.test(`empty-list patterns: ${source}`, () => {
    const actual = run(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'g [] = 0; g [1]',
    'g [] = 0; g (map (x -> x) [1])',
    'f [] = [0]; f xs = [1,2]; g [] = 0; g (f [])',
]) Deno.test(`empty-list pattern rejects a non-empty list: ${source}`, () => rejected(session(), source));
// The runtime tries clauses by literal score, then most specific first. When a clause
// definitely matches, overload choices made only of later clauses are dropped;
// choices whose clauses all definitely fail are dropped too.
for (const [source, expected] of [
    ['f [] = [0]; f xs = [1,2]; g [a] = a; g (f [])', '0'],
    ['f [] = [0]; f xs = [1,2]; g [a,b] = a; g (f [3])', '1'],
    ['f xs = [1,2]; f [] = [0]; g [a] = a; g (f [])', '0'],
    ['f (x::xs) = [x]; f other = [1,2]; g [a] = a; g (f [7,8])', '7'],
    ['f [a,b] = [a]; f other = [1,2]; g [x] = x; g (f [7,8])', '7'],
    ['f [] y = [y]; f xs y = [1,2]; g [a] = a; g (f [] 5)', '5'],
    ['f xs 0 = [0]; f [] n = [1,2]; g [a] = a; g (f [] 0)', '0'],
    ['f xs 0 = [0]; f [] n = [1,2]; g [a,b] = a; g (f [] 1)', '1'],
    ['f n = [1,2]; f 0 = [0]; g [a] = a; g (f 0)', '0'],
    ['f "x" = [0]; f s = [1,2]; g [a] = a; g (f "x")', '0'],
    ['f True = [0]; f b = [1,2]; g [a] = a; g (f True)', '0'],
] as const) Deno.test(`the most specific matching clause wins: ${source}`, () => {
    const actual = run(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'f [] = [0]; f xs = [1,2]; g [a,b] = a; g (f [])',
    'f xs = [1,2]; f [] = [0]; g [a,b] = a; g (f [])',
    'f [a,b] = [a]; f other = [1,2]; g [x] = x; g (f [7,8,9])',
    'f x x = [0]; f x y = [1,2]; g [a] = a; g (f 1 2)',
    'f xs 0 = [0]; f [] n = [1,2]; g [a] = a; g (f [] 1)',
    'f n = [1,2]; f 0 = [0]; g [a,b] = a; g (f 0)',
    'f True = [0]; f b = [1,2]; g [a] = a; g (f False)',
    // Unknown lengths keep every possible clause.
    // (Static evaluation is bounded in work: this filter scans a million elements.)
    'f [] = [0]; f xs = [1,2]; g [a] = a; g (f (tail (take 1 (filter (> 999999) [0..]))))',
]) Deno.test(`later clauses still count unless a match is definite: ${source}`, () => rejected(session(), source));
// Typed clauses are ranked as the runtime ranks them: an exact type (30)
// before a numeric aggregate (10) before a lossless conversion (1) before other
// patterns (0); literals (40) first. Value-dependent cases keep both clauses.
for (const [source, expected] of [
    ['f (n : Int) = [0]; f xs = [1,2]; g [a] = a; g (f 3)', '0'],
    ['f xs = [1,2]; f (n : Int) = [0]; g [a] = a; g (f 3)', '0'],
    ['f (n : Int) = [0]; f xs = [1,2]; g [a,b] = a; g (f "s")', '1'],
    ['f (n : Int) = [0]; f (s : String) = [1,2]; g [a] = a; g (f 3)', '0'],
    ['f (n : Int) = [0]; f (s : String) = [1,2]; g [a,b] = a; g (f "x")', '1'],
    ['f (n : Number) = [0]; f xs = [1,2]; g [a] = a; g (f 2.5)', '0'],
    ['f (n : Exact) = [0]; f xs = [1,2]; g [a,b] = a; g (f 2.5)', '1'],
    ['f (xs : List _) = [0]; f other = [1,2]; g [a] = a; g (f [5,6])', '0'],
    ['f (n : Int) = [0]; f xs = [1,2]; h x = g (f x); g [a] = a; h 3', '0'],
] as const) Deno.test(`typed clauses rank like the runtime: ${source}`, () => {
    const actual = run(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'f xs = [1,2]; f (n : Int) = [0]; g [a,b] = a; g (f 3)',
    'f (n : Int) = [0]; f xs = [1,2]; g [a] = a; g (f "s")',
    'f (n : Int) = [0]; f xs = [1,2]; h x = g (f x); g [a] = a; h "s"',
    // Whether a Float converts to Int8 depends on its value: 2.5 does not.
    'f (n : Int8) = [0]; f xs = [1,2]; g [a] = a; h x = g (f (x * 1.0)); h 2.5',
]) Deno.test(`typed clauses keep possible clauses: ${source}`, () => rejected(session(), source));
// Clauses of the same input type whose results differ only in list lengths
// become separate overload choices instead of a definition error; any other
// result conflict is still rejected.
for (const [source, expected] of [
    ['f (n : Int) = [1,2]; f 0 = [0]; g [a] = a; g (f 0)', '0'],
    ['f (n : Int) = [1,2]; f 0 = [0]; g [a,b] = a; g (f 3)', '1'],
    ['f (n : Int) = [[1],[2,3]]; f 0 = [[0]]; g [[a]] = a; g (f 0)', '0'],
] as const) Deno.test(`clauses with different result lengths: ${source}`, () => {
    const actual = run(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'f (n : Int) = [1,2]; f 0 = [0]; g [a,b] = a; g (f 0)',
    'f (n : Int) = [1,2]; f 0 = [0]; g [a] = a; g (f 3)',
    // Clauses with different result types: where the call cannot tell which
    // runs (the time is not known), the result is either, used as both.
    'std <- import "std"; use std.time; f (n : Int) = "a"; f 0 = 1; t <- currentTime; f t ++ "b"',
    'std <- import "std"; use std.time; f (n : Int) = ["a","b"]; f 0 = [1]; t <- currentTime; head (f t) + 1',
    'f (n : Int) = "a"; f 0 = 1; f 0 ++ "b"',
]) Deno.test(`clauses with different results stay checked: ${source}`, () => rejected(session(), source));
// A literal passed through function parameters still selects clauses: a
// deferred call keeps its argument's (symbolic) value, and each call
// substitutes the actual one, through any number of levels.
for (const [source, expected] of [
    ['f (n : Int) = [1,2]; f 0 = [0]; h x = g (f x); g [a] = a; h 0','0'],
    ['f (n : Int) = [1,2]; f 0 = [0]; h x = g (f x); g [a,b] = a; h 3','1'],
    ['f (n : Int) = [1,2]; f 0 = [0]; h x = g (f x); g [a] = a; [h 0, h 0]','[0,0]'],
    ['f (n : Int) = [1,2]; f 0 = [0]; h x = g (f (x - 1)); g [a] = a; h 1','0'],
    ['f (n : Int) = [1,2]; f 0 = [0]; h s x = g (f x); g [a] = a; h "s" 0','0'],
    ['f (n : Int) = [1,2]; f 0 = [0]; h x = g (f x); k y = h y; g [a] = a; k 0','0'],
    ['f (n : Int) = [1,2]; f 0 = [0]; h x = g (f x); k y = h y; m z = k z; g [a] = a; m 0','0'],
    ['f (n : Int) = [0]; f (s : String) = [1]; h x = g (f x); k y = h y; g [a] = a; k 0','0'],
] as const) Deno.test(`literals through parameters: ${source}`, () => {
    const actual = run(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'f (n : Int) = [1,2]; f 0 = [0]; h x = g (f x); g [a] = a; h 3',
    'f (n : Int) = [1,2]; f 0 = [0]; h x = g (f x); g [a,b] = a; h 0',
    'f (n : Int) = [1,2]; f 0 = [0]; h x = g (f x); g [a] = a; [h 0, h 5]',
    'f (n : Int) = [1,2]; f 0 = [0]; h x = g (f (x - 1)); g [a] = a; h 2',
    'f (n : Int) = [1,2]; f 0 = [0]; h x = g (f x); k y = h y; g [a] = a; k 4',
    'f (n : Int) = [0]; f (s : String) = [1,2]; h x = g (f x); k y = h y; g [a] = a; k "s"',
    'f (n : Int) = 1; h x = f x + 1; k y = h y; k "s"',
]) Deno.test(`literals through parameters stay checked: ${source}`, () => rejected(session(), source));
// Boolean and string literals reach clauses through parameters too.
for (const [source, expected] of [
    ['f True = [0]; f b = [1,2]; h x = g (f x); g [a] = a; h True','0'],
    ['f True = [0]; f b = [1,2]; h x = g (f x); g [a,b] = a; h False','1'],
    ['f "x" = [0]; f s = [1,2]; h x = g (f x); g [a] = a; h "x"','0'],
    ['f "x" = [0]; f s = [1,2]; h x = g (f x); g [a,b] = a; h "y"','1'],
    ['f True = [0]; f b = [1,2]; h x = g (f x); k y = h y; g [a] = a; k True','0'],
    ['f "x" = [0]; f s = [1,2]; h x = g (f x); k y = h y; m z = k z; g [a] = a; m "x"','0'],
    ['f "x" = [0]; f s = [1,2]; h n s = g (f s); g [a] = a; h 1 "x"','0'],
    ['f "x" = [0]; f s = [1,2]; h x = { x = "y"; g (f x) }; g [a,b] = a; h "x"','1'],
] as const) Deno.test(`boolean and string literals through parameters: ${source}`, () => {
    const actual = run(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'f True = [0]; f b = [1,2]; h x = g (f x); g [a] = a; h False',
    'f True = [0]; f b = [1,2]; h x = g (f x); g [a,b] = a; h True',
    'f "x" = [0]; f s = [1,2]; h x = g (f x); g [a] = a; h "y"',
    'f True = [0]; f b = [1,2]; h x = g (f x); k y = h y; g [a] = a; k False',
    'f True = [0]; f b = [1,2]; h x = g (f x); g [a] = a; [h True, h False]',
    'f "x" = [0]; f s = [1,2]; h x = { x = "y"; g (f x) }; g [a] = a; h "x"',
]) Deno.test(`boolean and string literals through parameters stay checked: ${source}`, () => rejected(session(), source));
// Characters, floats, integer ranges and constructors select clauses too,
// directly and through parameters.
for (const [source, expected] of [
    ["f 'a' = [0]; f c = [1,2]; h x = g (f x); g [a] = a; h 'a'", '0'],
    ["f 'a' = [0]; f c = [1,2]; h x = g (f x); g [a,b] = a; h 'b'", '1'],
    ["f 'a' = [0]; f c = [1,2]; h x = g (f x); k y = h y; g [a] = a; k 'a'", '0'],
    ["c = 'a'; f 'a' = [0]; f x = [1,2]; g [a] = a; g (f c)", '0'],
    ['f 1.5 = [0]; f x = [1,2]; h x = g (f x); g [a] = a; h 1.5','0'],
    ['f 1.5 = [0]; f x = [1,2]; h x = g (f x); g [a,b] = a; h 2.5','1'],
    ['f 2 = [0]; f x = [1,2]; g [a] = a; g (f 2.0)','0'],
    ['f 2.0 = [0]; f x = [1,2]; g [a] = a; g (f 2)','0'],
    ['f [1..3] = [0]; f x = [1,2]; h x = g (f x); g [a] = a; h 2','0'],
    ['f [1..3] = [0]; f x = [1,2]; h x = g (f x); g [a,b] = a; h 7','1'],
    ['std <- import "std"; use std.option; f None = [0]; f x = [1,2]; h x = g (f x); g [a] = a; h None','0'],
    ['std <- import "std"\nuse std.option\nf None = [0]; f x = [1,2]; h x = g (f x); g [a,b] = a; h (Some 1)','1'],
    ['std <- import "std"\nuse std.option\nf (Some x) = [x]; f other = [1,2]; h v = g (f v); g [a] = a; h (Some 7)','7'],
    ['Light = Off | On; f On = [1]; f x = [0,0]; h l = g (f l); g [a] = a; h On','1'],
] as const) Deno.test(`more literal kinds select clauses: ${source}`, () => {
    const actual = run(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    "f 'a' = [0]; f c = [1,2]; h x = g (f x); g [a] = a; h 'b'",
    'f 1.5 = [0]; f x = [1,2]; h x = g (f x); g [a] = a; h 2.5',
    'f [1..3] = [0]; f x = [1,2]; h x = g (f x); g [a] = a; h 7',
    'std <- import "std"; use std.option; f None = [0]; f x = [1,2]; h x = g (f x); g [a] = a; h (Some 1)',
    'Light = Off | On; f On = [1]; f x = [0,0]; h l = g (f l); g [a] = a; h Off',
]) Deno.test(`more literal kinds stay checked: ${source}`, () => rejected(session(), source));
// A function's result value (a literal or constructor, or one of its
// arguments) is known at direct calls by name, so clause ranking can use it.
for (const [source, expected] of [
    ['std <- import "std"\nuse std.option\nf None = [0]; f x = [1,2]; g [a] = a; mk x = None; g (f (mk 1))', '0'],
    ['std <- import "std"\nuse std.option\nf None = [0]; f x = [1,2]; g [a,b] = a; mk x = Some x; g (f (mk 1))', '1'],
    ['std <- import "std"; use std.option\nf None = [0]\nf x = [1,2]\ng [a] = a\nmk x = None\nh v = g (f v)\nh (mk 3)', '0'],
    ['std <- import "std"; use std.option\nf None = [0]\nf x = [1,2]\ng [a] = a\nmk x = None\nh v = g (f (mk v))\nh 3', '0'],
    ['std <- import "std"\nuse std.option\nf None = [0]; f x = [1,2]; g [a] = a; pass v = v; g (f (pass None))', '0'],
    ['std <- import "std"; use std.option\nf None = [0]\nf x = [1,2]\ng [a] = a\nmk x = None\nmk2 y = mk y\ng (f (mk2 1))', '0'],
    ['std <- import "std"; use std.option\nf None = [0]\nf x = [1,2]\ng [a] = a\npick b = b ? None : None\ng (f (pick True))', '0'],
    ['f 0 = [0]; f x = [1,2]; g [a] = a; zero x = 0; g (f (zero 9))', '0'],
    ['f "x" = [0]; f s = [1,2]; g [a] = a; named x = "x"; g (f (named 1))', '0'],
    ["f 'a' = [0]; f s = [1,2]; g [a] = a; letter x = 'a'; g (f (letter 1))", '0'],
    // A variable holding a known function calls it.
    ['std <- import "std"\nuse std.option\nf None = [0]; f x = [1,2]; g [a] = a; mk x = None; mkv = mk; g (f (mkv 1))', '0'],
] as const) Deno.test(`function results select clauses: ${source}`, () => {
    const actual = run(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'std <- import "std"; use std.option; f None = [0]; f x = [1,2]; g [a] = a; mk x = Some x; g (f (mk 1))',
    'std <- import "std"\nuse std.option\nf None = [0]; f x = [1,2]; g [a] = a; pass v = v; g (f (pass (Some 2)))',
    // A call through a variable that picks the function its clause cannot take.
    'std <- import "std"; use std.option\nf None = [0]\nf x = [1,2]\ng [a] = a\nmk x = None\nmk2 x = Some x\nmkv = False ? mk : mk2\ng (f (mkv 1))',
    // Code after a rebinding reads the new version.
    "f 'a' = [0]; f x = [1,2]; g [a] = a; c = 'a'; h u = g (f c); c = 'b'; g (f c)",
]) Deno.test(`function results stay checked: ${source}`, () => rejected(session(), source));
// Results that depend on argument values: the checker evaluates a directly
// called function's clauses and conditions with what is known about the
// arguments, and decides calls through parameters at the enclosing calls.
for (const [source, expected] of [
    ['std <- import "std"; use std.option\nf None = [0]\nf x = [1,2]\ng [a] = a\npick b = b ? None : Some 1\ng (f (pick True))','0'],
    ['std <- import "std"; use std.option\nf None = [0]\nf x = [1,2]\ng [a,b] = a\npick b = b ? None : Some 1\ng (f (pick False))','1'],
    ['std <- import "std"; use std.option\nf None = [0]\nf x = [1,2]\ng [a] = a\nmk 0 = None\nmk n = Some n\ng (f (mk 0))','0'],
    ['std <- import "std"; use std.option\nf None = [0]\nf x = [1,2]\ng [a,b] = a\nmk 0 = None\nmk n = Some n\ng (f (mk 5))','1'],
    ['std <- import "std"; use std.option\nf None = [0]\nf x = [1,2]\ng [a] = a\nsafe n = n > 0 ? Some n : None\ng (f (safe -3))','0'],
    ['std <- import "std"; use std.option\nf None = [0]\nf x = [1,2]\ng [a,b] = a\nsafe n = n > 0 ? Some n : None\ng (f (safe 4))','1'],
    ['std <- import "std"; use std.option\nf None = [0]\nf x = [1,2]\ng [a] = a\nsafe n = n - 1 > 0 ? Some n : None\ng (f (safe 1))','0'],
    ['std <- import "std"; use std.option\nf None = [0]\nf x = [1,2]\ng [a] = a\nboth p q = p && q ? Some 1 : None\ng (f (both True False))','0'],
    ['std <- import "std"; use std.option\nf None = [0]\nf x = [1,2]\ng [a] = a\nz n = !n ? None : Some 1\ng (f (z 0))','0'],
    ['std <- import "std"; use std.option\nf None = [0]\nf x = [1,2]\ng [a] = a\nis s = s == "x" ? None : Some 1\ng (f (is "x"))','0'],
    ['std <- import "std"; use std.option\nf None = [0]\nf x = [1,2]\ng [a] = a\ncount 0 = None\ncount n = count (n - 1)\ng (f (count 5))','0'],
    ['std <- import "std"; use std.option\nf None = [0]\nf x = [1,2]\ng [a] = a\nsafe n = n > 0 ? Some n : None\nh v = g (f (safe v))\nh 0','0'],
    ['std <- import "std"; use std.option\nf None = [0]\nf x = [1,2]\ng [a,b] = a\nsafe n = n > 0 ? Some n : None\nh v = g (f (safe v))\nh 5','1'],
    ['std <- import "std"; use std.option\nf None = [0]\nf x = [1,2]\ng [a] = a\nsafe n = n > 0 ? Some n : None\nh v = g (f (safe v))\nk w = h w\nk -1','0'],
    ['std <- import "std"; use std.option\nf None = [0]\nf x = [1,2]\ng [a] = a\nsafe n = n > 0 ? Some n : None\nh (v : Int) = g (f (safe v))\nh 0','0'],
    ['fib 0 = 0\nfib 1 = 1\nfib n = fib (n - 1) + fib (n - 2)\nf 6765 = [0]\nf x = [1,2]\ng [a] = a\ng (f (fib 20))','0'],
] as const) Deno.test(`value-dependent results: ${source}`, () => {
    const actual = run(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'std <- import "std"; use std.option\nf None = [0]\nf x = [1,2]\ng [a] = a\npick b = b ? None : Some 1\ng (f (pick False))',
    'std <- import "std"; use std.option\nf None = [0]\nf x = [1,2]\ng [a] = a\nmk 0 = None\nmk n = Some n\ng (f (mk 5))',
    'std <- import "std"; use std.option\nf None = [0]\nf x = [1,2]\ng [a] = a\nsafe n = n > 0 ? Some n : None\nh v = g (f (safe v))\nh 3',
    'std <- import "std"; use std.option\nf None = [0]\nf x = [1,2]\ng [a] = a\nsafe n = n > 0 ? Some n : None\nh v = g (f (safe v))\nk w = h w\nk 9',
    'std <- import "std"; use std.option\nf None = [0]\nf x = [1,2]\ng [a] = a\nsafe n = n > 0 ? Some n : None\nh v = g (f (safe v))\n[h 0, h 1]',
]) Deno.test(`value-dependent results stay checked: ${source}`, () => rejected(session(), source));
// Floating-point and exact rational conditions are evaluated with the
// runtime's own arithmetic and comparison, including NaN and lossy-mix rules.
const optionClauses = 'std <- import "std"; use std.option; f None = [0]; f x = [1,2]';
for (const [source, expected] of [
    ['g [a] = a; small x = x < 0.5 ? None : Some x; g (f (small 0.25))', '0'],
    ['g [a,b] = a; small x = x < 0.5 ? None : Some x; g (f (small 0.75))', '1'],
    ['g [a] = a; small x = x * 2.0 - 0.5 < 0.0 ? None : Some x; g (f (small 0.1))', '0'],
    ['g [a,b] = a; e3 x = x + 0.2 == 0.3 ? None : Some x; g (f (e3 0.1))', '1'],
    ['g [a] = a; half x = x / 2 == 1 / 2 ? None : Some x; g (f (half 1))', '0'],
    ['g [a] = a; third x = x < 1 / 3 ? None : Some x; g (f (third (1 / 4)))', '0'],
    ['g [a] = a; m x = x == 0.5 ? None : Some x; g (f (m (1 / 2)))', '0'],
    ['g [a,b] = a; n x = x < 1.0 ? None : Some x; g (f (n (0.0 / 0.0)))', '1'],
    ['g [a] = a; r x = floor x == 2 ? None : Some x; g (f (r 2.7))', '0'],
    ['g [a] = a; r x y = min (abs x) y < 1 ? None : Some x; g (f (r -0.5 4))', '0'],
    ['g [a] = a; r x = x ^ 2 == 1 / 4 ? None : Some x; g (f (r (1 / 2)))', '0'],
    ['g [a] = a; small x = x < 0.5 ? None : Some x; h v = g (f (small v)); h 0.25', '0'],
    ['g [a] = a; small x = x < 0.5 ? None : Some x; h v = g (f (small (v / 4))); h 1', '0'],
] as const) Deno.test(`float and rational conditions: ${source}`, () => {
    const actual = run(session(), `${optionClauses}\n${source}`);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const [source, expected] of [
    ['f 0.5 = [0]; f x = [1,2]; g [a] = a; g (f (1 / 2))', '0'],
    ['f 2 = [0]; f x = [1,2]; g [a] = a; g (f (6 / 3))', '0'],
] as const) Deno.test(`number patterns match computed values: ${source}`, () => {
    const actual = run(session(), source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'g [a] = a; small x = x * 2.0 - 0.5 < 0.0 ? None : Some x; g (f (small 0.4))',
    'g [a] = a; e3 x = x + 0.2 == 0.3 ? None : Some x; g (f (e3 0.1))',
    'g [a] = a; n x = x < 1.0 ? None : Some x; g (f (n (0.0 / 0.0)))',
    'g [a] = a; small x = x < 0.5 ? None : Some x; h v = g (f (small v)); h 0.75',
    'g [a] = a; small x = x < 0.5 ? None : Some x; h v = g (f (small (v / 4))); h 3',
    // Operations the runtime rejects give no value: both clauses count.
    'g [a] = a; r x = x + 0.5 < 1.0 ? None : Some x; g (f (r (1 / 3)))',
    'g [a] = a; r x = 1 / x > 0 ? None : Some x; g (f (r 0))',
    // A shadowed builtin is not evaluated as the builtin.
    'g [a] = a; min a b = 99; r x = min x 1 < 1 ? None : Some x; g (f (r 0))',
]) Deno.test(`float and rational conditions stay checked: ${source}`, () => rejected(session(), `${optionClauses}\n${source}`));
// Fixed-width numbers keep their type: Float32 rounds to single precision and
// Int8 overflow is a runtime error, so it gives no value.
for (const [source, expected] of [
    ['g [a] = a; s x = (x : Float32) < (0.5 : Float32) ? None : Some x; g (f (s 0.25))', '0'],
    ['g [a] = a; e3 x = (x : Float32) + (0.2 : Float32) == (0.3 : Float32) ? None : Some x; g (f (e3 0.1))', '0'],
    ['g [a] = a; b x = (x : Int8) + (100 : Int8) > (0 : Int8) ? None : Some x; g (f (b 20))', '0'],
    ['g [a,b] = a; b x = -(x : Int8) < (0 : Int8) ? Some x : None; g (f (b 5))', '1'],
    ['g [a] = a; s x = (x : Float32) < (0.5 : Float32) ? None : Some x; h v = g (f (s v)); h 0.25', '0'],
    ['g [a] = a; k (x : Float32) = None; k x = Some x; h v = g (f (k (v : Float32))); h 0.5', '0'],
    ['g [a] = a; z = 7 : Int32; s x = x == (7 : Int32) ? None : Some x; g (f (s z))', '0'],
    ['h v = v : Int8; h 5', '5'],
] as const) Deno.test(`fixed-width conditions: ${source}`, () => {
    const actual = run(session(), `${optionClauses}\n${source}`);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'g [a] = a; e3 x = (x : Float32) + (0.2 : Float32) == (0.3 : Float32) ? Some x : None; g (f (e3 0.1))',
    'g [a] = a; s x = (x : Float32) + (0.5 : Float64) < (1.0 : Float32) ? None : Some x; g (f (s 0.25))',
    'g [a] = a; b x = (x : Int8) + (100 : Int8) > (0 : Int8) ? None : Some x; g (f (b 100))',
    'g [a] = a; b x = -(x : Int8) > (0 : Int8) ? None : Some x; g (f (b -128))',
    'g [a] = a; b x = (x : UInt8) - (1 : UInt8) > (0 : UInt8) ? None : Some x; g (f (b 0))',
    'g [a] = a; b x = (x : Int8) > (0 : Int8) ? None : Some x; g (f (b 2.5))',
    'h v = v : Int8; h "x"',
]) Deno.test(`fixed-width conditions stay checked: ${source}`, () => rejected(session(), `${optionClauses}\n${source}`));
// A known value decides a typed clause as at runtime: its own type (30), a
// lossless conversion (1), or no match.
const intClauses = 'g [a] = a; k (x : Int) = None; k x = Some x';
for (const [source, expected] of [
    ['g (f (k (3 : UInt)))', '0'],
    ['g (f (k (3 : Int8)))', '0'],
    ['g (f (k (2 : Float32)))', '0'],
    ['k8 (x : Int8) = None; k8 x = Some x; g (f (k8 2.0))', '0'],
    ['z = 2 : UInt; g (f (k z))', '0'],
    ['h v = g (f (k (v : UInt))); h 4', '0'],
    ['k8 (x : Int8) = None; k8 x = Some x; g (f (k8 4))', '0'],
    ['m (x : Int8) = x + (1 : Int8); m x = 0 : Int8; g (f (m 4 > (4 : Int8) ? None : Some 1))', '0'],
] as const) Deno.test(`lossless typed clauses: ${source}`, () => {
    const actual = run(session(), `${optionClauses}\n${intClauses}\n${source}`);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'g (f (k 2.5))',
    'g (f (k (1 / 2)))',
    'g (f (k "s"))',
    'k8 (x : Int8) = None; k8 x = Some x; g (f (k8 300))',
]) Deno.test(`lossless typed clauses stay checked: ${source}`, () => rejected(session(), `${optionClauses}\n${intClauses}\n${source}`));
// The builtin length of a list or String is known when its size is: from a
// literal, a parameter at its calls, cons, append, shaped builtins (map, sort)
// and recursion over list patterns.
const sizeClauses = 'std <- import "std"\nuse std.[option,sequence,number]\ng [a] = a; sm n = n < 2 ? None : Some n\n'
    + 'q xs = length xs < 2 ? None : Some 1; len [] = 0; len (x::xs) = 1 + len xs';
for (const [source, expected] of [
    ['g (f (sm (length [1])))', '0'],
    ['k (x : Int) = None; k x = Some x; g (f (k (length [1])))', '0'],
    ['n = [1]; g (f (sm (length n)))', '0'],
    ['g (f (sm (length "a")))', '0'],
    ['hh xs = g (f (sm (length xs))); hh [5]', '0'],
    ['hh xs = g (f (sm (length xs - 1))); hh [5,6]', '0'],
    ['hh s = g (f (sm (length s))); hh "a"', '0'],
    ['hh ys = g (f (q ys)); hh [1]', '0'],
    ['hh ys = g (f (q (1 :: ys))); hh []', '0'],
    ['hh ys = g (f (q (map (+ 1) ys))); hh [1]', '0'],
    ['hh ys = g (f (q (sort ys))); hh [1]', '0'],
    ['g (f (sm (len [1])))', '0'],
    ['hh ys = g (f (sm (len ys))); hh [3]', '0'],
    // A known value has its own type: "a" a String, though it is also true.
    ['ln (s : String) = 1; ln xs = 3; hh s = g (f (sm (ln s))); hh "a"', '0'],
] as const) Deno.test(`length calls: ${source}`, () => {
    const actual = run(session(), `${optionClauses}\n${sizeClauses}\n${source}`);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'g (f (sm (length [1,2,3])))',
    'g (f (sm (length [1] + 1)))',
    'g (f (sm (length "ab")))',
    'hh xs = g (f (sm (length xs))); hh [5,6]',
    'hh ys = g (f (q ys)); hh [1,2]',
    'hh ys = g (f (q (1 :: ys))); hh [2]',
    'hh ys = g (f (q (ys ++ ys))); hh [2]',
    'ln (b : Bool) = 1; ln xs = 3; hh s = g (f (sm (ln s))); hh "a"',
    'hh ys = g (f (q (map (+ 1) ys))); hh [1,2]',
    'g (f (sm (len [1,2])))',
    // A predicate whose value stays unknown decides nothing: both clauses count.
    'g (f (q (filter (x -> x > sum [1..1000000]) [1,2])))',
]) Deno.test(`length calls stay checked: ${source}`, () => rejected(session(), `${optionClauses}\n${sizeClauses}\n${source}`));
// filter, map, take and drop over lists whose elements are known run as at
// runtime, as do integer ranges.
for (const [source, expected] of [
    ['g (f (q (filter (> 1) [1,2])))', '0'],
    ['g (f (q (filter (> 2) (map (* 2) [1,2]))))', '0'],
    ['big x = x > 1; g (f (q (filter big [1,2])))', '0'],
    ['g (f (q (filter (x -> x % 2 == 0) [1..3])))', '0'],
    ['hh ys = g (f (q (filter (> 1) ys))); hh [1,5]', '0'],
    ['hh n = g (f (q (filter (> n) [1,2,3]))); hh 2', '0'],
    ['g (f (q (take 1 [1,2,3])))', '0'],
    ['hh n = g (f (q (take n [5,6]))); hh 1', '0'],
    ['hh n = g (f (q (drop n [5,6]))); hh 1', '0'],
    ['hh n = g (f (q [1..n])); hh 1', '0'],
    ['g (f (q [3..3]))', '0'],
] as const) Deno.test(`list builtin lengths: ${source}`, () => {
    const actual = run(session(), `${optionClauses}\n${sizeClauses}\n${source}`);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'g (f (q (filter (> 1) [1,2,3])))',
    'g (f (q (filter (x -> x % 2 == 0) [1..5])))',
    'hh ys = g (f (q (filter (> 1) ys))); hh [3,5]',
    'hh n = g (f (q (filter (> n) [1,2,3]))); hh 1',
    'g (f (q (take 2 [1,2,3])))',
    'hh n = g (f (q (drop n [5,6]))); hh 0',
    'hh n = g (f (q [1..n])); hh 0',
    'g (f (q (take -1 [1])))',
]) Deno.test(`list builtin lengths stay checked: ${source}`, () => rejected(session(), `${optionClauses}\n${sizeClauses}\n${source}`));
// zip, zipWith and takeWhile; functions passed as arguments are applied too.
for (const [source, expected] of [
    ['g (f (q (zip [1] [2,3])))', '0'],
    ['g (f (q (zipWith (+) [1] [2,3])))', '0'],
    ['hh xs = g (f (q (zip xs [7,8]))); hh [1]', '0'],
    ['g (f (q (takeWhile (< 2) [1,2,3])))', '0'],
    ['g (f (q (takeWhile (> 5) [1..20])))', '0'],
    ['hh n = g (f (q (takeWhile (< n) [1,2,3]))); hh 2', '0'],
    ['hh xs = g (f (q (takeWhile (< 2) xs))); hh [1,5,0]', '0'],
    ['g (f (q (takeUntil (> 1) [1,2])))', '0'],
    ['hh p = g (f (q (filter p [1,2]))); hh (> 1)', '0'],
    ['big x = x > 1; hh p = g (f (q (filter p [1,2]))); hh big', '0'],
    ['hh p = g (f (q (takeWhile p [1,2,3]))); hh (< 2)', '0'],
    ['g (f (q (filter (x -> head x > 1) [[1],[2]])))', '0'],
    ['g (f (q (tail [1,2])))', '0'],
    ['f2 [] = [0]; f2 xs = [1,2]; g (f2 (tail [1]))', '0'],
    // A recursive call with a literal list does not fix an open parameter length.
    ['tw xs = null xs ? [] : tw []; length (tw [1,2])', '0'],
] as const) Deno.test(`zip and takeWhile lengths: ${source}`, () => {
    const actual = run(session(), `${optionClauses}\n${sizeClauses}\n${source}`);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'g (f (q (zip [1,2] [2,3])))',
    'g (f (q (takeWhile (< 3) [1,2,3])))',
    'g (f (q (takeWhile (> 0) [1..20])))',
    'hh n = g (f (q (takeWhile (< n) [1,2,3]))); hh 3',
    'hh p = g (f (q (filter p [1,2]))); hh (> 0)',
    // A recursive call still has to fit a parameter whose pattern fixes a length.
    'h [a] = h [a,a]; h [1]',
]) Deno.test(`zip and takeWhile lengths stay checked: ${source}`, () => rejected(session(), `${optionClauses}\n${sizeClauses}\n${source}`));
// The pure builtins and the standard library written in APN (folds, endless
// lists, text, local definitions) are evaluated on known values too.
const textClauses = 'std <- import "std"; use std.text; r b = b ? None : Some 1';
for (const [source, expected] of [
    ['g (f (q (dropWhile (< 2) [1,2])))', '0'],
    ['g (f (q (words "a")))', '0'],
    ['hh s = g (f (q (words s))); hh "x"', '0'],
    ['g (f (q (splitOn "," "a")))', '0'],
    ['g (f (r (trim "  a " == "a")))', '0'],
    ['g (f (r (to String 12 == "12")))', '0'],
    ['g (f (r (to String [1,2] == "[1,2]")))', '0'],
    ['g (f (r (reverse "ab" == "ba")))', '0'],
    ['g (f (r (upper "a" == "A")))', '0'],
    ['g (f (r (contains 2 [1,2])))', '0'],
    ['g (f (r (all (> 0) [1,2])))', '0'],
    ['g (f (r (isSome (find (> 1) [1,2]))))', '0'],
    ['g (f (r (sum [1,2] == 3)))', '0'],
    ['g (f (r (foldr (x, acc -> x + acc) 0 [1,2] == 3)))', '0'],
    ['g (f (q (take 1 (repeat 0))))', '0'],
    ['g (f (q (take 1 [0..])))', '0'],
    ['g (f (q (filter (> 3) (take 5 [0..]))))', '0'],
    ['g (f (r (isPrime 7)))', '0'],
    ['g (f (q (sort [3])))', '0'],
    ['local n = { k = n + 1; twice x = x * 2; twice k }; g (f (r (local 1 == 4)))', '0'],
    // (t x) takes any value, a number without its explicit type: a strict
    // accumulator, as a fold reads it each step.
    ['h (x : _) = x + 1; g (f (r (h 2 == 3 && h (2 : Int32) == 3)))', '0'],
    ['fs f (acc : _) [] = acc; fs f (acc : _) (x :: rest) = fs f (f acc x) rest\ng (f (r (fs (+) 0 [1,2] == 3)))', '0'],
    // A list's tail is computed when read: the [] three steps in is found
    // before the fourth step, tl [], which fails, is ever taken.
    ['nl [] = True; nl (_ :: _) = False; tl (_ :: r) = r; it h x = x :: it h (h x)\n' +
        'fi p (x :: rest) = p x ? x :: fi p rest : fi p rest; g (f (q (head (fi nl (it tl [1,2])))))', '0'],
] as const) Deno.test(`builtins and std evaluated: ${source}`, () => {
    const actual = run(session(), `${optionClauses}\n${sizeClauses}\n${textClauses}\n${source}`);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'g (f (q (dropWhile (< 2) [1,2,3])))',
    'g (f (q (words "a b")))',
    'hh s = g (f (q (words s))); hh "x y"',
    'g (f (r (trim "  a " == "b")))',
    'g (f (r (any (> 5) [1,2])))',
    'g (f (r (isPrime 8)))',
    'fs f (acc : _) [] = acc; fs f (acc : _) (x :: rest) = fs f (f acc x) rest\ng (f (r (fs (+) 0 [1,2] == 4)))',
    // enumerate pairs each element with its index: [0, 7] has two elements.
    'g (f (q (head (enumerate [7]))))',
    'g (f (q (sort [3,1])))',
]) Deno.test(`builtins and std evaluated stay checked: ${source}`, () => rejected(session(), `${optionClauses}\n${sizeClauses}\n${textClauses}\n${source}`));
// from String reads booleans and numbers as at runtime; recursion is evaluated as
// deep as the runtime's own stack allows (non-tail recursion to depth 500).
const deepClauses = 'count n = n == 0 ? 0 : 1 + count (n - 1); upto n = n == 0 ? [] : n :: upto (n - 1)';
for (const [source, expected] of [
    ['g (f (r (from String "12" == 12)))','0'],
    ['g (f (r (from String " True ")))','0'],
    ['g (f (r (from String "1/2" == 0.5)))','0'],
    ['g (f (q (integers "4")))','0'],
    ['g (f (r (count 500 == 500)))','0'],
    ['g (f (r (length (upto 450) == 450)))','0'],
    ['g (f (r (len [1..400] == 400)))','0'],
    ['g (f (r (sum (map (* 2) [1..5000]) == 25005000)))','0'],
    ['g (f (r (isPrime 7919)))','0'],
    ['g (f (q (take 1 (repeat 0))))','0'],
] as const) Deno.test(`parse and deep recursion: ${source}`, () => {
    const actual = run(session(), `${optionClauses}\n${sizeClauses}\n${textClauses}\n${deepClauses}\n${source}`);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'g (f (r (from String "x" == 1)))',
    'g (f (q (integers "4 5")))',
    'g (f (r (length (upto 450) == 449)))',
    'g (f (q (takeWhile (< 300) [1..])))',
    'g (f (q (take 2 (repeat 0))))',
]) Deno.test(`parse and deep recursion stay checked: ${source}`, () => rejected(session(), `${optionClauses}\n${sizeClauses}\n${textClauses}\n${deepClauses}\n${source}`));
// A count, a drop and a left fold written in APN, walking a list cell by cell.
const WALKS = 'cn [] n = n; cn (_ :: rest) (n : Int) = cn rest (n + 1)\n' +
    'dr _ [] = []; dr 0 (x :: rest) = x :: rest; dr (n : Int) (_ :: rest) = dr (n - 1) rest\n' +
    'fs f acc [] = acc; fs f acc (x :: rest) = fs f (f acc x) rest\n';
// A name a block binds twice is one binding: lazy definitions and closures
// see its latest value, eager ones (<-) the value where they stand. Long lists
// are walked within the work budget; ranges are cut arithmetically.
for (const [source, expected] of [
    ['local n = { k = n; k = 5; k }; g (f (r (local 1 == 5)))','0'],
    ['k y = { x = 1; h = () -> x; x = 5; h [] }; g (f (r (k 0 == 1)))','0'],
    ['x = 10; k y = { z = x + 1; x = 2; z }; g (f (r (k 0 == 11)))','0'],
    ['k y = { a = 1; b = a; a = 2; b }; g (f (r (k 0 == 1)))','0'],
    ['k y = { a <- return 1; b <- return (a + 1); a <- return 5; return b }\nw <- k 0\ng (f (r (w == 2)))','0'],
    ['k y = { a <- return 1; a <- return (a + 1); return a }; w <- k 0; g (f (r (w == 2)))','0'],
    ['k y = { n = 1; h q = q + n; n = 10; h 1 }; g (f (r (k 0 == 2)))','0'],
    ['k y = { a = 1; b <- return a; a = 2; return [a,b] }; w <- k 0; g (f (r (w == [2,1])))','0'],
    ['k y = { xs = 1 :: xs; length (take 3 xs) }; g (f (r (k 0 == 3)))','0'],
    ['g (f (r (([a,b] -> a) [1,2] == 1)))','0'],
    ['g (f (r (length [1..1000000] == 1000000)))','0'],
    ['g (f (r (head (drop 1000000 [0..]) == 1000000)))','0'],
    ['g (f (q (tail (take 1 (drop 20000 [0..])))))','0'],
    ['g (f (r (sum [1..20000] == 200010000)))','0'],
    ['g (f (r (length (filter (> 15000) [1..20000]) == 5000)))','0'],
    ['g (f (r ([5,3..0] == [5,3,1])))','0'],
    // A function that walks a range, counting, skips through it: cn counts,
    // dr drops until its count reaches 0, both written in APN. (Checked, not
    // run: the run, lazy, never needs checked.)
    [`${WALKS}checked = g (f (r (cn [1..10000000000] 0 == 10000000000)))\n0`, '0'],
    [`${WALKS}checked = g (f (r (cn [1,3..2000001] 0 == 1000001)))\n0`, '0'],
    [`${WALKS}checked = g (f (r (head (dr 1000000 [0..]) == 1000000)))\n0`, '0'],
    // A fold looks at each element, but its tail calls take no depth: as at
    // runtime, a tail-recursive walk of any length stays at one depth.
    [`${WALKS}checked = g (f (r (fs (+) 0 [1..20000] == 200010000)))\n0`, '0'],
] as const) Deno.test(`rebinding blocks and long lists: ${source}`, () => {
    const actual = run(session(), `${optionClauses}\n${sizeClauses}\n${textClauses}\n${source}`);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'k y = { x = 1; h = () -> x; x = 5; h [] }; g (f (r (k 0 == 5)))',
    'k y = { a = 1; b = a; a = 2; b }; g (f (r (k 0 == 2)))',
    'k y = { a <- return 1; b <- return (a + 1); a <- return 5; return b }\nw <- k 0\ng (f (r (w == 6)))',
    'g (f (r (length [1..1000000] == 999999)))',
    'g (f (r (sum [1..20000] == 0)))',
]) Deno.test(`rebinding blocks and long lists stay checked: ${source}`, () => rejected(session(), `${optionClauses}\n${sizeClauses}\n${textClauses}\n${source}`));
// Skipped through, a wrong count is a length mismatch the checker finds, not
// a value it cannot decide.
for (const source of [
    `${WALKS}g (f (r (cn [1..10000000000] 0 == 9999999999)))`,
    `${WALKS}g (f (r (head (dr 1000000 [0..]) == 0)))`,
    `${WALKS}g (f (r (fs (+) 0 [1..20000] == 1)))`,
]) Deno.test(`a walk skipped through is decided: ${source}`, () => {
    try { run(session(), `${optionClauses}\n${sizeClauses}\n${textClauses}\n${source}`); } catch (error) {
        if ((error as Error).message.includes("length mismatch")) return;
        throw error;
    }
    throw new Error(`accepted: ${source}`);
});
// Effects are not performed, but their results are known. Mutable cells keep
// their contents unless code in the session can write one (set, load, use).
const effectPrelude = `${optionClauses}\n${sizeClauses}\n${textClauses}`;
for (const [source, expected] of [
    ['v <- print 3; g (f (r (null v)))','0'],
    ['v <- emit 3; g (f (r (null v)))','0'],
    ['g (f (r (assert True True)))','0'],
    ['g (f (r (null (debug 4))))','0'],
    ['k y = { c = Mutable 5; c + 1 }; g (f (r (k 0 == 6)))','0'],
    ['c = Mutable 5; g (f (r (c + 1 == 6)))','0'],
] as const) Deno.test(`effects and cells: ${source}`, () => {
    const actual = run(session(), `${effectPrelude}\n${source}`);
    if (actual !== expected.trim()) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'k y = { c = Mutable 5; c + 1 }; g (f (r (k 0 == 7)))',
    'k y = { c = Mutable 1; h = () -> c + 0; set c 2; return (h []) }\nw <- k 0\ng (f (r (w == 1)))',
    'c = Mutable 5; bump x = set c x; g (f (r (c + 1 == 5)))',
]) Deno.test(`effects and cells stay checked: ${source}`, () => rejected(session(), `${effectPrelude}\n${source}`));
// Writes after reads follow the run's order: block statements, eager
// bindings and operands run in order, and a lazy binding is read when used.
for (const [source, expected] of [
    ['k y = { c = Mutable 1; set c (c + 1); set c (c * 10); return (c + 0) }\nw <- k 0\ng (f (r (w == 20)))', '0'],
    // A local cell rebinding a visible name is the block's own each run.
    ['c = 2\nk _ = { c = Mutable 1; set c (c + 1); return (c + 0) }\nw <- k 0\ng (f (r (w == 2)))', '0'],
    ['k y = { c = Mutable 1; a <- return (c + 0); set c 5; return (a + 0) }\nw <- k 0\ng (f (r (w == 1)))', '0'],
    ['k y = { c = Mutable 1; a = c + 0; set c 5; return (a + 0) }; w <- k 0; g (f (r (w == 5)))', '0'],
    ['bump c = set c (c + 1)\nk y = { c = Mutable 1; bump c; bump c; return (c + 0) }\nw <- k 0\ng (f (r (w == 3)))', '0'],
    ['k y = { c = Mutable 1; a <- return (c + 0); b <- { set c 5; return (c + 0) }; return (a + b) }\nw <- k 0\ng (f (r (w == 6)))', '0'],
    ['k y = { c = Mutable 1; h = () -> c + 0; set c 2; return (h []) }\nw <- k 0\ng (f (r (w == 2)))', '0'],
    ['sw c = { set c 9; return (c + 0) }\nk y = { c = Mutable 1; a = c + 0; s <- sw c; return (s + a) }\nw <- k 0\ng (f (r (w == 18)))', '0'],
    // List elements and call arguments that read a cell are computed when used.
    ['k y = { c = Mutable 1; xs = [c + 0]; set c 7; return (head xs) }\nw <- k 0\ng (f (r (w == 7)))', '0'],
    ['k y = { c = Mutable 1; xs = [c + 0]; v <- return (head xs + 0); set c 7; return v }\nw <- k 0\ng (f (r (w == 1)))', '0'],
    ['p x c = { set c 3; return (x + 0) }\nk y = { c = Mutable 1; p (c + 0) c }\nw <- k 0\ng (f (r (w == 3)))', '0'],
    // Top-level cells follow the statements that write them, in program order.
    ['counter = Mutable 0; set counter 4; g (f (r (counter + 0 == 4)))', '0'],
    ['counter = Mutable 0\nbump x = set counter (counter + 1)\nbump []\nbump []\ng (f (r (counter + 0 == 2)))', '0'],
    ['counter = Mutable 0\nset counter 4\nprint (counter + 0)\nset counter 9\ng (f (r (counter + 0 == 9)))', '0'],
    ['counter = Mutable 2; set counter (counter * 5); g (f (r (counter + 0 == 10)))', '0'],
    // A statement that writes and reads top-level cells: each part has the
    // value the statement's static run gave it, in the run's order.
    ['counter = Mutable 0\nk y = { set counter 4; return (counter + 0) }\nw <- k 0\ng (f (r (w == 4)))', '0'],
    ['counter = Mutable 0\nbump x = { set counter (counter + 1); return (counter + 0) }\na <- return (counter + 0)\nb <- bump 0\ng (f (r (a + b == 1)))', '0'],
    ['counter = Mutable 0\nbump x = { set counter (counter + 1); return (counter + 0) }\nb <- bump 0\ng (f (r (b + (counter + 0) == 2)))', '0'],
    ['counter = Mutable 0\nbump x = { set counter (counter + 1); return (counter + 0) }\nb <- bump 0\nprint [b, counter + 0]\ng (f (r (counter + 0 == 1)))', '0'],
    ['use std.function\ncounter = Mutable 0\nbump x = { set counter (counter + 1); return (counter + 0) }\nseq (bump 0) []\ng (f (r (counter + 0 == 0)))', '0'],
    // Values a statement leaves unforced are harmless unless kept; a kept one
    // is forced (once) where a later statement forces it. An uncertain
    // statement only affects the cells and values it can reach.
    ['counter = Mutable 0; xs <- return [set counter 9, 1]; g (f (r (counter + 0 == 0)))', '0'],
    ['counter = Mutable 0\nbox = Mutable [set counter 0]\nset box [set counter 3]\nprint (length box)\ng (f (r (counter + 0 == 0)))', '0'],
    ['counter = Mutable 0\nbox = Mutable [set counter 0]\nset box [set counter 3]\nhead box\ng (f (r (counter + 0 == 3)))', '0'],
    ['counter = Mutable 0\nbox = Mutable [set counter 0]\nset box [set counter 3]\nhead box\nset counter 8\nhead box\ng (f (r (counter + 0 == 3)))', '0'],
    ['counter = Mutable 0\nother = Mutable 7\nm = ([["a", 1]] : HashMap _ _)\nhas "a" m ? set counter 5 : return []\ng (f (r (other + 0 == 7)))', '0'],
    // Lazily computed elements run where the program forces them: map's
    // elements when used, filter's predicate as its cells are reached.
    ['counter = Mutable 0; print (length (map (x -> set counter x) [1,2])); g (f (r (counter + 0 == 0)))', '0'],
    ['counter = Mutable 0; do (map (x -> set counter x) [1,2]); g (f (r (counter + 0 == 2)))', '0'],
    ['counter = Mutable 0\nbump x = set counter (counter + 1)\nxs = map (x -> bump x) [1,2]\nprint (length xs)\ng (f (r (counter + 0 == 0)))', '0'],
    ['counter = Mutable 0\nbump x = set counter (counter + 1)\nhead (map (x -> bump x) [1,2])\ng (f (r (counter + 0 == 1)))', '0'],
    ['counter = Mutable 0\nbump x = set counter (counter + 1)\ndo (take 1 (map (x -> bump x) [1..]))\ng (f (r (counter + 0 == 1)))', '0'],
    // A top-level action builds its list afresh at each use; a value keeps it.
    ['counter = Mutable 0\nbump x = set counter (counter + 1)\nxs = map (x -> bump x) [1,2]\ndo xs\ndo xs\ng (f (r (counter + 0 == 4)))', '0'],
    ['counter = Mutable 0\nbump x = set counter (counter + 1)\nys = [bump 0, bump 0]\ndo ys\ng (f (r (counter + 0 == 2)))', '0'],
    // An uncertain statement reaching a lazily computed list follows what it is computed from.
    ['counter = Mutable 0\nother = Mutable 7\nys = map (x -> x * 2) [1,2]\nm = ([["a", 1]] : HashMap _ _)\nhas "a" m ? set counter (head ys) : return []\ng (f (r (other + 0 == 7)))', '0'],
    // A load reaches only what the loaded file's source names.
    ['counter = Mutable 0\nother = Mutable 7\nset other 8\nload "examples/advent-of-code/lanternfish"\ng (f (r (other + 0 == 8)))','0'],
    // A name use opened reaches the field it was opened from.
    ['counter = Mutable 0\nother = Mutable 7\nns = [bump = x -> set counter 3]\nuse ns\nm = ([["a", 1]] : HashMap _ _)\nhas "a" m ? bump 0 : return []\ng (f (r (other + 0 == 7)))','0'],
    // A function held by a pattern binding runs its body where it is called.
    ['counter = Mutable 0\nother = Mutable 7\nhb <- return (x -> 0)\ny <- return (hb 0)\ng (f (r (other + 0 == 7)))','0'],
    // Keys bound locally, and views stored in records, lists and cells or
    // passed to functions, reach the bindings their uses name.
    // A top-level value (an application or pipe that is not an action too:
    // xs = map ... is a list, kept) is computed when first used and kept; a
    // top-level action (a block, or an application yielding one) runs at each use.
    ['counter = Mutable 0; snap = counter + 0; set counter 4; g (f (r (snap + 0 == 4)))','0'],
    ['counter = Mutable 0\nsnap = counter + 0\nset counter 4\nprint snap\nset counter 9\ng (f (r (snap + 0 == 4)))','0'],
    ['counter = Mutable 0\nsnap = counter + 0\nset counter 4\nh x = snap + x\nset counter 9\ng (f (r (h 0 == 9)))','0'],
    ['counter = Mutable 0\na = counter + 0\nb = a + 1\nset counter 3\nprint a\nset counter 8\ng (f (r (b + 0 == 4)))','0'],
    ['counter = Mutable 0\ninit = set counter 5\ninit\nset counter 1\ninit\ng (f (r (counter + 0 == 5)))','0'],
    ['counter = Mutable 0; init = set counter 5; set counter 1; g (f (r (counter + 0 == 1)))','0'],
    ['counter = Mutable 0\nsnap = { counter + 0 }\nset counter 2\nprint snap\nset counter 7\ng (f (r (snap + 0 == 7)))','0'],
    // A writer passed by value runs where it is called.
    ['counter = Mutable 0\ntwice h = { h []; h [] }\ntwice (_ -> set counter (counter + 3))\ng (f (r (counter + 0 == 6)))','0'],
] as const) Deno.test(`cells written after reads: ${source}`, () => {
    const actual = run(session(), `${effectPrelude}\n${source}`);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'k y = { c = Mutable 1; set c (c + 1); set c (c * 10); return (c + 0) }\nw <- k 0\ng (f (r (w == 21)))',
    'k y = { c = Mutable 1; a <- return (c + 0); set c 5; return (a + 0) }\nw <- k 0\ng (f (r (w == 5)))',
    'k y = { c = Mutable 1; a = c + 0; set c 5; return (a + 0) }; w <- k 0; g (f (r (w == 1)))',
    'sw c = { set c 9; return (c + 0) }\nk y = { c = Mutable 1; a = c + 0; s <- sw c; return (s + a) }\nw <- k 0\ng (f (r (w == 10)))',
    'counter = Mutable 0; set counter 4; g (f (r (counter + 0 == 0)))',
    'counter = Mutable 0\nbump x = set counter (counter + 1)\nbump []\nbump []\ng (f (r (counter + 0 == 1)))',
    'counter = Mutable 0\nbump x = { set counter (counter + 1); return (counter + 0) }\na <- return (counter + 0)\nb <- bump 0\ng (f (r (a + b == 2)))',
    'counter = Mutable 0\nbump x = { set counter (counter + 1); return (counter + 0) }\nb <- bump 0\nprint [b, counter + 0]\ng (f (r (counter + 0 == 0)))',
    'counter = Mutable 0; do (map (x -> set counter x) [1,2]); g (f (r (counter + 0 == 1)))',
    'counter = Mutable 0\nbump x = set counter (counter + 1)\nxs = map (x -> bump x) [1,2]\ndo xs\ndo xs\ng (f (r (counter + 0 == 2)))',
    'k y = { c = Mutable 1; xs = [c + 0]; set c 7; return (head xs) }\nw <- k 0\ng (f (r (w == 1)))',
    'counter = Mutable 0\nk y = { set counter 4; return (counter + 0) }\nw <- k 0\ng (f (r (w == 0)))',
    'counter = Mutable 0; xs <- return [set counter 9, 1]; g (f (r (counter + 0 == 9)))',
    // A statement whose run is uncertain leaves what it can reach unknown.
    'counter = Mutable 0\nm = ([["a", 1]] : HashMap _ _)\nhas "a" m ? set counter 5 : return []\ng (f (r (counter + 0 == 5)))',
    // A function held by a pattern binding runs its body where it is called.
    'counter = Mutable 0\nother = Mutable 7\nhb <- return (x -> { set other 1; return 0 })\nhb 0\ng (f (r (other + 0 == 7)))',
    'counter = Mutable 0\nother = Mutable 7\nhs <- return [x -> { set other 1; return 0 }]\nhead hs 0\ng (f (r (other + 0 == 7)))',
    'counter = Mutable 0\nother = Mutable 7\npick n = n > 0 ? x -> { set other 1; 0 } : x -> 0\nhb <- return (pick 1)\nm = ([["a", 1]] : HashMap _ _)\nhas "a" m ? hb 0 : 0\ng (f (r (other + 0 == 7)))',
    'counter = Mutable 0\nother = Mutable 7\n[ha,hb] <- return [x -> return 0, x -> { set other 1; return 0 }]\nhb 0\ng (f (r (other + 0 == 7)))',
    // A name use opened reaches the field it was opened from.
    'counter = Mutable 0\nother = Mutable 7\nns = [bump = x -> set other 3]\nuse ns\nm = ([["a", 1]] : HashMap _ _)\nhas "a" m ? bump 0 : return []\ng (f (r (other + 0 == 7)))',
    'counter = Mutable 0\nother = Mutable 7\nns = [bump = x -> set counter 3]\nuse ns\nm = ([["a", 1]] : HashMap _ _)\nhas "a" m ? bump 0 : return []\ng (f (r (counter + 0 == 0)))',
    'counter = Mutable 0; snap = counter + 0; set counter 4; g (f (r (snap + 0 == 0)))',
    'counter = Mutable 0\nsnap = counter + 0\nset counter 4\nprint snap\nset counter 9\ng (f (r (snap + 0 == 9)))',
    'counter = Mutable 0\ninit = set counter 5\ninit\nset counter 1\ninit\ng (f (r (counter + 0 == 1)))',
]) Deno.test(`cells written after reads stay checked: ${source}`, () => rejected(session(), `${effectPrelude}\n${source}`));
for (const source of ['x::xs = []', 'x::y::z = [1]', 'f n = { x::xs = []; x }']) Deno.test(`a cons binding of a list known too short is rejected: ${source}`, () => rejected(session(), source));
Deno.test("an unknown constructor in a pattern is named, with the module that declares it", () => {
    for (const [source, message, hint] of [
        ["func (Some x::xs) = print [x,xs]", "unknown constructor 'Some' in a pattern", "add `std <- import \"std\"; use std.option` to use `Some`"],
        ["print None", "unbound variable 'None'", "add `std <- import \"std\"; use std.option` to use `None`"],
        // In code too: a name the library defines is a missing import, not open code.
        ["print [x <- Some 1, return x]", "unbound variable 'Some'", "add `std <- import \"std\"; use std.option` to use `Some`"],
        ["print [y + 1]", "unbound variable 'y'", "bind it in code joined before this"],
        ["Option a = Some a | None; k (Smoe x) = x", "unknown constructor 'Smoe' in a pattern", "did you mean 'Some'?"],
    ]) {
        try { run(session(), source); } catch (error) {
            const e = error as { message: string; hint?: string };
            if (e.message !== message || !e.hint?.includes(hint)) throw new Error(`${source}: ${e.message} (${e.hint})`);
            continue;
        }
        throw new Error(`accepted: ${source}`);
    }
    if (run(session(), 'std <- import "std"\nuse std.option\nfunc (Some x::xs) = [x,xs]; func [Some 1, None]') !== "[1, [None]]") throw new Error("with the import");
});
// An unbound name is reported where it is written, with the standard module
// exporting it, before any check of what it would have been.
for (const [source, name, module] of [
    ["perItem total count =\n    okOr \"no items\" (safeDiv total count)\n        >>= share -> Ok share", "okOr", "option"],
    ["x = 1\nprint (sum [1,2])", "sum", "sequence"],
    ["f x = nothere x >>= y -> [y]", "nothere", undefined],
] as const) Deno.test(`an unbound name is located and named: ${JSON.stringify(source)}`, () => {
    try { run(session(), source); } catch (error) {
        const e = error as { message: string; hint?: string; pos?: number };
        if (e.message !== `unbound variable '${name}'` || e.pos !== source.indexOf(name) || module && e.hint !== `add \`std <- import "std"; use std.${module}\` to use \`${name}\``) throw new Error(`${e.pos}: ${e.message} (${e.hint})`);
        return;
    }
    throw new Error(`accepted: ${source}`);
});
Deno.test("a set from an earlier REPL input keeps later cell reads unknown", () => {
    const i = session();
    run(i, `${effectPrelude}\nm = Mutable 5\nbump c = set c 9`);
    rejected(i, 'g (f (r (m + 1 == 6)))');
    // A cell the input makes is its own: nothing before can have written it.
    run(i, 'g (f (r (Mutable 5 + 1 == 6)))');
});
// When checking right before a run, readFile and getArgs see the program's
// input; the run reads the same snapshot. Lint and editor checks do not.
const fish = "examples/advent-of-code/samples/fish.input", hill = "examples/advent-of-code/samples/hill.input";
const inputPrelude = `std <- import "std"; use std.io; ${effectPrelude}`;
// Over input the checker cannot know, a fold keeps the length its step keeps:
// splitOn's state is [fields, current] at every step.
Deno.test("a fold keeps a length its step keeps, over unknown input", () => {
    const source = `std <- import "std"; use std.io\n${FL}fst [a,b] = a; step [a,b] x = [x :: a, b]\n` +
        'input <- readInput\nprint (fst (fl step [[],[]] (to (List Char) input)))';
    // Checked as an example is, without the input it will read.
    new CheckingSession().prepare(parse(source, "fold.apn"), Deno.cwd(), Deno.cwd());
});
Deno.test("readFile is read when checking before a run", () => {
    const actual = run(session(), `${inputPrelude}\ntext <- readFile "${fish}"; g (f (q (words text)))`);
    if (actual !== "0") throw new Error(actual);
    rejected(session(), `${inputPrelude}\ntext <- readFile "${hill}"; g (f (q (words text)))`);
});
Deno.test("getArgs and readInput see the program's arguments", () => {
    const one = session();
    one.programArgs = [fish];
    if (run(one, `${inputPrelude}\nargs <- getArgs; g (f (q args))`) !== "0") throw new Error("getArgs");
    if (run(one, `${inputPrelude}\ntext <- readInput; g (f (q (words text)))`) !== "0") throw new Error("readInput");
    const two = session();
    two.programArgs = [hill, "x"];
    rejected(two, `${inputPrelude}\nargs <- getArgs; g (f (q args))`);
});
Deno.test("readStdin is read when the run's stdin is not interactive", () => {
    const check = (stdin: string | undefined) => {
        const c = new CheckingSession();
        c.inputs = { readFile: () => undefined, args: () => [], readStdin: () => stdin };
        try { c.prepare(parse(`${inputPrelude}\ntext <- readStdin; g (f (q (words text)))`), "."); return true; }
        catch { return false; }
    };
    if (!check("one\n")) throw new Error("one word rejected");
    if (check("one two\n")) throw new Error("two words accepted");
    // A terminal is never read ahead: the value stays unknown.
    if (check(undefined)) throw new Error("unknown stdin decided");
});
Deno.test("checking without a run does not read input", () => {
    let accepted = true;
    try { new CheckingSession().prepare(parse(`${inputPrelude}\ntext <- readFile "${fish}"; g (f (q (words text)))`), "."); }
    catch { accepted = false; }
    if (accepted) throw new Error("lint read the input file");
});
Deno.test("the run reads the file contents the checker saw", () => {
    const i = session();
    const text = Deno.readTextFileSync(fish);
    if (run(i, `std <- import "std"\nuse std.[io,text]\ncontents <- readFile "${fish}"\nwords contents`) !== `["${text.trim()}"]`) throw new Error("run");
    // One snapshot per run: the checker's read is the one the run used.
    if (i.inputFile(fish) !== text) throw new Error("snapshot");
});
// A rebinding is a new version: code written before it keeps the one it saw.
for (const [source, expected] of [
    ['c n = n * 2; f x = c x; c s = s ++ "?"; f 1', '2'],
    ['c s = s ++ "?"; f x = c x; c n = n * 2; f "a"', '"a?"'],
    ['c n = n * 2; f x = c x; c s = s ++ "?"; c n = n + 1; [f 1, c 1]', '[2,2]'],
    ['c n = n * 2; g = x -> c x; c s = s ++ "?"; [g 1, c "a"]', '[2, "a?"]'],
    ['c n = n * 2; f x = c x; g y = f y + 1; c s = s ++ "?"; g 1', '3'],
    ['c n = n * 2; y = c 1; c s = s ++ "?"; y', '2'],
    ['c n = n * 2; y <- return (c 1); c s = s ++ "?"; y', '2'],
    ['c n = n * 2; ev 0 = c 0; ev n = od (n - 1); od 0 = 1; od n = ev (n - 1); c s = s ++ "?"; od 3', '0'],
    ['h = { c n = n * 2; f x = c x; c s = s ++ "?"; f 1 }; h', '2'],
] as const) Deno.test(`a reader keeps the version it saw: ${source}`, () => {
    if (run(session(), source) !== expected) throw new Error(source);
});
for (const source of [
    'c n = n * 2; f x = c x; c s = s ++ "?"; f "a"',
    'c n = n * 2; g = x -> c x; c s = s ++ "?"; g "a"',
    'h = { c n = n * 2; f x = c x; c s = s ++ "?"; f "a" }; h',
]) Deno.test(`a reader is checked against the version it saw: ${source}`, () => rejected(session(), source));
// A deferred typed numeric call reports at the call that supplies the value,
// or where it was written when its own definition decides it.
for (const [source, line, column] of [
    ['g (n : UInt) = n\nh x = g -x\nprint (h 2)', 3, 8],
    ['g (n : UInt) = n\nh x = g x\nd y = h "a"', 3, 7],
    ['std <- import "std"; use std.text\ng (n : UInt) = n\nh x = {\n    y = g x\n    z = upper x\n    y\n}', 4, 11],
] as const) Deno.test(`a deferred numeric call reports at line ${line}: ${source}`, () => {
    try { run(session(), source); } catch (error) {
        const { pos } = error as { pos: number };
        const before = source.slice(0, pos).split("\n");
        if (before.length !== line || before[before.length - 1].length + 1 !== column) throw new Error(`at ${before.length}:${before[before.length - 1].length + 1}`);
        return;
    }
    throw new Error("accepted");
});
// ':' adds one element (the mirror of the x:xs pattern), making a mixed list
// as a literal would when it differs from the tail's elements; joining is ++.
Deno.test("':' adds one element, mixed or not", () => {
    for (const [source, expected] of [['[1,2]::[3,4]', '[[1,2], 3, 4]'], ['[1,2]::3::[4,5]', '[[1,2], 3, 4, 5]'], ['1::["a"]', '[1, "a"]'],
            ['x::xs = [1,2]::[3,4]; [x,xs]', '[[1,2],[3,4]]'], ['length ([1,2]::[3,4])', '3'],
            ['[1]::[[3,4]]', '[[1],[3,4]]'], ['xs = [[3,4]]; [1,2,3]::xs', '[[1,2,3],[3,4]]'], ['[1,2]::[[3,4]]', '[[1,2],[3,4]]'],
            ['x::xs = [1]::[[3,4]]; x', '[1]'], ['[1,2] ++ [3,4]', '[1,2,3,4]']]) {
        if (run(session(), source) !== expected) throw new Error(source);
    }
    rejected(session(), '1::2');
});
Deno.test("a later REPL input or load rebinds a name for what comes after it", () => {
    // A later input may add clauses to a function earlier inputs use.
    const repl = session();
    run(repl, 'describe 0 = "zero"; []');
    run(repl, 'label x = describe x; []');
    run(repl, 'describe 1 = "one"; []');
    if (run(repl, 'describe 1') !== '"one"' || run(repl, 'label 0') !== '"zero"') throw new Error("clauses");
    const i = session();
    run(i, 'c n = n * 2; f x = c x; []');
    run(i, 'c s = s ++ "?"; []');
    if (run(i, 'f 1') !== '2' || run(i, 'c "a"') !== '"a?"') throw new Error("later input");
    rejected(i, 'f "a"');
    const j = session();
    j.sourceDir = new URL("./fixtures/", import.meta.url).pathname;
    run(j, 'r <- load "reload"; use r; twice x = double x; []');
    run(j, 't <- load "reload-text"; use t; []');
    if (run(j, 'twice 2') !== '4' || run(j, 'double "a"') !== '"aa"') throw new Error("load");
    rejected(j, 'twice "a"');
});
// A built-in type name on the left declares a typed binding.
for (const [source, expected] of [
    ['x : Int = 1; x', '1'],
    ['y : Float = 1; y', '1.0'],
    ['s : String = "hi"; s ++ "!"', '"hi!"'],
    ['(x : Int) <- return 5; x + 1', '6'],
    ['x : Int = 2.0; x', '2'],
    ['n : Int = -1; n', '-1'],
    ['n : UInt8 = 2 * 100; n', '200'],
    ['x : Float = -1; x', '-1.0'],
    ['g (n : Int) = n; g -1', '-1'],
    ['sqrt -1 + 2', '2+1i'],
    ['g (n : Int) = n; k = 1; g -k', '-1'],
    ['g (n : UInt) = n; k = 1; g k', '1'],
    ['g (n : UInt) = n; h x = g -x; h -2', '2'],
    ['g (n : Int) = n; h x = g -x; h 2', '-2'],
    ['h x = sqrt -x; h 1', '0+1i'],
    ['h x y = x - y; h 5 2', '3'],
    ['g (n : UInt) = n; h x = g -x; h -2', '2'],
    ['g (n : UInt) = n; h x = g x; h 2', '2'],
    ['g (n : Int) = n; h x = g x + 1; h 2', '3'],
    ['g (n : Float) = n; h x = g x; h 1', '1.0'],
    ['g (n : UInt) = n; h x = g -x; d y = h y; 1', '1'],
    ['Pt = [x : Float, y : Float]; g (p : Pt) = p.x; h x = g x; h [1,2]', '1.0'],
    ['Pt = [x : UInt, y : UInt]; g (p : Pt) = p.x; h x = g [x,-x]; h 0', '0'],
    ['Pt = [x : Float, y : Float]; g (p : Pt) = p.y; h x = g [x,x]; h 2', '2.0'],
    ['g (f : Int -> Int) = f 1; h x = g x; h (+ 1)', '2'],
    ['g [(a : UInt8), (b : UInt8)] = a + b; g [3,3]', '6'],
    ['g [(a : Float), b] = a; g [1, "x"]', '1.0'],
    ['g ((x : Float)::rest) = x; g [1,2]', '1.0'],
    ['[(a : UInt8), (b : UInt8)] = [3, 3]; a + b', '6'],
    ['(x : Float)::rest = [1,2]; x', '1.0'],
    ['g [(a : UInt8), (b : UInt8)] = a; h x = g [x, x * 100]; h 1', '1'],
    ['std <- import "std"; use std.option; g (Some (x : UInt8)) = x; g (Some 3)', '3'],
    ['std <- import "std"; use std.option; g (Some (x : Float)) = x; g (Some 1)', '1.0'],
    ['std <- import "std"; use std.option; Some (x : Float) = Some 1; x', '1.0'],
    // An imported constructor destructures without parentheses, as a declared one does.
    ['std <- import "std"\nuse std.option\nSome v = Some 123; f (Some (x : Float)) = x; [v, f (Some 1)]', '[123,1.0]'],
    ['std <- import "std"; use std.option; g (Some (x : UInt8)) = x; k = Some 3; g k', '3'],
    ['std <- import "std"; use std.option; g (Some (x : UInt8)) = x; h x = g (Some x); h 3', '3'],
    ['std <- import "std"; use std.option; g (Some (x : UInt8)) = x; h x = g x; h (Some 3)', '3'],
    ['Shape = Circle Float | Sq Float; Circle 2', 'Circle 2.0'],
    ['P = P2 Float Int | P0; P2 1 2', 'P2 1.0 2'],
    ['B = Byte UInt8 | NoByte; mk x = Byte x; mk 3', 'Byte 3'],
    ['Shape = Circle Float | Sq Float; area (Circle r) = r * r; area (Circle 2)', '4.0'],
    ['M = Named String | Clear; applyTo f = f "a"; applyTo Named', 'Named "a"'],
    ['Pair a b = MkPair a b | NoPair; g (MkPair (x : Float) (y : UInt8)) = y; g (MkPair 1 3)', '3'],
    ['Pair a b = MkPair a b | NoPair; g (MkPair (x : Float) (y : UInt8)) = x; g (MkPair 1 3)', '1.0'],
    ['P = P2 Int Int | P0; g (P2 a (y : UInt8)) = y; g (P2 1 3)', '3'],
    ['P = P2 Int Int | P0; g (P2 a (y : UInt8)) = y; h v = g (P2 1 v); h 3', '3'],
    ['P = P2 Int Int | P0; P2 a (y : UInt8) = P2 1 3; y', '3'],
    ['g (r : [x : UInt8]) = r.x; k = [x = 3]; g k', '3'],
    ['g (r : [x : UInt8]) = r.x; h r = g r; h [x = 3]', '3'],
    ['g (r : [x : UInt8]) = r.x; h v = g [x = v * 100]; h 1', '100'],
    ['Pt = [x : Float, y : Float]; g (p : Pt) = p.y; h v = g [x = v, y = v]; h 2', '2.0'],
    ['g (r : [x : UInt8, y : UInt8]) = r.y; b = [x = 1, y = 300]; g [use b, y = 2]', '2'],
    ['g (r : [x : UInt8]) = r.x; g [x = 300, use [x = 3]]', '3'],
    ['g (r : [x : UInt8, y : UInt8]) = r.x; h b = g [use b, x = 3]; h [x = 1, y = 2]', '3'],
    ['g (r : [x : UInt8]) = r.x; h v = g [use [x = v]]; h 3', '3'],
    ['f y = { x : Float = y; x * 2 }; f 1.5', '3.0'],
] as const) Deno.test(`typed binding: ${source}`, () => {
    if (run(session(), source) !== expected) throw new Error(source);
});
for (const source of ['x : Int = "a"', 'x : Int = 2.5', 'x : Int8 = 300',
    'n : UInt = -1', 'n : UInt = -1', 'n : Int = -2.5', 'n : UInt = 0 - 1', 'k = 100; n : UInt8 = k * 3', 'g (n : UInt) = n; g -1',
    'g (n : UInt) = n; g -1', 'g (n : UInt) = n; g - 1', 'g (n : Int) = n; g -2.5',
    'g (n : UInt8) = n; k = 1; g -k', 'g (n : UInt) = n; k = 1; g -k', 'g (n : UInt) = n; g (0 - 1)', 'g (n : UInt8) = n; k = 100; g (k * 3)',
    'g (n : UInt) = n; h x = g -x; h 2', 'g (n : UInt) = n; h x = g -x; d y = h (y * 2); d 1',
    'g (n : UInt) = n; h x = g -x; h 2', 'g (n : UInt) = n; h x = g x; h -2', 'g (n : UInt) = n; h x = g x; h "a"',
    'g (n : Int) = n; h x = g x; h 2.5', 'g (n : UInt) = n; h x = g -x; d y = h (y * 2); d 1',
    'g (n : UInt) = n; h x = g -x; d y = h 2; 1', 'g (n : UInt) = n; h x = g x; d y = h "a"; 1',
    'std <- import "std"; use std.text; g (n : UInt) = n; h x = { y = g x; z = upper x; y }; 1',
    'Pt = [x : UInt, y : UInt]; g (p : Pt) = p.x; h x = g [x,-x]; h 2', 'Pt = [x : UInt, y : UInt]; g (p : Pt) = p.x; h x = g x; h [2,-2]',
    'Pt = [x : Float, y : Float]; g (p : Pt) = p.x; h x = g x; h [1]', 'g (f : Int -> Int) = f 1; h x = g x; h 5', 'g (s : String) = s; h x = g x; h 1',
    'g [(a : UInt8), (b : UInt8)] = a; g [3,300]', 'g [(a : UInt8), (b : UInt8)] = a; g [3,-1]', 'g [(a : UInt8), (b : UInt8)] = a; h x = g [x, x * 100]; h 3',
    '[(a : UInt8), (b : UInt8)] = [3, 300]', 'g [(s : String), (n : Int)] = s; g [1,2]',
    'std <- import "std"\nuse std.option\ng (Some (x : UInt8)) = x; g (Some 300)', 'std <- import "std"\nuse std.option\ng (Some (x : UInt8)) = x; g (Some -1)',
    'std <- import "std"\nuse std.option\ng (Some (x : Int)) = x; g (Some 2.5)', 'std <- import "std"\nuse std.option\nSome (x : UInt8) = Some 300',
    'std <- import "std"\nuse std.option\ng (Some (x : String)) = x; g (Some 1)', 'std <- import "std"\nuse std.option\ng (Some (x : UInt8)) = x; k = Some 300; g k',
    'std <- import "std"\nuse std.option\ng (Some (x : UInt8)) = x; h x = g (Some x); h 300', 'std <- import "std"\nuse std.option\ng (Some (x : UInt8)) = x; h x = g x; h (Some 300)',
    'B = Byte UInt8 | NoByte; Byte 300', 'B = Byte UInt8 | NoByte; Byte -1', 'B = Byte UInt8 | NoByte; Byte "a"',
    'P = P2 Float Int | P0; P2 1 2.5', 'B = Byte UInt8 | NoByte; mk x = Byte x; mk 300', 'B = Byte UInt8 | NoByte; k = 300; Byte k',
    'Pair a b = MkPair a b | NoPair; g (MkPair (x : Float) (y : UInt8)) = y; g (MkPair 1 300)',
    'P = P2 Int Int | P0; g (P2 a (y : UInt8)) = y; g (P2 1 300)', 'P = P2 Int Int | P0; g (P2 a (y : UInt8)) = y; k = P2 1 300; g k',
    'P = P2 Int Int | P0; g (P2 a (y : UInt8)) = y; h v = g (P2 1 v); h 300', 'P = P2 Int Int | P0; P2 a (y : UInt8) = P2 1 300',
    'Pair a b = MkPair a b | NoPair\ng (MkPair (x : Float) (y : UInt8)) = y\nh x = g x\nh (MkPair 1 300)',
    'g (r : [x : UInt8]) = r.x; g [x = 300]', 'g (r : [x : UInt8]) = r.x; k = [x = 300]; g k', 'g (r : [x : UInt8]) = r.x; h r = g r; h [x = 300]',
    'g (r : [x : UInt8]) = r.x; h v = g [x = v * 100]; h 3', 'Pt = [x : UInt8, y : UInt8]; g (p : Pt) = p.y; g [x = 1, y = 300]',
    'g (r : [x : UInt8, y : UInt8]) = r.y; b = [x = 1, y = 300]; g [use b, x = 2]', 'g (r : [x : UInt8]) = r.x; g [use [x = 300]]',
    'g (r : [x : UInt8]) = r.x; g [x = 3, use [x = 300]]', 'g (r : [x : UInt8, y : UInt8]) = r.x; h b = g [use b, x = 300]; h [x = 1, y = 2]',
    'g (r : [x : UInt8, y : UInt8]) = r.y; h b = g [use b, x = 3]; h [x = 1, y = 300]', 'g (r : [x : UInt8]) = r.x; h v = g [use [x = v]]; h 300']) {
    Deno.test(`typed binding rejects: ${source}`, () => rejected(session(), source));
}
// A built-in type's name is a name like any other: a program may rebind it, and
// from then on Int means the program's Int (patterns, ascription, typeOf).
for (const [source, output] of [['Int = 5\nInt + 1', '6'], ['Int x y = x + y\nInt 2 3', '5'], ['Int x = x + 1\nInt 2', '3'],
    ['Int = Pos UInt | Neg UInt\ng (x : Int) = x\ng (Neg 2)', 'Neg 2'],
    ['Int = Pos UInt | Neg UInt\ntypeOf (Pos 1)', 'Int'], ['Int = Pos UInt | Neg UInt\nx = Pos 2 : Int\nx', 'Pos 2'],
    ['Bool = Yes | No\nh (b : Bool) = b\nh No', 'No']]) {
    Deno.test(`a built-in type name can be rebound: ${JSON.stringify(source)}`, () => {
        const shown = run(session(), source);
        if (shown !== output) throw new Error(`expected ${output}, got ${shown}`);
    });
}
Deno.test("a shadowed built-in type is not the program's type", () => {
    try { run(session(), 'Int = Pos UInt | Neg UInt\ng (x : Int) = x\nprint (g 5)'); }
    catch (error) { if (String(error).includes("two different types are named Int")) return; throw error; }
    throw new Error("accepted");
});

// A binding whose pattern its known value can never match is a static error,
// as a call no clause matches is.
for (const source of ["1 = 2", "[a,1] = [5,2]", 'std <- import "std"; use std.option\nNone = Some 1', '"x" = "y"']) {
    Deno.test(`a binding that can never match is rejected statically: ${JSON.stringify(source)}`, () => rejected(session(), source));
}
for (const source of ["1 = 1", "[a,1] = [5,1]", "f x = { 1 = x; x }"]) {
    Deno.test(`a binding that can match is accepted: ${JSON.stringify(source)}`, () => { run(session(), source); });
}
Deno.test("an unknown name in a type is reported as unbound", () => {
    try { run(session(), 'Msg = | Got (List missing.File)'); }
    catch (error) { if (error instanceof Error && error.message.includes("unbound variable 'missing'")) return; throw error; }
    throw new Error("accepted an unknown type");
});

// What the p5.js examples rely on, checked and run.
for (const [source, expected] of [
    // A record schema's List fields hold any length, in a list cell or a record cell.
    ['Pt = [x : Float, c : [Float,Float]]\nps = Mutable ([] : List Pt)\nset ps [[x = 1.0, c = [1.0,2.0]]]\nlength ps', '1'],
    ['B = [ns : List Int]\nb = Mutable ([ns = []] : B)\nset b [ns = [1,2]]\nb.ns', '[1,2]'],
    // A conversion of arithmetic on a parameter waits for its value.
    ['f w = w - 20 : Float\nf (3 : Number)', '-17.0'],
    ['f r = from JSON r : List Int\nf "[1, 2]"', '[1,2]'],
    // A list indexed by a lambda's parameter.
    ['f (xs : List _) = map (n -> xs n) [0..1]\nf [5,6]', '[5,6]'],
    // An overloaded operator in a function whose operands are parameters.
    ['Money = | Money Int\nMoney a + Money b = Money (a + b)\nf x y = x + y\nf (Money 1) (Money 2)', 'Money 3'],
    ['Money = | Money Int\nMoney a + Money b = Money (a + b)\nf x y = x + y\nf 1 2', '3'],
    // ... and one whose result is the parameter of a recursive call.
    ['Q (a : Int) (b : Int) = _\nQ a b + Q c d = Q (a * d + c * b) (b * d)\nf k acc = k > 3 ? acc : f (k + 1) (acc + Q 1 2)\nf 1 (Q 0 1)', 'Q 12 8'],
    ['Q a b = _\nQ a b + Q c d = Q (a * d + c * b) (b * d)\nf k acc = k > 3 ? acc : f (k + 1) (acc + Q 1 k)\nf 1 (Q 0 1)', 'Q 11 6'],
    // The checker knows what indexing gives: a list's item, a record's field,
    // or what clauses for get give.
    ['f 20 = "x"\nf n = 5\nxs = [10,20,30]\nr = [a = 20]\nf (xs 1) ++ f (xs -2) ++ f (r "a") ++ f r.a', '"xxxx"'],
    ['P (x : Float) (y : Float) = _\nget (P x y) "x" = x\nget (P x y) "y" = y\nf 2.0 = "two"\nf n = 5\np = P 1 2\nf p.y ++ f (p "x" + 1)', '"twotwo"'],
    // Clauses for a math function overload it, as for an operator.
    ['Dual = | Dual Float Float\nsin (Dual a b) = Dual (sin a) (b * cos a)\nsin (Dual 0.0 1.0)', 'Dual 0.0 1.0'],
    ['Dual = | Dual Float Float\nsin (Dual a b) = Dual (sin a) (b * cos a)\nsin 0.0', '0.0'],
    // Floats divide to a Float; a value of either of two types converts.
    ['x = 1.0 / 4.0\nr = [v = 0.5]\n{ r.v = x; r }', '[v = 0.25]'],
    ['b = True\n((b ? 1 : 2.5) : Float)', '1.0'],
    // A recursive function of a sketch, whose methods yield [].
    ['std <- import "std"; use std.p5\nb (p : Sketch) n = when (n > 2) (b p (n / 2))\nmain = sketch [draw = (p : Sketch) -> b p 120]\ntypeOf main', 'P5Program'],
    ['pairs []', '[]'],
    // A block may start with a comment line.
    ['f = {\n    # first a comment\n    1\n}\nf', '1'],
    // Comparisons stay exact (a float against an integer beyond 2^53 too).
    ['[2 ^ 53 + 1 > 9007199254740992.0, 0.5 < 1, 0.1 + 0.2 > 0.3]', '[True,True,True]'],
    // A cell holding a p5 object takes another, as itself.
    ['std <- import "std"; use std.p5\nc = Mutable (loadImage "a.png")\nset c (loadImage "b.png")\ntypeOf c', 'Mutable'],
    ['std <- import "std"; use std.glsl\nglsl (vec [Glsl "a", 1] * sin (Glsl "t"))', '"(vec2(a, 1.0) * sin(t))"'],
]) {
    Deno.test(`p5.js-example typing: ${source}`, () => {
        const actual = run(session(), source);
        if (actual !== expected) throw new Error(`${source}: ${actual}`);
    });
}
for (const source of [
    'f w = w - 20 : Float\nf "a"',
    'f (xs : List _) = map (n -> xs n) ["a"]\nf [1]',
    'f b = (b ? 1 : "a") : Int\nf True',
]) Deno.test(`p5.js-example typing rejects: ${source}`, () => rejected(session(), source));
// The checker reads the prelude's names by checking lib/prelude.apn itself.
Deno.test("the checker accepts the prelude it reads", async () => {
    const { checkTypes } = await import("../src/type-checker.ts");
    const source = await Deno.readTextFile(new URL("../lib/prelude.apn", import.meta.url));
    const issues = checkTypes(parse(source), { prelude: true }).issues;
    if (issues.length) throw new Error(issues[0].message);
});

// A refinement type, X = (p : T) | condition: T's values for which it holds
// (docs/semantics.md#refinement-types), checked by the run and, on values the
// check knows, statically.
const POSITIVE = "Positive = (n : Int) | n > 0\n", I32 = "I32 = (n : Int) | -2147483648 <= n && n <= 2147483647\n";
for (const [source, output] of [
    [POSITIVE + 'x = 3 : Positive\nx', '3'], [POSITIVE + 'f (x : Positive) = x * 2\nf 4', '8'],
    [POSITIVE + 'd (x : Positive) = "positive"\nd x = "other"\nmap d [-1,1]', '["other","positive"]'],
    [POSITIVE + '[isType Positive (3 : Positive), isType Positive 3, Int <= Positive]', '[True,False,False]'],
    [POSITIVE + 'typeOf (3 : Positive)', 'Positive'],
    [POSITIVE + 'Small = (n : Positive) | n < 10\n[typeOf (3 : Small), typeOf ((3 : Positive) : Small)]', '[Small,Small]'],
    ['Bounded lo hi = (n : Int) | lo <= n && n <= hi\nx = 5 : Bounded 1 10\nx', '5'],
    ['Ordered = ([a,b] : [Int,Int]) | a <= b\n[isType Ordered [1,2], isType Ordered [2,1]]', '[True,False]'],
    [POSITIVE + 'PosOrText = (Positive | String)\n[isType PosOrText "a", isType PosOrText (4 : Positive), isType PosOrText 4]', '[True,True,False]'],
    // A refinement of a scalar named by a capitalized name keeps its name, as
    // Int32 does: through arithmetic, its condition checked on each result,
    // while a typed pattern takes a plain value it holds, binding that value.
    [I32 + 'a = 100 : I32\n[typeOf a, typeOf (a + 1), (a : Int) + 1, a == 100]', '[I32, I32, 101, True]'],
    [I32 + 'h (x : I32) = typeOf x\nh x = "other"\n[h 5, h (5 : I32), h 1.5, h 3000000000]', '[Int,Int,"other","other"]'],
    [POSITIVE + 'Box (x : Positive) = _\nBox 2', 'Box 2'],
    ['Scalar = (n : UInt) | n <= 1114111 && (n < 55296 || n > 57343)\nc (x : Scalar) = x\nc 65', '65'],
]) {
    Deno.test(`a refinement type: ${JSON.stringify(source)}`, () => {
        const shown = run(session(), source);
        if (shown !== output) throw new Error(`expected ${output}, got ${shown}`);
    });
}
for (const [source, message] of [
    [POSITIVE + 'x = -3 : Positive', '-3 is not in Positive'], [POSITIVE + 'f (x : Positive) = x\nf -3', '-3 is not in Positive'],
    [POSITIVE + 'f (x : Positive) = x\nh y = f y\nh 0', '0 is not in Positive'],
    [POSITIVE + 'g [(a : Positive), b] = a\ng [-1,2]', '-1 is not in Positive'],
    [POSITIVE + 'k = 0 - 2\nBox (x : Positive) = _\nBox k', '-2 is not in Positive'],
    [I32 + 'a = 2000000000 : I32\na + a', '4000000000 is not in I32'], [I32 + 'x = 3000000000 : I32', '3000000000 is not in I32'],
]) {
    Deno.test(`a refinement type rejects: ${JSON.stringify(source)}`, () => {
        try { run(session(), source); } catch (error) { if (String(error).includes(message)) return; throw error; }
        throw new Error("accepted");
    });
}

// An instance's own use of its method is itself where its patterns take the
// arguments, and the method otherwise, as the run dispatches.
for (const [source, output] of [
    ['Money (m : Int) = _\nto String (Money m) = to String m\n[to String (Money 5), to String 7]', '["5","7"]'],
    ['Pair (a : Int) (b : Int) = _\nto String (Pair a b) = to String a ++ "," ++ to String b\nto String (Pair 1 2)', '"1,2"'],
    ['Tree = Leaf Int | Node Tree Tree\nmap f (Leaf x) = Leaf (f x)\nmap f (Node l r) = Node (map f l) (map f r)\nmap (+ 1) (Node (Leaf 1) (Leaf 2))',
        'Node (Leaf 2) (Leaf 3)'],
]) Deno.test(`an instance calls its method: ${JSON.stringify(source)}`, () => {
    const shown = run(session(), source);
    if (shown !== output) throw new Error(`expected ${output}, got ${shown}`);
});
