import type { Interpreter } from "./interp.ts";
import { type Value, mkInt, mkList, mkStr } from "./types.ts";
import { asFloat } from "./numbers.ts";
import { APNError } from "./errors.ts";

// Methods of a sketch's p and of a graphic, curried by the arity shown. One
// taking no arguments is an action field (p.noStroke, not p.noStroke []).
// p.call takes an argument list for the other overloads.
export const P5_METHODS: Record<string, number> = {
    createCanvas: 2, resizeCanvas: 2, noCanvas: 0, background: 1, clear: 0, pixelDensity: 1,
    describe: 1, describeElement: 2, textOutput: 0, noSmooth: 0,
    fill: 1, noFill: 0, stroke: 1, noStroke: 0, strokeWeight: 1, strokeCap: 1, strokeJoin: 1,
    circle: 3, ellipse: 4, rect: 4, square: 3, line: 4, point: 2,
    triangle: 6, quad: 8, arc: 6, bezier: 8,
    beginShape: 0, vertex: 2, splineVertex: 2, splineProperty: 2, endShape: 0,
    push: 0, pop: 0, translate: 2, rotate: 1, scale: 1, rotateX: 1, rotateY: 1, rotateZ: 1,
    text: 3, textSize: 1, textAlign: 1, textFont: 1, textStyle: 1, textWidth: 1,
    rectMode: 1, ellipseMode: 1, angleMode: 1, colorMode: 1, imageMode: 1,
    color: 1, lerpColor: 3, red: 1, green: 1, blue: 1, alpha: 1, hue: 1, saturation: 1, brightness: 1,
    frameRate: 1, noLoop: 0, loop: 0, redraw: 0, isLooping: 0,
    random: 2, randomGaussian: 0, randomSeed: 1, noise: 1, noiseSeed: 1,
    millis: 0, second: 0, minute: 0, hour: 0, day: 0, month: 0, year: 0,
    cursor: 1, noCursor: 0, keyIsDown: 1,
    // Images, pixels and filters. An image is an object (p5.loadImage,
    // p5.createGraphics, p5.createVideo, a framebuffer's color) or a URL.
    image: 3, tint: 1, noTint: 0, copy: 9, get: 2, set: 3, loadPixels: 0, updatePixels: 0, filter: 1,
    // WEBGL: shapes, models, camera, lights, materials and shaders.
    box: 3, plane: 2, sphere: 1, torus: 2, cylinder: 2, cone: 2, ellipsoid: 3, model: 1,
    camera: 9, perspective: 4, ortho: 6, orbitControl: 0, lights: 0,
    ambientLight: 1, directionalLight: 4, pointLight: 4, spotLight: 10,
    normalMaterial: 0, ambientMaterial: 1, specularMaterial: 1, emissiveMaterial: 1, shininess: 1,
    texture: 1, textureMode: 1, textureWrap: 1, shader: 1, resetShader: 0,
    // Storage (nothing kept where the page may not use it) and downloads.
    getItem: 1, storeItem: 2, saveJSON: 2, saveStrings: 3,
};
// Methods of the objects p5's functions make (p5.loadImage, p5.createVideo,
// p5.createShader, ...), by the same rules.
export const OBJECT_METHODS: Record<string, number> = {
    loadPixels: 0, updatePixels: 0, get: 2, set: 3, mask: 1, resize: 2, copy: 9, filter: 1,
    play: 0, pause: 0, stop: 0, loop: 0, noLoop: 0, hide: 0, show: 0, volume: 1, speed: 1,
    size: 2, showControls: 0, attribute: 2, time: 0,
    setUniform: 2, begin: 0, end: 0, normalize: 0,
};
// An object's properties, read when used (an action): a video's size is
// known once it loads; a framebuffer's color and depth are images.
const OBJECT_PROPERTIES = ["width", "height", "color", "depth", "duration"];
// The p5 functions that make objects; modify makes one from another object.
export const P5_OBJECTS = ["loadImage", "loadFont", "loadModel", "createImage", "createGraphics", "createVideo", "createAudio",
    "createCapture", "createShader", "createFilterShader", "createFramebuffer", "buildGeometry",
    "baseFilterShader", "baseColorShader", "baseMaterialShader", "baseNormalShader", "modify"];
// The methods that yield a value; the others yield [] (an action's empty result).
const RESULTS = new Set(["random", "randomGaussian", "noise", "millis", "second", "minute", "hour", "day", "month", "year",
    "isLooping", "color", "lerpColor", "red", "green", "blue", "alpha", "hue", "saturation", "brightness", "textWidth",
    "get", "getItem", "keyIsDown", "time", "call", "prompt"]);
// The binding's own methods, which p5 does not have.
const BINDING_METHODS: Record<string, number> = { prompt: 1 };
export const P5_EVENTS = ["setup", "draw", "mousePressed", "mouseReleased", "mouseClicked", "mouseMoved", "mouseDragged",
    "doubleClicked", "mouseWheel", "keyPressed", "keyReleased", "keyTyped", "windowResized", "touchStarted", "touchMoved", "touchEnded",
    "deviceMoved", "deviceTurned", "deviceShaken"];
// A sketch's properties, by type (a constant's value varies, so it is Dynamic).
const NUMBER_PROPERTIES = ["width", "height", "windowWidth", "windowHeight", "displayWidth", "displayHeight",
    "mouseX", "mouseY", "pmouseX", "pmouseY", "keyCode", "frameCount", "deltaTime",
    "accelerationX", "accelerationY", "accelerationZ", "pAccelerationX", "pAccelerationY", "pAccelerationZ",
    "rotationX", "rotationY", "rotationZ", "PI", "TWO_PI", "HALF_PI", "QUARTER_PI"];
const BOOL_PROPERTIES = ["mouseIsPressed", "keyIsPressed"], STRING_PROPERTIES = ["key", "code"];
const properties = [...NUMBER_PROPERTIES, ...BOOL_PROPERTIES, ...STRING_PROPERTIES, "mouseButton",
    "CENTER", "CORNER", "CORNERS", "RADIUS", "LEFT", "RIGHT", "TOP", "BOTTOM", "BASELINE",
    "CLOSE", "CHORD", "PIE", "OPEN", "RGB", "HSB", "HSL", "DEGREES", "RADIANS", "P2D", "WEBGL",
    "POINTS", "LINES", "TRIANGLES", "TRIANGLE_STRIP", "TRIANGLE_FAN", "QUADS", "QUAD_STRIP",
    "NORMAL", "IMAGE", "REPEAT", "CLAMP", "MIRROR", "ROUND", "SQUARE", "PROJECT", "BOLD", "ITALIC",
    "GRAY", "INVERT", "THRESHOLD", "BLUR", "POSTERIZE", "OPAQUE", "ERODE", "DILATE", "COVER", "CONTAIN", "VIDEO", "AUDIO",
    "UP_ARROW", "DOWN_ARROW", "LEFT_ARROW", "RIGHT_ARROW", "ENTER", "RETURN", "ESCAPE", "BACKSPACE", "DELETE", "SHIFT",
    "CONTROL", "OPTION", "ALT", "TAB", "ARROW", "CROSS", "HAND", "MOVE", "TEXT", "WAIT"];
// The fields of a callback's p (p5's Sketch) and of an object (p5Object), by
// kind: a method (its arity: it takes Dynamic arguments, as p5's take many
// kinds, a color being a number, a string or a list; and whether it yields a
// value or []), or a property's type name (an object's properties are actions).
export type P5Field = { arity: number; result: boolean } | "Number" | "Bool" | "String" | "Dynamic" | "action";
const methodField = (name: string, arity: number): P5Field => ({ arity, result: RESULTS.has(name) });
export function sketchFields(): Array<[string, P5Field]> {
    const type = (property: string): P5Field => NUMBER_PROPERTIES.includes(property) ? "Number"
        : BOOL_PROPERTIES.includes(property) ? "Bool" : STRING_PROPERTIES.includes(property) ? "String" : "Dynamic";
    return [...Object.entries({ ...P5_METHODS, ...BINDING_METHODS, call: 2, send: 1 }).map(([name, arity]): [string, P5Field] => [name, methodField(name, arity)]),
        ...properties.map((property): [string, P5Field] => [property, type(property)])];
}
const OBJECT_FIELDS = [...new Set([...Object.keys(P5_METHODS), ...Object.keys(OBJECT_METHODS), "call", ...OBJECT_PROPERTIES])];
export function objectFields(): Array<[string, P5Field]> {
    return OBJECT_FIELDS.map(name => [name, OBJECT_PROPERTIES.includes(name) ? "action" : methodField(name, name === "call" ? 2 : P5_METHODS[name] ?? OBJECT_METHODS[name])]);
}
// The Sketch type at runtime: its properties checked, its methods Dynamic.
export function p5SketchType(): Value {
    return { kind: "record", v: sketchFields().map(([name, field]): [string, Value] => [name, { kind: "type", name: typeof field === "string" ? field : "Dynamic" }]) };
}
// Functions whose string arguments may name a file the build bundled.
const ASSET_FUNCTIONS = new Set(["loadImage", "loadFont", "loadModel", "createVideo", "createAudio", "cursor", "image", "texture"]);
export type P5Instance = Record<string, unknown>;
const fail = (message: string): never => { throw new APNError("runtime", `p5: ${message}`); };
const nothing: Value = { kind: "list", v: [] };
const callable = (v: Value) => v.kind === "closure" || v.kind === "native" || v.kind === "clauseFn" || v.kind === "contract";
const isPlain = (value: object) => Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;

// An object's fields (OBJECT_FIELDS): its methods, call, and its properties as actions.
function objectRecordFields(on: (name: string, args: Value[]) => Value, call: (args: Value[]) => Value, property: (name: string) => Value): Array<[string, Value]> {
    const arity = (name: string) => P5_METHODS[name] ?? OBJECT_METHODS[name];
    return OBJECT_FIELDS.map((name): [string, Value] => OBJECT_PROPERTIES.includes(name) ? [name, method(name, 0, () => property(name))]
        : name === "call" ? [name, method(name, 2, call)] : [name, method(name, arity(name), args => on(name, args))]);
}
// A host function as a record field: a curried native, or an action when it takes nothing.
function method(name: string, arity: number, run: (args: Value[]) => Value): Value {
    if (arity === 0) return { kind: "io", run: () => run([]) };
    return { kind: "native", name: `p5.${name}`, arity, applied: [], invoke: args => ({ kind: "io", run: () => run(args) }) };
}

// An object a sketch uses (an image, a video, a shader): a description of
// how p5 makes it, a function and its arguments. Each sketch makes (or loads)
// it the first time it uses it, then keeps it; its methods act on the running
// sketch's. Every object has every method (a graphic's are a sketch's), so
// all have one type; one its object lacks fails when called.
interface Description { make: string; args: Value[] }
const descriptions = new WeakMap<Value, Description>();
let running: P5Sketch | undefined;
const active = (): P5Sketch => running ?? fail("p5 objects work inside a running sketch");
export function p5Object(make: string, args: Value[]): Value {
    if (!P5_OBJECTS.includes(make)) return fail(`unknown object maker '${make}'`);
    const record: Value = { kind: "record", v: objectRecordFields(
        (name, values) => active().on(record, name, values), values => active().callOn(record, values[0], values[1]),
        property => active().property(record, property)), shared: true };
    descriptions.set(record, { make, args });
    return record;
}

// A sketch: a program (p5.sketch) or a canvas in a view, whose callbacks the
// view replaces at each render. send, when given, takes p.send's messages.
export class P5Sketch {
    private callbacks = new Map<string, Value>();
    private preload: Value[] = [];
    // The objects the sketch has made, by description; a load is pending until done.
    private objects = new Map<Description, { value?: unknown; pending?: Promise<unknown>; error?: unknown }>();
    // Other p5 objects APN holds (a framebuffer's color), as records.
    private handles = new WeakMap<object, Value>();
    private handled = new WeakMap<Value, unknown>();
    private methods = new WeakMap<object, Array<[string, Value]>>();
    // Images by URL (undefined while loading, null when they failed).
    private images = new Map<string, unknown>();
    constructor(private i: Interpreter, program: Value, private p: P5Instance, private send?: (message: Value) => void) {
        const v = i.demand(program);
        this.setCallbacks(v.kind === "variant" && v.tag === "P5Sketch" ? v.v[0] : v);
    }
    setCallbacks(callbacks: Value): void {
        const fields = this.i.demand(callbacks);
        if (fields.kind !== "record") fail("a sketch expects a callback record");
        this.callbacks = new Map((fields as Extract<Value, { kind: "record" }>).v);
        // preload: the objects to load before setup.
        const preload = this.callbacks.get("preload");
        this.callbacks.delete("preload");
        if (preload) this.preload = this.i.items(preload);
        for (const name of this.callbacks.keys()) if (!P5_EVENTS.includes(name)) fail(`unknown callback '${name}'`);
    }
    // A view's newest callbacks: a canvas that is not looping (noLoop) draws
    // once with them, so it shows the newest model.
    update(callbacks: Value): void {
        this.setCallbacks(callbacks);
        if (typeof this.p.isLooping === "function" && !this.p.isLooping()) this.apply(this.p, "redraw", []);
    }
    // The objects preload names, loaded (setup waits for this).
    async loaded(): Promise<void> {
        const loads = this.preload.map(object => this.within(() => this.start(this.i.dataValue(object))));
        await Promise.allSettled(loads.map(state => state.pending));
    }
    private within<T>(run: () => T): T {
        const outer = running;
        running = this;
        try { return run(); } finally { running = outer; }
    }

    // A description's object, made (or its load started) the first time.
    private start(record: Value) {
        const description = descriptions.get(record) ?? fail("preload lists p5 objects (p5.loadImage path, ...)");
        let state = this.objects.get(description);
        if (state) return state;
        state = {};
        this.objects.set(description, state);
        const values = description.args.map(arg => this.toJS(arg));
        const made = description.make === "modify"
            ? this.apply(values[0] as P5Instance, "modify", [values[1]])
            : this.apply(this.p, description.make, ASSET_FUNCTIONS.has(description.make) ? values.map(x => this.asset(x)) : values);
        if (made && typeof (made as Promise<unknown>).then === "function") {
            const loading = state;
            loading.pending = (made as Promise<unknown>).then(value => { loading.value = value; }, error => { loading.error = error; })
                .finally(() => { loading.pending = undefined; });
        } else state.value = made;
        return state;
    }
    private object(record: Value): unknown {
        const state = this.start(record), description = descriptions.get(record)!;
        const first = description.args[0] && this.i.dataValue(description.args[0]);
        const label = first?.kind === "string" ? first.v : description.make;
        if (state.pending) return fail(`${label} has not loaded yet; list it in the sketch's preload`);
        if (state.error !== undefined) return fail(`could not load ${label}`);
        return state.value;
    }
    on(record: Value, name: string, args: Value[]): Value {
        return this.invoke(this.object(record) as P5Instance, name, args);
    }
    callOn(record: Value, name: Value, args: Value): Value {
        return this.invoke(this.object(record) as P5Instance, this.methodName(name), this.i.items(args), true);
    }
    property(record: Value, name: string): Value {
        return this.fromJS((this.object(record) as P5Instance)[name]);
    }
    private methodName(name: Value): string {
        const v = this.i.demand(name);
        return v.kind === "string" ? v.v : fail("call expects a method name string");
    }

    private toJS(value: Value): unknown {
        const i = this.i;
        const v = i.dataValue(value);
        if (descriptions.has(v)) return this.object(v);
        if (this.handled.has(v)) return this.handled.get(v);
        if (v.kind === "string" || v.kind === "char" || v.kind === "bool") return v.v;
        if (v.kind === "int") {
            const n = Number(v.v);
            if (!Number.isSafeInteger(n)) return fail("integer exceeds JavaScript's safe range; use inexact explicitly");
            return n;
        }
        if (v.kind === "float" || v.kind === "rational") return asFloat(v);
        if (i.isList(v)) return i.items(v).map(x => this.toJS(x));
        if (v.kind === "record") return Object.fromEntries(v.v.map(([key, x]) => [key, this.toJS(x)]));
        // A HashMap (keys a program computes) is an object too.
        if (v.kind === "hashmap") return Object.fromEntries([...v.entries.values()].map(([key, x]) => [String(this.toJS(key)), this.toJS(x)]));
        // A function p5 calls back: given p5's arguments, or the sketch's p
        // when it has none (buildGeometry's draws with it).
        if (callable(v)) return (...args: unknown[]) => this.within(() => {
            const result = i.runIO((args.length ? args.map(a => this.fromJS(a)) : [this.record(this.p)]).reduce((f, a) => i.apply(f, a), v));
            return this.toJS(i.demand(result));
        });
        return fail("arguments must be numbers, strings, booleans, lists, records, HashMaps, functions or p5 objects");
    }
    private fromJS(value: unknown): Value {
        if (typeof value === "number") return Number.isSafeInteger(value) ? mkInt(value) : { kind: "float", v: value };
        if (typeof value === "string") return mkStr(value);
        if (typeof value === "boolean") return { kind: "bool", v: value };
        if (value === null || value === undefined || typeof value !== "object") return nothing;
        if (Array.isArray(value)) return mkList(value.map(x => this.fromJS(x)));
        if (isPlain(value)) return { kind: "record", v: Object.entries(value).map(([key, x]) => [key, this.fromJS(x)]) };
        // Another p5 object (a color, a framebuffer's texture): passed back as itself.
        let record = this.handles.get(value);
        if (!record) {
            const target = value as P5Instance;
            record = { kind: "record", v: objectRecordFields((name, args) => this.invoke(target, name, args),
                ([name, args]) => this.invoke(target, this.methodName(name), this.i.items(args), true), name => this.fromJS(target[name])) };
            this.handles.set(value, record);
            this.handled.set(record, value);
        }
        return record;
    }
    private record(target: P5Instance): Value {
        let methods = this.methods.get(target);
        if (!methods) {
            methods = Object.entries(P5_METHODS).map(([name, arity]) => [name, method(name, arity, args => this.invoke(target, name, args))]);
            for (const [name, arity] of Object.entries(BINDING_METHODS)) methods.push([name, method(name, arity, args => this.binding(name, args))]);
            methods.push(["call", method("call", 2, ([name, args]) => this.invoke(target, this.methodName(name), this.i.items(args), true))]);
            methods.push(["send", method("send", 1, ([message]) => {
                if (!this.send) return fail("send needs a canvas inside a browser program (p5.canvas)");
                this.send(message);
                return nothing;
            })]);
            this.methods.set(target, methods);
        }
        // Properties are read when a callback first uses them (so after its
        // createCanvas); input is the canvas's, sizes the target's own.
        // A typed property p5 has not set yet reads as 0 or "".
        const read = (property: string): Value => ({ kind: "deferred", compute: () => {
            const value = (property === "width" || property === "height" ? target : this.p)[property];
            if (value === undefined || value === null) return NUMBER_PROPERTIES.includes(property) ? mkInt(0) : STRING_PROPERTIES.includes(property) ? mkStr("") : BOOL_PROPERTIES.includes(property) ? { kind: "bool", v: false } : nothing;
            return this.fromJS(value);
        } });
        return { kind: "record", v: [...methods, ...properties.map((property): [string, Value] => [property, read(property)])] };
    }
    private binding(name: string, args: Value[]): Value {
        // prompt asks the user for text: "" when they cancel.
        if (name === "prompt") return mkStr((globalThis as unknown as { prompt?: (message: string) => string | null }).prompt?.(String(this.toJS(args[0]))) ?? "");
        return fail(`unsupported method '${name}'`);
    }
    // A file the build bundled, by the path the program names, as a URL.
    private asset(value: unknown): unknown {
        if (typeof value === "string") return this.i.assetUrl?.(value) ?? value;
        return Array.isArray(value) ? value.map(x => this.asset(x)) : value;
    }
    // An image given by URL: loaded once, drawn from the frame it has loaded.
    private source(url: string): unknown {
        if (!this.images.has(url)) {
            this.images.set(url, undefined);
            Promise.resolve(this.apply(this.p, "loadImage", [url])).then(image => this.images.set(url, image), () => this.images.set(url, null));
        }
        return this.images.get(url) ?? undefined;
    }
    private apply(target: P5Instance, name: string, values: unknown[]): unknown {
        const method = target?.[name];
        if (typeof method !== "function") return fail(`method '${name}' is unavailable`);
        return method.apply(target, values);
    }
    // A method's result, when it has one (call, for any overload, always yields p5's).
    private invoke(target: P5Instance, name: string, args: Value[], call = false): Value {
        if (!Object.hasOwn(P5_METHODS, name) && !Object.hasOwn(OBJECT_METHODS, name)) return fail(`unsupported method '${name}'`);
        return this.within(() => {
            let values = args.map(arg => this.toJS(arg));
            if (ASSET_FUNCTIONS.has(name)) values = values.map(x => this.asset(x));
            if ((name === "image" || name === "texture") && typeof values[0] === "string") {
                const source = this.source(values[0]);
                if (!source) return nothing; // Not loaded yet: drawn once it is.
                values[0] = source;
            }
            try {
                const result = this.apply(target, name, values);
                return call || RESULTS.has(name) ? this.fromJS(result) : nothing;
            } catch (error) {
                // Storage a sandboxed page may not use: nothing kept, nothing read.
                if (name === "getItem" || name === "storeItem") return nothing;
                throw error;
            }
        });
    }
    has(name: string): boolean { return this.callbacks.has(name); }
    dispatch(name: string): Value {
        const callback = this.callbacks.get(name);
        if (!callback) return nothing;
        return this.within(() => this.i.demand(this.i.runIO(this.i.apply(callback, this.record(this.p)))));
    }
}
