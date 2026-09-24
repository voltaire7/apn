import { APNError } from "./errors.ts";

export type Token =
    | { k: "int"; v: bigint; pos: number }
    | { k: "float"; v: number; pos: number }
    | { k: "bool"; v: boolean; pos: number }
    | { k: "str"; v: string; pos: number }
    | { k: "char"; v: string; pos: number }
    | { k: "ident"; v: string; pos: number }
    | { k: "kw"; v: string; pos: number }             // keywords
    | { k: "sym"; v: string; pos: number }             // symbols incl. multi-char
    | { k: "newline"; pos: number } | { k: "indent"; pos: number } | { k: "dedent"; pos: number }
    | { k: "eof"; pos: number };

export const KEYWORDS = new Set([
    "where",
    "import", "true", "false", "rec",
]);

const SYMBOLS = [
  "..",
    ">>>", "==>", "$", "<<", "<<=", ">>=", "==", "!=", "<=", ">=", "=>", "->", "<-",
    "&&", "||", "++", "::", ":=",
];


export function lex(src: string): Token[] {
    const toks: Token[] = [];
    const indentStack = [0];
    let pos = 0;
    let atLineStart = true;
    let parenDepth = 0;

    const peek = (off = 0) => src[pos + off];
    const skipWs = () => { while (pos < src.length && " \t\r".includes(src[pos])) pos++; };

    // skip comments (line and block)
    const skipComment = (): boolean => {
        if (src.startsWith("#", pos)) {
            while (pos < src.length && src[pos] !== '\n') pos++;
            return true;
        }
        if (src.startsWith("{-", pos)) {
            let depth = 1;
            pos += 2;
            while (pos < src.length && depth > 0) {
                if (src.startsWith("{-", pos)) { depth++; pos += 2; }
                else if (src.startsWith("-}", pos)) { depth--; pos += 2; }
                else pos++;
            }
            return true;
        }
        return false;
    };

    while (pos < src.length) {
        // indentation detection at start of line (outside parens)
        if (atLineStart && parenDepth === 0) {
            atLineStart = false;
            let indent = 0;
            while (pos < src.length && (src[pos] === ' ' || src[pos] === '\t')) {
                indent += src[pos] === '\t' ? 4 : 1;
                pos++;
            }
            // blank / comment-only line: reset and keep going
            if (pos >= src.length) break;
            if (src[pos] === '\n') { continue; }
            if (src.startsWith("#", pos) || src.startsWith("{-", pos)) {
                const cStart = pos;
                skipComment();
                // After a comment, move to next line and re-detect indentation.
                if (pos < src.length && src[pos] === '\n') {
                    pos++;
                    toks.push({ k: "newline", pos: pos - 1 });
                    continue;
                }
                continue;
            }

            const cur = indentStack[indentStack.length - 1];
            if (indent > cur) {
                if (indent === cur + 4) {
                    indentStack.push(indent);
                    toks.push({ k: "indent", pos });
                } else {
                    throw new APNError(
                        "lex",
                        `indentation must increase by exactly 4 spaces (got +${indent - cur})`,
                        { pos },
                    );
                }
            } else {
                while (indent < indentStack[indentStack.length - 1]) {
                    indentStack.pop();
                    toks.push({ k: "dedent", pos });
                }
                if (indent !== indentStack[indentStack.length - 1]) {
                    throw new APNError("lex", `indentation must be a multiple of 4 spaces`, { pos });
                }
            }
        }

        skipWs();
        if (pos >= src.length) break;

        if (skipComment()) { atLineStart = false; continue; }

        const start = pos; // token start for error carets
        const c = src[pos];

        if (c === '\n') {
            pos++;
            if (parenDepth === 0) {
                toks.push({ k: "newline", pos: pos - 1 });
                atLineStart = true;
            }
            continue;
        }

        // symbols (multi-char first)
        let matchedSym = false;
        for (const s of SYMBOLS) {
            if (src.startsWith(s, pos)) {
                if (s === "<-" || s === "->" || s === "=>") {
                    // used contextually as constructor/member token `:` handled separately
                }
                toks.push({ k: "sym", v: s, pos: start });
                pos += s.length;
                matchedSym = true;
                break;
            }
        }
        if (matchedSym) continue;

        // Decimal, radix and exponent literals; signs remain unary operators.
        if (/\d/.test(c) || (c === "." && /\d/.test(src[pos + 1] ?? "") &&
            (pos === 0 || /[\s([{,;=+\-*/%^<>!?|:$@]/.test(src[pos - 1])))) {
            const rest = src.slice(pos);
            if (/^0[xXbBoO]/.test(rest)) {
                const literal = rest.match(/^0[xX][0-9a-fA-F]+|^0[bB][01]+|^0[oO][0-7]+/)?.[0];
                if (!literal || /[A-Za-z0-9_]/.test(rest[literal.length] ?? "")) throw new APNError("lex", "invalid radix integer", { pos: start });
                pos += literal.length;
                toks.push({ k: "int", v: BigInt(literal), pos: start });
            } else {
                const literal = rest.match(/^(?:\d+(?:\.(?!\.)\d*)?|\.\d+)(?:[eE][+-]?\d+)?/)![0];
                pos += literal.length;
                if (/[eE]/.test(src[pos] ?? "")) throw new APNError("lex", "invalid numeric exponent", { pos: start });
                toks.push(/[.eE]/.test(literal) ? { k: "float", v: Number(literal), pos: start } : { k: "int", v: BigInt(literal), pos: start });
            }
            continue;
        }

        // single-char symbols. `(`/`)` suppress layout inside parens (grouping);
        // `[`/`]` DO NOT: newlines and indentation inside a list literal are
        // significant, so elements can be separated just by being on their own
        // lines. `{`/`}` likewise participate in the global 4-space layout.
        if (":()[]{}.,;|".includes(c)) {
            if (c === '(') parenDepth++;
            if (c === ')') parenDepth--;
            // `:` is cons in this language; `::` handled above as symbol
            toks.push({ k: "sym", v: c === ":" ? ":" : c, pos: start });
            pos++;
            continue;
        }

        if ("=+-*/%^<>!&?@".includes(c)) {
            toks.push({ k: "sym", v: c, pos: start });
            pos++;
            continue;
        }

        if (c === '"') {
            pos++;
            let s = "";
            while (pos < src.length && src[pos] !== '"') {
                if (src[pos] === '\\') {
                    pos++;
                    s += ({ n: "\n", t: "\t", r: "\r", v: "\v", f: "\f", '\\': "\\", '"': '"' }[src[pos]] ?? src[pos]);
                } else s += src[pos];
                pos++;
            }
            if (pos >= src.length) {
                throw new APNError("lex", "unterminated string", { pos: start });
            }
            pos++; // closing quote
            toks.push({ k: "str", v: s, pos: start });
            continue;
        }

        if (c === "'") {
            pos++;
            let ch = String.fromCodePoint(src.codePointAt(pos) ?? 0);
            if (ch === '\\') {
                pos++;
                ch = ({ n: "\n", t: "\t", r: "\r", v: "\v", f: "\f", '\\': "\\", "'": "'" }[src[pos]] ?? src[pos]);
                pos++;
            } else pos += ch.length;
            if (src[pos] !== "'") throw new APNError("lex", "expected one character followed by closing quote", { pos: start });
            pos++;
            toks.push({ k: "char", v: ch, pos: start });
            continue;
        }

        if (/[A-Za-z_]/.test(c)) {
            let id = "";
            while (pos < src.length && /[A-Za-z0-9_']/.test(src[pos])) id += src[pos++];
            if (KEYWORDS.has(id)) toks.push({ k: "kw", v: id, pos: start });
            else toks.push({ k: "ident", v: id, pos: start });
            continue;
        }

        throw new APNError("lex", `unexpected character '${c}'`, { pos: start });
    }

    while (indentStack.length > 1) {
        indentStack.pop();
        toks.push({ k: "dedent", pos: src.length });
    }
    toks.push({ k: "eof", pos: src.length });
    return toks;
}

