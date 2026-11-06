import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

for (const checked of [false, true]) {
    for (
        const [source, expected] of [
            ["v.x = 1; [v,x]", "[1,1]"],
            ["v.(x) = 1; [v,x]", "[1,1]"],
            [
                "Option a = Some a | None; whole.(Some x) = Some 1; [whole,x]",
                "[Some 1, 1]",
            ],
            [
                "whole.[x: a, y: b] = [x: 1, y: 2]; [whole,a,b]",
                "[[x: 1, y: 2], 1, 2]",
            ],
            ["v.[x,y] = [1,2]; [v,x,y]", "[[1,2],1,2]"],
            ["v.[x,y] = [x: 1, y: 2, z: 3]; [v,x,y]", "[[x: 1, y: 2, z: 3], 1, 2]"],
            ["f v.x = [v,x]; f 1", "[1,1]"],
            ["f v.[x] = x; f v.[x,y] = y; f [1,2]", "2"],
            ["f v.[x,y] = [v,x,y]; f [1,2]", "[[1,2],1,2]"],
            [
                "f v.[x,y] = [v,x,y]; f [x: 1, y: 2, z: 3]",
                "[[x: 1, y: 2, z: 3], 1, 2]",
            ],
            ["f _.[x,y] = [x,y]; f [1,2]", "[1,2]"],
            ["f whole.(x::xs) = [whole,x]; f [1,2]", "[[1,2],1]"],
            [
                "Option a = Some a | None; f whole.(Some x) = [whole,x]; f (Some 1)",
                "[Some 1, 1]",
            ],
            ["f original.(x : Float) = [original,x]; f 1", "[1,1.0]"],
            [
                "f original.alias.(x : Float) = [original,alias,x]; f 1",
                "[1,1,1.0]",
            ],
            [
                "f original.(converted : [x: Float]) = [original,converted]; f [1]",
                "[[1], [x: 1.0]]",
            ],
            [
                "f whole.[x: a, y: b] = [whole,a,b]; f [x: 1, y: 2]",
                "[[x: 1, y: 2], 1, 2]",
            ],
            ["f x.x = x; f 1", "1"],
            ["f v.[x,x] = x; f [1,1]", "1"],
            ["v.x.y = 1; [v,x,y]", "[1,1,1]"],
            ["(v.x -> [v,x]) 1", "[1,1]"],
            ["[1,2] ~ [v.[x] -> 0, v.[x,y] -> y]", "2"],
            ["v = [x: 0]; v.x = 1; v", "[x: 1]"],
            ["v = [x: 1, y: 2]; v.[x,y] = v.[y,x]; v", "[x: 2, y: 1]"],
            ["v = [child: [x: 0]]; v.child.x = 1; v.child.x", "1"],
            ["v = [x: 1]; [{ v.x = 2; v.x }, v.x]", "[2,1]"],
            ["f v.x = 42; f (missing : Dynamic)", "42"],
            ["v.x = missing : Dynamic; 42", "42"],
            ["f v.(x::xs) = x; f [1..]", "1"],
            ["v.x <- return (Mutable 1); set x 2; v", "2"],
        ]
    ) {
        Deno.test(`dotted pattern checked=${checked}: ${source}`, () => {
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
            "f v.[x,x] = x; f [1,2]",
            "f v.[x,y] = x; f [1]",
            "v = 1; v.x = 2",
            "v = [x: 1]; v.[x] = 10",
        ]
    ) {
        Deno.test(`dotted pattern rejects checked=${checked}: ${source}`, () => {
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
Deno.test("dotted parameter shadows outer variable instead of updating it", () => {
    const i = new Interpreter();
    i.enableChecking();
    const actual = i.renderString(
        i.run(parseDocument("v = [x: 0]; f v.x = x; [f 1, v.x]")),
    );
    if (actual !== "[1,0]") throw new Error(actual);
});
Deno.test("failed dotted destructuring installs neither binding", () => {
    const i = new Interpreter();
    try {
        i.run(parseDocument("v.[x,y] = [1]"));
    } catch { /* expected */ }
    if (i.env.get("v") || i.env.get("x") || i.env.get("y")) {
        throw new Error("partial bindings leaked");
    }
});

Deno.test("nested dotted converting patterns retain static checks", () => {
    const i = new Interpreter();
    i.enableChecking();
    i.run(parseDocument("f original.alias.(x : Int) = x"));
    try {
        i.run(parseDocument('f "bad"'));
    } catch (error) {
        if (String(error).includes("cannot use String")) return;
        throw error;
    }
    throw new Error("Expected a static type error");
});
