import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
for (const checked of [false, true]) {
    for (
        const [source, expected] of [
            ["f ([x] : [t]) = [t,x]; f [1]", "[Int,1]"],
            ["f ([x] : [t]) = [t,x]; f [(1 : Int32)]", "[Int32,1]"],
            [
                'f ([x,y] : [t,u]) = [t,u,x,y]; f [1, "hi"]',
                '[Int, String, 1, "hi"]',
            ],
            ["f ([x,y] : [t,t]) = [t,x,y]; f [1,2]", "[Int,1,2]"],
            ["f (v : [x = t]) = [t,v.x]; f [x = 1]", "[Int,1]"],
            ["f ([[x]] : [[t]]) = [t,x]; f [[1]]", "[Int,1]"],
            ["f ([x] : [Int]) = x; f [1]", "1"],
            [
                'f ([x] : [t]) = [t,x]; [f [1], f ["hi"]]',
                '[[Int,1],[String,"hi"]]',
            ],
            ["([x] : [t]) <- return [1]; [t,x]", "[Int,1]"],
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
            'f ([x,y] : [t,t]) = x; f [1, "hi"]',
            "f ([x] : [t]) = x; f [1,2]",
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
