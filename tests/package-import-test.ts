import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

const directory = new URL("./fixtures/packages/", import.meta.url).pathname;
function interpreter(checked: boolean): Interpreter {
    const i = new Interpreter();
    if (checked) i.enableChecking();
    i.sourceDir = directory;
    return i;
}
function result(i: Interpreter, source: string): string {
    return i.renderString(i.run(parseDocument(source)));
}
for (const checked of [false, true]) {
    Deno.test(`import finds files and folders next to the code (checked=${checked})`, () => {
        const i = interpreter(checked);
        const actual = result(i, 'import ["hello","shapes","shapes/solid"]; [greet "you",square 3,cube 2,volume 2]');
        if (actual !== '["hi you",9,8,8]') throw new Error(actual);
        if (result(i, 'sh = import "shapes"; sh.square 4') !== "16") throw new Error("namespaced");
        // A folder's subfolders are not part of it.
        let excluded = false;
        try { result(interpreter(checked), 'import "shapes"; volume 2'); } catch { excluded = true; }
        if (!excluded) throw new Error("subfolder imported with its parent");
    });
    Deno.test(`a file wins over a folder of the same name (checked=${checked})`, () => {
        const i = interpreter(checked);
        if (result(i, 'import "both"; fromFile') !== "1") throw new Error("file");
        if (result(i, 'import "both/inside"; fromFolder') !== "2") throw new Error("inside the folder");
    });
    Deno.test(`a module's own imports resolve next to it (checked=${checked})`, () => {
        if (result(interpreter(checked), 'import "uses-hello"; exported') !== '"hi pkg"') throw new Error("relative import");
        // A local module shadows a standard one of the same name.
        if (result(interpreter(checked), 'import "local-text/user"; result') !== '"shadowed"') throw new Error("shadowing");
    });
    Deno.test(`standard modules take no prefix and there is no std module (checked=${checked})`, () => {
        if (result(interpreter(checked), 'import "option"; Some 1') !== "Some 1") throw new Error("bare name");
        for (const [source, hint] of [['import "std/option"', 'import "option"'], ['import "std"', "standard modules you need"], ['import "nope"', "no nope.apn or nope/"]]) {
            try { result(interpreter(checked), source); } catch (error) {
                const e = error as { message: string; hint?: string };
                if (!e.message.startsWith("unknown module") || !e.hint?.includes(hint)) throw new Error(`${source}: ${e.message} (${e.hint})`);
                continue;
            }
            throw new Error(`accepted: ${source}`);
        }
    });
    Deno.test(`a name defined by two files of a folder is an error (checked=${checked})`, () => {
        try { result(interpreter(checked), 'import "clash"'); } catch (error) {
            if (!String((error as Error).message).includes("twice")) throw error;
            return;
        }
        throw new Error("accepted a clash");
    });
}
