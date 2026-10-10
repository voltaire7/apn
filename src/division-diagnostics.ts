import { sourceLocations, type Expr, type TopLevel } from "./ast.ts";
import type { Diagnostic } from "./lint.ts";

// Warnings for a literal zero divisor: x / 0, x % 0, quotient x 0, remainder
// x 0, modulo x 0. Each fails when demanded, except / with a Float dividend,
// which gives an infinity; a zero Float divisor of / is IEEE division and is
// not reported. Like the other lint analyses, this never evaluates APN.
export function divisionDiagnostics(program: TopLevel[], source: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const pos = (offset: number) => {
        const lines = source.slice(0, offset).split("\n");
        return { line: lines.length - 1, character: lines.at(-1)!.length };
    };
    const report = (divisor: Expr, message: string) => {
        const at = sourceLocations.get(divisor);
        if (!at) return;
        const end = at.start + source.slice(at.start, at.end).trimEnd().length;
        diagnostics.push({ range: { start: pos(at.start), end: pos(end) }, severity: 2, source: "apn", code: "zeroDivisor", message });
    };
    const visit = (node: unknown): void => {
        if (Array.isArray(node)) { node.forEach(visit); return; }
        if (!node || typeof node !== "object") return;
        const n = node as Record<string, unknown>;
        if ("p" in n) return;
        if (n.t === "binop" && n.op === "/" && zero(n.r, false) && !floating(n.l as Expr)) {
            report(n.r as Expr, "division by zero fails unless the dividend is a Float; safeDiv gives None for a zero divisor");
        } else if (n.t === "binop" && n.op === "%" && zero(n.r, true)) report(n.r as Expr, "remainder by zero always fails");
        else if (n.t === "app" && zero(n.a, true)) {
            const f = n.f as Expr;
            const name = f.t === "app" && f.f.t === "var" ? f.f.name : undefined;
            if (name === "quotient") report(n.a as Expr, "division by zero always fails");
            if (name === "remainder" || name === "modulo") report(n.a as Expr, "remainder by zero always fails");
        }
        for (const value of Object.values(n)) if (value && typeof value === "object") visit(value);
    };
    visit(program);
    return diagnostics;
}

// A zero literal, perhaps negated or in parentheses; a Float one only when
// floats count.
function zero(e: unknown, floats: boolean): boolean {
    const x = e as Expr;
    if (x?.t === "block" && x.stmts.length === 1) return zero(x.stmts[0], floats);
    if (x?.t === "unop" && x.op === "neg") return zero(x.e, floats);
    return x?.t === "int" && x.v === 0n || floats && x?.t === "float" && x.v === 0;
}

function floating(e: Expr): boolean {
    if (e.t === "block" && e.stmts.length === 1) return floating(e.stmts[0]);
    if (e.t === "unop" && e.op === "neg") return floating(e.e);
    return e.t === "float";
}
