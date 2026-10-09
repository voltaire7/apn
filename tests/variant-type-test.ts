import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
function result(source: string): string {
    const interpreter = new Interpreter();
    return interpreter.renderString(interpreter.run(parseDocument(source)));
}
for (const [source, expected] of [
    ['Option x = Some x | None\nf (Option x) = match x [Some y -> y,None -> 0]\n[f (Some 123),f None]', '[123,0]'],
    ['Option x = Some x | None\nf (Option x) = true\nf _ = false\n[f (Some missing),f None,f 123]', '[true,true,false]'],
    ['Option x = Some x | None\nOther x = | Else x\nf (Option x) = true\nf _ = false\nf (Else 1)', 'false'],
    ['Option x = Some x | None\nmatch (Some 3) [Option x -> x]', 'Some 3'],
    ['Option x = Some x | None\n[match None [Option x -> 1,_ -> 0],match 2 [Option x -> 1,_ -> 0]]', '[1,0]'],
    ['Option x = Some x | None\n[Option (Some 1),cast Option None,isType Option (Some missing),isType Option 1,typeOf (Some 1)]', '[Some 1,None,true,false,Option]'],
    ['Option x = Some x | None\nf (Some x) = x\nf (Some 123)', '123'],
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
    interpreter.moduleSources = { "/lib/option.apn": 'Option x = Some x | None\nf (Option x) = 42' };
    interpreter.sourceDir = "/app/";
    const actual = interpreter.renderString(interpreter.run(parseDocument('m = import "option"\nOption x = | Other x\nm.f (m.Some missing)')));
    if (actual !== '42') throw new Error(actual);
});
Deno.test("user's original pattern dispatch prints the payload", () => {
    const output: string[] = [];
    const log = console.log;
    console.log = (value) => output.push(String(value));
    try { result('Option x = Some x | None\nfunc (Option x) = match x [\n    Some x -> print x\n    None -> _\n]\nfunc (Some 123)'); }
    finally { console.log = log; }
    if (output.join() !== '123') throw new Error(JSON.stringify(output));
});
