import { lint, position } from "../src/lint.ts";
import { LanguageServer, MessageReader, encodeMessage, symbols } from "../src/lsp.ts";
import { parse, parseDocument } from "../src/parser.ts";

function equal(actual: unknown, expected: unknown) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
    }
}
function initialized() {
    const server = new LanguageServer();
    server.handle({ id: 1, method: "initialize", params: {} });
    return server;
}
Deno.test("lint reports real layout and syntax errors without executing APN", () => {
    equal(lint('print "do not execute"\nx = x\nload "missing-file"\n'), []);
    equal(lint("foo =")[0].code, "parse");
    equal(lint("f = {\n  1\n}")[0].code, "lex");
    equal(lint("x = `add")[0].range.start, { line: 0, character: 4 });
    // Unused parameters warn; _ and _-prefixed names discard.
    const unused = (source: string) => lint(source).filter(d => d.code === "unused").map(d => [d.range.start.line, d.range.start.character, d.message]);
    equal(unused("f x y = x"), [[0, 4, "'y' is never used; write _ to discard it"]]);
    equal(unused("f x _ = x\ng _y = 1"), []);
    equal(unused("return x = MkCounter (s -> [1,s])").map(d => d[2]), ["'x' is never used; write _ to discard it"]);
    equal(unused("xs = [0,0]\ni = 0\nxs i = 1\nSome v = Some 1"), []);
    // A field update reads the record and binds no new names.
    equal(unused("f model t = {\n    model.time = t\n    model.[width,height] = [t,t]\n    model\n}"), []);
    equal(unused("copy n (xs : Vect n Int) = xs\nk = x, y -> x"), [[1, 7, "'y' is never used; write _ to discard it"]]);
    // A lambda where a type is expected is a function type, not code.
    equal(unused("f (g : a -> b) = g\nt = ((a -> b) -> List a -> List b) == typeOf map\nu = isType (a -> b) 5\nv = (a -> b).(x -> x)\nC a = | MkC (a -> b)"), []);
    equal(lint("handlers = [\n    Some y -> print y\n    None -> []\n]"), []);
    // (t x) binds t as well; (_ x) discards it.
    equal(unused("f (x : t) = x\ng (x : _) = x").map(d => d[2]), ["'t' is never used; write _ to discard it"]);
    // name k = v on a parameter assigns an item; on another name it defines a function.
    equal(unused("put k v xs = { xs k = v; xs }"), []);
    equal(unused("f x = { g k = 1; x }").map(d => d[2]), ["'k' is never used; write _ to discard it"]);
    // A name a typed pattern's type binds is a parameter too; repeating it is a use.
    equal(unused("first (x::_ : List a) = x\ng (_ : Vect n a) = n").map(d => d[2]), ["'a' is never used; write _ to discard it", "'a' is never used; write _ to discard it"]);
    equal(unused("h (_ : Vect n a) (_ : Vect n a) = n\nk (x::_ : List _) = x\ncopy n (xs : Vect n Int) = xs"), []);
    // So in the shorthand Vect n a xs, also when a lambda's pattern repeats it.
    equal(unused("f (xs : Vect n a) (ys : Vect m a) = [n,m,xs,ys]\ng = (xs : Vect n a) -> (ys : Vect m a) -> [n,m,xs,ys]"), []);
    equal(unused("f (xs : Vect n a) = [n,xs]").map(d => d[2]), ["'a' is never used; write _ to discard it"]);
    // A literal zero divisor warns, except IEEE division with a Float on either side.
    const zero = (source: string) => lint(source).filter(d => d.code === "zeroDivisor").map(d => [d.range.start.line, d.range.start.character, d.range.end.character]);
    equal(zero("a = 1 / 0\nb = (/ 0)\nc = quotient 7 -0\nd = 7 % 0.0\ne = modulo 7 0"), [[0, 8, 9], [1, 7, 8], [2, 15, 17], [3, 8, 11], [4, 13, 14]]);
    equal(zero("a = 1.0 / 0\nb = 1 / 0.0\nc = 1 / x\nd = safeDiv 1 0"), []);
    // Recursion with no smaller argument where the call is certainly evaluated.
    const endless = (source: string) => lint(source).filter(d => d.code === "termination").map(d => d.range.start.line);
    equal(endless("loop x = loop x\nup n = up (n + 1)\nspin n = n > 0 ? spin n : 0\ncount n = 1 + count n"), [0, 1, 2, 3]);
    equal(endless([
        "down 0 = 0", "down n = down (n - 1)", "len [] = 0", "len (_::xs) = 1 + len xs", "nats n = n :: nats (n + 1)",
        "fact Z = 1", "fact (S k) = (k + 1) * fact k", "rest xs = null xs ? 0 : rest (tail xs)",
        "act n = {", "    print n", "    act (n + 1)", "}", "xs = [1,2]", "xs 0 = xs 1", "f g = x -> f g x",
    ].join("\n")), []);
});
Deno.test("diagnostic positions use UTF-16 and stay within the document", () => {
    equal(position('"😀"\nfoo', 7), { line: 1, character: 2 });
    const error = lint('"😀"\nfoo =')[0];
    equal(error.range.start.line, 1);
    equal(error.range.end.line, 1);
    if (error.range.end.character > 5) throw new Error("range beyond EOF");
});
Deno.test("document parsing isolates declarations and restores REPL state", () => {
    parse("EditorRemembered a = | EditorRemembered a");
    const source = "EditorFresh a = | EditorFresh a";
    equal(parseDocument(source)[0].t, "type");
    equal(parseDocument(source)[0].t, "type");
    try { parseDocument("EditorBroken a = | EditorBroken a\nfoo ="); } catch { /* intentional */ }
    equal(parseDocument("EditorBroken a = | EditorBroken a")[0].t, "type");
    equal(parse("EditorRemembered x = EditorRemembered 1")[0].t, "patDef");
});
Deno.test("LSP diagnostics follow open/change/close and ignore stale versions", () => {
    const server = initialized();
    const uri = "file:///tmp/a.apn";
    const open: any = server.handle({ method: "textDocument/didOpen", params: { textDocument: { uri, text: "x =", version: 1 } } })[0];
    equal(open.params.diagnostics.length, 1);
    const change: any = server.handle({ method: "textDocument/didChange", params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: "x = 1" }] } })[0];
    equal(change.params.diagnostics, []);
    equal(change.params.version, 2);
    equal(server.handle({ method: "textDocument/didChange", params: { textDocument: { uri, version: 1 }, contentChanges: [{ text: "x =" }] } }), []);
    const close: any = server.handle({ method: "textDocument/didClose", params: { textDocument: { uri } } })[0];
    equal(close.params.diagnostics, []);
    equal(server.documents.size, 0);
});
Deno.test("LSP completion hover outline and lifecycle", () => {
    const server = initialized();
    const uri = "file:///tmp/a.apn";
    server.handle({ method: "textDocument/didOpen", params: { textDocument: { uri, version: 1, text: "double x = x * 2" } } });
    const request = (method: string): any => server.handle({ id: 2, method, params: { textDocument: { uri }, position: { line: 0, character: 2 } } })[0];
    const labels = request("textDocument/completion").result.items.map((x: any) => x.label);
    for (const name of ["double", "x", "print", "Int"]) if (!labels.includes(name)) throw new Error(`Missing ${name}`);
    equal(request("textDocument/hover").result.contents.value, "Top-level declarations in this document:\ndouble x = x * 2");
    equal(request("textDocument/documentSymbol").result[0].name, "double");
    equal(request("unknown").error.code, -32601);
    equal(server.handle({ id: 3, method: "shutdown" }), [{ jsonrpc: "2.0", id: 3, result: null }]);
    server.handle({ method: "exit" });
    equal(server.exitCode, 0);
    const early = new LanguageServer();
    early.handle({ method: "exit" });
    equal(early.exitCode, 1);
});
Deno.test("LSP framing handles fragmented and batched Unicode messages", () => {
    const messages = [{ id: 1, method: "initialize", params: { label: "😀é" } }, { method: "exit" }];
    const bytes = new Uint8Array([...encodeMessage(messages[0]), ...encodeMessage(messages[1])]);
    for (const size of [1, 3, 20, bytes.length]) {
        const reader = new MessageReader();
        const result = [];
        for (let i = 0; i < bytes.length; i += size) result.push(...reader.push(bytes.slice(i, i + size)));
        equal(result, messages);
    }
});
Deno.test("outline omits nested bindings", () => {
    equal(symbols("f x = {\n    local = 1\n    local + x\n}\n").map((s) => s.name), ["f"]);
});

Deno.test("outline supports apostrophes and excludes comparison expressions", () => {
    equal(symbols("double' x = x * 2\ndouble' 1 == 2\ndouble' \"=\"\n").map((s) => s.name), ["double'"]);
});
Deno.test("optional type diagnostics share the checker", () => {
    const source = 'f (x : Int) = x\nf "bad"';
    equal(lint(source).filter(d => d.code === 'type').length, 0);
    equal(lint(source, true).filter(d => d.code === 'type').length, 1);
    const server = new LanguageServer();
    server.handle({id: 1, method: 'initialize', params: {initializationOptions: {typeChecking: true}}});
    const result: any = server.handle({method: 'textDocument/didOpen', params: {textDocument: {uri: 'file:///types.apn', version: 1, text: source}}})[0];
    equal(result.params.diagnostics.filter((d: any) => d.code === 'type').length, 1);
});
Deno.test("completing a standard name adds its import, as a list beside another", () => {
    const complete = (text: string, name: string) => {
        const server = initialized();
        const uri = "file:///tmp/imports.apn";
        server.handle({ method: "textDocument/didOpen", params: { textDocument: { uri, version: 1, text } } });
        const items = (server.handle({ id: 2, method: "textDocument/completion", params: { textDocument: { uri }, position: { line: 0, character: 0 } } })[0] as any).result.items;
        const item = items.find((x: any) => x.label === name);
        return item && [item.detail, item.additionalTextEdits?.map((e: any) => [e.range.start.line, e.range.start.character, e.range.end.character, e.newText])];
    };
    equal(complete("x = 1", "sum"), ['From import "sequence"', [[0, 0, 0, 'import "sequence"\n\n']]]);
    equal(complete("\nx = 1", "sum")?.[1], [[0, 0, 0, 'import "sequence"\n']]);
    equal(complete('import "io" # files\nx = 1', "upper"), ['From import "text"', [[0, 7, 11, '["io","text"]']]]);
    equal(complete('import [\n    "io"\n]\nimport ["io","text"]', "sum"), ['From import "sequence"', [[3, 7, 20, '["io","text","sequence"]']]]);
    // Already imported, defined here, or in the prelude: nothing to add.
    equal(complete('import ["io","text"]', "readFile"), ['From import "io"', undefined]);
    equal(complete("sum xs = 0", "sum")?.[1], undefined);
    equal(complete("x = 1", "print")?.[1], undefined);
    // Retired natives are not offered; a native needing an import names it.
    equal(complete("x = 1", "toString"), undefined);
    equal(complete("x = 1", "withFile")?.[1]?.[0]?.[3], 'import "io"\n\n');
});
Deno.test("lint reports a clause or alternative that never runs", () => {
    const unreachable = (source: string) => lint(source).filter(d => d.code === "unreachable-clause").map(d => d.range.start.line);
    // After a clause taking any argument, a list, cons or program constructor
    // pattern ranks no higher, so its clause never runs; in a block too.
    equal(unreachable("f xs = 0\nf [a,b] = a + b\ng x = 0\ng (x :: _) = x"), [1, 3]);
    equal(unreachable("import \"option\"\nm _ = 0\nm (Some y) = y"), [2]);
    equal(unreachable("b = {\n    q x = 0\n    q [a] = a\n    q 1\n}"), [2]);
    equal(lint("f xs = 0\nf [a,b] = a + b")[0].message, "This clause of 'f' never runs: the clause on line 1 takes any argument and comes first.");
    // A literal or a built-in type outranks a name; an equivalent clause
    // replaces the earlier one; a guard or a repeated name takes not everything;
    // a rebinding starts a new version.
    equal(unreachable("f x = 0\nf 1 = 2\ng x = 0\ng (n : Int) = n\nk x = 0\nk y = 9"), []);
    equal(unreachable("n x x = 0\nn [a] b = 1\nw = x | x > 0 -> 1\nw [a] = 2\nr x = 0\nr = 5\nr [a] = 1"), []);
    // Constructors of imported modules, standard or the program's own, rank no
    // higher either; one the linter cannot resolve is left alone.
    equal(unreachable("import \"browser\"\nv _ = 0\nv Visible = 1"), [2]);
    const cards = new URL("./fixtures/lint/", import.meta.url).pathname;
    equal(lint("import \"cards\"\ns _ = 0\ns Hearts = 1", false, cards).filter(d => d.code === "unreachable-clause").map(d => d.range.start.line), [2]);
    equal(unreachable("import \"cards\"\ns _ = 0\ns Hearts = 1"), []);
    // So are those of a file a statement loads (load "f", (load "f" : Dynamic)).
    for (const load of ['load "cards"', '(load "cards" : Dynamic)', 'load "missing"']) {
        equal(lint(`${load}\ns _ = 0\ns Hearts = 1`, false, cards).filter(d => d.code === "unreachable-clause").length, load.includes("cards") ? 1 : 0);
    }
    // And of a record use opens: one bound to an import or a load, written in
    // place, or in a list; not a record never opened, or rebound to another.
    const opened = (source: string) => lint(source, false, cards).filter(d => d.code === "unreachable-clause").length;
    equal(opened('opt = import "option"\nuse opt\nf _ = 0\nf (Some x) = x'), 1);
    equal(opened('t <- load "cards"\nuse [t]\ns _ = 0\ns Hearts = 1'), 1);
    equal(opened('use (import "cards")\ns _ = 0\ns Hearts = 1'), 1);
    equal(opened('opt = import "option"\nf _ = 0\nf (Some x) = x'), 0);
    equal(opened('t <- load "cards"\nt = [x = 1]\nuse t\ns _ = 0\ns Hearts = 1'), 0);
    // match ranks its alternatives as clauses: a literal after an unconditional
    // one still runs, another name or list pattern never does.
    equal(unreachable("v = 3 ~ [\n    x -> 0\n    1 -> 5\n]"), []);
    equal(unreachable("v = 3 ~ [\n    x -> 0\n    [a] -> 5\n    y -> 1\n]"), [2, 3]);
    equal(unreachable("v = 3 ~ [\n    1 -> 5\n    x -> 0\n]"), []);
});
