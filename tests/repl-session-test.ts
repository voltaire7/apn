import { parse } from "../main.ts";
import { Interpreter } from "../src/interp.ts";
import { formatError, runSource } from "../src/repl.ts";

// repl opens a session on the program's scope where it runs. Each chunk here
// stands for a line typed into it (runSource shows a binding's value too); an
// error shows as the REPL reports it.
function session(program: string, chunks: string[][], check = true): { echoes: string[]; printed: string[] } {
    const echoes: string[] = [], printed: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => printed.push(args.map(String).join(" "));
    try {
        const interp = new Interpreter();
        if (check) interp.enableChecking();
        let opened = 0;
        interp.interactive = () => {
            for (const source of chunks[opened++] ?? []) {
                try { echoes.push(runSource(source, interp)); }
                catch (error) { echoes.push(formatError(error, false).split("\n")[0]); }
            }
        };
        interp.run(parse(program));
    } finally {
        console.log = log;
    }
    return { echoes, printed };
}

function equal(actual: unknown, expected: unknown): void {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}

Deno.test("a session sees the program's names as they are where repl runs", () => {
    const { echoes, printed } = session('x = 1\nf n = n * 2\nrepl\nx = "s"\nprint x', [["x + 1", "f x"]]);
    equal(echoes, ["2", "2"]);
    equal(printed, ["s"]);
});

Deno.test("a session inside a function sees its names, typed by their values", () => {
    const program = [
        "x = 1", "f n = {", "    m = n", "    xs = [1..]", "    h = y -> y + n", "    repl", "    return m", "}",
        'x = "later"', "r <- f 3", "print r",
    ].join("\n");
    const { echoes, printed } = session(program, [[
        "n + 1", 'n ++ "a"', "take 2 xs", "h 2", "h True", "x", 'x ++ "a"', "m = 10", "m",
    ]]);
    equal(echoes, [
        // n is the literal 3 passed in: an Int, exactly.
        "4", "type error: cannot append Int and String",
        // A range is data; h, a function, is Dynamic: its misuse fails when run.
        "[1,2]", "5", "runtime error: cannot apply '+' to bool and int",
        // f sees the x before x = "later".
        "1", "type error: cannot append Int and String",
        "10", "10",
    ]);
    // m = 10 stayed in the session.
    equal(printed, ["3"]);
});

Deno.test("a session checks against the types before the running statement", () => {
    const { echoes } = session('x = 1\nrepl\nx = "s"', [['x ++ "a"']]);
    equal(echoes, ["type error: cannot append Int and String"]);
});

Deno.test("what a session binds stays in it", () => {
    const { echoes, printed } = session("x = 1\nrepl\nprint x\nrepl", [["x = 10", "y = 2", "[x,y]"], ["x", "y"]]);
    equal(echoes, ["10", "2", "[10,2]", "1", "type error: unbound variable 'y'"]);
    equal(printed, ["1"]);
});

Deno.test("a session's actions take effect: a Mutable cell it sets keeps its contents", () => {
    const { printed } = session("c = Mutable 0\nrepl\nprint c", [["set c 5"]]);
    equal(printed, ["5"]);
});

Deno.test("a session run inside another returns to it", () => {
    const { echoes } = session("x = 1\nrepl", [["y = 2", "repl", "y"], ["x + y", "z = 3"]]);
    equal(echoes, ["2", "3", "3", "", "2"]);
});

Deno.test("repl is an action yielding []", () => {
    equal(session("print (typeOf repl)\nr <- repl\nprint r", [[]]).printed, ["IO []", "[]"]);
});

Deno.test("repl needs the command line's REPL", () => {
    const interp = new Interpreter();
    try {
        interp.run(parse("repl"));
    } catch (error) {
        equal((error as Error).message, "repl needs a terminal: run the program with apn");
        return;
    }
    throw new Error("repl ran without a REPL");
});
