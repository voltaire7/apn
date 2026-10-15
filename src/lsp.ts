// Startup loads the bundled interpreter prelude; editor launchers must allow
// reading lib/prelude.apn, lib/type.apn and lib/do.apn for Deno versions that gate text imports on permissions.
import { lint, position, type Range } from "./lint.ts";
import { parseDocument, setLooseSpacing } from "./parser.ts";
import { lex, KEYWORDS } from "./lexer.ts";
import { NATIVES } from "./interp.ts";
import { semanticTokens, TOKEN_TYPES } from "./highlight.ts";
import { TYPE_NAMES } from "./type-system.ts";
import { RETIRED_NATIVES, nativeModule } from "./native-exports.ts";
import { standardExports } from "./modules.ts";

type Message = { jsonrpc?: string; id?: number | string | null; method?: string; params?: any };
type Document = { text: string; version: number };
type Symbol = { name: string; kind: number; range: Range; selectionRange: Range; detail: string };

// Top-level outline only: no guesses about dynamic imports or lexical references.
export function symbols(text: string): Symbol[] {
    try {
        const program = parseDocument(text);
        const names = new Map<string, number>();
        for (const item of program) {
            if (item.t === "def") names.set(item.name, item.clauses[0]?.params.length ? 12 : 13);
            if (item.t === "patDef" && item.eager && item.pattern.p === "var") names.set(item.pattern.name, 13);
            if (item.t === "type") names.set(item.def.name, 10);
        }
        const result: Symbol[] = [];
        let offset = 0;
        for (const line of text.split("\n")) {
            const name = line.match(/^([A-Za-z_][A-Za-z0-9_']*)/)?.[1];
            if (name && names.has(name) && lex(line).some((token) => token.k === "sym" && (token.v === "=" || token.v === "<-"))) {
                const start = position(text, offset);
                result.push({ name, kind: names.get(name)!, detail: line.trim(),
                    range: { start, end: position(text, offset + line.length) },
                    selectionRange: { start, end: position(text, offset + name.length) } });
            }
            offset += line.length + 1;
        }
        return result;
    } catch { return []; }
}

const builtins = new Map<string, string>([
    ...NATIVES.map(([name, arity]): [string, string] => [name, `Built-in function; ${arity} argument${arity === 1 ? "" : "s"}.`]),
    ...TYPE_NAMES.map((name): [string, string] => [name, "Built-in type constructor."]),
    ["env", "env — action yielding a live record view of the lexical environment: scope <- env; scope.x reads and scope.x = value updates a binding."],
    ["print", "print value — action printing the value and a newline; yields []."],
    ["emit", "emit value — action printing the value without a newline; yields []."],
    ["set", "set cell value — action replacing a Mutable cell's contents; yields []."],
    ["IO", "IO T — the type of actions yielding T; IO [] action checks an action (return x makes one)."],
    ["map", "map f m — m with f applied to what it holds: an action, a list, or a type with an instance."],
    ["Monad", "Monad — the type of monadic values (IO, lists, types with >>= instances); return x is undecided until a context names its monad."],
    ["Functor", "Functor — the type of values map works on."],
    ["to", "to T x — x written as a T: to String, to JSON, to (List Char); another type converts as applying it. A method: define to T = ... for your types."],
    ["from", "from T x — a T read back: from String parses, from JSON decodes, from (List Char) joins. A method: define from T = ... for your types."],
    ["JSON", "JSON — JSON text, a named String: to JSON x encodes, from JSON text decodes."],
    ["Z", "Z — the natural number zero, UInt 0; the pattern Z matches 0."],
    ["S", "S n — the natural number after n (n + 1, a UInt); the pattern S k matches 1 and up, binding k to one less."],
    ["return", "return x — x in the monad the context decides (an annotation, a >>=, or IO when run)."],
    ["sequence", "sequence actions — action running each, yielding the list of results."],
    ["mapM", "mapM f xs — sequence (map f xs)."],
    ["when", "when condition action — run the action when the condition is true."],
    ["unless", "unless condition action — run the action when the condition is false."],
    ["guard", "guard condition — return [] when the condition holds, else empty: a false guard stops a do-block (a list or Option one)."],
    ["empty", "empty — the monad's value holding nothing, decided by the context: [] in a list, None in an Option."],
    ["cast", "cast Type value — APN prelude compatibility wrapper for lossless Type application."],
    ["use", "use namespace — open a record or list of records in the current scope; later fields win; returns ()."],
    ["do", "do actions — action running a list of actions in order, yielding the last result; [] for an empty list."],
    ["match", "match value alternatives — try unary pattern functions in order."],
    ["assert", "assert condition — require a truthy value; failures include the expression and source location."],
    ["bracket", "bracket acquire release use — action; finishes returned data before cleanup, even on failure (function)."],
    ["withFile", "withFile path use — action scoping a UTF-8 file reader; the callback receives the action file.read (io)."],
]);

// The document's one-line imports (import "x", import ["x","y"]), in order.
function importsOf(text: string): { line: number; start: number; end: number; modules: string[] }[] {
    const found: { line: number; start: number; end: number; modules: string[] }[] = [];
    text.split("\n").forEach((line, n) => {
        const [, keyword, target] = line.match(/^(import\s+)(.+?)\s*(#.*)?$/) ?? [];
        if (!target) return;
        try {
            const value = JSON.parse(target);
            const modules = Array.isArray(value) ? value : [value];
            if (modules.every(m => typeof m === "string")) found.push({ line: n, start: keyword.length, end: keyword.length + target.length, modules });
        } catch { /* not a plain import */ }
    });
    return found;
}
// The edit importing module: added to the first import, which becomes a list
// (import ["x","module"]), or a new import "module" on the first line,
// a blank line apart from what follows.
function importEdit(text: string, module: string): { range: Range; newText: string } {
    const first = importsOf(text)[0];
    const target = (modules: string[]) => modules.length === 1 ? JSON.stringify(modules[0]) : `[${modules.map(m => JSON.stringify(m)).join(",")}]`;
    if (first) return { range: { start: { line: first.line, character: first.start }, end: { line: first.line, character: first.end } }, newText: target([...first.modules, module]) };
    return { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: `import ${target([module])}\n${/^\s*(\n|$)/.test(text) ? "" : "\n"}` };
}
type CompletionItem = { label: string; detail: string; kind: number; documentation?: string; additionalTextEdits?: { range: Range; newText: string }[] };

export class LanguageServer {
    typeChecking = false;
    documents = new Map<string, Document>();
    initialized = false;
    shutdown = false;
    exitCode: number | null = null;

    handle(message: Message): unknown[] {
        const output: unknown[] = [];
        const reply = (result: unknown) => output.push({ jsonrpc: "2.0", id: message.id, result });
        const error = (code: number, messageText: string) => output.push({ jsonrpc: "2.0", id: message.id,
            error: { code, message: messageText } });
        const publish = (uri: string, document?: Document) => output.push({ jsonrpc: "2.0",
            method: "textDocument/publishDiagnostics", params: { uri,
                ...(document ? { version: document.version } : {}), diagnostics: document ? lint(document.text, this.typeChecking) : [] } });
        const p = message.params ?? {};
        if (message.method === "exit") { this.exitCode = this.shutdown ? 0 : 1; return output; }
        if (message.method === "initialize" && !this.initialized) {
            this.initialized = true;
            this.typeChecking = p.initializationOptions?.typeChecking === true;
            // Loose spacing, as apn --loose.
            setLooseSpacing(p.initializationOptions?.looseSpacing === true);
            reply({ capabilities: { positionEncoding: "utf-16", textDocumentSync: { openClose: true, change: 1 },
                semanticTokensProvider: { legend: { tokenTypes: TOKEN_TYPES, tokenModifiers: [] }, full: true },
                completionProvider: {}, hoverProvider: true, documentSymbolProvider: true },
                serverInfo: { name: "apn", version: "0.1.0" } });
            return output;
        }
        if (!this.initialized || this.shutdown) {
            if (message.id !== undefined) error(this.shutdown ? -32600 : -32002, this.shutdown ? "Server shut down" : "Server not initialized");
            return output;
        }
        switch (message.method) {
            case "shutdown": this.shutdown = true; reply(null); break;
            case "textDocument/didOpen": {
                const d = { text: p.textDocument.text, version: p.textDocument.version };
                this.documents.set(p.textDocument.uri, d); publish(p.textDocument.uri, d); break;
            }
            case "textDocument/didChange": {
                const uri = p.textDocument.uri;
                const old = this.documents.get(uri);
                if (!old || p.textDocument.version <= old.version) break;
                const changes = p.contentChanges;
                // Full synchronization is advertised; never interpret ranged changes as a whole file.
                if (!Array.isArray(changes) || changes.some((c) => c.range !== undefined)) break;
                const d = { text: changes.at(-1)?.text ?? old.text, version: p.textDocument.version };
                this.documents.set(uri, d); publish(uri, d); break;
            }
            case "textDocument/didClose": this.documents.delete(p.textDocument.uri); publish(p.textDocument.uri); break;
            case "textDocument/semanticTokens/full":
                reply({ data: semanticTokens(this.documents.get(p.textDocument.uri)?.text ?? "", new Set(["cast", "do", ...NATIVES.map(([name]) => name)])) }); break;
            case "textDocument/documentSymbol": reply(symbols(this.documents.get(p.textDocument.uri)?.text ?? "")); break;
            case "textDocument/completion": {
                const text = this.documents.get(p.textDocument.uri)?.text ?? "";
                // Natives a standard module exports come with their module, below.
                const entries = new Map<string, CompletionItem>([...builtins]
                    .filter(([label]) => !nativeModule(label) && !(label in RETIRED_NATIVES))
                    .map(([label, detail]) => [label, { label, detail, kind: 3 }]));
                for (const word of KEYWORDS) entries.set(word, { label: word, detail: "APN keyword", kind: 14 });
                // Lexical suggestions, including local parameters; not a claim of scope/type resolution.
                try { for (const t of lex(text)) if (t.k === "ident" && !entries.has(t.v)) {
                    entries.set(t.v, { label: t.v, detail: "Identifier in this document", kind: 6 });
                } } catch { /* Incomplete source still gets built-in completion. */ }
                // The standard library's names: accepting one not imported yet
                // adds its module to the document's imports.
                const imported = new Set(importsOf(text).flatMap(i => i.modules));
                const defined = new Set(symbols(text).map(s => s.name));
                for (const [name, modules] of standardExports()) {
                    if (defined.has(name) || entries.has(name) && entries.get(name)!.kind !== 6) continue;
                    const kind = /^[A-Z]/.test(name) ? 4 : 3;
                    const have = modules.find(m => imported.has(m));
                    const documentation = builtins.get(name);
                    const item: CompletionItem = { label: name, detail: `From import "${have ?? modules[0]}"`, kind, ...documentation ? { documentation } : {} };
                    if (!have) item.additionalTextEdits = [importEdit(text, modules[0])];
                    entries.set(name, item);
                }
                reply({ isIncomplete: false, items: [...entries.values()] }); break;
            }
            case "textDocument/hover": {
                const text = this.documents.get(p.textDocument.uri)?.text ?? "";
                const line = text.split("\n")[p.position.line] ?? "";
                const column = p.position.character;
                const word = [...line.matchAll(/[A-Za-z_][A-Za-z0-9_']*/g)].find((m) => m.index! <= column && column < m.index! + m[0].length)?.[0];
                const definitions = symbols(text).filter((s) => s.name === word);
                const detail = definitions.length ? "Top-level declarations in this document:\n" + definitions.map((s) => s.detail).join("\n") : builtins.get(word ?? "");
                reply(detail ? { contents: { kind: "plaintext", value: detail } } : null); break;
            }
            default: if (message.id !== undefined) error(-32601, `Method not found: ${message.method}`);
        }
        return output;
    }
}

const encoder = new TextEncoder();
export function encodeMessage(message: unknown): Uint8Array {
    const body = encoder.encode(JSON.stringify(message));
    const header = encoder.encode(`Content-Length: ${body.length}\r\n\r\n`);
    const packet = new Uint8Array(header.length + body.length);
    packet.set(header); packet.set(body, header.length); return packet;
}

export class MessageReader {
    private buffer = new Uint8Array();
    push(chunk: Uint8Array): Message[] {
        const combined = new Uint8Array(this.buffer.length + chunk.length);
        combined.set(this.buffer); combined.set(chunk, this.buffer.length); this.buffer = combined;
        const messages: Message[] = [];
        for (;;) {
            let end = -1;
            for (let i = 0; i + 3 < this.buffer.length; i++) {
                if (this.buffer[i] === 13 && this.buffer[i + 1] === 10 && this.buffer[i + 2] === 13 && this.buffer[i + 3] === 10) { end = i; break; }
            }
            if (end < 0) {
                if (this.buffer.length > 8192) throw new Error("LSP header too large");
                break;
            }
            const header = new TextDecoder().decode(this.buffer.subarray(0, end));
            const match = header.match(/^Content-Length:\s*(\d+)\s*$/im);
            if (!match) throw new Error("Missing Content-Length");
            const length = Number(match[1]);
            if (!Number.isSafeInteger(length) || length > 16 * 1024 * 1024) throw new Error("LSP message too large");
            if (this.buffer.length < end + 4 + length) break;
            const body = new TextDecoder().decode(this.buffer.subarray(end + 4, end + 4 + length));
            messages.push(JSON.parse(body));
            this.buffer = this.buffer.slice(end + 4 + length);
        }
        return messages;
    }
}

export async function runLanguageServer(): Promise<number> {
    const server = new LanguageServer();
    const reader = new MessageReader();
    const buffer = new Uint8Array(8192);
    for (;;) {
        const n = await Deno.stdin.read(buffer);
        if (n === null) return server.shutdown ? 0 : 1;
        for (const message of reader.push(buffer.subarray(0, n))) {
            for (const response of server.handle(message)) {
                const packet = encodeMessage(response);
                let offset = 0;
                while (offset < packet.length) offset += await Deno.stdout.write(packet.subarray(offset));
            }
            if (server.exitCode !== null) return server.exitCode;
        }
    }
}
