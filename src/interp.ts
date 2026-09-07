import { APNError, didYouMean } from "./errors.ts";
import type { Expr, Pattern, TopLevel, Alt } from "./ast.ts";
import type { DefClause, Type } from "./types.ts";
import { type Value, Env } from "./types.ts";
import { mkInt, mkBool, mkStr, mkList, valueToString, rawString } from "./types.ts";
import { parse } from "./parser.ts";

// ---------------- Evaluator ----------------

const STACK_LIMIT = 1000; // below V8's own JS stack, so APN errors first

// Native registry: name -> arity. One source of truth for env registration
// and for REPL tab completion.
export const NATIVES: Array<[string, number]> = [
  ["print", 1], ["head", 1], ["tail", 1], ["length", 1], ["null", 1],
  ["enumerate", 1], ["map", 2], ["filter", 2], ["foldl", 3], ["foldr", 3],
  ["intToString", 1], ["for", 2], ["pairs", 1], ["format", 2],
  ["toString", 1], ["parse", 1], ["debug", 1], ["exit", 1], ["load", 1],
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
      last = this.force(this.runStmt(this.eval(tl.value)));
    }
    return last;
  }

  evalDef(name: string, clauses: DefClause[]): Value {
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
    // definition time — it runs (and is cached) the first time the name is
    // forced. This is what lets core.txt define `halt = exit 0` without the
    // process exiting at load time.
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

  // DEMAND a real value: run 0-arg functions and force thunks until something
  // concrete emerges (a lazy argument may unwrap to an action that returns
  // another action, e.g. a block-local `smaller = filter ...` passed to a
  // pattern clause), then force containers so pattern matching sees a list.
  // Demand contexts: operands, record targets, scrutinees, pattern matching.
  // Natives that SHOW values (debug, toString) force instead — inspecting a
  // function yields the function.
  demand(v: Value): Value {
    for (;;) {
      checkInterrupt();
      if (v.kind === "closure" && v.params.length === 0) {
        v = this.callBlockFn(v);
      } else if (v.kind === "thunk") {
        v = this.force(v);
      } else {
        return this.force(v);
      }
    }
  }

  // STATEMENT position: a 0-arg function RUNS (the bare name is the call),
  // and a thunk re-runs UNCACHED (every mention acts). The loop chains:
  //   halt = (load "core.txt").halt ; halt   runs load, then the field's
  // action, then exits.  x = x ; x   re-evaluates forever (true divergence).
  runStmt(v: Value): Value {
    for (;;) {
      checkInterrupt();
      if (v.kind === "closure" && v.params.length === 0) {
        v = this.callBlockFn(v);
      } else if (v.kind === "thunk") {
        const old = this.env;
        this.env = v.env;
        try {
          v = this.eval(v.body);
        } finally {
          this.env = old;
        }
      } else {
        return v;
      }
    }
  }

  eval(e: Expr): Value {
    if (++this.stack > STACK_LIMIT) {
      throw new APNError("runtime", "call stack overflow", {
        hint: "unbounded recursion? each call adds a stack level",
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
      case "match": r = this.evalMatch(this.demand(this.eval(e.scrut)), e.alts); break;
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
        if (rec.kind === "lazyList") rec = this.force(rec);
        let base: Array<[string, Value]> | null = null;
        if (rec.kind === "record") base = rec.v;
        else if (rec.kind === "list" && rec.v.length === 0) base = []; // [] seeds a record
        if (base === null) {
          throw new APNError("runtime", `cannot set a field on a ${rec.kind}`, {
            hint: "only records accept fields (an empty list promotes to a record)",
          });
        }
        const rhs = this.force(this.eval(e.value));
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
              // LAST statement = TAIL POSITION: the value flows up untouched.
              // A returned 0-arg function is trampolined by the caller's
              // runStmt loop — so  func = { print "hi"; func }  loops FOREVER
              // at constant stack (and Ctrl+C breaks it).
              r = this.eval(s);
            } else r = this.runStmt(this.eval(s)); // bare name = call
          }
          // A block's value is its last statement's value — force it, so a
          // trailing `halt`/`exit` (or any thunk) actually runs.
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
    this.stack--;
    return r;
  }

  evalBinop(e: Extract<Expr, { t: "binop" }>): Value {
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
        if (l.kind === "int" && r.kind === "int") return mkInt(l.v * r.v);
        if (l.kind === "float" && r.kind === "float") return { kind: "float", v: l.v * r.v };
        return bad();
      case "/":
        if (r.kind === "int" && r.v === 0) throw new APNError("runtime", "division by zero");
        if (r.kind === "float" && r.v === 0) throw new APNError("runtime", "division by zero");
        if (l.kind === "int" && r.kind === "int") return mkInt(Math.trunc(l.v / r.v));
        if (l.kind === "float" && r.kind === "float") return { kind: "float", v: l.v / r.v };
        return bad();
      case "%":
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
      case "++":
        if (l.kind === "string" && r.kind === "string") return mkStr(l.v + r.v);
        if (l.kind === "list" && r.kind === "list") return mkList([...l.v, ...r.v]);
        return bad();
      case ":":
        if (r.kind === "list") return mkList([l, ...r.v]);
        return bad();
    }
  }

  equals(a: Value, b: Value): boolean {
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
    if (a.kind === "int" && b.kind === "int") return a.v - b.v;
    if (a.kind === "float" && b.kind === "float") return a.v - b.v;
    if (a.kind === "string" && b.kind === "string") return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
    if (a.kind === "char" && b.kind === "char") return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
    throw new Error("Runtime: cannot compare these values");
  }

  apply(f: Value, arg: Value): Value {
    // A lazy 0-param def used as a function (`f = g; f 1`) is a thunk — run it.
    if (f.kind === "thunk") f = this.force(f);
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
        f.applied.push(arg);
        if (f.applied.length < f.arity) return f;
        const args = f.applied;
        f.applied = [];
        return this.callNative(f.name, args, f.tag);
      }
      case "clauseFn": {
        f.applied.push(arg);
        if (f.applied.length < f.arity) return f;
        const raw = f.applied;
        f.applied = [];
        // DEMANDED args (run 0-arg functions + force), memoized once per call
        // so pattern clauses never re-run a side-effecting argument.
        let dem: Value[] | null = null;
        const demanded = () => dem ?? (dem = raw.map((a) => this.demand(a)));
        // Try each clause in order; a clause matches when ALL its params match.
        // All-var clauses bind the arguments UNEVALUATED (Haskell laziness);
        // pattern clauses demand real values to match against.
        for (const clause of f.clauses) {
          const binds = new Map<string, Value>();
          let ok = true;
          const simple = clause.params.every((p) => p.p === "var");
          const args = simple ? raw : demanded();
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
      case "lazyList": {
        // Indexing:  arr 0 -> element,  arr (-1) -> last,  arr [0, 2] -> picks
        const arr = f.kind === "lazyList" ? this.force(f) : f;
        if (arr.kind !== "list") throw new Error("Runtime: value is not a list");
        const carg = this.demand(arg);
        if (carg.kind === "int") {
          let i = carg.v;
          if (i < 0) i += arr.v.length;
          if (i < 0 || i >= arr.v.length) {
            throw new Error(`Runtime: index ${carg.v} out of range (len ${arr.v.length})`);
          }
          return arr.v[i];
        }
        if (carg.kind === "list") {
          const picks = carg.v.map((ix) => {
            if (ix.kind !== "int") throw new Error("Runtime: index must be an int");
            let i = ix.v;
            if (i < 0) i += arr.v.length;
            if (i < 0 || i >= arr.v.length) {
              throw new Error(`Runtime: index ${ix.v} out of range (len ${arr.v.length})`);
            }
            return arr.v[i];
          });
          return picks.length === 1 ? picks[0] : mkList(picks);
        }
        throw new Error("Runtime: indexing a list needs an int or a list of ints");
      }
      case "record": {
        // Applying an OBJECT clones it (list = positional, record = named),
        // or an int argument indexes it positionally -> [field, value].
        const carg = this.demand(arg);
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
          if (i < 0) i += f.v.length;
          if (i < 0 || i >= f.v.length) {
            throw new Error(`Runtime: index ${carg.v} out of range (len ${f.v.length})`);
          }
          return mkList([mkStr(f.v[i][0]), f.v[i][1]]);
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

  // Lazily evaluate a deferred list (and everything nested inside it) into a
  // concrete value. A deferred list, when used as a list, resolves its elements
  // as ordinary variables; when used as an object/template it is never forced
  // and its bare identifiers are read as field names.
  force(v: Value): Value {
    if (v.kind === "lazyList") {
      const old = this.env;
      this.env = v.env;
      try {
        return mkList(v.exprs.map((x) => this.force(this.eval(x))));
      } finally {
        this.env = old;
      }
    }
    if (v.kind === "thunk") {
      if (v.value) return v.value;
      // Follow thunk chains ITERATIVELY, with GHC-style black-hole
      // detection: `x = x` (or `a = b; b = a`) raises <<loop>> instead of
      // hanging the REPL forever.
      let cur: Value = v;
      while (cur.kind === "thunk") {
        checkInterrupt();
        if (cur.value) return cur.value;
        const old = this.env;
        this.env = cur.env;
        let out: Value;
        try {
          out = this.eval(cur.body);
        } finally {
          this.env = old;
        }
        cur = out;
      }
      // cur is concrete now; force nested containers and cache the result
      const forced = this.force(cur);
      v.value = forced;
      return forced;
    }
    if (v.kind === "list") return mkList(v.v.map((x) => this.force(x)));
    if (v.kind === "variant") return { kind: "variant", tag: v.tag, v: v.v.map((x) => this.force(x)) };
    if (v.kind === "record") {
      // Keep thunk fields lazy: a `load` module record may contain `halt = exit 0`
      // and forcing it would terminate the process on import.
      return { kind: "record", v: v.v.map(([k, x]) => [k, x.kind === "thunk" ? x : this.force(x)] as [string, Value]) };
    }
    return v;
  }

  // Evaluate a thunk's BODY but keep the result lazy (do NOT recurse/force).
  // Used where the raw value matters — a `load` module record (whose fields must
  // NOT be forced, they may contain `halt`) or a template lazyList (whose bare
  // names must stay unresolved). A non-lazy result is cached like force does.
  unpackThunk(v: Value): Value {
    if (v.kind !== "thunk") return v;
    if (v.value) return v.value;
    const old = this.env;
    this.env = v.env;
    try {
      const r = this.eval(v.body);
      if (r.kind !== "lazyList") v.value = r;
      return r;
    } finally {
      this.env = old;
    }
  }

  callNative(name: string, argsIn: Value[], tag?: string): Value {
    // SHOWING natives (debug, toString) force: inspecting a 0-arg function
    // yields the function itself. Everything else demands a real value.
    const show = name === "debug" || name === "toString";
    const args = argsIn.map((x) => show ? this.force(x) : this.demand(x));
    const a = args[0];
    switch (name) {
      case "print": {
        if (a.kind !== "string") throw new Error("Runtime: print expects a string (use toString or debug for other values)");
        console.log(a.v);
        return { kind: "unit" };
      }
      case "debug":
        console.log(valueToString(a));
        return { kind: "unit" };
      case "toString":
        return mkStr(valueToString(a));
      case "parse": {
        if (a.kind !== "string") throw new Error("Runtime: parse expects a string");
        const s = a.v.trim();
        if (s === "true") return mkBool(true);
        if (s === "false") return mkBool(false);
        if (/^-?\d+$/.test(s)) return mkInt(parseInt(s, 10));
        if (/^-?\d+\.\d+$/.test(s)) return { kind: "float", v: parseFloat(s) };
        throw new Error(`Runtime: parse: can't parse '${s}'`);
      }
      case "head":
        if (a.kind !== "list") throw new Error("Runtime: head expects a list");
        if (a.v.length === 0) throw new Error("Runtime: head of empty list");
        return a.v[0];
      case "tail":
        if (a.kind !== "list") throw new Error("Runtime: tail expects a list");
        if (a.v.length === 0) throw new Error("Runtime: tail of empty list");
        return mkList(a.v.slice(1));
      case "length":
        if (a.kind === "list") return mkInt(a.v.length);
        if (a.kind === "string") return mkInt(a.v.length);
        throw new Error("Runtime: length expects list or string");
      case "null":
        if (a.kind === "list") return mkBool(a.v.length === 0);
        if (a.kind === "string") return mkBool(a.v.length === 0);
        throw new Error("Runtime: null expects list or string");
      case "enumerate":
        if (a.kind !== "list") throw new Error("Runtime: enumerate expects a list");
        return { kind: "record", v: a.v.map((x, i) => [String(i), x] as [string, Value]) };
      case "map": {
        const f = args[0];
        if (args[1].kind !== "list") throw new Error("Runtime: map expects a list");
        return mkList(args[1].v.map((x) => this.apply(f, x)));
      }
      case "filter": {
        const p = args[0];
        if (args[1].kind !== "list") throw new Error("Runtime: filter expects a list");
        return mkList(args[1].v.filter((x) => {
          const r = this.apply(p, x);
          return r.kind === "bool" && r.v;
        }));
      }
      case "foldl": {
        const f = args[0];
        let acc = args[1];
        if (args[2].kind !== "list") throw new Error("Runtime: foldl expects a list");
        for (const x of args[2].v) acc = this.apply(this.apply(f, acc), x);
        return acc;
      }
      case "foldr": {
        const f = args[0];
        let acc = args[1];
        if (args[2].kind !== "list") throw new Error("Runtime: foldr expects a list");
        for (let i = args[2].v.length - 1; i >= 0; i--) {
          acc = this.apply(this.apply(f, args[2].v[i]), acc);
        }
        return acc;
      }
      case "intToString":
        if (a.kind !== "int") throw new Error("Runtime: intToString expects int");
        return mkStr(String(a.v));
      case "for": {
        // for : fn -> seq -> unit   (like map, but discards results, runs effects)
        // seq is a list (yields each element) or a record (yields each entry
        // as a [field, value] list).
        const f = args[0];
        const seq = args[1];
        if (seq.kind === "list") {
          for (const x of seq.v) this.apply(f, x);
        } else if (seq.kind === "record") {
          for (const [k, v] of seq.v) {
            this.apply(f, mkList([mkStr(k), v]));
          }
        } else throw new Error("Runtime: for expects a list or a record");
        return { kind: "unit" };
      }
      case "pairs":
        if (a.kind !== "record") throw new Error("Runtime: pairs expects a record");
        return mkList(a.v.map(([k, v]) => mkList([mkStr(k), v])));
      case "format": {
        const fmt = args[0];
        if (fmt.kind !== "string") throw new Error("Runtime: format expects a string");
        const vals = args[1].kind === "list" ? args[1].v : [args[1]];
        let out = "";
        let vi = 0;
        for (let i = 0; i < fmt.v.length; i++) {
          if (fmt.v[i] === "%") {
            if (fmt.v[i + 1] === "%") { out += "%"; i++; continue; }
            out += rawString(vals[vi] ?? { kind: "unit" });
            vi++;
          } else out += fmt.v[i];
        }
        return mkStr(out);
      }
      case "__constr":
        return { kind: "variant", tag: tag!, v: args };
      case "exit":
        // Can be put anywhere in the program: terminates the process instantly.
        if (a.kind !== "int") throw new Error("Runtime: exit expects an int status code");
        return Deno.exit(a.v);
      case "load": {
        // Import a file, resolving the path relative to the CURRENT source file.
        // Two effects: (1) the loaded file's own definitions are merged into the
        // current scope ("include"); (2) it returns a module record of them, so
        //   core = load "core.txt"; core.halt   (or just core.halt) works.
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

  // constructor application needs to remember the tag; we use a closure wrapper
  // handled separately in evalDef for data. For simplicity we wrap in apply.

  matchPattern(p: Pattern, v: Value, binds: Map<string, Value>): boolean {
    switch (p.p) {
      case "wildcard": return true;
      case "var":
        binds.set(p.name, v);
        return true;
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
        if (v.kind !== "list" || v.v.length !== p.v.length) return false;
        for (let i = 0; i < p.v.length; i++) {
          if (!this.matchPattern(p.v[i], v.v[i], binds)) return false;
        }
        return true;
      }
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
        if (v.kind !== "list" || v.v.length === 0) return false;
        const nm = new Map(binds);
        if (!this.matchPattern(p.head, v.v[0], nm)) return false;
        return this.matchPattern(p.tail, mkList(v.v.slice(1)), nm) && this.mergeBinds(binds, nm);
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
        const g = this.evalWith(binds, alt.guard);
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
    throw new APNError("runtime", "interrupted");
  }
}

export function setInterruptFlag(f: Int32Array | null): void {
  interruptFlag = f;
}

export function resetInterrupt(): void {
  if (interruptFlag !== null) Atomics.store(interruptFlag, 0, 0);
}

export function envNames(env: Env): string[] {
  const s = new Set<string>();
  for (let e: Env | null = env; e; e = e.parent) {
    for (const k of e.map.keys()) s.add(k);
  }
  return [...s];
}