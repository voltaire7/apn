import { Interpreter } from "../src/interp.ts";
import { parseDocument, setLooseSpacing } from "../src/parser.ts";
import { checkSource } from "../src/type-checker.ts";
for (const [source, expected] of [
    ['obj = [x: 3, y: 4]; obj.(x + y)', '7'],
    ['x = 100; outside = 10; obj = [x: 3]; obj.(x + outside)', '13'],
    ['obj = [x: 3, y: 4]; obj.([x,y])', '[3,4]'],
    ['obj = [x: 3]; result <- return obj.(x = 10; x); [result,obj.x]', '[10,3]'],
    ['obj = [x: 3]; f = obj.(y -> x + y); f 4', '7'],
    ['obj = [x: 3]; values = obj.([x]); values', '[3]'],
    ['obj = [x: 3]; obj.()', '[]'],
    ['obj = [x: 3]; obj.(sqrt (x ^ 2))', '3'],
    ['values = [1,2]; [Int,Float].(values)', '[1,2.0]'],
    ['obj = [(x): 9, x: 3]; [obj "(x)", obj.(x)]', '[9,3]'],
    ['obj = [child: [x: 1]]; result <- return obj.(child.x = 10; child.x); [result,obj.child.x]', '[10,1]'],
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
    const result = checkSource('obj = [x: 3, y: 4]; obj.(x + y)');
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
    ['[Int,Float].{ [1,2] }', '[1,2.0]'],
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
        ['f { x::xs } = x; f [1,2]', '1'],
        ['{ { Int x } -> x + 1 } 2', '3'],
        ['f { { Int -> Int } g } = g 2; f { + 1 }', '3'],
        ['obj = [x: 1]; obj.({ x + 1 })', '2'],
    ]) {
        const i = new Interpreter();
        const actual = i.renderString(i.run(parseDocument(source)));
        if (actual !== expected) throw new Error(`${source}: ${actual}`);
    }
});
Deno.test('one-line brackets: exactly one space inside braces, none inside ( ) and [ ]', () => {
    for (const source of ['{123}', '{ 123}', '{123 }', '{ 123  }', '{  123 }', '{ }', '{  }', '{\t123 }', 'print {4 * 3}', '{+ 2} 3', 'f {Int x} = x + 1',
            '( 123 )', '( 123)', '(123 )', '( )', '[ 1 ]', '[1,2 ]', '[ ]']) {
        try { parseDocument(source); } catch (error) {
            if ((error as { kind?: string }).kind === 'parse') continue;
            throw error;
        }
        throw new Error(`accepted: ${source}`);
    }
    for (const source of ['{ 123 }', '{}', '()', '[]', '(123)', '[1,2]', 'f x = {\n    x\n}', 'f x = {  # note\n    x\n}', 'xs = [\n    1\n]', 's = "{x}"', 'print { 1 }  # c', 'obj = [x: 1]; obj.{ x + 1 }']) parseDocument(source);
});
Deno.test('spacing at =, commas and record colons', () => {
    for (const source of ['x=1', 'x =1', 'x= 1', 'x  = 1', 'x =  1', '[1, 2]', '[1 ,2]', '[1 , 2]', '[1,  2]', '[x: 1,y: 2]', '[x: 1 , y: 2]', '[x: 1,  y: 2]',
            '[1 + 1,2]', '[[1, 2],[3]]', '1 +2', '1+ 2', 'x = 5; x- 1', 'f $x', '2^ .5', '[1,2, 3]', '["a", "b c"]', 'x, y -> x', '(Int x),y -> x', 'v = [x: 1, y: 2]; v.[x, y]',
            '[x:1]', '[x : 1]', '[x:  1]', 'f [x:a] = a', 'v = [x: 1]; v.[x:a] = [a: 2]', 'print [ [1,2] ]',
            '[1,2,]', '[x: 1, y: 2,]', 'xs = [\n    1,\n    2,\n]', 'r = [\n    a: 1,  # note\n]', 'xs = [\n    1,\n    2\n]',
            'r = [\n    a: 1,\n    b: 2\n]', 'func x = x; func(123)', 'f x y = x; f(1) 2', 'f x = x; f{ 1 }', 'v = [x: 1]; print v{ x }',
            'V = [x: Int, y: Int]; v = V[1,2]', 'f xs = xs; (f [1])[0]', 'print "a"[1]', 'f x = x; f 1[2]']) {
        try { parseDocument(source); } catch (error) {
            if ((error as { kind?: string }).kind === 'parse') continue;
            throw error;
        }
        throw new Error(`accepted: ${source}`);
    }
    for (const source of ['x = 1', 'f x = x + 1', 'z =\n    5', '[1,2,3,4]', '[[1,2],[3]]', '[x: 1, y: 2]', '[x: [1,2], y: 3]', '[-1: 1, (x): 2]',
            'f [x: a, y: b] = a', 'f (x::xs) = x', 'xs = [\n    1\n    2\n]', 'r = [\n    a: 1\n    b: 2\n]', 'xs = [\n    1,2\n    3\n]',
            'func x = x; func (123)', 'f x = x; f { 1 }', 'obj = [x: 1]; obj.{ x + 1 }', 'v = [x: 1, y: 2]; v.[x,y]', 'v = [x: 1, y: 2]; v.[x: a, y: b]',
            'V = [x: Int, y: Int]; v = V [1,2]', 'x = 1::[2]', '[[1],[2]]', '[1 + 1, 2]', '[[1 + 1, 2], [3]]', '["a b","c"]', '[0,-1,1/2,v.x]',
            'x,y -> x', '(Int x), y -> x', '1+2', 'f x = x; f -1', '(1 +)', '(+ 1)', 'a = 1; a == -1', 'xs = [\n    1,2\n    3 + 1, 4\n]']) parseDocument(source);
});
Deno.test("a ';' separates two statements on one line", () => {
    for (const source of ['{\n    print 123;\n    print 321;\n}', '{\n    print 123;print 321;\n}', '{ print 1; }', '{ ; print 1 }', 'print 1;; print 2',
            'print 1 ; print 2', 'print 1;print 2', ';print 1', 'print 1;  # note', '(print 1;)']) {
        try { parseDocument(source); } catch (error) {
            if ((error as { kind?: string }).kind === 'parse') continue;
            throw error;
        }
        throw new Error(`accepted: ${source}`);
    }
    for (const source of ['print 1; print 2', '{ print 1; print 2 }', '{\n    print 123; print 321\n}', 'x = 1; y = 2  # note']) parseDocument(source);
});
Deno.test('loose spacing accepts any spacing', () => {
    setLooseSpacing(true);
    try {
        for (const source of ['x=1', '[ 1 ,2 ]', '[x:1, y : 2]', '{x}', '( 1 )', '{ }', 'func =\n    {\n        print "hello"\n    }', '{\n    print 1;\n}', 'print 1;print 2',
            '{ print 1;print 2 }', '{ print 1; }', 'print 1;; print 2', ';print 1', 'print 1 ; print 2', '[1,2,]', 'xs = [\n    1,\n    2,\n]', 'xs = [\n    1,\n    2\n]', 'func x = x; func(123)',
            'V = [x: Int, y: Int]; v = V[1,2]']) parseDocument(source);
    } finally { setLooseSpacing(false); }
    for (const source of ['x=1', 'func =\n    {\n        print "hello"\n    }', '{ print 1;print 2 }']) {
        try { parseDocument(source); } catch { continue; }
        throw new Error(`strict rules not restored: ${source}`);
    }
});
