import { parseDocument, setLooseSpacing } from "../src/parser.ts";
import { Interpreter } from "../src/interp.ts";
import type { APNError } from "../src/errors.ts";
import { lint } from "../src/lint.ts";

for (const source of [
    'func = {\n    print "hi"\n}\n    print $ [1, 2, 3]',
    'func = { print "hi" }\n    print "outside"',
    'x = 1\n    y = 2',
    '    x = 1',
    'x = [\n    1\n]\n    print x',
    'f = { 1 }\n# comment\n\n    print 2',
]) Deno.test(`reject stray top-level indentation: ${source}`, () => {
    try { parseDocument(source); }
    catch (error) {
        if (error instanceof Error && error.message.includes('top-level statements must not be indented')) return;
        throw error;
    }
    throw new Error('accepted unexpected indentation');
});
for (const source of [
    'x =\n    1\nprint x',
    'f = {\n    x = 1\n    x\n}\nprint f',
    'xs = [\n    1\n    2\n]\nprint xs',
    'Choice =\n    | Yes\n    | No\nprint Yes',
]) Deno.test(`preserve nested layout: ${source}`, () => { parseDocument(source); });
Deno.test('editor flags the stray indented statement', () => {
    const diagnostics = lint('f = {\n    1\n}\n    print 2');
    if (diagnostics.length !== 1 || diagnostics[0].range.start.line !== 3) throw new Error(JSON.stringify(diagnostics));
});

// Lines are at most 99 characters (code points), comments included; --loose lifts it.
Deno.test("a line over 99 characters is a parse error", () => {
    parseDocument(`x = "${"a".repeat(93)}"`);
    parseDocument(`x = "${"😀".repeat(93)}"`);
    try { parseDocument(`x = 1\n# ${"a".repeat(98)}`); throw new Error("accepted a 100-character line"); }
    catch (error) {
        const e = error as APNError;
        if (!e.message.includes("line is 100 characters long; the limit is 99") || e.pos !== 6 + 99) throw error;
    }
    setLooseSpacing(true);
    try { parseDocument(`x = "${"a".repeat(200)}"`); } finally { setLooseSpacing(false); }
});
// A deeper line starting an argument continues an application: at the top
// level, in a block, in a list item and in a record field.
for (const [source, expected] of [
    ['f a b c = a + b + c\nf 1\n    2\n    3', '6'],
    ['f a b c = a + b + c\n{\n    x = f 1\n        2 3\n    x\n}', '6'],
    ['f a b = a * b\n[\n    f 2\n        3\n    4\n]', '[6, 4]'],
    ['f a b = a * b\n[\n    x: f 2\n        3\n    y: 4\n]', '[x: 6, y: 4]'],
    ['xs = map (n -> n + 1)\n    [1, 2]\nxs', '[2, 3]'],
]) Deno.test(`a deeper line continues an application: ${source}`, () => {
    const interpreter = new Interpreter();
    const actual = interpreter.renderString(interpreter.run(parseDocument(source)));
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
