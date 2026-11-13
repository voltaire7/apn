import { parse } from "../main.ts";
import { APNError } from "../src/errors.ts";
import { Interpreter } from "../src/interp.ts";

for (const source of ["foo =", "foo =\n", "foo = ;", "foo =\nbar = 1", "foo =\n{ 1 }", "= bar", "{ foo = }", "(foo =)", "f x ="]) {
    Deno.test(`missing binding side is a syntax error: ${JSON.stringify(source)}`, () => {
        try { parse(source); }
        catch (error) {
            if (error instanceof APNError && error.kind === "parse") return;
            throw error;
        }
        throw new Error("Expected a parse error");
    });
}

// A body of _ makes data, whatever the name's case: foo is itself, f 1 too.
Deno.test("a body of _ makes data", () => {
    const interp = new Interpreter();
    interp.run(parse("foo = _\nf x = _"));
    const shown = interp.renderString(interp.run(parse("[foo, f 1]")));
    if (shown !== "[foo, f 1]") throw new Error(shown);
});
// _ elsewhere is code still to write: an error when demanded.
Deno.test("placeholder expressions are silent until demanded", () => {
    const interp = new Interpreter();
    interp.run(parse("g x = x + 1"));
    for (const source of ["g _", "_"]) {
        try { interp.run(parse(source)); }
        catch (error) {
            if (error instanceof APNError && error.kind === "runtime" && error.message.includes("not implemented")) continue;
            throw error;
        }
        throw new Error(`Expected a not implemented error for ${source}`);
    }
    if (interp.renderString(interp.run(parse("1 + 2"))) !== "3") throw new Error("Interpreter did not recover");
});

for (const [source, expected] of [
    ["foo = []\nfoo", "[]"],
    ["foo =\n    42\nfoo", "42"],
    ["toAST [_]", '["[]","_"]'],
    ["head [1,_]", "1"],
    ["1 ~ [_ -> 7]", "7"],
    ["f _ = 7\nf missing", "7"],
    ["(_ -> 7) missing", "7"],
]) {
    Deno.test(`placeholder, unit, and wildcard compatibility: ${JSON.stringify(source)}`, () => {
        const interp = new Interpreter();
        const actual = interp.renderString(interp.run(parse(source)));
        if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
    });
}
