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

Deno.test("a session sees the top-level names, not a function's or block's own", () => {
    const program = "g = 4\nf n = {\n    m = n\n    repl\n    return m\n}\nr <- f 3\nprint r";
    const { echoes, printed } = session(program, [["g", "n", "m"]]);
    equal(echoes, ["4", "type error: unbound variable 'n'", "type error: unbound variable 'm'"]);
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
