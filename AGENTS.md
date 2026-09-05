# AGENTS.md

## PROJECT RULES — READ FIRST

1. **The workflow is mandatory.** For ANY change (add, change, or remove a
   feature), you MUST:
   1. Edit `main.ts` to implement the change.
   2. Update `features.txt` so it demonstrates the new/updated behavior
      (this file is the living spec AND the smoke test).
   3. Type-check and run the full showcase:
          deno check main.ts
          deno run --allow-read main.ts features.txt
   4. Confirm output matches expectations before declaring done.
   Do not end a task without completing all steps. Never leave `features.txt`
   out of date.
2. **Keep it green.** If a change breaks any existing feature, fix it before
   finishing. Do not leave the project in a broken state.
3. **Keep the file layout minimal.** `main.ts`, `features.txt`, `AGENTS.md` in
   the project root only — no `src/`, no package.json, no new dependencies.

## Project

Sloth (`sloth/`) is a lazy, Haskell-like, dynamically-typed (JS-like) scripting
language implemented as a single-file Deno/TypeScript interpreter. It runs from
the command line and has a REPL.

Three files only, all project root:
- `main.ts` — the entire interpreter (lexer, parser, evaluator, REPL)
- `features.txt` — the living spec + smoke test: a runnable showcase of EVERY
  feature. It must always stay in sync with what `main.ts` actually supports.
  (There are no real unit tests — this file IS the test.)
- `core.txt` — the standard library, imported with `load "core.txt"`. Defines
  things like `halt = exit 0` (`sq x = x * x` is there as a demo function).
- `AGENTS.md` — this file

## Run / verify

Deno required. From `sloth/`:
- Run the showcase (use this as the smoke test after any change):
    deno run --allow-read main.ts features.txt
- Start the REPL:               deno run --allow-read --allow-write --allow-env=HOME main.ts
  (the extra flags persist history in ~/.sloth_history; the REPL also runs
  with just --allow-read — history then stays in-session only)
- Type-check (always run after edits):
    deno check main.ts

There is NO `package.json`, no dependencies, no test framework, no `src/`.

## Architecture (all in main.ts, top to bottom)

- `Type` / `Value` — runtime values are tagged objects: int, float, bool,
  string, char, unit, list, lazyList, record, variant, closure, clauseFn,
  native, plus `thunk` — the LAZY wrapper for 0-arg value defs (see below;
  internal `nomatch` sentinel is used by multi-clause fallthrough).
- `Env` — lexical scope chain (mutable parent-linked maps). Free variables
  resolve at definition site (static/lexical scoping), but bindings are shared
  by reference (JS-like, not immutable).
- `Expr` / `Pattern` / `TopLevel` — AST.
- Lexer → Parser → Interpreter (`eval`, `evalBinop`, `apply`, `callNative`,
  `matchPattern`).
- `ReplEditor` — the interactive REPL's raw-mode line editor (history,
  completion, colors), plus the piped-stdin fallback loop.

## Core language semantics (don't break these)

- **Lazy lists**: a list literal evaluates to a `lazyList` (unevaluated
  elements + captured env), resolved only when forced. `[x, y, z]` is ALWAYS a
  list — bare identifiers resolve to the variables' values when forced. A list
  is never an object; an OBJECT is a record literal (`[k: v, ...]`).
  `force()` is the single entry point for turning a `lazyList` into a concrete
  list value; it recurses into nested lists/records/variants. Only invoke it
  when a list is actually needed.
- **Indexing**: applying a LIST to an int indexes it — `nums 0` is the first
  element, `nums (-1)` the last (negative counts from the end; the parens are
  needed because `nums -1` is a subtraction). Applying a list to a LIST of
  ints picks several elements: `nums [0, 2]` → `[10, 30]`. The callee's kind
  decides: list → index, record → clone (see below), else error.
  - `force()` is the single entry point for turning a `lazyList` into a concrete
    value; it recurses into nested lists/records/variants. Only invoke it when a
    list is actually needed.
- **No tuples.** `(a, b)` is invalid — parens are only for grouping/calls.
  Mixed values go in lists: `[213, "hello"]`.
- **Groups / blocks — `( )` and `{ }` are interchangeable.** Both are a
  statement sequence whose VALUE is the last statement's value; empty (`()`,
  `{}`) is unit. So `(4 * 3)` and `{4 * 3}` both equal 12, and a multi-line
  `{ }` can be used as a function body. A `{` at end of line REQUIRES its body
  on a following line indented exactly +4 (else parse error).
  Statements inside a block separate on `;` or same-level newlines; local
  definitions (`x = 40`) are allowed inside blocks and are scoped to the block
  (implemented via `{ t: "block" }` + `{ t: "stmDef" }` AST nodes — eval creates
  a child `Env`; `stmDef` binds into it).
- **Layout is strict 4-space (whole language).** Every nested level is exactly
  +4 spaces, and only +4: the lexer rejects +2, +8, or any non-multiple of 4.
  Blank and comment-only lines are ignored for layout. Only `(` suppresses
  newlines. `{` participates in the layout (brace blocks), and so does `[`:
  a list literal's elements are separated by `,` OR a newline (commas are
  optional when each element is on its own line), and a nested list/multi-line
  record works the same way. `[1 2]` on ONE line is still a single element
  (the application `1 2`); writing them on separate lines makes two elements.
- **Newlines are implicit semicolons; an explicit `;` also works.** A newline
  at the SAME indentation ends the current expression/statement; an INDENTED
  (+4) continuation line extends it (parsers `skipContinuation`). This makes
  whitespace significant:
      func = { 1 + 1 }        # body on the same line  -> func == 2
      func =
          match x [...]      # body continues on +4   -> the match expr
      func =
      { 1 + 1 }               # == `func = ; { ... }`: func == unit (RHS cut
                              #   off by a same-level newline) and the { } is
                              #   a separate standalone block statement.
  A def body that ends at a same-level newline (or an explicit `;` right after
  `=`) binds UNIT (see `parseDefBody`).
- **Records**: `[name: "Alice", age: 30]`, accessed with `rec.field` (chaining
  works: `a.b.c`). Keys may be quoted strings or numbers (`["my field": 1]`,
  `[123: 2]`), accessed the same way (`obj."my field"`, `obj.123`); a
  parenthesized expression is a DYNAMIC key (`obj.(key)` → the value of `key`).
  `enumerate list` builds a record with int keys (`[0: 10, 1: 20, 2: 30]`).
  The old `{ a = b }` syntax is REMOVED.
- **Prototype-based objects**: APPLYING a record (`vector3 [1, 2, 3]`) CLONES
  a record prototype (the prototype is a RECORD — a bare-name list is a list,
  never an object). A LIST argument replaces values positionally (one value per
  field; field count must match, else error); a RECORD argument overrides by
  name in any order — existing fields replaced, new fields appended, so
  `vector3 [z: 3, x: 1]` keeps the prototype's other defaults (→
  `[x: 1, y: 0, z: 3]`) and `vector3 [x: 1, y: 2, z: 3, a: 0]` adds `a`. An INT
  argument indexes positionally → the pair `[field, value]` (`vec 1` →
  `["y", 0]`). The prototype name must be lowercase (capital names are
  constructors).
- **Pluck — the QUOTED `.[...]` postfix** (record access -style, so even a
  bare-name list inside it is treated as field names, never values):
  `rec.[x, y]` gathers those fields' values into a LIST; `rec.[x: a, y: b]`
  keeps the fields under NEW keys (a smaller record). Mixing bare entries and
  `key: name` pairs in one pluck is a parse error. The same `[key: name]`
  shape is also a DESTRUCTURING PATTERN (see Bindings).
- **Ternary, not if/then/else**: `cond ? a : b` (right-associative). Keywords
  `if`, `then`, `else` are removed.
- **Functions**: two styles, partial application, recursion. `fn` is removed.
  - lambda: `double = x -> x * 2`, multi-param `add = a b -> a + b`
  - Haskell-style: `func x = x + x`, `add a b = a + b` — params go on the left
    of `=` and desugar to nested lambdas. Detected via lookahead (`isDef`),
    which scans params + optional `: Type` then requires `=`. Safe alongside
    top-level application expressions (`[1, 2, 3] $ head $ print`) because
    those lack `=`.
- **Pattern definitions**: params may be full patterns, and a function may be
  given as multiple equations (clauses) like Haskell, dispatched in order:
      len [] = 0
      len (x:rest) = 1 + len rest
  Consecutive same-name defs with params of equal arity are merged by
  `groupClauses` into one `clauseFn` value. See `evalDef` / `apply`:
  `clauseFn` accumulates applied args (supporting partial application), forces
  them, then tries each clause's patterns via `matchPattern`; no clause matches
  → "Runtime: non-exhaustive function definition". Guards on def clauses are
  NOT supported (use `match x [ ... | ... ]` inside the body for guards).
- **`match` expressions**: `match scrutinee [ pattern -> expr, ... ]` is THE
  pattern-matching form — there is NO `case` (the `case`/`of` keywords were
  removed and freed up as identifiers). Alternatives share the `{ t: "match" }`
  AST; each may carry a `|` guard, evaluation is `evalMatch`. The `[` ends the
  scrutinee, so alternatives separate on `,` or a newline, and ALL layouts
  work:
      fact n = match n [0 -> 1, _ -> n * fact (n - 1)]      # single line
      fact n = match n [                                    # same-line open
          0 -> 1
          _ -> n * fact (n - 1)
      ]
      fact n =                                               # block layout
          match n [
              0 -> 1
              _ -> n * fact (n - 1)
          ]
  A `match` scrutinee may not apply a `[...]` argument directly — parenthesize
  it (`match (head xs) [0 -> ..., _ -> ...]`).
- **`[x, y]` pattern matches both lists and records**: in `matchPattern`, a
  var-only list pattern against a record binds each variable to the field of
  the same name (like record destructuring); against a list it binds
  positionally (existing behavior). A KEYED record pattern `[x: a, y: b]`
  (Rust-style) extracts fields under NEW names from a record only — usable as
  a binding LHS, a function-param or match-alternative pattern; against a list
  it never matches. Bare and keyed entries can't mix in one pattern.
- **Pattern-lambdas**: a lambda's FIRST param may be a destructuring pattern
  (and only that — no literal `_`/`0 ->` lambdas, to keep guards like
  `x | x < 0 -> ...` unambiguous):
      for ([f, v] -> print (format "%: %" [f, v])) person   # record → [field, value]
      map ([a, b] -> a + b) [[1, 2], [3, 4]]                # list → positional
      x -> ...                                               # plain name params as before
  `startsLambdaPattern` limits the guess to `[ ... ]` and `(Ctor ...)`; the
  speculative parse falls back to a normal expression when no `->` follows.
- **Pipes & operators**:
  - `x $ f` feeds `x` into `f` (value-left pipe, replaces the old `|>`). No
    composition operator. The `.` postfix is record access and the QUOTED
    pluck only (`rec.field`, `rec.(dynKey)`, `rec.[x, y]` pluck); indexing and
    cloning happen by APPLICATION (`nums 0`, `vector3 [1, 2, 3]`).
  - **Idiom (DELIBERATE, DO NOT FLIP TO HASKELL `$`)**: the pipe is value-left
    on purpose. `negate 5 $ print` reads left-to-right and is the intended
    style; Haskell's right-associative `print $ negate 5` is *not* supported
    and would be a runtime error under this semantics. Use normal application
    for args and the pipe only for the final feed.
  - Backtick infix: ``a `f` b`` == `f a b` (between ternary and compare, left).
    **Exception: `\`for\`` inverts** so the sequence sits on the left:
    ``seq `for` fn`` == `seq $ for fn` == `for fn seq`. This is a parser-level
    inversion only — the `for` native stays strict fn-first (see below).
  - Operator sections: `(+ 2)` = `\x -> x + 2`, `(2 +)` = `\x -> 2 + x` for
    `+ - * / % == != < > <= >= ++`. `(-2)` stays unary negation (no whitespace
    info in the lexer); `(+)` alone is unsupported — use a lambda.
- **Iteration**: `for` is a native with the **same argument positioning as
  `map`**: `for : fn -> seq -> unit`, strictly fn-first and NOT order-flexible.
  A list iterates per element; a record per entry as `[field, value]`.
  Exactly like `map`, the pipe feeds the collection in last:
  `for (x -> ...) [1, 2, 3]` == `[1, 2, 3] $ for (x -> ...)`. The backtick
  spelling ``[1, 2, 3] `for` (x -> ...)`` also works (it inverts in the parser).
  Any other backtick (`myApp`, `map`, …) stays `f a b`, so putting a collection
  in the fn slot errors.
  Related natives: `pairs rec` (record → list of `[field, value]`), and
  `format "% %" [a, b]` (`%` = printf-style arg, strings unquoted; `%%` = `%`).
- **Termination**: `exit n` (native, n int) ends the whole process with status
  `n`, callable from ANYWHERE — top level, inside `{ }` blocks, lambdas,
  `for`/`map` callbacks, etc. implemented via an unconditional `Deno.exit`.
  `halt` is NOT a builtin — it is defined in core.txt as `halt = exit 0`
  (see *Lazy 0-arg defs* below), so importing core.txt doesn't exit; `halt`
  fires only when actually used (bare statement, `core.halt`, last line of a
  block, …).
- **`load "file"`** imports a file RELATIVE TO THE CURRENT FILE
  (`Interpreter.sourceDir`, set per run; REPL defaults to cwd). Two effects:
  (1) as a STATEMENT it merges the file's own definitions into the current
  scope (an `include` — inside a `{ }` block that merge stays scoped to the
  block); (2) as a VALUE it returns them as a `module` record, so
  `core = load "core.txt"; core.sq 4` is namespaced access. Implemented as a
  native: reads the file, `run`s it in a fresh child `Env`, then copies the
  loaded env's OWN entries into the caller env and returns them as a record.
- **Lazy 0-arg defs (thunks)**: a value def with NO params and NOT a lambda —
  `x = <expr>`, `r = [a, b]`, `core = load "..."` — is bound lazily: `evalDef`
  stores a `{ kind: "thunk" }` and `<expr>` evaluates (and caches) the FIRST
  time `x` is FORCED. `force()` is the single entry point and also recurses
  into lists/records/variants; `run()` forces each top-level expr statement's
  result, and a block forces its last statement's value — so a bare `halt`
  at top level or as a block's last line does fire. **File mode also forces
  the FINAL top-level value, so a TRAILING 0-arg def's block runs at the end
  of the file** (mid-file defs stay latent until used; `halt` after them
  exits before any of that). `recordAccess` and
  `pluck` use `unpackThunk` instead (evaluate the body but keep
  the result lazy — needed so `core.halt` doesn't force the whole module).
  `force(record)` deliberately leaves thunk FIELD values unforced (a `load`
  module may contain `halt`).
- **Output & conversion (DELIBERATE split)**:
  - `print s` — STRING ONLY; outputs the raw text (no quotes); anything else
    errors. It is for clean text output.
  - `toString x` — any value → string representation (strings come back
    *quoted*: `toString "hi"` = the string `"hi"`, i.e. `print (toString "hi")`
    renders `"hi"`). Use it when you need a string (to concatenate or print).
  - `parse s` — the inverse of `toString` for literals: `"42"` (int),
    `"3.5"` (float), `"true"`/`"false"` (bool), else a runtime error.
  - `debug x` — prints any value's representation (this is the OLD `print`
    behavior); for inspection/diagnostics.
  The showcase (`features.txt`) uses `debug` everywhere a value is being
  inspected and `print` only where the value is a string.
- **Variants** via `data Maybe a = Just a | Nothing`; constructors and match
  expressions. Nullary constructors are bare values; arity>0 constructors are
  curried natives tagged with the constructor name.
- **Bindings** — `symbol = value` is the ONLY form (no `let`, no mutation).
  It works at top level and inside `{ }` / `( )` blocks, where it is scoped to
  that block. The LHS may be a destructuring PATTERN: `[a, b] = expr` (list
  positionally, record by field name), `(Just x) = expr`, or `Just x = expr`
  (Haskell-style, no parens) — a binding error if the pattern doesn't match.
  Capital names are CONSTRUCTORS, never value/function names: a capital LHS
  def is a parse error unless it's a DECLARED constructor applied to args
  (`Just v = ...` destructures). A bare capital LHS is always an error —
  `Template = [count, label]` is invalid; use lowercase defs and build records
  with values (or clone from a record prototype with application — section 7). Optional
  (ignored) `: Type` annotations accepted. A block's value is its last
  statement. `match` with guards `|`.

## Evaluator notes

- In file mode, expressions evaluate for their effects but do NOT auto-print
  (assignments like `r = [...]` are silent, and a bare `pairs rec` statement
  prints nothing) — every demo line in `features.txt` uses an explicit `print`.
  In the REPL, unassigned expression results are echoed.

## Parser quirks (known, pre-existing)

- `&&` / `||` are NOT wired into the parser (they appear in `evalBinop` but don't
  parse). Use comparisons/ternaries instead.
- `` ` : ` `` cons is only a pattern operator (`x:rest`), not an expression
  operator.
- `match x [ ... ]` is a self-delimiting bracket form: it consumes its own `[ ]`
  (newlines/indents/dedents inside), independent of the block/semicolon rules
  above, and needs no hard-stop flag for the enclosing application (the `]`
  already ends everything).
- Inside `{ }`, block statements are at one flat level (nested constructs like
  `match` may deepen it); an `indent` token directly before a statement, or a
  `,`-tuple in `( )`, are rejected with a clear error.

## The REPL

Two modes, picked automatically: a **TTY** stdin gets the raw-mode line editor
(`ReplEditor`); a **piped** stdin (`... | deno run main.ts`) gets the plain
line loop — no colors, no editor, same chunk semantics. Interactive features:

- **History**: Up/Down walk submitted chunks. In a single-line buffer the
  arrows navigate history; in a multi-line buffer (continuation or a recalled
  multi-line entry) they move between lines instead. Persisted across
  sessions in `~/.sloth_history` (one JSON string per line, capped at 500 on
  load; needs `--allow-write` and `--allow-env=HOME`, else in-session only
  with a one-time hint).
- **Tab**: completes the word before the cursor from bound names (env walk),
  natives (`NATIVES` — same table that registers them), `match`/`data`, and
  `:commands`. One match completes; several extend the common prefix and a
  second Tab lists them. With no word (or no candidates) Tab inserts
  **4 spaces** — the indent unit; Backspace behind a full indent level
  deletes all 4 at once. Typing `}`/`]` on an indent-only line dedents one
  level first.
- **Chunks, not lines (Python-style prompts)**: `>>> ` opens a chunk, `... `
  marks continuation lines. Enter submits only when the chunk parses
  (`chunkComplete`: parse success, or an error that is neither EOF-shaped nor
  an unbalanced-bracket case → real error, shown in red). Incomplete input
  continues on the next line; a blank line is just spacing (it never forces
  a run — the completeness oracle makes Python's blank-line rule
  unnecessary; Ctrl+C bails). Enter mid-buffer splits the line. Auto-indent
  copies the current line's indent, +4 after `{`/`[`. Typing `}`/`]` on an
  indent-only line dedents one level first. Trailing blank lines are trimmed
  before running. Keys typed past a submit are queued and replayed into the
  next chunk (type-ahead).
- **Paste**: bracketed paste mode is enabled (`ESC[?2004h`), so pasted
  multi-line text is inserted verbatim, never auto-run; Enter then runs it.
- **Colors**: input is highlighted as typed (comments dim, strings/chars
  green, numbers yellow, `match`/`data`/bools magenta, natives blue, capital
  idents cyan); echoed values are colored by kind (node-style); errors red.
- **Keys**: Ctrl+C clear input (empty buffer = quit), Ctrl+D quit,
  Ctrl+L clear screen, Ctrl+A/E home/end, Ctrl+U/K kill to line start/end,
  Ctrl+W delete word back, arrows + Home/End/Delete.
- While the terminal is raw, `print`/`debug` output is routed through the
  editor so newlines are CRLF-correct (`console.log` is patched in TTY mode).
- `:help`/`:h` and `:quit`/`:q` work in both modes (`helpText()`).

## Conventions

- Untyped TypeScript; `Value` is a discriminated union. When adding a new kind,
  update `valueToString`, `eval`, and any `force`/pattern/`==` switches — they
  are exhaustive.
- Keep edits consolidated in `main.ts`; keep the minimal four-file layout (no new deps,
  no `src/`).
- Reflect new syntax in `features.txt` and in the REPL `:help` block.
- **Style — whole-function `match`**: when a function's ENTIRE body is a single
  `match`, write the same-line-open form (`f x = match x [ ... ]`), not the
  block form (`f x =\n  match x [ ... ]`). Examples in `features.txt` follow
  this. The block and fully single-line layouts still parse; only the
  single-line form is also shown (alongside the preferred one) in the 4b
  layout section.
- **Style — `{ }` on the right of `=`**: prefer the same-line-open form
  (`func = {` with the body on the following lines indented exactly +4 and the
  closing `}` at the start column) over the block form (`func =\n    { ... }`).
  Both parse; the user's default is the same-line-open one, e.g.:
      seqOf = {
          debug "one"

          6 * 7
      }
- **Commit after every task.** The user has asked that commits happen
  automatically. After each completed task (workflow green, see above), stage
  the files and commit with a concise, repo-style message:
      git add main.ts features.txt core.txt AGENTS.md
      git commit -m "short summary of the change"
  Don't commit secrets; there are none.
