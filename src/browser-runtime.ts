/// <reference lib="dom" />
import { Interpreter } from "./interp.ts";
import { parse } from "./parser.ts";
import { BrowserSandbox, type HtmlNode } from "./html.ts";

let app: BrowserSandbox;
const root = document.getElementById("app")!;
const errors = document.getElementById("apn-error")!;
let current: HtmlNode | undefined;

function patch(parent: Node, dom: Node | undefined, before: HtmlNode | undefined, after: HtmlNode): Node {
    const replace = !dom || !before || ("text" in before) !== ("text" in after) || ("tag" in before && "tag" in after && before.tag !== after.tag);
    if (replace) {
        const fresh = "text" in after ? document.createTextNode(after.text) : document.createElement(after.tag);
        if (dom) parent.replaceChild(fresh, dom); else parent.appendChild(fresh);
        dom = fresh; before = undefined;
    }
    if ("text" in after) {
        if (dom!.nodeValue !== after.text) dom!.nodeValue = after.text;
        return dom!;
    }
    const element = dom as HTMLElement;
    const old = before && "tag" in before ? before : undefined;
    for (const name of Object.keys(old?.attributes ?? {})) if (!(name in after.attributes)) {
        element.removeAttribute(name);
        if (name === "value") (element as HTMLInputElement).value = "";
        if (name === "checked") (element as HTMLInputElement).checked = false;
    }
    for (const [name, value] of Object.entries(after.attributes)) {
        if (value === false) element.removeAttribute(name); else element.setAttribute(name, value === true ? "" : value);
        if (name === "value" && (element as HTMLInputElement).value !== String(value)) (element as HTMLInputElement).value = String(value);
        if (name === "checked") (element as HTMLInputElement).checked = value === true;
    }
    for (const name of Object.keys(old?.styles ?? {})) if (!(name in after.styles)) element.style.removeProperty(name);
    for (const [name, value] of Object.entries(after.styles)) element.style.setProperty(name, value);
    for (const event of ["click", "input", "submit"]) {
        const id = after.events[event];
        const handler = id === undefined ? null : (e: Event) => {
            if (event === "submit") e.preventDefault();
            try {
                const next = app.dispatch(id, (e.target as HTMLInputElement).value ?? "");
                patch(root, root.firstChild ?? undefined, current, next); current = next;
                errors.hidden = true;
            } catch (error) { errors.textContent = String(error); errors.hidden = false; }
        };
        (element as unknown as Record<string, unknown>)[`on${event}`] = handler;
    }
    after.children.forEach((child, index) => patch(element, element.childNodes[index], old?.children[index], child));
    while (element.childNodes.length > after.children.length) element.lastChild!.remove();
    return element;
}
try {
    const payload = JSON.parse(document.getElementById("apn-program")!.textContent!);
    const interpreter = new Interpreter();
    interpreter.moduleSources = payload.modules;
    interpreter.run(parse(payload.source));
    const program = interpreter.env.get("main");
    if (!program) throw new Error("APN browser app must define main");
    app = new BrowserSandbox(interpreter, program);
    current = app.render();
    patch(root, undefined, undefined, current);
}
catch (error) { errors.textContent = String(error); errors.hidden = false; }
