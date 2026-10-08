import { Interpreter } from "../src/interp.ts";
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
    const module = i.run(parse('system = import "system"; system'));
    if (i.env.get("halt")) throw new Error("namespaced import opened halt");
    if (module.kind !== "record" || !module.v.some(([key]) => key === "halt")) throw new Error("halt was not exported in the module");
    if (!i.renderString(module).includes("halt:")) throw new Error("module inspection lost halt");
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
