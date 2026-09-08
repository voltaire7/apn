import { parse } from "../main.ts";
import { APNError } from "../src/errors.ts";

const invalid = [
    '    func = {\n        print "hi"\n    print "hi"\n}',
    'func = {\n    print "hi"\nprint "hi"\n}',
    'func = {\n    print "hi"\n    print "hi"\n    }',
    'func =\n    {\n        print "hi"\n    print "hi"\n}',
    'func =\n    { print "hi"; print "hi" }',
    'func =\n    {\n        print "hi"\n        print "hi"\n    }',
    'outer = {\n    inner =\n        { 1 }\n}',
];
for (const source of invalid) {
    Deno.test(`invalid block layout: ${source}`, () => {
        try { parse(source); } catch (error) {
            if (error instanceof APNError) return;
            throw error;
        }
        throw new Error("Expected syntax error");
    });
}
for (const source of [
    'func = {\n    print "hi"\n    print "hi"\n}',
    'func = { print "hi"; print "hi" }',
    'func =\n    print "hi"',
    'outer = {\n    inner = {\n        1\n    }\n    inner\n}',
]) {
    Deno.test(`valid block layout: ${source}`, () => { parse(source); });
}
