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
    // A String is its characters: as its base, List Char, it is a list.
    ["to (List Char) \"a😀\"", "['a','😀']"],
    ["(['h','i'] : String)", '"hi"'],
    // Any other type converts as applying it does.
    ["Money (x : Float) = _\nto Float (Money m) = m\nto Float (Money 1.2)", "1.2"],
    // A bare type name in a pattern matches that type, as a value.
    ["describe Int = \"integer\"\ndescribe String = \"text\"\n[describe Int, describe String]", '["integer","text"]'],
    [TEMPERATURE + "to Celsius (F 212)", "C 100.0"],
    [TEMPERATURE + "to String 2", '"2"'],
    // A list template converts position by position: [Char] is one Char.
    ["to [Char] \"h\"", "['h']"],
    ["to [Char,Char] \"hi\"", "['h','i']"],
    ["to [Float] [1]", "[1.0]"],
    ["to [Int,String] [x = 1, y = \"a\"]", '[x = 1, y = "a"]'],
    // The checker evaluates to and from as the run does, beside a program's own instances.
    [TEMPERATURE + "(\"a😀\" : Vect 2 Char)", "['a','😀']"],
    ["Money (x : Float) = _\nto Float (Money m) = m\n([to Float (Money 1.2)] : Vect 1 Float)", "[1.2]"],
] as const) {
    Deno.test(`conversions: ${source}`, () => {
        const actual = run(source);
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
}

for (const [source, kind, message] of [
    ["to (List Char) 5", "type", "cannot use Int where List Char is required"],
    ["Celsius = | C Float\nfrom Celsius 1", "type", "no from instance for Celsius"],
    ["to 5 1", "type", "to expects a type"],
    ["to [Char] \"hello\"", "runtime", "list template and input must have the same length"],
    ["from [Char] \"h\"", "type", "no from instance for a list template"],
    [TEMPERATURE + "(\"a😀\" : Vect 3 Char)", "type", "length mismatch: expected 3, got 2"],
    ["from (List Char) ['h','i']", "type", "no from instance for List Char"],
    // The old names are gone, with a hint to the new spelling.
    ["fromChars ['h']", "type", "(x : String)"],
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
const MONEY = "Money (m : Float) = _\nMoney a + Money b = Money (a + b)\nMoney a < Money b = a < b\n";
const CENTS = "Cents (c : Int) = _\nCents a + Cents b = Cents (a + b)\nto (Money Float) (Cents c) = Money ((c : Float) / 100)\n";
for (const checked of [true, false]) {
    const each = (source: string) => {
        const i = new Interpreter();
        if (checked) i.enableChecking();
        return i.renderString(i.run(parseDocument(source)));
    };
    for (const [source, expected] of [
        [MONEY + "to (Money Float) (x : Float) = Money x\n[Money 1.0 + 2.5, 2.5 + Money 1.0, Money 1.0 < 2.0]", "[Money 3.5, Money 3.5, True]"],
        [MONEY + CENTS + "Money 1.0 + Cents 50", "Money 1.5"],
        // The other way round, where a built-in type is needed: an index,
        // arithmetic, a typed pattern; an enumeration's positions are such instances.
        ["Level (n : Int) = _\nto Int (Level n) = n\nf (i : Int) = i + 1\n[[10,20,30] (Level 2), Level 2 * 5, f (Level 4)]", "[30,10,5]"],
        ["Direction = North | East | South\ng (i : Int) = i * 10\n[to Int South, g South, [5,6] East, East + 1]", "[2,20,6,2]"],
        // A pattern of the value's own type comes before a conversion.
        ["Level (n : Int) = _\nto Int (Level n) = n\nf (Level n) = 9\nf (i : Int) = i\n[f (Level 4), f 7]", "[9,7]"],
    ] as const) Deno.test(`operators promote through to (checked=${checked}): ${source}`, () => {
        const actual = each(source);
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
    for (const [source, message] of [
        [MONEY + "Money 1.0 + 2.5", checked ? "cannot combine Money and Float" : "cannot apply '+'"],
        [MONEY + CENTS + "to (Cents Int) (Money m) = Cents (round (m * 100))\nMoney 1.0 + Cents 50", "ambiguous: '+' could convert Money to Cents or Cents to Money"],
    ] as const) Deno.test(`operators promote only one way (checked=${checked}): ${source}`, () => {
        try { each(source); } catch (error) { if ((error as Error).message.includes(message)) return; throw error; }
        throw new Error("accepted");
    });
}
