import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

for (const [code, expected] of [
    ['func x = print x; func', 'x -> print x'],
    ['x -> print x', 'x -> print x'],
    ['f x = print (x + 1); f', 'x -> print (x + 1)'],
    ['f x = x * (x + 1); f', 'x -> x * (x + 1)'],
    ['f 0 = 1; f x = x; f', '0 -> 1\nx -> x'],
    ['g (x : Int) y = 1; g (x : Float) y = 2; g 1', 'y -> 1'],
    ['f (x : Int) = 1; f (x : Float) = 2; f', '(x : Int) -> 1\n(x : Float) -> 2'],
    ['h (x : Int) = x; h', '(x : Int) -> x'],
    ['f x y = x + y; f missing', 'y -> missing + y'],
    ['f x = x ~ [0 -> "zero", n -> "nonzero"]; f', 'x -> x ~ [0 -> "zero", n -> "nonzero"]'],
    ['print', 'print'],
    ['(+)', '(+)'],
    ['addOp = (+); addOp 1', '(1 +)'],
    ['(+ 1)', '(+ 1)'],
    ['g = x, y, z -> x * y * z; g 2 (1 + 1)', 'z -> 2 * (1 + 1) * z'],
    ['h (x : Int) y = x + y; h x 0 = x; h 1', 'y -> 1 + y\n0 -> 1'],
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
