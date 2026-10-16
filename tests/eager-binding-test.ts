import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
import { symbols } from "../src/lsp.ts";

function execute(source: string): string[] {
    const output: string[] = [];
    const log = console.log;
    console.log = (...values) => output.push(values.map(String).join(" "));
    try { new Interpreter().run(parseDocument(source)); }
    finally { console.log = log; }
    return output;
}
function equal(a: unknown, b: unknown) {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}
for (const [name, source, expected] of [
    ['executes now, once', 'action = print "run"\nx <- action\nprint "bound"\nx\nx', ['run', 'bound']],
    ['applications execute now, once', 'x <- print "run"\nx\nx', ['run']],
    ['ordinary actions still repeat', 'a = print "a"\nb = { print "b" }\na\na\nb\nb', ['a', 'a', 'b', 'b']],
    ['destructuring stays lazy', '[x] = [print "run"]\nprint "bound"\nx\nx', ['bound', 'run', 'run']],
    ['unused destructuring stays unevaluated', '[x] = [missing]\nprint 42', ['42']],
    ['eager lists retain lazy elements', 'xs <- return [missing, 42]\nprint (xs 1)', ['42']],
    ['eager ranges remain productive', 'xs <- return [0..]\nprint (take 3 xs)', ['[0, 1, 2]']],
    ['destructured eager result retains lazy fields', '[x, y] <- return [missing, 42]\nprint y', ['42']],
    ['wildcard runs action', '_ <- print "run"', ['run']],
    ['scoped binding reads old value', 'x = 1\n{ x <- return (x + 1); print x }\nprint x', ['2', '1']],
    ['mutable capture preserves cell identity', 'm = Mutable 0\nset m $ 42\nprint m', ['42']],
    ['capture argument-taking function', 'f <- return (x -> x + 1)\nprint (f 2)', ['3']],
    ['function source preserves eager bindings', 'f x = { y <- print x; y }\nprint f', ['x -> { y <- print x; y }']],
    ['multiline eager body', 'x <-\n    return (1 + 2)\nprint x', ['3']],
] as const) {
    Deno.test(`eager binding: ${name}`, () => equal(execute(source), expected));
}
for (const source of ['x <-', 'x <-\n', 'x <- ;', '{ x <- }', 'f x <- 1', 'x <- y <- 1', 'x <-\n    { 1 }']) {
    Deno.test(`invalid eager binding: ${JSON.stringify(source)}`, () => {
        try { parseDocument(source); } catch { return; }
        throw new Error('Expected syntax error');
    });
}
Deno.test('failed eager binding preserves the previous binding', () => {
    const i = new Interpreter();
    i.run(parseDocument('x = 42'));
    try { i.run(parseDocument('x <- missing')); throw new Error('Expected error'); }
    catch (error) { if (!String(error).includes('unbound variable')) throw error; }
    equal(i.renderString(i.run(parseDocument('x'))), '42');
});
Deno.test('getArgs supports bare capture and existing unit calls', () => {
    const i = new Interpreter();
    i.programArgs = ['first', 'second'];
    equal(i.renderString(i.run(parseDocument('import "io"\nargs <- getArgs\nargs'))), '["first", "second"]');
    equal(i.renderString(i.run(parseDocument('getArgs []'))), '["first", "second"]');
    equal(i.renderString(i.run(parseDocument('[args] = [getArgs]\nargs'))), '["first", "second"]');
});
Deno.test('eager bindings appear in the editor outline', () => {
    equal(symbols('args <- getArgs').map((symbol) => symbol.name), ['args']);
});
