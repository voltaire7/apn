import { parseDocument } from "./parser.ts";
import { APNError } from "./errors.ts";

export interface Position { line: number; character: number; }
export interface Range { start: Position; end: Position; }
export interface Diagnostic {
    range: Range;
    severity: number;
    source: string;
    code: string;
    message: string;
}

// JavaScript offsets and LSP's negotiated default both use UTF-16 code units.
export function position(source: string, offset: number): Position {
    const lines = source.slice(0, Math.max(0, Math.min(source.length, offset))).split("\n");
    return { line: lines.length - 1, character: lines.at(-1)!.length };
}

export function lint(source: string): Diagnostic[] {
    try { parseDocument(source); return []; }
    catch (error) {
        if (!(error instanceof APNError)) throw error;
        const start = Math.max(0, Math.min(source.length, error.pos ?? 0));
        const lineEnd = source.indexOf("\n", start);
        const end = Math.min(source.length, lineEnd < 0 ? source.length : lineEnd,
            start + Math.max(1, error.len ?? 1));
        return [{ range: { start: position(source, start), end: position(source, end) },
            severity: 1, source: "apn", code: error.kind, message: error.message }];
    }
}

export async function runLint(args: string[]): Promise<number> {
    const json = args.includes("--json");
    const files = args.filter((arg) => arg !== "--json");
    if (!files.length) { console.error("usage: apn --lint [--json] FILE.apn [...]"); return 2; }
    const results = [];
    let failed = false;
    for (const file of files) {
        try {
            const diagnostics = lint(await Deno.readTextFile(file));
            results.push({ file, diagnostics });
            if (diagnostics.length) failed = true;
            if (!json) for (const d of diagnostics) {
                console.log(`${file}:${d.range.start.line + 1}:${d.range.start.character + 1}: error[${d.code}]: ${d.message}`);
            }
        } catch (error) {
            failed = true;
            results.push({ file, error: String(error) });
            if (!json) console.error(`${file}: ${error}`);
        }
    }
    if (json) console.log(JSON.stringify(results));
    return failed ? 1 : 0;
}
