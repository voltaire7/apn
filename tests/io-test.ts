import { Interpreter, setInterruptFlag } from "../src/interp.ts";
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
    ["<- runs an action and binds its result", 'x <- { print 5; return 5 }\nprint (x + 1)', ["5", "6"]],
    ["print yields []", 'x <- print 5\nprint (null x)', ["5", "true"]],
    ["<- return x binds x, evaluated now", "x = 1\nx <- return (x + 1)\nprint x", ["2"]],
    ["IO T is a type that checks an action", 'sayHello = IO [] { print "hello" }\nsayHello', ["hello"]],
    ["return x is the action yielding x", "x <- return 42\nprint x", ["42"]],
    ["IO types describe actions", "print (IO [])\nprint (IO Int)", ["IO []", "IO Int"]],
    ["a block with an action statement is an action", 'f n = { print n; return (n * 2) }\ny <- f 3\nprint y', ["3", "6"]],
    ["a block of bindings stays a value", "f n = { m = n + 1; m * 2 }\nprint (f 3 + 1)", ["9"]],
    ["pure statements in a block stay pure", "f n = { assert (n > 0); n * 2 }\nprint (f 3)", ["6"]],
    ["a <- binding makes a block an action", "f n = { m <- return (n + 1); return (m * 2) }\ny <- f 3\nprint y", ["8"]],
    ["each run of an action repeats it", 'a = { print "run"; return 1 }\nx <- a\ny <- a\nprint (x + y)', ["run", "run", "2"]],
    ["a stored action reads cells again at each run", 'c = Mutable 0\nxs = [set c (c + 1)]\nhead xs\nhead xs\nprint (c + 0)', ["2"]],
    ["an action from an application repeats too", 'f n = { print n; return n }\na = f 1\nx <- a\ny <- a\nprint (x + y)', ["1", "1", "2"]],
    ["iterating an action runs each in turn", "[1,2] * n -> print n", ["1", "2"]],
    ["iteration yields the results", "xs <- [1,2] * n -> return (n * 10)\nprint xs", ["[10,20]"]],
    ["recursive actions run in constant stack", 'loop n = n == 0 ? return "done" : { emit ""; loop (n - 1) }\nr <- loop 5000\nprint r', ["done"]],
    ["set is an action", "c = Mutable 0\nbump = set c (c + 1)\nprint (c + 0)\nbump\nbump\nprint (c + 0)", ["0", "2"]],
    ["do runs a list of actions", 'r <- do [print "a", print "b", return 3]\nprint r', ["a", "b", "3"]],
    ["map over an action, list and Option", 'import "option"\nn <- map (+ 1) (return 1)\nprint [n]\nprint (map (* 2) [1,2])\nprint (map (* 2) (Some 4))\nprint (map (* 2) None)',
        ["[2]", "[2,4]", "Some 8", "None"]],
    ["<$> and <*>", 'import "option"\nprint ((+ 1) <$> [1,2])\nprint (Some (+ 1) <*> Some 41)\nprint ([(+ 1), (* 2)] <*> [10,20])\nr <- return (+ 1) <*> return 1\nprint r',
        ["[2,3]", "Some 42", "[11,21,20,40]", "2"]],
    [">>= and >> chain actions", 'return 5 >>= print\nprint "a" >> print "b"\nprint =<< return 6', ["5", "a", "b", "6"]],
    [">>= on lists and Result", 'import "option"\nprint ([1,2] >>= (x -> [x, x * 10]))\nprint (Ok 3 >>= (x -> Ok (x + 1)))\nprint (Err "e" >>= (x -> Ok (x + 1)))',
        ["[1,10,2,20]", "Ok 4", 'Err "e"']],
    ["sequence, mapM, when and unless", 'xs <- sequence [return 1, return 2]\nprint xs\nys <- mapM (x -> { print x; return (x * 2) }) [3,4]\nprint ys\nwhen true (print "yes")\nunless true (print "no")',
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
    ["f n = { print n; return n }\ny = f 1 + 1", "cannot use an action", "type"],
    ['f = IO Int { print "hi"; 42 }', "the last statement of a do-block must be an action", "type"],
    ["x = print 1 >>= (v -> 5)", "IO", "type"],
    ["x = (+ 1) <$> 5", "map needs an action", "type"],
    ["x <- 2 + 3", "<- runs an action, not Int", "type"],
    ['sayHello = IO { print "hello" }', "IO is a type constructor", "type"],
    ["x = IO 5", "IO is a type constructor", "type"],
    ['x = IO Int (print 1)', "where Int is required", "type"],
] as const) Deno.test(`IO rejects: ${JSON.stringify(source)}`, () => fails(source, message, kind));
Deno.test("IO: an action is not a condition", () => {
    try { run("x = print 1\nprint (x ? 1 : 2)", false); } catch (e) { if (String(e).includes("not a condition")) return; throw e; }
    throw new Error("accepted");
});
Deno.test("IO: iterating an infinite list streams each action until interrupted", () => {
    for (const source of ["[0..] * print", "print * [0..]"]) {
        const i = new Interpreter();
        i.enableChecking();
        const flag = new Int32Array(new SharedArrayBuffer(8));
        const log = console.log;
        let count = 0, interrupted = false;
        console.log = () => { if (++count === 1000) Atomics.store(flag, 0, 1); };
        setInterruptFlag(flag);
        try { i.run(parse(source)); }
        catch (e) { if (e instanceof Error && e.message === "interrupted") interrupted = true; else throw e; }
        finally { setInterruptFlag(null); console.log = log; }
        if (!interrupted || count !== 1000) throw new Error(`${source} did not stream`);
    }
});
Deno.test("IO: an iteration action reruns from the start", () => {
    const shown = run("a = [1,2] * print\na\na");
    if (JSON.stringify(shown) !== '["1","2","1","2"]') throw new Error(JSON.stringify(shown));
});
