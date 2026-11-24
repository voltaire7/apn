import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
import { resolveModule } from "../src/modules.ts";

const directory = new URL("./fixtures/packages/", import.meta.url).pathname;
function interpreter(checked: boolean): Interpreter {
    const i = new Interpreter();
    if (checked) i.enableChecking();
    i.sourceDir = directory;
    return i;
}
function result(i: Interpreter, source: string): string {
    return i.renderString(i.run(parseDocument(source)));
}
for (const checked of [false, true]) {
    Deno.test(`import finds files and folders next to the code (checked=${checked})`, () => {
        const i = interpreter(checked);
        const source = 'hello <- import "hello"\nshapes <- import "shapes"\n[..] = hello\n[..] = shapes.[square,cube]\n[..] = shapes.solid.box\n'
            + '[greet "you", square 3, cube 2, volume 2]';
        const actual = result(i, source);
        if (actual !== '["hi you", 9, 8, 8]') throw new Error(actual);
        // A folder's record holds its entries, each a module: files and subfolders.
        if (result(i, 'sh <- import "shapes"; sh.square.square 4') !== "16") throw new Error("namespaced");
        if (result(interpreter(checked), 'sh <- import "shapes"; map head (pairs sh)') !== '["cube","solid","square"]') throw new Error("entries");
    });
    // A module's value is its file's last statement's: a function is a module taking parameters.
    Deno.test(`a module ending in a function takes parameters (checked=${checked})`, () => {
        const actual = result(interpreter(checked), 'make <- import "counter"\nten = make 10\n[..] = make 5\n[ten.value,ten.next,next]');
        if (actual !== "[10,11,6]") throw new Error(actual);
    });
    // A folder's modules run when it is imported, each once: reading a field runs nothing.
    Deno.test(`importing a folder runs its modules (checked=${checked})`, () => {
        const output: string[] = [], log = console.log;
        console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
        try {
            const i = interpreter(checked);
            if (result(i, 'noisy <- import "noisy"\nprint "imported"\nnoisy.quiet.quietness') !== "0") throw new Error("value");
            if (result(i, 'again <- import "noisy"\nagain.loud.loudness') !== "11") throw new Error("cached");
        } finally { console.log = log; }
        if (output.join("|") !== "loud ran|imported") throw new Error(output.join("|"));
        try { result(interpreter(checked), 'm <- import "loop"'); } catch (error) {
            if (String(error).includes("cyclic import")) return;
            throw error;
        }
        throw new Error("a module reading itself back through its folder imported");
    });
    Deno.test(`a file wins over a folder of the same name (checked=${checked})`, () => {
        const i = interpreter(checked);
        if (result(i, 'both <- import "both"; [both.fromFile, length (pairs both)]') !== "[1,1]") throw new Error("file");
        if (result(i, 'inside <- import "both/inside"; inside.fromFolder') !== "2") throw new Error("inside the folder");
    });
    Deno.test(`a module's own imports resolve next to it (checked=${checked})`, () => {
        if (result(interpreter(checked), 'u <- import "uses-hello"; u.exported') !== '"hi pkg"') throw new Error("relative import");
        // A bare name is a local module: text beside the program is not std/text.
        if (result(interpreter(checked), 'user <- import "local-text/user"; user.result') !== '"shadowed"') throw new Error("local");
    });
    Deno.test(`std is the standard library (checked=${checked})`, () => {
        if (result(interpreter(checked), 'std <- import "std"; [..] = std.option; Some 1') !== "Some 1") throw new Error("std");
        for (const [source, hint] of [['import "option"', 'a standard module is std/option'], ['import "nope"', "no nope.apn or nope/"],
            ['import "std/nope"', "the standard library has no module 'nope'"]]) {
            try { result(interpreter(checked), `m <- ${source}`); } catch (error) {
                const e = error as { message: string; hint?: string };
                if (!e.message.startsWith("unknown module") || !e.hint?.includes(hint)) throw new Error(`${source}: ${e.message} (${e.hint})`);
                continue;
            }
            throw new Error(`accepted: ${source}`);
        }
    });
    Deno.test(`a folder's files are modules of their own (checked=${checked})`, () => {
        if (result(interpreter(checked), 'clash <- import "clash"; [clash.a.twice,clash.b.twice]') !== "[1,2]") throw new Error("entries");
    });
}
for (const checked of [false, true]) Deno.test(`a module imports packages from parent folders up to the program's (checked=${checked})`, () => {
    // nested/deep/inner.apn imports hello (two folders up) and greeting,
    // of which nested/greeting.apn is nearer than the program's.
    const actual = result(interpreter(checked), 'inner <- import "nested/deep/inner"; inner.inner');
    if (actual !== '["hi deep","near"]') throw new Error(actual);
});
Deno.test("imports never search above the program's folder", () => {
    // From nested/ as the program's folder, the outer hello.apn is out of reach.
    const nested = `${directory}nested/`;
    if (resolveModule("hello", `${nested}deep/`, undefined, nested)) throw new Error("searched above the root");
    if (!resolveModule("hello", `${nested}deep/`, undefined, directory)) throw new Error("did not search up to the root");
    if (resolveModule("hello", `${nested}deep/`)) throw new Error("searched up without a root");
});
Deno.test("the package example runs", () => {
    const i = new Interpreter();
    i.enableChecking();
    const file = new URL("../examples/packages/main.apn", import.meta.url);
    i.sourceDir = new URL(".", file).pathname;
    const printed: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => { printed.push(args.join(" ")); };
    try { i.run(parseDocument(Deno.readTextFileSync(file))); } finally { console.log = log; }
    const expected = ["Hello, packages!", "[9,10]", "24 m³", "16", "square: 9 m²\nrectangle: 10 m²"];
    if (JSON.stringify(printed) !== JSON.stringify(expected)) throw new Error(JSON.stringify(printed));
});
