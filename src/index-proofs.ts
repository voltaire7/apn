import type { Expr, Pattern, TopLevel } from "./ast.ts";

// Proofs of the indices a function's clauses claim for indexed families
// (app ((Vec n a) Nil) ((Vec m a) ys) = Vec (n + m) a ys). Indices are
// affine sums over naturals: Z, S k, literals, +, and * by a literal. A
// constructor pattern refines its parameter's index (Nil makes n 0; Cons x r
// makes n one more than r's). A recursive call whose arguments shrink is
// assumed to meet the claim of the clause it takes, one case per clause
// (induction). A claim that differs from its body's index by a constant in a
// case that can happen is wrong: the checker reports it at the definition.
// Anything else is left to the runtime check of the claim. Never evaluates APN.

type Family = Extract<TopLevel, { t: "type" }>["def"];
type Clause = { params: Pattern[]; body: Expr; guard?: Expr };
export interface ClaimFailure { message: string; at: Expr }

// c + Σ coefficient·variable, over the integers (variables stand for naturals).
type Affine = { c: bigint; v: Map<string, bigint> };
const constant = (c: bigint): Affine => ({ c, v: new Map() });
const variableOf = (name: string): Affine => ({ c: 0n, v: new Map([[name, 1n]]) });
function plus(a: Affine, b: Affine, scale = 1n): Affine {
    const v = new Map(a.v);
    for (const [name, k] of b.v) {
        const sum = (v.get(name) ?? 0n) + scale * k;
        if (sum) v.set(name, sum); else v.delete(name);
    }
    return { c: a.c + scale * b.c, v };
}
const times = (a: Affine, k: bigint): Affine => plus(constant(0n), a, k);

const unwrap = (e: Expr): Expr => e.t === "block" && e.stmts.length === 1 && e.style !== "{" ? unwrap(e.stmts[0]) : e;
// An application's head and arguments (f $ x applies f too).
function spine(e: Expr): [Expr, Expr[]] {
    e = unwrap(e);
    if (e.t === "pipe") { const [head, args] = spine(e.f); return [head, [...args, e.x]]; }
    const args: Expr[] = [];
    while (e.t === "app") { args.unshift(e.a); e = unwrap(e.f); }
    return [e, args];
}
const lower = (e: Expr): e is { t: "var"; name: string } => e.t === "var" && /^[a-z]/.test(e.name);

// What a clause knows: its typed patterns' index names, the family and index
// of each value it binds, and the equations its patterns made, solved.
class World {
    solved = new Map<string, Affine>();
    names = new Map<string, Affine>();
    values = new Map<string, { family: string; index: (Affine | undefined)[] }>();
    // Variables in order of creation, with the names they print as.
    order: string[] = [];
    shown = new Map<string, string>();
    impossible = false;
    // An equation it could not solve: the variables are not free, so a
    // difference may never happen.
    constrained = false;
    cases: string[] = [];
    // The function's own clauses whose claims this world assumed.
    assumed: number[] = [];
    certain = true;
    constructor(private serial = { n: 0 }) {}
    clone(): World {
        const w = new World(this.serial);
        w.solved = new Map(this.solved); w.names = new Map(this.names); w.values = new Map(this.values);
        w.order = [...this.order]; w.shown = new Map(this.shown);
        Object.assign(w, { impossible: this.impossible, constrained: this.constrained, cases: [...this.cases], assumed: [...this.assumed], certain: this.certain });
        return w;
    }
    fresh(name: string): Affine {
        const id = `${name}#${this.serial.n++}`;
        const taken = new Set(this.shown.values());
        let shown = name;
        while (taken.has(shown)) shown += "'";
        this.order.push(id); this.shown.set(id, shown);
        return variableOf(id);
    }
    normal(a: Affine): Affine {
        let out = constant(a.c);
        for (const [name, k] of a.v) out = plus(out, this.solved.has(name) ? this.normal(this.solved.get(name)!) : variableOf(name), k);
        return out;
    }
    equate(a: Affine, b: Affine): void {
        const d = this.normal(plus(a, b, -1n));
        if (!d.v.size) { if (d.c) this.impossible = true; return; }
        // Solve for the oldest variable with coefficient ±1: n = k + 1 for Cons
        // x r keeps r's k, so the claim reads in the parts' indices.
        const pick = [...d.v.keys()].filter(name => d.v.get(name) === 1n || d.v.get(name) === -1n)
            .sort((x, y) => this.order.indexOf(x) - this.order.indexOf(y))[0];
        if (!pick) { this.constrained = true; return; }
        const k = d.v.get(pick)!, rest = plus(d, variableOf(pick), -k);
        this.solved.set(pick, times(rest, -k));
        // A natural can't be negative.
        for (const name of this.order) {
            const value = this.normal(variableOf(name));
            if (value.c < 0n && [...value.v.values()].every(c => c <= 0n)) this.impossible = true;
        }
    }
    text(a: Affine): string {
        const n = this.normal(a), parts: string[] = [];
        for (const name of this.order) {
            const k = n.v.get(name);
            if (!k) continue;
            const shown = this.shown.get(name)!, term = k === 1n || k === -1n ? shown : `${k < 0n ? -k : k} * ${shown}`;
            parts.push(parts.length ? `${k < 0n ? "- " : "+ "}${term}` : k < 0n ? `-${term}` : term);
        }
        if (n.c || !parts.length) parts.push(parts.length ? `${n.c < 0n ? "-" : "+"} ${n.c < 0n ? -n.c : n.c}` : `${n.c}`);
        return parts.join(" ");
    }
}

// The first wrong claim, or whether every clause's claim was proven (then a
// later function may use them as it uses its own).
export function proveIndexClaims(name: string, clauses: Clause[], families: Map<string, Family>, proven: Map<string, Clause[]>): ClaimFailure | boolean {
    // The index positions of each family: where a constructor's result is
    // computed (Z, S k), not a parameter passed through.
    const positions = new Map<string, number[]>();
    for (const [family, def] of families) {
        const at = new Set<number>();
        for (const v of def.variants) if (v.result) spine(v.result)[1].forEach((arg, n) => { if (!lower(arg)) at.add(n); });
        positions.set(family, [...at].sort());
    }
    const familyOf = (tag: string) => [...families].find(([, def]) => def.variants.some(v => v.tag === tag))?.[0];
    const arity = clauses[0]?.params.length ?? 0;
    if (!arity || clauses.some(c => c.params.length !== arity)) return false;

    // A clause's claim: Vec (n + m) a body, its family, indices and body.
    const claimOf = (c: Clause) => {
        const [head, args] = spine(c.body);
        const def = head.t === "var" ? families.get(head.name) : undefined;
        if (!def || args.length !== (def.parameters?.length ?? 0) + 1) return undefined;
        return { family: def.name, args: args.slice(0, -1), body: args[args.length - 1] };
    };
    if (!clauses.some(claimOf)) return false;

    // Index an expression names, in a world: n (a typed pattern's name), Z,
    // S e, literals, +, and * by a literal.
    const affine = (e: Expr, env: (name: string) => Affine | undefined): Affine | undefined => {
        e = unwrap(e);
        if (e.t === "int") return e.v >= 0n ? constant(e.v) : undefined;
        if (e.t === "var") return e.name === "Z" ? constant(0n) : env(e.name);
        if (e.t === "app" && unwrap(e.f).t === "var" && (unwrap(e.f) as { name: string }).name === "S") {
            const inner = affine(e.a, env);
            return inner && plus(inner, constant(1n));
        }
        if (e.t === "binop" && (e.op === "+" || e.op === "*")) {
            const l = affine(e.l, env), r = affine(e.r, env);
            if (!l || !r) return undefined;
            if (e.op === "+") return plus(l, r);
            if (!l.v.size) return times(r, l.c);
            if (!r.v.size) return times(l, r.c);
        }
        return undefined;
    };

    // A constructor's index from its fields' indices (Cons x r: S of r's).
    const constructed = (w: World, family: string, tag: string, fields: ((Affine | undefined)[] | undefined)[]): (Affine | undefined)[] => {
        const def = families.get(family)!, variant = def.variants.find(v => v.tag === tag)!;
        const env = new Map<string, Affine>();
        (variant.fields ?? []).forEach((spec, n) => {
            const [head, args] = spine(spec);
            if (head.t !== "var" || head.name !== family) return;
            for (const i of positions.get(family)!) {
                const arg = args[i], index = fields[n]?.[i];
                if (arg && lower(arg) && index && !env.has(arg.name)) env.set(arg.name, index);
            }
        });
        const result = variant.result ? spine(variant.result)[1] : (def.parameters ?? []).map(p => ({ t: "var", name: p }) as Expr);
        return positions.get(family)!.map(i => {
            const arg = result[i];
            if (!arg) return undefined;
            return affine(arg, name => env.get(name) ?? (/^[a-z]/.test(name) ? w.fresh(name) : undefined));
        });
    };

    // Bind a parameter pattern, given the family and index its value has.
    // depth > 0 marks a part of the argument (r in Cons x r).
    type Bound = { world: World; parts: Map<string, number> };
    const bind = (b: Bound, p: Pattern, at: number, depth: number, family?: string, index?: (Affine | undefined)[]): void => {
        const w = b.world;
        const meet = (family: string, mine: (Affine | undefined)[]) => {
            if (index) mine.forEach((x, i) => { if (x && index[i]) w.equate(x, index[i]!); else if (x || index[i]) w.constrained = true; });
            return mine;
        };
        switch (p.p) {
            case "var":
                if (family) w.values.set(p.name, { family, index: index ?? positions.get(family)!.map(() => undefined) });
                if (depth) b.parts.set(p.name, at);
                return;
            case "wildcard": return;
            case "as": bind(b, p.left, at, depth, family, index); bind(b, p.right, at, depth, family, index); return;
            case "typeBind": bind(b, p.value, at, depth, family, index); return;
            case "schema": {
                const [head, args] = spine(p.type);
                const own = head.t === "var" ? families.get(head.name) : undefined;
                if (!own) { w.certain = false; bind(b, p.value, at, depth); return; }
                const mine = positions.get(own.name)!.map((i, at) => {
                    const arg = args[i];
                    if (!arg || arg.t === "placeholder") return index?.[at] ?? w.fresh("i");
                    // A name the pattern binds is the index the value has, when known.
                    if (lower(arg) && !w.names.has(arg.name)) { const x = index?.[at] ?? w.fresh(arg.name); w.names.set(arg.name, x); return x; }
                    return affine(arg, name => w.names.get(name));
                });
                bind(b, p.value, at, depth, own.name, meet(own.name, mine));
                return;
            }
            case "constr": {
                const own = familyOf(p.tag);
                if (!own || family && own !== family) { w.certain = false; return; }
                const variant = families.get(own)!.variants.find(v => v.tag === p.tag)!;
                const specs = variant.fields ?? [];
                const fields = specs.map(spec => {
                    const [head, args] = spine(spec);
                    if (head.t !== "var" || head.name !== own) return undefined;
                    return positions.get(own)!.map(i => w.fresh(args[i] && lower(args[i]) ? (args[i] as { name: string }).name : "i"));
                });
                meet(own, constructed(w, own, p.tag, fields));
                p.args.forEach((arg, n) => bind(b, arg, at, depth + 1, fields[n] ? own : undefined, fields[n]));
                return;
            }
            default: w.certain = false;
        }
    };
    const begin = (c: Clause, world = new World(), args?: ({ family: string; index: (Affine | undefined)[] } | undefined)[]): Bound => {
        const b: Bound = { world, parts: new Map() };
        c.params.forEach((p, n) => bind(b, p, n, 0, args?.[n]?.family, args?.[n]?.index));
        if (c.guard) world.certain = false;
        return b;
    };
    // A clause can be chosen for some arguments: simple patterns, no guard,
    // and an earlier clause differs from it in a constructor somewhere.
    const tagAt = (p: Pattern): string | undefined => p.p === "constr" ? p.tag : p.p === "schema" || p.p === "typeBind" ? tagAt(p.value) : undefined;
    const reachable = (fs: Clause[], j: number) => begin(fs[j]).world.certain &&
        fs.slice(0, j).every(earlier => earlier.params.some((p, n) => { const a = tagAt(p), b = tagAt(fs[j].params[n]); return a && b && a !== b; }));

    // The claim every clause makes of its parameters' indices (n + m from
    // (Vec n a) and (Vec m a) in each), keyed parameter:position.
    const uniform = (fs: Clause[]): { family: string; index: Affine[] } | undefined => {
        let found: { family: string; index: Affine[] } | undefined;
        for (const c of fs) {
            const claim = claimOf(c);
            if (!claim) return undefined;
            const keys = new Map<string, Affine>();
            c.params.forEach((p, n) => {
                while (p.p === "typeBind") p = p.value;
                if (p.p !== "schema") return;
                const [head, args] = spine(p.type);
                if (head.t !== "var" || !families.has(head.name)) return;
                positions.get(head.name)!.forEach((i, at) => { const arg = args[i]; if (arg && lower(arg) && !keys.has(arg.name)) keys.set(arg.name, variableOf(`${n}:${at}`)); });
            });
            const index = positions.get(claim.family)!.map(i => affine(claim.args[i], name => keys.get(name)));
            if (index.some(x => !x)) return undefined;
            const mine = { family: claim.family, index: index as Affine[] };
            const key = (x: typeof mine) => JSON.stringify([x.family, x.index.map(a => [`${a.c}`, [...a.v].map(([v, k]) => [v, `${k}`]).sort()])]);
            if (found && key(found) !== key(mine)) return undefined;
            found = mine;
        }
        return found;
    };
    // Recursive calls count only where one argument shrinks in every one of them.
    const calls: { args: Expr[]; parts: Map<string, number> }[] = [];
    let direct = true;
    const scan = (e: unknown, parts: Map<string, number>): void => {
        if (!e || typeof e !== "object") return;
        if (Array.isArray(e)) { e.forEach(x => scan(x, parts)); return; }
        const x = e as Expr;
        if ("p" in (x as object)) return;
        if (x.t === "app" || x.t === "pipe") {
            const [head, args] = spine(x);
            if (head.t === "var" && head.name === name) {
                if (args.length === arity) calls.push({ args, parts }); else direct = false;
                args.forEach(a => scan(a, parts));
                return;
            }
        }
        if (x.t === "var" && x.name === name) { direct = false; return; }
        for (const value of Object.values(x)) if (value && typeof value === "object") scan(value, parts);
    };
    clauses.forEach(c => scan(c.body, begin(c).parts));
    const shrinking = direct && [...Array(arity).keys()].find(n => calls.every(({ args, parts }) => {
        const arg = unwrap(args[n]);
        return arg.t === "var" && parts.get(arg.name) === n;
    }));

    // The worlds an expression's value can be in, each with its index;
    // undefined when the index is not known.
    type Outcome = { world: World; family: string; index: (Affine | undefined)[] };
    const outcomes = (e: Expr, w: World, depth = 0): Outcome[] | undefined => {
        e = unwrap(e);
        if (depth > 32) return undefined;
        if (e.t === "var") {
            const known = w.values.get(e.name);
            if (known) return [{ world: w, ...known }];
        }
        if (e.t === "ternary") {
            const a = outcomes(e.then, w.clone(), depth + 1), b = outcomes(e.els, w.clone(), depth + 1);
            if (!a || !b) return undefined;
            return [...a, ...b].map(o => { o.world.certain = false; return o; });
        }
        const [head, args] = spine(e);
        if (head.t !== "var") return undefined;
        const tagged = familyOf(head.name);
        if (tagged) {
            const variant = families.get(tagged)!.variants.find(v => v.tag === head.name)!;
            if (args.length !== variant.arity) return undefined;
            // Each family field's worlds, in turn.
            let worlds: { world: World; fields: ((Affine | undefined)[] | undefined)[] }[] = [{ world: w, fields: [] }];
            for (const [n, spec] of (variant.fields ?? []).entries()) {
                const [fieldHead] = spine(spec);
                const next: typeof worlds = [];
                for (const { world, fields } of worlds) {
                    if (fieldHead.t !== "var" || fieldHead.name !== tagged) { next.push({ world, fields: [...fields, undefined] }); continue; }
                    const inner = outcomes(args[n], world.clone(), depth + 1);
                    if (!inner) return undefined;
                    for (const o of inner) next.push({ world: o.world, fields: [...fields, o.index] });
                }
                if (next.length > 64) return undefined;
                worlds = next;
            }
            return worlds.map(({ world, fields }) => ({ world, family: tagged, index: constructed(world, tagged, head.name, fields) }));
        }
        // A claim inside the body is checked where it runs: its index is the claim's.
        const def = families.get(head.name);
        if (def && args.length === (def.parameters?.length ?? 0) + 1) {
            const index = positions.get(def.name)!.map(i => affine(args[i], n => w.names.get(n)));
            return [{ world: w, family: def.name, index }];
        }
        // A call: one world per clause it can take, with that clause's claim.
        const recursive = head.name === name;
        const callee = recursive ? (shrinking === undefined ? undefined : clauses) : proven.get(head.name);
        if (!callee || args.length !== callee[0].params.length) return undefined;
        // The arguments' indices, each computed in turn (Cons x acc); one with
        // several cases is not known.
        let base = w;
        const given = args.map(a => {
            const o = outcomes(a, base.clone(), depth + 1);
            if (o?.length !== 1) return undefined;
            base = o[0].world;
            return { family: o[0].family, index: o[0].index };
        });
        // Clauses that all claim the same of their parameters' indices need no cases.
        const same = uniform(callee);
        if (same) {
            const index = same.index.map(a => {
                let out: Affine | undefined = constant(a.c);
                for (const [key, k] of a.v) {
                    const [n, at] = key.split(":").map(Number), x = given[n]?.index[at];
                    out = out && x && plus(out, x, k);
                }
                return out;
            });
            if (index.every(x => x)) {
                if (recursive) base.assumed.push(...clauses.keys());
                return [{ world: base, family: same.family, index }];
            }
        }
        const result: Outcome[] = [];
        for (const [j, c] of callee.entries()) {
            const claim = claimOf(c);
            if (!claim) return undefined;
            // The callee's names are its own.
            const world = base.clone(), { names, values } = world;
            world.names = new Map(); world.values = new Map();
            begin(c, world, given);
            const index = positions.get(claim.family)!.map(i => affine(claim.args[i], n => world.names.get(n)));
            world.names = names; world.values = values;
            if (world.impossible) continue;
            c.params.forEach((p, n) => {
                const tag = tagAt(p), arg = unwrap(args[n]);
                if (tag && arg.t === "var") world.cases.push(`${arg.name} is ${tag}`);
            });
            if (!reachable(callee, j)) world.certain = false;
            if (recursive) world.assumed.push(j);
            result.push({ world, family: claim.family, index });
        }
        return result;
    };

    let all = true;
    const errors: (ClaimFailure & { clause: number; assumed: number[] })[] = [];
    for (const [n, c] of clauses.entries()) {
        const claim = claimOf(c);
        if (!claim) { all = false; continue; }
        const { world } = begin(c);
        if (world.impossible) continue;
        const claimed = positions.get(claim.family)!.map(i => affine(claim.args[i], name => world.names.get(name)));
        const found = outcomes(claim.body, world);
        if (!found) { all = false; continue; }
        for (const o of found) {
            if (o.world.impossible) continue;
            if (o.family !== claim.family) { all = false; continue; }
            for (const [i, at] of positions.get(claim.family)!.entries()) {
                const want = claimed[i], have = o.index[i];
                if (!want || !have) { all = false; continue; }
                const d = o.world.normal(plus(want, have, -1n));
                if (!d.v.size && !d.c) continue;
                all = false;
                if (d.v.size || !o.world.certain || o.world.constrained || !reachable(clauses, n)) continue;
                const when = o.world.cases.length ? `when ${o.world.cases.join(" and ")}, ` : "";
                const source = text(claim.args[at]);
                errors.push({
                    clause: n, assumed: o.world.assumed,
                    at: c.body,
                    message: `the claim ${claim.family} ${claim.args.map(a => wrap(text(a))).join(" ")} does not hold: ` +
                        `${when}${source} is ${o.world.text(want)} but the body's index is ${o.world.text(have)}`,
                });
            }
        }
    }
    // A wrong claim can make a clause that assumes it look wrong: report one
    // that assumed only claims with no error of their own.
    const wrong = new Set(errors.map(e => e.clause));
    const error = errors.find(e => e.assumed.every(j => !wrong.has(j))) ?? errors[0];
    return error ? { message: error.message, at: error.at } : all;
}

// Source-like text of an index or type argument.
function text(e: Expr): string {
    e = unwrap(e);
    switch (e.t) {
        case "int": return `${e.v}`;
        case "var": return e.name;
        case "placeholder": return "_";
        case "binop": return `${text(e.l)} ${e.op} ${text(e.r)}`;
        case "app": return `${text(e.f)} ${wrap(text(e.a))}`;
        default: return "…";
    }
}
const wrap = (s: string) => s.includes(" ") ? `(${s})` : s;
