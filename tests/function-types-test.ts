import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

// A lambda read as a function type wherever a type is expected; List T for a
// list of any length (see docs/semantics.md, "First-class types").
function run(source: string, checked: boolean): string[] {
    const output: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
    try {
        const i = new Interpreter();
        if (checked) i.enableChecking();
        i.run(parse(source));
    } finally {
        console.log = log;
    }
    return output;
}

for (const [name, source, expected] of [
    ["a lambda equals the type it spells out", "print ((a -> a) == typeOf (x -> x))\nprint ((b -> b) == typeOf (x -> x))\nprint ((a -> a) == typeOf (x, y -> x))\nprint ((a -> b -> a) == typeOf (x, y -> x))",
        ["true", "true", "false", "true"]],
    ["a function type taking a function", "print (((a -> b) -> List a -> List a) == typeOf filter)\nprint (typeOf filter)",
        ["true", "(a -> b) -> List a -> List a"]],
    // map works on any type with a map instance: c a is that type holding a.
    ["map's type maps any functor", "print (typeOf map)\nd m = map (* 2) m\nprint (typeOf d)",
        ["(a -> b) -> c a -> c b", "a b -> a c"]],
    // f a: a type variable applied to a type, any type holding an a.
    ["a type variable applied to a type", 'print (((a -> b) -> f a -> f b) == typeOf map)\nprint (((a -> b) -> g x -> g y) == typeOf map)\nprint (((a -> b) -> List a -> List b) == typeOf map)',
        ["true", "false", "false"]],
    ["f a in a contract takes any type holding an a", 'import "option"\napply2 (((a -> b) -> f a -> f b) m) xs = m (* 2) xs\nprint [apply2 map [1, 2], apply2 map (Some 3)]\nprint (typeOf apply2)\ntwice ((f a -> f a) h) x = h (h x)\nprint (twice tail [1, 2, 3])',
        ["[[2, 4], Some 6]", "((a -> b) -> c a -> c b) -> c a -> c b", "[3]"]],
    // f a e: the type's first two parameters (as a parameter ((f a) e), as (Vec n a xs)).
    ["a type variable applied to several types", 'import "option"\nboth (((a -> b) -> f a e -> f b e) m) r = m (* 2) r\nprint [both map (Ok 3), both map (Err "no")]\nprint (typeOf both)\nk ((a -> List (f a e)) h) = h\nprint ((k (x -> [Ok x])) 1)\nprint (isType ((f a e) -> f a e) (x -> x))\nprint (isType (((f a) e) -> f a e) (x -> x))\nprint (isType (f a e -> f a e) (x -> x))',
        ['[Ok 6, Err "no"]', "((a -> b) -> c a d -> c b d) -> c a d -> c b d", "[Ok 1]", "true", "true", "true"]],
    ["[Int] is positional; a list of any length is List Int", "print (List Int == typeOf [1, 2, 3])\nprint ([Int] == typeOf [1])\nprint (typeOf [1, \"a\"])\nprint (typeOf [1] == List)",
        ["true", "false", "List (Int | String)", "true"]],
    ["a name bound to a type is that type; any other is a variable", "a = 100\nprint ((a -> a) == typeOf (x -> x))\nt = Int\nprint ((t -> t) == typeOf ((Int x) -> x))\nprint ((t -> t) == typeOf (x -> x))",
        ["true", "true", "false"]],
    ["dotted application converts through the type", "print ((a -> a).(+ 1) 41)\nprint ((Int -> Int).(* 2) 21)", ["42", "42"]],
    ["a contract with type variables", "applyTwice ((a -> a) f) x = f (f x)\nprint (applyTwice (* 3) 2)\nfirst ((a -> b -> a) f) = f 1 \"x\"\nprint (first (x, y -> x))",
        ["18", "1"]],
    ["isType reads a lambda as a type", "print (isType (Int -> Int) (+ 1))\nprint (isType (a -> b) 5)", ["true", "false"]],
    ["a constructor field of a function type", "Counter s a = | MkCounter (s -> [a, s])\nrunCounter (MkCounter f) s = f s\nprint (runCounter (MkCounter (s -> [s, s + 1])) 5)",
        ["[5, 6]"]],
] as const) Deno.test(`function types: ${name}`, () => {
    for (const checked of [true, false]) {
        const actual = run(source, checked);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${checked ? "checked" : "unchecked"}: ${JSON.stringify(actual)}`);
    }
});

for (const [source, message] of [
    ["bad (((a -> b) -> f a -> f b) m) = m (* 2) 5", "cannot use Int where f a is required"],
    ['nope ((f Int -> f Int) h) = h\nprint ((nope (x -> x)) "s")', "cannot use String where f Int is required"],
    ["two ((f a e -> f a e) h) = h\nprint ((two (x -> x)) [1])", "where f a b is required"],
    ['import "option"\ntwo (((f a e) -> f a e) h) = h\nprint ((two (x -> x)) (Some 1))', "cannot use Option Int where f a b is required"],
    ["v = [f: (* 2)]\nv.f = 1", "cannot use Int where a -> b is required"],
    ["v = [f: (g -> g 1)]\nv.f = 1", "cannot use Int where (Int -> a) -> a is required"],
    ["print ([(x -> x)] ++ 1)", "cannot append Vect 1 (a -> a) and Int"],
] as const) Deno.test(`function types: the checker rejects ${JSON.stringify(source)}`, () => {
    try { run(source, true); }
    catch (e) { if ((e as { kind?: string }).kind === "type" && String((e as Error).message).includes(message)) return; throw e; }
    throw new Error("accepted");
});
Deno.test("function types: a contract checks each call's result", () => {
    try { run('print ((a -> a).(x -> "s") 1)', false); }
    catch (e) { if (String(e).includes("function contract a -> a: the result is not Int")) return; throw e; }
    throw new Error("accepted");
});
Deno.test("function types: the checker rejects a result of another type", () => {
    try { run('print ((a -> a).(x -> "s") 1)', true); }
    catch (e) { if ((e as { kind?: string }).kind === "type") return; throw e; }
    throw new Error("accepted");
});
Deno.test("function types: each call decides the variables afresh", () => {
    const actual = run('pick = (a -> b -> a).(x, y -> x)\nh = pick 1\nprint [h 2, h "s"]', false);
    if (JSON.stringify(actual) !== JSON.stringify(["[1, 1]"])) throw new Error(JSON.stringify(actual));
});
