import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
function result(source: string): string {
    const interpreter = new Interpreter();
    return interpreter.renderString(interpreter.run(parseDocument(source)));
}
for (const [source, expected] of [
    ['Option x = Some x | None\nf (x : Option _) = x ~ [Some y -> y, None -> 0]\n[f (Some 123), f None]', '[123,0]'],
    ['Option x = Some x | None\nf (x : Option _) = True\nf _ = False\n[f (Some missing), f None, f 123]', '[True,True,False]'],
    ['Option x = Some x | None\nOther x = | Else x\nf (x : Option _) = True\nf _ = False\nf (Else 1)', 'False'],
    ['Option x = Some x | None\nSome 3 ~ [(x : Option _) -> x]', 'Some 3'],
    ['Option x = Some x | None\n[None ~ [(x : Option _) -> 1, _ -> 0], 2 ~ [(x : Option _) -> 1, _ -> 0]]', '[1,0]'],
    ['Option x = Some x | None\n[\n    (Some 1 : Option), cast Option None, isType Option (Some missing)\n    isType Option 1, typeOf (Some 1)\n]', '[Some 1, None, True, False, Option Int]'],
    ['Option x = Some x | None\nf (Some x) = x\nf (Some 123)', '123'],
    ['Box x = | Box x\nf (Box x) = x\nf (Box 123)', '123'],
    // A type applied to its parameters is a type; one more pattern, a value of it.
    ['Option x = Some x | None\nf (Option t) = t\nf (Option Int)', 'Int'],
    ['Option x = Some x | None\nf (x : Option t) = [t,x]\nf (Some "a")', '[String, Some "a"]'],
    ['f (List t) = t\nf (List Int)', 'Int'],
    ['f (xs : List _) = xs\nf [1]', '[1]'],
] as const) {
    Deno.test(`declared variant types: ${source}`, () => {
        const actual = result(source);
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
}
Deno.test("parent type checks leave fields of partially-applied constructors lazy", () => {
    const actual = result('Pairish a b = | PairishValue a b\npartial = PairishValue missing\nf (x : Pairish _ _) = 42\nf (partial missing)');
    if (actual !== '42') throw new Error(actual);
});
Deno.test("parent type pattern resolves in the function's module scope", () => {
    const interpreter = new Interpreter();
    interpreter.moduleSources = { "/lib/option.apn": 'Option x = Some x | None\nf (x : Option _) = 42' };
    interpreter.sourceDir = "/app/";
    const actual = interpreter.renderString(interpreter.run(parseDocument('m <- import "std/option"\nOption x = | Other x\nm.f (m.Some missing)')));
    if (actual !== '42') throw new Error(actual);
});
Deno.test("user's original pattern dispatch prints the payload", () => {
    const output: string[] = [];
    const log = console.log;
    console.log = (value) => output.push(String(value));
    try { result('Option x = Some x | None\nfunc (x : Option _) = x ~ [\n    Some x -> print x\n    None -> _\n]\nfunc (Some 123)'); }
    finally { console.log = log; }
    if (output.join() !== '123') throw new Error(JSON.stringify(output));
});

// A constructor sharing its type's name, applied to types where a type is
// expected (another type's field), is that type applied to them.
for (const checked of [false, true]) Deno.test(`a shared-name constructor applied to types is the type (checked=${checked})`, () => {
    const interpreter = new Interpreter();
    if (checked) interpreter.enableChecking();
    const shown = interpreter.renderString(interpreter.run(parseDocument('Box a = | Box a\nWrap a = | Wrap (Box a)\nWrap (Box 1)')));
    if (shown !== "Wrap (Box 1)") throw new Error(shown);
});
Deno.test("a type named apart from its constructor describes a field", () => {
    const source = 'Box a = | MkBox a\nWrap a = | Wrap (Box a)\nWrap (MkBox 1)';
    if (result(source) !== "Wrap (MkBox 1)") throw new Error(result(source));
});
