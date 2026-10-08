import { sourceLocations, type Expr, type Pattern, type TopLevel } from "./ast.ts";
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
    const visit = (e: Expr, scope: Scope) => {
        if (e.t === "app" && e.f.t === "app" && e.f.f.t === "var" && e.f.f.name === "match" && !scope.has("match") && e.a.t === "list") {
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
