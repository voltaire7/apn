import { type Numeric, parseNumberText } from "./numbers.ts";

// Pure text natives: the runtime runs them, and the checker's evaluator runs
// the same functions on values it knows, so the two always agree.
export const textNatives = {
    upper: (text: string): string => text.toUpperCase(),
    lower: (text: string): string => text.toLowerCase(),
    // By code point: chars "a😀" is ['a','😀'].
    chars: (text: string): string[] => [...text],
    fromChars: (chars: string[]): string => chars.join(""),
    // The length of a string is its number of characters, as chars gives them.
    length: (text: string): bigint => {
        let n = 0n;
        for (const _ of text) n++;
        return n;
    },
};
// What parse reads from text: a Bool, a number literal, or null for neither.
export function parseLiteral(text: string): boolean | Numeric | null {
    const s = text.trim();
    if (s === "true" || s === "false") return s === "true";
    return parseNumberText(s);
}
