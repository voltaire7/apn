// A ',' between items none of which has a space takes nothing after it
// ([1,2,3]); otherwise, or between literals of different kinds, it takes one
// space ([1 + 1, 2], [Some 1, 2], ["a", 1], [[1], 2]). Lambda parameters always
// take one. Spaces inside string and character literals do not count.
export function spacedItem(text: string): boolean {
    return /\s/.test(text.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^\\'])'/g, ""));
}

// The kind of literal an item's text is: a number (1, -2.5, 1/3, 1e-3, 2i, all
// one kind), a string, a character, a Bool or a list ([1,2], [], [1..3]).
export function literalKind(text: string): string | undefined {
    if (/^-?\.?[0-9][0-9A-Za-z._]*(?:[/+-]\.?[0-9][0-9A-Za-z._]*)?$/.test(text)) return "number";
    if (/^"(?:\\.|[^"\\])*"$/.test(text)) return "string";
    if (/^'(?:\\.|[^\\'])+'$/.test(text)) return "char";
    if (text === "True" || text === "False") return "Bool";
    if (text.startsWith("[") && text.endsWith("]")) return "list";
    return undefined;
}

// Whether items are separated by ', ': one has a space, or two are literals
// of different kinds.
export function spacedItems(items: string[]): boolean {
    return items.some(spacedItem) || new Set(items.map(literalKind).filter(Boolean)).size > 1;
}

export function itemsText(items: string[]): string {
    return items.join(spacedItems(items) ? ", " : ",");
}

// A string or character as source writes it, escaped as the lexer reads it.
const ESCAPES: Record<string, string> = { "\\": "\\\\", "\n": "\\n", "\t": "\\t", "\r": "\\r", "\v": "\\v", "\f": "\\f", "\0": "\\0" };
export function stringLiteral(text: string): string {
    return `"${text.replace(/[\\\n\t\r\v\f\0"]/g, c => ESCAPES[c] ?? "\\" + c)}"`;
}
export function charLiteral(c: string): string {
    return `'${c.replace(/[\\\n\t\r\v\f\0']/g, x => ESCAPES[x] ?? "\\" + x)}'`;
}
