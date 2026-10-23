import { Interpreter } from "../src/interp.ts";
import type { Value } from "../src/types.ts";
import { parse } from "../src/parser.ts";

for (const name of ["number"]) {
    for (const absolute of [false, true]) Deno.test(`load ${name}: ${absolute ? "absolute" : "source-relative"}`, () => {
        const i = new Interpreter();
        const directory = new URL("../lib/", import.meta.url).pathname;
        i.sourceDir = directory;
        const path = absolute ? `${directory}${name}` : name;
        const result = i.run(parse(`load ${JSON.stringify(path)}; sq 7`));
        if (i.renderString(result) !== "49") throw new Error("loaded definitions unavailable");
        if (i.sourceDir !== directory) throw new Error("source directory not restored");
    });
}
// A library file loaded through '..' is the library's own: its imports are
// the modules the program has, so their types are the same types.
Deno.test("a library file loaded through .. shares the library's modules", () => {
    const i = new Interpreter();
    i.sourceDir = new URL("fixtures", import.meta.url).pathname;
    i.run(parse('import "option"\nsix = { load "../../lib/number"; sq 6 }\nsix'));
    if (i.renderString(i.run(parse("Option Int { return 1 }"))) !== "Some 1") throw new Error("a second Option");
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
    const module = i.run(parse('system = import "system"; [system]')) as Extract<Value, { kind: "list" }>;
    if (i.env.get("halt")) throw new Error("namespaced import opened halt");
    const record = i.force(module.v[0]);
    if (record.kind !== "record" || !record.v.some(([key]) => key === "halt")) throw new Error("halt was not exported in the module");
    if (!i.renderString(record).includes("halt:")) throw new Error("module inspection lost halt");
});

// An import or load opens its names only as a statement: written there, or as
// a name defined as one; a field of it, or a function returning it, opens none.
for (const [source, opened] of [
    ['system = import "system"\nsystem', true],
    ['system = import "system"\nmodule = system\nmodule', true],
    ['system = import "system"\n{ system; 1 }', false],
    ['system = import "system"\nhaltAction = system.halt', false],
    ['system = import "system"\nmodule _ = system\nmodule []', false],
    ['Dynamic $ import "system"', true],
    ['numbers = load "../lib/number"\nnumbers', true],
    ['numbers = load "../lib/number"\nnumbers.sq 2', false],
] as const) Deno.test(`a statement opens a module: ${JSON.stringify(source)}`, () => {
    const i = new Interpreter();
    i.sourceDir = new URL(".", import.meta.url).pathname;
    i.run(parse(source));
    const name = source.includes("load") ? "sq" : "halt";
    if (!!i.env.get(name) !== opened) throw new Error(`${name} ${opened ? "not opened" : "opened"}`);
});

for (const path of ['number.apn', 'number.APN', 'number.txt', '../lib/number.apn', '/tmp/number.apn', '', 'folder/']) {
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
