import { APNError, didYouMean } from "./errors.ts";
import type { Expr, Pattern, TopLevel, Alt } from "./ast.ts";
import type { DefClause, Type } from "./types.ts";
import { type Value, Env } from "./types.ts";
import { mkInt, mkBool, mkStr, mkList, valueToString, rawString } from "./types.ts";
import { parse, exprToSource } from "./parser.ts";

// ---------------- Evaluator ----------------

const STACK_LIMIT = 200; // below V8's own JS stack, so APN errors first

// Native registry: name -> arity. One source of truth for env registration
// and for REPL tab completion.
export const NATIVES: Array<[string, number]> = [
    ["print", 1], ["head", 1], ["tail", 1], ["length", 1], ["null", 1],
    ["enumerate", 1], ["map", 2], ["filter", 2], ["foldl", 3], ["foldr", 3],
    ["intToString", 1], ["pairs", 1], ["format", 2], ["zipWith", 3],
    ["take", 2], ["drop", 2], ["toString", 1], ["parse", 1], ["debug", 1], ["exit", 1], ["load", 1],
    ["emit", 1], ["step", 2], ["quote", 1], ["toAST", 1],
];

export class Interpreter {
    env = new Env();
    stack = 0;
    // Directory of the source file currently being evaluated — `load` resolves
    // relative paths against it ("relative to your current file").
    sourceDir: string = ".";

    constructor() {
        for (const [name, arity] of NATIVES) {
            this.env.setLocal(name, { kind: "native", name, arity, applied: [] });
        }
    }

    run(program: TopLevel[]): Value {
        let last: Value = { kind: "unit" };
        for (const tl of program) {
            if (tl.t === "data") {
                for (const v of tl.def.variants) {
                    if (v.arity === 0) {
                        // Nullary constructors are themselves the value.
                        this.env.setLocal(v.tag, { kind: "variant", tag: v.tag, v: [] });
                    } else {
                        this.env.setLocal(v.tag, {
                            kind: "native", name: "__constr", arity: v.arity, applied: [], tag: v.tag,
                        });
                    }
                }
                continue;
            }
            if (tl.t === "def") {
                last = this.evalDef(tl.name, tl.clauses);
                continue;
            }
            if (tl.t === "patDef") {
                last = this.evalPatBinding(tl);
                continue;
            }
            // a bare expression statement: 0-arg functions and thunks RUN here
            last = this.runStmt(this.eval(tl.value));
        }
        return last;
    }

    evalDef(name: string, clauses: DefClause[]): Value {
        // A one-index equation on an existing list is a scoped update.
        // Unbound/function names retain ordinary pattern-clause definitions.
        const previous = this.env.get(name);
        if (previous !== undefined && clauses[0].params.length > 0 &&
            previous.kind !== "clauseFn" && previous.kind !== "native" &&
            !(previous.kind === "closure" && previous.params.length > 0) &&
            !(previous.kind === "thunk" && previous.body.t === "placeholder")) {
            let list = this.demand(previous);
            if (this.isList(list)) {
                for (const clause of clauses) {
                    if (clause.params.length !== 1 || clause.params[0].p !== "int") {
                        throw new APNError("runtime", "list assignment needs one integer literal index");
                    }
                    const index = clause.params[0].v;
                    // Resolve the RHS against the old binding, before rebinding.
                    const value = this.demand(this.eval(clause.body));
                    list = this.setIndex(list, index, value);
                    this.env.setLocal(name, list);
                }
                return list;
            }
        }
        // A def with parameters is a pattern-dispatch function.
        if (clauses[0].params.length >= 1) {
            const arity = clauses[0].params.length;
            // Capture a shared env containing the binding itself, enabling recursion.
            const child = new Env(this.env);
            const fn: Value = {
                kind: "clauseFn", name, clauses, arity, env: child, applied: [],
            };
            child.setLocal(name, fn);
            this.env.setLocal(name, fn);
            return fn;
        }
        // Value-style def: single clause, no params.
        const value = clauses[0].body;
        // Lambda bodies become closures (with recursion via shared env), like before.
        if (value.t === "lambda") {
            const child = new Env(this.env);
            const clo: Value = { kind: "closure", params: value.params, body: value.body, env: child };
            child.setLocal(name, clo);
            this.env.setLocal(name, clo);
            return clo;
        }
        // An ACTION body (a block, an application, or a pipe — with or without
        // {}s, `f = print "hi"` == `f = { print "hi" }`) declares a 0-arg
        // FUNCTION: nothing runs at the definition, expression position yields
        // the function itself, statement position CALLS it (the bare name runs).
        if (value.t === "block" || value.t === "app" || value.t === "pipe") {
            const child = new Env(this.env);
            const clo: Value = { kind: "closure", params: [], body: value, env: child };
            child.setLocal(name, clo);
            this.env.setLocal(name, clo);
            return clo;
        }
        // Otherwise it's a lazy value binding: a THUNK. The body is not run at
        // definition time. Forcing memoizes the outer value across aliases and
        // arguments; lazy container components retain their own thunks.
        const thunk: Value = { kind: "thunk", body: value, env: this.env, value: undefined };
        this.env.setLocal(name, thunk);
        return thunk;
    }

    // Destructuring binding:  [name, hello] = value  (or (Just x) = value, ...).
    // Evaluates the RHS, matches the pattern, and binds the destructured names
    // in the CURRENT environment (top level or the enclosing block's env).
    evalPatBinding(b: { pattern: Pattern; value: Expr }): Value {
        const v = this.force(this.eval(b.value));
        const binds = new Map<string, Value>();
        if (!this.matchPattern(b.pattern, v, binds)) {
            throw new Error("Runtime: binding pattern did not match its value");
        }
        for (const [k, bv] of binds) this.env.setLocal(k, bv);
        return v;
    }


    // S-expression of an expression: nested APN lists, head first —
    //   toAST (1 + 2)  =>  [+, 1, 2]
    sexprOf(e: import("./ast.ts").Expr): Value {
        switch (e.t) {
            case "int": return mkInt(e.v);
            case "float": return { kind: "float", v: e.v };
            case "bool": return mkBool(e.v);
            case "string": return mkStr(e.v);
            case "char": return { kind: "char", v: e.v };
            case "unit": return { kind: "unit" };
            case "placeholder": return mkStr("_");
            case "var": return mkStr(e.name);
            case "binop": return mkList([mkStr(e.op), this.sexprOf(e.l), this.sexprOf(e.r)]);
            case "unop": return mkList([mkStr(e.op), this.sexprOf(e.e)]);
            case "app": return mkList([this.sexprOf(e.f), this.sexprOf(e.a)]);
            case "lambda": return mkList([mkStr("->"), mkStr(e.params.join(" ")), this.sexprOf(e.body)]);
            case "list": return mkList(e.v.map((x) => this.sexprOf(x)));
            case "record":
                return mkList(e.v.map(([k, x]) => mkList([mkStr(k), this.sexprOf(x)])));
            case "ternary":
                return mkList([mkStr("?:") as Value, this.sexprOf(e.cond), this.sexprOf(e.then), this.sexprOf(e.els)]);
            case "block": {
                // a single-statement ( ) group is transparent — toAST (1 + 2) => [+, 1, 2]
                const one = e.stmts.length === 1 && e.style === "(" && e.stmts[0].t !== "stmDef" && e.stmts[0].t !== "patDef";
                if (one) return this.sexprOf(e.stmts[0]);
                return mkList(e.stmts.map((st) => this.sexprOf(st.t === "stmDef" ? st.clauses[0].body : st.t === "patDef" ? st.value : st)));
            }
            case "match": return mkList([mkStr("match"), this.sexprOf(e.scrut)]);
            case "pipe": return mkList([mkStr("$"), this.sexprOf(e.x), this.sexprOf(e.f)]);
            case "recordAccess":
                return mkList([mkStr("."), this.sexprOf(e.rec), typeof e.field === "string" ? mkStr(e.field) : this.sexprOf(e.field)]);
            default: return mkList([mkStr(e.t)]);
        }
    }


    // A concrete value back to a literal expression (for step's evaluation
    // levels): lists/records rebuild structurally, so  [1 + 2]  steps to  [3].
    valueToExpr(v: Value): Expr {
        v = this.demand(v);
        if (this.isList(v)) return { t: "list", v: this.items(v).map((x) => this.valueToExpr(x)) };
        switch (v.kind) {
            case "int": return { t: "int", v: v.v };
            case "float": return { t: "float", v: v.v };
            case "bool": return { t: "bool", v: v.v };
            case "string": return { t: "string", v: v.v };
            case "char": return { t: "char", v: v.v };
            case "unit": return { t: "unit" };
            case "list": return { t: "list", v: v.v.map((x) => this.valueToExpr(x)) };
            case "record":
                return { t: "record", v: v.v.map(([k, x]) => [k, this.valueToExpr(x)] as [string, Expr]) };
            default: return { t: "var", name: "<" + v.kind + ">" };
        }
    }

    // step n v — descend n levels into v's unevaluated structure (resolving
    // names, unwrapping blocks/thunks/0-arg bodies) and return a LIVE 0-arg
    // action over the level's expression: debug shows its source, print RUNS it.
    stepNative(argsIn: Value[]): Value {
        const n = this.demand(argsIn[0]);
        if (n.kind !== "int" || n.v < 0) {
            throw new APNError("runtime", "step needs a non-negative int count");
        }
        const t = argsIn[1];
        // the argument's thunk wrapper is NOT a level — level 0 is its body
        let expr: import("./ast.ts").Expr | null = t.kind === "thunk" ? t.body : null;
        let val: Value = { kind: "unit" };
        for (let i = 0n; i < n.v; i++) {
            checkInterrupt();
            // free descents: names resolve, blocks expose their last statement
            for (;;) {
                if (expr !== null && expr.t === "var") {
                    val = this.env.get(expr.name) ?? { kind: "unit" };
                    expr = null;
                } else if (expr !== null && expr.t === "block") {
                    const last = expr.stmts[expr.stmts.length - 1];
                    if (last.t === "stmDef" || last.t === "patDef") break;
                    expr = last;
                } else break;
            }
            // the level: a 0-arg action or a thunk opens its body (structural);
            // anything computable evaluates ONE level (step 1 [1 + 2] => [3])
            const act = val.kind === "closure" && val.params.length === 0
                ? val
                : val.kind === "thunk"
                ? val
                : null;
            if (act !== null) {
                expr = act.body;
                val = { kind: "unit" };
                continue;
            }
            if (
                expr === null ||
                ["int", "float", "bool", "string", "char", "unit"].includes(expr.t)
            ) break;
            expr = this.valueToExpr(this.demand(this.eval(expr)));
            val = { kind: "unit" };
        }
        if (expr === null) return val;
        return { kind: "closure", params: [], body: expr, env: this.env };
    }



    // `*` iteration: seq * fn — applies fn over the sequence and returns the
    // results. seq is a list (elements), a record (entries as [field, value]
    // lists), or an int n (0..n-1; a negative n counts 0, -1, ... n+1).
    iterate(seq: Value, f: Value): Value {
        const out: Value[] = [];
        if (this.isList(seq)) {
            for (const x of this.elements(seq)) out.push(this.demand(this.apply(f, x)));
        } else if (seq.kind === "record") {
            for (const [k, x] of seq.v) out.push(this.apply(f, mkList([mkStr(k), x])));

        } else if (seq.kind === "int") {
            const n = seq.v < 0n ? -seq.v : seq.v;
            for (let i = 0n; i < n; i++) {
                checkInterrupt();
                out.push(this.apply(f, mkInt(seq.v >= 0n ? i : -i)));
            }
        } else {
            throw new APNError("runtime", `cannot iterate a ${seq.kind}`, {
                hint: "expected a list, a record, or an int count",
            });
        }
        return mkList(out);
    }

    // Run a 0-arg function (an action def: f = { ... } / f = print "hi").
    // Non-closures pass through unchanged.
    callBlockFn(v: Value): Value {
        if (v.kind !== "closure" || v.params.length !== 0) return v;
        const old = this.env;
        this.env = v.env;
        try {
            return this.eval(v.body);
        } finally {
            this.env = old;
        }
    }

    // Demand only the outer value. Actions remain repeatable, while argument
    // thunks share the result of an action within a call.
    demand(v: Value): Value {
        const original = v;
        v = this.force(v);
        while (v.kind === "closure" && v.params.length === 0) {
            checkInterrupt();
            v = this.force(this.callBlockFn(v));
        }
        if (original.kind === "thunk" || original.kind === "deferred") original.value = v;
        return v;
    }

    runStmt(v: Value): Value {
        return this.demand(v);
    }

    eval(e: Expr): Value {
        this.stack++;
        try {
            if (this.stack > STACK_LIMIT) {
                throw new APNError("runtime", "call stack overflow", {
                    hint: "unbounded strict recursion? Use a lazy cons tail to produce lists incrementally.",
                });
            }
            let r: Value;
            switch (e.t) {
                case "int": r = mkInt(e.v); break;
                case "float": r = { kind: "float", v: e.v }; break;
                case "bool": r = mkBool(e.v); break;
                case "string": r = mkStr(e.v); break;
                case "char": r = { kind: "char", v: e.v }; break;
                case "unit": r = { kind: "unit" }; break;
                case "placeholder": throw new APNError("runtime", "not implemented: '_' placeholder");
                case "var": {
                    const v = this.env.get(e.name);
                    if (v === undefined) {
                        const near = didYouMean(e.name, envNames(this.env));
                        throw new APNError("runtime", `unbound variable '${e.name}'`, {
                            hint: near ? `did you mean '${near}'?` : undefined,
                        });
                    }
                    r = v;
                    break;
                }
                case "binop": r = this.evalBinop(e); break;
                case "unop": {
                    const v = this.demand(this.eval(e.e));
                    if (e.op === "neg") {
                        r = (v.kind === "int" || v.kind === "float")
                            ? { kind: v.kind === "int" ? "int" : "float", v: -v.v } as Value
                            : { kind: "unit" };
                    } else {
                        r = v.kind === "bool" ? mkBool(!v.v) : { kind: "unit" };
                    }
                    break;
                }
                case "app":
                    // ARGUMENTS ARE LAZY (Haskell): the argument is wrapped, unevaluated,
                    // and forced/ran only where a real value is needed
                    r = this.apply(this.eval(e.f), { kind: "thunk", body: e.a, env: this.env });
                    break;
                case "lambda": r = { kind: "closure", params: e.params, body: e.body, env: this.env }; break;
                case "ternary": {
                    const c = this.demand(this.eval(e.cond));
                    r = (c.kind === "bool" && c.v) ? this.eval(e.then) : this.eval(e.els);
                    break;
                }
                case "match": r = this.evalMatch(this.delay(e.scrut), e.alts); break;
                case "range": r = { kind: "range", lo: e.lo, step: e.step, hi: e.hi }; break;
                case "floatRange": r = { kind: "floatRange", lo: e.lo, step: e.step, hi: e.hi }; break;
                case "list": r = { kind: "lazyList", exprs: e.v, env: this.env }; break;
                case "record": r = { kind: "record", v: e.v.map(([k, x]) => [k, this.eval(x)] as [string, Value]) }; break;
                case "recordAccess": {
                    let rec = this.callBlockFn(this.eval(e.rec));
                    // `core = load "..."` is a thunk; get the module WITHOUT forcing its
                    // fields (a module may contain `halt = exit 0`).
                    if (rec.kind === "thunk") rec = this.unpackThunk(rec);
                    let field: string;
                    if (typeof e.field === "string") {
                        field = e.field;
                    } else {
                        const kv = this.force(this.eval(e.field));
                        if (kv.kind !== "string" && kv.kind !== "int" && kv.kind !== "float") {
                            throw new Error("Runtime: dynamic field (parenthesized key) must be a string or number");
                        }
                        field = kv.kind === "string" ? kv.v : String(kv.v);
                    }
                    if (rec.kind !== "record") throw new Error("record access on non-record");
                    const f = rec.v.find(([k]) => k === field);
                    if (!f) {
                        const near = didYouMean(field, rec.v.map(([k]) => k));
                        throw new APNError("runtime", `record has no field '${field}'`, {
                            hint: near ? `did you mean '${near}'?` : undefined,
                        });
                    }
                    r = f[1];
                    break;
                }
                case "pluck": {
                    let rec = this.callBlockFn(this.eval(e.rec));
                    if (rec.kind === "thunk") rec = this.unpackThunk(rec);
                    if (rec.kind !== "record") throw new Error("pluck on non-record");
                    const byKey = new Map(rec.v);
                    if (e.entries.every((x) => typeof x === "string")) {
                        const out: Value[] = [];
                        for (const n of e.entries as string[]) {
                            const v = byKey.get(n);
                            if (v === undefined) {
                                const near = didYouMean(n, rec.v.map(([k]) => k));
                                throw new APNError("runtime", `record has no field '${n}'`, {
                                    hint: near ? `did you mean '${near}'?` : undefined,
                                });
                            }
                            out.push(v);
                        }
                        r = { kind: "list", v: out };
                    } else {
                        const out: Array<[string, Value]> = [];
                        for (const [src, dst] of e.entries as Array<[string, string]>) {
                            const v = byKey.get(src);
                            if (v === undefined) {
                                const near = didYouMean(src, rec.v.map(([k]) => k));
                                throw new APNError("runtime", `record has no field '${src}'`, {
                                    hint: near ? `did you mean '${near}'?` : undefined,
                                });
                            }
                            out.push([dst, v]);
                        }
                        r = { kind: "record", v: out };
                    }
                    break;
                }
                case "setFields": {
                    // eager: read the OLD record and the RHS fully BEFORE building the
                    // new one, so  vec.[x, y] = vec.[y, x]  swaps correctly
                    let rec = this.callBlockFn(this.eval(e.rec));
                    if (rec.kind === "thunk") rec = this.unpackThunk(rec);
                    if (this.isList(rec) && this.cell(rec) === null) rec = mkList([]);
                    let base: Array<[string, Value]> | null = null;
                    if (rec.kind === "record") base = rec.v;
                    else if (rec.kind === "list" && rec.v.length === 0) base = []; // [] seeds a record
                    if (base === null) {
                        throw new APNError("runtime", `cannot set a field on a ${rec.kind}`, {
                            hint: "only records accept fields (an empty list promotes to a record)",
                        });
                    }
                    const rhsValue = this.demand(this.eval(e.value));
                    const rhs = this.isList(rhsValue) ? mkList(this.items(rhsValue).map((x) => this.demand(x))) : rhsValue;
                    if (rhs.kind !== "list") {
                        throw new APNError("runtime", "field assignment needs a list of values on the right");
                    }
                    if (rhs.v.length !== e.entries.length) {
                        throw new APNError(
                            "runtime",
                            `${e.entries.length} field${e.entries.length === 1 ? "" : "s"} need ${e.entries.length} value${e.entries.length === 1 ? "" : "s"} (got ${rhs.v.length})`,
                        );
                    }
                    const out = base.map(([k, v]) => [k, v] as [string, Value]);
                    for (let i = 0; i < e.entries.length; i++) {
                        const idx = out.findIndex(([k]) => k === e.entries[i]);
                        if (idx === -1) out.push([e.entries[i], rhs.v[i]]);
                        else out[idx] = [e.entries[i], rhs.v[i]];
                    }
                    r = { kind: "record", v: out };
                    break;
                }
                case "pipe": r = this.apply(this.eval(e.f), { kind: "thunk", body: e.x, env: this.env }); break;
                case "block": {
                    const child = new Env(this.env);
                    const old = this.env;
                    this.env = child;
                    try {
                        r = { kind: "unit" };
                        for (let si = 0; si < e.stmts.length; si++) {
                            const s = e.stmts[si];
                            if (s.t === "stmDef") r = this.evalDef(s.name, s.clauses);
                            else if (s.t === "patDef") r = this.evalPatBinding(s);
                            else if (si === e.stmts.length - 1) {
                                // LAST statement = TAIL POSITION: the value flows up UNCALLED —
                                // a returned 0-arg function is trampolined by the CALLER's
                                // runStmt loop, so  func = { print "hi"; func }  loops forever
                                // at constant stack (Ctrl+C breaks it).
                                r = this.eval(s);
                            } else r = this.runStmt(this.eval(s)); // bare name = call
                        }
                        // Reveal the last value without traversing a returned list.
                        // A returned action is run by the caller's demand loop.
                        r = this.force(r);
                    } finally {
                        this.env = old;
                    }
                    break;
                }
                case "stmDef":
                    throw new Error("Runtime: internal error — statement definition used as an expression");
                case "patDef":
                    r = this.evalPatBinding(e);
                    break;
            }
            return r;
        } finally {
            this.stack--;
        }
    }

    evalBinop(e: Extract<Expr, { t: "binop" }>): Value {
        if (e.op === ":") {
            // Reject a definitely non-list tail without evaluating either side.
            // Unknown tails stay lazy, so head (1:missing) remains productive.
            if (["int", "float", "bool", "string", "char", "unit", "record", "lambda"].includes(e.r.t)) {
                throw new APNError("runtime", `cons tail expected a list, got ${e.r.t}`);
            }
            const tail = this.delay(e.r);
            return {
                kind: "cons", head: this.delay(e.l),
                tail: this.defer(() => {
                    const value = this.demand(tail);
                    if (!this.isList(value)) throw new APNError("runtime", `cons tail expected a list, got ${value.kind}`);
                    return value;
                }),
            };
        }
        if (e.op === "++") {
            const l = this.demand(this.eval(e.l));
            const r = this.delay(e.r);
            if (this.isList(l)) return this.append(l, r);
            const right = this.demand(r);
            if (l.kind === "string" && right.kind === "string") return mkStr(l.v + right.v);
            throw new APNError("runtime", `cannot apply '++' to ${l.kind} and ${right.kind}`);
        }
        const l = this.demand(this.eval(e.l));
        const r = this.demand(this.eval(e.r));
        const bad = (): never => {
            throw new APNError("runtime", `cannot apply '${e.op}' to ${l.kind} and ${r.kind}`);
        };
        switch (e.op) {
            case "+":
                if (l.kind === "int" && r.kind === "int") return mkInt(l.v + r.v);
                if (l.kind === "float" && r.kind === "float") return { kind: "float", v: l.v + r.v };
                if (l.kind === "string" && r.kind === "string") return mkStr(l.v + r.v);
                return bad();
            case "-":
                if (l.kind === "int" && r.kind === "int") return mkInt(l.v - r.v);
                if (l.kind === "float" && r.kind === "float") return { kind: "float", v: l.v - r.v };
                return bad();
            case "*":
                // OVERLOADED: with a function on the right, ITERATE —
                //   [1,2,3] * x -> print x     (elements)
                //   [x: 1] * [f, v] -> ...     (entries as [field, value])
                //   100 * x -> print x          (0..99; negatives count down)
                if (r.kind === "closure" || r.kind === "clauseFn" || r.kind === "native") {
                    return this.iterate(l, r);
                }
                if (l.kind === "int" && r.kind === "int") return mkInt(l.v * r.v);
                if (l.kind === "float" && r.kind === "float") return { kind: "float", v: l.v * r.v };
                return bad();
            case "/":
                if (r.kind === "int" && r.v === 0n) throw new APNError("runtime", "division by zero");
                if (r.kind === "float" && r.v === 0) throw new APNError("runtime", "division by zero");
                if (l.kind === "int" && r.kind === "int") return mkInt(l.v / r.v);
                if (l.kind === "float" && r.kind === "float") return { kind: "float", v: l.v / r.v };
                return bad();
            case "%":
                if (r.kind === "int" && r.v === 0n) throw new APNError("runtime", "remainder by zero");
                if (l.kind === "int" && r.kind === "int") return mkInt(l.v % r.v);
                return bad();
            case "==": return mkBool(this.equals(l, r));
            case "!=": return mkBool(!this.equals(l, r));
            case "<": return this.compare(l, r) < 0 ? mkBool(true) : mkBool(false);
            case ">": return this.compare(l, r) > 0 ? mkBool(true) : mkBool(false);
            case "<=": return this.compare(l, r) <= 0 ? mkBool(true) : mkBool(false);
            case ">=": return this.compare(l, r) >= 0 ? mkBool(true) : mkBool(false);
            case "&&":
                if (l.kind === "bool" && r.kind === "bool") return mkBool(l.v && r.v);
                return bad();
            case "||":
                if (l.kind === "bool" && r.kind === "bool") return mkBool(l.v || r.v);
                return bad();

        }
    }

    equals(a: Value, b: Value): boolean {
        a = this.demand(a);
        b = this.demand(b);
        if (this.isList(a) && this.isList(b)) {
            for (;;) {
                checkInterrupt();
                const x = this.cell(a), y = this.cell(b);
                if (x === null || y === null) return x === y;
                if (!this.equals(x.head, y.head)) return false;
                a = x.tail;
                b = y.tail;
            }
        }
        if (a.kind !== b.kind) return false;
        switch (a.kind) {
            case "int": return a.v === (b as any).v;
            case "float": return a.v === (b as any).v;
            case "bool": return a.v === (b as any).v;
            case "string": return a.v === (b as any).v;
            case "char": return a.v === (b as any).v;
            case "unit": return true;
            case "list": {
                const bl = b as any;
                if (a.v.length !== bl.v.length) return false;
                return a.v.every((x, i) => this.equals(x, bl.v[i]));
            }
            case "variant": {
                const bv = b as any;
                return a.tag === bv.tag && this.equals({ kind: "list", v: a.v }, { kind: "list", v: bv.v });
            }
            case "nomatch": return true;
            default: return false;
        }
    }

    compare(a: Value, b: Value): number {
        if (a.kind === "int" && b.kind === "int") return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
        if (a.kind === "float" && b.kind === "float") return a.v - b.v;
        if (a.kind === "string" && b.kind === "string") return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
        if (a.kind === "char" && b.kind === "char") return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
        throw new Error("Runtime: cannot compare these values");
    }

    apply(f: Value, arg: Value): Value {
        // A lazy 0-param def used as a function (`f = g; f 1`) is a thunk — run it.
        f = this.force(f);
        switch (f.kind) {
            case "closure": {
                if (f.params.length === 0) {
                    // a 0-arg action APPLIED to arguments: run it, then hand the
                    // result the argument — keeps partial application working:
                    //   addTwo = add 2   addTwo 10  ==  (add 2) 10
                    return this.apply(this.callBlockFn(f), arg);
                }
                const child = new Env(f.env);
                child.setLocal(f.params[0], arg);
                if (f.params.length === 1) {
                    const old = this.env;
                    this.env = child;
                    try { return this.eval(f.body); } finally { this.env = old; }
                }
                return { kind: "closure", params: f.params.slice(1), body: f.body, env: child };
            }
            case "native": {
                if (f.arity === 0) {
                    return this.callNative(f.name, [], f.tag);
                }
                const args = [...f.applied, arg];
                if (args.length < f.arity) return { ...f, applied: args };
                return this.callNative(f.name, args, f.tag);
            }
            case "clauseFn": {
                const raw = [...f.applied, arg];
                if (raw.length < f.arity) return { ...f, applied: raw };
                // Patterns demand only the structure they inspect. Shared
                // argument thunks prevent repeated effects across fallthrough.
                for (const clause of f.clauses) {
                    const binds = new Map<string, Value>();
                    let ok = true;
                    const args = raw;
                    for (let i = 0; i < clause.params.length; i++) {
                        if (!this.matchPattern(clause.params[i], args[i], binds)) { ok = false; break; }
                    }
                    if (!ok) continue;
                    const child = new Env(f.env);
                    for (const [k, v] of binds) child.setLocal(k, v);
                    const old = this.env;
                    this.env = child;
                    try { return this.eval(clause.body); } finally { this.env = old; }
                }
                throw new APNError(
                    "runtime",
                    `no clause of '${f.name}' matches the given arguments`,
                    { hint: "the definition's patterns don't cover this input" },
                );
            }
            case "list":
            case "lazyList":
            case "cons":
            case "floatRange":
            case "range": {
                const carg = this.demand(arg);
                if (carg.kind === "int") return this.index(f, carg.v);
                if (this.isList(carg)) {
                    const picks = this.items(carg).map((ix) => {
                        ix = this.demand(ix);
                        if (ix.kind !== "int") throw new APNError("runtime", "index must be an int");
                        return this.index(f, ix.v);
                    });
                    return picks.length === 1 ? picks[0] : mkList(picks);
                }
                throw new APNError("runtime", "indexing a list needs an int or a list of ints");
            }
            case "record": {
                // Applying an OBJECT clones it (list = positional, record = named),
                // or an int argument indexes it positionally -> [field, value].
                const value = this.demand(arg);
                const carg = this.isList(value) ? mkList(this.items(value)) : value;
                if (carg.kind === "list") {
                    if (f.v.length !== carg.v.length) {
                        throw new Error(`Runtime: field count (${f.v.length}) does not match list size (${carg.v.length})`);
                    }
                    return { kind: "record", v: f.v.map(([k], i) => [k, carg.v[i]] as [string, Value]) };
                }
                if (carg.kind === "record") {
                    const idx = new Map(f.v.map(([k], i) => [k, i]));
                    const out = f.v.slice();
                    for (const [k, v] of carg.v) {
                        const i = idx.get(k);
                        if (i !== undefined) out[i] = [k, v]; else out.push([k, v]);
                    }
                    return { kind: "record", v: out };
                }
                if (carg.kind === "int") {
                    let i = carg.v;
                    if (i < 0n) i += BigInt(f.v.length);
                    if (i < 0 || i >= f.v.length) {
                        throw new Error(`Runtime: index ${carg.v} out of range (len ${f.v.length})`);
                    }
                    return mkList([mkStr(f.v[Number(i)][0]), f.v[Number(i)][1]]);
                }
                throw new Error("Runtime: applying an object needs a list, a record, or an int index");
            }
            default:
                throw new APNError(
                    "runtime",
                    `cannot call a non-function (${f.kind})`,
                    { hint: "lists index and records clone when applied; ints, strings, bools do nothing" },
                );
        }
    }

    delay(body: Expr): Value {
        return { kind: "thunk", body, env: this.env };
    }

    defer(compute: () => Value): Value {
        return { kind: "deferred", compute };
    }

    // Weak-head evaluation: cache every thunk in an alias chain, never force
    // a cons head/tail or a container field just to reveal its outer shape.
    force(v: Value): Value {
        const pending: Array<Extract<Value, { kind: "thunk" | "deferred" }>> = [];
        try {
            for (;;) {
                checkInterrupt();
                if (v.kind === "lazyList") {
                    const env = v.env;
                    v.value ??= mkList(v.exprs.map((body) => ({ kind: "thunk", body, env })));
                    v = v.value;
                } else if (v.kind === "thunk" || v.kind === "deferred") {
                    if (v.value !== undefined) { v = v.value; continue; }
                    if (v.busy) throw new APNError("runtime", "cyclic evaluation: value depends on itself before producing a value");
                    v.busy = true;
                    pending.push(v);
                    if (v.kind === "deferred") v = v.compute();
                    else {
                        const old = this.env;
                        this.env = v.env;
                        try { v = this.eval(v.body); } finally { this.env = old; }
                    }
                } else break;
            }
            for (const thunk of pending) thunk.value = v;
            return v;
        } finally {
            for (const thunk of pending) thunk.busy = false;
        }
    }

    unpackThunk(v: Value): Value { return this.force(v); }

    isList(v: Value): boolean {
        return v.kind === "list" || v.kind === "lazyList" || v.kind === "cons" || v.kind === "range" || v.kind === "floatRange";
    }

    fromArray(values: Value[], i = 0): Value {
        return this.defer(() => i === values.length ? mkList([]) : {
            kind: "cons", head: values[i], tail: this.fromArray(values, i + 1),
        });
    }

    cell(v: Value): { head: Value; tail: Value } | null {
        v = this.demand(v);
        if (v.kind === "cons") return v;
        if (v.kind === "list") return v.v.length ? { head: v.v[0], tail: this.fromArray(v.v, 1) } : null;
        if (v.kind === "floatRange") {
            const index = v.index ?? 0;
            const current = v.lo + index * v.step;
            const tolerance = v.hi === null || v.step === 0 ? 0 : Math.min(
                Math.abs(v.step) / 2, 4 * Number.EPSILON * Math.max(1, Math.abs(current), Math.abs(v.hi)),
            );
            if (v.hi !== null && (v.step >= 0 ? current > v.hi + tolerance : current < v.hi - tolerance)) return null;
            if (!Number.isFinite(current) || index + 1 === index ||
                (index > 0 && v.step !== 0 && current === v.lo + (index - 1) * v.step)) {
                throw new APNError("runtime", "float range cannot advance at this precision");
            }
            const value = v.hi !== null && Math.abs(current - v.hi) <= tolerance ? v.hi : current;
            return { head: { kind: "float", v: value }, tail: { ...v, index: index + 1 } };
        }
        if (v.kind === "range") {
            if (v.hi !== null && (v.step > 0 ? v.lo > v.hi : v.lo < v.hi)) return null;
            return { head: mkInt(v.lo), tail: { ...v, lo: v.lo + v.step } };
        }
        throw new APNError("runtime", `expected a list, got ${v.kind}`);
    }

    *elements(v: Value): Generator<Value> {
        for (;;) {
            checkInterrupt();
            const cell = this.cell(v);
            if (cell === null) return;
            yield cell.head;
            v = cell.tail;
        }
    }

    items(v: Value): Value[] { return [...this.elements(v)]; }

    index(v: Value, i: bigint): Value {
        const original = i;
        if (i < 0) {
            const values = this.items(v);
            i += BigInt(values.length);
            if (i >= 0 && i < values.length) return values[Number(i)];
        } else {
            for (const value of this.elements(v)) {
                if (i-- === 0n) return value;
            }
        }
        throw new APNError("runtime", `index ${original} out of range`);
    }

    setIndex(list: Value, index: bigint, value: Value): Value {
        const original = index;
        if (index < 0n) {
            const values = this.items(list);
            index += BigInt(values.length);
            if (index < 0n || index >= values.length) throw new APNError("runtime", `index ${original} out of range`);
            values[Number(index)] = value;
            return mkList(values);
        }
        const prefix: Value[] = [];
        for (;;) {
            checkInterrupt();
            const cell = this.cell(list);
            if (cell === null) throw new APNError("runtime", `index ${original} out of range`);
            if (index-- === 0n) {
                let result: Value = { kind: "cons", head: value, tail: cell.tail };
                for (let i = prefix.length - 1; i >= 0; i--) result = { kind: "cons", head: prefix[i], tail: result };
                return result;
            }
            prefix.push(cell.head);
            list = cell.tail;
        }
    }

    append(xs: Value, ys: Value): Value {
        return this.defer(() => {
            const cell = this.cell(xs);
            if (cell === null) {
                const right = this.demand(ys);
                if (!this.isList(right)) throw new APNError("runtime", "list append expects a list");
                return right;
            }
            return { kind: "cons", head: cell.head, tail: this.append(cell.tail, ys) };
        });
    }

    // Rendering is incremental, including nested lists. Consumers decide
    // whether to stream fragments or collect a finite result into a string.
    render(v: Value, emit: (s: string) => void, raw = false, ancestors = new Set<Value>()): void {
        checkInterrupt();
        v = this.demand(v);
        // Track nested values, not successive spine cells: 1:xs may stream
        // forever, but a list containing itself cannot render a first element.
        if (ancestors.has(v)) throw new APNError("runtime", "cannot display a cyclic nested value");
        ancestors.add(v);
        try {
            if (this.isList(v)) {
                emit("[");
                let first = true;
                for (const item of this.elements(v)) {
                    if (!first) emit(", ");
                    first = false;
                    this.render(item, emit, false, ancestors);
                }
                emit("]");
            } else if (v.kind === "record") {
                emit("[");
                v.v.forEach(([key, val], i) => {
                    if (i) emit(", ");
                    emit(key + ": ");
                    // Inspect module actions without running halt; ordinary data
                    // fields still render their memoized values.
                    const field = this.force(val);
                    if (field.kind === "closure" && !field.params.length) emit(valueToString(field));
                    else this.render(field, emit, false, ancestors);
                });
                emit("]");
            } else if (v.kind === "variant") {
                emit(v.tag);
                for (const arg of v.v) { emit(" "); this.render(arg, emit, false, ancestors); }
            } else emit(raw ? rawString(v) : valueToString(v));
        } finally {
            ancestors.delete(v);
        }
    }

    renderString(v: Value, raw = false): string {
        const parts: string[] = [];
        this.render(v, (s) => parts.push(s), raw);
        return parts.join("");
    }

    printValue(v: Value, newline = true, raw = true): void {
        const enc = new TextEncoder();
        let buffer = "";
        this.render(v, (s) => {
            buffer += s;
            if (buffer.length >= 256) {
                Deno.stdout.writeSync(enc.encode(buffer));
                buffer = "";
            }
        }, raw);
        if (newline) console.log(buffer);
        else if (buffer) Deno.stdout.writeSync(enc.encode(buffer));
    }

    callNative(name: string, argsIn: Value[], tag?: string): Value {
        // debug forces without demanding a returned action; quote/toAST inspect
        // syntax and step has its own rules. Ordinary natives (including
        // print and toString) demand values and run zero-argument actions.
        // expression-level natives: they consume the argument's UNEVALUATED form
        if (name === "quote" || name === "toAST") {
            const t = argsIn[0];
            if (t.kind !== "thunk") throw new APNError("runtime", `${name} needs an expression`);
            if (name === "quote") {
                // quote: the expression's SOURCE TEXT as a string (parens kept for
                // ( ) groups); the expression is never evaluated
                const inner = exprToSource(t.body);
                const text = t.body.t === "block" && t.body.style === "(" ? `(${inner})` : inner;
                return mkStr(text);
            }
            return this.sexprOf(t.body);
        }
        if (name === "step") return this.stepNative(argsIn);
        if (name === "debug") {
            // debug = SOURCE inspection: show the argument as written; if what it
            // produces is a 0-arg action (and it wasn't a bare name), show its BODY.
            const t = argsIn[0];
            const forced = this.force(t);
            let text: string;
            if (t.kind === "thunk") {
                const isVar = t.body.t === "var";
                const act = forced.kind === "closure" && forced.params.length === 0
                    ? forced : forced.kind === "thunk" ? forced : null;
                text = !isVar && act ? exprToSource(act.body) : exprToSource(t.body);
            } else text = valueToString(t);
            console.log(text);
            return { kind: "unit" };
        }
        // These natives select their own demand points. In particular take 0
        // never inspects its input, and list producers defer their first cell.
        if (name === "__constr") return { kind: "variant", tag: tag!, v: argsIn };
        if (name === "map") return this.mapList(argsIn[0], argsIn[1]);
        if (name === "filter") return this.filterList(argsIn[0], argsIn[1]);
        if (name === "zipWith") return this.zipList(argsIn[0], argsIn[1], argsIn[2]);
        if (name === "foldr") return this.foldRight(argsIn[0], argsIn[1], argsIn[2]);
        if (name === "take" || name === "drop") {
            const count = this.demand(argsIn[0]);
            if (count.kind !== "int" || count.v < 0) throw new APNError("runtime", `${name} expects a non-negative int count`);
            if (name === "take") return this.takeList(count.v, argsIn[1]);
            let rest = argsIn[1];
            for (let i = 0n; i < count.v; i++) {
                checkInterrupt();
                const cell = this.cell(rest);
                if (cell === null) return mkList([]);
                rest = cell.tail;
            }
            return rest;
        }
        const args = argsIn.map((x) => this.demand(x));
        const a = args[0];
        switch (name) {
            case "print":
                this.printValue(a);
                return a;
            case "emit":
                this.printValue(a, false);
                return a;
            case "toString":
                return mkStr(this.renderString(a));
            case "parse": {
                if (a.kind !== "string") throw new Error("Runtime: parse expects a string");
                const s = a.v.trim();
                if (s === "true") return mkBool(true);
                if (s === "false") return mkBool(false);
                if (/^-?\d+$/.test(s)) return mkInt(BigInt(s));
                if (/^-?\d+\.\d+$/.test(s)) return { kind: "float", v: parseFloat(s) };
                throw new Error(`Runtime: parse: can't parse '${s}'`);
            }
            case "head": {
                const cell = this.cell(a);
                if (cell === null) throw new APNError("runtime", "head of empty list");
                return cell.head;
            }
            case "tail": {
                const cell = this.cell(a);
                if (cell === null) throw new APNError("runtime", "tail of empty list");
                return cell.tail;
            }
            case "length": {
                if (a.kind === "string") return mkInt(a.v.length);
                let n = 0n;
                for (const _ of this.elements(a)) n++;
                return mkInt(n);
            }
            case "null":
                if (a.kind === "string") return mkBool(a.v.length === 0);
                return mkBool(this.cell(a) === null);
            case "enumerate":
                return { kind: "record", v: this.items(a).map((x, i) => [String(i), x] as [string, Value]) };
            case "foldl": {
                const f = args[0];
                let acc = args[1];
                for (const x of this.elements(args[2])) acc = this.demand(this.apply(this.apply(f, acc), x));
                return acc;
            }
            case "intToString":
                if (a.kind !== "int") throw new Error("Runtime: intToString expects int");
                return mkStr(String(a.v));
            case "pairs":
                if (a.kind !== "record") throw new Error("Runtime: pairs expects a record");
                return mkList(a.v.map(([k, v]) => mkList([mkStr(k), v])));
            case "format": {
                const fmt = args[0];
                if (fmt.kind !== "string") throw new Error("Runtime: format expects a string");
                const vals = this.isList(args[1]) ? this.items(args[1]) : [args[1]];
                let out = "";
                let vi = 0;
                for (let i = 0; i < fmt.v.length; i++) {
                    if (fmt.v[i] === "%") {
                        if (fmt.v[i + 1] === "%") { out += "%"; i++; continue; }
                        out += this.renderString(vals[vi] ?? { kind: "unit" }, true);
                        vi++;
                    } else out += fmt.v[i];
                }
                return mkStr(out);
            }
            case "exit":
                // Can be put anywhere in the program: terminates the process instantly.
                if (a.kind !== "int") throw new Error("Runtime: exit expects an int status code");
                // Deno takes a signed 32-bit host exit code; never silently round.
                if (a.v < -2147483648n || a.v > 2147483647n) {
                    throw new APNError("runtime", "exit status must fit a signed 32-bit integer");
                }
                return Deno.exit(Number(a.v));
            case "load": {
                // Import a file, resolving the path relative to the CURRENT source file.
                // Two effects: (1) the loaded file's own definitions are merged into the
                // current scope ("include"); (2) it returns a module record of them, so
                //   core = load "lib/core.apn"; core.halt   (or just core.halt) works.
                // Inside a `{ }` block the merge stays scoped to that block.
                if (a.kind !== "string") throw new Error("Runtime: load expects a file path string");
                const p = a.v;
                const path =
                    this.sourceDir === "." || p.startsWith("/") ? p : `${this.sourceDir}/${p}`;
                let src: string;
                try {
                    src = Deno.readTextFileSync(path);
                } catch (err) {
                    throw new Error(`Runtime: load: can't read '${p}' (looked in '${path}'): ${(err as Error).message}`);
                }
                let program: TopLevel[];
                try {
                    program = parse(src);
                } catch (err) {
                    throw new Error(`Runtime: load: parse error in '${path}': ${(err as Error).message}`);
                }
                const caller = this.env;
                const oldDir = this.sourceDir;
                this.sourceDir = dirname(path);
                const loaded = new Env(caller);
                this.env = loaded;
                try {
                    this.run(program);
                } finally {
                    this.env = caller;
                    this.sourceDir = oldDir;
                }
                // Merge the loaded file's own definitions into the current scope,
                // and return them as a module record (namespaced access: core.halt).
                const fields: Array<[string, Value]> = [];
                for (const [k, val] of loaded.map) {
                    caller.setLocal(k, val);
                    fields.push([k, val]);
                }
                return { kind: "record", v: fields };
            }
        }
        throw new Error(`Runtime: unknown native '${name}'`);
    }

    mapList(f: Value, xs: Value): Value {
        return this.defer(() => {
            const cell = this.cell(xs);
            if (cell === null) return mkList([]);
            return { kind: "cons", head: this.defer(() => this.apply(this.demand(f), cell.head)), tail: this.mapList(f, cell.tail) };
        });
    }

    filterList(f: Value, xs: Value): Value {
        return this.defer(() => {
            for (;;) {
                checkInterrupt();
                const cell = this.cell(xs);
                if (cell === null) return mkList([]);
                const predicate = this.demand(this.apply(this.demand(f), cell.head));
                if (predicate.kind === "bool" && predicate.v) {
                    return { kind: "cons", head: cell.head, tail: this.filterList(f, cell.tail) };
                }
                xs = cell.tail;
            }
        });
    }

    zipList(f: Value, xs: Value, ys: Value): Value {
        return this.defer(() => {
            const x = this.cell(xs);
            if (x === null) return mkList([]);
            const y = this.cell(ys);
            if (y === null) return mkList([]);
            return {
                kind: "cons",
                head: this.defer(() => this.apply(this.apply(this.demand(f), x.head), y.head)),
                tail: this.zipList(f, x.tail, y.tail),
            };
        });
    }

    takeList(n: bigint, xs: Value): Value {
        return this.defer(() => {
            if (n === 0n) return mkList([]);
            const cell = this.cell(xs);
            if (cell === null) return mkList([]);
            return { kind: "cons", head: cell.head, tail: this.takeList(n - 1n, cell.tail) };
        });
    }

    foldRight(f: Value, initial: Value, xs: Value): Value {
        return this.defer(() => {
            const cell = this.cell(xs);
            if (cell === null) return initial;
            return this.apply(this.apply(this.demand(f), cell.head), this.foldRight(f, initial, cell.tail));
        });
    }

    matchPattern(p: Pattern, v: Value, binds: Map<string, Value>): boolean {
        if (p.p === "wildcard") return true;
        if (p.p === "var") { binds.set(p.name, v); return true; }
        v = this.demand(v);
        switch (p.p) {
            case "int": return v.kind === "int" && v.v === p.v;
            case "bool": return v.kind === "bool" && v.v === p.v;
            case "string": return v.kind === "string" && v.v === p.v;
            case "list": {
                if (v.kind === "record") {
                    // A var-only list pattern destructures a record by field name:
                    //   [x, y]  matches  [x: 1, y: 2]  binding x=1, y=2
                    const fields = new Map<string, Value>();
                    for (const [k, val] of v.v) fields.set(k, val);
                    for (const el of p.v) {
                        if (el.p !== "var") return false;
                        if (!fields.has(el.name)) return false;
                        binds.set(el.name, fields.get(el.name)!);
                    }
                    return true;
                }
                if (!this.isList(v)) return false;
                let rest: Value = v;
                for (const pattern of p.v) {
                    const cell = this.cell(rest);
                    if (cell === null || !this.matchPattern(pattern, cell.head, binds)) return false;
                    rest = cell.tail;
                }
                return this.cell(rest) === null;
            }

            case "range":
                // [0..10] matches any int in the range, inclusive
                return v.kind === "int" && v.v >= p.lo && v.v <= p.hi;
            case "recPat": {
                // Keyed record pattern (Rust-style):  [x: a, y: b]  extracts fields x, y
                // from a record and binds a, b to their values.
                if (v.kind !== "record") return false;
                const fields = new Map<string, Value>();
                for (const [k, val] of v.v) fields.set(k, val);
                for (const [key, name] of p.v) {
                    if (!fields.has(key)) return false;
                    binds.set(name, fields.get(key)!);
                }
                return true;
            }
            case "cons": {
                if (!this.isList(v)) return false;
                const cell = this.cell(v);
                if (cell === null) return false;
                const nm = new Map(binds);
                if (!this.matchPattern(p.head, cell.head, nm)) return false;
                return this.matchPattern(p.tail, cell.tail, nm) && this.mergeBinds(binds, nm);
            }
            case "constr": {
                if (v.kind !== "variant" || v.tag !== p.tag) return false;
                if (v.v.length !== p.args.length) return false;
                for (let i = 0; i < p.args.length; i++) {
                    if (!this.matchPattern(p.args[i], v.v[i], binds)) return false;
                }
                return true;
            }
        }
    }

    mergeBinds(orig: Map<string, Value>, added: Map<string, Value>): boolean {
        for (const [k, v] of added) orig.set(k, v);
        return true;
    }

    evalMatch(scrut: Value, alts: Alt[]): Value {
        for (const alt of alts) {
            const binds = new Map<string, Value>();
            if (!this.matchPattern(alt.pattern, scrut, binds)) continue;
            if (alt.guard) {
                const g = this.demand(this.evalWith(binds, alt.guard));
                if (!(g.kind === "bool" && g.v)) continue;
            }
            return this.evalWith(binds, alt.body);
        }
        throw new APNError("runtime", "non-exhaustive match: no alternative fits this value");
    }

    evalWith(binds: Map<string, Value>, e: Expr): Value {
        const child = new Env(this.env);
        for (const [k, v] of binds) child.setLocal(k, v);
        const old = this.env;
        this.env = child;
        try { return this.eval(e); } finally { this.env = old; }
    }
}

// Directory part of a path (no external deps).
export function dirname(p: string): string {
    const i = p.lastIndexOf("/");
    if (i < 0) return ".";
    return i === 0 ? "/" : p.slice(0, i);
}



let interruptFlag: Int32Array | null = null;

export function checkInterrupt(): void {
    if (interruptFlag === null) return;
    checkInterruptInner();
}
let __spinCount = 0;
function checkInterruptInner(): void {
    if (++__spinCount % 100_000_000 === 0) {
        if (Atomics.load(interruptFlag!, 0) === 1) {
            Atomics.store(interruptFlag!, 0, 0);
            throw new APNError("runtime", "interrupted");
        }
    }
    if (
        Atomics.load(interruptFlag!, 0) === 1 ||
        Atomics.wait(interruptFlag!, 0, 0, 0) !== "timed-out" ||
        Atomics.load(interruptFlag!, 1) === 888
    ) {
        Atomics.store(interruptFlag!, 0, 0);
        Atomics.store(interruptFlag!, 1, 0);
        throw new APNError("runtime", "interrupted");
    }
}

export function setInterruptFlag(f: Int32Array | null): void {
    interruptFlag = f;
}

export function resetInterrupt(): void {
    if (interruptFlag !== null) {
        Atomics.store(interruptFlag, 0, 0);
        Atomics.store(interruptFlag, 1, 0);
    }
}

export function envNames(env: Env): string[] {
    const s = new Set<string>();
    for (let e: Env | null = env; e; e = e.parent) {
        for (const k of e.map.keys()) s.add(k);
    }
    return [...s];
}