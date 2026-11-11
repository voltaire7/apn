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


// private and public mark the parts of a file's top level (Jai's #scope_file
// and #scope_export): an import or a use of its code sees the public names,
// which keep seeing the private ones (docs/semantics.md#module-imports).
for (const checked of [false, true]) {
    const session = () => {
        const i = new Interpreter();
        if (checked) i.enableChecking();
        i.sourceDir = new URL("fixtures/privacy", import.meta.url).pathname;
        return i;
    };
    for (const [source, expected] of [
        ['shapes <- import "shapes"\n[shapes.area 2, shapes.perimeter 1]', '[12,13]'],
        ['m <- load "shapes"\nuse m\n[area 2, perimeter 1]', '[12,13]'],
        ['m <- load "shapes"\nm.pi', '3'],
    ]) Deno.test(`private names stay in their file${checked ? " (checked)" : ""}: ${JSON.stringify(source)}`, () => {
        const i = session(), actual = i.renderString(i.run(parse(source)));
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
    for (const [source, message] of [
        ['shapes <- import "shapes"\nshapes.hidden', checked ? "missing field 'hidden'" : "no field 'hidden'"],
        ['m <- load "shapes"\nuse m\nhelper 1', "unbound variable 'helper'"],
        ['m <- load "shapes"\nm.helper', checked ? "missing field 'helper'" : "unbound variable 'helper'"],
        ['twice <- import "twice"\ntwice.x', "'x' is bound both public and private"],
    ]) Deno.test(`private names stay in their file${checked ? " (checked)" : ""}: ${JSON.stringify(source)} fails`, () => {
        try { session().run(parse(source)); } catch (error) { if (String(error).includes(message)) return; throw error; }
        throw new Error("accepted");
    });
}
Deno.test("private marks a file's top level, not a block", () => {
    try { new Interpreter().run(parse("f x = {\n    private\n    x\n}\nf 1")); }
    catch (error) { if (String(error).includes("private and public mark a file's top level")) return; throw error; }
    throw new Error("accepted");
});
