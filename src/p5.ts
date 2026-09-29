import { Interpreter } from "./interp.ts";
import { type Value, mkInt, mkStr } from "./types.ts";
import { asFloat } from "./numbers.ts";
import { APNError } from "./errors.ts";

// Curried convenience functions. p.call accepts argument lists for overloads.
export const P5_METHODS: Record<string, number> = {
    createCanvas: 2, resizeCanvas: 2, background: 1, clear: 0,
    fill: 1, noFill: 0, stroke: 1, noStroke: 0, strokeWeight: 1,
    circle: 3, ellipse: 4, rect: 4, square: 3, line: 4, point: 2,
    triangle: 6, quad: 8, arc: 6, bezier: 8,
    push: 0, pop: 0, translate: 2, rotate: 1, scale: 1,
    text: 3, textSize: 1, textAlign: 1, textFont: 1,
    rectMode: 1, ellipseMode: 1, angleMode: 1, colorMode: 1,
    beginShape: 0, vertex: 2, endShape: 0,
    frameRate: 1, noLoop: 0, loop: 0, redraw: 0,
    random: 1, randomSeed: 1, noise: 1, noiseSeed: 1, millis: 0,
    pixelDensity: 1, describe: 1,
};
export const P5_EVENTS = ["setup", "draw", "mousePressed", "mouseReleased", "mouseClicked", "mouseMoved", "mouseDragged", "doubleClicked", "keyPressed", "keyReleased", "keyTyped", "windowResized", "touchStarted", "touchMoved", "touchEnded"];
const properties = ["width", "height", "windowWidth", "windowHeight", "mouseX", "mouseY", "pmouseX", "pmouseY", "mouseIsPressed", "mouseButton", "key", "keyCode", "keyIsPressed", "frameCount", "deltaTime", "PI", "TWO_PI", "HALF_PI", "QUARTER_PI", "CENTER", "CORNER", "CORNERS", "RADIUS", "LEFT", "RIGHT", "TOP", "BOTTOM", "BASELINE", "CLOSE", "RGB", "HSB", "HSL", "DEGREES", "RADIANS", "P2D", "WEBGL"];
export type P5Instance = Record<string, unknown>;
const fail = (message: string): never => { throw new APNError("runtime", `p5: ${message}`); };
function fromJS(value: unknown): Value {
    if (typeof value === "number") return Number.isSafeInteger(value) ? mkInt(value) : { kind: "float", v: value };
    if (typeof value === "string") return mkStr(value);
    if (typeof value === "boolean") return { kind: "bool", v: value };
    return { kind: "list", v: [] }; // Renderer objects and void results are deliberately opaque.
}
function toJS(i: Interpreter, value: Value): unknown {
    const v = i.dataValue(value);
    if (v.kind === "string" || v.kind === "char" || v.kind === "bool") return v.v;
    if (v.kind === "int") {
        const n = Number(v.v);
        if (!Number.isSafeInteger(n)) return fail("integer exceeds JavaScript's safe range; use inexact explicitly");
        return n;
    }
    if (v.kind === "float" || v.kind === "rational") return asFloat(v);
    if (i.isList(v)) return i.items(v).map(x => toJS(i, x));
    return fail("arguments must be numbers, strings, booleans, or lists");
}
export class P5Sketch {
    private callbacks: Map<string, Value>;
    private id: string;
    private static nextId = 0;
    constructor(private i: Interpreter, program: Value, private p: P5Instance) {
        const v = i.demand(program);
        if (v.kind !== "variant" || v.tag !== "P5Sketch") fail("expected sketch callback record");
        const fields = i.demand((v as Extract<Value, { kind: "variant" }>).v[0]);
        if (fields.kind !== "record") fail("sketch expects a callback record");
        this.callbacks = new Map((fields as Extract<Value, { kind: "record" }>).v);
        for (const name of this.callbacks.keys()) if (!P5_EVENTS.includes(name)) fail(`unknown callback '${name}'`);
        this.id = `__p5_${P5Sketch.nextId++}_`;
        for (const method of Object.keys(P5_METHODS)) i.hostNatives.set(this.id + method, args => this.invoke(method, args));
        i.hostNatives.set(this.id + "call", args => {
            const name = i.demand(args[0]);
            if (name.kind !== "string") return fail("call expects a method name string");
            return this.invoke(name.v, i.items(args[1]));
        });
    }
    private invoke(name: string, args: Value[]): Value {
        if (!Object.hasOwn(P5_METHODS, name)) return fail(`unsupported method '${name}'`);
        const method = this.p[name];
        if (typeof method !== "function") return fail(`method '${name}' is unavailable`);
        return fromJS(method.apply(this.p, args.map(arg => toJS(this.i, arg))));
    }
    has(name: string): boolean { return this.callbacks.has(name); }
    dispatch(name: string): Value {
        const callback = this.callbacks.get(name);
        if (!callback) return { kind: "list", v: [] };
        const fields: Array<[string, Value]> = Object.entries(P5_METHODS).map(([method, arity]) => [method, {
            kind: "native", name: this.id + method, arity: Math.max(1, arity), applied: [],
        }]);
        // Zero-argument p5 methods use an explicit APN [] argument.
        for (const [method, arity] of Object.entries(P5_METHODS)) if (arity === 0) this.i.hostNatives.set(this.id + method, () => this.invoke(method, []));
        fields.push(["call", { kind: "native", name: this.id + "call", arity: 2, applied: [] }]);
        for (const property of properties) fields.push([property, fromJS(this.p[property])]);
        return this.i.demand(this.i.apply(callback, { kind: "record", v: fields }));
    }
}
