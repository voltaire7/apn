import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
for (const checked of [false, true]) {
    for (
        const [source, expected] of [
            ["f ([t] [x]) = [t, x]; f [1]", "[Int, 1]"],
            ["f ([t] [x]) = [t, x]; f [Int32 1]", "[Int32, 1]"],
            [
                'f ([t, u] [x, y]) = [t, u, x, y]; f [1, "hi"]',
                '[Int, String, 1, "hi"]',
            ],
            ["f ([t, t] [x, y]) = [t, x, y]; f [1, 2]", "[Int, 1, 2]"],
            ["f ([x: t] v) = [t, v.x]; f [x: 1]", "[Int, 1]"],
            ["f ([[t]] [[x]]) = [t, x]; f [[1]]", "[Int, 1]"],
            ["f ([Int] [x]) = x; f [1]", "1"],
            [
                'f ([t] [x]) = [t, x]; [f [1], f ["hi"]]',
                '[[Int, 1], [String, "hi"]]',
            ],
            ["([t] [x]) <- return ([1]); [t, x]", "[Int, 1]"],
        ]
    ) {
        Deno.test(`type-shape pattern checked=${checked}: ${source}`, () => {
            const i = new Interpreter();
            if (checked) i.enableChecking();
            const actual = i.renderString(i.run(parseDocument(source)));
            if (actual !== expected) {
                throw new Error(`${actual} != ${expected}`);
            }
        });
    }
    for (
        const source of [
            'f ([t, t] [x, y]) = x; f [1, "hi"]',
            "f ([t] [x]) = x; f [1, 2]",
        ]
    ) {
        Deno.test(`type-shape mismatch checked=${checked}: ${source}`, () => {
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
