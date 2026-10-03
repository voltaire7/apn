import { requireChecked, checkSource } from "../src/type-checker.ts";
for (const source of ['import "std"', 'env', 'missing', 'load "file"', 'f x = x + 1', 'f (Dynamic x) = x x']) {
    Deno.test(`checked execution rejects unknowns: ${source}`, () => {
        try { requireChecked(source); } catch (e) {
            if (String(e).includes('cannot establish static types')) return;
            throw e;
        }
        throw new Error('accepted dynamic boundary');
    });
}
Deno.test('gradual editor analysis remains available', () => {
    const result = checkSource('import "std"');
    if (result.issues.length || !result.dynamicBoundaries) throw new Error(JSON.stringify(result));
});
for (const source of ['id x = x; [id 1, id true]', 'loop x = loop x', 'self f = f f; self (x -> 123)', 'x = x']) {
    Deno.test(`checked recursion and inference: ${source}`, () => { requireChecked(source); });
}
Deno.test('inferred arguments are not silently converted without runtime wrappers', () => {
    const source = 'f x = x == 0 ? 1 : x * x; f 1.0';
    if (!checkSource(source, '<test>', {strict: true}).issues.length) throw new Error('inferred Int argument accepted Float');
});

for (const source of ['!missing', '-"hello"', '1 < "hello"', 'f x y = x < y']) {
    Deno.test(`strict operators reject invalid or unresolved operands: ${source}`, () => {
        if (!checkSource(source, '<test>', { strict: true }).issues.length) throw new Error('invalid operand escaped checking');
    });
}
