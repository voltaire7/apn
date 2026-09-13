// Record storage keys preserve the distinction between identifiers and strings.
// Identifiers and numeric field names cannot contain NUL. Prefix string keys
// (including strings that themselves contain NUL) so equality/maps stay exact.
// Never expose this encoding through APN values or host symbol names.
export function stringKey(text: string): string { return "\0" + text; }
export function isStringKey(key: string): boolean { return key.startsWith("\0"); }
export function keyText(key: string): string { return isStringKey(key) ? key.slice(1) : key; }
export function keySource(key: string): string {
    if (!isStringKey(key)) return key;
    // Use APN's supported escapes (JSON's \\u and \\b are not APN escapes).
    const escapes: Record<string, string> = {
        "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r",
        "\t": "\\t", "\v": "\\v", "\f": "\\f",
    };
    return '"' + keyText(key).replace(/[\\"\n\r\t\v\f]/g, (char) => escapes[char]) + '"';
}
