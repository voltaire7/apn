import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";
import { P5Sketch, type P5Instance } from "../src/p5.ts";

Deno.test("p5 example dispatches setup, animation, and mutable click events", () => {
    const i = new Interpreter();
    i.run(parse(Deno.readTextFileSync(new URL("../examples/browser/p5-sketch.apn", import.meta.url))));
    const calls: unknown[][] = [];
    const p: P5Instance = { frameCount: 0 };
    for (const name of ["createCanvas", "describe", "noStroke", "background", "fill", "circle", "textSize", "text"]) {
        p[name] = function (this: unknown, ...args: unknown[]) {
            if (this !== p) throw new Error("p5 receiver lost");
            calls.push([name, ...args]);
        };
    }
    const sketch = new P5Sketch(i, i.env.get("main")!, p);
    sketch.dispatch("setup");
    sketch.dispatch("draw");
    if (!calls.some(c => JSON.stringify(c) === '["circle",320,180,60]')) throw new Error("first frame");
    if (!calls.some(c => JSON.stringify(c) === '["noStroke"]')) throw new Error("unit argument leaked to p5");
    if (i.renderString(sketch.dispatch("mousePressed")) !== 'False') throw new Error("event return value");
    p.frameCount = 40;
    sketch.dispatch("draw");
    const circles = calls.filter(c => c[0] === 'circle');
    if (circles[1][3] !== 70 || circles[1][1] === 320) throw new Error("frame state or mutable state stale");
});
Deno.test("p5 call supports overload arguments and rejects unsafe integer conversion", () => {
    const i = new Interpreter();
    i.run(parse('p5 = import "p5"\nmain = p5.sketch [\n    setup = p -> p.call "fill" [255,0,0]\n    draw = p -> p.circle 9007199254740993 0 10\n]'));
    let args: unknown[] = [];
    const sketch = new P5Sketch(i, i.env.get('main')!, { fill: (...a: unknown[]) => { args = a; }, circle: () => {} });
    sketch.dispatch('setup');
    if (JSON.stringify(args) !== '[255,0,0]') throw new Error('overload args');
    try { sketch.dispatch('draw'); } catch (error) {
        if (String(error).includes('safe range')) return;
        throw error;
    }
    throw new Error('lossy integer accepted');
});
Deno.test("p5 objects are made once per sketch, and preload waits for them", async () => {
    const i = new Interpreter();
    i.run(parse('import "p5"\nimg = loadImage "a.png"\nmain = sketch [preload = [img], setup = (p : Sketch) -> p.image img 1 2]'));
    let loads = 0, drawn: unknown;
    const image = { width: 5 };
    const sketch = new P5Sketch(i, i.env.get("main")!, {
        loadImage: () => { loads++; return Promise.resolve(image); },
        image: (x: unknown) => { drawn = x; },
    });
    await sketch.loaded();
    sketch.dispatch("setup");
    sketch.dispatch("setup");
    if (loads !== 1 || drawn !== image) throw new Error(`${loads} loads`);
});
Deno.test("p5 call yields p5's result; a callback without arguments gets the sketch's p", () => {
    const i = new Interpreter();
    i.run(parse('import "p5"\nshape = buildGeometry ((p : Sketch) -> p.sphere 3)\nmain = sketch [setup = (p : Sketch) -> {\n    rate <- p.call "frameRate" []\n    p.model shape\n    p.text (to String rate) 0 0\n}]'));
    const calls: unknown[][] = [];
    const sketch = new P5Sketch(i, i.env.get("main")!, {
        frameRate: () => 60,
        buildGeometry: (draw: () => unknown) => { draw(); return "geometry"; },
        sphere: (r: unknown) => { calls.push(["sphere", r]); },
        model: (m: unknown) => { calls.push(["model", m]); },
        text: (t: unknown) => { calls.push(["text", t]); },
    });
    sketch.dispatch("setup");
    if (JSON.stringify(calls) !== '[["sphere",3],["model","geometry"],["text","60"]]') throw new Error(JSON.stringify(calls));
});
Deno.test("p5 takes a HashMap (keys a program computes) as an object", () => {
    const i = new Interpreter();
    i.run(parse('import "p5"\nmain = sketch [setup = (p : Sketch) -> p.call "fill" [HashMap [["a b",1]]]]'));
    let given: unknown;
    new P5Sketch(i, i.env.get("main")!, { fill: (x: unknown) => { given = x; } }).dispatch("setup");
    if (JSON.stringify(given) !== '{"a b":1}') throw new Error(JSON.stringify(given));
});
