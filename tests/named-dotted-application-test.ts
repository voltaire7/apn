// A dot reads a record's (or code's) fields; on another list, v.x is get v "x",
// association lookup: its items are its positions, and zipWith ($) applies a
// list of functions to values.
import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
import { checkSource } from "../src/type-checker.ts";

for (const [source, expected] of [
    ['values = missing; obj = [values = 42]; obj.values', '42'],
    ['obj = [unbound = 42]; obj.unbound', '42'],
    ['obj = [child = [x = 42]]; obj.child.x', '42'],
    ['[x = 1, y = 2].[y,x]', '[2,1]'],
    ['code = [a = 1, b = a + 1]; code.b', '2'],
    ['zipWith ($) [(* 2), (+ 1)] [1,2]', '[2,3]'],
    ['[["x", 1], ["y", 3], ["x", 2]].x', '2'],
    ['[["x", 1], ["y", 2]].[y,x]', '[2,1]'],
    ['to Record [["k", 4], ["j", 5], ["k", 6]]', '[k = 6, j = 5]'],
    ['(to Record [["x", 1]]).(x + 1)', '2'],
] as const) Deno.test(`dot: ${source}`, () => {
    const i = new Interpreter();
    const actual = i.renderString(i.run(parseDocument(source)));
    if (actual !== expected) throw new Error(actual);
});

for (const source of [
    'templates = [(* 2), (+ 1)]; values = [1,2]; templates.values',
    '[(* 2)].[3]',
    '["old"].["new"]',
    'templates = [Int]; templates.missing',
]) {
    Deno.test(`a dot on a list is rejected when it runs: ${source}`, () => {
        const i = new Interpreter();
        try { i.renderString(i.run(parseDocument(source))); } catch (error) {
            if (/a list has no field|association lookup expects/.test(String(error))) return;
            throw error;
        }
        throw new Error("accepted");
    });
    Deno.test(`a dot on a list is rejected by the check: ${source}`, () => {
        const issues = checkSource(source).issues.map(i => i.message).join("; ");
        if (!issues.includes("a list has no field")) throw new Error(issues || "accepted");
    });
}

Deno.test("a list's names are known only at runtime: xs.(e) is rejected", () => {
    const issues = checkSource('xs = [["x", 1]]; xs.(x + 1)').issues.map(i => i.message).join("; ");
    if (!issues.includes("scoped evaluation requires a record")) throw new Error(issues || "accepted");
});
