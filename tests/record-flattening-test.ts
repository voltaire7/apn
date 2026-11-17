import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
for (const checked of [false, true]) {
    for (
        const [source, expected] of [
            ["[use [x = 1], y = 2, z = 3]", "[x = 1, y = 2, z = 3]"],
            ['base = [x = 1]; [use base, x = "hi"]', '[x = "hi"]'],
            ['base = [x = 1]; [x = "hi", use base]', "[x = 1]"],
            ["[use [x = 1], use [y = 2], z = 3]", "[x = 1, y = 2, z = 3]"],
            ["r = [use [child = [x = 1]], y = 2]; r.child.x", "1"],
            ["x = 1; r = [x = x, use [y = 2]]; r.y", "2"],
            ["base = [x = 1]; r = [use base]; r.x = 2; [base.x,r.x]", "[1,2]"],
            // _ = e binds nothing, in a record as in a block.
            ["base = [x = 1]; [_ = base, y = 2]", "[y = 2]"],
            [
                "unused = missing : Dynamic; base = [x = unused]; r = [use base, y = 2]; r.y",
                "2",
            ],
            ['v = [x = 1]; v._ = [x = "hi", y = 2]; v', '[x = "hi", y = 2]'],
            ["v = [inner = [x = 1]]; v.inner._ = [y = 2]; v.inner", "[x = 1, y = 2]"],
            ["x = Mutable 1; r = [use [cell = x]]; set r.cell 2; x", "2"],
            ["T = [x : Int]; U = [use T, y : Float]; ([1,2] : U)", "[x = 1, y = 2.0]"],
        ]
    ) {
        Deno.test(`record flattening checked=${checked}: ${source}`, () => {
            const i = new Interpreter();
            if (checked) i.enableChecking();
            const actual = i.renderString(i.run(parseDocument(source)));
            if (actual !== expected) {
                throw new Error(`${actual} != ${expected}`);
            }
        });
    }
    for (const source of ["[use 1]", "[use [1,2]]", "v = [x = 1]; v._ = 2"]) {
        Deno.test(`invalid flattening checked=${checked}: ${source}`, () => {
            const i = new Interpreter();
            if (checked) i.enableChecking();
            try {
                i.run(parseDocument(source));
            } catch {
                return;
            }
            throw new Error("Expected rejection");
        });
    }
}
