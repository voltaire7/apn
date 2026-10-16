import { Interpreter } from "./interp.ts";
import { type Value, mkInt, mkStr } from "./types.ts";
import { asFloat } from "./numbers.ts";
import { APNError } from "./errors.ts";

// Curried convenience functions. p.call accepts argument lists for overloads.
export const P5_METHODS: Record<string, number> = {
    createCanvas: 2, resizeCanvas: 2, background: 1, clear: 0,
    fill: 1, noFill: 0, stroke: 1, noStroke: 0, strokeWeight: 1, strokeCap: 1, strokeJoin: 1,
    circle: 3, ellipse: 4, rect: 4, square: 3, line: 4, point: 2,
    triangle: 6, quad: 8, arc: 6, bezier: 8,
    push: 0, pop: 0, translate: 2, rotate: 1, scale: 1, rotateX: 1, rotateY: 1, rotateZ: 1,
    text: 3, textSize: 1, textAlign: 1, textFont: 1, textStyle: 1,
    rectMode: 1, ellipseMode: 1, angleMode: 1, colorMode: 1,
    beginShape: 0, vertex: 2, endShape: 0,
    frameRate: 1, noLoop: 0, loop: 0, redraw: 0,
    random: 1, randomSeed: 1, noise: 1, noiseSeed: 1, millis: 0,
    pixelDensity: 1, describe: 1, cursor: 1, noCursor: 0, keyIsDown: 1, noSmooth: 0,
    // WEBGL: shapes, camera, lights and materials.
    box: 3, plane: 2, sphere: 1, torus: 2, cylinder: 2, cone: 2, ellipsoid: 3,
    camera: 9, perspective: 4, ortho: 6, normalMaterial: 0, ambientLight: 1, directionalLight: 4, pointLight: 4,
    ambientMaterial: 1, specularMaterial: 1, emissiveMaterial: 1, shininess: 1,
    // Images and textures by URL (loaded once, drawn once loaded) or by the
    // name of a generated graphic (see graphic).
    image: 5, imageMode: 1, tint: 1, noTint: 0, texture: 1, textureMode: 1, textureWrap: 1,
};
export const P5_EVENTS = ["setup", "draw", "mousePressed", "mouseReleased", "mouseClicked", "mouseMoved", "mouseDragged", "doubleClicked", "keyPressed", "keyReleased", "keyTyped", "windowResized", "touchStarted", "touchMoved", "touchEnded"];
const properties = ["width", "height", "windowWidth", "windowHeight", "mouseX", "mouseY", "pmouseX", "pmouseY", "mouseIsPressed", "mouseButton", "key", "keyCode", "keyIsPressed", "frameCount", "deltaTime",
    "PI", "TWO_PI", "HALF_PI", "QUARTER_PI", "CENTER", "CORNER", "CORNERS", "RADIUS", "LEFT", "RIGHT", "TOP", "BOTTOM", "BASELINE", "CLOSE",
    "RGB", "HSB", "HSL", "DEGREES", "RADIANS", "P2D", "WEBGL", "TRIANGLES", "TRIANGLE_STRIP", "TRIANGLE_FAN", "QUADS", "NORMAL", "IMAGE", "REPEAT", "CLAMP", "MIRROR", "ROUND", "SQUARE", "PROJECT", "BOLD", "ITALIC"];
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
// A sketch: a program (p5.sketch) or a canvas in a view, whose callbacks the
// view replaces at each render. send, when given, takes p.send's messages.
export class P5Sketch {
    private callbacks = new Map<string, Value>();
    private id: string;
    private static nextId = 0;
    // Images by URL (undefined while loading, null when they failed) and generated graphics by name.
    private images = new Map<string, unknown>();
    private graphics = new Map<string, P5Instance>();
    constructor(private i: Interpreter, program: Value, private p: P5Instance, private send?: (message: Value) => void) {
        const v = i.demand(program);
        this.setCallbacks(v.kind === "variant" && v.tag === "P5Sketch" ? v.v[0] : v);
        this.id = `__p5_${P5Sketch.nextId++}_`;
        this.bind(p, this.id);
    }
    setCallbacks(callbacks: Value): void {
        const fields = this.i.demand(callbacks);
        if (fields.kind !== "record") fail("a sketch expects a callback record");
        this.callbacks = new Map((fields as Extract<Value, { kind: "record" }>).v);
        for (const name of this.callbacks.keys()) if (!P5_EVENTS.includes(name)) fail(`unknown callback '${name}'`);
    }
    // The host functions drawing on target (the canvas, or a graphic).
    private bind(target: P5Instance, prefix: string): void {
        const i = this.i;
        for (const method of Object.keys(P5_METHODS)) i.hostNatives.set(prefix + method, args => this.invoke(target, method, P5_METHODS[method] === 0 ? [] : args));
        i.hostNatives.set(prefix + "call", args => {
            const name = i.demand(args[0]);
            if (name.kind !== "string") return fail("call expects a method name string");
            return this.invoke(target, name.v, i.items(args[1]));
        });
        i.hostNatives.set(prefix + "send", args => {
            if (!this.send) return fail("send needs a canvas inside a browser program (p5.canvas)");
            this.send(args[0]);
            return { kind: "list", v: [] };
        });
        i.hostNatives.set(prefix + "graphic", args => this.graphic(args));
    }
    // A graphic drawn once by an APN callback, then usable as a texture or image by name.
    private graphic(args: Value[]): Value {
        const i = this.i, name = i.dataValue(args[0]);
        if (name.kind !== "string") return fail("graphic expects a name");
        if (!this.graphics.has(name.v)) {
            const create = this.p.createGraphics;
            if (typeof create !== "function") return fail("graphics are unavailable");
            const g = create.call(this.p, toJS(i, args[1]), toJS(i, args[2])) as P5Instance;
            this.graphics.set(name.v, g);
            const prefix = `${this.id}g${this.graphics.size}_`;
            this.bind(g, prefix);
            i.runIO(i.apply(args[3], this.record(g, prefix)));
        }
        return name;
    }
    // An image or texture source: a generated graphic, or an image by URL.
    private source(name: string): unknown {
        if (this.graphics.has(name)) return this.graphics.get(name);
        if (!this.images.has(name)) {
            this.images.set(name, undefined);
            const load = this.p.loadImage;
            if (typeof load === "function") load.call(this.p, name, (image: unknown) => this.images.set(name, image), () => this.images.set(name, null));
        }
        return this.images.get(name) ?? undefined;
    }
    private invoke(target: P5Instance, name: string, args: Value[]): Value {
        if (!Object.hasOwn(P5_METHODS, name)) return fail(`unsupported method '${name}'`);
        const method = target[name];
        if (typeof method !== "function") return fail(`method '${name}' is unavailable`);
        const values = args.map(arg => toJS(this.i, arg));
        if ((name === "image" || name === "texture") && typeof values[0] === "string") {
            const source = this.source(values[0]);
            if (!source) return { kind: "list", v: [] }; // Not loaded yet: drawn once it is.
            values[0] = source;
        }
        return fromJS(method.apply(target, values));
    }
    private record(target: P5Instance, prefix: string): Value {
        const fields: Array<[string, Value]> = Object.entries(P5_METHODS).map(([method, arity]) => [method, {
            kind: "native", name: prefix + method, arity: Math.max(1, arity), applied: [],
        }]);
        fields.push(["call", { kind: "native", name: prefix + "call", arity: 2, applied: [] }]);
        fields.push(["send", { kind: "native", name: prefix + "send", arity: 1, applied: [] }]);
        fields.push(["graphic", { kind: "native", name: prefix + "graphic", arity: 4, applied: [] }]);
        // Input is the canvas's; sizes are the target's own.
        for (const property of properties) fields.push([property, fromJS((property === "width" || property === "height" ? target : this.p)[property])]);
        return { kind: "record", v: fields };
    }
    has(name: string): boolean { return this.callbacks.has(name); }
    dispatch(name: string): Value {
        const callback = this.callbacks.get(name);
        if (!callback) return { kind: "list", v: [] };
        // A callback returns the action that draws (or the new state); run it.
        return this.i.demand(this.i.runIO(this.i.apply(callback, this.record(this.p, this.id))));
    }
}
