import { checkSource } from "../src/type-checker.ts";
import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

// The checker evaluates the pure code a type needs, as the program would; what
// it cannot decide (a parameter, input, or past its budget) is a runtime check.
const ELEM = "Elem flag = flag ? Int : String; ";
const issues = (source: string) => checkSource(source, "<test>", { strict: true }).issues.map(i => i.message);
const run = (source: string) => { const i = new Interpreter(); return i.renderString(i.run(parseDocument(source))); };

for (const source of [
    ELEM + "(5 : Elem (isEven 4))",
    ELEM + "big n = n > 3; (7 : Elem (big 5))",
    "elemType flag = flag ? Int : String; elemType (3 > 1) 5",
    "cell 0 = Int; cell _ = String; cell 1 \"s\"",
    "fib 0 = 0; fib 1 = 1; fib n = fib (n - 1) + fib (n - 2); ([1,2,3,4,5] : Vect (fib 5) Int)",
]) {
    Deno.test(`a type computed by known code is decided: ${source}`, () => {
        const found = issues(source);
        if (found.length) throw new Error(found.join("; "));
    });
}

for (const [source, message] of [
    [ELEM + "(\"s\" : Elem (isEven 4))", "cannot use String where Int is required"],
    ["elemType flag = flag ? Int : String; elemType (3 > 1) \"s\"", "cannot use String where Int is required"],
    ["cell 0 = Int; cell _ = String; cell 1 5", "cannot use Int where String is required"],
    ["fib 0 = 0; fib 1 = 1; fib n = fib (n - 1) + fib (n - 2); ([1,2,3,4] : Vect (fib 5) Int)", "length mismatch: expected 5, got 4"],
    [ELEM + "f n = [1] : Elem (n > 3)", "cannot use Vect 1 Int where Int or String is required"],
]) {
    Deno.test(`a type computed by known code rejects: ${source}`, () => {
        const found = issues(source);
        if (!found.includes(message)) throw new Error(JSON.stringify(found));
    });
}

Deno.test("a type chosen by a parameter is checked at runtime", () => {
    const source = ELEM + "f n = \"s\" : Elem (n > 3); f 1 ++ \"!\"";
    const result = checkSource(source, "<test>", { strict: true });
    if (result.issues.length || !result.runtimeChecks) throw new Error(JSON.stringify(result));
    if (run(source) !== '"s!"') throw new Error(run(source));
    let message = "";
    try { run(ELEM + "f n = \"s\" : Elem (n > 3); f 5"); } catch (error) { message = String(error); }
    if (!message.includes("Int expects a number")) throw new Error(message);
});

Deno.test("a length evaluation cannot decide is checked at runtime", () => {
    const slow = "fib 0 = 0; fib 1 = 1; fib n = fib (n - 1) + fib (n - 2); xs = [1,2,3] : Vect (fib 27) Int";
    const result = checkSource(slow, "<test>", { strict: true });
    if (result.issues.length || !result.runtimeChecks) throw new Error(JSON.stringify(result));
    let message = "";
    try { run(slow + "; xs"); } catch (error) { message = String(error); }
    if (!message.includes("Vect length mismatch")) throw new Error(message);
    // Laziness: a length that never finishes is never demanded here.
    const endless = "loop n = loop (n + 1); xs = [1] : Vect (loop 0) Int; 1";
    if (issues(endless).length) throw new Error(issues(endless).join("; "));
    if (run(endless) !== "1") throw new Error("demanded an unused length");
});

Deno.test("the checker runs the runtime's text functions", () => {
    const source = 'import "text"; (to (List Char) "a😀" : Vect 3 Char)';
    const i = new Interpreter();
    i.enableChecking();
    let message = "";
    try { i.run(parseDocument(source)); } catch (error) { message = String(error); }
    if (!message.includes("length mismatch: expected 3, got 2")) throw new Error(message);
    const ok = new Interpreter();
    ok.enableChecking();
    const shown = ok.renderString(ok.run(parseDocument('import "text"; [upper "straße", (to (List Char) "a😀" : Vect 2 Char)]')));
    if (shown !== '["STRASSE",[\'a\',\'😀\']]') throw new Error(shown);
});

Deno.test("a condition reading a cell is not decided out of order", () => {
    const source = "counter = Mutable 0; set counter 5; " + ELEM + "x = 5 : Elem (counter > 3); x";
    const found = issues(source);
    if (found.length) throw new Error(found.join("; "));
});
