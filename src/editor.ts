/// <reference lib="dom" />
// The examples editor (apn --site): edits a program, colors it as the REPL and
// the language server do, and runs it in a sandboxed frame beside it.
import { highlightHtml, PALETTES, TOKEN_TYPES } from "./highlight.ts";
import { BUNDLE_APP } from "./modules.ts";

// data: the examples' data files, by the path a program names them with.
type Site = { examples: Record<string, string>; modules: Record<string, string>; data: Record<string, string>; style: string };
const site: Site = JSON.parse(document.getElementById("apn-site")!.textContent!);
const runtime = document.getElementById("apn-runtime")!.textContent!;
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const source = element<HTMLTextAreaElement>("source"), highlight = element("highlight"), gutter = element("gutter");
const picker = element<HTMLSelectElement>("examples"), preview = element<HTMLIFrameElement>("preview");
const original = element<HTMLAnchorElement>("original"), themeButton = element<HTMLButtonElement>("theme");

// Storage may be unavailable (a private window, blocked site data).
const stored = (store: () => Storage) => ({
    get(key: string): string | null { try { return store().getItem(key); } catch { return null; } },
    set(key: string, value: string): void { try { store().setItem(key, value); } catch { /* not kept */ } },
});
const session = stored(() => sessionStorage), local = stored(() => localStorage);

// Light or dark: the visitor's choice, else the system's. Token colors are
// the shared palettes, Latte and Frappé.
const style = document.createElement("style");
style.textContent = (["light", "dark"] as const).map(theme =>
    `:root[data-theme="${theme}"]{${TOKEN_TYPES.map(type => `--t-${type}:${PALETTES[theme][type]};`).join("")}}`).join("\n")
    + TOKEN_TYPES.map(type => `.t-${type}{color:var(--t-${type})}`).join("") + ".t-comment{font-style:italic}";
document.head.appendChild(style);
const systemDark = matchMedia("(prefers-color-scheme: dark)");
function applyTheme(): void {
    const theme = local.get("apn-theme") ?? (systemDark.matches ? "dark" : "light");
    document.documentElement.dataset.theme = theme;
    themeButton.textContent = theme === "dark" ? "Light" : "Dark";
    themeButton.title = `Switch to the ${theme === "dark" ? "light" : "dark"} theme`;
}
themeButton.addEventListener("click", () => { local.set("apn-theme", document.documentElement.dataset.theme === "dark" ? "light" : "dark"); applyTheme(); });
systemDark.addEventListener("change", applyTheme);
applyTheme();

const names = Object.keys(site.examples);
// An example's title and source link come from its first comment line:
// "# Title, from https://...".
const firstLine = (name: string) => /^#\s*(.*)$/m.exec(site.examples[name])?.[1] ?? "";
// The comment an example starts with, which names its title and original.
const leadingComment = (name: string) => /^(?:#.*\n?)*/.exec(site.examples[name])?.[0] ?? "";
const titleOf = (name: string) => firstLine(name).split(",")[0] || name;
names.sort((a, b) => titleOf(a).localeCompare(titleOf(b)));
for (const name of names) picker.add(new Option(titleOf(name), name));
let current = names[0];

function render(): void {
    highlight.innerHTML = highlightHtml(source.value) + "\n";
    gutter.textContent = source.value.split("\n").map((_, n) => n + 1).join("\n");
    // The textarea grows with its text, so the panel scrolls both layers together.
    source.style.height = "0";
    source.style.height = `${highlight.scrollHeight}px`;
    source.style.width = "0";
    source.style.width = `${Math.max(highlight.scrollWidth, source.parentElement!.clientWidth)}px`;
}
function open(name: string): void {
    current = site.examples[name] === undefined ? names[0] : name;
    picker.value = current;
    source.value = session.get(`apn:${current}`) ?? site.examples[current];
    const link = /https?:\/\/\S+/.exec(leadingComment(current))?.[0];
    original.hidden = !link;
    if (link) original.href = link;
    document.title = `${titleOf(current)} · APN`;
    render();
    run();
}
function run(): void {
    // The data files the source names (as a string literal), as the build bundles them.
    const named = Object.entries(site.data).filter(([path]) => source.value.includes(JSON.stringify(path)));
    const modules = { ...site.modules, ...Object.fromEntries(named.map(([path, entry]) => [BUNDLE_APP + path, entry])) };
    const payload = JSON.stringify({ source: source.value, modules }).replace(/</g, "\\u003c");
    preview.srcdoc = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
        + `<style>${site.style}</style><body><div id="app"></div><pre id="apn-error" role="alert" hidden></pre>`
        + `<script id="apn-program" type="application/json">${payload}<\/script><script type="module">${runtime}<\/script></body></html>`;
}
source.addEventListener("input", () => { session.set(`apn:${current}`, source.value); render(); });
source.addEventListener("keydown", event => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); run(); return; }
    const { selectionStart: start, selectionEnd: end, value } = source;
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    if (event.key === "Tab") {
        event.preventDefault();
        if (event.shiftKey) source.setRangeText("", lineStart, lineStart + (value.startsWith("    ", lineStart) ? 4 : 0), "preserve");
        else source.setRangeText("    ", start, end, "end");
    } else if (event.key === "Enter") {
        // Keep the line's indentation, 4 deeper after an opening { or [.
        event.preventDefault();
        const line = value.slice(lineStart, start), indent = /^ */.exec(line)![0];
        source.setRangeText("\n" + indent + (/[{[]\s*$/.test(line) ? "    " : ""), start, end, "end");
    } else return;
    source.dispatchEvent(new Event("input"));
});
picker.addEventListener("change", () => { location.hash = picker.value; });
element("run").addEventListener("click", run);
element("reset").addEventListener("click", () => { session.set(`apn:${current}`, site.examples[current]); open(current); });
addEventListener("hashchange", () => open(decodeURIComponent(location.hash.slice(1))));
addEventListener("resize", render);
open(decodeURIComponent(location.hash.slice(1)));
