import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
for (const checked of [false, true]) {
    for (
        const [source, expected] of [
            [
                "a = [1,2,3]; a [first = 0, last = 2] = [last = 30, first = 10]; a",
                "[10,2,30]",
            ],
            ["a = [1,2]; a [x = 0, y = 1] = a [x = 1, y = 0]; a", "[2,1]"],
            ["a = [1,2]; a [x = 0, y = 0] = [x = 10, y = 20]; a", "[20,2]"],
            ["a = [1,2]; i = 0; keys = [x = i]; a keys = [x = 3]; a", "[3,2]"],
            ["a = [0..]; a [x = 2] = [x = 7]; take 4 a", "[0,1,7,3]"],
            ["v = [x = 1, y = 2]; v.[x = a, y = b] = [b = 20, a = 10]; v", "[x = 10, y = 20]"],
            ["v = [x = 1, y = 2]; v.[x = a, y = b] = v.[a = y, b = x]; v", "[x = 2, y = 1]"],
            [
                "v = [child = [x = 1, y = 2]]; v.child.[x = a] = [a = 3]; v",
                "[child = [x = 3, y = 2]]",
            ],
            ["v = [x = (1 : Float)]; v.[x = a] = [a = 3]; v", "[x = 3.0]"],
            // _ takes its value and discards it, as in a list pattern.
            ["v = [x = 0, y = 0]; v.[x,_] = [1,2]; v", "[x = 1, y = 0]"],
            ["v = [x = 0, y = 0]; pair = [7,8]; v.[_,y] = pair; v", "[x = 0, y = 8]"],
            ["v = [c = [x = 0, y = 0]]; v.c.[_,y] = [1,2]; v", "[c = [x = 0, y = 2]]"],
            ["v = [x = 0]; v.[_] = [5]; v", "[x = 0]"],
            ['a = [["x", 1], ["y", 2]]; a "x" = 10; a', '[["x", 10], ["y", 2]]'],
            ['a = [["x", 1], ["y","hi"]]; a "x" = 10; a', '[["x", 10], ["y","hi"]]'],
            ['a = [["x", 1], ["x", 2]]; a "x" = 10; a', '[["x", 10], ["x", 2]]'],
            ['a = [["x", (1 : Float)]]; k = "x"; a k = 2; a', '[["x", 2.0]]'],
            [
                "[first = x, rest = _] = [x = 1, y = 2, z = 3]; [first,rest]",
                "[1, [y = 2, z = 3]]",
            ],
            ["[rest = _, first = x] = [x = 1, y = 2]; [first,rest]", "[1, [y = 2]]"],
            ["[first = x, rest = _] = [x = 1]; rest", "[]"],
            [
                "f [first = x, rest = _] = [[..] = rest, x = first]; f [x = 1, y = 2]",
                "[y = 2, x = 1]",
            ],
            ["[y = 2] ~ [[a = x, r = _] -> a, _ -> 0]", "0"],
            ["f [a = x, r = _] = a; f [b = y, r = _] = b; f [y = 2]", "2"],
            ["f [first = x, rest = _] = rest; f [x = 1, y = 2]", "[y = 2]"],
            ["f [first = x, rest = _] = rest.y; f [x = 1, y = 2]", "2"],
            [
                "f [first = x, rest = _] = [first,rest]; [f [x = 1, y = 2], f [x = 3, z = 4]]",
                "[[1, [y = 2]], [3, [z = 4]]]",
            ],
            [
                "unused = missing : Dynamic; [first = x, rest = _] = [x = 1, y = unused]; first",
                "1",
            ],
            ["[first = x, rest = _] = [x = 1, y = 2]; [[..] = rest, x = first]", "[y = 2, x = 1]"],
        ]
    ) {
        Deno.test(`selection symmetry checked=${checked}: ${source}`, () => {
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
            "a = [1]; a [x = 0] = [y = 2]",
            "a = [1]; a [x = 1] = [x = 2]",
            "a = [1]; a [x = 0] = [x = .2]",
            "v = [x = 1]; v.[x = a] = [b = 2]",
            "v = [x = 1]; v.[y = a] = [a = 2]",
            "v = [x = 1]; v.[x = a] = [a = .2]",
            'a = [["x", 1]]; a "missing" = 2',
            'a = [["x", 1]]; a "x" = .2',
            "[first = x, rest = _] = [y = 1]",
            "f [first = x, rest = _] = rest.x; f [x = 1]",
            "[x:first,_:a,_:b]=[x:1]",
        ]
    ) {
        Deno.test(`selection symmetry rejection checked=${checked}: ${source}`, () => {
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

for (const checked of [false, true]) {
    for (
        const [initial, update, name, expected] of [
            ["a = [1,2]", "a [x = 0, y = 1] = [x = 10, y = .2]", "a", "[1,2]"],
            ["v = [x = 1, y = 2]", "v.[x = a, y = b] = [a = 10, b = .2]", "v", "[x = 1, y = 2]"],
            ['a = [["x", 1], ["y", 2]]', 'a "y" = .2', "a", '[["x", 1], ["y", 2]]'],
        ]
    ) {
        Deno.test(`failed selection update is atomic checked=${checked}: ${update}`, () => {
            const i = new Interpreter();
            if (checked) i.enableChecking();
            i.run(parseDocument(initial));
            let failed = false;
            try {
                i.run(parseDocument(update));
            } catch {
                failed = true;
            }
            if (!failed) throw new Error("Expected failure");
            const actual = i.renderString(i.run(parseDocument(name)));
            if (actual !== expected) {
                throw new Error(`${actual} != ${expected}`);
            }
        });
    }
}
