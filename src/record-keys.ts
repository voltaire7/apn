// Every record key is an ordinary string. Quoted field syntax includes the
// surrounding quote characters in that string; there is no tagged key encoding.
export function stringKey(text: string): string { return '"' + text + '"'; }
// This checks spelling for rendering only, not a distinct runtime key kind.
export function isStringKey(key: string): boolean { return key.length >= 2 && key.startsWith('"') && key.endsWith('"'); }
export function keyText(key: string): string { return key; }
export function keySource(key: string): string {
    if (!isStringKey(key)) return key;
    // Escape the contents when writing quoted field syntax back to source.
    const escapes: Record<string, string> = {
        "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r",
        "\t": "\\t", "\v": "\\v", "\f": "\\f",
    };
    return '"' + key.slice(1, -1).replace(/[\\"\n\r\t\v\f]/g, (char) => escapes[char]) + '"';
}
