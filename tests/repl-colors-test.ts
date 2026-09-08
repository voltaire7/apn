import { parse } from "../main.ts";
import { Interpreter } from "../src/interp.ts";
import { renderColored } from "../src/repl.ts";

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
