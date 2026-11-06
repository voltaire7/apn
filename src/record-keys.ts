// A record's key is a name; one that is not written as a name is in backticks.
export function keySource(key: string): string { return /^[A-Za-z_][A-Za-z0-9_']*$/.test(key) ? key : "`" + key + "`"; }
// A field as source writes it: x = 1, or x : T for the type it holds.
export function fieldSource(key: string, text: string, type = false): string { return `${keySource(key)} ${type ? ":" : "="} ${text}`; }
