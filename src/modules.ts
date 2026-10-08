// Where `import "name"` finds its code. Next to the importing file (the
// current directory in the REPL): name.apn, else every .apn file directly in
// a name/ folder (subfolders are imported as name/sub). Otherwise the standard
// library, found the same way under lib/. Standard modules take no prefix and
// there is no whole-library module: "std" and "std/name" are errors.
//
// The files come from the disk, or from a bundle (a browser build): a map
// from virtual paths to sources, with the standard library under BUNDLE_LIB
// and the program's own directory at BUNDLE_APP.

import { parse } from "./parser.ts";

export const STD_DIRECTORY = new URL("../lib/", import.meta.url);
export const BUNDLE_LIB = "/lib/";
export const BUNDLE_APP = "/app/";

/** One file of a module: its source, a label for errors, and its directory. */
export interface ModuleFile { source: string; label: string; directory: string; std?: string }
/** A resolved module: a cache key (its path) and its files, in import order. */
export interface ResolvedModule { key: string; files: ModuleFile[] }

const NAME = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;

// Reading files and listing a folder's .apn files, by absolute path.
interface Files { read(path: string): string | undefined; list(folder: string): string[] | undefined; lib: string }

const disk: Files = {
    read(path) {
        try { return Deno.readTextFileSync(path); } catch { return undefined; }
    },
    list(folder) {
        try { return [...Deno.readDirSync(folder)].filter(entry => entry.isFile && entry.name.endsWith(".apn")).map(entry => entry.name); }
        catch { return undefined; }
    },
    lib: STD_DIRECTORY.pathname,
};
function bundleFiles(bundle: Record<string, string>): Files {
    return {
        read: path => bundle[path],
        list(folder) {
            const names = Object.keys(bundle).filter(path => path.startsWith(folder) && path.endsWith(".apn") && !path.slice(folder.length).includes("/"));
            return names.length ? names.map(path => path.slice(folder.length)) : undefined;
        },
        lib: BUNDLE_LIB,
    };
}
const asFolder = (directory: string) => directory.endsWith("/") ? directory : `${directory}/`;
function absolute(directory: string, files: Files): string {
    if (files !== disk || directory.startsWith("/")) return asFolder(directory);
    return new URL(asFolder(directory), `file://${Deno.cwd()}/`).pathname;
}

// name.apn, else name/*.apn, under the folder base.
function find(files: Files, base: string, name: string, std: boolean): ResolvedModule | undefined {
    const tag = (label: string) => std ? { std: label } : {};
    const path = `${base}${name}.apn`, source = files.read(path);
    if (source !== undefined) return { key: path, files: [{ source, label: std ? name : path, directory: path.slice(0, path.lastIndexOf("/") + 1), ...tag(name) }] };
    const folder = `${base}${name}/`;
    const names = files.list(folder)?.sort();
    if (!names?.length) return undefined;
    return {
        key: folder,
        files: names.map(file => {
            const label = `${name}/${file.slice(0, -4)}`;
            return { source: files.read(folder + file)!, label: std ? label : folder + file, directory: folder, ...tag(label) };
        }),
    };
}

/** Resolve an import from code in directory, from the disk or a bundle. */
export function resolveModule(spec: string, directory: string, bundle?: Record<string, string>): ResolvedModule | undefined {
    if (!NAME.test(spec) || spec === "std" || spec.startsWith("std/")) return undefined;
    const files = bundle ? bundleFiles(bundle) : disk;
    const local = find(files, absolute(directory, files), spec, false);
    // Inside the standard library, local modules are the library's own.
    if (local) return local.key.startsWith(files.lib) ? find(files, files.lib, spec, true) : local;
    return find(files, files.lib, spec, true);
}

/** Why an import could not be resolved, with a hint. */
export function unknownModule(spec: string, bundled = false): { message: string; hint: string } {
    if (spec === "std") return { message: "unknown module 'std'", hint: 'import the standard modules you need, such as import "option" or import ["option","text"]' };
    if (spec.startsWith("std/")) return { message: `unknown module '${spec}'`, hint: `standard modules take no prefix: import "${spec.slice(4)}"` };
    if (bundled) return { message: `module '${spec}' is not bundled`, hint: "a browser build bundles the standard library and the local modules the program imports" };
    return { message: `unknown module '${spec}'`, hint: `no ${spec}.apn or ${spec}/ next to this file, and no standard module '${spec}'` };
}

// The literal module names a program imports.
function importsOf(source: string, label: string): string[] {
    const names: string[] = [];
    const walk = (node: unknown): void => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        const n = node as Record<string, unknown>;
        if (n.t === "import") names.push(...[n.module as string | string[]].flat());
        Object.values(n).forEach(walk);
    };
    walk(parse(source, label));
    return names;
}

/**
 * A bundle for a program in directory: the whole standard library under
 * BUNDLE_LIB and every local module the program imports (and they import),
 * under BUNDLE_APP at the same relative paths. Run it from BUNDLE_APP.
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
    const seen = new Set<string>();
    const visit = (code: string, label: string, from: string) => {
        for (const spec of importsOf(code, label)) {
            const module = resolveModule(spec, from);
            if (!module || seen.has(module.key) || module.files.some(file => file.std)) continue;
            seen.add(module.key);
            for (const file of module.files) {
                const path = file.label;
                if (!path.startsWith(root)) continue;
                bundle[`${BUNDLE_APP}${path.slice(root.length)}`] = file.source;
                visit(file.source, path, file.directory);
            }
        }
    };
    visit(source, "<app>", root);
    return bundle;
}
