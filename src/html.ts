import { Interpreter } from "./interp.ts";
import { type Value, mkInt, mkList, mkStr } from "./types.ts";
import { APNError } from "./errors.ts";
import { fromJson } from "./json.ts";

// The view as plain data for the page to patch in. A sketch node is a p5
// sketch's callback record (see the p5 module's canvas).
export type HtmlNode = { text: string } | { sketch: Value } | {
    tag: string;
    attributes: Record<string, string | boolean>;
    styles: Record<string, string>;
    // Event name to handler number; prevented: events whose default is stopped.
    events: Record<string, number>;
    prevented: string[];
    children: HtmlNode[];
};
type Handler = { message: Value } | { input: Value } | { event: Value };
// What an event handler (onEvent) receives, as a record.
export type FileInfo = { name: string; size: number; mime: string; url: string };
export type EventInfo = { value?: string; checked?: boolean; key?: string; pageX?: number; pageY?: number; files?: FileInfo[] };
// A subscription the page installs; its message function is the newest one.
export type Subscription =
    | { kind: "every"; ms: number; toMessage: Value }
    | { kind: "frame"; delta: boolean; toMessage: Value }
    | { kind: "key" | "mouse"; event: string; toMessage: Value }
    | { kind: "resize" | "visibility"; toMessage: Value };
export const subscriptionKey = (s: Subscription): string =>
    s.kind === "every" ? `every:${s.ms}` : s.kind === "frame" ? `frame:${s.delta}` : s.kind === "key" || s.kind === "mouse" ? `${s.kind}:${s.event}` : s.kind;
// What commands need from the page: deferral, HTTP, file pickers, the viewport.
export interface Platform {
    defer(run: () => void): void;
    http(url: string): Promise<{ status: number; body: string }>;
    selectFiles(mimes: string[], multiple: boolean): Promise<FileInfo[]>;
    download(name: string, mime: string, content: string): void;
    viewport(): { width: number; height: number };
}

const fail = (message: string): never => { throw new APNError("runtime", `HTML: ${message}`); };
function string(i: Interpreter, value: Value): string {
    const v = i.dataValue(value);
    return v.kind === "string" ? v.v : fail("expected String; use to String for numbers");
}
function variant(i: Interpreter, value: Value): Extract<Value, { kind: "variant" }> {
    const v = i.demand(value);
    return v.kind === "variant" ? v : fail("expected a command or subscription");
}
const record = (fields: Array<[string, Value]>): Value => ({ kind: "record", v: fields });
const number = (n: number): Value => Number.isSafeInteger(n) ? mkInt(n) : { kind: "float", v: n };
// What the browser measures (a frame's delta, a pointer's position) is a Float,
// as Elm's, even when it happens to be whole: an exact 17 or 512 would make
// what it feeds exact, which a later 16.7 or 512.5 cannot join.
const measured = (n: number): Value => ({ kind: "float", v: n });
export const fileValue = (file: FileInfo): Value => record([["name", mkStr(file.name)], ["size", number(file.size)], ["mime", mkStr(file.mime)], ["url", mkStr(file.url)]]);
function eventValue(info: EventInfo): Value {
    return record([
        ["value", mkStr(info.value ?? "")], ["checked", { kind: "bool", v: info.checked ?? false }], ["key", mkStr(info.key ?? "")],
        ["pageX", measured(info.pageX ?? 0)], ["pageY", measured(info.pageY ?? 0)], ["files", mkList((info.files ?? []).map(fileValue))],
    ]);
}
const UNSAFE_TAGS = ["script", "iframe", "object", "embed", "base", "meta", "link", "foreignobject"];
const VOID_TAGS = ["input", "br", "hr", "img"];

// A sandbox or an element program: its model, view and, for an element,
// commands and subscriptions. send applies a message; onChange tells the page
// to render after a message that did not come from a page event.
export class BrowserApp {
    model: Value;
    private update: Value;
    private view: Value;
    private subscriptionsOf?: Value;
    // main as a view alone (Elm's main = text "Hello!"): it never changes.
    private fixed?: Value;
    private handlers: Handler[] = [];
    onChange: () => void = () => {};
    onError: (error: unknown) => void = error => { throw error; };
    constructor(readonly interpreter: Interpreter, program: Value, readonly platform?: Platform) {
        const i = interpreter, v = i.demand(program);
        if (v.kind === "variant" && ["HtmlText", "HtmlElement", "HtmlSketch"].includes(v.tag)) {
            this.fixed = v;
            this.model = this.update = this.view = { kind: "list", v: [] };
            return;
        }
        if (v.kind !== "variant" || (v.tag !== "BrowserSandbox" && v.tag !== "BrowserElement")) fail("main must be a view or a browser program (browser.sandbox or browser.element)");
        const element = (v as Extract<Value, { kind: "variant" }>).tag === "BrowserElement";
        const spec = i.demand((v as Extract<Value, { kind: "variant" }>).v[0]);
        if (spec.kind !== "record") fail(`${element ? "element" : "sandbox"} expects [init: ..., update: ..., view: ...${element ? ", subscriptions: ..." : ""}]`);
        const fields = new Map((spec as Extract<Value, { kind: "record" }>).v);
        const get = (key: string): Value => fields.get(key) ?? fail(`${element ? "element" : "sandbox"} is missing '${key}'`);
        this.update = i.demand(get("update"));
        this.view = i.demand(get("view"));
        if (element) {
            this.subscriptionsOf = i.demand(get("subscriptions"));
            const [model, command] = this.pair(get("init"), "init");
            this.model = model;
            this.run(command);
        } else this.model = i.demand(get("init"));
    }
    // An element's [model, command].
    private pair(value: Value, what: string): [Value, Value] {
        const items = this.interpreter.items(value);
        if (items.length !== 2) fail(`${what} must give [model, command]`);
        return [this.interpreter.demand(items[0]), items[1]];
    }
    render(): HtmlNode {
        const handlers: Handler[] = [];
        const tree = this.node(this.fixed ?? this.interpreter.apply(this.view, this.model), handlers);
        this.handlers = handlers;
        return tree;
    }
    // A page event on handler id: its message.
    message(id: number, input: string | EventInfo = ""): Value {
        const handler = this.handlers[id] ?? fail("unknown event handler");
        const i = this.interpreter, info = typeof input === "string" ? { value: input } : input;
        return "message" in handler ? handler.message
            : "input" in handler ? i.apply(handler.input, mkStr(info.value ?? "")) : i.apply(handler.event, eventValue(info));
    }
    // Its message, applied; the new view.
    dispatch(id: number, input: string | EventInfo = ""): HtmlNode {
        this.send(this.message(id, input));
        return this.render();
    }
    // Apply a message. A failed update keeps the model it had.
    send(message: Value): void {
        const i = this.interpreter, old = this.model;
        try {
            const next = i.apply(i.apply(this.update, message), old);
            if (this.subscriptionsOf) {
                const [model, command] = this.pair(next, "update");
                this.model = model;
                this.run(command);
            } else this.model = i.demand(next);
        } catch (error) { this.model = old; throw error; }
    }
    // A message from a command or subscription, after the current one.
    private later(message: () => Value): void {
        const platform = this.platform ?? fail("commands need a browser");
        platform.defer(() => {
            try { this.send(message()); this.onChange(); }
            catch (error) { this.onError(error); }
        });
    }
    // Run a command: none, batch, a task, an HTTP request, a file picker or
    // download, the viewport.
    run(command: Value): void {
        const i = this.interpreter, c = variant(i, command);
        switch (c.tag) {
            case "EffectNone": return;
            case "EffectBatch": for (const each of i.items(c.v[0])) this.run(each); return;
            case "TaskPerform": return this.later(() => i.apply(c.v[1], i.runIO(c.v[0])));
            case "TaskAttempt": return this.later(() => {
                let result: Value;
                try { result = i.runIO(c.v[0]); }
                catch (error) { return i.apply(c.v[2], mkStr(error instanceof Error ? error.message : String(error))); }
                return i.apply(c.v[1], result);
            });
            case "HttpGet": {
                const platform = this.platform ?? fail("HTTP needs a browser");
                const url = string(i, c.v[0]), expect = new Map(i.demand(c.v[1]).kind === "record" ? (i.demand(c.v[1]) as Extract<Value, { kind: "record" }>).v : []);
                const json = i.dataValue(expect.get("json") ?? fail("http.get expects an expectation")).kind === "bool" && (i.dataValue(expect.get("json")!) as { v: boolean }).v;
                const failure = (status: number, reason: string) => this.later(() => i.apply(i.apply(expect.get("failure")!, mkInt(status)), mkStr(reason)));
                platform.http(url).then(({ status, body }) => {
                    if (status < 200 || status > 299) return failure(status, `${url} answered ${status}`);
                    let value: Value = mkStr(body);
                    if (json) { try { value = fromJson(body); } catch (error) { return failure(-1, error instanceof Error ? error.message : String(error)); } }
                    this.later(() => i.apply(expect.get("success")!, value));
                }, error => failure(0, error instanceof Error ? error.message : String(error)));
                return;
            }
            case "FileSelect": {
                const platform = this.platform ?? fail("file selection needs a browser");
                const mimes = i.items(c.v[0]).map(m => string(i, m)), multiple = i.dataValue(c.v[1]).kind === "bool" && (i.dataValue(c.v[1]) as { v: boolean }).v;
                platform.selectFiles(mimes, multiple).then(files => {
                    if (files.length) this.later(() => i.apply(c.v[2], mkList(files.map(fileValue))));
                }, error => this.onError(error));
                return;
            }
            case "FileDownload": {
                const platform = this.platform ?? fail("downloads need a browser");
                return platform.download(string(i, c.v[0]), string(i, c.v[1]), string(i, c.v[2]));
            }
            case "ViewportGet": {
                const platform = this.platform ?? fail("the viewport needs a browser");
                return this.later(() => {
                    const { width, height } = platform.viewport();
                    return i.apply(c.v[0], record([["width", number(width)], ["height", number(height)]]));
                });
            }
            default: return fail(`unknown command ${c.tag}`);
        }
    }
    // The subscriptions the model asks for, flattened.
    subscriptions(): Subscription[] {
        if (!this.subscriptionsOf) return [];
        const i = this.interpreter, found: Subscription[] = [];
        const visit = (value: Value): void => {
            const s = variant(i, value);
            switch (s.tag) {
                case "EffectNone": return;
                case "EffectBatch": i.items(s.v[0]).forEach(visit); return;
                case "TimeEvery": {
                    const ms = i.dataValue(s.v[0]);
                    const n = ms.kind === "int" ? Number(ms.v) : ms.kind === "float" ? ms.v : fail("every expects milliseconds");
                    found.push({ kind: "every", ms: n, toMessage: s.v[1] }); return;
                }
                case "FrameSub": found.push({ kind: "frame", delta: string(i, s.v[0]) === "delta", toMessage: s.v[1] }); return;
                case "KeySub": found.push({ kind: "key", event: string(i, s.v[0]), toMessage: s.v[1] }); return;
                case "MouseSub": found.push({ kind: "mouse", event: string(i, s.v[0]), toMessage: s.v[1] }); return;
                case "ResizeSub": found.push({ kind: "resize", toMessage: s.v[0] }); return;
                case "VisibilitySub": found.push({ kind: "visibility", toMessage: s.v[0] }); return;
                default: return fail(`unknown subscription ${s.tag}`);
            }
        };
        visit(i.apply(this.subscriptionsOf, this.model));
        return found;
    }
    // A subscription's message from what the page saw.
    notify(subscription: Subscription, ...args: (number | string | boolean)[]): void {
        const i = this.interpreter;
        const measures = subscription.kind === "frame" && subscription.delta || subscription.kind === "mouse";
        const value = (x: number | string | boolean): Value => typeof x === "number" ? (measures ? measured(x) : number(x))
            : typeof x === "string" ? mkStr(x) : { kind: "bool", v: x };
        this.send(args.reduce((f: Value, x) => i.apply(f, value(x)), subscription.toMessage));
    }
    private node(value: Value, handlers: Handler[]): HtmlNode {
        const i = this.interpreter, v = i.demand(value);
        if (v.kind !== "variant") return fail("view must return text or an HTML element");
        if (v.tag === "HtmlText") return { text: string(i, v.v[0]) };
        if (v.tag === "HtmlSketch") return { sketch: v.v[0] };
        if (v.tag !== "HtmlElement" || v.v.length !== 3) return fail("invalid HTML node");
        const tag = string(i, v.v[0]);
        if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(tag) || UNSAFE_TAGS.includes(tag.toLowerCase())) return fail(`unsupported element '${tag}'`);
        const node: Extract<HtmlNode, { tag: string }> = { tag, attributes: {}, styles: {}, events: {}, prevented: [], children: [] };
        const handle = (event: string, handler: Handler) => { node.events[event] = handlers.length; handlers.push(handler); };
        for (const item of i.items(v.v[1])) {
            const attr = i.demand(item);
            if (attr.kind !== "variant") return fail("invalid attribute");
            if (attr.tag === "HtmlClick") handle("click", { message: attr.v[0] });
            else if (attr.tag === "HtmlSubmit") { handle("submit", { message: attr.v[0] }); node.prevented.push("submit"); }
            else if (attr.tag === "HtmlInput") handle("input", { input: i.demand(attr.v[0]) });
            else if (attr.tag === "HtmlOn") {
                const event = string(i, attr.v[0]);
                if (!/^[a-z]+$/.test(event)) return fail(`unsupported event '${event}'`);
                handle(event, { event: i.demand(attr.v[1]) });
                const prevent = i.dataValue(attr.v[2]);
                if (prevent.kind === "bool" && prevent.v) node.prevented.push(event);
            } else if (attr.tag === "HtmlStyle") {
                node.styles[string(i, attr.v[0])] = string(i, attr.v[1]);
            } else if (attr.tag === "HtmlAttr") {
                const name = string(i, attr.v[0]);
                if (!/^[a-zA-Z][a-zA-Z0-9:_-]*$/.test(name) || name.toLowerCase().startsWith("on") || name.toLowerCase() === "srcdoc") return fail(`unsupported attribute '${name}'`);
                const raw = i.dataValue(attr.v[1]);
                const content = raw.kind === "bool" ? raw.v : string(i, raw);
                if (typeof content === "string" && ["href", "src", "action", "formaction", "xlink:href"].includes(name.toLowerCase()) && /^\s*(javascript|vbscript|data)\s*:/i.test(content.replace(/[\u0000- ]/g, ""))) return fail("unsafe URL attribute");
                node.attributes[name] = content;
            } else return fail(`unknown attribute '${attr.tag}'`);
        }
        node.children = i.items(v.v[2]).map((child) => this.node(child, handlers));
        if (VOID_TAGS.includes(tag.toLowerCase()) && node.children.length) return fail(`${tag} cannot have children`);
        return node;
    }
}
