/// <reference lib="dom" />
import { BUNDLE_APP, bundledFile } from "./modules.ts";
import { Interpreter } from "./interp.ts";
import { P5Sketch, P5_EVENTS, type P5Instance } from "./p5.ts";
import { parse } from "./parser.ts";
import { BrowserApp, type EventInfo, type HtmlNode, type Platform, type Subscription, subscriptionKey } from "./html.ts";
import type { Value } from "./types.ts";

const SVG = "http://www.w3.org/2000/svg";
const root = document.getElementById("app")!;
const errors = document.getElementById("apn-error")!;
// A view's error shows until a later render succeeds; an update's (whose
// message is lost) and a sketch's (which stops its drawing) stay.
let viewError = false;
const report = (error: unknown, fromView = false) => { errors.textContent = String(error); errors.hidden = false; viewError = fromView; };
const recovered = () => { if (viewError) errors.hidden = true; };
let app: BrowserApp;
let interpreter: Interpreter;
let current: HtmlNode | undefined;

// p5.js, loaded once, when a page first draws a sketch.
const P5_URL = "https://cdn.jsdelivr.net/npm/p5@2.3.3/lib/p5.min.js";
type P5Constructor = new (setup: (p: P5Instance) => void, root: HTMLElement) => P5Instance;
let p5Loading: Promise<P5Constructor> | undefined;
function loadP5(): Promise<P5Constructor> {
    return p5Loading ??= new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = P5_URL;
        script.onload = () => resolve((globalThis as unknown as { p5: P5Constructor }).p5);
        script.onerror = () => reject(new Error("Could not load p5.js; check your network connection"));
        document.head.appendChild(script);
    });
}
// Start a sketch in container; its callbacks may be replaced while it runs.
function startSketch(container: HTMLElement, callbacks: Value, send?: (message: Value) => void): { sketch?: P5Sketch; pending: Value } {
    const state: { sketch?: P5Sketch; pending: Value } = { pending: callbacks };
    loadP5().then(P5 => new P5(p => {
        const sketch = state.sketch = new P5Sketch(interpreter, state.pending, p, send);
        const run = (event: string) => {
            if (!sketch.has(event)) return;
            try {
                const result = sketch.dispatch(event);
                return result.kind === "bool" ? result.v : undefined;
            } catch (error) { (p.noLoop as () => void)(); report(error); }
        };
        for (const event of P5_EVENTS) if (event !== "preload") p[event] = () => run(event);
        // preload starts loads; setup runs once they have finished (p5 waits for it).
        p.setup = async () => {
            run("preload");
            await sketch.loaded();
            run("setup");
        };
    }, container), report);
    return state;
}
const sketches = new WeakMap<Node, { sketch?: P5Sketch; pending: Value }>();

// What an event handler sees: the target's value, a key, the pointer, files.
function eventInfo(e: Event): EventInfo {
    const target = e.target as HTMLInputElement | null;
    const transfer = (e as DragEvent).dataTransfer;
    const files = [...(transfer?.files ?? target?.files ?? [])].map(file => ({ name: file.name, size: file.size, mime: file.type, url: URL.createObjectURL(file) }));
    return { value: target?.value ?? "", checked: target?.checked ?? false, key: (e as KeyboardEvent).key ?? "", pageX: (e as MouseEvent).pageX ?? 0, pageY: (e as MouseEvent).pageY ?? 0, files };
}
// After an update: the subscriptions it asks for at once, and the view at the
// next animation frame. The view is drawn at most once a frame, as Elm draws
// it, so events between frames (a held key's repeats) cost no drawing.
let stale = false, drawing = false;
function changed(): void {
    try { subscriptions.update(app.subscriptions()); } catch (error) { report(error, true); }
    stale = true;
    if (!drawing) { drawing = true; requestAnimationFrame(() => { drawing = false; draw(); }); }
}
function draw(): void {
    if (!stale) return;
    stale = false;
    try {
        const next = app.render();
        patch(root, root.firstChild ?? undefined, current, next, false);
        current = next;
        recovered();
    } catch (error) { report(error, true); }
}
const kind = (node: HtmlNode) => "text" in node ? "#text" : "sketch" in node ? "#sketch" : node.tag;
function patch(parent: Node, dom: Node | undefined, before: HtmlNode | undefined, after: HtmlNode, svg: boolean): Node {
    const inSvg = svg || ("tag" in after && after.tag === "svg");
    if (!dom || !before || kind(before) !== kind(after)) {
        const fresh = "text" in after ? document.createTextNode(after.text) : "sketch" in after ? document.createElement("div")
            : inSvg ? document.createElementNS(SVG, after.tag) : document.createElement(after.tag);
        if (dom) parent.replaceChild(fresh, dom); else parent.appendChild(fresh);
        if ("sketch" in after) sketches.set(fresh, startSketch(fresh as HTMLElement, after.sketch, message => queueMicrotask(() => send(message))));
        dom = fresh; before = undefined;
    }
    if ("text" in after) {
        if (dom.nodeValue !== after.text) dom.nodeValue = after.text;
        return dom;
    }
    if ("sketch" in after) {
        const state = sketches.get(dom)!;
        state.pending = after.sketch;
        state.sketch?.update(after.sketch);
        return dom;
    }
    const element = dom as HTMLElement;
    const old = before && "tag" in before ? before : undefined;
    for (const name of Object.keys(old?.attributes ?? {})) if (!(name in after.attributes)) {
        element.removeAttribute(name);
        if (name === "value") (element as HTMLInputElement).value = "";
        if (name === "checked") (element as HTMLInputElement).checked = false;
    }
    // Only what changed is written: rewriting an unchanged attribute or style
    // (an SVG's viewBox every frame) can make a browser lay the page out again.
    for (const [name, value] of Object.entries(after.attributes)) {
        if (old?.attributes[name] !== value) {
            if (value === false) element.removeAttribute(name); else element.setAttribute(name, value === true ? "" : value);
        }
        // What the visitor typed or ticked is the element's, not its attribute's.
        if (name === "value" && (element as HTMLInputElement).value !== String(value)) (element as HTMLInputElement).value = String(value);
        if (name === "checked") (element as HTMLInputElement).checked = value === true;
    }
    for (const name of Object.keys(old?.styles ?? {})) if (!(name in after.styles)) element.style.removeProperty(name);
    for (const [name, value] of Object.entries(after.styles)) if (old?.styles[name] !== value) element.style.setProperty(name, value);
    // One listener per event, reading the newest handler when it fires.
    const listeners = (element as unknown as { apnListeners?: Map<string, { listener: EventListener; id: number; prevent: boolean }> }).apnListeners ??= new Map();
    for (const [event, entry] of listeners) if (!(event in after.events)) { element.removeEventListener(event, entry.listener); listeners.delete(event); }
    for (const [event, id] of Object.entries(after.events)) {
        const prevent = after.prevented.includes(event), entry = listeners.get(event);
        if (entry) { entry.id = id; entry.prevent = prevent; continue; }
        const fresh = { id, prevent, listener: (e: Event) => {
            if (fresh.prevent) e.preventDefault();
            try { app.send(app.message(fresh.id, event === "input" ? (e.target as HTMLInputElement).value ?? "" : eventInfo(e))); }
            catch (error) { report(error); return; }
            changed();
        } };
        element.addEventListener(event, fresh.listener);
        listeners.set(event, fresh);
    }
    after.children.forEach((child, index) => patch(element, element.childNodes[index], old?.children[index], child, inSvg && after.tag !== "foreignObject"));
    while (element.childNodes.length > after.children.length) element.lastChild!.remove();
    return element;
}
// A message from a command, a subscription or a sketch: update, then draw.
function send(message: Value): void {
    try { app.send(message); } catch (error) { report(error); return; }
    changed();
}

// The subscriptions the model asks for: installed once, given the newest
// message functions after each update, removed when no longer asked for.
// A page opened with #stats shows, each second, what it did: animation frames
// and the slowest one's work, input events with the slowest handler and the
// longest an event waited to be handled, and the keys the browser reports
// held. It tells a slow or throttled browser from lost or queued input.
const stats = location.hash === "#stats" ? (() => {
    const box = document.createElement("pre");
    box.style.cssText = "position:fixed;top:0;right:0;margin:0;padding:6px 8px;z-index:9;font:12px/1.4 monospace;"
        + "background:rgba(0,0,0,.75);color:#fff;pointer-events:none";
    document.body.appendChild(box);
    let frames = 0, work = 0, events = 0, handled = 0, waited = 0, last = "none";
    const held = new Set<string>(), watch = { capture: true, passive: true };
    addEventListener("keydown", e => { held.add(e.key); last = `keydown ${e.key}${e.repeat ? " (repeat)" : ""}`; }, watch);
    addEventListener("keyup", e => { held.delete(e.key); last = `keyup ${e.key}`; }, watch);
    addEventListener("blur", () => { last = "the page lost focus"; });
    setInterval(() => {
        box.textContent = [
            `frames/s       ${frames}   slowest ${work.toFixed(1)} ms`,
            `input events/s ${events}   slowest ${handled.toFixed(1)} ms`,
            `longest wait   ${waited.toFixed(0)} ms`,
            `keys held      ${[...held].join(" ") || "none"}`,
            `last key event ${last}`,
        ].join("\n");
        frames = work = events = handled = waited = 0;
    }, 1000);
    return {
        frame(ms: number) { frames++; work = Math.max(work, ms); },
        event(e: Event, start: number) {
            events++;
            handled = Math.max(handled, performance.now() - start);
            waited = Math.max(waited, start - e.timeStamp);
        },
    };
})() : undefined;

const subscriptions = (() => {
    const active = new Map<string, { current: Subscription; stop: () => void }>();
    const fire = (key: string, ...args: (number | string | boolean)[]) => {
        const entry = active.get(key);
        if (!entry) return;
        try { app.notify(entry.current, ...args); } catch (error) { report(error); return; }
        changed();
    };
    const start = (s: Subscription, key: string): () => void => {
        if (s.kind === "every") { const timer = setInterval(() => fire(key, Date.now()), s.ms); return () => clearInterval(timer); }
        if (s.kind === "frame") {
            let frame = 0, last = performance.now();
            // A frame's update draws in that frame.
            const tick = (now: number) => {
                const start = performance.now(), delta = now - last;
                last = now;
                fire(key, s.delta ? delta : Date.now());
                draw();
                stats?.frame(performance.now() - start);
                frame = requestAnimationFrame(tick);
            };
            frame = requestAnimationFrame(tick);
            return () => cancelAnimationFrame(frame);
        }
        if (s.kind === "key") return listen(document, s.event, e => fire(key, (e as KeyboardEvent).key));
        if (s.kind === "mouse") return listen(document, s.event, e => fire(key, (e as MouseEvent).pageX, (e as MouseEvent).pageY));
        if (s.kind === "resize") return listen(window, "resize", () => fire(key, innerWidth, innerHeight));
        return listen(document, "visibilitychange", () => fire(key, document.visibilityState === "visible"));
    };
    // Passive, as Elm's are: a subscription never cancels what the browser
    // does, so the browser need not wait for it on each of a held key's repeats.
    const listen = (target: EventTarget, event: string, f: (e: Event) => void) => {
        const handle = (e: Event) => { const start = performance.now(); f(e); stats?.event(e, start); };
        target.addEventListener(event, handle, { passive: true });
        return () => target.removeEventListener(event, handle);
    };
    return {
        update(wanted: Subscription[]): void {
            const keys = new Set<string>();
            for (const s of wanted) {
                const key = subscriptionKey(s);
                keys.add(key);
                const entry = active.get(key);
                if (entry) entry.current = s; else active.set(key, { current: s, stop: start(s, key) });
            }
            for (const [key, entry] of active) if (!keys.has(key)) { entry.stop(); active.delete(key); }
        },
    };
})();

const platform: Platform = {
    defer: run => setTimeout(run, 0),
    http: async url => { const response = await fetch(url); return { status: response.status, body: await response.text() }; },
    selectFiles: (mimes, multiple) => new Promise(resolve => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = mimes.join(",");
        input.multiple = multiple;
        input.onchange = () => resolve([...input.files ?? []].map(file => ({ name: file.name, size: file.size, mime: file.type, url: URL.createObjectURL(file) })));
        input.click();
    }),
    download: (name, mime, content) => {
        const link = document.createElement("a");
        link.href = URL.createObjectURL(new Blob([content], { type: mime }));
        link.download = name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 0);
    },
    viewport: () => ({ width: innerWidth, height: innerHeight }),
};

try {
    const payload = JSON.parse(document.getElementById("apn-program")!.textContent!);
    interpreter = new Interpreter();
    interpreter.moduleSources = payload.modules;
    // Bundled data files, as blob URLs made once.
    const urls = new Map<string, string>();
    interpreter.assetUrl = path => {
        if (urls.has(path)) return urls.get(path);
        const file = bundledFile(payload.modules, path);
        if (!file) return undefined;
        // A font loads through CSS, which takes no blob URL from an
        // opaque-origin page (a sandboxed frame).
        if (file.mime.startsWith("font/") && file.dataUrl) return file.dataUrl;
        const blob = file.text !== undefined ? new Blob([file.text], { type: file.mime })
            : new Blob([Uint8Array.from(atob(file.dataUrl!.slice(file.dataUrl!.indexOf(",") + 1)), c => c.charCodeAt(0))], { type: file.mime });
        const url = URL.createObjectURL(blob);
        urls.set(path, url);
        return url;
    };
    interpreter.sourceDir = BUNDLE_APP;
    interpreter.enableChecking();
    interpreter.run(parse(payload.source), false, true);
    const program = interpreter.env.get("main");
    if (!program) throw new Error("APN browser app must define main");
    const value = interpreter.demand(program);
    if (value.kind === "variant" && value.tag === "P5Sketch") startSketch(root, value);
    else {
        app = new BrowserApp(interpreter, value, platform);
        app.onChange = changed;
        app.onError = report;
        changed();
        draw();
    }
}
catch (error) { report(error); }
