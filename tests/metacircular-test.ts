import { Interpreter } from "../src/interp.ts";
import { parse } from "../main.ts";

const sourcePrograms = [
    "2 ^ 3 ^ 2", "-2 ^ 2", "2 ^ -3",
    '[c -> c] "a😀é"', '[c -> 42] "hi"', '[(c -> c), (c -> c)] "hi"',
    '0 123', '[x -> x * 2] [1,2,3]', '[(x -> x + 1), (x -> x * 2)] [3,4]',
    '42', '1 + 2 * 3', '(1 + 2) * 3', '-12 + 5', '1 / 3 + 1 / 6',
    'true ? 42 : missing', 'false ? missing : 7', '!false', '[]',
    '"hello" ++ " world"', '[1,2 + 3,7]', 'head [42,missing]',
    'id x = x; id 42', 'constant x y = x; constant 42 missing',
    '(x -> x + 1) 41', 'compose f g x = f (g x); compose (x -> x * 2) (x -> x + 1) 20',
    'fact n = n == 0 ? 1 : n * fact (n - 1); fact 5',
    'x = 1:x; take 6 x',
    'mapLocal f xs = null xs ? [] : (f (head xs)) : mapLocal f (tail xs); mapLocal (x -> x * 2) [1,2,3]',
    'outer x = { inner y = x + y; inner }; outer 40 2',
    'x = 7; f ignored = x; { x = 99; f 0 }',
    'even n = n == 0 ? true : odd (n - 1); odd n = n == 0 ? false : even (n - 1); even 4',
    '(x -> x + 40) $ 2',
    '(x -> x + 1) $ (x -> x * 2) $ 3',
    '# comment\nx = 41\nx + 1',
];
for (const source of sourcePrograms) Deno.test(`metacircular agrees with host: ${source}`, () => {
    const host = new Interpreter();
    const expected = host.renderString(host.run(parse(source)));
    const meta = new Interpreter();
    meta.run(parse('import "std/meta"'));
    meta.env.setLocal("source", { kind: "string", v: source });
    const actual = meta.renderString(meta.run(parse('metaEval source')));
    if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
});
for (const source of ['foo =', '1 +', '[1,2', '"unterminated', '1.2', '1; 2', 'missing', 'head []']) {
    Deno.test(`metacircular rejects: ${source}`, () => {
        const i = new Interpreter(); i.run(parse('import "std/meta"'));
        i.env.setLocal("source", { kind: "string", v: source });
        try { i.renderString(i.run(parse('metaEval source'))); }
        catch { return; }
        throw new Error("Expected a syntax/runtime error");
    });
}
for (const source of ['20 + 22', 'id x = x; id 42', 'true ? 42 : missing', 'head ([x -> x * 2] [21])', 'head ([c -> 42] "hi")']) {
    Deno.test(`evaluator evaluates its own source, then: ${source}`, () => {
        const i = new Interpreter(); i.run(parse('import "std/meta"'));
        i.env.setLocal("evaluatorSource", { kind: "string", v: Deno.readTextFileSync(new URL("../lib/meta/evaluator.apn", import.meta.url)) });
        i.env.setLocal("source", { kind: "string", v: source });
        const actual = i.renderString(i.run(parse('metaSelfEval evaluatorSource source')));
        if (actual !== "42") throw new Error(actual);
    });
}
Deno.test("object environment exposes no host parser or evaluator", () => {
    const i = new Interpreter(); i.run(parse('import "std/meta"'));
    for (const name of ["parse", "eval", "toAST", "load", "metaEval", "meEval"]) {
        i.env.setLocal("name", { kind: "string", v: name });
        if (i.renderString(i.run(parse('has name metaPrimitives'))) !== "false") throw new Error(`Leaked ${name}`);
    }
});
Deno.test("record access demands action chains without forcing unrelated fields", () => {
    const i = new Interpreter();
    const actual = i.renderString(i.run(parse('make x = [answer: x, unused: [missing]]; a = make 42; b = a; b.answer')));
    if (actual !== "42") throw new Error(actual);
});
Deno.test("nested module loads restore the caller's source directory", () => {
    const i = new Interpreter(); i.sourceDir = "/unrelated/caller";
    i.run(parse('import "std/meta"'));
    if (i.sourceDir !== "/unrelated/caller") throw new Error("module changed caller directory");
});
Deno.test("evaluation depth remains bounded with a language error", () => {
    const i = new Interpreter();
    try { i.renderString(i.run(parse('loop x = 1 + loop x; loop 0'))); }
    catch (error) {
        if (error instanceof Error && error.message === "call stack overflow") return;
        throw error;
    }
    throw new Error("expected the APN recursion guard");
});
