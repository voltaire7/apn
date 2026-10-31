import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

function check(source: string, expected: string) {
    const i = new Interpreter();
    const actual = i.renderString(i.run(parse(source)));
    if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
}
Deno.test("mutable update crosses block scope", () => check('x = Mutable 0; { set x $ x + 1 }; x', '1'));
Deno.test("mutable reads do not replace cell with cached contents", () => check('x = Mutable 0; a <- return (x + 0); set x $ x + 1; b <- return (x + 0); set x $ x + 1; x', '2'));
Deno.test("aliases and function parameters share mutable identity", () => check('x = Mutable 0; y = x; increment ref = set ref $ ref + 1; increment y; increment x; y', '2'));
Deno.test("argument-taking factories allocate distinct cells", () => check('make n = Mutable n; x = make 0; y = make 0; set x $ 9; y', '0'));
Deno.test("mutable supports nonnumeric contents", () => check('x = Mutable "old"; set x "new"; x', '"new"'));
Deno.test("mutable identity can be inspected", () => check('x = Mutable 0; [typeOf x, isType Mutable x]', '[Mutable,True]'));
Deno.test("failed set preserves old contents", () => {
    const i = new Interpreter();
    i.run(parse('x = Mutable 7'));
    try { i.run(parse('set x (1 / 0)')); } catch { }
    if (i.renderString(i.run(parse('x'))) !== '7') throw new Error('failed update changed cell');
    try { i.run(parse('set 1 0')); } catch (error) {
        if (error instanceof Error && error.message.includes('Mutable target')) return;
        throw error;
    }
    throw new Error('nonmutable target accepted');
});

Deno.test("mutable containers support application", () => check('x = Mutable [10,20]; x 1', '20'));
Deno.test("mutable parameter patterns preserve reference", () => check('x = Mutable 0; increment (Mutable ref) = set ref (ref + 1); increment x; x', '1'));

Deno.test("target-first set supports partial application and dollar", () => {
    check('x = Mutable 0; put = set x; put 1; set x $ x + 1; x', '2');
});
Deno.test("target-first set preserves the captured cell reference", () => {
    check('x = Mutable 0; put = set x; alias <- return x; put 7; alias', '7');
});
