// A ',' between items none of which has a space takes nothing after it
// ([1,2,3], x,y -> x); otherwise it takes one space ([1 + 1, 2], [Some 1, 2]).
// Spaces inside string and character literals do not count.
export function spacedItem(text: string): boolean {
    return /\s/.test(text.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^\\'])'/g, ""));
}

export function itemsText(items: string[]): string {
    return items.join(items.some(spacedItem) ? ", " : ",");
}
