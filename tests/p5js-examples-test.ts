// The p5.js examples in APN (examples/p5js), as apn --site builds them: each
// checks, links its original, and is on the index; and a few run here, with
// a recording p5 instance or a fake browser platform.
import { Interpreter } from "../src/interp.ts";
import { parse } from "../main.ts";
import { BrowserApp, type HtmlNode, type Platform } from "../src/html.ts";
import { P5Sketch, type P5Instance } from "../src/p5.ts";
import { BUNDLE_APP, bundleProgram } from "../src/modules.ts";

const folder = new URL("../examples/p5js/", import.meta.url);
const read = (name: string) => Deno.readTextFileSync(new URL(`${name}.apn`, folder));
const examples = [...Deno.readDirSync(folder)].filter(e => e.name.endsWith(".apn") && e.name !== "index.apn")
    .map(e => e.name.slice(0, -".apn".length)).sort();

// A program as the page runs it: from its bundle, with its data files.
function load(name: string, extra = ""): Interpreter {
    const source = read(name) + extra;
    const i = new Interpreter();
    i.moduleSources = bundleProgram(source, folder.pathname);
    i.sourceDir = BUNDLE_APP;
    i.enableChecking();
    i.run(parse(source, `${name}.apn`));
    return i;
}
const value = (i: Interpreter, name: string) => i.renderString(i.env.get(name)!);
// A p5 instance recording each call, with a canvas's properties.
function recorder(calls: unknown[][]): P5Instance {
    const properties: Record<string, unknown> = { width: 710, height: 400, mouseX: 0, mouseY: 0, frameCount: 1 };
    return new Proxy(properties, {
        get: (target, name: string) => name in target ? target[name]
            : (...args: unknown[]) => { calls.push([name, ...args]); return name === "createCanvas" ? undefined : 0; },
    }) as P5Instance;
}
const content = (n: HtmlNode): string => "text" in n ? n.text : "sketch" in n ? "" : n.children.map(content).join("|");

Deno.test("every p5.js example checks, with the data files it names bundled", () => {
    if (examples.length !== 65) throw new Error(`${examples.length} examples`);
    for (const name of examples) {
        const source = read(name), interpreter = new Interpreter();
        interpreter.moduleSources = bundleProgram(source, folder.pathname);
        interpreter.checkingSession().prepare(parse(source, `${name}.apn`), BUNDLE_APP);
    }
    const words = bundleProgram(read("words"), folder.pathname);
    if (!words[`${BUNDLE_APP}assets/SourceSansPro-Regular.otf`]?.startsWith("data:font/otf;base64,")) throw new Error("font not bundled");
});
Deno.test("each p5.js example names the one it recreates, and what it does", () => {
    const leading = /^# [^\n]+, from( https:\/\/p5js\.org\/examples\/[a-z0-9-]+\/|\n# https:\/\/p5js\.org\/examples\/[a-z0-9-]+\/)\n# \S[^\n]*\n/;
    for (const name of examples) if (!leading.test(read(name))) throw new Error(`${name}: ${read(name).split("\n").slice(0, 3).join(" / ")}`);
});
Deno.test("the p5.js index links every example to the editor", () => {
    const links: string[] = [];
    const walk = (n: HtmlNode) => { if ("tag" in n) { if (n.tag === "a") links.push(String(n.attributes.href)); n.children.forEach(walk); } };
    const i = load("index");
    walk(new BrowserApp(i, i.env.get("main")!).render());
    const linked = links.filter(l => l.startsWith("editor.html#")).map(l => l.slice("editor.html#".length)).sort();
    if (JSON.stringify(linked) !== JSON.stringify(examples)) throw new Error(linked.join());
});
Deno.test("a recursive sketch draws its tree", () => {
    const i = load("recursive-tree"), calls: unknown[][] = [];
    const sketch = new P5Sketch(i, i.env.get("main")!, recorder(calls));
    sketch.dispatch("setup");
    sketch.dispatch("draw");
    if (calls.filter(c => c[0] === "line").length < 100) throw new Error(`${calls.filter(c => c[0] === "line").length} lines`);
});
Deno.test("Game of Life counts neighbors with shifted boards", () => {
    const i = load("game-of-life", "\nblinker = generate [\n" + ["00000", "00100", "00100", "00100", "00000"]
        .map(row => `    [${[...row].join(",")}]`).join("\n") + "\n]\n");
    if (value(i, "blinker") !== "[[0,0,0,0,0],[0,0,0,0,0],[0,1,1,1,0],[0,0,0,0,0],[0,0,0,0,0]]") throw new Error(value(i, "blinker"));
});
Deno.test("Mandelbrot escapes count iterations", () => {
    const i = load("mandelbrot-set", "\ncounts = [escape 0.0 0.0, escape -0.75 0.1, escape 1.0 1.0]\n");
    if (value(i, "counts") !== "[100,34,3]") throw new Error(value(i, "counts"));
});
Deno.test("a p5.strands shader's hook is written as GLSL", () => {
    const i = load("filter-shader-p5-strands", '\ncode = glsl (displace [texCoord = MkGlsl "uv", canvasContent = MkGlsl "tex"])\n');
    const zoom = (n: string) => `TEXTURE(tex, (((uv - 0.5) / ${n}) + 0.5))`;
    const expected = `"vec4(TEXTURE(tex, uv).r, ${zoom("1.05")}.g, ${zoom("1.1")}.b, TEXTURE(tex, uv).a)"`;
    if (value(i, "code") !== expected) throw new Error(value(i, "code"));
});
Deno.test("JSON and Table load bundled data, and download what they hold", async () => {
    for (const [name, file, held] of [["json", "bubbles.json", '"name":"A"'], ["table", "bubbles.csv", "160.0,103.0,20.0,A"]]) {
        const queue: (() => void)[] = [], downloads: string[][] = [];
        const platform: Platform = {
            defer: run => queue.push(run), http: () => Promise.resolve({ status: 0, body: "" }), selectFiles: () => Promise.resolve([]),
            download: (...file) => { downloads.push(file); }, viewport: () => ({ width: 800, height: 600 }),
        };
        const i = load(name), app = new BrowserApp(i, i.env.get("main")!, platform);
        app.render();
        await new Promise(r => setTimeout(r, 0));
        while (queue.length) queue.shift()!();
        app.dispatch(0);
        if (downloads[0]?.[0] !== file || !downloads[0][2].includes(held)) throw new Error(`${name}: ${JSON.stringify(downloads)}`);
        if (!content(app.render()).includes("Download bubble data")) throw new Error(name);
    }
});
