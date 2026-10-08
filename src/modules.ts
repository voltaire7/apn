// Where `import "name"` finds its code. Next to the importing file (the
// current directory in the REPL): name.apn, else every .apn file directly in
// a name/ folder (subfolders are imported as name/sub). Otherwise the standard
// library, found the same way under lib/. Standard modules take no prefix and
// there is no whole-library module: "std" and "std/name" are errors.

export const STD_DIRECTORY = new URL("../lib/", import.meta.url);

/** One file of a module: its source, a label for errors, and its directory. */
export interface ModuleFile { source: string; label: string; directory: string; std?: string }
/** A resolved module: a cache key (its path) and its files, in import order. */
export interface ResolvedModule { key: string; files: ModuleFile[] }

const NAME = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;

function readFile(url: URL): string | undefined {
    try { return Deno.readTextFileSync(url); } catch { return undefined; }
}
function folderFiles(url: URL): string[] | undefined {
    try {
        return [...Deno.readDirSync(url)].filter(entry => entry.isFile && entry.name.endsWith(".apn")).map(entry => entry.name).sort();
    } catch { return undefined; }
}
function directoryUrl(directory: string): URL {
    return new URL(directory.endsWith("/") ? directory : `${directory}/`, `file://${Deno.cwd()}/`);
}

// name.apn, else name/*.apn, under base.
function find(base: URL, name: string, std: boolean): ResolvedModule | undefined {
    const file = new URL(`${name}.apn`, base);
    const source = readFile(file);
    const tag = (label: string) => std ? { std: label } : {};
    if (source !== undefined) {
        return { key: file.href, files: [{ source, label: std ? name : file.pathname, directory: new URL(".", file).pathname, ...tag(name) }] };
    }
    const folder = new URL(`${name}/`, base);
    const names = folderFiles(folder);
    if (!names?.length) return undefined;
    return {
        key: folder.href,
        files: names.map(file => {
            const label = `${name}/${file.slice(0, -4)}`;
            return { source: Deno.readTextFileSync(new URL(file, folder)), label: std ? label : new URL(file, folder).pathname, directory: folder.pathname, ...tag(label) };
        }),
    };
}

/**
 * Resolve an import from code in directory. With bundled sources (a browser
 * build) only the standard library's top-level modules exist.
 */
export function resolveModule(spec: string, directory: string, bundled?: Record<string, string>): ResolvedModule | undefined {
    if (!NAME.test(spec) || spec === "std" || spec.startsWith("std/")) return undefined;
    if (bundled) {
        const source = bundled[spec];
        return source === undefined ? undefined : { key: `std:${spec}`, files: [{ source, label: spec, directory: STD_DIRECTORY.pathname, std: spec }] };
    }
    const local = find(directoryUrl(directory), spec, false);
    // Inside the standard library, local modules are the library's own.
    if (local) return local.key.startsWith(STD_DIRECTORY.href) ? find(STD_DIRECTORY, spec, true) : local;
    return find(STD_DIRECTORY, spec, true);
}

/** Why an import could not be resolved, with a hint. */
export function unknownModule(spec: string, bundled = false): { message: string; hint: string } {
    if (spec === "std") return { message: "unknown module 'std'", hint: 'import the standard modules you need, such as import "option" or import ["option","text"]' };
    if (spec.startsWith("std/")) return { message: `unknown module '${spec}'`, hint: `standard modules take no prefix: import "${spec.slice(4)}"` };
    if (bundled) return { message: `module '${spec}' is not bundled`, hint: "a browser build bundles the standard library only" };
    return { message: `unknown module '${spec}'`, hint: `no ${spec}.apn or ${spec}/ next to this file, and no standard module '${spec}'` };
}
