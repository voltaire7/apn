import { Interpreter } from "../src/interp.ts";
import { NATIVES } from "../src/natives.ts";
import { parseDocument } from "../src/parser.ts";

function result(source: string): string {
    const i = new Interpreter();
    return i.renderString(i.run(parseDocument(source)));
}
for (const [source, expected] of [
    ['std <- import "std"; use std.text\ncast String $ to (List Char) "hello"', '"hello"'],
    ['cast String $ cast [Char,Char,Char] $ "a😀é"', '"a😀é"'],
    ['cast String []', '""'],
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
    ['cast Bool True', 'True'],
    ['take 1 (cast List [1,missing])', '[1]'],
    ['(identity : Int -> Int) <- return (x -> x); cast (typeOf identity) (x -> x + 1) 2', '3'],
    ['(.2 : Float) + .3', '0.5'],
    ['(1 : Int) + .2', '1.2'],
] as const) Deno.test(`APN cast: ${source}`, () => {
    const actual = result(source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const [source, error] of [
    ['(.2 : Int)', 'lossy conversion'],
    ['(-.2 : Int)', 'lossy conversion'],
    ['(-1.7 : Int)', 'lossy conversion'],
    ['(1/3 : Int)', 'lossy conversion'],
    ['(.1 + .1 : Int)', 'lossy conversion'],
    ['cast Int (.2 : Float)', 'lossy conversion'],
    ['cast Int $ (.2 : Float)', 'lossy conversion'],
    ['cast Int (1/3 : Fraction)', 'lossy conversion'],
    ['cast Int (.2 : Complex)', 'lossy conversion'],
    ['x = .2 : Float\ny = cast Int x\n[y,x]', 'lossy conversion'],
    ['mine t x = x ~ [(value : source) -> (value : t)]\nmine Int (.2 : Float)', 'lossy conversion'],
    ['mine t (x : source) = x : t\nmine Int (.2 : Complex)', 'lossy conversion'],
    ['types <- import "std/type"\ntypes.cast Int (.2 : Float)', 'lossy conversion'],
    ['std <- import "std"; use std.type\ncast Int (.2 : Float)', 'lossy conversion'],
    ['cast String [1]', 'list of Char'],
    ['cast String ["h"]', 'list of Char'],
    ["(['h',missing] : String)", 'unbound variable'],
    ['((.2 : Float) : Int)', 'lossy conversion'],
    ['f (x : Int) = x\nf (.2 : Float)', 'no clause'],
    ['func (x : Int) = print Int\nfunc .2', 'no clause'],
    ['((x : Int) -> x) .2', 'no clause'],
    ['Count (x : Int) = _\nf (Count x) = x\nf .2', 'no clause'],
    ['(128 : Int8)', 'out of range'],
    ['cast Int8 (128 : Int)', 'out of range'],
    ['cast UInt (-1 : Int)', 'negative integer'],
    ['cast Int (1+2i : Complex)', 'real number'],
    ['cast Int "hi"', 'expects a number'],
    ['cast (x -> x) 1', 'no clause'],
] as const) Deno.test(`APN cast rejects: ${source}`, () => {
    try { result(source); } catch (e) {
        if (e instanceof Error && e.message.includes(error)) return;
        throw e;
    }
    throw new Error(`Expected ${error}`);
});
Deno.test("cast is the APN prelude definition, not a native", () => {
    const i = new Interpreter();
    if (NATIVES.some(([name]) => name === 'cast')) throw new Error('cast is still native');
    if (i.env.get('cast')?.kind !== 'clauseFn') throw new Error('cast is not a pattern function');
    const source = i.renderString(i.run(parseDocument('cast')));
    if (source !== '(target : List _), value -> (target : Type).(value)\n(target : Type), value -> (value : target)') throw new Error(source);
});
