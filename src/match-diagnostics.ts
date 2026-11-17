import { clausePlaces, importedPath, isLoadCall, matchOperands, sourceLocations, takesAll, type Expr, type Pattern, type TopLevel } from "./ast.ts";
import type { Diagnostic } from "./lint.ts";
import { builtinContains } from "./type-system.ts";
import { loadPath, readLoad, resolveModule } from "./modules.ts";
import { parseDocument } from "./parser.ts";

// This analysis never evaluates APN. Unknown families or dynamic handler lists
// are left to runtime matching; guards cannot establish total coverage. The
// families it knows are the program's and those the modules it imports and the
// files it loads declare (resolved from directory, as the interpreter resolves
// them, and read only).
export function matchDiagnostics(program: TopLevel[], source: string, directory = "."): Diagnostic[] {
    const families = new Map<string, Map<string, number>>();
    const parameters = new Map<string, number>();
    const constructors = new Map<string, string>();
    const add = (name: string, count: number, variants: Array<[string, number]>) => {
        families.set(name, new Map(variants));
        parameters.set(name, count);
        for (const [tag] of variants) constructors.set(tag, name);
    };
    // A module's files, by the path an import names, from a file's folder.
    const moduleSources = (spec: string, from: string): Source[] => {
        let module;
        try { module = resolveModule(spec, from); } catch { return []; }
        return module ? module.files.map((file, n) => ({ key: `${module.key}#${n}`, text: file.source, directory: file.directory })) : [];
    };
    // The files an expression brings in: a module it imports or a file it
    // loads (also through Dynamic), resolved from a file's folder.
    type Source = { key: string; text: string; directory: string };
    const sourcesOf = (e: Expr, from: string): Source[] => {
        if (e.t === "block" && e.style === "(" && e.stmts.length === 1) return sourcesOf(e.stmts[0], from);
        if ((e.t === "app" || e.t === "pipe") && e.f.t === "var" && e.f.name === "Dynamic") return sourcesOf(e.t === "app" ? e.a : e.x, from);
        const imported = importedPath(e);
        if (imported) return moduleSources(imported, from);
        const argument = isLoadCall(e) && (e.t === "app" ? e.a : e.t === "pipe" ? e.x : undefined);
        if (!argument || argument.t !== "string") return [];
        let path;
        try { path = loadPath(argument.v, from); } catch { return []; }
        const text = readLoad(path);
        return text === undefined ? [] : [{ key: path, text, directory: path.slice(0, path.lastIndexOf("/") + 1) }];
    };
    // A file's families, and those of what it imports, loads, or opens with
    // use: a record bound to an import or a load, either written in place, or
    // a list of them.
    const visited = new Set<string>();
    const declare = (statements: TopLevel[], from: string) => {
        // A name's sources, and the import path it names (std's entries are std/name).
        const records = new Map<string, { sources: Source[]; spec?: string }>();
        const open = (sources: Source[]) => {
            for (const source of sources) {
                if (visited.has(source.key)) continue;
                visited.add(source.key);
                let parsed;
                try { parsed = parseDocument(source.text); } catch { continue; }
                declare(parsed, source.directory);
            }
        };
        const specOf = (e: Expr) => e.t === "var" ? records.get(e.name)?.spec : undefined;
        const used = (e: Expr): Source[] => e.t === "var" ? records.get(e.name)?.sources ?? []
            : e.t === "list" ? e.v.flatMap(used)
            : e.t === "recordAccess" && !e.scoped && specOf(e.rec) ? moduleSources(`${specOf(e.rec)}/${e.field}`, from)
            : e.t === "pluck" && specOf(e.rec) ? e.entries.flatMap(entry => typeof entry === "string" ? moduleSources(`${specOf(e.rec)}/${entry}`, from) : [])
            : sourcesOf(e, from);
        for (const node of statements) {
            if (node.t === "type") add(node.def.name, node.def.parameters?.length ?? 0, node.def.variants.map(v => [v.tag, v.arity]));
            const bound = node.t === "def" && !node.clauses[0].params.length ? [node.name, node.clauses[0].body] as const
                : node.t === "patDef" && node.pattern.p === "var" ? [node.pattern.name, node.value] as const : undefined;
            if (bound) records.set(bound[0], { sources: sourcesOf(bound[1], from), spec: importedPath(bound[1]) });
            if (node.t !== "expr") continue;
            const e = node.value;
            // Only use opens records.
            if (e.t === "app" && e.f.t === "var" && e.f.name === "use") open(used(e.a));
            // A record (a module's value) declares its types, and spreads what its uses open.
            if (e.t === "record") for (const item of e.items ?? []) {
                if (item.t === "typeDef") add(item.def.name, item.def.parameters?.length ?? 0, item.def.variants.map(v => [v.tag, v.arity]));
                if (item.t === "app" && item.f.t === "var" && item.f.name === "use") open(used(item.a));
            }
        }
    };
    declare(program, directory);
    type Scope = Map<string, string | undefined>;
    const diagnostics: Diagnostic[] = [];
    const pos = (offset: number) => {
        const lines = source.slice(0, offset).split("\n");
        return { line: lines.length - 1, character: lines.at(-1)!.length };
    };
    const bind = (pattern: Pattern, scope: Scope) => {
        if (pattern.p === "var") scope.set(pattern.name, undefined);
        else if (pattern.p === "typeBind") { scope.set(pattern.name, undefined); bind(pattern.value, scope); }
        else if (pattern.p === "constr") {
            for (const arg of pattern.args) bind(arg, scope);
            // (Option _ value): the pattern after the type's parameters is its value.
            const value = pattern.args[parameters.get(pattern.tag) ?? -1];
            if (families.has(pattern.tag) && pattern.args.length === parameters.get(pattern.tag)! + 1 && value.p === "var") scope.set(value.name, pattern.tag);
        } else {
            for (const value of Object.values(pattern)) {
                if (value && typeof value === "object" && "p" in value) bind(value as Pattern, scope);
                if (Array.isArray(value)) for (const item of value) if (item && typeof item === "object" && "p" in item) bind(item as Pattern, scope);
            }
        }
    };
    const familyOf = (e: Expr, scope: Scope): string | undefined => {
        if (e.t === "var") return scope.has(e.name) ? scope.get(e.name) : constructors.get(e.name);
        if (e.t === "app") return familyOf(e.f, scope);
        return undefined;
    };
    const irrefutable = (p: Pattern) => p.p === "wildcard" || p.p === "var";
    const lineOf = (e: Expr) => { const at = sourceLocations.get(e); return at && pos(at.start); };
    const unreachable = (at: { line: number; character: number } | undefined, message: string) => {
        if (at) diagnostics.push({ range: { start: { line: at.line, character: 0 }, end: at }, severity: 2, source: "apn", code: "unreachable-clause", message });
    };
    // Clauses are tried most specific first (see clausePlaces): one never runs
    // only when one tried before it takes every argument it does. Among a
    // function's clauses that is an equivalent one, which replaces it; among a
    // match's alternatives, both stay, and the later never runs.
    type Clause = { params: Pattern[]; body: Expr; guard?: Expr };
    const visit = (e: Expr, scope: Scope) => {
        const written = matchOperands(e);
        if (written?.head === "~" && !scope.has("~") && written.alternatives.t === "list") {
            const alternativesList = written.alternatives;
            const alternatives = alternativesList.v.flatMap<Clause & { at: Expr }>(a => a.t === "patternLambda" ? [{ params: a.params, guard: a.guard, body: a.body, at: a }]
                : a.t === "lambda" ? [{ params: a.params.map(name => ({ p: "var", name })), body: a.body, at: a }] : []);
            const places = clausePlaces(alternatives, builtinContains);
            alternatives.forEach((alt, n) => {
                const before = alternatives.find((other, m) => places[m] < places[n] && !other.guard && takesAll(other, alt, builtinContains));
                if (before) unreachable(lineOf(alt.body) ?? lineOf(alt.at), "This alternative never runs: an earlier one takes every value it does.");
            });
            const family = familyOf(written.value, scope);
            const variants = family && families.get(family);
            if (variants && alternativesList.v.every(a => (a.t === "patternLambda" || a.t === "lambda") && a.params.length === 1)) {
                const covered = new Set<string>();
                let catchAll = false;
                for (const alt of alternativesList.v) {
                    if (alt.t === "lambda") { catchAll = true; break; }
                    if (alt.t !== "patternLambda" || alt.guard) continue;
                    const pattern = alt.params[0];
                    if (irrefutable(pattern)) { catchAll = true; break; }
                    if (pattern.p === "constr" && variants.get(pattern.tag) === pattern.args.length && pattern.args.every(irrefutable)) {
                        // Repeated binders impose equality, so cannot prove coverage.
                        const names = pattern.args.filter(p => p.p === "var" && p.name !== "_").map(p => (p as { name: string }).name);
                        if (new Set(names).size === names.length) covered.add(pattern.tag);
                    }
                }
                const missing = [...variants.keys()].filter(tag => !covered.has(tag));
                const location = sourceLocations.get(e);
                if (!catchAll && missing.length && location) diagnostics.push({
                    range: { start: pos(location.start), end: pos(location.start + 5) }, severity: 2,
                    source: "apn", code: "non-exhaustive-match",
                    message: `No unconditional alternative covers ${missing.join(", ")} in ${family}.`,
                });
            }
        }
        if (e.t === "lambda" || e.t === "patternLambda") {
            const inner = new Map(scope);
            if (e.t === "lambda") for (const name of e.params) inner.set(name, undefined);
            else { for (const p of e.params) bind(p, inner); if (e.guard) visit(e.guard, inner); }
            visit(e.body, inner); return;
        }
        if (e.t === "stmDef") {
            for (const clause of e.clauses) {
                const inner = new Map(scope); inner.set(e.name, undefined);
                clause.params.forEach(p => bind(p, inner)); visit(clause.body, inner);
            }
            return;
        }
        if (e.t === "block") {
            const inner = new Map(scope);
            for (const stmt of e.stmts) {
                if (stmt.t === "stmDef") inner.set(stmt.name, undefined);
                if (stmt.t === "patDef") bind(stmt.pattern, inner);
                visit(stmt, inner);
            }
            return;
        }
        // Traverse expression children without traversing source metadata.
        const child = (value: unknown) => {
            if (Array.isArray(value)) value.forEach(child);
            else if (value && typeof value === "object" && "t" in value) visit(value as Expr, scope);
        };
        Object.values(e).forEach(child);
    };
    const top = new Map<string, string | undefined>();
    for (const node of program) if (node.t === "def") top.set(node.name, undefined);
    for (const node of program) {
        if (node.t === "def") for (const clause of node.clauses) {
            const scope = new Map(top); clause.params.forEach(p => bind(p, scope)); visit(clause.body, scope);
        }
        else if (node.t === "expr") visit(node.value, top);
        else if (node.t === "patDef") { bind(node.pattern, top); visit(node.value, top); }
    }
    return diagnostics;
}

// The names a binding pattern binds.
function patternNames(p: Pattern): string[] {
    if (p.p === "var") return [p.name];
    return Object.values(p).flatMap(value => Array.isArray(value) ? value.flatMap(x => x && typeof x === "object" && "p" in x ? patternNames(x) : [])
        : value && typeof value === "object" && "p" in value ? patternNames(value as Pattern) : []);
}

