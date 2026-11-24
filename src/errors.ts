import type { Token } from "./lexer.ts";

// ---------------- Errors ----------------

// Every user-facing failure: parse/lex errors carry a source POSITION (the
// offending token) so the reporter can draw a caret; runtime errors carry an
// optional hint ("did you mean ...?").
// An action where a value is shown (print, echo, emit, toString, the REPL's
// echo): it has no value until it runs, as in Haskell.
// What a dot on a list finds instead of a field.
export const LIST_FIELDS = "a list's items are its positions (xs 0); apply each function to its value with zipWith ($) fs xs";
export const ACTION_SHOWN = {
    message: "an action has no value to show until it runs",
    hint: "run it, then show what it gives: x <- readFile \"f\", then print x",
};
// _ where it means nothing: it is data as a body (f x = _), any type as a
// type's argument (List _) and any value in a pattern.
export function placeholderError(): APNError {
    return new APNError("runtime", "_ stands for nothing here: it is data as a definition's body, any as a type's argument, any value in a pattern", {
        hint: 'code still to write is fail "todo"',
    });
}

export class APNError extends Error {
    kind: "parse" | "lex" | "runtime" | "type";
    pos?: number;
    len?: number;
    src?: string;
    hint?: string;

    constructor(
        kind: APNError["kind"],
        message: string,
        opts: { pos?: number; len?: number; hint?: string } = {},
    ) {
        super(message);
        this.kind = kind;
        this.pos = opts.pos;
        this.len = opts.len;
        this.hint = opts.hint;
    }
}

// Width of a token's source text (for the caret span).
export function tokLen(t: Token): number {
    switch (t.k) {
        case "str": return t.v.length + 2;
        case "char": return "n\t\\'\"".includes(t.v) ? 4 : 3;
        case "ident": return t.v.length + (t.quoted ? 2 : 0);
        case "kw": return t.v.length;
        case "int": case "float": return String(t.v).length;
        case "sym": return t.v.length;
        default: return 0; // newline / indent / dedent / eof: just point
    }
}

export function editDistance(a: string, b: string): number {
    const m = a.length, n = b.length;
    const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            d[i][j] = Math.min(
                d[i - 1][j] + 1,
                d[i][j - 1] + 1,
                d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
        }
    }
    return d[m][n];
}

// The closest candidate within a small edit distance, for "did you mean".
// Longer names tolerate distance 2 (covers transposition typos like
// "nmae" -> "name"); short ones only 1.
export function didYouMean(name: string, candidates: string[]): string | null {
    let best: string | null = null;
    let bestD = Infinity;
    for (const c of candidates) {
        if (c === name) continue;
        const d = editDistance(name, c);
        const cap = Math.max(name.length, c.length) >= 4 ? 2 : 1;
        if (d <= cap && d < bestD) {
            best = c;
            bestD = d;
        }
    }
    return best;
}


// CLI file-open failures should identify the user's path, not expose host stacks.
export function formatFileReadError(file: string, error: unknown): string {
    const reason = error instanceof Deno.errors.NotFound ? "file not found"
        : error instanceof Deno.errors.PermissionDenied || error instanceof Deno.errors.NotCapable ? "permission denied"
        : error instanceof Deno.errors.IsADirectory ? "is a directory"
        : error instanceof Error ? error.message : String(error);
    return `error: cannot read ${JSON.stringify(file)}: ${reason}`;
}

// A noun with its indefinite article: an Option, a Result.
export function withArticle(noun: string): string {
    return `${/^[AEIOUaeiou]/.test(noun) ? "an" : "a"} ${noun}`;
}

// A type applied to a value as written (Int x): the message and the
// spellings that say it.
// A type of values is a type given all its parameters: Option _, not Option
// (which is a function of types), wherever it is the type of a value.
export function missingTypeParameters(name: string, given: string[], missing: number): { message: string; hint: string } {
    const total = given.length + missing, all = [name, ...given, ...Array.from({ length: missing }, () => "_")].join(" ");
    return { message: `${name} takes ${total} type parameter${total === 1 ? "" : "s"}; a type is given all of them`, hint: `(x : ${all})` };
}
export function typeApplied(type: string, written = type): { message: string; hint: string } {
    const convert = type === "Dynamic" ? "" : `, or convert it (to ${/\s/.test(written) ? `(${written})` : written} x)`;
    return { message: `${type} is a type, not a function`, hint: `ascribe a value (x : ${written})${convert}` };
}
