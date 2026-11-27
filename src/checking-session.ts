import { APNError } from "./errors.ts";
import { parse } from "./parser.ts";
import { inLibrary, loadPath, readLoad, resolveModule, unknownModule } from "./modules.ts";
import { type CheckOptions, checkTypes, type LocalName, dynamicEntry, importedValue, mayMutate, moduleType, moduleValue, recursiveValue, settleRecursive, type TypeBridge, type TypeIssue, type TypeScope } from "./type-checker.ts";
import { type Expr, type TopLevel } from "./ast.ts";
type Ty = ReturnType<typeof moduleValue>;

/** Static state is separate from evaluation: checking never runs an APN action. */
export class CheckingSession {
    private scope: TypeScope = new Map();
    // Each file's or folder's value, by its path (see moduleValue).
    private modules = new Map<string, Ty>();
    private loading = new Set<string>();
    // The loads of a file made while it is checked (it loads itself), by its path.
    private recursive = new Map<string, Ty[]>();
    // A bundle (a browser build) to import from instead of the disk: virtual
    // paths to sources (see bundleProgram in modules.ts).
    moduleSources?: Record<string, string>;
    // Instances of map, >>=, <*> and return the session's programs and modules define.
    instances = new Map<string, unknown[]>();
    // Declared families' parameters kept apart in unions (see CheckOptions).
    invariance = new Map<string, Set<number>>();
    // Clauses' inferred result types, for overloads chosen by result type.
    resultHeads = new Map<string, string>();
    // Types of values and typed patterns by source position, and the newest
    // check's acceptance test (see CheckOptions.valueTypes).
    valueTypes = new Map<string, unknown>();
    // Calls that give a named subtype's name back (CheckOptions.keptTypes).
    keptTypes = new Map<string, unknown>();
    patternTypes = new WeakMap<Expr, unknown>();
    bridge?: TypeBridge;
    // Names defined in local scopes so far (see CheckOptions.localNames).
    private localNames = new Map<string, LocalName | undefined>();
    /** Names the interpreter can resolve, so the checker can tell a typo from a runtime-only builtin. */
    runtimeNames?: () => Iterable<string>;
    /** The program's input when checking right before a run (see CheckOptions.inputs). */
    inputs?: CheckOptions["inputs"];

    prepare(program: TopLevel[], directory = ".", root = directory, file = false): TypeScope {
        // The program's folder: imports search up to it (see resolveModule).
        this.root = root;
        return this.check(program, directory, this.scope, false, undefined, file).scope;
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
        this.check(program, directory, saved, false, { index, scope: scope => { before = scope; } }, false);
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
    /** Programs sharing a scope (the REPL's inputs, loaded files) that used use
     * on a record of unknown fields. */
    private opaqueUses = new Set<TopLevel[]>();

    private check(program: TopLevel[], directory: string, initial: TypeScope, library: boolean, before?: CheckOptions["before"], file = true): { scope: TypeScope; exports: TypeScope; value?: Ty } {
        this.mutation ||= mayMutate(program);
        let scope: TypeScope = new Map();
        let exports: TypeScope = new Map();
        let value: Ty | undefined;
        const result = checkTypes(program, {
            ...this.options(program, directory, library), strict: true, initial, before, file,
            result: (bound, published, last) => { scope = bound; exports = published; value = last; },
        });
        // A module's [..] opens names in its own scope, which no other program shares.
        if (result.opaqueUse && !library) this.opaqueUses.add(program);
        if (result.issues.length) {
            const issue = result.issues[0];
            const error = new APNError("type", issue.message, issue);
            error.src = issue.source;
            throw error;
        }
        return { scope, exports, value };
    }

    // Every issue a run's check of a program finds, not only its first: the
    // linter's. A file linted alone may be a module of a program further up,
    // so its imports search every parent folder; a standard library file is
    // checked as an import of it is.
    issues(program: TopLevel[], directory = "."): TypeIssue[] {
        this.root = "/";
        this.mutation ||= mayMutate(program);
        const library = inLibrary(directory, this.moduleSources);
        const { issues } = checkTypes(program, { ...this.options(program, directory, library), strict: true, ...library ? { file: false } : {} });
        // A contradiction met twice (by its statement, then by a check left to
        // the end) is one issue.
        return issues.filter((issue, n) => issues.findIndex(other => other.pos === issue.pos && other.message === issue.message) === n);
    }

    // What every check of a program in this session shares.
    private options(program: TopLevel[], directory: string, library: boolean): CheckOptions {
        return {
            library,
            runtimeNames: !library && this.runtimeNames ? new Set(this.runtimeNames()) : undefined,
            inputs: library ? undefined : this.inputs,
            localNames: library ? undefined : this.localNames,
            mutation: () => this.mutation,
            openedElsewhere: () => [...this.opaqueUses].some(p => p !== program),
            instances: this.instances,
            invariance: this.invariance,
            resultHeads: this.resultHeads,
            valueTypes: this.valueTypes,
            keptTypes: this.keptTypes,
            patternTypes: this.patternTypes,
            bridge: bridge => { this.bridge = bridge; },
            imports: module => this.module(module, directory),
            loads: path => this.load(path, directory),
        };
    }

    // The value of the module spec names from directory, its own copy for this
    // import: a file's (its last statement's), or a folder's record of its
    // entries, each checked when first read.
    module(module: string, directory = "."): Ty {
        const resolved = resolveModule(module, directory, this.moduleSources, this.root);
        if (!resolved) { const { message, hint } = unknownModule(module, !!this.moduleSources); throw new APNError("type", message, { hint }); }
        const known = this.modules.get(resolved.key);
        if (known) return importedValue(known);
        if (this.loading.has(resolved.key)) throw new APNError("type", `cyclic import '${module}'`);
        this.loading.add(resolved.key);
        try {
            let value: Ty;
            if (resolved.files.length) {
                const [file] = resolved.files;
                // (Its last statement is its value, not an action of its block.)
                value = moduleValue(this.check(parse(file.source, file.label), file.directory, new Map(), true, undefined, false).value);
            } else {
                const entries: TypeScope = new Map();
                for (const entry of resolved.entries) {
                    let type: Ty | undefined;
                    entries.set(entry.name, Object.defineProperty({}, "type", {
                        enumerable: true, get: () => type ??= this.module(entry.spec, entry.directory), set: (t: Ty) => { type = t; },
                    }) as ReturnType<typeof dynamicEntry>);
                }
                value = moduleType(() => entries);
            }
            this.modules.set(resolved.key, value);
            return importedValue(value);
        } catch (error) {
            if (error instanceof APNError && !error.message.startsWith(`${module}: `)) error.message = `${module}: ${error.message}`;
            throw error;
        } finally { this.loading.delete(resolved.key); }
    }

    // The value of the file load name runs from directory: its last statement's,
    // checked in a scope of its own.
    load(name: string, directory: string): Ty {
        const key = loadPath(name, directory, this.moduleSources);
        const known = this.modules.get(key);
        if (known) return importedValue(known);
        // A file loading itself (or one loading it) is recursion, as a function's
        // call of itself is: its value there is the one the file turns out to have.
        if (this.loading.has(key)) {
            const placeholder = recursiveValue();
            this.recursive.get(key)?.push(placeholder);
            return placeholder;
        }
        this.loading.add(key);
        this.recursive.set(key, []);
        try {
            const source = readLoad(key, this.moduleSources);
            if (source === undefined) {
                throw new APNError("type", this.moduleSources ? `load '${name}' is not bundled` : `load: cannot read '${name}' (looked in '${key}')`,
                    this.moduleSources ? { hint: "a browser build bundles only files inside the program's folder" } : {});
            }
            const value = moduleValue(this.check(parse(source, key), key.slice(0, key.lastIndexOf("/") + 1), new Map(), true, undefined, false).value);
            for (const placeholder of this.recursive.get(key) ?? []) {
                const problem = settleRecursive(placeholder, value);
                if (problem) throw new APNError("type", `load '${name}': ${problem}`);
            }
            this.modules.set(key, value);
            return importedValue(value);
        } finally { this.loading.delete(key); this.recursive.delete(key); }
    }
}
