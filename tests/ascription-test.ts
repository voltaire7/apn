// (x : T) makes x a member of T (a conversion it declares, lossless); a type
// takes no value, so T x is an error however it is applied.
import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

function result(source: string): string {
    const i = new Interpreter();
    return i.renderString(i.run(parseDocument(source)));
}
for (const [source, expected] of [
    ['std <- import "std"; [..] = std.text\n([\'h\',\'i\'] : String)', '"hi"'],
    ['(to [Char,Char,Char] "a😀é" : String)', '"a😀é"'],
    ['([] : String)', '""'],
    ["(['h','i'] : String)", '"hi"'],
    ['("hi" : String)', '"hi"'],
    ["Text = String\n(['h','i'] : Text)", '"hi"'],
    ["xs = 'a'::xs\n(take 3 xs : String)", '"aaa"'],
    ['((2 : Float) : Int)', '2'],
    ['payload (x : t) = [t,x]\npayload (5 : Int32)', '[Int32,5]'],
    ['payload (x : Float) = x\npayload (.2 : Float)', '0.2'],
    ['payload (x : Number) = x\npayload (5 : Int32)', '5'],
    ['payload (x : Int) = x\npayload 2.0', '2'],
    ['f (x : Int) = 1\nf x = 2\nf .2', '2'],
    ['f (x : Float32) = 1\nf x = 2\nf .1', '2'],
    ['f (x : Float) = 1\nf x = 2\nf 9007199254740993', '2'],
    ['.2 ~ [(x : Int) -> 1, _ -> 2]', '2'],
    ['payload (x : Int) = x\npayload (2 : Float)', '2'],
    ['[.2 == (.2 : Float), (1 : Int) == (1 : Float), (1 : Int32) == 1]', '[True,True,True]'],
    ['(True : Bool)', 'True'],
    ['take 1 ([1,missing] : List _)', '[1]'],
    ['(identity : Int -> Int) <- return (x -> x); ((x -> x + 1) : typeOf identity) 2', '3'],
    ['(.2 : Float) + .3', '0.5'],
    ['(1 : Int) + .2', '1.2'],
    // A function converts: to T x is (x : T) as one.
    ['map (to Int32) [1,2]', '[1,2]'],
    ['[1..3] * to Float', '[1.0,2.0,3.0]'],
] as const) Deno.test(`ascription: ${source}`, () => {
    const actual = result(source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const [source, error] of [
    ['(.2 : Int)', 'lossy conversion'],
    ['(-.2 : Int)', 'lossy conversion'],
    ['(-1.7 : Int)', 'lossy conversion'],
    ['(1/3 : Int)', 'lossy conversion'],
    ['(.1 + .1 : Int)', 'lossy conversion'],
    ['((1/3 : Fraction) : Int)', 'lossy conversion'],
    ['((.2 : Complex) : Int)', 'lossy conversion'],
    ['x = .2 : Float\ny = x : Int\n[y,x]', 'lossy conversion'],
    ['mine t x = x ~ [(value : source) -> (value : t)]\nmine Int (.2 : Float)', 'lossy conversion'],
    ['mine t (x : source) = x : t\nmine Int (.2 : Complex)', 'lossy conversion'],
    ['([1] : String)', 'list of Char'],
    ['(["h"] : String)', 'list of Char'],
    ["(['h',missing] : String)", 'unbound variable'],
    ['((.2 : Float) : Int)', 'lossy conversion'],
    ['f (x : Int) = x\nf (.2 : Float)', 'no clause'],
    ['func (x : Int) = print Int\nfunc .2', 'no clause'],
    ['((x : Int) -> x) .2', 'no clause'],
    ['Count (x : Int) = _\nf (Count x) = x\nf .2', 'no clause'],
    ['(128 : Int8)', 'out of range'],
    ['((128 : Int) : Int8)', 'out of range'],
    ['((-1 : Int) : UInt)', 'negative integer'],
    ['((1+2i : Complex) : Int)', 'real number'],
    // A type takes types, not a value, written or passed on.
    ['Int32 5', 'Int32 is a type, not a function'],
    ['map Int32 [1,2]', 'Int32 is a type, not a function'],
    ['[1..4] * Int32', 'Int32 is a type, not a function'],
    ['f g = g 5\nf Float', 'Float is a type, not a function'],
    ['HashMap [["a", 1]]', 'HashMap is a type, not a function'],
    ['cast Int 1', "unbound variable 'cast'"],
] as const) Deno.test(`ascription rejects: ${source}`, () => {
    try { result(source); } catch (e) {
        if (e instanceof Error && e.message.includes(error)) return;
        throw e;
    }
    throw new Error(`Expected ${error}`);
});
// (x : t) with t a parameter is checked at each call, with the type it is given.
for (const [source, expected] of [
    ['ascribe t x : t = x\nascribe (HashMap _ _) [["a", 1]]', '[["a", 1]]'],
    ["ascribe t x : t = x\nascribe Int (2 / 2)", "1"],
    ['ascribe t x : t = x\nascribe Int "a"', "error: cannot use String where Int is required"],
] as const) Deno.test(`checked ascription to a parameter: ${source}`, () => {
    const i = new Interpreter();
    i.enableChecking();
    let actual: string;
    try { actual = i.renderString(i.run(parseDocument(source))); }
    catch (e) { actual = `error: ${(e as Error).message.split("\n")[0]}`; }
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
