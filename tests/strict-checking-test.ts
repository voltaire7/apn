import { requireChecked, checkSource } from "../src/type-checker.ts";
for (const source of ['import ["type","function","option","sequence","array","number","text","map","combinator","io","system","search"]', 'env', 'missing', 'load "file"']) {
    Deno.test(`checked execution rejects unknowns: ${source}`, () => {
        try { requireChecked(source); } catch (e) {
            if (String(e).includes('cannot establish static types')) return;
            throw e;
        }
        throw new Error('accepted dynamic boundary');
    });
}
Deno.test('gradual editor analysis remains available', () => {
    const result = checkSource('import ["type","function","option","sequence","array","number","text","map","combinator","io","system","search"]');
    if (result.issues.length || !result.dynamicBoundaries) throw new Error(JSON.stringify(result));
});
for (const source of ['id x = x; [id 1,id true]', 'loop x = loop x', 'self f = f f; self (x -> 123)', 'x = x']) {
    Deno.test(`checked recursion and inference: ${source}`, () => { requireChecked(source); });
}
Deno.test('inferred arguments are not silently converted without runtime wrappers', () => {
    const source = 'f x = x == 0 ? 1 : x * x; f 1.0';
    if (!checkSource(source, '<test>', {strict: true}).issues.length) throw new Error('inferred Int argument accepted Float');
});

for (const source of ['!missing', '-"hello"', '1 < "hello"']) {
    Deno.test(`strict operators reject invalid or unresolved operands: ${source}`, () => {
        if (!checkSource(source, '<test>', { strict: true }).issues.length) throw new Error('invalid operand escaped checking');
    });
}

for (const source of ['f x = x + 1; f 2', 'f x y = x < y; f 1 2']) {
    Deno.test(`operators infer deferred constraints: ${source}`, () => { requireChecked(source); });
}
for (const source of ['f x = x + 1; f "bad"', 'f x y = x < y; f 1 "bad"']) {
    Deno.test(`inferred operator constraints reject incompatible calls: ${source}`, () => {
        if (!checkSource(source, '<test>', { strict: true }).issues.length) throw new Error('invalid call escaped checking');
    });
}
