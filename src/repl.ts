import { lex, type Token } from "./lexer.ts";
import { parse } from "./parser.ts";
import { VERSION } from "./cli-options.ts";
import { APNError } from "./errors.ts";
import { NATIVE_NAMES, envNames, dirname, Interpreter, setInterruptFlag, resetInterrupt } from "./interp.ts";
import type { Value, Env } from "./types.ts";
import type { Expr, Pattern, TopLevel } from "./ast.ts";
import { highlightTokens, PALETTES } from "./highlight.ts";
import { forwardWordEnd, moveWord, type Style } from "./word-motion.ts";

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
    const head = e.kind === "runtime" ? "runtime error" : e.kind === "type" ? "type error" : "parse error";
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

// Run a source chunk; returns the forced value, or null for suppressed statements.
// REPL echo uses this (it needs the Value for colored printing).
// A file (file) is a block run once: what it drops is checked as a block's
// last statement is, where the REPL would show it.
function runSourceValue(src: string, interp: Interpreter, binding = false, file = false): Value | null {
    let program: TopLevel[];
    try {
        program = parse(src, interp.sourceFile);
    } catch (err) {
        throw err instanceof APNError ? err : new APNError("parse", (err as Error).message);
    }
    let val: Value;
    try {
        val = interp.run(program, false, file);
    } catch (err) {
        if (err instanceof APNError) throw err;
        throw new APNError("runtime", (err as Error).message.replace(/^Runtime: /, ""));
    }
    if (binding) return null; // an assignment binds — never forced, never echoed
    // A statement running an import or a load yields a module: showing all of
    // it could force infinite lists or failing lazy bindings. Print and field
    // reads still show its parts.
    const last = program[program.length - 1];
    if (last?.t === "expr" && interp.isModule(val)) return null;
    val = interp.force(val);
    if (last?.t === "expr" && interp.ranAction && val.kind === "list" && val.v.length === 0) return null;
    return val;
}

// Does the chunk END in a binding (def / pattern binding / type)? Those are
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
            if (e.t === "app" && e.f.t === "var" && ["print", "echo", "emit"].includes(e.f.name)) return true;
            if (e.t === "pipe") {
                const c = e.f;
                if (c.t === "var" && ["print", "echo", "emit"].includes(c.name)) return true;
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

export function runSource(src: string, interp: Interpreter, binding = false, file = false): string {
    const val = runSourceValue(src, interp, binding, file);
    return val === null ? "" : interp.renderString(val);
}

// Does this parse error mean "input is still incomplete, keep reading"?
function isIncompleteError(msg: string): boolean {
    return /'EOF'|end of file|unterminated|expected '->'|expected an expression after|unexpected 'newline'|unexpected 'indent'|unexpected 'dedent'/.test(msg);
}

// Scan only text before the cursor; tolerate incomplete/invalid source.
export function insideBrackets(src: string, multilineOnly = false): boolean {
    const stack: { bracket: string; line: number }[] = [];
    let line = 0;
    let quote = "", comment = false, escaped = false;
    for (const ch of src) {
        if (ch === "\n") line++;
        if (comment) { if (ch === "\n") comment = false; continue; }
        if (quote) {
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === quote) quote = "";
            continue;
        }
        if (ch === "#") { comment = true; continue; }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if ("([{".includes(ch)) stack.push({ bracket: ch, line });
        else if (")]}".includes(ch)) {
            const opening = "([{"[")]}".indexOf(ch)];
            if (stack[stack.length - 1]?.bracket === opening) stack.pop();
        }
    }
    return multilineOnly ? stack.some((entry) => entry.line < line) : stack.length > 0;
}

export function afterOpeningBracket(src: string): boolean {
    return "([{".includes(lastSignificant(src).slice(-1) || "?");
}
// A line ending in a binding's = (or <-, ->) still awaits its body.
export function awaitsBody(src: string): boolean {
    const end = lastSignificant(src);
    return end.endsWith("<-") || end.endsWith("->") || end.endsWith("=") && !/[=<>!]=$/.test(end);
}
// The end of the last token before the cursor, ignoring comments; empty
// inside an unterminated string.
function lastSignificant(src: string): string {
    let quote = "", comment = false, escaped = false, token = "", lastToken = "";
    for (const ch of src) {
        if (comment) { if (ch === "\n") comment = false; continue; }
        if (quote) {
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === quote) quote = "";
            token += ch;
            continue;
        }
        if (/\s/.test(ch) || ch === "#") {
            if (token) { lastToken = token; token = ""; }
            if (ch === "#") comment = true;
            continue;
        }
        token += ch;
        if (ch === '"' || ch === "'") quote = ch;
    }
    return quote ? "" : (token || lastToken).slice(-2);
}

// ---- ANSI colors (TTY REPL only; piped output stays plain) ----
// Tokens take the shared Frappé palette (src/highlight.ts), in truecolor.
const ansi = (hex: string) => `\x1b[38;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m`;
const T = Object.fromEntries(Object.entries(PALETTES.dark).map(([type, hex]) => [type, ansi(hex)]));
const A = {
    reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
    red: "\x1b[38;2;231;130;132m", // #e78284   errors
    green: T.string, yellow: T.number, cyan: T.type, // carets, hints, prompts
};
const paint = (code: string, s: string) => code + s + A.reset;

// Text the interpreter renders, colored by its kind (Interpreter.paint).
export function colored(text: string, kind?: Value["kind"] | "key"): string {
    if (kind === "key") return text;
    if (kind === "int" || kind === "float" || kind === "rational" || kind === "complex") return highlightLine(text);
    const type = kind === "string" || kind === "char" ? "string"
        : kind === "bool" ? "keyword"
        : kind === "variant" || kind === "type" ? "type" : "punctuation";
    return paint(T[type], text);
}

export function renderColored(interp: Interpreter, value: Value, emit: (s: string) => void): void {
    interp.render(value, (text, kind) => emit(colored(text, kind)));
}


// Syntax-highlight one buffer line (best-effort, purely cosmetic); ternaries
// carries open ?: from line to line.
export function highlightLine(s: string, ternaries: number[] = [0]): string {
    let out = "", at = 0;
    for (const token of highlightTokens(s, NATIVE_NAMES, ternaries)) {
        out += s.slice(at, token.start) + paint(T[token.type], s.slice(token.start, token.start + token.length));
        at = token.start + token.length;
    }
    return out + s.slice(at);
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
        `  [a,b] = value (destructuring binding; records match by field name)`,
        `  Some v = value (declared constructors destructure; capital defs are errors)`,
        `  [x = 1, y = x + 1]  (a record: its fields are bindings, each in scope for those after it)`,
        `  [x : Float, y : Float = 1]  (declared fields: a type, or a typed value); [use r, z = 3] spreads r`,
        `  [\`my value\` = 1]  (a field that is not a name is in backticks; read r.\`my value\` or r "my value")`,
        `  [x = a, y = b] = value  (rename destructure: pull fields out of a record)`,
        `  [["x",1]] "x"  (association lookup; first matching string key)`,
        `  nums 0 / nums -1 / nums [0,2]   (single or multiple indices)`,
        `  [String,Int].["x",1] / templates.values / templates.(expr)  (list templates)`,
        `  vec [z = 3, x = 1]   (a copy with those fields; [] : T makes a type's value)`,
        `  rec.field / rec "key" / rec.[x,y] / rec.[a = x]  (access, pluck, renamed pluck)`,
        `  rec.(expression) / rec.{ statements }  (evaluate with record fields in a local scope)`,
        `  vec.x = 10 / obj.child.x = 10 / vec.[x,y] = [1,2]  (record update: rebinds a modified`,
        `              copy, scoped like any def — blocks shadow; [] seeds a record)`,
        `  vec.[x : Float] = [1]  (a typed entry declares the field anew: x is the Float 1.0)`,
        `  f = { ... }  ({ stays on the = line; body +4 spaces; } aligned)`,
        `  x -> expr; x, y -> expr; (x : Int), y -> expr   (lambdas; t x -> t is one pattern)`,
        `  xs * x -> { expr } * y -> expr   (braces end the first lambda)`,
        `  cond ? a : b   (ternary)`,
        `  x ~ [ pat -> expr, ... ]   (match: an operator; alternatives are pattern lambdas)`,
        `  literal patterns: 0  1.5  "s"  'c'  True  [1..9]   (tried before other clauses)`,
        `  func ((Int -> Int) f) = Int { f 123 }   (checked function contract)`,
        `  ((a -> a) f), (a -> a).(+ 1), (a -> a) == typeOf f   a lambda read as a function type`,
        `  List Int is a list of any length; [Int] is exactly one Int; [Int..] endlessly many`,
        `  f x = 1; f x = "one"   overloads by result type: (f 0 : Int) is 1, (f 0 : String) "one"`,
        `  Option a = Some a | None`,
        `  Count = Int     (a named Int: an Int wherever one is accepted, keeps its name)`,
        `  Positive = (n : Int) | n > 0   (a refinement: the Ints for which the condition holds)`,
        `  Box x = _   (a constructor: Box 5 stands for itself; Rect (w : Float) (h : Float) = _ converts fields)`,
        `  UserId (id : Int) = _   (a distinct type: none of Int's operations; UserId x patterns unwrap)`,
        `  f (x : Int) : Int = x + x   (: T after the parameters is the type of f x, its result)`,
        `  Circle (r : Float) : Shape = _   (a constructor of Shape; Shape = Circle Float | ... stands for it)`,
        `  Opt a : Type = _   (a type: a constructor declared into Type; constructors are declared into it)`,
        `  Add x (Num 0) = x, then Add x y = _   (rules before a constructor's declaration run first)`,
        `  Percent (x : Float) = x > 100 ? Percent 100.0 : _   (a constructor's logic; _ is the value itself)`,
        `  Box a = tag Box Box [a]   (a tagged value: its constructor, owner and fields)`,
        `  assert c x           x once c holds (a failure reports c and its location)`,
        `  [1,2,3]  [0..5] [0,0.5..100] [0..]  ranges; 0:[] conses`,
        `  ['a'..'e'] => "abcde"; take 6 (iterate (*2) 1) => [1,2,4,8,16,32]`,
        `  ones = 1:ones; take 5 ones   lazy heads/tails; drop 5 ones`,
        `  map/filter/zipWith/foldr consume lazy lists; Ctrl+C stops output`,
        `  f $ x             application: f (x); f $ g $ x = f (g x)`,
        `  (+ 2)  (2 +)  (+)  (- 2)  (10 -)  (-)  operator sections   (-2 is a number)`,
        `  operators are prelude functions: (+) 1 2; infixl/infixr/infix 0..9 declare fixity`,
        `  (Money a) + (Money b) = Money (a + b)   beside Money: joins + everywhere`,
        `  xs +++ ys = ...; (<+>) = f   new operators work but are not recommended`,
        `  ( ) and { } are groups/blocks: [] when empty, value = last stmt`,
        `  spacing: x = 1, lists [1,2,3] and [1 + 1, 2], records [x = 1, y = 2], (x), { x } (--loose: none)`,
        `  [f x, g y] = [x, y]   (defines f x = x and g y = y; both sides of = space their commas alike)`,
        `  operators spaced on both sides or neither: 1 + 2, 1+2 (not 1 +2); -x negates, f -1 passes -1`,
        `  ; or newline       statement separators (blocks & top level)`,
        `  print, readFile, fetch, set ... are IO actions: statements and <- run them`,
        `  echo x prints x as the REPL shows it; repl opens a session on the names where it runs`,
        `  x <- action        run it now and bind its result (outer value only); x <- return v is strict`,
        `  f n = { print n; return n }   a block running an action is an action; it ends with one`,
        `  IO [] is the type of an action yielding []; IO [] { print "hi" } checks one; return x`,
        `  map/<$>, return, <*>, >>=, >>, =<<, sequence, mapM, when, unless (IO, lists, Option)`,
        `  while [n < 3] (set n (n + 1)) runs its code anew each pass; loop action runs forever`,
        `  for [i = 0, i < 3, i = i + 1] { print i }: the step rebinds i (or set a cell)`,
        `  throw e (None, Err e, [], an IO failure), guard c: a False guard throws c; so does a discarded None/Err`,
        `  map f (Leaf x) = ...; Box x >>= f = ...; return = Box   instances (beside the type)`,
        `  Option Int { return 42 } => Some 42; List Int { a <- [1,2]; return a }   any monad`,
        `  indentation: strict 4-space layout (exactly +4 per level); lines are at most 99 characters`,
        `  a deeper line continues an application, an operator chain, a list item or a record field`,
        `  [1,2,3] * x -> print x      (seq * fn iterates; int * fn counts)`,
        `  recursion, higher-order fns, records, variants`,
        `  std <- import "std"; use std.[function,number]   the library; open modules`,
        `  text <- import "std/text"; text.words "a b"   one module (a file or a folder), not opened`,
        `  use record (or a list of records) opens its fields in this scope`,
        `  text <- readFile "input.input"; input <- readInput; args <- getArgs (script I/O)`,
        `  Bool True; String "hi"; Char 'a'; List [1,2]; Record [x = 1]`,
        `  (x -> x : Function); (Int : Type); (YourConstructor value : Variant)`,
        `  Int/UInt, Int8..Int128/UInt8..UInt128, Float/Float32, Fraction, Complex`,
        `  f Z = 1; f (S k) = ... (UInt as naturals: Z is 0, S k matches k + 1)`,
        `  Vec n a = Nil -> Vec Z a | Cons a (Vec k a) -> Vec (S k) a (indexed family)`,
        `  to String x; from String "42"; to JSON x; from JSON text; to (List Char) s; from (List Char) cs`,
        `  describe Int = ...  (a bare type name in a pattern matches that type)`,
        `  do [print "hi", return 42] — the block { print "hi"; return 42 }`,
        `  123 : Int32; to Int (truncate 3.7); typeOf value; ([x : Float] : Type)`,
        `  values are sets: Int | String; Int <= Number; [1] <= [1,2]; [1,2] & [1,3]; 3 | 5`,
        `  x : Int32 = 123; x = 123 : Int32; f (n : Int) = ...  (declare, ascribe, type a pattern)`,
        `  append : Vect n a -> Vect m a -> Vect (n + m) a  (declares the clauses after it)`,
        `  myTypeOf (x : t) = print t   (bind the runtime type and value)`,
        `  f (x : Int) = ...; f (x : Number) = ... (typed overloads)`,
        `  100 * _ -> (0 : Int) repeats; 100 * (0 : Int) multiplies`,
        `  insert ["x": 123] $ HashMap []; lookup "x" m; m "x"`,
        `  has/remove key map; keys/values/pairs map; map updates are persistent`,
        `  sqrt -1 => 0+1i (function - number applies it to the negated number)`,
        `  exact integers/rationals: 0xFF, 0b1010, 0o17, 1 / 3; floats: .1, 1e3`,
        `  1 + 2.0 => 3.0; exact/inexact convert; quotient truncates division`,
        `  sqrt -1 => 0+1i; literals 1i, 3+4i, 2@3 (radians); realPart/imagPart`,
        `  isNumber/isInteger/isExact; numerator/denominator; round ties to even`,
        `  foo = _   unfinished definition; using it raises not implemented`,
        `  List _ / Option _   (_ given to a type is any: typeOf x <= List _)`,
        `  arr 0 = 10   update an existing list; arr (-1) = 10 updates its last item`,
        `  both sides of = are required; use [] for an empty result`,
        ``,
        `print x    any value (strings raw), returns x;  emit  = no newline`,
        `debug x    shows the SOURCE as written;  step n v  descends v's body`,
        `probe [1 + 1] => [1 + 1]: a list is code; print shows values, reduce gives them`,
        `[x = 1] ++ [x + 1] joins code: [2]; code 0 = (x = 10) replaces an item; code.x reads x, code.x = 5 rebinds it`,
        `toAST [1 + 2] => ["[]",["+",1,2]]; import "std/syntax": fromAST, eval, toLambda`,
        `Mutable: x = Mutable 0; set x $ (x + 1); print x`,
        `Builtins: head tail take drop length null enumerate map filter zipWith`,
        `          foldl foldr pairs format to from exit load step`,
        ``,
        `numbers <- load "lib/std/number"  reads lib/std/number.apn as code (omit the`,
        `               extension): numbers.sq 4 reads it; use numbers runs the file here,`,
        `               binding what it binds. halting is system's  halt = exit 0.`,
        `0-arg defs: ordinary value bodies are lazy and memoized; an ACTION`,
        `               body (f = { ... } / f = print "hi" — same thing) declares`,
        `               a 0-arg FUNCTION: the bare name at statement level runs it`,
        `               print f also runs it; debug f shows its name without running it`,
        ``,
        `Types are written after ':'; '::' is cons:`,
        `  x = 5 : Int    x : Int = 5    f (x : Int) = x + 1    (f : Int -> Int) <- expr`,
        `Run: deno run --allow-read main.ts examples/features.apn`,
        ``,
        `REPL:`,
        `  Up/Down    move between lines; first/last line browses history`,
        `  Tab        complete names/builtins/:commands; with nothing to`,
        `             complete, insert 4 spaces (the indent unit)`,
        `  Backspace  behind a full indent level deletes all 4 spaces; on a blank`,
        `             continuation line it undoes the line break (cursor at the`,
        `             end of the line above)`,
        `  Enter      continues after an opener or inside a multiline bracket block`,
        `             on the next line ("... " prompt, auto-indent);`,
        `             cursor position decides, regardless of syntax validity`,
        `  Shift+Enter reverses Enter; Option+Left/Right moves by word, as fish does`,
        `  paste      multi-line text is inserted, not run; Enter then runs it`,
        `  editor     editors/neovim/try-apn FILE opens your usual Neovim with APN LSP`,
        `  Ctrl+C     clear input (empty: quit)  Ctrl+D quit  Ctrl+L clear screen`,
        `  Ctrl+A/E   line start/end  Ctrl+U/K kill to line start/end  Ctrl+Y yank`,
        `  Ctrl+W     kill a path component (foo/bar loses bar)  Option+Backspace/D a word`,
    ].join("\n");
}

// ---- raw-mode line editor (TTY only) ----

type KeyAction = "cont" | "submit" | "quit";
const ENC = new TextEncoder();

// Key modifiers as terminals encode them (one less than the number sent);
// Caps Lock (64) and Num Lock (128) are not modifiers of a binding.
const SHIFT = 1, ALT = 2, CTRL = 4, SUPER = 8, META = 32;
const KEY_NAMES: Record<string, string> = {
    A: "up", B: "down", C: "right", D: "left", H: "home", F: "end",
    "1~": "home", "7~": "home", "4~": "end", "8~": "end", "3~": "delete", "200~": "paste",
    13: "enter", 9: "tab", 127: "backspace", 8: "backspace", 27: "escape",
};
// A key from the bytes after ESC [ (or ESC O): legacy and modified cursor
// keys (A, 1;5D), editing keys (3~, 3;3~), the Kitty protocol (119;5u) and
// xterm's modifyOtherKeys (27;5;119~). Undefined for a key release.
export function decodeKey(rest: string): { name: string; modifiers: number } | undefined {
    const modifiers = (n: string | undefined) => (Number(n ?? 1) - 1) & ~(64 | 128);
    let m = /^(\d+)(?::\d+)*(?:;(\d+)(?::(\d))?)?u$/.exec(rest);
    if (m) {
        if (m[3] === "3") return undefined;
        const code = Number(m[1]);
        return { name: KEY_NAMES[code] ?? String.fromCodePoint(code).toLowerCase(), modifiers: modifiers(m[2]) };
    }
    m = /^27;(\d+);(\d+)~$/.exec(rest);
    if (m) return { name: KEY_NAMES[m[2]] ?? String.fromCodePoint(Number(m[2])).toLowerCase(), modifiers: modifiers(m[1]) };
    m = /^(?:1)?(?:;(\d+))?([A-DHF])$/.exec(rest);
    if (m) return { name: KEY_NAMES[m[2]], modifiers: modifiers(m[1]) };
    m = /^(\d+)(?:;(\d+))?~$/.exec(rest);
    if (m) return { name: KEY_NAMES[`${m[1]}~`] ?? "unknown", modifiers: modifiers(m[2]) };
    return { name: "unknown", modifiers: 0 };
}

export class ReplEditor {
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

    constructor(interp: Interpreter, hist: string[]) {
        this.interp = interp;
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
    render(finish = false): void {
        const w = this.width();
        if (this.visRow > 0) this.emit(`\x1b[${this.visRow}A`);
        this.emit("\r\x1b[J");
        let total = 0;
        const ternaries = [0];
        for (let i = 0; i < this.lines.length; i++) {
            const p = i === 0 ? paint(A.bold + A.cyan, ">>> ") : paint(A.cyan, "... ");
            this.emit(p + highlightLine(this.lines[i], ternaries) + "\r\n");
            total += this.rowsOf(i, w);
        }
        // Submission leaves the cursor below the entire chunk, including wraps.
        if (finish) { this.visRow = total; return; }
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
            // dedent assist: typing ), } or ] on an indent-only line drops one level
            if ((ch === "}" || ch === "]" || ch === ")") && this.col === line.length && /^\s+$/.test(line) && line.length >= 4) {
                this.lines[this.row] = line.slice(4);
                this.col -= 4;
            }
            this.lines[this.row] = this.lines[this.row].slice(0, this.col) + ch +
                this.lines[this.row].slice(this.col);
            this.col++;
        }
    }

    // Paste already contains its layout; never apply typing indentation assists.
    insertPaste(text: string): void {
        const parts = text.replace(/\r\n?/g, "\n").split("\n");
        const before = this.lines[this.row].slice(0, this.col);
        const after = this.lines[this.row].slice(this.col);
        const last = parts.length - 1;
        const endCol = (last === 0 ? before.length : 0) + parts[last].length;
        parts[0] = before + parts[0];
        parts[last] += after;
        this.lines.splice(this.row, 1, ...parts);
        this.row += last;
        this.col = endCol;
    }

    // Break the line at the cursor; auto-indent like the 4-space layout (copy
    // the line's indent, +4 when it ends with an opening bracket).
    splitLine(): void {
        const line = this.lines[this.row];
        const indent = (/^ */.exec(line) ?? [""])[0];
        const prefix = [...this.lines.slice(0, this.row), line.slice(0, this.col)].join("\n");
        const deeper = line.slice(0, this.col).trim() !== "" && (afterOpeningBracket(prefix) || awaitsBody(prefix)) ? "    " : "";
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
            // inverse of the dedent assist: deleting a lone )/]/} that the assist
            // moved to column 0 restores the 4-space continuation indent
            if (this.row > 0 && this.col === 1 && (line === "]" || line === "}" || line === ")")) {
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

    // Left and Right stay on their line, as in Vim (Up and Down change lines).
    left(): void {
        if (this.col > 0) this.col--;
    }

    // The cursor as an offset into the whole chunk, and back.
    offset(): number {
        return this.lines.slice(0, this.row).reduce((n, line) => n + line.length + 1, 0) + this.col;
    }
    place(offset: number): void {
        const before = this.src().slice(0, offset).split("\n");
        this.row = before.length - 1;
        this.col = before[this.row].length;
    }

    // Kills, as fish's: the text goes to the kill ring (Ctrl+Y yanks it), and
    // consecutive kills join into one entry, in the order the text had.
    killed = "";
    killing = false;
    kill(to: number): void {
        const from = this.offset(), src = this.src(), [a, b] = from < to ? [from, to] : [to, from];
        if (a === b) return;
        const text = src.slice(a, b);
        this.killed = !this.killing ? text : to < from ? text + this.killed : this.killed + text;
        this.killing = true;
        this.lines = (src.slice(0, a) + src.slice(b)).split("\n");
        this.place(a);
    }
    yank(): void {
        const at = this.offset(), src = this.src();
        this.lines = (src.slice(0, at) + this.killed + src.slice(at)).split("\n");
        this.place(at + this.killed.length);
    }
    // Fish's word motions: back to a word's start, on past its end.
    backWord(style: Style): number { return moveWord(this.src(), this.offset(), -1, style); }
    forwardWord(style: Style): number { return forwardWordEnd(this.src(), this.offset(), style); }

    right(): void {
        if (this.col < this.lines[this.row].length) this.col++;
    }

    // Trailing whitespace-only lines never reach the parser.
    trimmedSrc(): string {
        return this.src().replace(/(?:\n[ \t]*)+$/, "");
    }

    enter(shift = false): KeyAction {
        const prefix = [...this.lines.slice(0, this.row), this.lines[this.row].slice(0, this.col)].join("\n");
        const continueLine = afterOpeningBracket(prefix) || awaitsBody(prefix) || insideBrackets(prefix, true);
        if (continueLine === shift) return "submit";
        this.splitLine();
        return "cont";
    }

    // Up and Down move a line within the buffer and, from its first or last
    // line, through history: an older entry's last line, a newer one's first,
    // as if the entries were one text. They keep the column, as in Vim
    // (clamped to each line, remembered across shorter lines until another key
    // moves); changing entries puts the cursor at the end of each line, until
    // a move sideways sets a column.
    goal: number | null = null;
    vertical(row: number): KeyAction {
        this.goal ??= this.col;
        this.row = row;
        this.col = Math.min(this.goal, this.lines[row].length);
        return "cont";
    }
    up(): KeyAction {
        if (this.row > 0) return this.vertical(this.row - 1);
        if (this.hist.length === 0) return "cont";
        if (this.histIdx === null) {
            this.draft = this.src();
            this.histIdx = this.hist.length - 1;
        } else if (this.histIdx > 0) this.histIdx--;
        else return "cont";
        this.lines = this.hist[this.histIdx].split("\n");
        this.goal = Infinity;
        return this.vertical(this.lines.length - 1);
    }

    down(): KeyAction {
        if (this.row < this.lines.length - 1) return this.vertical(this.row + 1);
        if (this.histIdx === null) return "cont";
        this.histIdx++;
        if (this.histIdx >= this.hist.length) this.histIdx = null;
        this.lines = (this.histIdx === null ? this.draft : this.hist[this.histIdx]).split("\n");
        this.goal = Infinity;
        return this.vertical(0);
    }

    completionCands(): string[] {
        const s = new Set<string>();
        for (const n of NATIVE_NAMES) s.add(n);
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
            // ESC then a key: that key with Alt (Option), as legacy terminals send it.
            if (e.length === 2 && e[1] !== "[" && e[1] !== "O") {
                this.esc = "";
                return this.key(ch === "\x7f" || ch === "\b" ? "backspace" : ch, ALT);
            }
            const last = e[e.length - 1];
            const done = (e[1] === "O" && e.length >= 3) ||
                (e[1] === "[" && e.length >= 3 && (last === "~" || /[A-Za-z]/.test(last)));
            if (!done) return "cont";
            this.esc = "";
            const key = decodeKey(e[1] === "O" ? e[2] : e.slice(2));
            return key ? this.key(key.name, key.modifiers) : "cont";
        }
        if (ch === "\x1b") { this.esc = "\x1b"; return "cont"; }
        const code = ch.charCodeAt(0);
        // Control bytes are their letter with Ctrl (\x17 is Ctrl+W).
        if (ch === "\r" || ch === "\n") return this.key("enter", 0);
        if (ch === "\t") return this.key("tab", 0);
        if (ch === "\x7f") return this.key("backspace", 0);
        if (code < 32) return this.key(String.fromCharCode(code + 96), CTRL);
        this.killing = false;
        this.goal = null;
        this.insertText(ch);
        return "cont";
    }

    // A key with its modifiers (lock keys already left out), bound as fish binds it.
    key(name: string, modifiers: number): KeyAction {
        const alt = (modifiers & (ALT | SUPER | META)) !== 0, ctrl = (modifiers & CTRL) !== 0, shift = (modifiers & SHIFT) !== 0;
        const wasKilling = this.killing;
        this.killing = false;
        if (name !== "up" && name !== "down") this.goal = null;
        if (ctrl && !alt) switch (name) {
            case "c": return this.ctrlC();
            case "d": return this.ctrlD();
            case "l": return this.ctrlL();
            case "a": this.col = 0; return "cont";
            case "e": this.col = this.lines[this.row].length; return "cont";
            case "b": this.left(); return "cont";
            case "f": this.right(); return "cont";
            case "y": this.yank(); return "cont";
            case "j": case "m": return this.enter();
            case "i": return this.tab();
            case "h": this.backspace(); return "cont";
        }
        // Kills (fish's ctrl-u, ctrl-k, ctrl-w, alt-backspace, alt-d).
        this.killing = wasKilling;
        if (ctrl && !alt && name === "u") { this.kill(Math.max(0, this.offset() - (this.col || 1))); return "cont"; }
        if (ctrl && !alt && name === "k") {
            const rest = this.lines[this.row].length - this.col;
            this.kill(this.offset() + (rest || (this.row < this.lines.length - 1 ? 1 : 0)));
            return "cont";
        }
        if (ctrl && !alt && name === "w") { this.kill(this.backWord("pathComponents")); return "cont"; }
        if (alt && (name === "backspace" || ctrl && name === "h")) { this.kill(this.backWord("punctuation")); return "cont"; }
        if (ctrl && name === "backspace") { this.kill(this.backWord("whitespace")); return "cont"; }
        if (alt && (name === "d" || name === "delete")) { this.kill(this.forwardWord("punctuation")); return "cont"; }
        if (ctrl && name === "delete") { this.kill(this.forwardWord("whitespace")); return "cont"; }
        this.killing = false;
        switch (name) {
            case "enter": return this.enter(shift);
            case "tab": return this.tab();
            case "backspace": this.backspace(); return "cont";
            case "delete": this.deleteFwd(); return "cont";
            case "up": return this.up();
            case "down": return this.down();
            case "home": this.col = 0; return "cont";
            case "end": this.col = this.lines[this.row].length; return "cont";
            case "paste": this.pastePending = true; return "cont"; // bracketed paste start
        }
        // Option+Left/Right and Alt+B/F by word, Shift or Ctrl by
        // whitespace-separated word, plain arrows by character.
        const style: Style | undefined = alt ? "punctuation" : shift || ctrl ? "whitespace" : undefined;
        if (name === "left" || alt && name === "b") { if (style) this.place(this.backWord(style)); else this.left(); return "cont"; }
        if (name === "right" || alt && name === "f") { if (style) this.place(this.forwardWord(style)); else this.right(); return "cont"; }
        return "cont";
    }

    // Read one chunk until a submit key action. null = user quit.
    // Keys typed ahead (a read batch extending past the Enter that submits)
    // are kept in pendingKeys and replayed into the NEXT chunk.
    // Bracketed paste (the terminal wraps pastes in ESC[200~ ... ESC[201~)
    // inserts its text verbatim without running it.
    pendingKeys = "";
    pastePending = false;

    readChunk(): string | null {
        this.lines = [""]; this.row = 0; this.col = 0;
        this.histIdx = null; this.goal = null; this.esc = ""; this.tabPrefix = ""; this.visRow = 0;
        this.render();
        const buf = new Uint8Array(4096);
        const dec = new TextDecoder();
        let queue = this.pendingKeys;
        this.pendingKeys = "";
        let stash = ""; // a paste whose end marker has not arrived yet
        while (true) {
            if (queue === "") {
                const n = Deno.stdin.readSync(buf);
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
                this.insertPaste(queue.slice(6, e));
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
                this.render(true);
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
// The REPL runs synchronously (repl runs inside an evaluation), so it waits
// for the worker's listener on the flag's third slot.
function startInterruptWatcher(): { worker: Worker; flag: Int32Array } {
    const src = `self.onmessage = (e) => {
        const flag = new Int32Array(e.data);
        Deno.addSignalListener("SIGINT", () => {
            Atomics.load(flag, 1);
            Atomics.store(flag, 0, 1);
            Atomics.store(flag, 1, 888);
        });
        Atomics.store(flag, 2, 1);
        Atomics.notify(flag, 2);
    };`;
    const worker = new Worker(`data:application/javascript,${encodeURIComponent(src)}`, {
        type: "module",
        name: "apn-sigint",
    });
    const flag = new Int32Array(new SharedArrayBuffer(12));
    worker.postMessage(flag.buffer);
    if (Atomics.wait(flag, 2, 0, 5000) === "timed-out") {
        worker.terminate();
        throw new Error("the Ctrl+C watcher did not start");
    }
    return { worker, flag };
}

// stty helpers: capture the cooked termios once, restore it around each
// evaluation so Ctrl+C raises a real SIGINT (needs --allow-run).
function ttyCookedSettings(): string {
    const p = new Deno.Command("stty", { args: ["-g"], stdin: "inherit", stdout: "piped", stderr: "null" });
    return new TextDecoder().decode(p.outputSync().stdout).trim();
}

function setTtyCooked(saved: string): void {
    new Deno.Command("stty", { args: [saved], stdin: "inherit", stdout: "null", stderr: "null" }).outputSync();
}

// The editor of the session running now: a session repl opens inside it
// shares its terminal setup and takes the keys typed ahead.
let activeEditor: ReplEditor | undefined;

function replTTY(interp: Interpreter): void {
    const hist = loadHistory();
    const ed = new ReplEditor(interp, hist);
    const outer = activeEditor;
    if (outer) { ed.pendingKeys = outer.pendingKeys; outer.pendingKeys = ""; }
    activeEditor = ed;
    const watch = outer ? undefined : startInterruptWatcher();
    if (watch) setInterruptFlag(watch.flag);

    // Route console.log (used by the print/debug natives) through the editor
    // so output is newline-correct while the terminal is raw.
    const origLog = console.log.bind(console);
    console.log = (...args: unknown[]) => {
        ed.print(args.map((x) => typeof x === "string" ? x : String(x)).join(" "));
    };

    const savedCooked = ttyCookedSettings();
    Deno.stdin.setRaw(true);
    ed.emit("\x1b[>1u"); // request distinct modified keys (Kitty keyboard protocol)
    if (!outer) ed.emit("\x1b[?2004h"); // ask the terminal to wrap pastes in ESC[200~..ESC[201~
    try {
        while (true) {
            const src = ed.readChunk();
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
            ed.emit("\x1b[<u"); // cooked evaluation needs ordinary Ctrl+C, not enhanced key bytes
            setTtyCooked(savedCooked);
            try {
                const val = runSourceValue(src, interp, lastIsBinding(src) || lastIsPrintCall(src));
                if (val !== null) {
                    renderColored(interp, val, (x) => ed.emit(x));
                    ed.emit("\n");
                }
            } catch (err) {
                if (err instanceof APNError && err.message === "interrupted") {
                    ed.print(paint(A.dim, "Interrupted."));
                } else {
                    ed.print(formatError(err, true));
                }
            } finally {
                Deno.stdin.setRaw(true);
                ed.emit("\x1b[>1u");
            }
        }
    } finally {
        if (watch) { setInterruptFlag(null); watch.worker.terminate(); }
        ed.emit("\x1b[<u");
        if (!outer) ed.emit("\x1b[?2004l");
        else outer.pendingKeys = ed.pendingKeys;
        activeEditor = outer;
        console.log = origLog;
        Deno.stdin.setRaw(false);
    }
}

// ---- piped REPL (stdin not a TTY): plain line loop, no editor/colors ----

// Lines read from stdin and not used yet, shared so that a session repl opens
// takes the lines after the one that opened it.
const piped = { lines: [] as string[], rest: "", decoder: new TextDecoder() };
function pipedLine(): string | null {
    const buf = new Uint8Array(1024);
    while (!piped.lines.length) {
        const n = Deno.stdin.readSync(buf);
        if (n === null) {
            if (!piped.rest) return null;
            piped.lines.push(piped.rest);
            piped.rest = "";
            break;
        }
        const lines = (piped.rest + piped.decoder.decode(buf.subarray(0, n), { stream: true })).split("\n");
        piped.rest = lines.pop()!;
        piped.lines.push(...lines);
    }
    return piped.lines.shift()!;
}

function replPiped(interp: Interpreter): void {
    const write = (text: string) => Deno.stdout.writeSync(ENC.encode(text));
    const prompt = ">>> ";
    let pending = "";
    write(prompt);
    for (let line = pipedLine(); line !== null; line = pipedLine()) {
        line = line.trimEnd();
        if (line.length === 0) {
            write(prompt);
            continue;
        }
        if (line === ":quit" || line === ":q") {
            console.log("bye");
            return;
        }
        if (line === ":help" || line === ":h") {
            console.log(helpText());
            write(prompt);
            continue;
        }
        pending = pending ? pending + "\n" + line : line;
        // Try to evaluate; if the parse error indicates an incomplete block
        // (missing `in`, `->`, or a structural `newline`), keep accumulating so
        // users can enter multi-line constructs. Otherwise report the error.
        try {
            const val = runSourceValue(pending, interp, lastIsBinding(pending) || lastIsPrintCall(pending));
            if (val !== null) interp.printValue(val, true, false);
        } catch (err) {
            if (isIncompleteError((err as Error).message)) {
                write("... ");
                continue;
            }
            console.log(formatError(err, false));
        }
        pending = "";
        write(prompt);
    }
    write("\n");
}

// A REPL session on the interpreter's scope: the editor on a terminal, a
// plain line loop otherwise. It returns when the input ends or on :quit.
function session(interp: Interpreter): void {
    if (Deno.stdin.isTerminal()) replTTY(interp);
    else replPiped(interp);
}

// An interpreter for running programs from the command line: echo colors on a
// terminal, and repl opens a session (see Interpreter.session).
export function commandLineInterpreter(): Interpreter {
    const interp = new Interpreter();
    interp.enableChecking();
    if (Deno.stdout.isTerminal()) interp.paint = colored;
    interp.interactive = () => session(interp);
    return interp;
}

export function repl(): void {
    console.log(`APN interpreter v${VERSION}`);
    console.log("Applicative Polish Notation — lazy, statically checked with inference and Dynamic boundaries.");
    if (Deno.stdin.isTerminal()) console.log(":help :quit  |  Up/Down history  |  Tab complete/indent  |  Ctrl+C/D quit");
    else console.log("Commands: :help :quit\n");
    session(commandLineInterpreter());
}

