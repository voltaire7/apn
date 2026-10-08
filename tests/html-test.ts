import { bundleProgram } from "../src/modules.ts";
import { Interpreter } from "../src/interp.ts";
import { parse } from "../main.ts";
import { BrowserSandbox, type HtmlNode } from "../src/html.ts";

function app(source: string): BrowserSandbox {
    const i = new Interpreter();
    i.run(parse(source));
    return new BrowserSandbox(i, i.env.get("main")!);
}
function content(node: HtmlNode): string {
    return "text" in node ? node.text : node.children.map(content).join("");
}
Deno.test("browser counter uses comma-free nested HTML and distinct nullary messages", () => {
    const counter = app(Deno.readTextFileSync(new URL("../examples/browser/counter.apn", import.meta.url)));
    if (content(counter.render()) !== '-0+') throw new Error("initial view");
    if (content(counter.dispatch(1)) !== '-1+') throw new Error("increment");
    if (content(counter.dispatch(0)) !== '-0+') throw new Error("decrement");
    if (content(counter.dispatch(0)) !== '--1+') throw new Error("negative model");
});
Deno.test("input messages carry strings and boolean attributes update", () => {
    const greeting = app(Deno.readTextFileSync(new URL("../examples/browser/greeting.apn", import.meta.url)));
    const initial = greeting.render();
    if (!("tag" in initial) || !("tag" in initial.children[3]) || initial.children[3].attributes.disabled !== true) throw new Error("initial disabled state");
    const updated = greeting.dispatch(0, '<b>APN & 😀</b>');
    if (!content(updated).includes('Hello, <b>APN & 😀</b>!')) throw new Error("input value lost");
    if (!("tag" in updated) || !("tag" in updated.children[3]) || updated.children[3].attributes.disabled !== false) throw new Error("disabled did not change");
    if (!content(greeting.dispatch(1)).includes('Hello, !')) throw new Error("clear message");
});
Deno.test("event messages are lazy and failed updates leave the old model usable", () => {
    const counter = app(`import "html"
import "browser"
HtmlTestMsg = GoodEvent | BadEvent
update msg model = match msg [GoodEvent -> model + 1,BadEvent -> missing]
view model = div [] [button [onClick GoodEvent] [text (toString model)],button [onClick BadEvent] [text "bad"]]
main = sandbox [init: 0, update: update, view: view]`);
    if (content(counter.render()) !== '0bad') throw new Error("initial render");
    try { counter.dispatch(1); throw new Error("expected failure"); }
    catch (error) { if (!(error instanceof Error) || !error.message.includes("missing")) throw error; }
    if (content(counter.dispatch(0)) !== '1bad') throw new Error("update did not recover");
});
for (const [view, error] of [
    ['text 42', 'expected String'],
    ['node "script" [] [text "alert(1)"]', 'unsupported element'],
    ['div [attribute "onclick" "alert(1)"] []', 'unsupported attribute'],
    ['a [href "javascript:alert(1)"] [text "bad"]', 'unsafe URL'],
    ['input [] [text "child"]', 'cannot have children'],
    ['42', 'view must return'],
]) Deno.test(`HTML rejects invalid nodes: ${view}`, () => {
    const test = app(`import "html"\nimport "browser"\nmain = sandbox [init: 0, update: (msg model -> model), view: (model -> ${view})]`);
    try { test.render(); }
    catch (e) { if (e instanceof Error && e.message.includes(error)) return; throw e; }
    throw new Error("Expected error");
});
Deno.test("bundled modules load without filesystem access", () => {
    const i = new Interpreter();
    i.moduleSources = {
        "/lib/html.apn": Deno.readTextFileSync(new URL("../lib/html.apn", import.meta.url)),
        "/lib/browser.apn": Deno.readTextFileSync(new URL("../lib/browser.apn", import.meta.url)),
    };
    i.sourceDir = "/app/";
    i.run(parse('import "html"; import "browser"; main = sandbox [init: 1, update: (msg model -> model), view: (n -> text (toString n))]'));
    if (content(new BrowserSandbox(i, i.env.get("main")!).render()) !== '1') throw new Error("bundled app failed");
    try { i.importStandard('text'); }
    catch (error) { if (error instanceof Error && error.message.includes('not bundled')) return; throw error; }
    throw new Error("missing bundled module silently fell back to filesystem");
});
Deno.test("nullary constructor function clauses do not consume the next parameter", () => {
    const i = new Interpreter();
    const source = 'Choice = FirstChoice | SecondChoice; choose FirstChoice x = x; choose SecondChoice x = x + 1; choose SecondChoice 41';
    if (i.renderString(i.run(parse(source))) !== '42') throw new Error("nullary constructor pattern failed");
});
Deno.test("a browser build bundles the local modules a program imports", () => {
    const directory = new URL("./fixtures/packages/", import.meta.url).pathname;
    const source = 'import ["uses-hello","shapes"]\nanswer = [exported,square 3]';
    const bundle = bundleProgram(source, directory);
    const local = Object.keys(bundle).filter(path => path.startsWith("/app/")).sort();
    // The imported files and what they import, not the rest of the folder.
    if (JSON.stringify(local) !== '["/app/hello.apn","/app/shapes/cube.apn","/app/shapes/square.apn","/app/uses-hello.apn"]') throw new Error(JSON.stringify(local));
    if (!bundle["/lib/option.apn"]) throw new Error("standard library missing");
    for (const checked of [false, true]) {
        const i = new Interpreter();
        i.moduleSources = bundle;
        i.sourceDir = "/app/";
        if (checked) i.enableChecking();
        i.run(parse(source));
        if (i.renderString(i.run(parse("answer"))) !== '["hi pkg",9]') throw new Error(`checked=${checked}`);
        try { i.run(parse('import "both"')); } catch (error) {
            if (error instanceof Error && error.message.includes("not bundled")) continue;
            throw error;
        }
        throw new Error("an unbundled local module resolved");
    }
});
