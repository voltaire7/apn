import { parse } from "../main.ts";
import { Interpreter } from "../src/interp.ts";
import { renderColored, highlightLine, colored } from "../src/repl.ts";
import { highlightHtml } from "../src/highlight.ts";

// The REPL echo: every value is colored as the interpreter renders it.
function echo(interp: Interpreter, value: import("../src/types.ts").Value): string {
    let output = "";
    renderColored(interp, value, (text) => { output += text; });
    return output;
}

for (const source of ["[1]", "[x: 1]", '[x: [1,"hi",true]]', "take 3 [1..]"]) {
    Deno.test(`streamed REPL colors: ${source}`, () => {
        const interp = new Interpreter();
        const value = interp.run(parse(source));
        let output = "";
        renderColored(interp, value, (text) => { output += text; });
        if (!output.includes("\x1b[38;2;229;200;144m1\x1b[0m")) throw new Error("Missing numeric color");
        if (output.replace(/\x1b\[[0-9;]*m/g, "") !== interp.renderString(value)) throw new Error("Rendering changed content");
        if (source.includes('"hi"') && !output.includes('\x1b[38;2;166;209;137m"hi"\x1b[0m')) throw new Error("Missing string color");
    });
}
// A list's items are held only until its ',' is decided (sixteen of them).
Deno.test("colored infinite lists stream", () => {
    const interp = new Interpreter();
    const stop = new Error("stop");
    let output = "";
    try {
        renderColored(interp, interp.run(parse("[1..]")), (text) => {
            output += text;
            if (output.includes("144m20\x1b[0m")) throw stop;
        });
    } catch (error) { if (error !== stop) throw error; }
    if (output.replace(/\x1b\[[0-9;]*m/g, "") !== `[${Array.from({ length: 20 }, (_, n) => n + 1).join(",")}`) throw new Error("Not streaming");
});

Deno.test("operators use peach while structural punctuation stays gray", () => {
    for (const ch of "+-*/%!<>$&|?`") {
        if (highlightLine(ch) !== `\x1b[38;2;239;159;118m${ch}\x1b[0m`) throw new Error(`Operator color: ${ch}`);
    }
    for (const ch of "[]{}[];,:.=") {
        if (highlightLine(ch) !== `\x1b[38;2;131;139;167m${ch}\x1b[0m`) throw new Error(`Punctuation color: ${ch}`);
    }
    const adjacent = highlightLine("(-x)+[1]");
    if (!adjacent.includes("\x1b[38;2;131;139;167m(\x1b[0m\x1b[38;2;239;159;118m-")) throw new Error("Adjacent tokens share color");
    for (const source of ['"+"', "'+'", "# +"]) {
        if (highlightLine(source).includes("239;159;118")) throw new Error("Colored operator inside literal/comment");
    }
});

Deno.test("fraction slashes are peach in scalar and nested echoes", () => {
    const interp = new Interpreter();
    const value = interp.run(parse("1/3"));
    const expected = "\x1b[38;2;229;200;144m1\x1b[0m\x1b[38;2;239;159;118m/\x1b[0m\x1b[38;2;229;200;144m3\x1b[0m";
    if (echo(interp, value) !== expected) throw new Error("Wrong scalar fraction colors");
    for (const source of ["[1/3]", "[x: 1/3]"]) {
        let output = "";
        renderColored(interp, interp.run(parse(source)), (text) => { output += text; });
        if (!output.includes(expected)) throw new Error("Wrong nested fraction colors");
    }
});

Deno.test("complex signs are peach in scalar and nested echoes", () => {
    const interp = new Interpreter();
    for (const source of ["sqrt -1", "makeRectangular 0 -1"]) {
        const value = interp.run(parse(source));
        const sign = source.startsWith("sqrt") ? "+" : "-";
        const expected = `\x1b[38;2;239;159;118m${sign}\x1b[0m`;
        if (!echo(interp, value).includes(expected)) throw new Error("Wrong complex sign color");
        let nested = "";
        renderColored(interp, { kind: "list", v: [value] }, (text) => { nested += text; });
        if (!nested.includes(expected)) throw new Error("Wrong nested complex sign color");
    }
});

Deno.test("ternary colons are peach, record colons and assignment are gray", () => {
    const peach = "\x1b[38;2;239;159;118m", gray = "\x1b[38;2;131;139;167m";
    const text = highlightLine('x = true ? [field: 1] : false ? 2 : 3');
    if (text.split(peach + ":").length - 1 !== 2) throw new Error("Missing ternary color");
    if (!text.includes(gray + ":") || !text.includes(gray + "=")) throw new Error("Wrong punctuation color");
    for (const op of ["==", "!=", "<=", ">="]) {
        if (highlightLine(op) !== peach + op + "\x1b[0m") throw new Error("Comparison lost operator color");
    }
    const state = [0];
    highlightLine("true ?", state);
    if (!highlightLine('    "yes" : "no"', state).includes(peach + ":")) throw new Error("Multiline ternary lost color");
});

Deno.test("numeric markers are peach and digits remain yellow", () => {
    const peach = "\x1b[38;2;239;159;118m", yellow = "\x1b[38;2;229;200;144m";
    for (const [source, marker, digits] of [["2i", "i", "2"], ["0xFF", "x", "FF"], ["0b1101", "b", "1101"], ["0o235", "o", "235"], ["0XFE", "X", "FE"], ["1e3", "e", "3"]]) {
        const output = highlightLine(source);
        if (!output.includes(peach + marker + "\x1b[0m") || !output.includes(yellow + digits + "\x1b[0m")) throw new Error(`Wrong colors: ${source}`);
    }
    if (highlightLine("i") !== "i") throw new Error("Colored standalone variable i");
    const interp = new Interpreter();
    const value = interp.run(parse("2i"));
    if (!echo(interp, value).includes(peach + "i\x1b[0m")) throw new Error("Missing echoed imaginary marker color");
    let nested = "";
    renderColored(interp, { kind: "list", v: [value] }, (text) => { nested += text; });
    if (!nested.includes(peach + "i\x1b[0m")) throw new Error("Missing nested imaginary marker color");
});

Deno.test("functions echo as the interpreter renders them", () => {
    const interp = new Interpreter();
    const value = interp.run(parse("f x y = x + y\nf 1"));
    if (echo(interp, value).replace(/\x1b\[[0-9;]*m/g, "") !== "y -> 1 + y") throw new Error(echo(interp, value));
});

Deno.test("REPL colors match and return as it colors import, load and use", () => {
    const color = (word: string) => highlightLine(word).match(/^\x1b\[[0-9;]*m/)?.[0];
    for (const word of ["match", "return", "load", "use"]) {
        if (color(word) !== color("import")) throw new Error(`${word}: ${JSON.stringify(highlightLine(word))}`);
    }
});

Deno.test("the web editor's HTML escapes tokens after coloring them", () => {
    const html = highlightHtml('f x = match x [\n    1 -> "<b>"\n]', new Set());
    if (!html.includes('<span class="t-operator">-&gt;</span>') || !html.includes('<span class="t-string">"&lt;b&gt;"</span>')) throw new Error(html);
    if (!html.includes('<span class="t-keyword">match</span>') || html.split("\n").length !== 3) throw new Error(html);
});

Deno.test("a type's numeric arguments are colored as numbers", () => {
    const interp = new Interpreter();
    const output = echo(interp, interp.run(parse("Vect 2 (Vect 1 Int)")));
    if (!output.includes("\x1b[38;2;229;200;144m1\x1b[0m")) throw new Error(output);
    if (output.replace(/\x1b\[[0-9;]*m/g, "") !== "Vect 2 (Vect 1 Int)") throw new Error(output);
});

// echo x prints what the REPL echoes for x, colored when paint is set.
Deno.test("echo prints as the REPL echoes", () => {
    const output: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
    try {
        const interp = new Interpreter();
        interp.enableChecking();
        interp.run(parse('echo ["hi", Vect 1 Int]'));
        interp.paint = colored;
        interp.run(parse('echo "hi"'));
        const expected = echo(interp, interp.run(parse('"hi"')));
        if (output[0] !== '["hi", Vect 1 Int]' || output[1] !== expected) throw new Error(JSON.stringify(output));
    } finally {
        console.log = log;
    }
});
