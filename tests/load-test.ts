import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

for (const name of ["number", "number.apn"]) {
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

Deno.test("std/system exposes halt as a deferred action", () => {
    const i = new Interpreter();
    const module = i.run(parse('system = import "std/system"; system'));
    const halt = i.env.get("halt");
    if (!halt) throw new Error("halt was not exported");
    if (!i.renderString(module).includes("halt:")) throw new Error("module inspection lost halt");
});
