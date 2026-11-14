// compile's snapshot (docs/runtime-compilation.md): an entry and what it
// reaches, rebuilt in a fresh interpreter, which gives what the program would.
import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
import { captureSnapshot, restoreSnapshot } from "../src/snapshot.ts";
import type { Value } from "../src/types.ts";

// The value of name in a fresh interpreter, from a snapshot of source's run,
// passed through JSON as an executable carries it.
function travelled(source: string, name: string): string {
    const before = new Interpreter();
    before.run(parseDocument(source));
    const entry: Value = { kind: "thunk", body: { t: "var", name }, env: before.programEnv };
    const snapshot = JSON.parse(JSON.stringify(captureSnapshot(before, entry)));
    const after = new Interpreter();
    return after.renderString(after.demand(restoreSnapshot(after, snapshot)));
}

for (const [source, name, expected] of [
    // Definitions, recursion and constructors travel as code.
    ["fact 0 = 1\nfact n = n * fact (n - 1)\nr = fact 20", "r", "2432902008176640000"],
    ["Shape = Circle Float | Square Float\narea (Circle r) = 3 * r * r\narea (Square s) = s * s\n" +
        "r = map area [Circle 1.0, Square 2.0]", "r", "[3.0,4.0]"],
    ["add n = x -> x + n\nr = map (add 10) [1,2]", "r", "[11,12]"],
    // What an action gave is data; a cell, its contents when compile ran.
    ["g <- return \"made before\"\nr = g", "r", '"made before"'],
    ["c = Mutable 10\nset c 42\nr = c + 0", "r", "42"],
    // A redefined prelude name is the program's.
    ["map f xs = \"mine\"\nr = map id [1]", "r", '"mine"'],
] as const) Deno.test(`a snapshot carries ${name} of: ${source.split("\n").pop()}`, () => {
    const actual = travelled(source, name);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});

// A value that cannot travel is an error where the executable uses it.
Deno.test("a value that cannot travel fails only where it is used", () => {
    if (travelled("xs <- return (map (* 2) [1..])\nr = 5", "r") !== "5") throw new Error("an unused value failed");
    let message = "";
    try { travelled("xs <- return (map (* 2) [1..])\nr = take 2 xs", "r"); } catch (error) { message = String(error); }
    if (!message.includes("xs cannot travel to the executable")) throw new Error(message || "no error");
});

// The whole path, building and running a script, needs to write and run deno.
const canBuild = Deno.permissions.querySync({ name: "write" }).state === "granted" && Deno.permissions.querySync({ name: "run" }).state === "granted";
Deno.test({ name: "compile writes a script that runs its entry", ignore: !canBuild, fn() {
    const folder = Deno.makeTempDirSync();
    try {
        const i = new Interpreter();
        i.run(parseDocument(`main = print "hi from the executable"\ncompile main [name = "${folder}/hello", target = "js"]`));
        const out = new Deno.Command(Deno.execPath(), { args: ["run", "--allow-all", `${folder}/hello.js`], stdout: "piped" }).outputSync();
        const text = new TextDecoder().decode(out.stdout).trim();
        if (text !== "hi from the executable") throw new Error(text);
    } finally { Deno.removeSync(folder, { recursive: true }); }
} });
