import { parse } from "../main.ts";
import { Interpreter } from "../src/interp.ts";
import { APNError } from "../src/errors.ts";
for (const [source, expected] of [
    ['insert [x: 123] $ HashMap []', 'HashMap [["x",123]]'],
    ['m = insert [x: 123] $ HashMap []\nlookup "x" m', '123'],
    ['HashMap [["x",1],["y",2]]', 'HashMap [["x",1],["y",2]]'],
    ['m = HashMap [x: 1]\nm "x"', '1'],
    ['m = HashMap [x: 1]\nn = insert [x: 2, y: 3] m\n[m "x", n "x", has "y" m, has "y" n]', '[1,2,False,True]'],
    ['lookup 1 $ HashMap [[1,"first"],[1.0,"last"]]', '"last"'],
    ['m = HashMap [x: 1]\n[pairs m, keys m, values m, length m, null m]', '[[["x",1]],["x"],[1],1,False]'],
    ['remove "x" $ HashMap [x: 1]', 'HashMap []'],
    ['f (m : HashMap) = length m\nf (HashMap [x: 1])', '1'],
    ['HashMap [x: 1, y: 2] == HashMap [y: 2, x: 1]', 'True'],
    ['lookup "x" (HashMap [["x",1],["unused",missing]])', '1'],
    ['typeOf (HashMap [])', 'HashMap'],
    ['isType HashMap (HashMap [])', 'True'],
]) {
    Deno.test(`HashMap: ${source}`, () => {
        const interp = new Interpreter();
        const actual = interp.renderString(interp.run(parse(source)));
        if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
    });
}
for (const source of ['HashMap [1]', 'HashMap [[1,2,3]]', 'lookup "x" (HashMap [])', 'HashMap [[[],1]]']) {
    Deno.test(`HashMap input error: ${source}`, () => {
        try { const interp = new Interpreter(); interp.renderString(interp.run(parse(source))); }
        catch (e) { if (e instanceof APNError) return; throw e; }
        throw new Error("Expected map error");
    });
}
