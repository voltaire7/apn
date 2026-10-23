import { checkSource, requireChecked } from "../src/type-checker.ts";
import { Interpreter } from "../src/interp.ts";
import { parseDocument, patternSource } from "../src/parser.ts";

const append = `append (Vect n a []) (Vect m a ys) = Vect (n + m) a ys
append (Vect n a (x::xs)) (Vect m a ys) = Vect (n + m) a (x :: append xs ys)`;
function run(source: string): string {
    const interpreter = new Interpreter();
    return interpreter.renderString(interpreter.run(parseDocument(source)));
}
for (const [source, expected] of [
    ['inspect (Vect n a xs) = [n,a,xs]; inspect [1,2]', '[2,Int,[1,2]]'],
    ['inspect (Vect n a xs) = [n,a,xs]; inspect (Vect 2 Float [1,2])', '[2,Float,[1.0,2.0]]'],
    ['inspect (Vect n a xs) = [n,a,xs]; inspect (Vect 0 Int [])', '[0,Int,[]]'],
    ['inspect (Vect n a xs) = [n,a,xs]; inspect []', '[0,a,[]]'],
    ['inspect (Vect n a xs) (Vect m a ys) = [n,m,a]; inspect [] [1,2]', '[0,2,Int]'],
    ['inspect (Vect n a xs) (Vect m a ys) = [n,m,a]; inspect [true] []', '[1,0,Bool]'],
    ['f (Vect n Int xs) = xs; f [1,2]', '[1,2]'],
    ['f (Vect 2 a xs) = xs; f [true,false]', '[true,false]'],
    [append + '\nappend [1,2] [3,4]', '[1,2,3,4]'],
    [append + '\nappend [] [3,4]', '[3,4]'],
    [append + '\nappend [1,2] []', '[1,2]'],
    [append + '\nappend [] []', '[]'],
    [append + '\ntypeOf (append [1,2] [3,4])', 'Vect 4 Int'],
    ['f (Vect n a xs) (Vect m a ys) = a; f (Vect 0 Int []) []', 'Int'],
    ['VectAlias = Vect; f (VectAlias n a xs) = n; f [1,2]', '2'],
    ['f (Vect n a xs) = n; f _ = 123; f [1,2]', '2'],
    // A length keeps a name bound to a value; a function's name binds there.
    ['size = 2; f (Vect size a xs) = 1; f _ = 0; [f [1], f [1,2]]', '[0,1]'],
    ['o (Vect k a xs) = k; k x = x; o [1,2,3]', '3'],
] as const) Deno.test(`Vect pattern runtime: ${source}`, () => {
    const actual = run(source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'f (Vect n a xs) = xs; f [1,true]',
    'f (Vect n Int xs) = xs; f [true]',
    'f (Vect n a xs) (Vect m a ys) = xs; f [1] [true]',
    'f (Vect n a xs) (Vect n a ys) = xs; f [1] [2,3]',
    'f (Vect 2 a xs) = xs; f [1]',
    'f (Vect n a xs) = xs; f 1',
]) Deno.test(`Vect pattern rejects mismatch: ${source}`, () => {
    try { run(source); } catch (error) {
        if (String(error).includes('no clause')) return;
        throw error;
    }
    throw new Error('expected pattern mismatch');
});
for (const source of [
    append + '\nappend [1,2] [3,4]',
    append + '\nappend [] []',
    'f (Vect n a xs) = Vect n a xs; f [1,2]',
    'f (Vect n a xs) (Vect n a ys) = xs; f [1] [2]',
    'f x x = x; f 1 1',
    'o (Vect k a xs) = k; k x = x; o [1,2,3]',
    'o ((Vect k Int) xs) = k; k x = x; o [1,2,3]',
]) Deno.test(`Vect and equality patterns check statically: ${source}`, () => {
    const result = requireChecked(source);
    if (result.dynamicBoundaries) throw new Error(JSON.stringify(result));
});
for (const source of [
    'bad (Vect n a xs) = Vect (n + 1) a xs',
    'bad (Vect n a []) (Vect m a ys) = Vect (n + m + 1) a ys',
    'bad (Vect n a (x::xs)) = Vect n a xs',
    'f (Vect n a xs) (Vect m a ys) = xs; f [1] [true]',
    'f (Vect n a xs) (Vect n a ys) = xs; f [1] [2,3]',
    // A call checked before the clause's statement reads it the same way.
    'size = 2; h x = f x; f (Vect size Int xs) = xs; h [1,2,3]',
    'f x x = x; f 1 true',
    '(x, x -> x) 1 true',
]) Deno.test(`Vect and equality patterns have static contradictions: ${source}`, () => {
    if (!checkSource(source, '<test>', { strict: true }).issues.length) throw new Error('expected static error');
});
// The checker reads (Vect n a xs) without rewriting it: a checked run takes
// the vector apart as an unchecked one does, a mismatch failing the match.
Deno.test('a checked Vect pattern mismatch fails the match', () => {
    const i = new Interpreter();
    i.enableChecking();
    try { i.run(parseDocument('f (Vect 2 Int xs) = xs\nf (Dynamic [1,2,3])')); } catch (error) {
        if (String(error).includes('no clause')) return;
        throw error;
    }
    throw new Error('expected pattern mismatch');
});
Deno.test('checking leaves a flat typed pattern as written', () => {
    const i = new Interpreter();
    i.enableChecking();
    const shown = i.renderString(i.run(parseDocument('f (Vect n a xs) = n\nf')));
    if (shown !== 'Vect n a xs -> n') throw new Error(shown);
});
Deno.test('Vect patterns retain annotated element laziness', () => {
    const source = 'size (Vect n a xs) = n; size (Vect 1 Int [missing])';
    if (run(source) !== '1') throw new Error('forced an element');
});
Deno.test('Vect pattern source round-trips', () => {
    const program = parseDocument('f (Vect n Int (x::xs)) = n');
    const first = program[0];
    if (first.t !== 'def') throw new Error('expected definition');
    const printed = patternSource(first.clauses[0].params[0]);
    if (run(`f ${printed} = n; f [1,2]`) !== '2') throw new Error(printed);
});

Deno.test('a fixed Vect pattern rejects an infinite list without consuming it', () => {
    if (run('f (Vect 2 a xs) = 1; f _ = 0; f [1..]') !== '0') throw new Error('wrong clause');
    if (run('f n (Vect n a xs) = 1; f _ _ = 0; f 2 [1..]') !== '0') throw new Error('wrong repeated-index clause');
});
