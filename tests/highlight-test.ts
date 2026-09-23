import { highlightTokens, semanticTokens, TOKEN_TYPES } from "../src/highlight.ts";
import { LanguageServer } from "../src/lsp.ts";
function equal(a: unknown, b: unknown) {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}
function colors(source: string) {
    const lines = source.split("\n");
    return highlightTokens(source, new Set(["print"])).map((t) => [lines[t.line].slice(t.start, t.start + t.length), t.type]);
}
Deno.test("editor numbers distinguish prefixes, exponents, complex and polar markers", () => {
    equal(colors("0xFF 0b10 0o77 2i 1e-3 -1 1/3 2@0"), [
        ["0", "number"], ["x", "operator"], ["FF", "number"],
        ["0", "number"], ["b", "operator"], ["10", "number"],
        ["0", "number"], ["o", "operator"], ["77", "number"],
        ["2", "number"], ["i", "operator"], ["1", "number"], ["e", "operator"], ["-", "operator"], ["3", "number"],
        ["-", "operator"], ["1", "number"], ["1", "number"], ["/", "operator"], ["3", "number"],
        ["2", "number"], ["@", "operator"], ["0", "number"],
    ]);
});
Deno.test("editor ternary colons differ from record and cons colons", () => {
    equal(colors('x = true ? [x: 1] : (1:[])').filter(([text]) => text === ":" || text === "="),
        [["=", "punctuation"], [":", "punctuation"], [":", "operator"], [":", "punctuation"]]);
    equal(colors('true ? false ? 1 : 2 : 3').filter(([text]) => text === ":"), [[":", "operator"], [":", "operator"]]);
});
Deno.test("editor colors keywords, builtins, constructors, strings and comments", () => {
    equal(colors('import print Some true "hello" # comment'), [
        ["import", "keyword"], ["print", "function"], ["Some", "type"], ["true", "keyword"],
        ['"hello"', "string"], ["# comment", "comment"],
    ]);
    equal(colors("double' x = 'a'"), [["=", "punctuation"], ["'a'", "string"]]);
});
Deno.test("highlighting tolerates incomplete strings and brackets with UTF-16 positions", () => {
    const source = '["😀\nhello';
    equal(highlightTokens(source, new Set()), [
        { line: 0, start: 0, length: 1, type: "punctuation" },
        { line: 0, start: 1, length: 3, type: "string" },
        { line: 1, start: 0, length: 5, type: "string" },
    ]);
    equal(semanticTokens(source, new Set()), [0, 0, 1, TOKEN_TYPES.indexOf("punctuation"), 0,
        0, 1, 3, TOKEN_TYPES.indexOf("string"), 0, 1, 0, 5, TOKEN_TYPES.indexOf("string"), 0]);
});
Deno.test("range separators stay gray and decimal dots stay yellow", () => {
    equal(colors("[1..10] .1"), [["[", "punctuation"], ["1", "number"], ["..", "punctuation"],
        ["10", "number"], ["]", "punctuation"], [".1", "number"]]);
});
Deno.test("LSP advertises and serves semantic tokens for incomplete source", () => {
    const server = new LanguageServer();
    const init: any = server.handle({ id: 1, method: "initialize" })[0];
    equal(init.result.capabilities.semanticTokensProvider.legend.tokenTypes, TOKEN_TYPES);
    const uri = "file:///tmp/colors.apn";
    server.handle({ method: "textDocument/didOpen", params: { textDocument: { uri, version: 1, text: "print [" } } });
    const result: any = server.handle({ id: 2, method: "textDocument/semanticTokens/full", params: { textDocument: { uri } } })[0];
    equal(result.result.data.length, 10);
});

Deno.test("editor exponent operator", () => {
    equal(colors("2^3"), [["2", "number"], ["^", "operator"], ["3", "number"]]);
});
