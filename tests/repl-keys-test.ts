import { ReplEditor, insideBrackets } from "../src/repl.ts";
import { Interpreter } from "../src/interp.ts";

function editor(src: string, offset = src.length): ReplEditor {
    const ed = new ReplEditor(new Interpreter(), []);
    ed.lines = src.split("\n");
    const prefix = src.slice(0, offset).split("\n");
    ed.row = prefix.length - 1;
    ed.col = prefix.at(-1)!.length;
    return ed;
}
function equal(actual: unknown, expected: unknown) {
    if (actual !== expected) throw new Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}
for (const [src, offset, inside] of [
    ["foo =", 5, false], ["x ->", 4, false],
    ["(1)", 2, true], ["(1)", 3, false],
    ["[1]", 1, true], ["{ 1 }", 3, true],
    ['"("', 3, false], ["# [", 3, false],
    ['{ "[" # }\n', 10, true], ["([)]", 4, true],
    ["1 + 2", 1, false],
] as const) {
    Deno.test(`Enter and Shift+Enter at ${offset} in ${src}`, () => {
        equal(editor(src, offset).enter(), inside ? "cont" : "submit");
        equal(editor(src, offset).enter(true), inside ? "submit" : "cont");
    });
}
Deno.test("Shift+Enter inserts a newline outside brackets", () => {
    const ed = editor("foo =");
    ed.enter(true);
    equal(ed.lines.length, 2);
});
for (const sequence of ["\x1b[13;2u", "\x1b[27;2;13~"]) {
    Deno.test(`Shift+Enter decoding ${JSON.stringify(sequence)}`, () => {
        const ed = editor("{");
        let action = "";
        for (const ch of sequence) action = ed.feed(ch);
        equal(action, "submit");
    });
}
for (const [left, right] of [["\x1bb", "\x1bf"], ["\x1b[1;3D", "\x1b[1;3C"], ["\x1b[1;9D", "\x1b[1;9C"]]) {
    Deno.test(`word navigation ${JSON.stringify(left)}`, () => {
        const ed = editor("one + two\nthree");
        for (const ch of left) ed.feed(ch);
        equal(ed.row, 1); equal(ed.col, 0);
        for (const ch of left) ed.feed(ch);
        equal(ed.row, 0); equal(ed.col, 6);
        for (const ch of right) ed.feed(ch);
        equal(ed.col, 9);
    });
}
Deno.test("escaped quotes and comments do not create brackets", () => {
    equal(insideBrackets('"escaped \\" ("'), false);
    equal(insideBrackets("# {\n[]"), false);
});

for (const sequence of ["\x17", "\x1b[119;5u", "\x1b[119;5:2u", "\x1b[27;5;119~"]) {
    Deno.test(`Ctrl+W deletes a word: ${JSON.stringify(sequence)}`, () => {
        const ed = editor("one two");
        for (const ch of sequence) ed.feed(ch);
        equal(ed.src(), "one ");
        equal(ed.col, 4);
        ed.lines = ["one", "two"]; ed.row = 1; ed.col = 0;
        for (const ch of sequence) ed.feed(ch);
        equal(ed.src(), "onetwo");
    });
}
Deno.test("encoded Ctrl shortcuts retain legacy behavior", () => {
    for (const code of [1, 3, 4, 5, 11, 21, 23]) {
        const legacy = editor("one two", 4), enhanced = editor("one two", 4);
        const expected = legacy.feed(String.fromCharCode(code));
        let actual = "";
        for (const ch of `\x1b[${code + 96};5u`) actual = enhanced.feed(ch);
        equal(actual, expected); equal(enhanced.src(), legacy.src());
        equal(enhanced.col, legacy.col);
    }
});
Deno.test("Ctrl+W release does not delete twice", () => {
    const ed = editor("one two");
    for (const ch of "\x1b[119;5u\x1b[119;5:3u") ed.feed(ch);
    equal(ed.src(), "one ");
});
