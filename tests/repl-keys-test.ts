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
        const source = "match (Some 123) [\n    Some x -> print x\n    None\n]";
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
