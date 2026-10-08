import { parse } from "../main.ts";
import { Interpreter } from "../src/interp.ts";

for (const [name, source, expected] of [
    ["positive index", "arr = [1,2,3]\narr 0 = 10\narr", "[10,2,3]"],
    ["negative index", "arr = [1,2,3]\narr (-1) = 10\narr", "[1,2,10]"],
    ["consecutive updates and old RHS", "arr = [1,2,3]\narr 0 = 10\narr 1 = arr 0 + 1\narr", "[10,11,3]"],
    ["block shadows outer binding", "arr = [1,2]\ninner = { arr 0 = 9; arr }\n[inner,arr]", "[[9,2],[1,2]]"],
    ["existing aliases are not mutated", "arr = [1,2]\nold = arr\nold\narr 0 = 9\n[old,arr]", "[[1,2],[9,2]]"],
    ["unrelated element is not demanded", "arr = [0,missing]\narr 0 = 9\narr 0", "9"],
    ["infinite range only traverses selected prefix", "arr = [0..]\narr 2 = 9\ntake 5 arr", "[0,1,9,3,4]"],
    ["literal function clauses stay definitions", "f 0 = 10\nf 1 = 20\n[f 0,f 1]", "[10,20]"],
    ["existing function can be redefined", "f x = x\nf 2\nf 0 = 10\nf 0", "10"],
    ["unfinished function can be implemented", "f = _\nf 0 = 10\nf 0", "10"],
]) {
    Deno.test(`list assignment: ${name}`, () => {
        const interp = new Interpreter();
        const actual = interp.renderString(interp.run(parse(source)));
        if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
    });
}

for (const index of ["2", "(-3)", "9007199254740993"]) {
    Deno.test(`out-of-bounds assignment preserves original list: ${index}`, () => {
        const interp = new Interpreter();
        interp.run(parse("arr = [1,2]"));
        let failed = false;
        try { interp.run(parse(`arr ${index} = 10`)); }
        catch (error) {
            if (!(error instanceof Error) || !error.message.includes("out of range")) throw error;
            failed = true;
        }
        if (!failed || interp.renderString(interp.run(parse("arr"))) !== "[1,2]") {
            throw new Error("Invalid assignment did not preserve the list");
        }
    });
}
