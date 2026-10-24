import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
function result(source: string): string {
    const interpreter = new Interpreter();
    return interpreter.renderString(interpreter.run(parseDocument(source)));
}
for (const [source, expected] of [
    ['Option x = Some x | None\nf (Option _ x) = match x [Some y -> y, None -> 0]\n[f (Some 123), f None]', '[123,0]'],
    ['Option x = Some x | None\nf (Option _ x) = true\nf _ = false\n[f (Some missing), f None, f 123]', '[true,true,false]'],
    ['Option x = Some x | None\nOther x = | Else x\nf (Option _ x) = true\nf _ = false\nf (Else 1)', 'false'],
    ['Option x = Some x | None\nmatch (Some 3) [Option _ x -> x]', 'Some 3'],
    ['Option x = Some x | None\n[match None [Option _ x -> 1, _ -> 0], match 2 [Option _ x -> 1, _ -> 0]]', '[1,0]'],
    ['Option x = Some x | None\n[Option (Some 1), cast Option None, isType Option (Some missing), isType Option 1, typeOf (Some 1)]', '[Some 1, None, true, false, Option]'],
    ['Option x = Some x | None\nf (Some x) = x\nf (Some 123)', '123'],
    ['Box x = | Box x\nf (Box x) = x\nf (Box 123)', '123'],
    // A type applied to its parameters is a type; one more pattern, a value of it.
    ['Option x = Some x | None\nf (Option t) = t\nf (Option Int)', 'Int'],
    ['Option x = Some x | None\nf (Option t x) = [t,x]\nf (Some "a")', '[String, Some "a"]'],
    ['f (List t) = t\nf (List Int)', 'Int'],
    ['f (List _ xs) = xs\nf [1]', '[1]'],
] as const) {
    Deno.test(`declared variant types: ${source}`, () => {
        const actual = result(source);
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
}
Deno.test("parent type checks leave fields of partially-applied constructors lazy", () => {
    const actual = result('Pairish a b = | PairishValue a b\npartial = PairishValue missing\nf (Pairish _ _ x) = 42\nf (partial missing)');
    if (actual !== '42') throw new Error(actual);
});
Deno.test("parent type pattern resolves in the function's module scope", () => {
    const interpreter = new Interpreter();
    interpreter.moduleSources = { "/lib/option.apn": 'Option x = Some x | None\nf (Option _ x) = 42' };
    interpreter.sourceDir = "/app/";
    const actual = interpreter.renderString(interpreter.run(parseDocument('m = import "option"\nOption x = | Other x\nm.f (m.Some missing)')));
    if (actual !== '42') throw new Error(actual);
});
Deno.test("user's original pattern dispatch prints the payload", () => {
    const output: string[] = [];
    const log = console.log;
    console.log = (value) => output.push(String(value));
    try { result('Option x = Some x | None\nfunc (Option _ x) = match x [\n    Some x -> print x\n    None -> _\n]\nfunc (Some 123)'); }
    finally { console.log = log; }
    if (output.join() !== '123') throw new Error(JSON.stringify(output));
});

// A constructor sharing its type's name is the constructor, also in another
// type's field, where it describes no type: the error says to name it apart.
for (const checked of [false, true]) Deno.test(`a shared-name constructor in a field says to name it apart (checked=${checked})`, () => {
    const interpreter = new Interpreter();
    if (checked) interpreter.enableChecking();
    try {
        interpreter.renderString(interpreter.run(parseDocument('Box a = | Box a\nWrap a = | Wrap (Box a)\nWrap (Box 1)')));
    } catch (error) {
        const hint = (error as { hint?: string }).hint ?? "";
        if (hint.includes("`Box` here is the constructor") && hint.includes("Box a = | MkBox")) return;
        throw error;
    }
    throw new Error("accepted a constructor as a field's type");
});
Deno.test("a type named apart from its constructor describes a field", () => {
    const source = 'Box a = | MkBox a\nWrap a = | Wrap (Box a)\nWrap (MkBox 1)';
    if (result(source) !== "Wrap (MkBox 1)") throw new Error(result(source));
});
