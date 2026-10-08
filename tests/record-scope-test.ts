import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
import { checkSource } from "../src/type-checker.ts";
for (const [source, expected] of [
    ['obj = [x: 3,y: 4]; obj.(x + y)', '7'],
    ['x = 100; outside = 10; obj = [x: 3]; obj.(x + outside)', '13'],
    ['obj = [x: 3,y: 4]; obj.([x,y])', '[3, 4]'],
    ['obj = [x: 3]; result <- obj.(x = 10; x); [result,obj.x]', '[10, 3]'],
    ['obj = [x: 3]; f = obj.(y -> x + y); f 4', '7'],
    ['obj = [x: 3]; values = obj.([x]); values', '[3]'],
    ['obj = [x: 3]; obj.()', '[]'],
    ['obj = [x: 3]; obj.(sqrt (x ^ 2))', '3'],
    ['values = [1,2]; [Int,Float].(values)', '[1, 2.0]'],
    ['obj = [(x): 9,x: 3]; [obj "(x)",obj.(x)]', '[9, 3]'],
    ['obj = [child: [x: 1]]; result <- obj.(child.x = 10; child.x); [result,obj.child.x]', '[10, 1]'],
    ['obj = [x: 3]; obj.(inner = [x: 4]; inner.(x) + x)', '7'],
] as const) Deno.test(`record scope: ${source}`, () => {
    const i = new Interpreter();
    const actual = i.renderString(i.run(parseDocument(source)));
    if (actual !== expected) throw new Error(actual);
});
Deno.test('record scope restores the caller after failure', () => {
    const i = new Interpreter(); i.run(parseDocument('x = 99; obj = [x: 3]'));
    try { i.run(parseDocument('obj.(fail "oops")')); } catch { /* expected */ }
    if (i.renderString(i.run(parseDocument('x'))) !== '99') throw new Error('scope leaked');
});
Deno.test('scoped expressions are not field assignment targets', () => {
    for (const source of ['obj.(x) = 1', 'obj.(x).y = 1', 'obj.child.(x) = 1']) {
        const i = new Interpreter();
        i.run(parseDocument('obj = [x: 0, child: [x: 0]]'));
        try { i.run(parseDocument(source)); } catch { continue; }
        throw new Error(source);
    }
});
Deno.test('static checker resolves record scope fields', () => {
    const result = checkSource('obj = [x: 3,y: 4]; obj.(x + y)');
    if (result.issues.length) throw new Error(JSON.stringify(result.issues));
});

Deno.test('multiline record scope uses normal brace layout', () => {
    const i = new Interpreter();
    const source = `vec = [x: 1, y: 2, z: 3]
vec.{
    result = x + y
    result * result
}`;
    if (i.renderString(i.run(parseDocument(source))) !== '9') throw new Error('wrong result');
    if (i.renderString(i.run(parseDocument('vec'))) !== '[x: 1, y: 2, z: 3]') throw new Error('record changed');
    if (checkSource(source).issues.length) throw new Error('checker rejected scope');
});
for (const [source, expected] of [
    ['vec = [x: 1]; vec.{ x = 10; x }; vec.x', '1'],
    ['vec = [x: 1]; vec.{}', '[]'],
    ['vec = [x: 1]; f = vec.{ y -> x + y }; f 2', '3'],
    ['[Int, Float].{ [1, 2] }', '[1, 2.0]'],
    ['vec = [x: 1]; vec.{ [y: x + 1] }.y', '2'],
] as const) Deno.test(`braced scope: ${source}`, () => {
    const i = new Interpreter();
    if (i.renderString(i.run(parseDocument(source))) !== expected) throw new Error(source);
});
Deno.test('braced scope function source round-trips', () => {
    const i = new Interpreter();
    const fn = i.renderString(i.run(parseDocument('f vec = vec.{ result = x + y; result * result }; f')));
    if (i.renderString(i.run(parseDocument(`(${fn}) [x: 1, y: 2]`))) !== '9') throw new Error(fn);
});
Deno.test('braced scope enforces indentation', () => {
    for (const source of ['vec.{\n    x\nx\n}', 'vec.{\n    x\n    }']) {
        try { parseDocument(source); } catch { continue; }
        throw new Error('invalid layout accepted');
    }
});

Deno.test('braces and parentheses share grouped expression and pattern behavior', () => {
    for (const [source, expected] of [
        ['{ + 2 } 3', '5'], ['{ 2 + } 3', '5'], ['{ + } 2 3', '5'],
        ['f { Int x } = x + 1; f 2', '3'],
        ['f { x:xs } = x; f [1,2]', '1'],
        ['{ { Int x } -> x + 1 } 2', '3'],
        ['f { { Int -> Int } g } = g 2; f { + 1 }', '3'],
        ['obj = [x: 1]; obj.({ x + 1 })', '2'],
    ]) {
        const i = new Interpreter();
        const actual = i.renderString(i.run(parseDocument(source)));
        if (actual !== expected) throw new Error(`${source}: ${actual}`);
    }
});
Deno.test('a one-line brace block keeps exactly one space inside each brace', () => {
    for (const source of ['{123}', '{ 123}', '{123 }', '{ 123  }', '{  123 }', '{  }', '{\t123 }', 'print {4 * 3}', '{+ 2} 3', 'f {Int x} = x + 1']) {
        try { parseDocument(source); } catch (error) {
            if ((error as { kind?: string }).kind === 'parse') continue;
            throw error;
        }
        throw new Error(`accepted: ${source}`);
    }
    for (const source of ['{ 123 }', '{}', '{ }', 'f x = {\n    x\n}', 'f x = {  # note\n    x\n}', 's = "{x}"', 'print { 1 }  # c', 'obj = [x: 1]; obj.{ x + 1 }']) parseDocument(source);
});
