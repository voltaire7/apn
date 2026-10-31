import { sourceLocations, type Expr, type Pattern, type TopLevel } from "./ast.ts";
import type { Diagnostic } from "./lint.ts";
import { definitionsInOrder } from "./unused-diagnostics.ts";

// Warnings for a function that calls itself with no smaller argument where
// the call is certainly evaluated, so it may never finish: f n = f (n + 1).
// An argument is smaller when it is part of what a parameter's pattern took
// apart (xs from x :: xs, k from S k), the parameter minus a positive number
// (n - 1), or tail of it. A call under a lazy constructor (n :: nats (n + 1)),
// in another function's argument, a lambda or a block (an action's loop) is
// not evaluated by the call itself, so it is not reported. Like the other
// lint analyses, this never evaluates APN.
export function terminationDiagnostics(program: TopLevel[], source: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const pos = (offset: number) => {
        const lines = source.slice(0, offset).split("\n");
        return { line: lines.length - 1, character: lines.at(-1)!.length };
    };
    // Function definitions, in every block, told from item assignments
    // (xs 0 = 1) as the unused-parameter lint tells them.
    const statements = (list: unknown[]): void => definitionsInOrder(list, (node, clauses) => {
        if (clauses) check(node.name as string, clauses);
        visit(node);
    });
    const visit = (node: unknown): void => {
        if (Array.isArray(node)) { node.forEach(visit); return; }
        if (!node || typeof node !== "object") return;
        const n = node as Record<string, unknown>;
        if (n.t === "block") { statements(n.stmts as unknown[]); return; }
        for (const value of Object.values(n)) if (value && typeof value === "object") visit(value);
    };
    const check = (name: string, clauses: Clause[]) => {
        const arity = clauses[0]?.params.length ?? 0;
        if (!arity || !/^[a-z]/.test(name)) return;
        for (const clause of clauses) {
            if (clause.params.length !== arity || clause.params.some(p => binds(p, name))) continue;
            for (const call of strictCalls(clause.body, name, arity)) {
                if (call.args.some((arg, i) => smaller(arg, clause.params[i]))) continue;
                const at = sourceLocations.get(call.expr) ?? sourceLocations.get(clause.body);
                if (!at) continue;
                const end = at.start + source.slice(at.start, at.end).trimEnd().length;
                diagnostics.push({ range: { start: pos(at.start), end: pos(end) }, severity: 2, source: "apn", code: "termination",
                    message: `'${name}' calls itself without a smaller argument; it may never finish` });
            }
        }
    };
    statements(program.map(node => node.t === "expr" ? node.value : node));
    return diagnostics;
}

type Clause = { params: Pattern[]; body: Expr; guard?: Expr };
type Call = { expr: Expr; args: Expr[] };

// Operators that evaluate both operands; : and ++'s right side, and \ are lazy.
const STRICT = new Set(["+", "-", "*", "/", "%", "^", "==", "!=", "<", ">", "<=", ">=", "&&", "||"]);

// The self-calls (name applied to at least arity arguments) that evaluating e
// certainly evaluates: through branches and strict operands, not into other
// functions' arguments, lambdas or blocks.
function strictCalls(e: Expr, name: string, arity: number): Call[] {
    switch (e.t) {
        case "ternary": return [...strictCalls(e.cond, name, arity), ...strictCalls(e.then, name, arity), ...strictCalls(e.els, name, arity)];
        case "binop":
            if (STRICT.has(e.op)) return [...strictCalls(e.l, name, arity), ...strictCalls(e.r, name, arity)];
            return e.op === "++" ? strictCalls(e.l, name, arity) : [];
        // -x is negate x and !x is not x.
        case "unop": return [...strictCalls(e.e, name, arity), ...name === (e.op === "neg" ? "negate" : "not") && arity <= 1 ? [{ expr: e, args: [e.e] }] : []];
        case "pipe": return strictCalls({ t: "app", f: e.f, a: e.x }, name, arity).map(c => ({ ...c, expr: e }));
        case "app": {
            const args: Expr[] = [];
            let head: Expr = e;
            while (head.t === "app") { args.unshift(head.a); head = head.f; }
            if (head.t === "var" && head.name === name && args.length >= arity) return [{ expr: e, args: args.slice(0, arity) }];
            // The head is evaluated; its arguments are not, until it uses them.
            return head.t === "var" ? [] : strictCalls(head, name, arity);
        }
        default: return [];
    }
}

// Is arg smaller than what the parameter p received?
function smaller(arg: Expr, p: Pattern): boolean {
    while (arg.t === "block" && arg.stmts.length === 1) arg = arg.stmts[0];
    const whole = wholeNames(p), parts = partNames(p);
    if (arg.t === "var") return parts.has(arg.name);
    // n - 1, n - k for a positive literal k.
    if (arg.t === "binop" && arg.op === "-" && arg.l.t === "var" && (whole.has(arg.l.name) || parts.has(arg.l.name))) {
        return arg.r.t === "int" && arg.r.v > 0n || arg.r.t === "float" && arg.r.v > 0;
    }
    // tail xs, drop k xs: a list after its first element.
    if (arg.t === "app" && arg.f.t === "var" && arg.f.name === "tail" && arg.a.t === "var") return whole.has(arg.a.name) || parts.has(arg.a.name);
    return false;
}
// The names a pattern binds to the whole argument (n, (Int n), all@...).
function wholeNames(p: Pattern): Set<string> {
    switch (p.p) {
        case "var": return new Set([p.name]);
        case "as": return new Set([...wholeNames(p.left), ...wholeNames(p.right)]);
        case "typeBind": return wholeNames(p.value);
        case "schema": return wholeNames(p.value);
        // A numeric type pattern binds the number itself.
        case "constr": return /^U?Int|^Float|^Number|^Integer/.test(p.tag) && p.args.length === 1 ? wholeNames(p.args[0]) : new Set();
        default: return new Set();
    }
}
// The names a pattern binds to parts of the argument, each smaller than it.
function partNames(p: Pattern): Set<string> {
    const all = (q: Pattern): string[] => {
        switch (q.p) {
            case "var": return [q.name];
            case "as": return [...all(q.left), ...all(q.right)];
            case "typeBind": return [q.name, ...all(q.value)];
            case "schema": return all(q.value);
            case "list": return q.v.flatMap(all);
            case "cons": return [...all(q.head), ...all(q.tail)];
            case "constr": return q.args.flatMap(all);
            case "recPat": return q.v.map(([, name]) => name);
            default: return [];
        }
    };
    switch (p.p) {
        case "as": return new Set([...partNames(p.left), ...partNames(p.right)]);
        case "typeBind": return partNames(p.value);
        case "schema": return partNames(p.value);
        case "list": case "cons": case "recPat": return new Set(all(p));
        // A constructor's fields are parts (S k, Some x); a numeric type's payload is the whole.
        case "constr": return /^U?Int|^Float|^Number|^Integer/.test(p.tag) ? new Set() : new Set(all(p));
        default: return new Set();
    }
}
// Does the pattern bind name (shadowing the function)?
function binds(p: Pattern, name: string): boolean {
    return wholeNames(p).has(name) || partNames(p).has(name);
}
