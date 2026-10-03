import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";
function run(source: string): string {
    const i = new Interpreter();
    return i.renderString(i.run(parseDocument(source)));
}
for (const source of [
    'f x x = x; f 1 1',
    '(x x -> x) 1 1',
    'f [x,x] = x; f [1,1]',
    'f [a:x,b:x] = x; f [a:1,b:1]',
    'f x [x] = x; f 1 [x:1]',
    '(x -> x -> x) 2 1',
    'x = 2; f x x = x; f 1 1',
    'f _ _ = 1; f 2 3',
    '(_ _ -> 1) 2 3',
]) Deno.test(`repeated patterns accept: ${source}`, () => {
    if (run(source) !== '1') throw new Error(source);
});
for (const source of [
    'f x x = x; f 1 2',
    '(x x -> x) 1 2',
    'f [x,x] = x; f [1,2]',
    'f [a:x,b:x] = x; f [a:1,b:2]',
    'f x [x] = x; f 1 [x:2]',
]) Deno.test(`repeated patterns reject: ${source}`, () => {
    try { run(source); } catch (e) {
        if (String(e).includes('no clause')) return;
        throw e;
    }
    throw new Error('expected mismatch');
});
