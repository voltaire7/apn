import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

// to T x writes x as a T; from T x reads it back. Both are methods: a
// program's instances join the builtin ones (String, JSON, List Char).
function run(source: string): string {
    const i = new Interpreter();
    i.enableChecking();
    return i.renderString(i.run(parse(source)));
}
function failure(source: string): { kind?: string; message: string } {
    try { run(source); } catch (error) {
        const e = error as { kind?: string; message: string; hint?: string };
        return { kind: e.kind, message: `${e.message} ${e.hint ?? ""}` };
    }
    throw new Error(`accepted: ${source}`);
}
const TEMPERATURE = "Celsius = | C Float\nFahrenheit = | F Float\nto Celsius = (F f) -> C ((f - 32) * 5 / 9)\n";

for (const [source, expected] of [
    ["to String 1.5 ++ \"!\"", '"1.5!"'],
    ["Int (from String \"42\") + 1", "43"],
    ["to JSON [a: 1, b: [true]]", '"{"a":1,"b":[true]}"'],
    ["from JSON \"[1,2]\"", "[1, 2]"],
    ["to (List Char) \"a😀\"", "['a', '😀']"],
    ["from (List Char) ['h', 'i']", '"hi"'],
    // Any other type converts as applying it does.
    ["Money = Float\nto Float (Money 1.2)", "1.2"],
    // A bare type name in a pattern matches that type, as a value.
    ["describe Int = \"integer\"\ndescribe String = \"text\"\n[describe Int, describe String]", '["integer", "text"]'],
    [TEMPERATURE + "to Celsius (F 212)", "C 100.0"],
    [TEMPERATURE + "to String 2", '"2"'],
    // A list template converts position by position, as cast does: [Char] is one Char.
    ["to [Char] \"h\"", "['h']"],
    ["to [Char, Char] \"hi\"", "['h', 'i']"],
    ["to [Float] [1]", "[1.0]"],
    ["to [Int, String] [x: 1, y: \"a\"]", '[x: 1, y: "a"]'],
    // The checker evaluates to and from as the run does, beside a program's own instances.
    [TEMPERATURE + "Vect 2 Char (to (List Char) \"a😀\")", "['a', '😀']"],
    ["Money = Float\nVect 1 Float [to Float (Money 1.2)]", "[1.2]"],
] as const) {
    Deno.test(`conversions: ${source}`, () => {
        const actual = run(source);
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
}

for (const [source, kind, message] of [
    ["to (List Char) 5", "type", "cannot use Int where String is required"],
    ["Celsius = | C Float\nfrom Celsius 1", "type", "no from instance for Celsius"],
    ["to 5 1", "type", "to expects a type"],
    ["to [Char] \"hello\"", "runtime", "list template and input must have the same length"],
    ["from [Char] \"h\"", "type", "no from instance for a list template"],
    [TEMPERATURE + "Vect 3 Char (to (List Char) \"a😀\")", "type", "length mismatch: expected 3, got 2"],
    // The old names are gone, with a hint to the new spelling.
    ["chars \"hi\"", "type", "to (List Char)"],
    ["toString 1", "type", "to String"],
] as const) {
    Deno.test(`conversions reject: ${source}`, () => {
        const error = failure(source);
        if (error.kind !== kind || !error.message.includes(message)) throw new Error(`${error.kind}: ${error.message}`);
    });
}
