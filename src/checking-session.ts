import { APNError } from "./errors.ts";
import { parse } from "./parser.ts";
import { loadPath, readLoad, resolveModule, unknownModule } from "./modules.ts";
import { type CheckOptions, checkTypes, copyTypeScope, dynamicEntry, mayMutate, type TypeScope } from "./type-checker.ts";
import type { TopLevel } from "./ast.ts";
import { NATIVE_EXPORTS } from "./native-exports.ts";

/** Static state is separate from evaluation: checking never runs an APN action. */
// A module file's name within its package, for messages.
function fileName(label: string): string {
    return label.slice(label.lastIndexOf("/") + 1).replace(/\.apn$/, "") + ".apn";
}

export class CheckingSession {
    private scope: TypeScope = new Map();
    private modules = new Map<string, TypeScope>();
    private loading = new Set<string>();
    private checkedLoads = new Map<string, string>();

    verifyLoad(name: string, directory: string, source: string): void {
        if (this.checkedLoads.get(loadPath(name, directory, this.moduleSources)) !== source) throw new APNError("type", `load '${name}' was not checked with this source; resubmit its definition or use Dynamic for runtime loading`);
    }
    // A bundle (a browser build) to import from instead of the disk: virtual
    // paths to sources (see bundleProgram in modules.ts).
    moduleSources?: Record<string, string>;
    // Instances of map, >>=, <*> and return the session's programs and modules define.
    instances = new Map<string, unknown[]>();
    // Declared families' parameters kept apart in unions (see CheckOptions).
    invariance = new Map<string, Set<number>>();
    // Clauses' inferred result types, for overloads chosen by result type.
    resultHeads = new Map<string, string>();
    moduleStatements = new Set<string>();
    /** Names the interpreter can resolve, so the checker can tell a typo from a runtime-only builtin. */
    runtimeNames?: () => Iterable<string>;
    /** The program's input when checking right before a run (see CheckOptions.inputs). */
    inputs?: CheckOptions["inputs"];

    prepare(program: TopLevel[], directory = ".", root = directory): TypeScope {
        // The program's folder: imports search up to it (see resolveModule).
        this.root = root;
        return this.check(program, directory, this.scope, false).scope;
    }
    private root?: string;

    commit(candidate: TypeScope, visible: Set<string>): void {
        this.scope = new Map([...candidate].filter(([name]) => visible.has(name)));
    }

    // A REPL session inside a run (repl) checks against the program's types
    // before its statement at index, of the visible names the run has bound
    // there, and types each local as the literal of its value or as Dynamic
    // (null; see Interpreter.sessionNames). The returned function ends the
    // session, restoring the session's scope.
    enter(program: TopLevel[], index: number, directory: string, visible: Set<string>, locals: Map<string, string | null>): () => void {
        const saved = this.scope;
        let before: TypeScope = new Map();
        this.check(program, directory, saved, false, { index, scope: scope => { before = scope; } });
        const scope = new Map([...before].filter(([name]) => visible.has(name)));
        for (const [name, source] of locals) scope.set(name, this.literal(name, source, scope) ?? dynamicEntry());
        this.scope = scope;
        return () => { this.scope = saved; };
    }
    private literal(name: string, source: string | null, scope: TypeScope): ReturnType<typeof dynamicEntry> | undefined {
        if (source === null) return undefined;
        try { return this.check(parse(`${name} = ${source}`), ".", scope, false).scope.get(name); }
        catch { return undefined; }
    }

    /** Whether any program this session has checked may write a Mutable cell. */
    private mutation = false;
    /** Programs that used use on a record of unknown fields. */
    private opaqueUses = new Set<TopLevel[]>();

    private check(program: TopLevel[], directory: string, initial: TypeScope, library: boolean, before?: CheckOptions["before"]): { scope: TypeScope; exports: TypeScope } {
        this.mutation ||= mayMutate(program);
        let scope: TypeScope = new Map();
        let exports: TypeScope = new Map();
        const result = checkTypes(program, {
            strict: true, initial, library, before,
            runtimeNames: !library && this.runtimeNames ? new Set(this.runtimeNames()) : undefined,
            inputs: library ? undefined : this.inputs,
            mutation: () => this.mutation,
            openedElsewhere: () => [...this.opaqueUses].some(p => p !== program),
            instances: this.instances,
            invariance: this.invariance,
            resultHeads: this.resultHeads,
            moduleStatements: this.moduleStatements,
            loadedNames: path => this.loadedNames(path, directory),
            imports: module => {
                const fields = this.module(module, directory);
                return fields;
            },
            loads: (path, caller, tail) => {
                const fields = this.load(path, directory, caller, tail);
                return fields;
            },
            result: (value, published) => { scope = value; exports = published; },
        });
        if (result.opaqueUse) this.opaqueUses.add(program);
        if (result.issues.length) {
            const issue = result.issues[0];
            const error = new APNError("type", issue.message, issue);
            error.src = issue.source;
            throw error;
        }
        return { scope, exports };
    }

    module(module: string | string[], directory = "."): TypeScope {
        if (Array.isArray(module)) {
            const fields: TypeScope = new Map();
            for (const item of module) for (const [name, value] of this.module(item, directory)) fields.set(name, value);
            return fields;
        }
        const resolved = resolveModule(module, directory, this.moduleSources, this.root);
        if (!resolved) { const { message, hint } = unknownModule(module, !!this.moduleSources); throw new APNError("type", message, { hint }); }
        if (this.modules.has(resolved.key)) return copyTypeScope(this.modules.get(resolved.key)!);
        if (this.loading.has(resolved.key)) throw new APNError("type", `cyclic import '${module}'`);
        this.loading.add(resolved.key);
        try {
            // A folder's files are modules of their own; their exports merge.
            const exports: TypeScope = new Map(), from = new Map<string, string>();
            for (const file of resolved.files) {
                const checked = this.check(parse(file.source, file.label), file.directory, new Map(), true);
                for (const key of file.std ? NATIVE_EXPORTS[file.std] ?? [] : []) {
                    const entry = checked.scope.get(key);
                    if (entry) checked.exports.set(key, entry);
                }
                for (const [name, entry] of checked.exports) {
                    if (from.has(name) && resolved.files.length > 1) throw new APNError("type", `'${name}' is defined by both ${from.get(name)} and ${fileName(file.label)}`);
                    entry.nonGeneric = undefined; entry.mono = false;
                    exports.set(name, entry);
                    from.set(name, fileName(file.label));
                }
            }
            this.modules.set(resolved.key, exports);
            return copyTypeScope(exports);
        } catch (error) {
            if (error instanceof APNError && !error.message.startsWith(`${module}: `)) error.message = `${module}: ${error.message}`;
            throw error;
        } finally { this.loading.delete(resolved.key); }
    }

    /** Every variable name a checked loaded file mentions (see CheckOptions.loadedNames). */
    loadedNames(name: string, directory: string): Set<string> | undefined {
        const path = loadPath(name, directory, this.moduleSources);
        // A statement's static run precedes checking it: read the file it loads.
        const source = this.checkedLoads.get(path) ?? readLoad(path, this.moduleSources);
        if (source === undefined) return undefined;
        const names = new Set<string>();
        const walk = (node: unknown): void => {
            if (!node || typeof node !== "object") return;
            if (Array.isArray(node)) { node.forEach(walk); return; }
            const n = node as Record<string, unknown>;
            if (n.t === "var" && typeof n.name === "string") names.add(n.name);
            Object.values(n).forEach(value => value && typeof value === "object" && walk(value));
        };
        walk(parse(source, path));
        return names;
    }
    // A tail load (a program's last statement) may load a file already being
    // checked: the runtime replaces the running file with it, so it binds
    // nothing new where it stands.
    load(name: string, directory: string, caller = this.scope, tail = false): TypeScope {
        const base = name.slice(name.lastIndexOf("/") + 1);
        if (!base || base.includes(".")) throw new APNError("type", "load expects an extensionless file name");
        const key = loadPath(name, directory, this.moduleSources);
        if (this.loading.has(key) && tail) return new Map();
        if (this.loading.has(key)) throw new APNError("type", `cyclic load '${name}'; use an explicit Dynamic boundary for runtime loading`);
        this.loading.add(key);
        try {
            const source = readLoad(key, this.moduleSources);
            if (source === undefined) {
                throw new APNError("type", this.moduleSources ? `load '${name}' is not bundled` : `load: cannot read '${name}' (looked in '${key}')`,
                    this.moduleSources ? { hint: "a browser build bundles only files inside the program's folder" } : {});
            }
            const exports = this.check(parse(source, key), key.slice(0, key.lastIndexOf("/") + 1), copyTypeScope(caller), false).exports;
            this.checkedLoads.set(key, source);
            return exports;
        } catch (error) {
            if (error instanceof APNError) throw error;
            throw new APNError("type", `load: cannot check '${name}': ${String(error)}`);
        } finally { this.loading.delete(key); }
    }
}
