import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

const schema = "Vector3 = [x: Float, y: Float, z: Float]";
const definition = "func (Vector3 v) = v.x";
for (const argument of ["[1,2,3]", "[x: 1, y: 2, z: 3]"]) {
    for (const incremental of [false, true]) Deno.test(`checked record pattern: ${argument}, incremental=${incremental}`, () => {
        const interpreter = new Interpreter();
        interpreter.enableChecking();
        const statements = [schema, definition, `func ${argument}`];
        let value;
        if (incremental) for (const statement of statements) value = interpreter.run(parse(statement));
        else value = interpreter.run(parse(statements.join("; ")));
        const result = interpreter.renderString(value!);
        if (result !== "1.0") throw new Error(`expected Float 1.0, got ${result}`);
    });
}
for (const argument of ["[]", "[1,2]", "[1,2,3,4]", '[1,"bad",3]', "[x: 1, y: 2]"]) {
    Deno.test(`checked record pattern rejects ${argument}`, () => {
        const interpreter = new Interpreter();
        interpreter.enableChecking();
        try {
            interpreter.run(parse(`${schema}\n${definition}\nfunc ${argument}`));
        } catch (error) {
            if ((error as { kind?: string }).kind === "type") return;
            throw error;
        }
        throw new Error("invalid argument was accepted");
    });
}

for (const [source, expected] of [
    [`${schema}; Alias = Vector3; f (Alias v) = v.z; f [1,2,3]`, "3.0"],
    ['Shape = [point: [x: Float], label: String]; f (Shape v) = v.point.x; f [point: [x: 1], label: "a"]', "1.0"],
    ['Pair = [String,Int]; f (Pair xs) = xs 1; f ["x",2]', "2"],
] as const) Deno.test(`checked structural schema preserves payload types: ${source}`, () => {
    const interpreter = new Interpreter();
    interpreter.enableChecking();
    const actual = interpreter.renderString(interpreter.run(parse(source)));
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});

Deno.test("record-pattern printing converts positional input before the body runs", () => {
    const interpreter = new Interpreter();
    interpreter.enableChecking();
    const lines: string[] = [];
    const log = console.log;
    console.log = (...values: unknown[]) => { lines.push(values.join(" ")); };
    try {
        interpreter.run(parse(`${schema}; func (Vector3 v) = print v.x; func [1,2,3]`));
    } finally {
        console.log = log;
    }
    if (lines.join("\n") !== "1.0") throw new Error(JSON.stringify(lines));
});
for (const [source, expected] of [
    ["[x,y] = [y: 2, x: 10]; x - y", "8"],
    ['[x,y] = [y: "b", x: 1]; [x + 1, y ++ "c"]', '[2,"bc"]'],
    ["[x,y] <- return [y: 2, x: 10]; x - y", "8"],
    ["r = { [x,y] = [y: 2, x: 10]; x - y }; r", "8"],
    ["[x] = [x: 1, y: 2]; x", "1"],
    ["[a,b] = [1,2]; a + b", "3"],
] as const) Deno.test(`checked standalone list pattern: ${source}`, () => {
    const interpreter = new Interpreter();
    interpreter.enableChecking();
    const result = interpreter.renderString(interpreter.run(parse(source)));
    if (result !== expected) throw new Error(`expected ${expected}, got ${result}`);
});
for (const source of ["[x,z] = [y: 2, x: 1]; x", '[x,y] = [y: "b", x: 1]; y + 1']) {
    Deno.test(`checked standalone list pattern rejects: ${source}`, () => {
        const interpreter = new Interpreter();
        interpreter.enableChecking();
        try { interpreter.run(parse(source)); } catch (error) {
            if ((error as { kind?: string }).kind === "type") return;
            throw error;
        }
        throw new Error("invalid binding was accepted");
    });
}
