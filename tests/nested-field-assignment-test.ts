import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
import { checkSource } from "../src/type-checker.ts";

for (const [source, expected] of [
    ['obj = [child: [x: 1, y: 2], z: 3]; obj.child.x = 10; obj', '[child: [x: 10, y: 2], z: 3]'],
    ['obj = [a: [b: [x: 1]]]; obj.a.b.x = 10; obj.a.b.x', '10'],
    ['obj = [child: [x: 1]]; old <- return (obj); obj.child.x = 10; old.child.x', '1'],
    ['obj = [child: [x: 1]]; { obj.child.x = 10 }; obj.child.x', '1'],
    ['obj = [child: [x: Float 1]]; obj.child.x = 10; obj.child.x', '10.0'],
    ['obj = [child: [x: 1]]; obj.child.y = 2; obj.child', '[x: 1, y: 2]'],
    ['obj = [child: []]; obj.child.x = 10; obj.child.x', '10'],
    ['obj = [child: [x: 1, y: 2]]; obj.child.[x,y] = obj.child.[y,x]; obj.child', '[x: 2, y: 1]'],
    ['obj = [child: [x: 1]]; obj.child.[x] = [10]; obj.child.x', '10'],
    ['obj = ["child": [(x): 1]]; obj."child".[(x)] = [10]; obj."child" "(x)"', '10'],
    ['obj = [child: [x: 1]]; scope <- env; scope.obj.child.x = 10; obj.child.x', '10'],
    ['calls = Mutable 0; make = { set calls (calls + 1); return [child: [x: 1]] }; obj <- make; obj.child.x = 10; [obj.child.x,calls]', '[10,1]'],
] as const) Deno.test(`nested field update: ${source}`, () => {
    const i = new Interpreter();
    const actual = i.renderString(i.run(parseDocument(source)));
    if (actual !== expected) throw new Error(actual);
});
for (const assignment of ['obj.child.x = 1.5', 'obj.missing.x = 1', 'obj.child.x.y = 1', 'obj.child.[x] = 10']) {
    Deno.test(`nested failure preserves root: ${assignment}`, () => {
        const i = new Interpreter();
        i.run(parseDocument('obj = [child: [x: 1]]'));
        let failed = false;
        try { i.run(parseDocument(assignment)); } catch { failed = true; }
        if (!failed || i.renderString(i.run(parseDocument('obj'))) !== '[child: [x: 1]]') throw new Error('invalid update');
    });
}
Deno.test('checker follows nested assignment paths', () => {
    const good = checkSource('obj = [child: [x: 1], y: "ok"]; obj.child.x = 10; obj.y');
    if (good.issues.length) throw new Error(JSON.stringify(good.issues));
    for (const assignment of ['obj.child.x = "bad"', 'obj.missing.x = 1', 'obj.child.x.y = 1']) {
        if (!checkSource(`obj = [child: [x: 1]]; ${assignment}`).issues.length) throw new Error(assignment);
    }
});

Deno.test('printed nested update functions parse and preserve their behavior', () => {
    const i = new Interpreter();
    const fn = i.renderString(i.run(parseDocument('f obj = { obj.child.x = 10; obj }; f')));
    const result = i.renderString(i.run(parseDocument(`(${fn}) [child: [x: 1]]`)));
    if (result !== '[child: [x: 10]]') throw new Error(result);
});
