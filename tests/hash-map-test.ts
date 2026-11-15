import { parse } from "../main.ts";
import { Interpreter } from "../src/interp.ts";
import { APNError } from "../src/errors.ts";
for (const [source, expected] of [
    ['insert [["x", 123]] $ ([] : HashMap _ _)', '([["x", 123]] : HashMap _ _)'],
    ['m = insert [["x", 123]] $ ([] : HashMap _ _)\nlookup "x" m', '123'],
    ['([["x", 1], ["y", 2]] : HashMap _ _)', '([["x", 1], ["y", 2]] : HashMap _ _)'],
    ['m = ([["x", 1]] : HashMap _ _)\nm "x"', '1'],
    ['m = ([["x", 1]] : HashMap _ _)\nn = insert [["x", 2], ["y", 3]] m\n[m "x", n "x", has "y" m, has "y" n]', '[1, 2, False, True]'],
    ['lookup 1 $ ([[1, "first"], [1.0, "last"]] : HashMap _ _)', '"last"'],
    ['m = ([["x", 1]] : HashMap _ _)\n[pairs m, keys m, values m, length m, null m]', '[[["x", 1]], ["x"], [1], 1, False]'],
    ['remove "x" $ ([["x", 1]] : HashMap _ _)', '([] : HashMap _ _)'],
    ['f (m : HashMap _ _) = length m\nf ([["x", 1]] : HashMap _ _)', '1'],
    ['([["x", 1], ["y", 2]] : HashMap _ _) == ([["y", 2], ["x", 1]] : HashMap _ _)', 'True'],
    ['lookup "x" ([["x", 1], ["unused",missing]] : HashMap _ _)', '1'],
    ['typeOf ([] : HashMap _ _)', 'HashMap a b'],
    ['typeOf ([["a", 1], ["b","x"]] : HashMap _ _)', 'HashMap String (Int | String)'],
    ['isType (HashMap _ _) ([] : HashMap _ _)', 'True'],
    ['isType (HashMap String Int) ([[1,1]] : HashMap _ _)', 'False'],
]) {
    Deno.test(`HashMap: ${source}`, () => {
        const interp = new Interpreter();
        const actual = interp.renderString(interp.run(parse(source)));
        if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
    });
}
// A map is an association list converted to HashMap k v: HashMap takes two
// types and no value, and a record is not an association list.
for (const source of ['([1] : HashMap _ _)', '([[1,2,3]] : HashMap _ _)', 'lookup "x" ([] : HashMap _ _)', '([[[], 1]] : HashMap _ _)',
    'HashMap [["a", 1]]', '([a = 1] : HashMap _ _)', 'insert [a = 1] ([] : HashMap _ _)']) {
    Deno.test(`HashMap input error: ${source}`, () => {
        try { const interp = new Interpreter(); interp.renderString(interp.run(parse(source))); }
        catch (e) { if (e instanceof APNError) return; throw e; }
        throw new Error("Expected map error");
    });
}
