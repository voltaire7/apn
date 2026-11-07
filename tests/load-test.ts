import { Interpreter } from "../src/interp.ts";
import type { Value } from "../src/types.ts";
import { parse } from "../src/parser.ts";

for (const name of ["number"]) {
    for (const absolute of [false, true]) Deno.test(`load ${name}: ${absolute ? "absolute" : "source-relative"}`, () => {
        const i = new Interpreter();
        const directory = new URL("../lib/std/", import.meta.url).pathname;
        i.sourceDir = directory;
        const path = absolute ? `${directory}${name}` : name;
        const result = i.run(parse(`numbers <- load ${JSON.stringify(path)}; numbers.sq 7`));
        if (i.renderString(result) !== "49") throw new Error("loaded definitions unavailable");
        if (i.sourceDir !== directory) throw new Error("source directory not restored");
    });
}
// A library file loaded through '..' is the library's own: its imports are
// the modules the program has, so their types are the same types.
Deno.test("a library file loaded through .. shares the library's modules", () => {
    const i = new Interpreter();
    i.sourceDir = new URL("fixtures", import.meta.url).pathname;
    i.run(parse('std <- import "std"; use std.option\nsix = { numbers <- load "../../lib/std/number"; return (numbers.sq 6) }\nsix'));
    if (i.renderString(i.run(parse("({ return 1 } : Option Int)"))) !== "Some 1") throw new Error("a second Option");
});
Deno.test("extensionless load reports the resolved APN path", () => {
    const i = new Interpreter();
    try { i.run(parse('load "missing-load-test-source"')); }
    catch (error) {
        if (error instanceof Error && error.message.includes("missing-load-test-source.apn")) return;
        throw error;
    }
    throw new Error("expected missing source error");
});

Deno.test("system exposes halt as a deferred action", () => {
    const i = new Interpreter();
    const module = i.run(parse('system <- import "std/system"; [system]')) as Extract<Value, { kind: "list" }>;
    if (i.env.get("halt")) throw new Error("namespaced import opened halt");
    const record = i.force(module.v[0]);
    if (record.kind !== "record" || !record.v.some(([key]) => key === "halt")) throw new Error("halt was not exported in the module");
    if (!i.renderString(record).includes("halt =")) throw new Error("module inspection lost halt");
});

// A module (an import's or a load's) opens its names only by use, which opens
// them in its own block; a field of it, a binding of it or running it opens none.
for (const [source, opened] of [
    ['system <- import "std/system"\nuse system', true],
    ['std <- import "std"\nuse std.system', true],
    ['std <- import "std"\nuse std.[system,option]', true],
    ['system <- import "std/system"\n{ use system; 1 }', false],
    ['system <- import "std/system"\nhaltAction = system.halt', false],
    ['system <- import "std/system"\nmodule _ = system\nm = module []', false],
    ['numbers <- load "../lib/std/number"\nuse numbers', true],
    ['numbers = load "../lib/std/number"\nnumbers', false],
    ['load "../lib/std/number"', false],
    ['numbers <- load "../lib/std/number"\nnumbers.sq 2', false],
] as const) Deno.test(`use opens a module: ${JSON.stringify(source)}`, () => {
    // Checked, as programs run: the check finds a result return keeps unevaluated.
    const i = new Interpreter();
    i.enableChecking();
    i.sourceDir = new URL(".", import.meta.url).pathname;
    i.run(parse(source));
    const name = source.includes("load") ? "sq" : "halt";
    if (!!i.env.get(name) !== opened) throw new Error(`${name} ${opened ? "not opened" : "opened"}`);
});

for (const path of ['number.apn', 'number.APN', 'number.txt', '../lib/std/number.apn', '/tmp/number.apn', '', 'folder/']) {
    Deno.test(`load rejects explicit extensions or missing names: ${path}`, () => {
        const i = new Interpreter();
        const scope = i.env, directory = i.sourceDir;
        let rejected = false;
        try { i.run(parse(`load ${JSON.stringify(path)}`)); }
        catch (error) {
            if (error instanceof Error && error.message.includes('extensionless file name')) rejected = true;
            else throw error;
        }
        if (!rejected || i.env !== scope || i.sourceDir !== directory) throw new Error('expected clean rejection');
    });
}
Deno.test('load validates computed paths too', () => {
    const i = new Interpreter();
    try { i.run(parse('path = "number" ++ ".apn"; load path')); }
    catch (error) { if (error instanceof Error && error.message.includes('extensionless file name')) return; throw error; }
    throw new Error('explicit extension accepted');
});
