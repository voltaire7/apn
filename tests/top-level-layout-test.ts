import { parseDocument } from "../src/parser.ts";
import { lint } from "../src/lint.ts";

for (const source of [
    'func = {\n    print "hi"\n}\n    [1,2,3] $ print',
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
