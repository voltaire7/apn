import { checkSource, checkTypes } from "../src/type-checker.ts";
import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

for (
    const source of [
        "self f = f f",
        "self f = f f; self self",
        "self f = f f; self (x -> x)",
        "self f = f f; [self (x -> 123), self (x -> true)]",
        "omega = (x -> x x) (x -> x x)",
        "loop x = loop x",
        "forever x = forever; forever 1 2",
        "x = x",
        "xs = 1 : xs",
        "Y f = (x -> f (x x)) (x -> f (x x))",
    "Option a = Some a | None; self f = f f; a = self (x -> Some x); [a, self (x -> Some x)]",
    "self f = f f; a = self (x -> [x]); b = self (x -> [x]); a ++ b",
    "self f = f f; a = self (x -> [next: x]); b = self (x -> [next: x]); [a,b]",
    ]
) {
    Deno.test(`recursive inference terminates without Dynamic: ${source}`, () => {
        const result = checkSource(source);
        if (result.issues.length || result.dynamicBoundaries) {
            throw new Error(JSON.stringify(result));
        }
    });
}

for (
    const source of [
        "self f = f f; self 123",
        "self f = f f; Int (self (x -> true))",
        'self f = f f; self (x -> x); self "bad"',
        'self f = f f; [self (x -> 1), self (x -> true)]; Int (self (x -> "bad"))',
        'outer x = { self f = f f; self (ignored -> x) }; Int (outer "bad")',
        "loop (Int x) = loop x; loop true",
        'xs = 1 : xs; xs ++ ["bad"]',
    ]
) {
    Deno.test(`recursive inference preserves contradictions: ${source}`, () => {
        const result = checkSource(source);
        if (!result.issues.length) throw new Error("expected a type error");
    });
}

Deno.test("the original self-application factorial still checks and runs", () => {
    const source =
        "factorial = (self -> n -> self self n) (self -> n -> n == 0 ? 1 : n * (self self (n - 1))); factorial 5";
    const checked = checkSource(source, "<test>", { strict: true });
    if (checked.issues.length || checked.dynamicBoundaries) throw new Error(JSON.stringify(checked));
    const interpreter = new Interpreter();
    const actual = interpreter.renderString(
        interpreter.run(parseDocument(source)),
    );
    if (actual !== "120") throw new Error(actual);
});

Deno.test("a copied recursive function keeps its result relationship", () => {
    const source = 'self f = f f; a = self (x -> 123); b = self (x -> "hello"); [a,b]';
    const checked = checkSource(source);
    if (checked.issues.length || checked.dynamicBoundaries) {
        throw new Error(JSON.stringify(checked));
    }
    const interpreter = new Interpreter();
    const actual = interpreter.renderString(
        interpreter.run(parseDocument(source)),
    );
    if (actual !== '[123, "hello"]') throw new Error(actual);
});

Deno.test("checking depth exhaustion is an error, not Dynamic success", () => {
    // Construct the AST directly so this tests the checker, not parser limits.
    let expression: import("../src/ast.ts").Expr = { t: "int", v: 1n };
    for (let n = 0; n < 300; n++) expression = { t: "list", v: [expression] };
    // Use the same public entry point used by parsed programs.
    const result = checkTypes([{ t: "expr", value: expression }]);
    if (!result.issues.some((x) => x.message.includes("limit exceeded"))) {
        throw new Error(JSON.stringify(result));
    }
});

Deno.test("checking work exhaustion is an error, not Dynamic success", () => {
    const result = checkTypes(Array.from({ length: 50001 }, () => ({
        t: "expr" as const, value: { t: "int" as const, v: 1n },
    })));
    if (!result.issues.some(x => x.message.includes("limit exceeded"))) throw new Error(JSON.stringify(result));
});
