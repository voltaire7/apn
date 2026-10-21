// A ',' between items none of which has a space takes nothing after it
// ([1,2,3], x,y -> x); otherwise it takes one space ([1 + 1, 2], [Some 1, 2]).
// Spaces inside string and character literals do not count.
export function spacedItem(text: string): boolean {
    return /\s/.test(text.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^\\'])'/g, ""));
}

export function itemsText(items: string[]): string {
    return items.join(items.some(spacedItem) ? ", " : ",");
}

// A string or character as source writes it, escaped as the lexer reads it.
const ESCAPES: Record<string, string> = { "\\": "\\\\", "\n": "\\n", "\t": "\\t", "\r": "\\r", "\v": "\\v", "\f": "\\f", "\0": "\\0" };
export function stringLiteral(text: string): string {
    return `"${text.replace(/[\\\n\t\r\v\f\0"]/g, c => ESCAPES[c] ?? "\\" + c)}"`;
}
export function charLiteral(c: string): string {
    return `'${c.replace(/[\\\n\t\r\v\f\0']/g, x => ESCAPES[x] ?? "\\" + x)}'`;
}
