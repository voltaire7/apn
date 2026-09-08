import { parse } from "../main.ts";
import { Interpreter } from "../src/interp.ts";

for (const [source, expected] of [
    ['[x: 1, y: 2, z: 3] * [field, value] -> {\n    format "%: %" [field, value]\n} * x -> x', '["x: 1", "y: 2", "z: 3"]'],
    ["[1, 2] * x -> { x + 1 } * x -> { x * 2 }", "[4, 6]"],
    ["[1, 2] * (x: Int) -> { x + 1 } * x -> x * 2", "[4, 6]"],
    ["[1, 2] * x -> x * 2 + 1", "[3, 5]"],
    ["f = x -> { y = x + 1; y * 2 }\nf 3", "8"],
]) {
    Deno.test(`brace lambda boundary: ${source}`, () => {
        const interp = new Interpreter();
        const actual = interp.renderString(interp.run(parse(source)));
        if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
    });
}

Deno.test("chained record map prints each formatted entry", () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
    try {
        const interp = new Interpreter();
        const value = interp.run(parse('vec = [x: 1, y: 2, z: 3]\nvec * [field, value] -> {\n    format "%: %" [field, value]\n} * x -> print x'));
        interp.renderString(value);
        if (lines.join("\n") !== "x: 1\ny: 2\nz: 3") {
            throw new Error(`Unexpected output: ${JSON.stringify(lines)}`);
        }
    } finally {
        console.log = original;
    }
});
