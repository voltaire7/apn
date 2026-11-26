import { parse } from "../main.ts";
import { Interpreter } from "../src/interp.ts";
import { APNError } from "../src/errors.ts";
for (const [source, expected] of [
    // A map shows as its association list, which it is.
    ['insert [["x", 123]] $ ([] : HashMap _ _)', '[["x", 123]]'],
    ['m = insert [["x", 123]] $ ([] : HashMap _ _)\nlookup "x" m', '123'],
    ['([["x", 1], ["y", 2]] : HashMap _ _)', '[["x", 1], ["y", 2]]'],
    ['m : HashMap _ _ = [["x", 1]]\nm "x"', '1'],
    ['m : HashMap _ _ = [["x", 1]]\nn = insert [["x", 2], ["y", 3]] m\n[m "x", n "x", has "y" m, has "y" n]', '[1, 2, False, True]'],
    ['lookup 1 $ ([[1, "first"], [1.0, "last"]] : HashMap _ _)', '"last"'],
    ['m : HashMap _ _ = [["x", 1]]\n[pairs m, keys m, values m, length m, null m]', '[[["x", 1]], ["x"], [1], 1, False]'],
    ['remove "x" $ ([["x", 1]] : HashMap _ _)', '[]'],
    ['f (m : HashMap _ _) = length m\nf ([["x", 1]] : HashMap _ _)', '1'],
    // Its pairs in the order first inserted, compared as a list's.
    ['([["x", 1], ["y", 2]] : HashMap _ _) == ([["y", 2], ["x", 1]] : HashMap _ _)', 'False'],
    ['([["x", 1], ["y", 2]] : HashMap _ _) == [["x", 1], ["y", 2]]', 'True'],
    // Any key with equality: a list, a record, a constructor; a record's fields are its pairs.
    ['([[[], 1]] : HashMap _ _) []', '1'],
    ['([a = 1] : HashMap _ _) "a"', '1'],
    ['map ([k,v] -> v) ([["x", 1], ["y", 2]] : HashMap _ _)', '[1,2]'],
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
// types and no value, and a key needs equality.
for (const source of ['([1] : HashMap _ _)', '([[1,2,3]] : HashMap _ _)', 'lookup "x" ([] : HashMap _ _)',
    'HashMap [["a", 1]]', '([[x -> x, 1]] : HashMap _ _)']) {
    Deno.test(`HashMap input error: ${source}`, () => {
        try { const interp = new Interpreter(); interp.renderString(interp.run(parse(source))); }
        catch (e) { if (e instanceof APNError) return; throw e; }
        throw new Error("Expected map error");
    });
}
