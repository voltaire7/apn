import { APNError } from "./errors.ts";
import { parse } from "./parser.ts";
import { type CheckOptions, checkTypes, copyTypeScope, mayMutate, type TypeScope } from "./type-checker.ts";
import type { TopLevel } from "./ast.ts";

const moduleNames = new Set(["type", "function", "option", "sequence", "array", "number", "text", "map", "meta", "combinator", "io", "search", "html", "browser", "system", "p5", "ffi"]);
const nativeExports: Record<string, string[]> = {
    ffi: ["withLibrary", "allocate", "peek", "poke", "offset", "nullPointer"],
    io: ["withFile", "readFile", "readStdin", "getArgs"],
    function: ["bracket", "fail", "seq", "do"],
    text: ["chars", "fromChars", "upper", "lower"],
};
/** Static state is separate from evaluation: checking never runs an APN action. */
export class CheckingSession {
    private scope: TypeScope = new Map();
    private modules = new Map<string, TypeScope>();
    private loading = new Set<string>();
    private checkedLoads = new Map<string, string>();

    verifyLoad(name: string, directory: string, source: string): void {
        const path = name.startsWith("/") ? `${name}.apn` : `${directory}/${name}.apn`;
        const url = new URL(path, `file://${Deno.cwd()}/`);
        if (this.checkedLoads.get(url.href) !== source) throw new APNError("type", `load '${name}' was not checked with this source; resubmit its definition or use Dynamic for runtime loading`);
    }
    moduleSources?: Record<string, string>;
    extendDefinitions = false;
    /** Names the interpreter can resolve, so the checker can tell a typo from a runtime-only builtin. */
    runtimeNames?: () => Iterable<string>;
    /** The program's input when checking right before a run (see CheckOptions.inputs). */
    inputs?: CheckOptions["inputs"];

    prepare(program: TopLevel[], directory = "."): TypeScope {
        return this.check(program, directory, this.scope, false).scope;
    }

    commit(candidate: TypeScope, visible: Set<string>): void {
        this.scope = new Map([...candidate].filter(([name]) => visible.has(name)));
    }

    /** Whether any program this session has checked may write a Mutable cell. */
    private mutation = false;

    private check(program: TopLevel[], directory: string, initial: TypeScope, library: boolean): { scope: TypeScope; exports: TypeScope } {
        this.mutation ||= mayMutate(program);
        let scope: TypeScope = new Map();
        let exports: TypeScope = new Map();
        const result = checkTypes(program, {
            strict: true, initial, library, extendDefinitions: this.extendDefinitions,
            runtimeNames: !library && this.runtimeNames ? new Set(this.runtimeNames()) : undefined,
            inputs: library ? undefined : this.inputs,
            mutation: () => this.mutation,
            imports: module => {
                const fields = this.module(module);
                return fields;
            },
            loads: (path, caller) => {
                const fields = this.load(path, directory, caller);
                return fields;
            },
            result: (value, published) => { scope = value; exports = published; },
        });
        if (result.issues.length) {
            const issue = result.issues[0];
            const error = new APNError("type", issue.message, issue);
            error.src = issue.source;
            throw error;
        }
        return { scope, exports };
    }

    module(module: string | string[]): TypeScope {
        if (Array.isArray(module)) {
            const fields: TypeScope = new Map();
            for (const item of module) for (const [name, value] of this.module(item)) fields.set(name, value);
            return fields;
        }
        if (this.modules.has(module)) return copyTypeScope(this.modules.get(module)!);
        const name = module === "std" ? "std" : module.startsWith("std/") && moduleNames.has(module.slice(4)) ? module.slice(4) : null;
        if (!name) throw new APNError("type", `unknown module '${module}'`);
        if (this.loading.has(module)) throw new APNError("type", `cyclic import '${module}'`);
        this.loading.add(module);
        try {
            const source = this.moduleSources ? this.moduleSources[name] : Deno.readTextFileSync(new URL(`../lib/${name}.apn`, import.meta.url));
            if (source === undefined) throw new APNError("type", `module '${module}' is not bundled`);
            const checked = this.check(parse(source, module), new URL("../lib/", import.meta.url).pathname, new Map(), true);
            for (const key of nativeExports[name] ?? []) {
                const entry = checked.scope.get(key);
                if (entry) checked.exports.set(key, entry);
            }
            for (const entry of checked.exports.values()) { entry.nonGeneric = undefined; entry.mono = false; }
            this.modules.set(module, checked.exports);
            return copyTypeScope(checked.exports);
        } catch (error) {
            if (error instanceof APNError) error.message = `${module}: ${error.message}`;
            throw error;
        } finally { this.loading.delete(module); }
    }

    load(name: string, directory: string, caller = this.scope): TypeScope {
        const base = name.slice(name.lastIndexOf("/") + 1);
        if (!base || base.includes(".")) throw new APNError("type", "load expects an extensionless file name");
        const path = name.startsWith("/") ? `${name}.apn` : `${directory}/${name}.apn`;
        const url = new URL(path, `file://${Deno.cwd()}/`);
        const key = url.href;
        if (this.loading.has(key)) throw new APNError("type", `cyclic load '${name}'; use an explicit Dynamic boundary for runtime loading`);
        this.loading.add(key);
        try {
            const source = Deno.readTextFileSync(url);
            const exports = this.check(parse(source, url.pathname), new URL(".", url).pathname, copyTypeScope(caller), false).exports;
            this.checkedLoads.set(key, source);
            return exports;
        } catch (error) {
            if (error instanceof APNError) throw error;
            throw new APNError("type", `load: cannot check '${name}': ${String(error)}`);
        } finally { this.loading.delete(key); }
    }
}
