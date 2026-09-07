import { lex, type Token } from "./lexer.ts";
import { parse } from "./parser.ts";
import { APNError } from "./errors.ts";
import { NATIVES, envNames, dirname, Interpreter, setInterruptFlag, resetInterrupt } from "./interp.ts";
import type { Value, Env } from "./types.ts";
import type { Expr, Pattern, TopLevel } from "./ast.ts";
import { valueToString } from "./types.ts";

// ---------------- REPL ----------------

// Ctrl+C BREAKS a running evaluation: a divergent chunk (x = x; x) spins in
// the sync interpreter and blocks Deno's event loop, so a plain signal
// listener can never fire. Instead the TTY REPL spawns a tiny WORKER (whose
// event loop stays free) that watches SIGINT and flips a SharedArrayBuffer
// flag; the interpreter's hot loops poll it.

// 1-based line/column of a source offset.
function locate(src: string, pos: number): { line: number; col: number } {
    let line = 1, lineStart = 0;
    for (let i = 0; i < pos && i < src.length; i++) {
        if (src[i] === "\n") {
            line++;
            lineStart = i + 1;
        }
    }
    return { line, col: pos - lineStart + 1 };
}

// Render an error the pretty way: a red headline, an optional hint, and for
// parse/lex errors a --> line, the offending source line (syntax-highlighted
// in color mode) with one line of context on each side, and a caret under the
// offending token.
export function formatError(err: unknown, color: boolean): string {
    const e = err instanceof APNError
        ? err
        : new APNError("runtime", (err as Error)?.message ?? String(err));
    const p = (code: string, s: string) => color ? code + s + A.reset : s;
    const head = e.kind === "runtime" ? "runtime error" : "parse error";
    const out: string[] = [p(A.bold + A.red, head + ": ") + e.message];
    if (e.hint) out.push(p(A.dim, "  hint: ") + p(A.yellow, e.hint));
    if (e.pos !== undefined && e.src) {
        const { line, col } = locate(e.src, e.pos);
        const lines = e.src.split("\n");
        const gutter = String(Math.min(line + 1, lines.length)).length;
        const show = (n: number) => {
            const text = lines[n - 1].replace(/\r$/, "");
            const num = p(A.dim, String(n).padStart(gutter) + " | ");
            return num + (color ? highlightLine(text) : text);
        };
        out.push(p(A.dim, `  --> line ${line}, column ${col}`));
        if (line >= 2) out.push(show(line - 1));
        out.push(show(line));
        const caret = " ".repeat(Math.max(0, col - 1)) + "^".repeat(Math.max(1, e.len ?? 1));
        out.push(p(A.dim, " ".repeat(gutter) + " | ") + p(A.green, caret));
        if (line < lines.length) out.push(show(line + 1));
    }
    return out.join("\n");
}

// Run a source chunk; returns the forced value, or null for unit/void.
// REPL echo uses this (it needs the Value for colored printing).
function runSourceValue(src: string, interp: Interpreter, binding = false): Value | null {
    let program: TopLevel[];
    try {
        program = parse(src);
    } catch (err) {
        throw err instanceof APNError ? err : new APNError("parse", (err as Error).message);
    }
    let val: Value;
    try {
        val = interp.run(program);
    } catch (err) {
        if (err instanceof APNError) throw err;
        throw new APNError("runtime", (err as Error).message.replace(/^Runtime: /, ""));
    }
    if (binding) return null; // an assignment binds — never forced, never echoed
    val = interp.force(val);
    return val.kind === "unit" ? null : val;
}

// Does the chunk END in a binding (def / pattern binding / data)? Those are
// SILENT in the REPL — like GHCi's `let`, they bind without echoing a value.
// Does the chunk END in a bare print/emit call? Those already produced their
// output — echoing the RETURNED value would print it twice.
function lastIsPrintCall(src: string): boolean {
    try {
        const prog = parse(src);
        const last = prog[prog.length - 1];
        if (!last || last.t !== "expr") return false;
        let e = last.value;
        for (;;) {
            if (e.t === "app" && e.f.t === "var" && (e.f.name === "print" || e.f.name === "emit")) return true;
            if (e.t === "pipe") {
                const c = e.f;
                if (c.t === "var" && (c.name === "print" || c.name === "emit")) return true;
                e = c;
                continue;
            }
            return false;
        }
    } catch {
        return false;
    }
}

function lastIsBinding(src: string): boolean {
    try {
        const prog = parse(src);
        const last = prog[prog.length - 1];
        return last !== undefined && last.t !== "expr";
    } catch {
        return false;
    }
}

export function runSource(src: string, interp: Interpreter, binding = false): string {
    const val = runSourceValue(src, interp, binding);
    return val === null ? "" : valueToString(val);
}

// Does this parse error mean "input is still incomplete, keep reading"?
function isIncompleteError(msg: string): boolean {
    return /'EOF'|end of file|unterminated|expected '->'|unexpected 'newline'|unexpected 'indent'|unexpected 'dedent'/.test(msg);
}

function unbalancedBrackets(src: string): boolean {
    try {
        let d = 0;
        for (const t of lex(src)) {
            if (t.k !== "sym") continue;
            if (t.v === "(" || t.v === "[" || t.v === "{") d++;
            else if (t.v === ")" || t.v === "]" || t.v === "}") d--;
        }
        return d > 0;
    } catch {
        return false;
    }
}

// A chunk is complete when it parses cleanly. An EOF-shaped parse error or
// an unclosed bracket means "keep reading" (multi-line input).
function chunkComplete(src: string): boolean {
    try {
        parse(src);
        return true;
    } catch (err) {
        return !(isIncompleteError((err as Error).message) || unbalancedBrackets(src));
    }
}

// ---- ANSI colors (TTY REPL only; piped output stays plain) ----
// Catppuccin Frappé palette, truecolor:
// https://github.com/catppuccin/nvim/blob/main/lua/catppuccin/palettes/frappe.lua
const A = {
    reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
    red: "\x1b[38;2;231;130;132m", // #e78284   errors
    green: "\x1b[38;2;166;209;137m", // #a6d189 strings/chars
    yellow: "\x1b[38;2;229;200;144m", // #e5c890 numbers
    blue: "\x1b[38;2;140;170;238m", // #8caaee  natives
    magenta: "\x1b[38;2;202;158;230m", // #ca9ee6 mauve: match/data/bools
    cyan: "\x1b[38;2;153;209;219m", // #99d1db  sky: prompts, capital idents
    gray: "\x1b[38;2;131;139;167m", // #838ba7  overlay1: punctuation, structure
    comment: "\x1b[38;2;115;121;148m", // #737994 overlay0: comments
};
const paint = (code: string, s: string) => code + s + A.reset;

// node-style typed echo: numbers yellow, strings/chars green, bools magenta,
// values' structure (brackets, colons, commas) gray, unit/functions gray.
// Variant tags stay cyan (capital constructors are cyan in input too).
function showValue(v: Value): string {
    switch (v.kind) {
        case "int": case "float": return paint(A.yellow, String(v.v));
        case "string": return paint(A.green, `"${v.v}"`);
        case "char": return paint(A.green, `'${v.v}'`);
        case "bool": return paint(A.magenta, String(v.v));
        case "unit": return paint(A.gray, "()");
        case "list":
            return paint(A.gray, "[") + v.v.map(showValue).join(paint(A.gray, ", ")) +
                paint(A.gray, "]");
        case "lazyList": return paint(A.gray, "<lazy>");
        case "record":
            return paint(A.gray, "[") +
                v.v.map(([k, x]) => `${k}${paint(A.gray, ": ")}${showValue(x)}`).join(paint(A.gray, ", ")) +
                paint(A.gray, "]");
        case "variant":
            return paint(A.cyan, v.tag) + (v.v.length ? " " + v.v.map(showValue).join(" ") : "");
        default: return paint(A.gray, valueToString(v));
    }
}

const REPL_KEYWORDS = new Set(["match", "data"]);
const NATIVE_NAMES = new Set(NATIVES.map(([n]) => n));

// Syntax-highlight one buffer line (best-effort, purely cosmetic).
function highlightLine(s: string): string {
    let out = "", i = 0;
    const word = (c: string) => /[A-Za-z0-9_]/.test(c);
    while (i < s.length) {
        const c = s[i];
        if (c === "#") { out += paint(A.comment, s.slice(i)); break; }
        if (c === '"') {
            let j = i + 1;
            while (j < s.length && s[j] !== '"') j++;
            j = Math.min(j + 1, s.length);
            out += paint(A.green, s.slice(i, j)); i = j; continue;
        }
        if (c === "'") {
            const j = s[i + 1] === "\\" ? Math.min(i + 4, s.length) : Math.min(i + 3, s.length);
            out += paint(A.green, s.slice(i, j)); i = j; continue;
        }
        if (/\d/.test(c)) {
            let j = i;
            while (j < s.length && /[\d.]/.test(s[j])) j++;
            out += paint(A.yellow, s.slice(i, j)); i = j; continue;
        }
        if (word(c)) {
            let j = i;
            while (j < s.length && word(s[j])) j++;
            const w = s.slice(i, j);
            out += REPL_KEYWORDS.has(w) || w === "true" || w === "false" ? paint(A.magenta, w)
                : NATIVE_NAMES.has(w) ? paint(A.blue, w)
                : /^[A-Z]/.test(w) ? paint(A.cyan, w)
                : w;
            i = j; continue;
        }
        // structural punctuation and operators recede to gray so names and
        // values pop (spaces stay uncolored)
        let j = i;
        while (
            j < s.length && !/[A-Za-z0-9_]/.test(s[j]) && s[j] !== " " &&
            !"\"'#".includes(s[j])
        ) j++;
        if (j === i) { out += s[i]; i++; } // a space: plain, single char
        else {
            out += paint(A.gray, s.slice(i, j));
            i = j;
        }
    }
    return out;
}

// ---- history persistence (~/.apn_history, one JSON entry per line) ----

const HIST_CAP = 500;
let histWriteHinted = false;

function histFile(): string | null {
    try {
        const home = Deno.env.get("HOME");
        return home ? `${home}/.apn_history` : null;
    } catch {
        return null; // no --allow-env / no HOME: skip persistence, keep session history
    }
}

function loadHistory(): string[] {
    const f = histFile();
    if (!f) return [];
    try {
        const out: string[] = [];
        for (const line of Deno.readTextFileSync(f).split("\n")) {
            if (!line) continue;
            try { out.push(JSON.parse(line) as string); } catch { /* corrupt line: skip */ }
        }
        return out.slice(-HIST_CAP);
    } catch {
        return [];
    }
}

function appendHistory(entry: string): boolean {
    const f = histFile();
    if (!f) return true;
    try {
        Deno.writeTextFileSync(f, JSON.stringify(entry) + "\n", { append: true });
        return true;
    } catch {
        return false;
    }
}

function helpText(): string {
    return [
        `Language:`,
        `  symbol = value   (the ONLY binding form; top level or inside { } blocks)`,
        `  [a, b] = value (destructuring binding; records match by field name)`,
        `  Just v = value (declared constructors destructure; capital defs are errors)`,
        `  [x: a, y: b] = value  (rename destructure: pull fields out of a record)`,
        `  nums 0 / nums (-1) / nums [0, 2]   (apply a list = index)`,
        `  vec [1,2,3] / vec [z: 3, x: 1]   (apply a record = clone)`,
        `  rec.field / rec."key" / rec.(dyn) / rec.[x, y]  (quoted access + pluck)`,
        `  vec.x = 10 / vec.[x, y] = [1, 2]  (record update: rebinds a modified`,
        `              copy, scoped like any def — blocks shadow; [] seeds a record)`,
        `  x -> expr        (lambdas; first param may be [a, b] or (Ctor ..))`,
        `  cond ? a : b   (ternary)`,
        `  match x [ pat -> expr, ... ]   (all patterns, | guards; , or newline)`,
        `  data Maybe a = Just a | Nothing`,
        `  [1,2,3]  [name: "x", age: 2]   (newlines also separate elements)`,
        `  x $ f             pipe: feeds x into f`,
        `  a \`f\` b            infix call == f a b  (only \`for\` inverts)`,
        `  (+ 2)  (2 +)  (+)  operator sections   ((-2) stays unary minus)`,
        `  ( ) and { } are groups/blocks: unit when empty, value = last stmt`,
        `  ; or newline       statement separators (blocks & top level)`,
        `  indentation: strict 4-space layout (exactly +4 per level)`,
        `  for (x -> print x) [1,2,3]   for fn seq`,
        `  recursion, higher-order fns, records, variants`,
        ``,
        `print x    any value (strings raw), returns x;  emit  = no newline`,
        `debug x    shows the SOURCE as written;  step n v  descends v's body`,
        `quote / toAST  the s-expression as a list: toAST (1 + 2) => ["+", 1, 2]`,
        `Builtins: head tail length null enumerate map filter foldl foldr`,
        `          for pairs format intToString exit load`,
        ``,
        `load "core.txt"  imports the standard library (core.txt): as a`,
        `               statement it merges into the current scope; as a`,
        `               value it returns a module (core.sq 4). halting is`,
        `               core.txt's  halt = exit 0  (lazy: fires only when used).`,
        `0-arg defs: x = <expr> is a LAZY value (runs on first use); an ACTION`,
        `               body (f = { ... } / f = print "hi" — same thing) declares`,
        `               a 0-arg FUNCTION: the bare name at statement level runs it`,
        `               (so does debug (f)); debug f shows <function>`,
        ``,
        `Type annotations (TS-style) are accepted & ignored at runtime:`,
        `  x: Int = 5`,
        `Run: deno run --allow-read main.ts features.txt`,
        ``,
        `REPL:`,
        `  Up/Down    history (kept in ~/.apn_history)`,
        `  Tab        complete names/builtins/:commands; with nothing to`,
        `             complete, insert 4 spaces (the indent unit)`,
        `  Backspace  behind a full indent level deletes all 4 spaces; on a blank`,
        `             continuation line it undoes the line break (cursor at the`,
        `             end of the line above)`,
        `  Enter      runs when the chunk is complete; incomplete input continues`,
        `             on the next line ("... " prompt, auto-indent);`,
        `             a blank line is just spacing, Ctrl+C clears the input`,
        `  paste      multi-line text is inserted, not run; Enter then runs it`,
        `  Ctrl+C     clear input (empty: quit)  Ctrl+D quit  Ctrl+L clear screen`,
        `  Ctrl+A/E   line start/end  Ctrl+U/K kill to line start/end  Ctrl+W delete word`,
    ].join("\n");
}

// ---- raw-mode line editor (TTY only) ----

type KeyAction = "cont" | "submit" | "quit";
const ENC = new TextEncoder();

class ReplEditor {
    lines: string[] = [""];
    row = 0;
    col = 0;
    hist: string[];
    histIdx: number | null = null;
    draft = "";
    tabPrefix = "";
    esc = "";
    visRow = 0; // visual rows between the render home and the cursor
    interp: Interpreter;
    isComplete: (src: string) => boolean;

    constructor(interp: Interpreter, isComplete: (src: string) => boolean, hist: string[]) {
        this.interp = interp;
        this.isComplete = isComplete;
        this.hist = hist;
    }

    src(): string { return this.lines.join("\n"); }

    width(): number {
        try { return Deno.consoleSize().columns || 80; } catch { return 80; }
    }

    // Python-style prompts: ">>> " opens a chunk, "... " marks continuation
    // lines. Uniform 4-char width keeps the cursor math trivial.
    promptW(_i: number): number { return 4; }

    emit(s: string): void {
        Deno.stdout.writeSync(ENC.encode(s));
    }

    // Print a line of output below the input (raw mode: emit CRLF ourselves).
    print(s: string): void {
        this.emit(s.replace(/\n/g, "\r\n") + "\r\n");
    }

    // Visual rows a logical line occupies (terminal wrap assumed).
    rowsOf(i: number, w: number): number {
        return Math.max(1, Math.ceil((this.promptW(i) + this.lines[i].length) / w));
    }

    // Repaint the whole chunk from its home row; the home is where the cursor
    // sat when the chunk started, so only relative cursor moves are needed.
    render(): void {
        const w = this.width();
        if (this.visRow > 0) this.emit(`\x1b[${this.visRow}A`);
        this.emit("\r\x1b[J");
        let total = 0;
        for (let i = 0; i < this.lines.length; i++) {
            const p = i === 0 ? paint(A.bold + A.cyan, ">>> ") : paint(A.cyan, "... ");
            this.emit(p + highlightLine(this.lines[i]) + "\r\n");
            total += this.rowsOf(i, w);
        }
        let curRow = 0;
        for (let i = 0; i < this.row; i++) curRow += this.rowsOf(i, w);
        const x = this.promptW(this.row) + this.col;
        curRow += Math.floor(x / w);
        if (total - curRow > 0) this.emit(`\x1b[${total - curRow}A`);
        this.emit("\r");
        const xc = x % w;
        if (xc > 0) this.emit(`\x1b[${xc}C`);
        this.visRow = curRow;
    }

    insertText(t: string): void {
        for (const ch of t) {
            if (ch === "\n") { this.splitLine(); continue; }
            const line = this.lines[this.row];
            // dedent assist: typing } or ] on an indent-only line drops one level
            if ((ch === "}" || ch === "]") && this.col === line.length && /^\s+$/.test(line) && line.length >= 4) {
                this.lines[this.row] = line.slice(4);
                this.col -= 4;
            }
            this.lines[this.row] = this.lines[this.row].slice(0, this.col) + ch +
                this.lines[this.row].slice(this.col);
            this.col++;
        }
    }

    // Break the line at the cursor; auto-indent like the 4-space layout (copy
    // the line's indent, +4 when it ends with an opening bracket).
    splitLine(): void {
        const line = this.lines[this.row];
        const indent = (/^ */.exec(line) ?? [""])[0];
        const deeper = /[{[]\s*$/.test(line) ? "    " : "";
        this.lines[this.row] = line.slice(0, this.col);
        this.lines.splice(this.row + 1, 0, indent + deeper + line.slice(this.col));
        this.row++;
        this.col = indent.length + deeper.length;
    }

    backspace(): void {
        // a whitespace-only continuation line is just auto-indent: Backspace
        // undoes the line break — the cursor lands at the END of the line above
        if (this.row > 0 && /^\s*$/.test(this.lines[this.row])) {
            this.lines.splice(this.row, 1);
            this.row--;
            this.col = this.lines[this.row].length;
            return;
        }
        if (this.col > 0) {
            const line = this.lines[this.row];
            // inverse of the dedent assist: deleting a lone ]/} that the assist
            // moved to column 0 restores the 4-space continuation indent
            if (this.row > 0 && this.col === 1 && (line === "]" || line === "}")) {
                this.lines[this.row] = "    ";
                this.col = 4;
                return;
            }
            // the "opposite of Tab": a Backspace behind a full indent level
            // deletes all 4 spaces at once
            const n = this.col % 4 === 0 && this.col >= 4 &&
                    line.slice(this.col - 4, this.col) === "    " ? 4 : 1;
            this.lines[this.row] = line.slice(0, this.col - n) + line.slice(this.col);
            this.col -= n;
            return;
        }
        if (this.row > 0) {
            const prev = this.lines[this.row - 1];
            this.lines[this.row - 1] = prev + this.lines[this.row];
            this.lines.splice(this.row, 1);
            this.row--;
            this.col = prev.length;
        }
    }

    deleteFwd(): void {
        const line = this.lines[this.row];
        if (this.col < line.length) {
            this.lines[this.row] = line.slice(0, this.col) + line.slice(this.col + 1);
            return;
        }
        if (this.row < this.lines.length - 1) {
            this.lines[this.row] = line + this.lines[this.row + 1];
            this.lines.splice(this.row + 1, 1);
        }
    }

    left(): void {
        if (this.col > 0) this.col--;
        else if (this.row > 0) { this.row--; this.col = this.lines[this.row].length; }
    }

    // Ctrl+W: delete back to the start of the previous word (whitespace-
    // delimited); at column 0 it falls back to joining with the line above.
    deleteWordBack(): void {
        if (this.col === 0) { this.backspace(); return; }
        const line = this.lines[this.row];
        let i = this.col;
        while (i > 0 && line[i - 1] === " ") i--;
        while (i > 0 && line[i - 1] !== " ") i--;
        this.lines[this.row] = line.slice(0, i) + line.slice(this.col);
        this.col = i;
    }

    right(): void {
        if (this.col < this.lines[this.row].length) this.col++;
        else if (this.row < this.lines.length - 1) { this.row++; this.col = 0; }
    }

    // Trailing whitespace-only lines never reach the parser.
    trimmedSrc(): string {
        return this.src().replace(/(?:\n[ \t]*)+$/, "");
    }

    enter(): KeyAction {
        const atEnd = this.row === this.lines.length - 1 &&
            this.col === this.lines[this.row].length;
        if (!atEnd) { this.splitLine(); return "cont"; }
        const line = this.lines[this.row];
        // whitespace-only single line: like Python, just show a fresh prompt
        if (this.lines.length === 1 && line.trim() === "") return "submit";
        if (this.isComplete(this.trimmedSrc())) return "submit";
        this.splitLine();
        return "cont";
    }

    // Single-line buffer: Up/Down walk history. Multi-line buffer (continuation
    // or a recalled multi-line entry): Up/Down move between lines instead.
    up(): KeyAction {
        if (this.lines.length > 1) {
            if (this.row > 0) { this.row--; this.col = Math.min(this.col, this.lines[this.row].length); }
            return "cont";
        }
        if (this.hist.length === 0) return "cont";
        if (this.histIdx === null) {
            this.draft = this.src();
            this.histIdx = this.hist.length - 1;
        } else if (this.histIdx > 0) this.histIdx--;
        this.recall(this.hist[this.histIdx]);
        return "cont";
    }

    down(): KeyAction {
        if (this.lines.length > 1) {
            if (this.row < this.lines.length - 1) { this.row++; this.col = Math.min(this.col, this.lines[this.row].length); }
            return "cont";
        }
        if (this.histIdx === null) return "cont";
        this.histIdx++;
        if (this.histIdx >= this.hist.length) {
            this.histIdx = null;
            this.recall(this.draft);
        } else this.recall(this.hist[this.histIdx]);
        return "cont";
    }

    recall(entry: string): void {
        this.lines = entry.split("\n");
        this.row = this.lines.length - 1;
        this.col = this.lines[this.row].length;
    }

    completionCands(): string[] {
        const s = new Set<string>(["match", "data"]);
        for (const [n] of NATIVES) s.add(n);
        for (const n of envNames(this.interp.env)) s.add(n);
        return [...s].sort();
    }

    // Tab: complete the word before the cursor (builtins, bound names,
    // :commands). With no word (or no completion) on an empty spot it inserts
    // 4 spaces — the language's indent unit.
    tab(): KeyAction {
        const line = this.lines[this.row];
        const before = line.slice(0, this.col);
        if (/^:[a-z]*$/.test(before)) {
            const cmds = [":help", ":h", ":quit", ":q"].filter((c) => c.startsWith(before) && c !== before);
            if (cmds.length === 1) this.insertText(cmds[0].slice(before.length));
            else if (cmds.length > 1) this.listMatches(cmds);
            return "cont";
        }
        const word = (/[A-Za-z0-9_]*$/.exec(before) ?? [""])[0];
        if (word === "") {
            this.insertText("    ");
            this.tabPrefix = "";
            return "cont";
        }
        const cands = this.completionCands().filter((c) => c.startsWith(word) && c !== word);
        if (cands.length === 0) { this.tabPrefix = ""; return "cont"; }
        if (cands.length === 1) {
            this.insertText(cands[0].slice(word.length));
            this.tabPrefix = "";
            return "cont";
        }
        let common = cands[0];
        for (const c of cands) while (!c.startsWith(common)) common = common.slice(0, -1);
        if (common.length > word.length) {
            this.insertText(common.slice(word.length));
            this.tabPrefix = common;
            return "cont";
        }
        if (this.tabPrefix === word) this.listMatches(cands); // Tab again: list them
        else this.tabPrefix = word;
        return "cont";
    }

    listMatches(items: string[]): void {
        this.emit("\r\n" + items.join("  ") + "\r\n");
        this.visRow = 0;
        this.render();
    }

    ctrlC(): KeyAction {
        // quit only on a literally empty buffer; indent-only input CLEARS
        // (the indent may be auto-inserted, invisible to the eye)
        if (this.lines.length === 1 && this.lines[0] === "") return "quit";
        this.lines = [""]; this.row = 0; this.col = 0; this.histIdx = null;
        return "cont";
    }

    ctrlD(): KeyAction {
        if (this.src() === "") return "quit";
        this.deleteFwd();
        return "cont";
    }

    ctrlL(): KeyAction {
        this.emit("\x1b[2J\x1b[H");
        this.visRow = 0;
        return "cont";
    }

    // Feed one decoded input character; escape sequences assemble in this.esc.
    feed(ch: string): KeyAction {
        if (this.esc !== "") {
            this.esc += ch;
            const e = this.esc;
            if (e.length === 2 && e[1] !== "[" && e[1] !== "O") {
                this.esc = ""; // stray ESC followed by a normal char: ignore both
                return "cont";
            }
            const last = e[e.length - 1];
            const done = (e[1] === "O" && e.length >= 3) ||
                (e[1] === "[" && e.length >= 3 && (last === "~" || /[A-Za-z]/.test(last)));
            if (!done) return "cont";
            this.esc = "";
            const rest = e[1] === "O" ? e[2] : e.slice(2);
            if (rest === "A") return this.up();
            if (rest === "B") return this.down();
            if (rest === "C") { this.right(); return "cont"; }
            if (rest === "D") { this.left(); return "cont"; }
            if (rest === "H" || rest === "1~" || rest === "7~") { this.col = 0; return "cont"; }
            if (rest === "F" || rest === "4~" || rest === "8~") {
                this.col = this.lines[this.row].length;
                return "cont";
            }
            if (rest === "3~") { this.deleteFwd(); return "cont"; }
            if (rest === "200~") { this.pastePending = true; } // bracketed paste start
            return "cont";
        }
        switch (ch) {
            case "\x1b": this.esc = "\x1b"; return "cont";
            case "\r": case "\n": return this.enter();
            case "\t": return this.tab();
            case "\x7f": this.backspace(); return "cont";
            case "\x03": return this.ctrlC();
            case "\x04": return this.ctrlD();
            case "\x0c": return this.ctrlL();
            case "\x01": this.col = 0; return "cont";
            case "\x05": this.col = this.lines[this.row].length; return "cont";
            case "\x15":
                this.lines[this.row] = this.lines[this.row].slice(this.col);
                this.col = 0;
                return "cont";
            case "\x17": this.deleteWordBack(); return "cont";
            case "\x0b":
                this.lines[this.row] = this.lines[this.row].slice(0, this.col);
                return "cont";
            default:
                if (ch >= " " && ch !== "\x7f") this.insertText(ch);
                return "cont";
        }
    }

    // Read one chunk (Enter on complete input). null = user quit.
    // Keys typed ahead (a read batch extending past the Enter that submits)
    // are kept in pendingKeys and replayed into the NEXT chunk.
    // Bracketed paste (the terminal wraps pastes in ESC[200~ ... ESC[201~)
    // inserts its text verbatim without running it.
    pendingKeys = "";
    pastePending = false;

    async readChunk(): Promise<string | null> {
        this.lines = [""]; this.row = 0; this.col = 0;
        this.histIdx = null; this.esc = ""; this.tabPrefix = ""; this.visRow = 0;
        this.render();
        const buf = new Uint8Array(4096);
        const dec = new TextDecoder();
        let queue = this.pendingKeys;
        this.pendingKeys = "";
        let stash = ""; // a paste whose end marker has not arrived yet
        while (true) {
            if (queue === "") {
                const n = await Deno.stdin.read(buf);
                if (n === null) return null;
                queue = (stash + dec.decode(buf.subarray(0, n), { stream: true })).replace(/\r\n?/g, "\n");
                stash = "";
            }
            if (queue.startsWith("\x1b[200~")) {
                const e = queue.indexOf("\x1b[201~", 6);
                if (e === -1) {
                    stash = queue; // wait for the rest of the paste
                    queue = "";
                    continue;
                }
                this.insertText(queue.slice(6, e));
                queue = queue.slice(e + 6);
                this.render();
                continue;
            }
            let action: KeyAction = "cont";
            let i = 0;
            for (; i < queue.length; i++) {
                if (queue[i] === "\x1b" && queue.startsWith("\x1b[200~", i)) break;
                action = this.feed(queue[i]);
                if (action !== "cont") break;
                this.render(); // per keystroke, like a real terminal shows them
            }
            if (this.pastePending) { // marker assembled char-by-char in feed()
                this.pastePending = false;
                queue = "\x1b[200~" + queue.slice(i + 1);
                continue;
            }
            if (action === "submit" || action === "quit") {
                this.pendingKeys = queue.slice(i + 1);
                this.emit("\r\n");
                return action === "submit" ? this.trimmedSrc() || "" : null;
            }
            if (i < queue.length) { // stopped at a paste marker
                queue = queue.slice(i);
                continue;
            }
            queue = "";
        }
    }
}

// ---- TTY REPL: raw-mode editor, colors, persistent history ----

// The SIGINT watcher worker: its event loop is free while the main thread
// spins in a divergent evaluation, so Ctrl+C always gets through.
function startInterruptWatcher(): { worker: Worker; flag: Int32Array } {
    const src = `self.onmessage = (e) => {
        const flag = new Int32Array(e.data);
        Deno.addSignalListener("SIGINT", () => {
            Atomics.load(flag, 1);
            Atomics.store(flag, 0, 1);
            Atomics.store(flag, 1, 888);
        });
        self.postMessage("ready");
    };`;
    const worker = new Worker(`data:application/javascript,${encodeURIComponent(src)}`, {
        type: "module",
        name: "apn-sigint",
    });
    const sab = new SharedArrayBuffer(8);
    worker.postMessage(sab);
    return { worker, flag: new Int32Array(sab) };
}

// stty helpers: capture the cooked termios once, restore it around each
// evaluation so Ctrl+C raises a real SIGINT (needs --allow-run).
async function ttyCookedSettings(): Promise<string> {
    const p = new Deno.Command("stty", { args: ["-g"], stdin: "inherit", stdout: "piped", stderr: "null" });
    const out = await p.output();
    return new TextDecoder().decode(out.stdout).trim();
}

async function setTtyCooked(saved: string): Promise<void> {
    await new Deno.Command("stty", { args: [saved], stdin: "inherit", stdout: "null", stderr: "null" }).output();
}

async function replTTY(): Promise<void> {
    const interp = new Interpreter();
    const hist = loadHistory();
    const ed = new ReplEditor(interp, chunkComplete, hist);
    const watch = startInterruptWatcher();
    setInterruptFlag(watch.flag);

    // Route console.log (used by the print/debug natives) through the editor
    // so output is newline-correct while the terminal is raw.
    const origLog = console.log.bind(console);
    console.log = (...args: unknown[]) => {
        ed.print(args.map((x) => typeof x === "string" ? x : String(x)).join(" "));
    };

    const savedCooked = await ttyCookedSettings();
    Deno.stdin.setRaw(true);
    ed.emit("\x1b[?2004h"); // ask the terminal to wrap pastes in ESC[200~..ESC[201~
    try {
        while (true) {
            const src = await ed.readChunk();
            if (src === null) { ed.print("bye"); return; }
            const cmd = src.trim();
            if (cmd === ":quit" || cmd === ":q") { ed.print("bye"); return; }
            if (cmd === ":help" || cmd === ":h") { ed.print(helpText()); continue; }
            if (cmd === "") continue;
            if (src !== hist[hist.length - 1]) {
                hist.push(src);
                if (!appendHistory(src) && !histWriteHinted) {
                    histWriteHinted = true;
                    ed.print(paint(A.dim, "(history not saved: run with --allow-write)"));
                }
            }
            resetInterrupt(); // fresh chunk, fresh interrupt state
            // During EVALUATION the terminal drops out of raw mode, so Ctrl+C
            // raises a real SIGINT (the watcher worker flips the flag and the
            // hot loops throw). Editing happens back in raw mode where Ctrl+C is
            // the usual 0x03 clear/quit.
            await setTtyCooked(savedCooked);
            try {
                const val = runSourceValue(src, interp, lastIsBinding(src) || lastIsPrintCall(src));
                if (val !== null) ed.print(showValue(val));
            } catch (err) {
                if (err instanceof APNError && err.message === "interrupted") {
                    ed.print(paint(A.dim, "Interrupted."));
                } else {
                    ed.print(formatError(err, true));
                }
            } finally {
                Deno.stdin.setRaw(true);
            }
        }
    } finally {
        setInterruptFlag(null);
        watch.worker.terminate();
        ed.emit("\x1b[?2004l");
        console.log = origLog;
        Deno.stdin.setRaw(false);
    }
}

// ---- piped REPL (stdin not a TTY): plain line loop, no editor/colors ----

async function replPiped(): Promise<void> {
    const interp = new Interpreter();

    const decoder = new TextDecoder();
    const buf = new Uint8Array(1024);
    const stdin = Deno.stdin;

    let pending = "";
    const prompt = ">>> ";

    const processBuffer = (chunk: string): string[] => {
        return chunk.split("\n");
    };

    let leftover = "";

    // We drive input manually; print the initial prompt.
    await Deno.stdout.write(new TextEncoder().encode(prompt));

    while (true) {
        const n = await stdin.read(buf);
        if (n === null) break;
        const chunk = decoder.decode(buf.subarray(0, n));
        leftover += chunk;
        const lines = processBuffer(leftover);
        leftover = lines.pop() ?? "";

        for (const rawLine of lines) {
            const line = rawLine.trimEnd();
            if (line.length === 0) {
                await Deno.stdout.write(new TextEncoder().encode(prompt));
                continue;
            }
            if (line === ":quit" || line === ":q") {
                console.log("bye");
                return;
            }
            if (line === ":help" || line === ":h") {
                console.log(helpText());
                await Deno.stdout.write(new TextEncoder().encode(prompt));
                continue;
            }

            pending = pending ? pending + "\n" + line : line;
            // Try to evaluate; if the parse error indicates an incomplete block
            // (missing `in`, `->`, or a structural `newline`), keep accumulating so
            // users can enter multi-line constructs. Otherwise report the error.
            try {
                const out = runSource(pending, interp, lastIsBinding(pending) || lastIsPrintCall(pending));
                if (out) console.log(out);
                pending = "";
                await Deno.stdout.write(new TextEncoder().encode(prompt));
                continue;
            } catch (err) {
                const msg = (err as Error).message;
                if (isIncompleteError(msg)) {
                    // Possibly incomplete — keep going.
                    await Deno.stdout.write(new TextEncoder().encode("... "));
                    continue;
                }
                // Real error: show it, reset pending.
                console.log(formatError(err, false));
                pending = "";
                await Deno.stdout.write(new TextEncoder().encode(prompt));
                continue;
            }
        }
        if (leftover !== "") {
            await Deno.stdout.write(new TextEncoder().encode(prompt));
        }
    }
}

export async function repl(): Promise<void> {
    console.log("APN interpreter v1.1.0");
    console.log("Applicative Polish Notation — lazy, Haskell-like, untyped like JS, annotated like TS.");
    if (Deno.stdin.isTerminal()) {
        console.log(":help :quit  |  Up/Down history  |  Tab complete/indent  |  Ctrl+C/D quit");
        await replTTY();
        return;
    }
    console.log("Commands: :help :quit");
    console.log();
    await replPiped();
}

