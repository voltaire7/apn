import { sourceLocations, type Expr, type Pattern, type TopLevel } from "./ast.ts";
import type { Diagnostic } from "./lint.ts";

// Warnings for names a parameter pattern binds but its body never uses:
// write _ to discard a value. Names starting with _ are discarded on
// purpose.
// Like the other lint analyses, this never evaluates APN.
export function unusedDiagnostics(program: TopLevel[], source: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const pos = (offset: number) => {
        const lines = source.slice(0, offset).split("\n");
        return { line: lines.length - 1, character: lines.at(-1)!.length };
    };
    const report = (names: string[], body: Expr, extra: Expr[] = []) => {
        const used = new Set<string>();
        for (const e of [body, ...extra]) free(e, new Set(), used, new Set(names));
        const start = firstOffset(body);
        // A name bound twice (f x x) is used: the second compares with the first.
        for (const name of new Set(names)) {
            if (used.has(name) || names.indexOf(name) !== names.lastIndexOf(name) || name.startsWith("_") || name.startsWith("$")) continue;
            const at = start === undefined ? undefined : lastWord(source, name, start);
            if (at === undefined) continue;
            diagnostics.push({
                range: { start: pos(at), end: pos(at + name.length) }, severity: 2, source: "apn", code: "unused",
                message: `'${name}' is never used; write _ to discard it`,
            });
        }
    };
    // The parameters in scope, innermost last: name k = v on one assigns an item.
    const parameters: string[][] = [];
    const statements = (list: unknown[]): void => definitionsInOrder(list, (node, clauses) => {
        if (clauses) {
            // A parameter's type may use an earlier one: n ((SizedInts n) xs).
            for (const c of clauses) report(c.params.flatMap(x => bound(x, false)), c.body, [...c.guard ? [c.guard] : [], ...c.params.flatMap(types)]);
            // A name a typed pattern's type binds (a in (List a) xs) is used if
            // the body reads it or another parameter's type repeats it.
            for (const c of clauses) {
                const typeNames = c.params.flatMap(types).flatMap(namesIn);
                const repeated = (name: string) => typeNames.filter(n => n === name).length > 1;
                report(typeBound(c.params, defined).filter(name => !repeated(name)), c.body, c.guard ? [c.guard] : []);
            }
        }
        if (node.t === "def" || node.t === "stmDef") {
            for (const c of node.clauses as Clause[]) {
                parameters.push(clauses ? c.params.flatMap(x => bound(x, false)) : []);
                visit(c.body);
                if (c.guard) visit(c.guard);
                parameters.pop();
            }
        } else visit(node);
    }, new Set(parameters.flat()));
    const visit = (node: unknown): void => {
        if (Array.isArray(node)) { node.forEach(visit); return; }
        if (!node || typeof node !== "object") return;
        const n = node as Record<string, unknown>;
        // A lambda where a type is expected is a function type, not code: in
        // a pattern or constructor field, beside ==, as isType's first
        // argument, or before .( ).
        if ("p" in n || n.t === "type") return;
        if (n.t === "binop" && (n.op === "==" || n.op === "!=")) {
            for (const side of [n.l, n.r]) if (!lambdaIn(side)) visit(side);
            return;
        }
        if (n.t === "app" && (n.f as Expr).t === "app" && ((n.f as Expr & { t: "app" }).f as Expr).t === "var" &&
            (((n.f as Expr & { t: "app" }).f) as Expr & { t: "var" }).name === "isType" && lambdaIn((n.f as Expr & { t: "app" }).a)) {
            visit(n.a);
            return;
        }
        if (n.t === "recordAccess" && n.scoped && lambdaIn(n.rec)) { visit(n.argument); return; }
        if (n.t === "block") { statements(n.stmts as unknown[]); return; }
        if (n.t === "lambda") report(n.params as string[], n.body as Expr);
        else if (n.t === "patternLambda") {
            const params = n.params as Pattern[];
            report(params.flatMap(x => bound(x, false)), n.body as Expr, [...n.guard ? [n.guard as Expr] : [], ...params.flatMap(types)]);
        }
        for (const value of Object.values(n)) if (value && typeof value === "object") visit(value);
    };
    // Names the document defines anywhere: a type may name them.
    const defined = new Set<string>();
    const collect = (node: unknown): void => {
        if (Array.isArray(node)) { node.forEach(collect); return; }
        if (!node || typeof node !== "object") return;
        const n = node as Record<string, unknown>;
        if ((n.t === "def" || n.t === "stmDef") && typeof n.name === "string") defined.add(n.name);
        if (n.t === "patDef") for (const name of bound(n.pattern as Pattern)) defined.add(name);
        for (const value of Object.values(n)) if (value && typeof value === "object") collect(value);
    };
    collect(program);
    typeNames = new Set(["Vect", "List", ...[...defined].filter(name => /^[A-Z]/.test(name))]);
    statements(program.map(node => node.t === "expr" ? node.value : node));
    return diagnostics;
}

// The types a typed pattern may name, as Vect n a xs: the prelude's, and the
// document's (set for each document checked).
let typeNames = new Set<string>();
// Vect n a xs is the typed pattern ((Vect n a) xs), as (m : HashMap a b) is:
// its type's arguments are expressions, compared when bound, and only its
// last part binds a value.
function typed(p: Pattern): Pattern {
    if (p.p !== "constr" || !(p.typed || typeNames.has(p.tag)) || p.args.length < 2) return p;
    const parts = p.args.slice(0, -1).map((x): Expr => x.p === "var" ? { t: "var", name: x.name } : x.p === "int" ? { t: "int", v: x.v } : { t: "placeholder" } as Expr);
    return { p: "schema", type: parts.reduce((f, a): Expr => ({ t: "app", f, a }), { t: "var", name: p.tag } as Expr), value: p.args.at(-1)! };
}

// The names typed patterns' types bind: a lowercase argument (n and a in
// (Vect n a) xs) that no earlier parameter bound and the document does not define.
function typeBound(params: Pattern[], defined: Set<string>): string[] {
    const earlier = new Set<string>(), found: string[] = [];
    const walk = (pattern: Pattern): void => {
        const p = typed(pattern);
        if (p.p === "schema") {
            const args: Expr[] = [];
            let head = p.type;
            while (head.t === "block" && head.stmts.length === 1) head = head.stmts[0];
            while (head.t === "app") { args.unshift(head.a); head = head.f; }
            for (const arg of args) {
                if (arg.t === "var" && /^[a-z]/.test(arg.name) && !earlier.has(arg.name) && !defined.has(arg.name)) { earlier.add(arg.name); found.push(arg.name); }
            }
            walk(p.value);
            return;
        }
        for (const value of Object.values(p)) {
            if (Array.isArray(value)) value.forEach(x => x && typeof x === "object" && "p" in x && walk(x as Pattern));
            else if (value && typeof value === "object" && "p" in value) walk(value as Pattern);
        }
    };
    for (const p of params) { walk(p); for (const name of bound(p, false)) earlier.add(name); }
    return found;
}
function namesIn(e: unknown): string[] {
    if (Array.isArray(e)) return e.flatMap(namesIn);
    if (!e || typeof e !== "object") return [];
    const n = e as Record<string, unknown>;
    if (n.t === "var") return [n.name as string];
    return Object.values(n).flatMap(v => v && typeof v === "object" ? namesIn(v) : []);
}

// The names a function type uses: a -> b's input a too, written as a parameter.
function typeNamesIn(e: unknown): string[] {
    const n = e as Record<string, unknown>;
    if (n?.t === "lambda") return [...n.params as string[], ...typeNamesIn(n.body)];
    if (n?.t === "block" && Array.isArray(n.stmts) && n.stmts.length === 1) return typeNamesIn(n.stmts[0]);
    return namesIn(e);
}

type Clause = { params: Pattern[]; body: Expr; guard?: Expr };
// A block's (or program's) statements in order, each given to each: with its
// clauses when it defines a function. A name bound to a value earlier makes
// name k = v an item assignment, not a function; a capitalized one
// destructures or declares a type.
export function definitionsInOrder(list: unknown[], each: (node: Record<string, unknown>, clauses?: Clause[]) => void, outer = new Set<string>()): void {
    const values = new Set(outer);
    for (const item of list) {
        const n = item as Record<string, unknown> | null;
        if (!n || typeof n !== "object") continue;
        if ((n.t === "def" || n.t === "stmDef") && Array.isArray(n.clauses)) {
            const name = n.name as string, clauses = n.clauses as Clause[];
            if (clauses.every(c => !c.params.length)) {
                if (!clauses.some(c => c.body.t === "lambda" || c.body.t === "patternLambda")) values.add(name);
                each(n);
            } else each(n, !values.has(name) && !/^[A-Z]/.test(name) ? clauses : undefined);
            continue;
        }
        if (n.t === "patDef") for (const name of bound(n.pattern as Pattern)) values.add(name);
        each(n);
    }
}
// A lambda written in place, perhaps in parentheses.
function lambdaIn(e: unknown): boolean {
    const x = e as Expr;
    if (x?.t === "block" && x.stmts.length === 1) return lambdaIn(x.stmts[0]);
    return x?.t === "lambda" || x?.t === "patternLambda";
}

// The names a pattern binds, a type's name too ((t x) binds t; (_ x) does not).
function bound(pattern: Pattern, types = true): string[] {
    const p = typed(pattern);
    switch (p.p) {
        case "var": return [p.name];
        case "typeBind": return [p.name, ...bound(p.value, types)];
        case "as": return [...bound(p.left, types), ...bound(p.right, types)];
        case "schema": return bound(p.value, types);
        case "list": return p.v.flatMap(x => bound(x, types));
        case "cons": return [...bound(p.head, types), ...bound(p.tail, types)];
        case "constr": return p.args.flatMap(x => bound(x, types));
        case "recPat": return p.v.map(([, name]) => name);
        default: return [];
    }
}

// The type expressions in a pattern, which may use other parameters.
function types(pattern: Pattern): Expr[] {
    const p = typed(pattern);
    switch (p.p) {
        case "schema": return [p.type, ...types(p.value)];
        case "typeBind": return types(p.value);
        case "as": return [...types(p.left), ...types(p.right)];
        case "list": return p.v.flatMap(types);
        case "cons": return [...types(p.head), ...types(p.tail)];
        case "constr": return p.args.flatMap(types);
        default: return [];
    }
}

// Collect the names e uses that the binders inside it do not shadow. values
// are the parameters being checked: name k = v on one assigns an item (as at
// runtime, where it is bound to a value), using the name and k.
function free(e: unknown, shadowed: Set<string>, used: Set<string>, values = new Set<string>()): void {
    if (Array.isArray(e)) { for (const x of e) free(x, shadowed, used, values); return; }
    if (!e || typeof e !== "object") return;
    const n = e as Record<string, unknown>;
    const within = (names: string[], parts: unknown[]) => {
        const inner = new Set([...shadowed, ...names]);
        const outer = new Set([...values].filter(name => !names.includes(name)));
        for (const part of parts) free(part, inner, used, outer);
    };
    const assigns = (s: Expr) => s.t === "stmDef" && values.has(s.name) && !shadowed.has(s.name) && s.clauses.every(c => c.params.length);
    switch (n.t) {
        case "var": if (!shadowed.has(n.name as string)) used.add(n.name as string); return;
        case "lambda": within(n.params as string[], [n.body]); return;
        case "patternLambda": within((n.params as Pattern[]).flatMap(x => bound(x)), [n.body, n.guard, n.params]); return;
        case "block": {
            // Definitions in a block are visible to all of its statements. An
            // update (model.time = t) binds nothing new: it reads the record
            // and rebinds it, and its pattern names fields.
            const statements = n.stmts as Expr[];
            for (const s of statements) {
                if (!assigns(s)) continue;
                used.add((s as Expr & { t: "stmDef" }).name);
                for (const c of (s as Expr & { t: "stmDef" }).clauses) for (const name of c.params.flatMap(x => bound(x))) if (!shadowed.has(name)) used.add(name);
            }
            const names = statements.flatMap(s => s.t === "stmDef" && !assigns(s) ? [s.name] : s.t === "patDef" && !s.update ? bound(s.pattern) : []);
            within(names, [statements.map(s => assigns(s) ? (s as Expr & { t: "stmDef" }).clauses.map(c => c.body) : s)]);
            return;
        }
        case "stmDef": case "def":
            for (const c of n.clauses as { params: Pattern[]; body: Expr; guard?: Expr }[]) within(c.params.flatMap(x => bound(x)), [c.body, c.guard, c.params]);
            return;
        case "patDef": free(n.value, shadowed, used, values); free(n.pattern, shadowed, used, values); if (n.update) free(n.update, shadowed, used, values); return;
    }
    // Patterns hold expressions only in their types.
    if ("p" in n) {
        const p = typed(n as Pattern);
        if (p !== n) { free(p, shadowed, used, values); return; }
        // A lambda as a pattern's type ((k : t -> b), and so k : t -> b) is a
        // function type: it uses its names.
        if (n.p === "schema" && lambdaIn(n.type)) { for (const name of typeNamesIn(n.type)) if (!shadowed.has(name)) used.add(name); }
        else if (n.p === "schema") free(n.type, shadowed, used, values);
        for (const value of Object.values(n)) if (value && typeof value === "object" && (Array.isArray(value) || "p" in value)) free(value, shadowed, used, values);
        return;
    }
    for (const value of Object.values(n)) if (value && typeof value === "object") free(value, shadowed, used, values);
}

// Where an expression's source starts: its own location or its earliest part's.
function firstOffset(e: unknown): number | undefined {
    if (!e || typeof e !== "object") return undefined;
    const own = sourceLocations.get(e as Expr)?.start;
    let best = own;
    for (const value of Object.values(e as object)) {
        if (!value || typeof value !== "object") continue;
        const parts = Array.isArray(value) ? value : [value];
        for (const part of parts) {
            const at = firstOffset(part);
            if (at !== undefined && (best === undefined || at < best)) best = at;
        }
    }
    return best;
}

// The last whole-word occurrence of name before offset: the parameter, which
// comes before its body.
function lastWord(source: string, name: string, before: number): number | undefined {
    const word = /[A-Za-z0-9_$']/;
    for (let at = source.lastIndexOf(name, before - name.length); at >= 0; at = source.lastIndexOf(name, at - 1)) {
        if (!word.test(source[at - 1] ?? " ") && !word.test(source[at + name.length] ?? " ")) return at;
        if (at === 0) break;
    }
    return undefined;
}
