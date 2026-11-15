import { checkSource } from "../src/type-checker.ts";
import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

for (
    const source of [
        'id x = x; [id 1, id "hi"]',
        "f (x : Int) = x; f 1",
        // Clauses may give different types: a call gives the clause's that runs.
        'f 0 = 1; f 1 = "one"; f 0 + 1',
        'f x = x.x; f [x = 1, y = "extra"]',
        "Option a = Some a | None; f (Some x) = x; f None = 0; f (Some 1)",
        "([1,2,3] : Vect 3 Int)",
        "V n = Vect (n + 0) Int; ([1,2,3] : V 3)",
        "f n (xs : Vect n Int) = xs; f 3 [1,2,3]",
        "f n (xs : Vect (n + 1) Int) = xs; f 2 [1,2,3]",
        "f n (xs : Vect n Int) (ys : Vect n Int) = xs; f 2 [1,2] [3,4]",
        "f n (xs : Vect n Int) (ys : Vect 1 Int) = xs ++ ys : Vect (n + 1) Int",
        "f (x : Dynamic) = x x; f (y -> y)",
        "Vector3 = [x : Float, y : Float, z : Float]; vec = [1,2,3] : Vector3",
    ]
) {
    Deno.test(`gradual check accepts: ${source}`, () => {
        const result = checkSource(source);
        if (result.issues.length) throw new Error(JSON.stringify(result.issues));
    });
}
for (
    const [source, message] of [
        ['f (x : Int) = x; f "bad"', "cannot use String"],
        ['f 0 = 1; f 1 = "bad"; f 1 + 1', "cannot combine String and Int"],
        ["f x = x.x; f [y = 2]", "missing field"],
        ["([1,2] : Vect 3 Int)", "length mismatch"],
        ["([1,2,3] : Vect 2 Int)", "length mismatch"],
        ["([] : Vect -1 Int)", "nonnegative"],
        ["([1,2] : Vect 2 123)", "element must be a type"],
        ["f n (xs : Vect n Int) = xs; f 3 [1,2]", "length mismatch"],
        ["f n (xs : Vect (n + 1) Int) = xs; f 2 [1,2]", "length mismatch"],
        ["f n (xs : Vect n Int) (ys : Vect n Int) = xs; f 2 [1,2] [3]", "length mismatch"],
        ["(.2 : Int)", "lossy"],
    ]
) {
    Deno.test(`gradual check rejects: ${source}`, () => {
        const result = checkSource(source);
        if (!result.issues.some((x) => x.message.includes(message))) throw new Error(JSON.stringify(result));
    });
}
for (
    const [source, expected] of [
        ["([1,2,3] : Vect 3 Int)", "[1,2,3]"],
        ["V n = Vect (n + 1) Int; ([1,2,3] : V 2)", "[1,2,3]"],
        ["f n (xs : Vect n Int) = xs; f 3 [1,2,3]", "[1,2,3]"],
        ["typeOf ([1,2,3] : Vect 3 Int)", "Vect 3 Int"],
        ["v = [1,2] : Vect 2 Int; v 0 = 3; [v, typeOf v]", "[[3,2], Vect 2 Int]"],
        ["[isType (Vect 2 Int) [1,2], isType (Vect 2 Int) [1]]", "[True,False]"],
        ["[Vect 2 Int == Vect 2 Int, Vect 2 Int == Vect 3 Int]", "[True,False]"],
        ['f (x : Dynamic) = x; f "hi"', '"hi"'],
    ]
) {
    Deno.test(`dependent runtime: ${source}`, () => {
        const i = new Interpreter();
        const actual = i.renderString(i.run(parseDocument(source)));
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
}
for (
    const source of [
        "([1] : Vect 2 Int)",
        "([1..] : Vect 2 Int)",
        "f n (xs : Vect n Int) = xs; f 2 [1]",
        "v = [1] : Vect 1 Int; v 0 = .2",
    ]
) {
    Deno.test(`dependent runtime rejects: ${source}`, () => {
        const i = new Interpreter();
        try {
            i.renderString(i.run(parseDocument(source)));
        } catch (error) {
            // A typed Vect parameter rejects by not matching.
            if (["length mismatch", "lossy", "no clause"].some(m => String(error).includes(m))) return;
            throw error;
        }
        throw new Error("expected error");
    });
}

for (
    const source of [
        "add (x : Int) (y : Int) = x + y; add (x : Float) (y : Float) = x + y; [add 1 2, add .1 .2]",
        'x = 1; [{ x = "local"; x }, x]',
        "f (x : Int32) = x; f 1",
        "f t n (xs : Vect n t) = xs; f Int 2 [1,2]",
        "f (t : Type) x = x : t; f Int 1",
        "Option a = Some a | None; (Some 1 : Option Int)",
        'Choice flag = flag ? Int : String; [(1 : Choice True), ("hello" : Choice False)]',
    ]
) {
    Deno.test(`gradual APN compatibility: ${source}`, () => {
        const result = checkSource(source);
        if (result.issues.length) throw new Error(JSON.stringify(result));
    });
}
for (
    const source of [
        '([1, "bad"] : Vect 2 Int)',
        'f n (xs : Vect n Int) = xs; f 2 [1, "bad"]',
        'Choice flag = flag ? Int : String; ("bad" : Choice True)',
    ]
) {
    Deno.test(`dependent elements reject: ${source}`, () => {
        if (!checkSource(source).issues.length) throw new Error("expected static error");
    });
}
Deno.test("type computations remain non-evaluating in checker", () => {
    const source = 'Choice flag = { debug "must not run"; flag ? Int : String }; (1 : Choice True)';
    const result = checkSource(source);
    if (result.issues.length) throw new Error(JSON.stringify(result));
});
Deno.test("captured variables are not spuriously generalized", () => {
    const result = checkSource('f x = { g y = x; g 1 }; (f "bad" : Int)');
    if (!result.issues.length) throw new Error("capture relationship was lost");
});
Deno.test("runtime value-dependent type selection", () => {
    const i = new Interpreter();
    const source = 'Choice flag = flag ? Int : String; [(1 : Choice True), ("hello" : Choice False)]';
    if (i.renderString(i.run(parseDocument(source))) !== '[1, "hello"]') throw new Error("wrong selected type");
});
for (
    const source of [
        'v = [] : [x : Float]; v.x = "bad"',
        'v = [1,2] : Vect 2 Int; i = 0; v i = "bad"',
        "v = [x = 1]; v.x = .2",
        "v = [1,2]; v 2 = 3",
    ]
) {
    Deno.test(`checked assignment rejects: ${source}`, () => {
        if (!checkSource(source).issues.length) throw new Error("expected assignment error");
    });
}
for (
    const source of [
        "v = [] : [x : Float]; v.x = 1",
        "v = [x : Float]; v.x = 123",
        "v = [1,2] : Vect 2 Int; i = 0; v i = 3",
    ]
) {
    Deno.test(`checked assignment accepts: ${source}`, () => {
        const result = checkSource(source);
        if (result.issues.length) throw new Error(JSON.stringify(result));
    });
}
Deno.test("vector checking follows lossless element conversion", () => {
    if (checkSource("([1,2] : Vect 2 Float)").issues.length) throw new Error("lossless conversion rejected");
    if (!checkSource("([1,.2] : Vect 2 Int)").issues.length) throw new Error("lossy conversion accepted");
});
Deno.test("first-class builtin constructors remain checkable", () => {
    const source =
        "a = [1,2] : List _\nb = [x = 1] : Record\nc = x -> x : Function\nv = [1,2] : Vect 2 (Int : Type)\nm = Mutable 1";
    const result = checkSource(source);
    if (result.issues.length) throw new Error(JSON.stringify(result));
});
Deno.test("known primitive arithmetic errors are static", () => {
    if (!checkSource('1 + "bad"').issues.length) throw new Error("known error escaped checking");
    if (checkSource('"a" + "b"').issues.length) throw new Error("string addition was rejected");
});
Deno.test("affine indices substitute multiple arguments", () => {
    const definition = "f n m (xs : Vect (n + m) Int) = xs; ";
    if (checkSource(definition + "f 1 2 [1,2,3]").issues.length) throw new Error("valid sum rejected");
    if (!checkSource(definition + "f 1 2 [1,2]").issues.length) throw new Error("invalid sum accepted");
    if (checkSource("([1,3..0] : Vect 0 Int)").issues.length) throw new Error("empty range miscounted");
});
Deno.test("constant index predicates select a dependent type", () => {
    const definition = "Choice n = n == 0 ? Int : String; ";
    if (checkSource(definition + "(123 : Choice 0)").issues.length) throw new Error("selection rejected");
    if (!checkSource(definition + '("bad" : Choice 0)').issues.length) throw new Error("selection ignored");
});
Deno.test("rebound indices keep lazy aliases dynamic", () => {
    // V keeps the size it was written with.
    const source = "size = 2; V = Vect size Int; size = 3; ([1,2] : V)";
    const result = checkSource(source);
    if (result.issues.length) throw new Error(JSON.stringify(result));
    const i = new Interpreter();
    if (i.renderString(i.run(parseDocument(source))) !== "[1,2]") throw new Error("lazy alias changed");
});

Deno.test('gradual checking accepts list selection and atomic swaps', () => {
    const checked = checkSource('arr = [1,2,3]; arr [1,2] = arr [2,1]; arr [2,0]');
    if (checked.issues.length) throw new Error(JSON.stringify(checked.issues));
});
Deno.test('gradual checking rejects a known multi-index bounds error', () => {
    const checked = checkSource('arr = [1,2]; arr [0,2] = [3,4]');
    if (!checked.issues.some(x => x.message.includes('out of range'))) throw new Error(JSON.stringify(checked));
});
