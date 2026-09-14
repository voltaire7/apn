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
    equal(lint("1 `add` 2")[0].range.start, { line: 0, character: 2 });
    equal(lint("handlers = [\n    Some y -> print y\n    None -> ()\n]"), []);
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
    for (const name of ["double", "x", "print", "Int", "match"]) if (!labels.includes(name)) throw new Error(`Missing ${name}`);
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
