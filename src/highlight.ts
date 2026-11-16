// Tolerant lexical colors: keep highlighting while a document is incomplete.
// The REPL, the language server and the web editor all color with these
// tokens; their names form the LSP legend.
export const TOKEN_TYPES = ["number", "string", "comment", "keyword", "function", "type", "operator", "punctuation"];
// Catppuccin's colors for each token type: Frappé on dark backgrounds (the
// REPL's, and editors/neovim/apn.lua's), Latte on light ones.
// https://github.com/catppuccin/palette
export const PALETTES: Record<"dark" | "light", Record<string, string>> = {
    dark: { number: "#e5c890", string: "#a6d189", comment: "#737994", keyword: "#ca9ee6", function: "#8caaee", type: "#99d1db", operator: "#ef9f76", punctuation: "#838ba7" },
    light: { number: "#df8e1d", string: "#40a02b", comment: "#9ca0b0", keyword: "#8839ef", function: "#1e66f5", type: "#04a5e5", operator: "#fe640b", punctuation: "#8c8fa1" },
};
export interface HighlightToken { line: number; start: number; length: number; type: string; }
const KEYWORDS = new Set(["import", "load", "use", "do", "return", "else", "loop", "for", "while", "True", "False"]);
// A name is a function where it is applied: at the head of an application
// (after what starts an expression, a line's start, ( [ { , ; = or an
// operator), with an argument after it on its line: map and add in
// map (add 1) xs, not add1 in map add1 xs, which is a value there. A name a
// statement or item defines is not applied (wallis n = ..., as wallis : Int
// -> Float; double in [double x = x * 2, double 3] where it is defined).
function applied(source: string, start: number, end: number): boolean {
    if (defined(source, start, end)) return false;
    let before = start - 1;
    // (A field, model.zone, is applied as the chain it ends is: where the chain
    // starts, intrinsics.add 1 1, not toMinute model.zone model.time.)
    if (source[before] === ".") {
        while (before >= 0 && /[A-Za-z0-9_'.]/.test(source[before])) before--;
    }
    while (before >= 0 && (source[before] === " " || source[before] === "\t")) before--;
    const p = before < 0 ? "\n" : source[before];
    const heads = p === "\n" || "([{,;=".includes(p) || "+-*/%^!<>$&|?\\`@~:".includes(p);
    let after = end;
    while (after < source.length && (source[after] === " " || source[after] === "\t")) after++;
    const n = source[after] ?? "";
    const argument = /[A-Za-z0-9_([{"']/.test(n) || n === "." && /[0-9]/.test(source[after + 1] ?? "");
    return heads && argument;
}
// Whether the name at start..end begins a statement or an item (its line, or
// after ( [ { , ;) that defines it: an = follows within it, at its own level
// or that of a group holding it, outside strings, not part of another
// operator (==, <=, >=, !=, =>, :=), as in wallis n = ..., [double x = x * 2,
// double 3] and [f x, g y] = [x, y].
function defined(source: string, start: number, end: number): boolean {
    let before = start - 1;
    while (before >= 0 && (source[before] === " " || source[before] === "\t")) before--;
    if (before >= 0 && !"\n([{,;".includes(source[before])) return false;
    // (After its item, an = in the same brackets is a later item's; once they
    // close, one is the group's: [f x, g y] = [x, y] defines f and g.)
    let depth = 0, later = false;
    for (let i = end; i < source.length && source[i] !== "\n"; i++) {
        const c = source[i];
        if (c === '"' || c === "'") {
            for (i++; i < source.length && source[i] !== c && source[i] !== "\n"; i++) if (source[i] === "\\") i++;
            continue;
        }
        if ("([{".includes(c)) depth++;
        else if (")]}".includes(c) && --depth < 0) { depth = 0; later = false; }
        else if (!depth && (c === "#" || c === "?")) return false;
        else if (!depth && (c === "," || c === ";")) later = true;
        else if (c === "=" && !depth && !later && !"=<>!:".includes(source[i - 1]) && !"=>".includes(source[i + 1] ?? "")) return true;
    }
    return false;
}
// ternaries carries open ?: across calls, for text given a line at a time.
export function highlightTokens(source: string, ternaries = [0]): HighlightToken[] {
    const tokens: HighlightToken[] = [];
    let i = 0, line = 0, column = 0;
    const take = (length: number, type?: string) => {
        const text = source.slice(i, i + length);
        for (const [index, part] of text.split("\n").entries()) {
            if (index) { line++; column = 0; }
            const width = part.endsWith("\r") ? part.length - 1 : part.length;
            if (type && width) tokens.push({ line, start: column, length: width, type });
            column += part.length;
        }
        i += length;
    };
    while (i < source.length) {
        const c = source[i];
        if (c === "#") {
            const end = source.indexOf("\n", i);
            take((end < 0 ? source.length : end) - i, "comment"); continue;
        }
        if (c === '"' || c === "'") {
            let end = i + 1;
            while (end < source.length) {
                if (source[end] === "\\") { end += 2; continue; }
                if (source[end++] === c) break;
            }
            take(Math.min(end, source.length) - i, "string"); continue;
        }
        if (source.startsWith("..", i)) { take(2, "punctuation"); continue; }
        const number = source.slice(i).match(/^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:\d+(?:\.(?!\.)\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/)?.[0];
        if (number) {
            if (/^0[xXbBoO]/.test(number)) {
                take(1, "number"); take(1, "operator"); take(number.length - 2, "number");
            } else {
                for (const part of number.split(/([eE+-])/).filter(Boolean)) {
                    take(part.length, /^[eE+-]$/.test(part) ? "operator" : "number");
                }
            }
            if (source[i] === "i" && !/[A-Za-z0-9_']/.test(source[i + 1] ?? "")) take(1, "operator");
            continue;
        }
        const word = source.slice(i).match(/^[A-Za-z_][A-Za-z0-9_']*/)?.[0];
        if (word) {
            take(word.length, KEYWORDS.has(word) ? "keyword" : /^[A-Z]/.test(word) ? "type"
                : applied(source, i, i + word.length) ? "function" : undefined);
            continue;
        }
        if ("([{".includes(c)) ternaries.push(0);
        if (")]}".includes(c) && ternaries.length > 1) ternaries.pop();
        if (c === "?") ternaries[ternaries.length - 1]++;
        if (c === ":" && ternaries[ternaries.length - 1] > 0) {
            ternaries[ternaries.length - 1]--; take(1, "operator"); continue;
        }
        if (c === ";" || c === ",") ternaries[ternaries.length - 1] = 0;
        // A run of operator characters is one operator (<+>, >>=), as lexed.
        const run = source.slice(i).match(/^[!$%&*+\-/<=>\\^|~:]+/)?.[0];
        if (run && run.length > 1) { take(run.length, "operator"); continue; }
        take(1, "+-*/%^!<>$&|?\\`@~".includes(c) ? "operator"
            : "(){}[];,:.=".includes(c) ? "punctuation" : undefined);
    }
    return tokens;
}

// Source as HTML, each token a <span class="t-TYPE">: the text is escaped
// after it is tokenized, so -> stays an arrow.
export function highlightHtml(source: string): string {
    const escape = (text: string) => text.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
    const lines = source.split("\n"), html = lines.map(() => ""), ends = lines.map(() => 0);
    for (const token of highlightTokens(source)) {
        const line = lines[token.line];
        html[token.line] += escape(line.slice(ends[token.line], token.start))
            + `<span class="t-${token.type}">${escape(line.slice(token.start, token.start + token.length))}</span>`;
        ends[token.line] = token.start + token.length;
    }
    return lines.map((line, n) => html[n] + escape(line.slice(ends[n]))).join("\n");
}

export function semanticTokens(source: string): number[] {
    let previousLine = 0, previousStart = 0;
    const data: number[] = [];
    for (const token of highlightTokens(source)) {
        data.push(token.line - previousLine,
            token.line === previousLine ? token.start - previousStart : token.start,
            token.length, TOKEN_TYPES.indexOf(token.type), 0);
        previousLine = token.line; previousStart = token.start;
    }
    return data;
}
