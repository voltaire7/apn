// Elm's examples in APN (examples/elm), run as the browser runs them, with a
// fake platform: commands, subscriptions, SVG, p5 canvases and the playground.
import { Interpreter } from "../src/interp.ts";
import { parse } from "../main.ts";
import { BrowserApp, type HtmlNode, type Platform, type Subscription } from "../src/html.ts";
import { P5Sketch, P5_METHODS } from "../src/p5.ts";
import { BUNDLE_APP, bundleProgram } from "../src/modules.ts";

const folder = new URL("../examples/elm/", import.meta.url);
const read = (name: string) => Deno.readTextFileSync(new URL(`${name}.apn`, folder));
const content = (n: HtmlNode): string => "text" in n ? n.text : "sketch" in n ? "" : n.children.map(content).join("|");

// Commands' messages wait in queue until flushed, as the page defers them.
function fake(answers: Record<string, { status: number; body: string }> = {}) {
    const queue: (() => void)[] = [], downloads: string[][] = [];
    const platform: Platform = {
        defer: run => queue.push(run),
        http: url => Promise.resolve(answers[url] ?? { status: 0, body: "" }),
        selectFiles: () => Promise.resolve([{ name: "a.png", size: 3, mime: "image/png", url: "blob:a" }, { name: "b.png", size: 4, mime: "image/png", url: "blob:b" }]),
        download: (name, mime, content) => { downloads.push([name, mime, content]); },
        viewport: () => ({ width: 800, height: 600 }),
    };
    const flush = async () => { for (let n = 0; n < 3; n++) { await new Promise(r => setTimeout(r, 0)); while (queue.length) queue.shift()!(); } };
    return { platform, flush, downloads };
}
function run(name: string, platform?: Platform): BrowserApp {
    const i = new Interpreter();
    i.sourceDir = folder.pathname;
    i.enableChecking();
    i.run(parse(read(name), `${name}.apn`));
    const app = new BrowserApp(i, i.env.get("main")!, platform);
    app.render();
    return app;
}
const find = (subscriptions: Subscription[], kind: string, event?: string) =>
    subscriptions.find(s => s.kind === kind && (event === undefined || "event" in s && s.event === event)) ?? (() => { throw new Error(`no ${kind} subscription`); })();
function sketchIn(node: HtmlNode): unknown {
    if ("sketch" in node) return node.sketch;
    return "children" in node ? node.children.map(sketchIn).find(x => x) : undefined;
}

Deno.test("every Elm example checks, as apn --site checks it", () => {
    for (const entry of Deno.readDirSync(folder)) {
        if (!entry.name.endsWith(".apn")) continue;
        const source = Deno.readTextFileSync(new URL(entry.name, folder));
        const interpreter = new Interpreter();
        interpreter.moduleSources = bundleProgram(source, folder.pathname);
        interpreter.checkingSession().prepare(parse(source, entry.name), BUNDLE_APP);
    }
});
Deno.test("each example links the Elm example it recreates", () => {
    for (const entry of Deno.readDirSync(folder)) {
        const first = Deno.readTextFileSync(new URL(entry.name, folder)).split("\n")[0];
        if (!/^# .+, from https:\/\/elm-lang\.org\/examples(\/[a-z-]+)?$/.test(first)) throw new Error(`${entry.name}: ${first}`);
    }
});
Deno.test("the index links every example to the editor", () => {
    const page = content(run("index").render());
    for (const title of ["Hello", "Text Fields", "Drag-and-Drop", "First Person", "Mario"]) if (!page.includes(title)) throw new Error(title);
    const links: string[] = [];
    const walk = (n: HtmlNode) => { if ("tag" in n) { if (n.tag === "a") links.push(String(n.attributes.href)); n.children.forEach(walk); } };
    walk(run("index").render());
    for (const link of links.filter(l => l.startsWith("editor.html#"))) {
        try { Deno.statSync(new URL(`${link.slice("editor.html#".length)}.apn`, folder)); }
        catch { throw new Error(`${link} has no example`); }
    }
    if (links.filter(l => l.startsWith("editor.html#")).length !== 27) throw new Error(`${links.length} links`);
});
Deno.test("static views, sandboxes and SVG", () => {
    if (content(run("hello").render()) !== "Hello!") throw new Error("hello");
    const shapes = run("shapes").render();
    if (!("tag" in shapes) || shapes.tag !== "svg" || shapes.attributes.viewBox !== "0 0 400 400") throw new Error("SVG keeps attribute case");
    const fields = run("text-fields");
    if (content(fields.dispatch(0, "stressed")) !== "|desserts") throw new Error("reverse");
    const forms = run("forms");
    forms.dispatch(1, "secret");
    if (!content(forms.dispatch(2, "secrets")).includes("Passwords do not match!")) throw new Error("mismatch");
    if (!content(forms.dispatch(2, "secret")).includes("OK")) throw new Error("match");
});
Deno.test("random commands send fresh values", async () => {
    const { platform, flush } = fake();
    const numbers = run("numbers", platform), seen = new Set<string>();
    for (let n = 0; n < 30; n++) { numbers.dispatch(0); await flush(); seen.add(content(numbers.render()).split("|")[0]); }
    if ([...seen].some(face => !["1", "2", "3", "4", "5", "6"].includes(face)) || seen.size < 3) throw new Error([...seen].join());
    const cards = run("cards", platform);
    cards.dispatch(0); await flush();
    if (!/^Draw\|[\u{1F0A1}-\u{1F0AE}]$/u.test(content(cards.render()))) throw new Error(content(cards.render()));
});
Deno.test("HTTP commands decode answers or report failure", async () => {
    const quote = JSON.stringify({ quote: "Q", source: "S", author: "A", year: 1999 });
    const { platform, flush } = fake({ "https://elm-lang.org/assets/public-opinion.txt": { status: 200, body: "Once" }, "https://elm-lang.org/api/random-quotes": { status: 200, body: quote } });
    const book = run("book", platform);
    if (content(book.render()) !== "Loading...") throw new Error("loading");
    await flush();
    if (content(book.render()) !== "Once") throw new Error(content(book.render()));
    const quotes = run("quotes", platform);
    await flush();
    if (!content(quotes.render()).includes("Q|— |S| by A (1999)")) throw new Error(content(quotes.render()));
    // A body the decoder rejects is a failure.
    const broken = fake({ "https://elm-lang.org/api/random-quotes": { status: 200, body: '{"quote": 1}' } });
    const bad = run("quotes", broken.platform);
    await broken.flush();
    if (!content(bad.render()).includes("could not load")) throw new Error(content(bad.render()));
});
Deno.test("tasks and time subscriptions", async () => {
    const { platform, flush } = fake();
    const clock = run("local-time", platform);
    await flush();
    const every = find(clock.subscriptions(), "every");
    if (every.kind !== "every" || every.ms !== 1000) throw new Error("every 1000");
    clock.notify(every, Date.UTC(2024, 0, 1, 13, 4, 5));
    if (!/^\d+:4:5$/.test(content(clock.render()))) throw new Error(content(clock.render()));
});
Deno.test("files: pickers, drops and previews", async () => {
    const { platform, flush } = fake();
    const drop = run("drag-and-drop", platform);
    drop.dispatch(0, {});
    if (!content(drop.render()).includes("hover: true")) throw new Error("drag enter");
    drop.dispatch(3, { files: [{ name: "x.png", size: 1, mime: "image/png", url: "blob:x" }] });
    if (!content(drop.render()).includes('name: "x.png"') || content(drop.render()).includes("hover: true")) throw new Error(content(drop.render()));
    const previews = run("image-previews", platform);
    previews.dispatch(4);
    await flush();
    const urls: string[] = [];
    const walk = (n: HtmlNode) => { if ("tag" in n) { if (n.styles["background-image"]) urls.push(n.styles["background-image"]); n.children.forEach(walk); } };
    walk(previews.render());
    if (urls.join() !== "url('blob:a'),url('blob:b')") throw new Error(urls.join());
});
Deno.test("playground games read the keyboard, mouse and screen", async () => {
    const { platform, flush } = fake();
    const keyboard = run("keyboard", platform);
    await flush();
    const subscriptions = keyboard.subscriptions();
    keyboard.notify(find(subscriptions, "key", "keydown"), "ArrowRight");
    for (let n = 0; n < 3; n++) keyboard.notify(find(subscriptions, "frame"), 1000 + n);
    const svg = keyboard.render();
    if (!("tag" in svg) || svg.tag !== "svg" || svg.attributes.viewBox !== "-400 -300 800 600") throw new Error(JSON.stringify(svg).slice(0, 300));
    const placed = svg.children[0];
    if (!("tag" in placed) || placed.attributes.transform !== "translate(3,0) rotate(0) scale(1)") throw new Error(JSON.stringify(placed));
    // A held key repeats; releasing it stops the square (the update once read
    // its own new keys and never finished, so the key stayed down).
    keyboard.notify(find(subscriptions, "key", "keydown"), "ArrowRight");
    keyboard.notify(find(subscriptions, "key", "keyup"), "ArrowRight");
    for (let n = 3; n < 6; n++) keyboard.notify(find(subscriptions, "frame"), 1000 + n);
    const stopped = (keyboard.render() as { children: HtmlNode[] }).children[0];
    if (!("tag" in stopped) || stopped.attributes.transform !== "translate(3,0) rotate(0) scale(1)") throw new Error(JSON.stringify(stopped));
    const mouse = run("mouse", platform);
    await flush();
    mouse.notify(find(mouse.subscriptions(), "mouse", "mousemove"), 500, 200);
    mouse.notify(find(mouse.subscriptions(), "mouse", "mousedown"), 500, 200);
    const circle = mouse.render();
    if (!("tag" in circle) || !("tag" in circle.children[0]) || circle.children[0].attributes.transform !== "translate(100,-100) rotate(0) scale(1)" || circle.children[0].attributes.opacity !== "0.2") throw new Error(JSON.stringify(circle));
});
Deno.test("p5 canvases in views draw the model", () => {
    const calls: string[] = [];
    const p: Record<string, unknown> = { PI: Math.PI, WEBGL: "webgl", TRIANGLES: 4, width: 400, height: 400, windowWidth: 400, windowHeight: 400 };
    const graphics = () => { const g: Record<string, unknown> = { width: 256, height: 256 }; for (const m of Object.keys(P5_METHODS)) g[m] = (...args: unknown[]) => { calls.push(`g.${m}`); void args; }; return g; };
    for (const m of Object.keys(P5_METHODS)) p[m] = (...args: unknown[]) => { calls.push(`${m}${JSON.stringify(args)}`); };
    p.createGraphics = graphics;
    const cube = run("cube");
    cube.send(cube.interpreter.apply(cube.interpreter.env.get("TimeDelta")!, { kind: "int", v: 5000n }));
    const sketch = new P5Sketch(cube.interpreter, sketchIn(cube.render()) as never, p);
    sketch.dispatch("setup");
    sketch.dispatch("draw");
    if (!calls.includes('createCanvas[400,400,"webgl"]') || !calls.includes("rotateY[3]") || calls.filter(c => c.startsWith("vertex")).length !== 36) throw new Error(calls.join("\n"));
    calls.length = 0;
    const crate = run("crate");
    const crateSketch = new P5Sketch(crate.interpreter, sketchIn(crate.render()) as never, p);
    crateSketch.dispatch("setup");
    crateSketch.dispatch("draw");
    crateSketch.dispatch("draw");
    // The texture is drawn once, in setup, then used each frame.
    if (calls.filter(c => c === "g.background").length !== 1 || calls.filter(c => c.startsWith("box")).length !== 2) throw new Error(calls.join("\n"));
});
Deno.test("a frame's delta is a Float, also when the browser rounds it to whole milliseconds", () => {
    const cube = run("cube");
    const frame = find(cube.subscriptions(), "frame");
    // An exact 17 would make the angle an exact fraction that 16.7 cannot join.
    for (const delta of [17, 16, 16.7, 17]) cube.notify(frame, delta);
    cube.render();
});
