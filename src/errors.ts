import type { Token } from "./lexer.ts";

// ---------------- Errors ----------------

// Every user-facing failure: parse/lex errors carry a source POSITION (the
// offending token) so the reporter can draw a caret; runtime errors carry an
// optional hint ("did you mean ...?").
export class APNError extends Error {
    kind: "parse" | "lex" | "runtime";
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
        case "ident": case "kw": return t.v.length;
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

