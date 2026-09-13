import { keySource } from "./record-keys.ts";
import type { Expr, Pattern } from "./ast.ts";
import type { Value } from "./types.ts";
import { exprToSource, functionSpecSource } from "./parser.ts";
import { valueToString } from "./types.ts";

function pattern(p: Pattern): string {
    switch (p.p) {
        case "contract": return `((${functionSpecSource(p.spec)}) ${pattern(p.value)})`;
        case "wildcard": return "_";
        case "var": return p.name;
        case "int": return String(p.v);
        case "bool": return String(p.v);
        case "string": return JSON.stringify(p.v);
        case "list": return `[${p.v.map(pattern).join(", ")}]`;
        case "cons": return `(${pattern(p.head)} : ${pattern(p.tail)})`;
        case "constr": return p.args.length ? `(${p.tag} ${p.args.map(pattern).join(" ")})` : p.tag;
        case "typeBind": return `(${p.name} ${pattern(p.value)})`;
        case "recPat": return `[${p.v.map(([k, v]) => `${keySource(k)}: ${v}`).join(", ")}]`;
        case "range": return `[${p.lo}..${p.hi}]`;
    }
}
const precedence: Record<string, number> = { "||": 2, "&&": 3, "==": 4, "!=": 4, "<": 4, ">": 4, "<=": 4, ">=": 4, ":": 5, "++": 5, "+": 6, "-": 6, "*": 7, "/": 7, "%": 7 };
function source(e: Expr, parent = 0): string {
    let text: string, level = 12;
    switch (e.t) {
        case "string": return JSON.stringify(e.v);
        case "app": level = 10; text = `${source(e.f, 10)} ${source(e.a, 11)}`; break;
        case "binop": {
            level = precedence[e.op];
            const right = e.op === ":" || e.op === "++";
            text = `${source(e.l, level + (right ? 1 : 0))} ${e.op} ${source(e.r, level + (right ? 0 : 1))}`;
            break;
        }
        case "unop": level = 9; text = `${e.op === "neg" ? "-" : "!"}${source(e.e, 9)}`; break;
        case "patternLambda": level = 0; text = `${e.params.map(pattern).join(" ")}${e.guard ? " | " + source(e.guard) : ""} -> ${source(e.body)}`; break;
        case "lambda": level = 0; text = `${e.params.join(" ")} -> ${source(e.body)}`; break;
        case "pipe": level = 1; text = `${source(e.x, 1)} $ ${source(e.f, 2)}`; break;
        case "ternary": level = 0; text = `${source(e.cond, 1)} ? ${source(e.then)} : ${source(e.els)}`; break;
        case "list": return `[${e.v.map(x => source(x)).join(", ")}]`;
        case "record": return `[${e.v.map(([k, v]) => `${keySource(k)}: ${source(v)}`).join(", ")}]`;
        case "block": {
            if (e.style === "(" && e.stmts.length === 1) return `(${source(e.stmts[0])})`;
            return `{ ${e.stmts.map(x => source(x)).join("; ")} }`;
        }
        case "stmDef": return e.clauses.map(c => `${e.name}${c.params.length ? " " + c.params.map(pattern).join(" ") : ""} = ${source(c.body)}`).join("; ");
        case "patDef": return `${pattern(e.pattern)} ${e.eager ? "<-" : "="} ${source(e.value)}`;
        case "recordAccess": return `${source(e.rec, 11)}.${typeof e.field === "string" ? keySource(e.field) : `(${source(e.field)})`}`;
        default: return exprToSource(e);
    }
    return level < parent ? `(${text})` : text;
}
// Inspect syntax only: never demand bound arguments or walk a captured environment.
function argument(v: Value): string {
    if (v.kind === "thunk") return source(v.body);
    if (v.kind === "deferred") return "<deferred>";
    return valueToString(v);
}
export function functionSource(v: Extract<Value, { kind: "closure" | "clauseFn" | "native" }>): string {
    if (v.kind === "closure") return `${v.params.length ? v.params.join(" ") : "()"} -> ${source(v.body)}`;
    if (v.kind === "native") {
        const name = v.tag ?? v.name;
        return name + v.applied.map(a => ` (${argument(a)})`).join("");
    }
    const text = v.clauses.length === 1
        ? `${v.clauses[0].params.map(pattern).join(" ")}${v.clauses[0].guard ? " | " + source(v.clauses[0].guard) : ""} -> ${source(v.clauses[0].body)}`
        : v.clauses.map(c => `${v.name} ${c.params.map(pattern).join(" ")} = ${source(c.body)}`).join("\n");
    return v.applied.length ? `(${text})${v.applied.map(a => ` (${argument(a)})`).join("")}` : text;
}
