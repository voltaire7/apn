import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

// to T x writes x as a T; from T x reads it back. Both are methods: a
// program's instances join the builtin ones (String, JSON, Chars).
function run(source: string): string {
    const i = new Interpreter();
    i.enableChecking();
    return i.renderString(i.run(parse(source)));
}
function failure(source: string): { kind?: string; message: string } {
    try { run(source); } catch (error) { return error as { kind?: string; message: string }; }
    throw new Error(`accepted: ${source}`);
}
const TEMPERATURE = "Celsius = | C Float; Fahrenheit = | F Float; to Celsius = (F f) -> C ((f - 32) * 5 / 9); ";

for (const [source, expected] of [
    ["to String 1.5 ++ \"!\"", '"1.5!"'],
    ["Int (from String \"42\") + 1", "43"],
    ["to JSON [a: 1, b: [true]]", '"{"a":1,"b":[true]}"'],
    ["from JSON \"[1,2]\"", "[1,2]"],
    ["to Chars \"a😀\"", "['a','😀']"],
    ["from Chars ['h','i']", '"hi"'],
    // Any other type converts as applying it does.
    ["Money = Float; to Float (Money 1.2)", "1.2"],
    // A bare type name in a pattern matches that type, as a value.
    ["describe Int = \"integer\"; describe String = \"text\"; [describe Int,describe String]", '["integer","text"]'],
    [TEMPERATURE + "to Celsius (F 212)", "C 100.0"],
    [TEMPERATURE + "to String 2", '"2"'],
] as const) {
    Deno.test(`conversions: ${source}`, () => {
        const actual = run(source);
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
}

for (const [source, kind, message] of [
    ["to Chars 5", "type", "cannot use Int where String is required"],
    ["Celsius = | C Float; from Celsius 1", "type", "no from instance for Celsius"],
    ["to 5 1", "type", "to expects a type"],
] as const) {
    Deno.test(`conversions reject: ${source}`, () => {
        const error = failure(source);
        if (error.kind !== kind || !error.message.includes(message)) throw new Error(`${error.kind}: ${error.message}`);
    });
}
