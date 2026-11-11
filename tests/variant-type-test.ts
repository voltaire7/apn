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
// A constructor named as its type is the type where a type is expected:
// after a declaration's or an ascription's ':', checked and run alike.
for (const [source, expected] of [
    ['Point = | Point Int Int\nr : Point = Point 1 2\nr', 'Point 1 2'],
    ['Point = | Point Int Int\nx : Point\nx = Point 1 2\nx', 'Point 1 2'],
    ['Box a = | Box a\nq : Box Int = Box 4\n[q, typeOf q]', '[Box 4, Box Int]'],
    ['Point = | Point Int Int\nps : List Point = [Point 1 2]\nps', '[Point 1 2]'],
] as const) for (const checked of [true, false]) Deno.test(`a constructor names its type (checked=${checked}): ${source}`, () => {
    const interpreter = new Interpreter();
    if (checked) interpreter.enableChecking();
    const actual = interpreter.renderString(interpreter.run(parseDocument(source)));
    if (actual !== expected) throw new Error(actual);
});
// Bare, X = A | B declares constructors; the union of existing types is the
// expression in parentheses, checked as the union it is.
for (const checked of [true, false]) Deno.test(`a union of types is written in parentheses (checked=${checked})`, () => {
    const run = (source: string) => {
        const interpreter = new Interpreter();
        if (checked) interpreter.enableChecking();
        return interpreter.renderString(interpreter.run(parseDocument(source)));
    };
    if (run('IS = (Int | String)\nf (x : IS) = x\n[f 1, f "a", Int <= IS]') !== '[1,"a",True]') throw new Error("union");
    if (run('g (x : Int | String) = x\ng 2') !== '2') throw new Error("written in place");
    try { run('IS = Int | String\n1'); } catch (error) {
        if (String(error).includes("their union is written in parentheses")) return;
        throw error;
    }
    throw new Error("a bare union of types was accepted");
});
