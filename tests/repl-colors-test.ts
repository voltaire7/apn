import { parse } from "../main.ts";
import { Interpreter } from "../src/interp.ts";
import { renderColored, highlightLine, showValue } from "../src/repl.ts";

for (const source of ["[1]", "[x: 1]", '[x: [1, "hi", true]]', "take 3 [1..]"]) {
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
Deno.test("colored infinite lists stream without buffering", () => {
    const interp = new Interpreter();
    const stop = new Error("stop");
    let output = "";
    try {
        renderColored(interp, interp.run(parse("[1..]")), (text) => {
            output += text;
            if (output.includes("144m3\x1b[0m")) throw stop;
        });
    } catch (error) { if (error !== stop) throw error; }
    if (output.replace(/\x1b\[[0-9;]*m/g, "") !== "[1, 2, 3") throw new Error("Not streaming");
});

Deno.test("operators use peach while structural punctuation stays gray", () => {
    for (const ch of "+-*/%!<>$&|?`") {
        if (highlightLine(ch) !== `\x1b[38;2;239;159;118m${ch}\x1b[0m`) throw new Error(`Operator color: ${ch}`);
    }
    for (const ch of "(){}[];,:.=") {
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
    if (showValue(value) !== expected) throw new Error("Wrong scalar fraction colors");
    for (const source of ["[1/3]", "[x: 1/3]"]) {
        let output = "";
        renderColored(interp, interp.run(parse(source)), (text) => { output += text; });
        if (!output.includes(expected)) throw new Error("Wrong nested fraction colors");
    }
});

Deno.test("complex signs are peach in scalar and nested echoes", () => {
    const interp = new Interpreter();
    for (const source of ["sqrt (-1)", "makeRectangular 0 (-1)"]) {
        const value = interp.run(parse(source));
        const sign = source.startsWith("sqrt") ? "+" : "-";
        const expected = `\x1b[38;2;239;159;118m${sign}\x1b[0m`;
        if (!showValue(value).includes(expected)) throw new Error("Wrong complex sign color");
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
        if (!highlightLine(op).includes(peach + "=")) throw new Error("Comparison lost operator color");
    }
    const state = [0];
    highlightLine("true ?", state);
    if (!highlightLine('    "yes" : "no"', state).includes(peach + ":")) throw new Error("Multiline ternary lost color");
});
