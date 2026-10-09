import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

for (const checked of [false, true]) {
    for (
        const [source, expected] of [
            ["[10,20,30] [first: 0, last: 2]", "[first: 10, last: 30]"],
            ["[Int] [x: 0]", "[x: Int]"],
            ["choose i = [10,20] [x: i]; choose 1", "[x: 20]"],
            ["[1] [x: Dynamic 0]", "[x: 1]"],
            ["match [x: 1] [([t] [x]) -> x,_ -> 0]", "1"],
            ["match [answer: 1] [([t] [x]) -> x,_ -> 0]", "0"],
            [
                "[10,20,30] [last: -1, first: 0, again: 0]",
                "[last: 30, first: 10, again: 10]",
            ],
            [
                "Direction = North | South; [10,20] [a: South, b: North]",
                "[a: 20, b: 10]",
            ],
            ["[0..] [x: 100]", "[x: 100]"],
            ["unused = Dynamic missing; r = [1,unused] [good: 0]; r.good", "1"],
            ["[Float].[x: 1]", "[x: 1.0]"],
            ["[Float].[1]", "[1.0]"],
            ["r = [Float].[x: 1]; r.x + .5", "1.5"],
            [
                "unused = Dynamic missing; r = [Int,Int].[good: 1, bad: unused]; r.good",
                "1",
            ],
            [
                "source = [x: 1]; r = [Float].source; [source,r]",
                "[[x: 1],[x: 1.0]]",
            ],
            ['[(+ 1)].["x": 1]', '["x": 2]'],
            ['[String,Int].[name: "a", age: 2]', '[name: "a", age: 2]'],
            ["[(+ 1),(* 2)].[b: 3, a: 4]", "[b: 4, a: 8]"],
            ["[[Float]].[nested: [x: 1]]", "[nested: [x: 1.0]]"],
            ["[].([] [])", "[]"],
            ["f ([t] [x]) = [t,x]; f [x: 1]", "[Int,1]"],
            ["f ([t] [x]) = [t,x]; f [extra: 2, x: Int32 1]", "[Int32,1]"],
            [
                'f ([a,b] [x,y]) = [a,b,x,y]; f [y: "hi", x: 1]',
                '[Int,String,1,"hi"]',
            ],
            ["f ([Int] [x]) = x; f [x: 1]", "1"],
            ["f ([Float] [x]) = x; f [x: 1]", "1.0"],
            [
                "f whole.([t] [x]) = [whole,t,x]; f [x: 1, y: 2]",
                "[[x: 1, y: 2],Int,1]",
            ],
            ["([t] [x]) <- return ([x: 1]); [t,x]", "[Int,1]"],
            [
                'f ([t] [x]) = [t,x]; [f [1],f [x: "hi"]]',
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
            "[Int] [x: 1]",
            '[1] [x: "0"]',
            "[1] [x: .2]",
            "[Int].[x: 1, y: 2]",
            "[Int,Int].[x: 1]",
            "f ([t] [x]) = x; f [answer: 1]",
            "f ([Int] [x]) = x; f [x: .2]",
            'f ([t,t] [x,y]) = x; f [x: 1, y: "hi"]',
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
