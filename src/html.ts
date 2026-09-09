import { Interpreter } from "./interp.ts";
import { type Value } from "./types.ts";
import { APNError } from "./errors.ts";

export type HtmlNode = { text: string } | {
    tag: string;
    attributes: Record<string, string | boolean>;
    styles: Record<string, string>;
    events: Record<string, number>;
    children: HtmlNode[];
};
type Handler = { message: Value } | { input: Value };
const fail = (message: string): never => { throw new APNError("runtime", `HTML: ${message}`); };
function string(i: Interpreter, value: Value): string {
    const v = i.demand(value);
    return v.kind === "string" ? v.v : fail("expected String; use toString for numbers");
}
function variant(i: Interpreter, value: Value, tag: string): Value[] {
    const v = i.demand(value);
    return v.kind === "variant" && v.tag === tag ? v.v : fail(`expected ${tag}`);
}

export class BrowserSandbox {
    model: Value;
    private update: Value;
    private view: Value;
    private handlers: Handler[] = [];
    constructor(readonly interpreter: Interpreter, program: Value) {
        const i = interpreter;
        const spec = i.demand(variant(i, program, "BrowserSandbox")[0]);
        if (spec.kind !== "record") fail("sandbox expects [init: ..., update: ..., view: ...]");
        const fields = new Map((spec as Extract<Value, { kind: "record" }>).v);
        const get = (key: string): Value => fields.get(key) ?? fail(`sandbox is missing '${key}'`);
        this.model = i.demand(get("init"));
        this.update = i.demand(get("update"));
        this.view = i.demand(get("view"));
    }
    render(): HtmlNode {
        const handlers: Handler[] = [];
        const tree = this.node(this.interpreter.apply(this.view, this.model), handlers);
        this.handlers = handlers;
        return tree;
    }
    dispatch(id: number, input = ""): HtmlNode {
        const handler = this.handlers[id] ?? fail("unknown event handler");
        const i = this.interpreter;
        const message = "message" in handler ? handler.message : i.apply(handler.input, { kind: "string", v: input });
        const old = this.model;
        try {
            this.model = i.demand(i.apply(i.apply(this.update, message), old));
            return this.render();
        } catch (error) { this.model = old; throw error; }
    }
    private node(value: Value, handlers: Handler[]): HtmlNode {
        const i = this.interpreter, v = i.demand(value);
        if (v.kind !== "variant") return fail("view must return text or an HTML element");
        if (v.tag === "HtmlText") return { text: string(i, v.v[0]) };
        if (v.tag !== "HtmlElement" || v.v.length !== 3) return fail("invalid HTML node");
        const tag = string(i, v.v[0]).toLowerCase();
        if (!/^[a-z][a-z0-9-]*$/.test(tag) || ["script", "iframe", "object", "embed", "base", "meta", "link"].includes(tag)) return fail(`unsupported element '${tag}'`);
        const node: Extract<HtmlNode, { tag: string }> = { tag, attributes: {}, styles: {}, events: {}, children: [] };
        for (const item of i.items(v.v[1])) {
            const attr = i.demand(item);
            if (attr.kind !== "variant") return fail("invalid attribute");
            if (attr.tag === "HtmlClick" || attr.tag === "HtmlInput" || attr.tag === "HtmlSubmit") {
                const event = attr.tag === "HtmlClick" ? "click" : attr.tag === "HtmlInput" ? "input" : "submit";
                node.events[event] = handlers.length;
                handlers.push(event === "input" ? { input: i.demand(attr.v[0]) } : { message: attr.v[0] });
            } else if (attr.tag === "HtmlStyle") {
                node.styles[string(i, attr.v[0])] = string(i, attr.v[1]);
            } else if (attr.tag === "HtmlAttr") {
                const name = string(i, attr.v[0]).toLowerCase();
                if (!/^[a-z][a-z0-9:_-]*$/.test(name) || name.startsWith("on") || name === "srcdoc") return fail(`unsupported attribute '${name}'`);
                const raw = i.demand(attr.v[1]);
                const content = raw.kind === "bool" ? raw.v : string(i, raw);
                if (typeof content === "string" && ["href", "src", "action", "formaction"].includes(name) && /^\s*(javascript|vbscript|data)\s*:/i.test(content.replace(/[\u0000-\u0020]/g, ""))) return fail("unsafe URL attribute");
                node.attributes[name] = content;
            } else return fail(`unknown attribute '${attr.tag}'`);
        }
        node.children = i.items(v.v[2]).map((child) => this.node(child, handlers));
        if (["input", "br", "hr", "img"].includes(tag) && node.children.length) return fail(`${tag} cannot have children`);
        return node;
    }
}
