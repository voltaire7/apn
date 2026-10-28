import { Interpreter, NATIVES } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

function result(source: string): string {
    const i = new Interpreter();
    return i.renderString(i.run(parseDocument(source)));
}
for (const [source, expected] of [
    ['import "text"\ncast String $ to (List Char) "hello"', '"hello"'],
    ['cast String $ cast [Char,Char,Char] $ "a😀é"', '"a😀é"'],
    ['cast String []', '""'],
    ["String ['h','i']", '"hi"'],
    ['String "hi"', '"hi"'],
    ["Text := String\nText ['h','i']", 'Text "hi"'],
    ["xs = 'a'::xs\nString (take 3 xs)", '"aaa"'],
    ['Int (Float 2)', '2'],
    ['payload (t x) = [t,x]\npayload (Int32 5)', '[Int32,5]'],
    ['payload (Float x) = x\npayload (Float .2)', '0.2'],
    ['payload (Number x) = x\npayload (Int32 5)', '5'],
    ['payload (Int x) = x\npayload 2.0', '2'],
    ['f (Int x) = 1\nf x = 2\nf .2', '2'],
    ['f (Float32 x) = 1\nf x = 2\nf .1', '2'],
    ['f (Float x) = 1\nf x = 2\nf 9007199254740993', '2'],
    ['match .2 [(Int x) -> 1, _ -> 2]', '2'],
    ['payload (Int x) = x\npayload (Float 2)', '2'],
    ['[.2 == Float .2, Int 1 == Float 1, Int32 1 == 1]', '[true,true,true]'],
    ['cast Bool true', 'true'],
    ['take 1 (cast List [1,missing])', '[1]'],
    ['((Int -> Int) identity) <- return (x -> x); cast (typeOf identity) (x -> x + 1) 2', '3'],
    ['Float .2 + .3', '0.5'],
    ['Int 1 + .2', '1.2'],
] as const) Deno.test(`APN cast: ${source}`, () => {
    const actual = result(source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const [source, error] of [
    ['Int .2', 'lossy conversion'],
    ['Int -.2', 'lossy conversion'],
    ['Int -1.7', 'lossy conversion'],
    ['Int (1/3)', 'lossy conversion'],
    ['Int (.1 + .1)', 'lossy conversion'],
    ['cast Int (Float .2)', 'lossy conversion'],
    ['cast Int $ Float .2', 'lossy conversion'],
    ['cast Int (Fraction (1/3))', 'lossy conversion'],
    ['cast Int (Complex .2)', 'lossy conversion'],
    ['x = Float .2\ny = cast Int x\n[y,x]', 'lossy conversion'],
    ['mine t x = match x [(source value) -> t value]\nmine Int (Float .2)', 'lossy conversion'],
    ['mine t (source x) = t x\nmine Int (Complex .2)', 'lossy conversion'],
    ['types = import "type"\ntypes.cast Int (Float .2)', 'lossy conversion'],
    ['import "type"\ncast Int (Float .2)', 'lossy conversion'],
    ['cast String [1]', 'list of Char'],
    ['cast String ["h"]', 'list of Char'],
    ["String ['h',missing]", 'unbound variable'],
    ['Int (Float .2)', 'lossy conversion'],
    ['f (Int x) = x\nf (Float .2)', 'no clause'],
    ['func (Int x) = print Int\nfunc .2', 'no clause'],
    ['((Int x) -> x) .2', 'no clause'],
    ['Count := Int\nf (Count x) = x\nf .2', 'no clause'],
    ['Int8 128', 'out of range'],
    ['cast Int8 (Int 128)', 'out of range'],
    ['cast UInt (Int -1)', 'negative integer'],
    ['cast Int (Complex (1+2i))', 'real number'],
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
    if (source !== '(List _ target), value -> (Type target).(value)\n(Type target), value -> target value') throw new Error(source);
});
