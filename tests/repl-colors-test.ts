import { parse } from "../main.ts";
import { Interpreter } from "../src/interp.ts";
import { renderColored, highlightLine } from "../src/repl.ts";

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
    for (const ch of "+-*/%=!<>$&|?`") {
        if (highlightLine(ch) !== `\x1b[38;2;239;159;118m${ch}\x1b[0m`) throw new Error(`Operator color: ${ch}`);
    }
    for (const ch of "(){}[];,:.") {
        if (highlightLine(ch) !== `\x1b[38;2;131;139;167m${ch}\x1b[0m`) throw new Error(`Punctuation color: ${ch}`);
    }
    const adjacent = highlightLine("(-x)+[1]");
    if (!adjacent.includes("\x1b[38;2;131;139;167m(\x1b[0m\x1b[38;2;239;159;118m-")) throw new Error("Adjacent tokens share color");
    for (const source of ['"+"', "'+'", "# +"]) {
        if (highlightLine(source).includes("239;159;118")) throw new Error("Colored operator inside literal/comment");
    }
});
