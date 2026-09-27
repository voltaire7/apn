import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
function result(source: string): string {
    const interpreter = new Interpreter();
    return interpreter.renderString(interpreter.run(parseDocument(source)));
}
for (const [source, expected] of [
    ['Maybe x = Just x | Nothing\nf (Maybe x) = match x [Just y -> y, Nothing -> 0]\n[f (Just 123), f Nothing]', '[123, 0]'],
    ['Maybe x = Just x | Nothing\nf (Maybe x) = true\nf _ = false\n[f (Just missing), f Nothing, f 123]', '[true, true, false]'],
    ['Maybe x = Just x | Nothing\nOther x = | Else x\nf (Maybe x) = true\nf _ = false\nf (Else 1)', 'false'],
    ['Maybe x = Just x | Nothing\nmatch (Just 3) [Maybe x -> x]', 'Just 3'],
    ['Maybe x = Just x | Nothing\n[match Nothing [Maybe x -> 1, _ -> 0], match 2 [Maybe x -> 1, _ -> 0]]', '[1, 0]'],
    ['Maybe x = Just x | Nothing\n[Maybe (Just 1), cast Maybe Nothing, isType Maybe (Just missing), isType Maybe 1, typeOf (Just 1)]', '[Just 1, Nothing, true, false, Maybe]'],
    ['Maybe x = Just x | Nothing\nf (Just x) = x\nf (Just 123)', '123'],
    ['Box x = | Box x\nf (Box x) = x\nf (Box 123)', '123'],
] as const) {
    Deno.test(`declared variant types: ${source}`, () => {
        const actual = result(source);
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
}
Deno.test("parent type checks leave fields of partially-applied constructors lazy", () => {
    const actual = result('Pairish a b = | PairishValue a b\npartial = PairishValue missing\nf (Pairish x) = 42\nf (partial missing)');
    if (actual !== '42') throw new Error(actual);
});
Deno.test("parent type pattern resolves in the function's module scope", () => {
    const interpreter = new Interpreter();
    interpreter.moduleSources = { option: 'Maybe x = Just x | Nothing\nf (Maybe x) = 42' };
    const actual = interpreter.renderString(interpreter.run(parseDocument('m = import "std/option"\nMaybe x = | Other x\nm.f (m.Just missing)')));
    if (actual !== '42') throw new Error(actual);
});
Deno.test("user's original pattern dispatch prints the payload", () => {
    const output: string[] = [];
    const log = console.log;
    console.log = (value) => output.push(String(value));
    try { result('Maybe x = Just x | Nothing\nfunc (Maybe x) = match x [\n    Just x -> print x\n    Nothing -> _\n]\nfunc (Just 123)'); }
    finally { console.log = log; }
    if (output.join() !== '123') throw new Error(JSON.stringify(output));
});
