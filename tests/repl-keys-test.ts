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
    ["foo =", 5, true], ["x ->", 4, true], ["y <-", 4, true], ["x == ", 5, false], ["foo = 1", 7, false], ['s = "="', 7, false],
    ["(1)", 2, false], ["(1)", 3, false],
    ["[1]", 1, true], ["{ 1 }", 3, false],
    ['"("', 3, false], ["# [", 3, false],
    ['{ "[" # }\n', 10, true], ["([)]", 4, false],
    ["1 + 2", 1, false],
] as const) {
    Deno.test(`Enter and Shift+Enter at ${offset} in ${src}`, () => {
        equal(editor(src, offset).enter(), inside ? "cont" : "submit");
        equal(editor(src, offset).enter(true), inside ? "submit" : "cont");
    });
}
Deno.test("Shift+Enter inserts a newline outside brackets", () => {
    const ed = editor("foo = 1");
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

// Caps Lock (+64) and Num Lock (+128) ride along in the modifiers.
for (const sequence of ["\x17", "\x1b[119;5u", "\x1b[119;5:2u", "\x1b[27;5;119~", "\x1b[119;69u", "\x1b[119;197u"]) {
    Deno.test(`Ctrl+W deletes a word: ${JSON.stringify(sequence)}`, () => {
        const ed = editor("one two");
        for (const ch of sequence) ed.feed(ch);
        equal(ed.src(), "one ");
        equal(ed.col, 4);
        // As fish does, a line break before the cursor goes with the word before it.
        ed.lines = ["one", "two"]; ed.row = 1; ed.col = 0;
        for (const ch of sequence) ed.feed(ch);
        equal(ed.src(), "two");
    });
}
Deno.test("arrows move with Caps Lock or Num Lock on", () => {
    const ed = editor("ab\ncd");
    for (const sequence of ["\x1b[1;65D", "\x1b[1;129D"]) for (const ch of sequence) ed.feed(ch);
    equal(ed.col, 0);
    for (const ch of "\x1b[1;65A") ed.feed(ch);
    equal(ed.row, 0);
    for (const ch of "\x1b[1;65C") ed.feed(ch);
    equal(ed.col, 1);
    for (const ch of "\x1b[1;67D") ed.feed(ch); // Option+Left
    equal(ed.col, 0);
});
const keys = (ed: ReplEditor, sequence: string) => { for (const ch of sequence) ed.feed(ch); };
Deno.test("changing history entries puts the cursor at the end of each line, until a move sideways", () => {
    const ed = new ReplEditor(new Interpreter(), ["f x = {\n    x + 1\n}", "1 + 2"]);
    ed.lines = ["12345678"]; ed.row = 0; ed.col = 6;
    keys(ed, "\x1b[A");
    equal(ed.src(), "1 + 2"); equal(ed.col, 5);
    keys(ed, "\x1b[A"); // an older entry: its last line
    equal(ed.row, 2); equal(ed.col, 1);
    keys(ed, "\x1b[A"); // a middle line
    equal(ed.row, 1); equal(ed.col, 9);
    keys(ed, "\x1b[A");
    equal(ed.row, 0); equal(ed.col, 7);
    keys(ed, "\x1b[B\x1b[B\x1b[B"); // a newer entry: its first line
    equal(ed.src(), "1 + 2"); equal(ed.row, 0); equal(ed.col, 5);
    keys(ed, "\x1b[B"); // the draft
    equal(ed.src(), "12345678"); equal(ed.col, 8);
    keys(ed, "\x1b[A\x1b[A\x1b[A\x1b[D\x1b[D\x1b[D"); // a move sideways sets a column...
    equal(ed.row, 1); equal(ed.col, 6);
    keys(ed, "\x1b[A"); // ...that the next moves keep
    equal(ed.row, 0); equal(ed.col, 6);
    keys(ed, "\x1b[B\x1b[B"); // within the entry
    equal(ed.row, 2); equal(ed.col, 1);
    keys(ed, "\x1b[B\x1b[D\x1b[D\x1b[B"); // another entry: the end again
    equal(ed.src(), "12345678"); equal(ed.col, 8);
});
Deno.test("Up and Down in a new entry keep the column, as in Vim", () => {
    const ed = editor("12345678\nab\n12345678", 6);
    keys(ed, "\x1b[B");
    equal(ed.row, 1); equal(ed.col, 2);
    keys(ed, "\x1b[B"); // the column remembered past a short line
    equal(ed.row, 2); equal(ed.col, 6);
    keys(ed, "\x1b[D\x1b[A\x1b[A"); // moving sideways sets a new column
    equal(ed.row, 0); equal(ed.col, 5);
});
Deno.test("Left and Right stay on their line, as in Vim", () => {
    const ed = editor("ab\ncd", 2);
    keys(ed, "\x1b[C");
    equal(ed.row, 0); equal(ed.col, 2);
    ed.row = 1; ed.col = 0;
    keys(ed, "\x1b[D");
    equal(ed.row, 1); equal(ed.col, 0);
});
Deno.test("Ctrl+W kills back to a path component, as fish's", () => {
    const ed = editor('load "lib/sub/file"');
    keys(ed, "\x17");
    equal(ed.src(), 'load "lib/sub/'); // the quote goes with the name it ends
    keys(ed, "\x17");
    equal(ed.src(), 'load "lib/');
    keys(ed, "\x17");
    equal(ed.src(), 'load "');
});
Deno.test("Option+Backspace and Option+D kill a word; _ separates words", () => {
    const ed = editor("x_value + 1", 7);
    keys(ed, "\x1b\x7f");
    equal(ed.src(), "x_ + 1");
    keys(ed, "\x1b[127;3u");
    equal(ed.src(), "x + 1");
    const forward = editor("map f xs", 0);
    keys(forward, "\x1bd");
    equal(forward.src(), " f xs");
});
Deno.test("Ctrl+Y yanks what consecutive kills took, in order", () => {
    const ed = editor("one two three");
    keys(ed, "\x17\x17");
    equal(ed.src(), "one ");
    keys(ed, "\x19");
    equal(ed.src(), "one two three");
    keys(ed, "\x01\x0b\x19\x19");
    equal(ed.src(), "one two threeone two three");
});
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

Deno.test("Enter submits an unfinished list after an element", () => {
    equal(editor("[1, 2, 3").enter(), "submit");
});
for (const opener of ["(", "{", "["]) {
    Deno.test(`Enter indents immediately after ${opener} at the cursor`, () => {
        const ed = editor(opener + "123", 1);
        equal(ed.enter(), "cont");
        equal(ed.src(), opener + "\n    123");
        equal(ed.col, 4);
        equal(editor(opener + "  ").enter(), "cont");
        equal(editor(opener + "  ").enter(true), "submit");
    });
}
Deno.test("an opening bracket in an unfinished string does not indent", () => {
    equal(editor('["[').enter(), "submit");
});

for (const [open, close] of [["[", "]"], ["{", "}"], ["(", ")"]]) {
    Deno.test(`Enter continues a multiline ${open} body`, () => {
        const src = open + "\n    1";
        const ed = editor(src);
        equal(ed.enter(), "cont");
        equal(ed.src(), src + "\n    ");
        equal(ed.col, 4);
        equal(editor(src).enter(true), "submit");
        equal(editor(src + "\n" + close).enter(), "submit");
        equal(editor(src + "\n" + close).enter(true), "cont");
    });
}
Deno.test("an earlier unrelated line does not make a bracket multiline", () => {
    equal(editor("x = 1\n[1, 2, 3").enter(), "submit");
});
Deno.test("Enter inside a pasted multiline list uses cursor position", () => {
    const src = "[\n    1\n]";
    const ed = editor(src, src.indexOf("1") + 1);
    equal(ed.enter(), "cont");
    equal(ed.src(), "[\n    1\n    \n]");
});

Deno.test("blank continuation lines retain indentation without accumulating it", () => {
    for (const opening of ["[", "{", "("]) {
        const ed = editor(opening);
        for (let i = 0; i < 3; i++) {
            equal(ed.enter(), "cont");
            equal(ed.lines[ed.row], "    ");
            equal(ed.col, 4);
        }
    }
    const nested = editor("[\n    [");
    nested.enter();
    equal(nested.col, 8);
    nested.enter();
    equal(nested.col, 8);
});


Deno.test("bracketed paste preserves handler indentation and waits for Enter", async () => {
    const source = "handlers = [\n    Some y -> print y\n    None -> []\n]";
    const ed = editor("");
    ed.emit = () => {};
    ed.render = () => {};
    // Enter arrives after the complete paste; it must submit the intact snippet.
    ed.pendingKeys = "\x1b[200~" + source + "\x1b[201~\r";
    equal(await ed.readChunk(), source);
});

Deno.test("paste preserves nested layout, blank lines and trailing newline", () => {
    const source = "f = {\n    [\n        1\n\n    ]\n}\n";
    const ed = editor("");
    ed.insertPaste(source);
    equal(ed.src(), source);
    equal(ed.row, 6);
    equal(ed.col, 0);
});

Deno.test("paste inserts at the cursor without dedenting closing brackets", () => {
    const ed = editor("    suffix", 4);
    ed.insertPaste("]\n    }");
    equal(ed.src(), "    ]\n    }suffix");
    equal(ed.row, 1);
    equal(ed.col, 5);
});

Deno.test("paste normalizes clipboard line endings without adding indentation", () => {
    for (const newline of ["\r\n", "\r", "\n"]) {
        const ed = editor("");
        ed.insertPaste("[" + newline + "    1" + newline + "]");
        equal(ed.src(), "[\n    1\n]");
    }
});

for (const width of [80, 16]) {
    for (const [position, movement, submit] of [
        ["first line", "\x1b[A\x1b[A\x1b[A\x01\x1b[C\x1b[C\x1b[C\x1b[C\x1b[C", "\r"],
        ["middle line", "\x1b[A\x1b[A", "\x1b[13;2u"],
        ["last line", "", "\r"],
    ]) Deno.test(`submission finishes below input from ${position}, width ${width}`, async () => {
        const source = "Some 123 ~ [\n    Some x -> print x\n    None\n]";
        const ed = editor("");
        let output = "";
        ed.width = () => width;
        ed.emit = text => { output += text; };
        ed.pendingKeys = "\x1b[200~" + source + "\x1b[201~" + movement + submit;
        equal(await ed.readChunk(), source);
        ed.print("123");
        // After the final repaint there must be no move back into the input.
        const finalPaint = output.slice(output.lastIndexOf("\r\x1b[J") + 4);
        const plain = finalPaint.replace(/\x1b\[[0-9;]*m/g, "");
        equal(plain, source.split("\n").map((line, index) => (index ? "... " : ">>> ") + line + "\r\n").join("") + "123\r\n");
    });
}

Deno.test("typing a closing parenthesis dedents a blank continuation", () => {
    const ed = editor("vec * (\n    print\n    ");
    ed.insertText(")");
    equal(ed.src(), "vec * (\n    print\n)");
    equal(ed.col, 1);
    ed.backspace();
    equal(ed.src(), "vec * (\n    print\n    ");
    equal(ed.col, 4);
});
Deno.test("closing parentheses dedent one level inside nested layout", () => {
    const ed = editor("f = {\n    g (\n        x\n        ");
    ed.insertText(")");
    equal(ed.lines.at(-1), "    )");
    equal(ed.col, 5);
});
Deno.test("inline and pasted closing parentheses keep their indentation", () => {
    const inline = editor("f (\n    x");
    inline.insertText(")");
    equal(inline.src(), "f (\n    x)");
    const pasted = editor("f (\n    ");
    pasted.insertPaste(")");
    equal(pasted.src(), "f (\n    )");
});
Deno.test("Enter after a trailing = indents the body", () => {
    const ed = editor("func =");
    equal(ed.enter(), "cont");
    equal(ed.lines[1], "    ");
    ed.insertText("{");
    equal(ed.enter(), "cont");
    equal(ed.lines[2], "        ");
});
