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

// On a list or HashMap, v.x is get v "x" and v.x = y is with v "x" y, checked
// and run; a Record parameter takes any record, its fields read when it runs.
for (const [source, expected] of [
    ['a = [["x", 1]]\na.x = 5\na.y = 6\na', '[["x", 5], ["y", 6]]'],
    ['a = [["x", 1], ["y", 2]]\nb = [7,8]\na.[x,y] = b\na', '[["x", 7], ["y", 8]]'],
    ['[["x", 1], ["y", 2]].[y = x, x = y]', '[y = 1, x = 2]'],
    ['m = ([["x", 1], ["y", 9]] : HashMap _ _)\nm.y = 2\n[m.x,m.y]', '[1,2]'],
    ['m = ([["x", 1], ["y", 2]] : HashMap _ _)\nm.[y = x]', '[y = 1]'],
    ['m = ([[1,10]] : HashMap _ _)\nn = m\nm 1 = 11\nm 2 = 20\n[n,m]', '[[[1,10]],[[1,11],[2,20]]]'],
    ['m = ([x = 1, y = 2] : HashMap _ _)\nm.x + 1', '2'],
    ['f (xs : List Int) = 1\nf (r : Record) = 2\n[f [a = 1], f [1]]', '[2,1]'],
    ['f (r : Record) = r.a + 1\nf [a = 1]', '2'],
    ['f (r : Record) = r.[a,b]\nf [a = 1, b = 2]', '[1,2]'],
] as const) Deno.test(`keyed dot, checked: ${source}`, () => {
    const i = new Interpreter();
    i.enableChecking();
    const actual = i.renderString(i.run(parseDocument(source)));
    if (actual !== expected) throw new Error(actual);
});
