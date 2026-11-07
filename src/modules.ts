// Where `import "name"` finds its code. Next to the importing file (the
// current directory in the REPL): name.apn, else a name/ folder, whose
// entries (its .apn files and subfolders) are the module's fields, each
// imported when used (beside name.apn, name/ is reached by path: name/sub).
// Then the same in each parent folder up to the program's root (the main
// program's folder), so a module in a subfolder can import its siblings'
// packages; the nearest wins. "std" is the standard library, the folder
// lib/std/, and "std/name" one of its modules.
//
// The files come from the disk, or from a bundle (a browser build): a map
// from virtual paths to sources, with the standard library under BUNDLE_LIB
// and the program's own directory at BUNDLE_APP.

import { parse, parseDocument } from "./parser.ts";
import { NATIVE_EXPORTS } from "./native-exports.ts";
import { METHODS } from "./ast.ts";

export const STD_DIRECTORY = new URL("../lib/std/", import.meta.url);
export const BUNDLE_LIB = "/lib/";
export const BUNDLE_APP = "/app/";

/** One file of a module: its source, a label for errors, and its directory. */
export interface ModuleFile { source: string; label: string; directory: string; std?: string }
/**
 * A resolved module: a cache key (its path), and its file (name.apn) or its
 * folder's entries (name/'s files and subfolders, by name), each a module of
 * its own: the spec that resolves it from directory.
 */
export interface ResolvedModule { key: string; files: ModuleFile[]; entries: ModuleEntry[] }
export interface ModuleEntry { name: string; spec: string; directory: string }

const NAME = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;

// Reading files and listing a folder's .apn files and subfolders (with a
// trailing /), by absolute path.
interface Files { read(path: string): string | undefined; list(folder: string): string[] | undefined; lib: string }

const disk: Files = {
    read(path) {
        try { return Deno.readTextFileSync(path); } catch { return undefined; }
    },
    list(folder) {
        try {
            return [...Deno.readDirSync(folder)].filter(entry => !entry.name.startsWith(".")
                && (entry.isFile && entry.name.endsWith(".apn") || entry.isDirectory)).map(entry => entry.isDirectory ? `${entry.name}/` : entry.name);
        } catch { return undefined; }
    },
    lib: STD_DIRECTORY.pathname,
};
function bundleFiles(bundle: Record<string, string>): Files {
    return {
        read: path => bundle[path],
        list(folder) {
            const names = new Set<string>();
            for (const path of Object.keys(bundle)) {
                if (!path.startsWith(folder) || !path.endsWith(".apn")) continue;
                const rest = path.slice(folder.length), slash = rest.indexOf("/");
                names.add(slash < 0 ? rest : rest.slice(0, slash + 1));
            }
            return names.size ? [...names] : undefined;
        },
        lib: BUNDLE_LIB,
    };
}
// A path with its . and .. parts resolved, so one file has one spelling.
function normal(path: string): string {
    const parts: string[] = [];
    for (const part of path.split("/")) {
        if (part === "..") parts.pop();
        else if (part && part !== ".") parts.push(part);
    }
    return `/${parts.join("/")}`;
}
function absolute(directory: string, files: Files): string {
    const folder = normal(files !== disk || directory.startsWith("/") ? directory : `${Deno.cwd()}/${directory}`);
    return folder.endsWith("/") ? folder : `${folder}/`;
}

// name.apn, else the folder name/, under the folder base (name "" is base
// itself): the file, or the folder's entries.
function find(files: Files, base: string, name: string, std: boolean): ResolvedModule | undefined {
    const path = `${base}${name}.apn`, source = name ? files.read(path) : undefined;
    if (source !== undefined) {
        return { key: path, files: [{ source, label: std ? name : path, directory: path.slice(0, path.lastIndexOf("/") + 1), ...std ? { std: name } : {} }], entries: [] };
    }
    const folder = name ? `${base}${name}/` : base;
    const listed = files.list(folder)?.sort();
    if (!listed?.length) return undefined;
    const entries = listed.map(entry => entry.replace(/(\.apn|\/)$/, "")).filter((entry, n, all) => all.indexOf(entry) === n)
        .map(entry => ({ name: entry, spec: entry, directory: folder }));
    return { key: folder, files: [], entries };
}

// The folders an import from directory searches: it, then its parents up
// to root (only it when it is outside root).
function searchFolders(directory: string, root: string | undefined): string[] {
    const folders = [directory];
    if (root === undefined || !directory.startsWith(root)) return folders;
    for (let folder = directory; folder !== root;) {
        folder = folder.slice(0, folder.lastIndexOf("/", folder.length - 2) + 1);
        folders.push(folder);
    }
    return folders;
}

/**
 * Resolve an import from code in directory, from the disk or a bundle,
 * searching parent folders up to root (the program's folder).
 */
export function resolveModule(spec: string, directory: string, bundle?: Record<string, string>, root?: string): ResolvedModule | undefined {
    if (!NAME.test(spec)) return undefined;
    const files = bundle ? bundleFiles(bundle) : disk;
    if (spec === "std" || spec.startsWith("std/")) {
        const resolved = find(files, files.lib, spec.slice(4), true);
        // The library's entries are its modules: std/name each.
        if (resolved) resolved.entries = resolved.entries.map(entry => ({ ...entry, spec: `${spec}/${entry.name}`, directory: files.lib }));
        return resolved;
    }
    const start = absolute(directory, files);
    // Inside the standard library, a bare name is a module beside the file.
    if (start.startsWith(files.lib)) return find(files, start, spec, true);
    for (const folder of searchFolders(start, root === undefined ? undefined : absolute(root, files))) {
        const local = find(files, folder, spec, false);
        if (local) return local;
    }
    return undefined;
}

/** Why an import could not be resolved, with a hint. */
export function unknownModule(spec: string, bundled = false): { message: string; hint: string } {
    if (spec.startsWith("std/")) return { message: `unknown module '${spec}'`, hint: `the standard library has no module '${spec.slice(4)}'` };
    if (bundled) return { message: `module '${spec}' is not bundled`, hint: "a browser build bundles the standard library and the local modules the program imports" };
    const standard = !spec.includes("/") && resolveModule(`std/${spec}`, ".") ? `; a standard module is std.${spec}: \`std <- import "std"; use std.${spec}\`` : "";
    return { message: `unknown module '${spec}'`, hint: `no ${spec}.apn or ${spec}/ here or in a parent folder of the program${standard}` };
}

/**
 * The file load "name" reads from code in directory: name.apn relative to it
 * (or absolute), normalised; a virtual path when reading from a bundle.
 */
export function loadPath(name: string, directory: string, bundle?: Record<string, string>): string {
    const files = bundle ? bundleFiles(bundle) : disk;
    return normal(name.startsWith("/") ? `${name}.apn` : `${absolute(directory, files)}${name}.apn`);
}
/** A loaded file's source, from the disk or a bundle. */
export function readLoad(path: string, bundle?: Record<string, string>): string | undefined {
    return (bundle ? bundleFiles(bundle) : disk).read(path);
}

// A bundled data file, by the path a program names: relative to the program's
// folder (or absolute in the bundle). Text files hold their text; others a data URL.
const bundledPath = (path: string) => new URL(path.startsWith("/") ? path : `${BUNDLE_APP}${path}`, "file:///").pathname;
export function bundledText(bundle: Record<string, string>, path: string): string | undefined {
    const text = bundle[bundledPath(path)];
    return text === undefined || text.startsWith(DATA_URL) ? undefined : text;
}
export function bundledFile(bundle: Record<string, string>, path: string): { text?: string; dataUrl?: string; mime: string } | undefined {
    const key = bundledPath(path), content = bundle[key];
    if (content === undefined || key.endsWith(".apn")) return undefined;
    return content.startsWith(DATA_URL) ? { dataUrl: content, mime: content.slice(5, content.indexOf(";")) } : { text: content, mime: mimeOf(key) };
}
const DATA_URL = "data:";
const MIME: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav",
    otf: "font/otf", ttf: "font/ttf", woff: "font/woff", woff2: "font/woff2",
    json: "application/json", csv: "text/csv", txt: "text/plain",
};
const mimeOf = (path: string) => MIME[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";
// A data file's bundle entry: its text when it is UTF-8 text, else a data URL.
function dataEntry(path: string): string {
    const bytes = Deno.readFileSync(path);
    try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (!text.includes("\0") && !/^(image|video|audio|font)\//.test(mimeOf(path))) return text;
    } catch { /* binary */ }
    let binary = "";
    for (let n = 0; n < bytes.length; n += 0x8000) binary += String.fromCharCode(...bytes.subarray(n, n + 0x8000));
    return `${DATA_URL}${mimeOf(path)};base64,${btoa(binary)}`;
}

// The literal module names a program imports, the literal paths it loads, the
// string literals it uses (any may name a data file), and whether it mentions
// load any other way (a computed path).
function dependenciesOf(source: string, label: string): { imports: string[]; loads: string[]; strings: string[]; computed: boolean } {
    const imports: string[] = [], loads: string[] = [], strings: string[] = [];
    let mentions = 0;
    const isLoad = (f: unknown) => !!f && typeof f === "object" && (f as Record<string, unknown>).t === "var" && (f as { name: string }).name === "load";
    const walk = (node: unknown): void => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        const n = node as Record<string, any>;
        if (isLoad(n)) mentions++;
        if (n.t === "import") imports.push(n.module as string);
        if (n.t === "app" && isLoad(n.f) && n.a?.t === "string") loads.push(n.a.v);
        if (n.t === "pipe" && isLoad(n.f) && n.x?.t === "string") loads.push(n.x.v);
        if (n.t === "string" && typeof n.v === "string" && n.v && !n.v.includes("\n")) strings.push(n.v);
        Object.values(n).forEach(walk);
    };
    walk(parse(source, label));
    return { imports, loads, strings, computed: mentions > loads.length };
}

/**
 * A bundle for a program in directory: the whole standard library under
 * BUNDLE_LIB, and every local module the program imports and every file it
 * loads by a literal path (and, in turn, theirs), under BUNDLE_APP at the same
 * relative paths. A load of a computed path may read any file, so once one
 * appears every .apn file in the program's folder and its subfolders (except
 * hidden ones) is bundled. A string literal naming another file there (an
 * image, a font, CSV or JSON data) bundles it too, as data (see bundledFile).
 * Run it from BUNDLE_APP. Files outside the program's folder are not bundled.
 */
export function bundleProgram(source: string, directory: string): Record<string, string> {
    const bundle: Record<string, string> = {};
    const addLib = (folder: URL, prefix: string) => {
        for (const entry of Deno.readDirSync(folder)) {
            if (entry.isDirectory) addLib(new URL(`${entry.name}/`, folder), `${prefix}${entry.name}/`);
            else if (entry.name.endsWith(".apn")) bundle[`${BUNDLE_LIB}${prefix}${entry.name}`] = Deno.readTextFileSync(new URL(entry.name, folder));
        }
    };
    addLib(STD_DIRECTORY, "");
    const root = absolute(directory, disk);
    const seen = new Set<string>(), modulesSeen = new Set<string>();
    let everything = false;
    const addAll = (folder: string) => {
        for (const entry of [...Deno.readDirSync(folder)].sort((a, b) => a.name < b.name ? -1 : 1)) {
            if (entry.name.startsWith(".")) continue;
            if (entry.isDirectory) addAll(`${folder}${entry.name}/`);
            else if (entry.isFile && entry.name.endsWith(".apn")) {
                const path = `${folder}${entry.name}`, source = disk.read(path);
                if (source !== undefined) add(path, source);
            }
        }
    };
    const add = (path: string, source: string) => {
        if (seen.has(path) || !path.startsWith(root)) return;
        seen.add(path);
        bundle[`${BUNDLE_APP}${path.slice(root.length)}`] = source;
        visit(source, path, path.slice(0, path.lastIndexOf("/") + 1));
    };
    const visit = (code: string, label: string, from: string) => {
        let dependencies;
        try { dependencies = dependenciesOf(code, label); } catch { return; }
        // A local module's file and, as any may be used, its folder's entries.
        const addModule = (spec: string, directory: string) => {
            const module = resolveModule(spec, directory, undefined, root);
            if (!module || modulesSeen.has(module.key)) return;
            modulesSeen.add(module.key);
            for (const file of module.files) add(file.label, file.source);
            for (const entry of module.entries) addModule(entry.spec, entry.directory);
        };
        for (const spec of dependencies.imports) if (spec !== "std" && !spec.startsWith("std/")) addModule(spec, from);
        for (const name of dependencies.loads) {
            const path = loadPath(name, from), source = disk.read(path);
            if (source !== undefined) add(path, source);
        }
        for (const name of dependencies.strings) {
            if (name.endsWith(".apn")) continue;
            const path = new URL(name, `file://${from}`).pathname;
            if (!path.startsWith(root) || bundle[`${BUNDLE_APP}${path.slice(root.length)}`] !== undefined) continue;
            try { if (!Deno.statSync(path).isFile) continue; } catch { continue; }
            bundle[`${BUNDLE_APP}${path.slice(root.length)}`] = dataEntry(path);
        }
        if (dependencies.computed && !everything) { everything = true; addAll(root); }
    };
    visit(source, "<app>", root);
    return bundle;
}

// Standard modules whose names repeat other modules' (decode.int and
// random.int, svg.circle and playground's circle, parser.string and
// decode.string): a program using both of a pair imports one qualified, so
// they offer no "add import" names.
export const QUALIFIED_MODULES = new Set(["random", "decode", "svg", "parser"]);

// The standard library's exports by name, with the modules defining each:
// top-level names not starting with _, and each module's natives, for
// completion and "add import" hints. The prelude needs no import. Without
// read access to lib/ it is the natives alone.
let standardIndex: Map<string, string[]> | undefined;
export function standardExports(): Map<string, string[]> {
    if (standardIndex) return standardIndex;
    const index = new Map<string, string[]>();
    // Each module by the spec that imports it: std/name.
    const add = (name: string, module: string) => {
        if (/^[A-Za-z]/.test(name) && !METHODS.has(name)) index.set(name, [...new Set([...index.get(name) ?? [], `std/${module}`])]);
    };
    for (const [module, names] of Object.entries(NATIVE_EXPORTS)) names.forEach(name => add(name, module));
    let files: string[] = [];
    try { files = [...Deno.readDirSync(STD_DIRECTORY)].filter(e => e.isFile && e.name.endsWith(".apn")).map(e => e.name).sort(); } catch { /* natives only */ }
    for (const file of files) {
        const module = file.slice(0, -".apn".length);
        if (["prelude", "type", "do"].includes(module) || QUALIFIED_MODULES.has(module)) continue;
        try {
            for (const item of parseDocument(Deno.readTextFileSync(new URL(file, STD_DIRECTORY)))) {
                if (item.t === "def") add(item.name, module);
                if (item.t === "patDef" && item.pattern.p === "var") add(item.pattern.name, module);
                if (item.t === "type") { add(item.def.name, module); item.def.variants.forEach(v => add(v.tag, module)); }
            }
        } catch { /* a module that does not parse alone offers nothing */ }
    }
    return standardIndex = index;
}

// The first standard module exporting name, if any.
export function standardModule(name: string): string | undefined {
    return standardExports().get(name)?.[0];
}
