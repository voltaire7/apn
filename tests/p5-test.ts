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
    if (i.renderString(sketch.dispatch("mousePressed")) !== 'false') throw new Error("event return value");
    p.frameCount = 40;
    sketch.dispatch("draw");
    const circles = calls.filter(c => c[0] === 'circle');
    if (circles[1][3] !== 70 || circles[1][1] === 320) throw new Error("frame state or mutable state stale");
});
Deno.test("p5 call supports overload arguments and rejects unsafe integer conversion", () => {
    const i = new Interpreter();
    i.run(parse('p5 = import "p5"; main = p5.sketch [setup: (p -> p.call "fill" [255,0,0]), draw: (p -> p.circle 9007199254740993 0 10)]'));
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
