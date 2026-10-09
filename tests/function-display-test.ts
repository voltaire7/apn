import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

for (const [code, expected] of [
    ['func x = print x; func', 'x -> print x'],
    ['x -> print x', 'x -> print x'],
    ['f x = print (x + 1); f', 'x -> print (x + 1)'],
    ['f x = x * (x + 1); f', 'x -> x * (x + 1)'],
    ['f 0 = 1; f x = x; f', 'f 0 = 1\nf x = x'],
    ['f x y = x + y; f missing', '(x y -> x + y) missing'],
    ['f x = match x [0 -> "zero",n -> "nonzero"]; f', 'x -> match x [0 -> "zero",n -> "nonzero"]'],
    ['print', 'print'],
    ['(+)', '(+)'],
    ['addOp = (+); addOp 1', '(1 +)'],
    ['(+ 1)', '(+ 1)'],
    ['g = x y z -> x * y * z; g 2 (1 + 1)', '(x y z -> x * y * z) 2 (1 + 1)'],
]) Deno.test(`function display: ${code}`, () => {
    const i = new Interpreter();
    const result = i.renderString(i.run(parse(code)));
    if (result !== expected) throw new Error(`Expected ${expected}, got ${result}`);
});
Deno.test("displaying function body and captured argument has no effects", () => {
    const i = new Interpreter();
    i.run(parse('x = Mutable 0; f a b = set x 9; partial = f (set x 4)'));
    i.renderString(i.run(parse('partial')));
    if (i.renderString(i.run(parse('x'))) !== '0') throw new Error('display ran effects');
});
