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
    ["a function type taking a function", "print (((a -> b) -> List a -> List b) == typeOf map)\nprint (typeOf map)",
        ["true", "(a -> b) -> List a -> List b"]],
    ["[Int] is positional; a list of any length is List Int", "print (List Int == typeOf [1,2,3])\nprint ([Int] == typeOf [1])\nprint (typeOf [1,\"a\"])\nprint (typeOf [1] == List)",
        ["true", "false", "List (Int | String)", "true"]],
    ["a name bound to a type is that type; any other is a variable", "a = 100\nprint ((a -> a) == typeOf (x -> x))\nt = Int\nprint ((t -> t) == typeOf ((Int x) -> x))\nprint ((t -> t) == typeOf (x -> x))",
        ["true", "true", "false"]],
    ["dotted application converts through the type", "print ((a -> a).(+ 1) 41)\nprint ((Int -> Int).(* 2) 21)", ["42", "42"]],
    ["a contract with type variables", "applyTwice ((a -> a) f) x = f (f x)\nprint (applyTwice (* 3) 2)\nfirst ((a -> b -> a) f) = f 1 \"x\"\nprint (first (x, y -> x))",
        ["18", "1"]],
    ["isType reads a lambda as a type", "print (isType (Int -> Int) (+ 1))\nprint (isType (a -> b) 5)", ["true", "false"]],
    ["a constructor field of a function type", "Counter s a = | MkCounter (s -> [a,s])\nrunCounter (MkCounter f) s = f s\nprint (runCounter (MkCounter (s -> [s,s + 1])) 5)",
        ["[5,6]"]],
] as const) Deno.test(`function types: ${name}`, () => {
    for (const checked of [true, false]) {
        const actual = run(source, checked);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${checked ? "checked" : "unchecked"}: ${JSON.stringify(actual)}`);
    }
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
    const actual = run('pick = (a -> b -> a).(x, y -> x)\nh = pick 1\nprint [h 2,h "s"]', false);
    if (JSON.stringify(actual) !== JSON.stringify(["[1,1]"])) throw new Error(JSON.stringify(actual));
});
