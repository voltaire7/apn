import { parseDocument } from "../src/parser.ts";
import { lint } from "../src/lint.ts";
for (const source of [
    'vec * (\n    print\n    )',
    'f (\n    x\n  )',
    'f (\n    + 1\n    )',
    'f (\n    )',
    'f = {\n    g (\n        x\n)\n}',
]) Deno.test(`reject misaligned closing parenthesis: ${source}`, () => {
    try { parseDocument(source); } catch (error) {
        if (String(error).includes('closing ) must align')) return;
        throw error;
    }
    throw new Error('accepted misaligned parenthesis');
});
for (const source of [
    '(\n    vec + 1\n) * print',
    'f (\n    x y)',
    'f (x +\n    y)',
    'f (\n    + 1\n)',
    'f = {\n    g (\n        x y\n    )\n}',
    'f (\n    g (\n        x y\n    )\n)',
]) Deno.test(`preserve aligned and inline parentheses: ${source}`, () => { parseDocument(source); });
Deno.test('misaligned parenthesis has an editor diagnostic at the closer', () => {
    const diagnostics = lint('vec * (\n    print\n    )');
    if (diagnostics.length !== 1 || diagnostics[0].range.start.line !== 2 || diagnostics[0].range.start.character !== 4) {
        throw new Error(JSON.stringify(diagnostics));
    }
});
