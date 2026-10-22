import { clauseKey, METHODS, sourceLocations, type Expr, type Pattern, type TopLevel } from "./ast.ts";
import type { Diagnostic } from "./lint.ts";

// This analysis never evaluates APN. Unknown families or dynamic handler lists
// are left to runtime matching; guards cannot establish total coverage.
export function matchDiagnostics(program: TopLevel[], source: string): Diagnostic[] {
    const families = new Map<string, Map<string, number>>();
    const constructors = new Map<string, string>();
    const add = (name: string, variants: Array<[string, number]>) => {
        families.set(name, new Map(variants));
        for (const [tag] of variants) constructors.set(tag, name);
    };
    for (const node of program) {
        if (node.t === "type") add(node.def.name, node.def.variants.map(v => [v.tag, v.arity]));
        if (node.t === "expr" && node.value.t === "import") {
            const modules = [node.value.module].flat();
            if (modules.includes("option")) {
                add("Option", [["Some", 1], ["None", 0]]);
                add("Result", [["Ok", 1], ["Err", 1]]);
            }
        }
    }
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
            if (families.has(pattern.tag) && pattern.args.length === 1 && pattern.args[0].p === "var") scope.set(pattern.args[0].name, pattern.tag);
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
    // A clause takes any argument when its parameters are distinct names or _.
    type Clause = { params: Pattern[]; body: Expr; guard?: Expr };
    const takesAny = (c: Clause) => {
        const names = c.params.flatMap(p => p.p === "var" ? [p.name] : []);
        return !c.guard && c.params.every(irrefutable) && new Set(names).size === names.length;
    };
    // Clauses rank by their patterns (a literal first, then a built-in type, as
    // dispatch does); these patterns rank with a plain name, so a clause of only
    // them never runs after one that takes any argument.
    const ranksLowest = (p: Pattern): boolean => ["var", "wildcard", "list", "cons", "recPat", "range"].includes(p.p)
        || p.p === "as" && ranksLowest(p.left) && ranksLowest(p.right) || p.p === "constr" && constructors.has(p.tag);
    // A scope's definitions, in order: a clause after one of the same function
    // taking any argument (not an equivalent one, which replaces it) never runs.
    // A binding without parameters starts a new version of the name.
    type Definition = { name: string; clauses: Clause[] } | { rebinds: string[] };
    const clauseOrder = (definitions: Definition[]) => {
        const earlier = new Map<string, Clause[]>();
        for (const d of definitions) {
            if ("rebinds" in d) { d.rebinds.forEach(name => earlier.delete(name)); continue; }
            if (METHODS.has(d.name)) continue;
            for (const c of d.clauses) {
                if (!c.params.length) { earlier.delete(d.name); continue; }
                const seen = (earlier.get(d.name) ?? []).filter(e => clauseKey(d.name, e) !== clauseKey(d.name, c));
                const any = seen.find(e => takesAny(e) && e.params.length === c.params.length);
                if (any && c.params.every(ranksLowest)) {
                    unreachable(lineOf(c.body), `This clause of '${d.name}' never runs: the clause on line ${(lineOf(any.body)?.line ?? 0) + 1} takes any argument and comes first.`);
                }
                earlier.set(d.name, [...seen, c]);
            }
        }
    };
    const visit = (e: Expr, scope: Scope) => {
        if (e.t === "app" && e.f.t === "app" && e.f.f.t === "var" && e.f.f.name === "match" && !scope.has("match") && e.a.t === "list") {
            // Alternatives are tried in order: one after an unconditional one never runs.
            const first = e.a.v.findIndex(a => a.t === "lambda" || a.t === "patternLambda" && takesAny(a));
            if (first >= 0) for (const alt of e.a.v.slice(first + 1)) {
                if (alt.t === "lambda" || alt.t === "patternLambda") unreachable(lineOf(alt.body) ?? lineOf(alt), "This alternative never runs: an earlier one takes any value.");
            }
            const family = familyOf(e.f.a, scope);
            const variants = family && families.get(family);
            if (variants && e.a.v.every(a => (a.t === "patternLambda" || a.t === "lambda") && a.params.length === 1)) {
                const covered = new Set<string>();
                let catchAll = false;
                for (const alt of e.a.v) {
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
            clauseOrder(e.stmts.flatMap<Definition>(st => st.t === "stmDef" ? [{ name: st.name, clauses: st.clauses }]
                : st.t === "patDef" ? [{ rebinds: patternNames(st.pattern) }] : []));
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
    clauseOrder(program.flatMap<Definition>(node => node.t === "def" ? [{ name: node.name, clauses: node.clauses }]
        : node.t === "patDef" ? [{ rebinds: patternNames(node.pattern) }] : []));
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
