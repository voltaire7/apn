import { checkSource } from "../src/type-checker.ts";
import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

for (
    const source of [
        'id x = x; [id 1, id "hi"]',
        "f (Int x) = x; f 1",
        'f x = x.x; f [x: 1, y: "extra"]',
        "Option a = Some a | None; f (Some x) = x; f None = 0; f (Some 1)",
        "Vector 3 Int [1,2,3]",
        "V n = Vector (n + 0) Int; V 3 [1,2,3]",
        "f n ((Vector n Int) xs) = xs; f 3 [1,2,3]",
        "f n ((Vector (n + 1) Int) xs) = xs; f 2 [1,2,3]",
        "f n ((Vector n Int) xs) ((Vector n Int) ys) = xs; f 2 [1,2] [3,4]",
        "f n ((Vector n Int) xs) ((Vector 1 Int) ys) = Vector (n + 1) Int (xs ++ ys)",
        "f (Dynamic x) = x x; f (y -> y)",
        "Vector3 = [x: Float, y: Float, z: Float]; vec = Vector3 [1,2,3]",
    ]
) {
    Deno.test(`gradual check accepts: ${source}`, () => {
        const result = checkSource(source);
        if (result.issues.length) throw new Error(JSON.stringify(result.issues));
    });
}
for (
    const [source, message] of [
        ['f (Int x) = x; f "bad"', "cannot use String"],
        ['f 0 = 1; f 1 = "bad"', "cannot use String"],
        ['x = 1; x = "bad"', "cannot use String"],
        ["f x = x.x; f [y: 2]", "missing field"],
        ["Vector 3 Int [1,2]", "length mismatch"],
        ["Vector 2 Int [1,2,3]", "length mismatch"],
        ["Vector (-1) Int []", "nonnegative"],
        ["Vector 2 123 [1,2]", "element must be a type"],
        ["f n ((Vector n Int) xs) = xs; f 3 [1,2]", "length mismatch"],
        ["f n ((Vector (n + 1) Int) xs) = xs; f 2 [1,2]", "length mismatch"],
        ["f n ((Vector n Int) xs) ((Vector n Int) ys) = xs; f 2 [1,2] [3]", "length mismatch"],
        ["Int .2", "lossy"],
        ["f x = x x", "Dynamic boundary"],
    ]
) {
    Deno.test(`gradual check rejects: ${source}`, () => {
        const result = checkSource(source);
        if (!result.issues.some((x) => x.message.includes(message))) throw new Error(JSON.stringify(result));
    });
}
for (
    const [source, expected] of [
        ["Vector 3 Int [1,2,3]", "[1, 2, 3]"],
        ["V n = Vector (n + 1) Int; V 2 [1,2,3]", "[1, 2, 3]"],
        ["f n ((Vector n Int) xs) = xs; f 3 [1,2,3]", "[1, 2, 3]"],
        ["typeOf (Vector 3 Int [1,2,3])", "Vector 3 Int"],
        ["v = Vector 2 Int [1,2]; v 0 = 3; [v, typeOf v]", "[[3, 2], Vector 2 Int]"],
        ["[isType (Vector 2 Int) [1,2], isType (Vector 2 Int) [1]]", "[true, false]"],
        ["[(Vector 2 Int) == (Vector 2 Int), (Vector 2 Int) == (Vector 3 Int)]", "[true, false]"],
        ['f (Dynamic x) = x; f "hi"', '"hi"'],
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
        "Vector 2 Int [1]",
        "Vector 2 Int [1..]",
        "f n ((Vector n Int) xs) = xs; f 2 [1]",
        "v = Vector 1 Int [1]; v 0 = .2",
    ]
) {
    Deno.test(`dependent runtime rejects: ${source}`, () => {
        const i = new Interpreter();
        try {
            i.renderString(i.run(parseDocument(source)));
        } catch (error) {
            if (String(error).includes("length mismatch") || String(error).includes("lossy")) return;
            throw error;
        }
        throw new Error("expected error");
    });
}

for (
    const source of [
        "add (Int x) (Int y) = x + y; add (Float x) (Float y) = x + y; [add 1 2, add .1 .2]",
        'x = 1; { x = "local"; x }; x',
        "f (Int32 x) = x; f 1",
        "f t n ((Vector n t) xs) = xs; f Int 2 [1,2]",
        "f (Type t) x = t x; f Int 1",
        "Option a = Some a | None; Option Int (Some 1)",
        'Choice flag = flag ? Int : String; [Choice true 1, Choice false "hello"]',
    ]
) {
    Deno.test(`gradual APN compatibility: ${source}`, () => {
        const result = checkSource(source);
        if (result.issues.length) throw new Error(JSON.stringify(result));
    });
}
for (
    const source of [
        'Vector 2 Int [1,"bad"]',
        'f n ((Vector n Int) xs) = xs; f 2 [1,"bad"]',
        'Choice flag = flag ? Int : String; Choice true "bad"',
    ]
) {
    Deno.test(`dependent elements reject: ${source}`, () => {
        if (!checkSource(source).issues.length) throw new Error("expected static error");
    });
}
Deno.test("type computations remain non-evaluating in checker", () => {
    const source = 'Choice flag = { print "must not run"; flag ? Int : String }; Choice true 1';
    const result = checkSource(source);
    if (result.issues.length) throw new Error(JSON.stringify(result));
});
Deno.test("captured variables are not spuriously generalized", () => {
    const result = checkSource('f x = { g y = x; g 1 }; Int (f "bad")');
    if (!result.issues.length) throw new Error("capture relationship was lost");
});
Deno.test("runtime value-dependent type selection", () => {
    const i = new Interpreter();
    const source = 'Choice flag = flag ? Int : String; [Choice true 1, Choice false "hello"]';
    if (i.renderString(i.run(parseDocument(source))) !== '[1, "hello"]') throw new Error("wrong selected type");
});
for (
    const source of [
        'v = [x: Float] []; v.x = "bad"',
        'v = Vector 2 Int [1,2]; i = 0; v i = "bad"',
        "v = [x: 1]; v.x = .2",
        "v = [1,2]; v 2 = 3",
    ]
) {
    Deno.test(`checked assignment rejects: ${source}`, () => {
        if (!checkSource(source).issues.length) throw new Error("expected assignment error");
    });
}
for (
    const source of [
        "v = [x: Float] []; v.x = 1",
        "v = [x: Float]; v.x = 123",
        "v = Vector 2 Int [1,2]; i = 0; v i = 3",
    ]
) {
    Deno.test(`checked assignment accepts: ${source}`, () => {
        const result = checkSource(source);
        if (result.issues.length) throw new Error(JSON.stringify(result));
    });
}
Deno.test("vector checking follows lossless element conversion", () => {
    if (checkSource("Vector 2 Float [1,2]").issues.length) throw new Error("lossless conversion rejected");
    if (!checkSource("Vector 2 Int [1,.2]").issues.length) throw new Error("lossy conversion accepted");
});
Deno.test("first-class builtin constructors remain checkable", () => {
    const source =
        "a = List [1,2]; b = Record [x: 1]; c = Function (x -> x); v = Vector 2 (Type Int) [1,2]; m = Mutable 1";
    const result = checkSource(source);
    if (result.issues.length) throw new Error(JSON.stringify(result));
});
Deno.test("known primitive arithmetic errors are static", () => {
    if (!checkSource('1 + "bad"').issues.length) throw new Error("known error escaped checking");
    if (checkSource('"a" + "b"').issues.length) throw new Error("string addition was rejected");
});
Deno.test("affine indices substitute multiple arguments", () => {
    const definition = "f n m ((Vector (n + m) Int) xs) = xs; ";
    if (checkSource(definition + "f 1 2 [1,2,3]").issues.length) throw new Error("valid sum rejected");
    if (!checkSource(definition + "f 1 2 [1,2]").issues.length) throw new Error("invalid sum accepted");
    if (checkSource("Vector 0 Int [1,3..0]").issues.length) throw new Error("empty range miscounted");
});
Deno.test("constant index predicates select a dependent type", () => {
    const definition = "Choice n = n == 0 ? Int : String; ";
    if (checkSource(definition + "Choice 0 123").issues.length) throw new Error("selection rejected");
    if (!checkSource(definition + 'Choice 0 "bad"').issues.length) throw new Error("selection ignored");
});
Deno.test("rebound indices keep lazy aliases dynamic", () => {
    const source = "size = 2; V = Vector size Int; size = 3; V [1,2,3]";
    const result = checkSource(source);
    if (result.issues.length || !result.dynamicBoundaries) throw new Error(JSON.stringify(result));
    const i = new Interpreter();
    if (i.renderString(i.run(parseDocument(source))) !== "[1, 2, 3]") throw new Error("lazy alias changed");
});
