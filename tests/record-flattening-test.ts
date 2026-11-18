import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
for (const checked of [false, true]) {
    for (
        const [source, expected] of [
            ["[[..] = [x = 1], y = 2, z = 3]", "[x = 1, y = 2, z = 3]"],
            ['base = [x = 1]; [[..] = base, x = "hi"]', '[x = "hi"]'],
            ['base = [x = 1]; [x = "hi", [..] = base]', "[x = 1]"],
            ["[[..] = [x = 1], [..] = [y = 2], z = 3]", "[x = 1, y = 2, z = 3]"],
            ["r = [[..] = [child = [x = 1]], y = 2]; r.child.x", "1"],
            ["x = 1; r = [x = x, [..] = [y = 2]]; r.y", "2"],
            ["base = [x = 1]; r = [[..] = base]; r.x = 2; [base.x,r.x]", "[1,2]"],
            // _ = e binds nothing, in a record as in a block.
            ["base = [x = 1]; [_ = base, y = 2]", "[y = 2]"],
            // A record ++ a record: one record, the written one's items seeing
            // the first's names; nothing of the first runs again.
            ["[a = 1] ++ [x = 1]", "[a = 1, x = 1]"],
            ["r = [a = 1]; r ++ [x = a + 1]", "[a = 1, x = 2]"],
            ["make n = [a = n]; make 5 ++ [x = 1]", "[a = 5, x = 1]"],
            ["r = [a = 1]; s = [b = 2, a = 3]; r ++ s", "[a = 3, b = 2]"],
            ["c = [x = 1] ++ [x + 1]; [c, do c]", "[[2], 2]"],
            ["s.[..] = [Box = | Box Int, unbox (Box n) = n]; m = s ++ [wrap n = Box n]; unbox (m.wrap 4)", "4"],
            [
                "unused = missing : Dynamic; base = [x = unused]; r = [[..] = base, y = 2]; r.y",
                "2",
            ],
            ['v = [x = 1]; v._ = [x = "hi", y = 2]; v', '[x = "hi", y = 2]'],
            ["v = [inner = [x = 1]]; v.inner._ = [y = 2]; v.inner", "[x = 1, y = 2]"],
            ["x = Mutable 1; r = [[..] = [cell = x]]; set r.cell 2; x", "2"],
            ["T = [x : Int]; U = [[..] = T, y : Float]; ([1,2] : U)", "[x = 1, y = 2.0]"],
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
    for (const source of ["[[..] = 1]", "[[..] = [1,2]]", "v = [x = 1]; v._ = 2"]) {
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
