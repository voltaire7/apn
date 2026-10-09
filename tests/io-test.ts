import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

// Effects are IO actions: values that statements and <- bindings run.
function run(source: string, checked = true): string[] {
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
function fails(source: string, text: string, kind?: string): void {
    try { run(source); } catch (error) {
        const e = error as { message: string; hint?: string; kind?: string };
        if ((e.message.includes(text) || e.hint?.includes(text)) && (!kind || e.kind === kind)) return;
        throw error;
    }
    throw new Error(`accepted: ${source}`);
}

for (const [name, source, expected] of [
    ["a statement runs its action", 'print "hi"', ["hi"]],
    ["naming an action runs nothing", 'greet = print "hi"\nprint "first"\ngreet\ngreet', ["first", "hi", "hi"]],
    ["<- runs an action and binds its result", 'x <- { print 5; 5 }\nprint (x + 1)', ["5", "6"]],
    ["print yields []", 'x <- print 5\nprint (null x)', ["5", "true"]],
    ["<- binds a plain value as it is", "x <- 2 + 3\nprint x", ["5"]],
    ["IO wraps a block", 'sayHello = IO { print "hello" }\nsayHello', ["hello"]],
    ["IO of a value is the action yielding it", "x <- IO 42\nprint x", ["42"]],
    ["a block with an action statement is an action", 'f n = { print n; n * 2 }\ny <- f 3\nprint y', ["3", "6"]],
    ["a block of bindings stays a value", "f n = { m = n + 1; m * 2 }\nprint (f 3 + 1)", ["9"]],
    ["pure statements in a block stay pure", "f n = { assert (n > 0); n * 2 }\nprint (f 3)", ["6"]],
    ["a <- binding makes a block an action", "f n = { m <- n + 1; m * 2 }\ny <- f 3\nprint y", ["8"]],
    ["each run of an action repeats it", 'a = { print "run"; 1 }\nx <- a\ny <- a\nprint (x + y)', ["run", "run", "2"]],
    ["iterating an action runs each in turn", "[1,2] * n -> print n", ["1", "2"]],
    ["iteration yields the results", "xs <- [1,2] * n -> IO (n * 10)\nprint xs", ["[10,20]"]],
    ["recursive actions run in constant stack", 'loop n = n == 0 ? IO "done" : { emit ""; loop (n - 1) }\nr <- loop 5000\nprint r', ["done"]],
    ["set is an action", "c = Mutable 0\nbump = set c (c + 1)\nprint (c + 0)\nbump\nbump\nprint (c + 0)", ["0", "2"]],
    ["env yields a live view", "x = 1\nscope <- Dynamic env\nscope.x = 2\nprint x", ["2"]],
    ["do runs a list of actions", 'r <- do [print "a",print "b",IO 3]\nprint r', ["a", "b", "3"]],
    ["fmap over an action, list and Option", 'import "option"\nn <- fmap (+ 1) (pure 1)\nprint [n]\nprint (fmap (* 2) [1,2])\nprint (fmap (* 2) (Some 4))\nprint (fmap (* 2) None)',
        ["[2]", "[2,4]", "Some 8", "None"]],
    ["<$> and <*>", 'import "option"\nprint ((+ 1) <$> [1,2])\nprint (Some (+ 1) <*> Some 41)\nprint ([(+ 1),(* 2)] <*> [10,20])\nr <- pure (+ 1) <*> pure 1\nprint r',
        ["[2,3]", "Some 42", "[11,21,20,40]", "2"]],
    [">>= and >> chain actions", 'pure 5 >>= print\nprint "a" >> print "b"\nprint =<< pure 6', ["5", "a", "b", "6"]],
    [">>= on lists and Result", 'import "option"\nprint ([1,2] >>= (x -> [x,x * 10]))\nprint (Ok 3 >>= (x -> Ok (x + 1)))\nprint (Err "e" >>= (x -> Ok (x + 1)))',
        ["[1,10,2,20]", "Ok 4", 'Err "e"']],
    ["sequence, mapM, when and unless", 'xs <- sequence [pure 1,pure 2]\nprint xs\nys <- mapM (x -> { print x; x * 2 }) [3,4]\nprint ys\nwhen true (print "yes")\nunless true (print "no")',
        ["[1,2]", "3", "4", "[6,8]", "yes"]],
] as const) Deno.test(`IO: ${name}`, () => {
    for (const checked of [true, false]) {
        const actual = run(source, checked);
        const shown = actual.filter(line => line !== "");
        if (JSON.stringify(shown) !== JSON.stringify(expected)) throw new Error(`${checked ? "checked" : "unchecked"}: ${JSON.stringify(actual)}`);
    }
});

for (const [source, message, kind] of [
    ["x = print 5\nprint (x + 1)", "bind its result first", "type"],
    ["f n = { print n; n }\ny = f 1 + 1", "cannot use an action", "type"],
    ["x = print 1 >>= (v -> 5)", "IO", "type"],
    ["x = (+ 1) <$> 5", "fmap needs an action", "type"],
    ["x = 1\n(Dynamic env).x", "an action has no fields", "runtime"],
] as const) Deno.test(`IO rejects: ${JSON.stringify(source)}`, () => fails(source, message, kind));
Deno.test("IO: an action is not a condition", () => {
    try { run("x = print 1\nprint (x ? 1 : 2)", false); } catch (e) { if (String(e).includes("not a condition")) return; throw e; }
    throw new Error("accepted");
});
