import { Interpreter } from "../src/interp.ts";
import { parse, parseDocument } from "../src/parser.ts";

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
const TEMPERATURE = "Celsius = | C Float\nFahrenheit = | F Float\nto Celsius = F f -> C ((f - 32) * 5 / 9)\n";

for (const [source, expected] of [
    ["to String 1.5 ++ \"!\"", '"1.5!"'],
    ["(from String \"42\" : Int) + 1", "43"],
    ["to JSON [a = 1, b = [True]]", '"{\\"a\\":1,\\"b\\":[true]}"'],
    ["from JSON \"[1,2]\"", "[1,2]"],
    ["to (List Char) \"a😀\"", "['a','😀']"],
    ["from (List Char) ['h','i']", '"hi"'],
    // Any other type converts as applying it does.
    ["Money = | MkMoney Float\nto Float (MkMoney m) = m\nto Float (MkMoney 1.2)", "1.2"],
    // A bare type name in a pattern matches that type, as a value.
    ["describe Int = \"integer\"\ndescribe String = \"text\"\n[describe Int, describe String]", '["integer","text"]'],
    [TEMPERATURE + "to Celsius (F 212)", "C 100.0"],
    [TEMPERATURE + "to String 2", '"2"'],
    // A list template converts position by position, as cast does: [Char] is one Char.
    ["to [Char] \"h\"", "['h']"],
    ["to [Char,Char] \"hi\"", "['h','i']"],
    ["to [Float] [1]", "[1.0]"],
    ["to [Int,String] [x = 1, y = \"a\"]", '[x = 1, y = "a"]'],
    // The checker evaluates to and from as the run does, beside a program's own instances.
    [TEMPERATURE + "(to (List Char) \"a😀\" : Vect 2 Char)", "['a','😀']"],
    ["Money = | MkMoney Float\nto Float (MkMoney m) = m\n([to Float (MkMoney 1.2)] : Vect 1 Float)", "[1.2]"],
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
    [TEMPERATURE + "(to (List Char) \"a😀\" : Vect 3 Char)", "type", "length mismatch: expected 3, got 2"],
    // The old names are gone, with a hint to the new spelling.
    ["chars \"hi\"", "type", "to (List Char)"],
    ["toString 1", "type", "to String"],
] as const) {
    Deno.test(`conversions reject: ${source}`, () => {
        const error = failure(source);
        if (error.kind !== kind || !error.message.includes(message)) throw new Error(`${error.kind}: ${error.message}`);
    });
}
// An operand of a type the program defines, met by one of another type that no
// clause of the operator takes, converts the other through a to instance, and
// the operator runs again. Checked and unchecked runs agree.
const MONEY = "Money = | MkMoney Float\nMkMoney a + MkMoney b = MkMoney (a + b)\nMkMoney a < MkMoney b = a < b\n";
const CENTS = "Cents = | MkCents Int\nMkCents a + MkCents b = MkCents (a + b)\nto Money (MkCents c) = MkMoney ((c : Float) / 100)\n";
for (const checked of [true, false]) {
    const each = (source: string) => {
        const i = new Interpreter();
        if (checked) i.enableChecking();
        return i.renderString(i.run(parseDocument(source)));
    };
    for (const [source, expected] of [
        [MONEY + "to Money (x : Float) = MkMoney x\n[MkMoney 1.0 + 2.5, 2.5 + MkMoney 1.0, MkMoney 1.0 < 2.0]", "[MkMoney 3.5, MkMoney 3.5, True]"],
        [MONEY + CENTS + "MkMoney 1.0 + MkCents 50", "MkMoney 1.5"],
        // The other way round, where a built-in type is needed: an index,
        // arithmetic, a typed pattern; an enumeration's positions are such instances.
        ["Level = | MkLevel Int\nto Int (MkLevel n) = n\nf (i : Int) = i + 1\n[[10,20,30] (MkLevel 2), MkLevel 2 * 5, f (MkLevel 4)]", "[30,10,5]"],
        ["Direction = North | East | South\ng (i : Int) = i * 10\n[to Int South, g South, [5,6] East, East + 1]", "[2,20,6,2]"],
        // A pattern of the value's own type comes before a conversion.
        ["Level = | MkLevel Int\nto Int (MkLevel n) = n\nf (MkLevel n) = 9\nf (i : Int) = i\n[f (MkLevel 4), f 7]", "[9,7]"],
    ] as const) Deno.test(`operators promote through to (checked=${checked}): ${source}`, () => {
        const actual = each(source);
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
    for (const [source, message] of [
        [MONEY + "MkMoney 1.0 + 2.5", checked ? "cannot combine Money and Float" : "cannot apply '+'"],
        [MONEY + CENTS + "to Cents (MkMoney m) = MkCents (round (m * 100))\nMkMoney 1.0 + MkCents 50", "ambiguous: '+' could convert Money to Cents or Cents to Money"],
    ] as const) Deno.test(`operators promote only one way (checked=${checked}): ${source}`, () => {
        try { each(source); } catch (error) { if ((error as Error).message.includes(message)) return; throw error; }
        throw new Error("accepted");
    });
}
