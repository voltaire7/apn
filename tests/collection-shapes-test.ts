import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

for (const checked of [false, true]) {
    for (
        const [source, expected] of [
            ["[10,20,30] [first = 0, last = 2]", "[first = 10, last = 30]"],
            ["[Int] [x = 0]", "[x : Int]"],
            ["choose i = [10,20] [x = i]; choose 1", "[x = 20]"],
            ["[1] [x = (0 : Dynamic)]", "[x = 1]"],
            ["[x = 1] ~ [([x] : [t]) -> x, _ -> 0]", "1"],
            ["[answer = 1] ~ [([x] : [t]) -> x, _ -> 0]", "0"],
            [
                "[10,20,30] [last = -1, first = 0, again = 0]",
                "[last = 30, first = 10, again = 10]",
            ],
            [
                "Direction = North | South; [10,20] [a = South, b = North]",
                "[a = 20, b = 10]",
            ],
            ["[0..] [x = 100]", "[x = 100]"],
            ["unused = missing : Dynamic; r = [1,unused] [good = 0]; r.good", "1"],
            ["([x = 1] : [Float])", "[x = 1.0]"],
            ["([1] : [Float])", "[1.0]"],
            ["r = ([x = 1] : [Float]); r.x + .5", "1.5"],
            [
                "unused = missing : Dynamic; r = ([good = 1, bad = unused] : [Int,Int]); r.good",
                "1",
            ],
            [
                "source = [x = 1]; r = (source : [Float]); [source,r]",
                "[[x = 1], [x = 1.0]]",
            ],
            ['[(+ 1)].[x = 1]', '[x = 2]'],
            ['([name = "a", age = 2] : [String,Int])', '[name = "a", age = 2]'],
            ["[(+ 1), (* 2)].[b = 3, a = 4]", "[b = 4, a = 8]"],
            ["([nested = [x = 1]] : [[Float]])", "[nested = [x = 1.0]]"],
            ["[].([] [])", "[]"],
            ["f ([x] : [t]) = [t,x]; f [x = 1]", "[Int,1]"],
            ["f ([x] : [t]) = [t,x]; f [extra = 2, x = (1 : Int32)]", "[Int32,1]"],
            [
                'f ([x,y] : [a,b]) = [a,b,x,y]; f [y = "hi", x = 1]',
                '[Int, String, 1, "hi"]',
            ],
            ["f ([x] : [Int]) = x; f [x = 1]", "1"],
            ["f ([x] : [Float]) = x; f [x = 1]", "1.0"],
            [
                "f whole@([x] : [t]) = [whole,t,x]; f [x = 1, y = 2]",
                "[[x = 1, y = 2], Int, 1]",
            ],
            ["([x] : [t]) <- return [x = 1]; [t,x]", "[Int,1]"],
            [
                'f ([x] : [t]) = [t,x]; [f [1], f [x = "hi"]]',
                '[[Int,1],[String,"hi"]]',
            ],
        ]
    ) {
        Deno.test(`collection shapes checked=${checked}: ${source}`, () => {
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
            "[Int] [x = 1]",
            '[1] [x = "0"]',
            "[1] [x = .2]",
            "([x = 1, y = 2] : [Int])",
            "([x = 1] : [Int,Int])",
            "f ([x] : [t]) = x; f [answer = 1]",
            "f ([x] : [Int]) = x; f [x = .2]",
            'f ([x,y] : [t,t]) = x; f [x = 1, y = "hi"]',
        ]
    ) {
        Deno.test(`collection shape rejection checked=${checked}: ${source}`, () => {
            const i = new Interpreter();
            if (checked) i.enableChecking();
            try {
                i.renderString(i.run(parseDocument(source)));
            } catch {
                return;
            }
            throw new Error("Expected rejection");
        });
    }
}
