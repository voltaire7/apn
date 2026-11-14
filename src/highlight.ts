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
// ternaries carries open ?: across calls, for text given a line at a time.
export function highlightTokens(source: string, natives: Set<string>, ternaries = [0]): HighlightToken[] {
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
            take(word.length, ["import", "load", "use", "do", "return", "else", "True", "False"].includes(word) ? "keyword"
                : natives.has(word) ? "function" : /^[A-Z]/.test(word) ? "type" : undefined);
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
export function highlightHtml(source: string, natives: Set<string>): string {
    const escape = (text: string) => text.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
    const lines = source.split("\n"), html = lines.map(() => ""), ends = lines.map(() => 0);
    for (const token of highlightTokens(source, natives)) {
        const line = lines[token.line];
        html[token.line] += escape(line.slice(ends[token.line], token.start))
            + `<span class="t-${token.type}">${escape(line.slice(token.start, token.start + token.length))}</span>`;
        ends[token.line] = token.start + token.length;
    }
    return lines.map((line, n) => html[n] + escape(line.slice(ends[n]))).join("\n");
}

export function semanticTokens(source: string, natives: Set<string>): number[] {
    let previousLine = 0, previousStart = 0;
    const data: number[] = [];
    for (const token of highlightTokens(source, natives)) {
        data.push(token.line - previousLine,
            token.line === previousLine ? token.start - previousStart : token.start,
            token.length, TOKEN_TYPES.indexOf(token.type), 0);
        previousLine = token.line; previousStart = token.start;
    }
    return data;
}
