import { checkSource, requireChecked } from "../src/type-checker.ts";
import { Interpreter } from "../src/interp.ts";
import { parseDocument, patternSource } from "../src/parser.ts";

const append = `append ([] : Vect n a) (ys : Vect m a) = ys : Vect (n + m) a
append (x::xs : Vect n a) (ys : Vect m a) = x :: append xs ys : Vect (n + m) a`;
function run(source: string): string {
    const interpreter = new Interpreter();
    return interpreter.renderString(interpreter.run(parseDocument(source)));
}
for (const [source, expected] of [
    ['inspect (xs : Vect n a) = [n,a,xs]; inspect [1,2]', '[2,Int,[1,2]]'],
    ['inspect (xs : Vect n a) = [n,a,xs]; inspect ([1,2] : Vect 2 Float)', '[2,Float,[1.0,2.0]]'],
    ['inspect (xs : Vect n a) = [n,a,xs]; inspect ([] : Vect 0 Int)', '[0,Int,[]]'],
    ['inspect (xs : Vect n a) = [n,a,xs]; inspect []', '[0,a,[]]'],
    ['inspect (xs : Vect n a) (ys : Vect m a) = [n,m,a]; inspect [] [1,2]', '[0,2,Int]'],
    ['inspect (xs : Vect n a) (ys : Vect m a) = [n,m,a]; inspect [True] []', '[1,0,Bool]'],
    ['f (xs : Vect n Int) = xs; f [1,2]', '[1,2]'],
    ['f (xs : Vect 2 a) = xs; f [True,False]', '[True,False]'],
    [append + '\nappend [1,2] [3,4]', '[1,2,3,4]'],
    [append + '\nappend [] [3,4]', '[3,4]'],
    [append + '\nappend [1,2] []', '[1,2]'],
    [append + '\nappend [] []', '[]'],
    [append + '\ntypeOf (append [1,2] [3,4])', 'Vect 4 Int'],
    ['f (xs : Vect n a) (ys : Vect m a) = a; f ([] : Vect 0 Int) []', 'Int'],
    ['VectAlias = Vect; f (VectAlias n a xs) = n; f [1,2]', '2'],
    ['f (xs : Vect n a) = n; f _ = 123; f [1,2]', '2'],
    // A length keeps a name bound to a value; a function's name binds there.
    ['size = 2; f (xs : Vect size a) = 1; f _ = 0; [f [1], f [1,2]]', '[0,1]'],
    ['o (xs : Vect k a) = k; k x = x; o [1,2,3]', '3'],
] as const) Deno.test(`Vect pattern runtime: ${source}`, () => {
    const actual = run(source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of [
    'f (xs : Vect n a) = xs; f [1,True]',
    'f (xs : Vect n Int) = xs; f [True]',
    'f (xs : Vect n a) (ys : Vect m a) = xs; f [1] [True]',
    'f (xs : Vect n a) (ys : Vect n a) = xs; f [1] [2,3]',
    'f (xs : Vect 2 a) = xs; f [1]',
    'f (xs : Vect n a) = xs; f 1',
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
    'f (xs : Vect n a) = xs : Vect n a; f [1,2]',
    'f (xs : Vect n a) (ys : Vect n a) = xs; f [1] [2]',
    'f x x = x; f 1 1',
    'o (xs : Vect k a) = k; k x = x; o [1,2,3]',
    'o (xs : Vect k Int) = k; k x = x; o [1,2,3]',
]) Deno.test(`Vect and equality patterns check statically: ${source}`, () => {
    const result = requireChecked(source);
    if (result.dynamicBoundaries) throw new Error(JSON.stringify(result));
});
for (const source of [
    'bad (xs : Vect n a) = xs : Vect (n + 1) a',
    'bad ([] : Vect n a) (ys : Vect m a) = ys : Vect (n + m + 1) a',
    'bad (x::xs : Vect n a) = xs : Vect n a',
    'f (xs : Vect n a) (ys : Vect m a) = xs; f [1] [True]',
    'f (xs : Vect n a) (ys : Vect n a) = xs; f [1] [2,3]',
    // A call checked before the clause's statement reads it the same way.
    'size = 2; h x = f x; f (xs : Vect size Int) = xs; h [1,2,3]',
    'f x x = x; f 1 True',
    '(x, x -> x) 1 True',
]) Deno.test(`Vect and equality patterns have static contradictions: ${source}`, () => {
    if (!checkSource(source, '<test>', { strict: true }).issues.length) throw new Error('expected static error');
});
// The checker reads (Vect n a xs) without rewriting it: a checked run takes
// the vector apart as an unchecked one does, a mismatch failing the match.
Deno.test('a checked Vect pattern mismatch fails the match', () => {
    const i = new Interpreter();
    i.enableChecking();
    try { i.run(parseDocument('f (xs : Vect 2 Int) = xs\nf ([1,2,3] : Dynamic)')); } catch (error) {
        if (String(error).includes('no clause')) return;
        throw error;
    }
    throw new Error('expected pattern mismatch');
});
Deno.test('checking leaves a flat typed pattern as written', () => {
    const i = new Interpreter();
    i.enableChecking();
    const shown = i.renderString(i.run(parseDocument('f (xs : Vect n a) = n\nf')));
    if (shown !== '(xs : Vect n a) -> n') throw new Error(shown);
});
Deno.test('Vect patterns retain annotated element laziness', () => {
    const source = 'size (xs : Vect n a) = n; size ([missing] : Vect 1 Int)';
    if (run(source) !== '1') throw new Error('forced an element');
});
Deno.test('Vect pattern source round-trips', () => {
    const program = parseDocument('f (x::xs : Vect n Int) = n');
    const first = program[0];
    if (first.t !== 'def') throw new Error('expected definition');
    const printed = patternSource(first.clauses[0].params[0]);
    if (run(`f ${printed} = n; f [1,2]`) !== '2') throw new Error(printed);
});

Deno.test('a fixed Vect pattern rejects an infinite list without consuming it', () => {
    if (run('f (xs : Vect 2 a) = 1; f _ = 0; f [1..]') !== '0') throw new Error('wrong clause');
    if (run('f n (xs : Vect n a) = 1; f _ _ = 0; f 2 [1..]') !== '0') throw new Error('wrong repeated-index clause');
});
// A typed pattern prints as it parses back; a type spelled with an operator
// stands alone for no name.
for (const source of ["(Int | String)", "(x : Int | String)", "(a -> a)", "(f : a -> a)", "(xs : [Int])", "(xs : Vect n a)", "(x : t)"]) {
    Deno.test(`typed pattern source round-trips: ${source}`, () => {
        const pattern = (parseDocument(`g ${source} = 1`)[0] as Extract<ReturnType<typeof parseDocument>[number], { t: "def" }>).clauses[0].params[0];
        if (patternSource(pattern) !== source) throw new Error(patternSource(pattern));
    });
}
// Its arguments known, a computed type's pattern tests a plain value against
// the type they compute.
Deno.test("a computed type's pattern with known arguments tests a plain value", () => {
    const source = "SizedInts n = Vect n Int\ncopy n (xs : SizedInts n) = xs\n";
    if (run(source + "copy 3 [1,2,3]") !== "[1,2,3]") throw new Error("a fitting list did not match");
    let rejected = false;
    try { run(source + "copy 2 [1,2,3]"); } catch (error) { rejected = String(error).includes("length mismatch"); }
    if (!rejected) throw new Error("a list of another length was accepted");
});
