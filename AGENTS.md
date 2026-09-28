# AGENTS.md

## PROJECT RULES — READ FIRST

1. **The workflow is mandatory.** For ANY change (add, change, or remove a
   feature), you MUST:
   1. Edit the relevant `src/` module (or `main.ts` for entry-point changes).
   2. Update `examples/features.apn` so it demonstrates the new/updated behavior
      (this file is the living spec AND the smoke test).
   3. Type-check and run the full showcase:
          deno check main.ts
          deno test --allow-read tests/*-test.ts
          deno run --allow-read main.ts examples/features.apn
   4. Confirm output matches expectations before declaring done.
   Do not end a task without completing all steps. Never leave `examples/features.apn`
   out of date.
2. **Keep it green.** If a change breaks any existing feature, fix it before
   finishing. Do not leave the project in a broken state.
3. **Layout:** `main.ts`, `apn`, `readme.md`, and `AGENTS.md` stay in the root.
   Use `src/` for the interpreter, `lib/` for the standard library, `examples/`
   for runnable examples, `tests/` for regression assertions, `docs/` for
   documentation. Personal scratch programs live outside the repository. No deps.

## Project

APN — **A**pplicative **P**olish **N**otation — is a lazy, Haskell-like,
dynamically-typed (JS-like) scripting language implemented as a Deno/
TypeScript interpreter. It runs from the command line and has a REPL.

Layout:
- `main.ts` — thin entry point: shebang, imports, the `import.meta.main`
  dispatch; re-exports `parse`/`lex` for ad-hoc tooling
- `src/types.ts` — `Value`, `Env`, `mk*`, `valueToString` (the runtime world)
- `src/ast.ts` — `Expr`/`Pattern`/`TopLevel`/`Alt`/`DefClause` type shapes
- `src/numbers.ts` — exact rationals, complex arithmetic, conversions and numeric natives
- `src/errors.ts` — `APNError` (kinds parse/lex/runtime), `didYouMean`,
  `tokLen`, `editDistance`
- `src/lexer.ts` — `Token`, `KEYWORDS`, `SYMBOLS`, `lex`
- `src/parser.ts` — `Parser`, `parse`, `groupClauses`, `declaredCtors`
- `src/interp.ts` — `NATIVES`, `Interpreter` (eval/apply/demand/runStmt),
  `checkInterrupt` + the interrupt flag, `envNames`, `dirname`
- `src/repl.ts` — REPL editor, colors, history, errors rendering, drivers
- `apn` — tiny sh launcher (REPL/file runs; no logic)
- `examples/features.apn` — the living spec + smoke test: a runnable showcase of EVERY
  feature. It must always stay in sync with what `main.ts` actually supports.
  Observable evaluation rules are asserted separately in `tests/semantics-test.ts`.
- `lib/std.apn` — standard library entry point, imported with `import "std"`.
  Modules are cached per interpreter; see `docs/standard-library.md`.
  `sq` is defined in `lib/number.apn`; `halt` in `lib/system.apn`.
- `AGENTS.md` — this file
- `readme.md` — quick start and directory guide
- `~/Desktop/test.apn` — user-owned scratch program outside the repository; preserve its edits

- `docs/semantics.md` — authoritative current evaluation rules and limitations
- `tests/semantics-test.ts` — dependency-free Deno evaluation assertions
- `tests/bigint-test.ts` — exact arithmetic, large Fibonacci values, and host boundaries

## Run / verify

Deno required. From `apn/`:
- Run the showcase (use this as the smoke test after any change):
    deno run --allow-read main.ts examples/features.apn
- Start the REPL:               ./apn
  (wrapper script that runs
   `deno run --allow-read --allow-write --allow-env=HOME --allow-run=stty,deno main.ts "$@"` —
   also runs files, e.g. `./apn examples/features.apn`. The extra flags persist
   history in ~/.apn_history; the bare deno command with just --allow-read
   works too — history then stays in-session only)
- Type-check (always run after edits):
    deno check main.ts

Run evaluation assertions: `deno test --allow-read tests/*-test.ts`.
There is no `package.json` and no external dependencies; tests use Deno.test.

## Architecture (implemented in src/ modules)

- `Type` / `Value` — runtime values are tagged objects: int, rational, float, complex, bool,
  string, char, unit, list, lazyList, record, variant, closure, clauseFn,
  native, plus `thunk`, internal computed `deferred` thunks, and lazy `cons`
  cells (see below;
  internal `nomatch` sentinel is used by multi-clause fallthrough).
- `Env` — lexical scope chain (mutable parent-linked maps). Free variables
  resolve at definition site (static/lexical scoping), but bindings are shared
  by reference (JS-like, not immutable).
- `Expr` / `Pattern` / `TopLevel` — AST.
- Lexer → Parser → Interpreter (`eval`, `evalBinop`, `apply`, `callNative`,
  `matchPattern`).
- `APNError` — every user-facing failure (parse/lex/runtime), rendered by
  `formatError` with a caret at the offending token.
- `ReplEditor` — the interactive REPL's raw-mode line editor (history,
  completion, colors), plus the piped-stdin fallback loop.

## Core language semantics (don't break these)

`docs/semantics.md` is authoritative for evaluation and memoization. Deferred values
and arguments share their memoized outer result, including through alias chains.
Actions remain repeatable and run when demanded. Update assertions with any
intentional evaluation change.

- **Numbers**: `src/numbers.ts` owns the Scheme-style numeric tower. Integers
  and reduced rationals are exact (`bigint`); floats are binary64 and inexact;
  complex numbers have real numeric components. Mixed arithmetic is inexact
  only when exact operands can convert without loss; otherwise require explicit inexact conversion.
  `/` preserves exact fractions; `quotient` truncates; `%` is `remainder`.
  Exact division by zero errors; inexact division follows IEEE infinity/NaN.
  Numeric equality/order compare exact finite values without first rounding
  big integers to floats. Non-real complex values cannot be ordered.
  Literals use APN notation: decimal, 0x/0b/0o, decimals and e/E exponents.
  No Scheme # prefixes: # remains a comment. Use `exact`, `inexact`, and
  `makeRectangular` instead. Float rendering retains .0 where needed.
  Indexes and counts require exact integers; never silently round them.
  `mkInt(number)` accepts only safe host counters. Integer ranges remain exact,
  fractional exact ranges use `rationalRange`, mixed ranges use `floatRange`.
- **Lazy lists**: literal elements are thunks; cons cells defer their head and
  tail. `force()` reveals only the outer value and memoizes every traversed
  thunk. It must never recursively force a list. Use `cell()` / `elements()` to
  consume the spine incrementally, and `demand()` for a needed element.
  `x = 1:x` and recursive Fibonacci lists are productive. `x = x` waits indefinitely when demanded and remains interruptible. Failed/interrupted thunks release their busy flags.
  Lists are always lists; an object is a record literal (`[k: v, ...]`).
  `take` and `drop` accept non-negative integer counts; `map`, `filter`,
  `zipWith`, `foldr`, and list append support infinite inputs incrementally.
  Full traversals (length, negative indexing, etc.) need finite inputs to finish.
- **Indexing**: applying a LIST to an int indexes it — `nums 0` is the first
  element, `nums (-1)` the last (negative counts from the end; the parens are
  needed because `nums -1` is a subtraction). List-to-list application is
  TEMPLATE application, not multi-indexing: use `map nums [0, 2]` to pick indexes.
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
  newlines in its own context; nested `{` and `[` restore layout. `{` participates in the layout (brace blocks), and so does `[`:
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
      { 1 + 1 }               # parse error: same-level line cannot supply the body
  Both sides of `=` are required. Empty bodies (including before `;` or a
  closing delimiter) are parse errors. Use `foo = _` for an unfinished value
  or function body: it is deferred and raises "not implemented" when evaluated.
  Use `foo = ()` for an explicit unit value. Pattern `_` remains a wildcard.
  In the REPL, submitting `foo =` alone reports a syntax error immediately;
  a complete pasted indented definition can still span lines.
- **Records**: `[name: "Alice", age: 30]`, accessed with `rec.field` (chaining
  works: `a.b.c`). Every key is a string. `rec "field"` equals `rec.field`;
  `rec."field"` selects a key containing surrounding quote characters.
  `rec.1` equals `rec "1"`, while `rec 1` is positional.
  Dot access quotes field spellings: `rec.-1` selects "-1" and `rec.(x)`
  selects "(x)" without evaluating x. Application accepts computed strings.
  `enumerate list` builds a record with int keys (`[0: 10, 1: 20, 2: 30]`).
  The old `{ a = b }` syntax is REMOVED.
- **Prototype-based objects**: APPLYING a record (`vector3 [1, 2, 3]`) CLONES
  a record prototype (the prototype is a RECORD — a bare-name list is a list,
  never an object). A LIST argument applies slots positionally (nonempty lists require the exact
  field count; [] initializes all defaults); a RECORD argument applies matching slots by
  name in any order — supplied fields transformed, omitted type slots initialized, new fields appended, so
  `vector3 [z: 3, x: 1]` keeps the prototype's other defaults (→
  `[x: 1, y: 0, z: 3]`) and `vector3 [x: 1, y: 2, z: 3, a: 0]` adds `a`. An INT
  argument indexes positionally → the pair `[field, value]` (`vec 1` →
  `["y", 0]`). Ordinary templates use lowercase names; type-only templates may be capitalized aliases.
- **Pluck — the QUOTED `.[...]` postfix** (record access -style, so even a
  bare-name list inside it is treated as field names, never values):
  `rec.[x, y]` gathers those fields' values into a LIST; `rec.[x: a, y: b]`
  keeps the fields under NEW keys (a smaller record). Mixing bare entries and
  `key: name` pairs in one pluck is a parse error. The same `[key: name]`
  shape is also a DESTRUCTURING PATTERN (see Bindings).
- **Record update (field/pluck assignment)**: `vec.x = 10` and
  `vec.[x, y] = [1, 2]` rebind the NAME to a modified COPY — records are
  never mutated in place. The parser desugars the statement to an EAGER
  pattern binding `vec = setFields(vec, entries, rhs)` (`{ t: "setFields" }`:
  reads the old record and the RHS fully first, so
  `vec.[x, y] = vec.[y, x]` swaps). Existing fields keep their position,
  new fields append. Because it is a binding, it is SCOPED like any def —
  inside a `{ }` block it shadows the outer name (the outer record is
  unchanged). An empty list `[]` promotes to a record on first assignment.
  Errors: non-record targets and value-count mismatches.
- **Ternary, not if/then/else**: `cond ? a : b` (right-associative). Keywords
  `if`, `then`, `else` are removed.
- **Functions**: two styles, partial application, recursion. `fn` is removed.
  - lambda: `double = x -> x * 2`, multi-param `add = a b -> a + b`
  - Haskell-style: `func x = x + x`, `add a b = a + b` — params go on the left
    of `=` and desugar to nested lambdas. Detected via lookahead (`isDef`),
    which scans params + optional `: Type` then requires `=`. Safe alongside
    top-level application expressions (`print $ head $ [1, 2, 3]`) because
    those lack `=`.
- **Pattern definitions**: params may be full patterns, and a function may be
  given as multiple equations (clauses) like Haskell, dispatched in order:
      len [] = 0
      len (x:rest) = 1 + len rest
  Consecutive same-name defs with params of equal arity are merged by
  `groupClauses` into one `clauseFn` value. See `evalDef` / `apply`:
  `clauseFn` accumulates applied args (supporting partial application) as
  LAZY thunks; variable/wildcard patterns bind without demand. Other patterns
  demand only the structure they inspect via `matchPattern`; shared thunks
  ensure clause fallthrough does not repeat effects already demanded. No clause matches
  → "no clause of '<name>' matches the given arguments" (the error names the
  function). Guards on def clauses are
  NOT supported (use `match x [ ... | ... ]` inside the body for guards).
- **First-class matching**: `match value alternatives` is an intrinsic function. It accepts a
  lazy list of unary functions, including pattern lambdas with optional guards.
  Only pattern/false-guard failure falls through; runtime errors propagate.
  No match keyword or match AST node is needed; native dispatch iterates lazily.
  Parenthesize computed arguments as with any curried function:
      match (head xs) [0 -> 1, _ -> 2]
      handlers = [Some x -> x, None -> 0]
      match value handlers
- **`[x, y]` pattern matches both lists and records**: in `matchPattern`, a
  var-only list pattern against a record binds each variable to the field of
  the same name (like record destructuring); against a list it binds
  positionally (existing behavior). A KEYED record pattern `[x: a, y: b]`
  (Rust-style) extracts fields under NEW names from a record only — usable as
  a binding LHS, a function-param or match-alternative pattern; against a list
  it never matches. Bare and keyed entries can't mix in one pattern.
- **Pattern lambdas**: all parameters may be patterns (constructors, literals,
  lists, types, wildcards), optionally followed by a `|` Bool guard. They are
  represented by `patternLambda` and evaluate to ordinary `clauseFn` values.
  Failed direct application raises a no-clause error; intrinsic `match` probes without
  running the body and uses the internal nomatch sentinel only for mismatch.

- **Pipes & operators**:
  - `f $ x` applies `f` to `x`, with the lowest precedence and right associativity.
    `f $ g $ x` means `f (g x)`. This replaces the old value-left pipe.
    Composition uses `\`; dot syntax selects record fields or plucks.
  - Backtick infix is removed: backticks outside strings/comments are lexical errors.
    See the precedence table in `docs/semantics.md#operator-precedence-and-associativity`.
  - Operator sections: `(+ 2)` = `\x -> x + 2`, `(2 +)` = `\x -> 2 + x` for
    `+ - * / % == != < > <= >= ++`. `(-2)` stays unary negation (no whitespace
    info in the lexer); a LONE `(op)` is a 2-arg lambda: `add = (+)`.
- **Iteration — `*` is OVERLOADED**: `seq * fn` iterates and RETURNS the
  results list. `for` is REMOVED (no native, no backtick inversion — freed
  as an identifier). The left side decides what iterates: a LIST yields each
  element; a RECORD yields each entry as a `[field, value]` list; an INT n
  runs fn n times with `0..n-1` (a negative n counts `0, -1, ... n+1` —
  `3 * _ -> print "hello"` runs three times). `*` between two numbers is
  still multiplication; the overload triggers on a function right operand.
  Related natives: `pairs rec`, and `format "% %" [a, b]` (`%` = printf-style
  arg, strings unquoted; `%%` = `%`).
- **Ranges**: `[a..b]` inclusive INT range — the implicit step ADAPTS to the
  direction (`[0..-100]` and `[5..3]` descend; an EXPLICIT step pointing the
  wrong way is empty: `[0,1..-100]` = `[]`); bounds are constant arithmetic
  (`[0..50+50]`); `[a,b..c]` gives the STEP (`b-a`); `[a..]` / `[a,b..]` are
  INFINITE — a lazy `range` value that `print`/`emit`/the REPL echo STREAM as
  constructed (Ctrl+C breaks) and `*` iterates lazily. Range PATTERNS:
  `[lo..hi]` match any int in the range, inclusive. `:` also CONSes in
  expressions (`0:[]` → `[0]`, right-associative; parenthesize inside list
  literals so it isn't record syntax). `zipWith fn xs ys` zips pairwise lazily.
  All lazy lists, not just ranges, stream through print/emit and REPL echo;
  Ctrl+C interrupts output and the REPL remains usable.
- **Variants** via `Maybe a = Just a | Nothing`; constructors and match
  expressions. Nullary constructors are bare values; arity>0 constructors are
  curried natives tagged with the constructor name.
- **Bindings** — `symbol = value` is the ONLY form (no `let`, no mutation).
  It works at top level and inside `{ }` / `( )` blocks, where it is scoped to
  that block. The LHS may be a destructuring PATTERN: `[a, b] = expr` (list
  positionally, record by field name), `(Just x) = expr`, or `Just x = expr`
  (Haskell-style, no parens) — a binding error if the pattern doesn't match.
  New capitalized names bind type aliases; existing constructor names on the
  LHS destructure, including nullary assertions. A pipe marks constructor
  declarations; one constructor needs a leading |. Type-only list/record
  templates are valid aliases; ordinary templates keep lowercase names. Optional
  (ignored) `: Type` annotations accepted. A block's value is its last
  statement. `match` with guards `|`.

## Evaluator notes

- In file mode, expressions evaluate for their effects but do NOT auto-print
  (assignments like `r = [...]` are silent, and a bare `pairs rec` statement
  prints nothing; file execution never renders its unused last value) — every demo line in `examples/features.apn` uses an explicit `print`.
  In the REPL, unassigned expression results are echoed, and ASSIGNMENTS are
  SILENT (GHCi `let` parity — `lastIsBinding` gates the echo, so `x = x`
  never hangs the REPL; reference the name to see the value).

## Errors

All user-facing failures are `APNError` — kinds `parse` / `lex` / `runtime` —
rendered by `formatError(err, color)`:

- **Parse/lex errors** point at the offending token: bold red headline, dim
  `--> line L, column C`, the source line with one line of context on each
  side (syntax-highlighted in the TTY REPL), and a green caret spanning the
  token. The lexer stamps every token with `pos`; the parser tracks the last
  token it looked at (`Parser.seen`).
- **Runtime errors** are a headline plus an optional `hint:` — `did you mean
  '...'?` for unbound variables (edit distance over bound names + natives)
  and missing record fields (over the record's fields). The non-exhaustive
  function error names the function. Operator type errors are uniform:
  `cannot apply '+' to list and int`.
- Messages carry no `Parser:`/`Lexer:`/`Runtime:` prefixes — the headline
  category replaces them. `tokenStr` returns BARE token text (the message
  templates add the quotes; the old version double-quoted).
- Unterminated strings/chars are LEX errors now (they used to silently
  swallow the rest of the file); the REPL treats "unterminated" as
  incomplete input, so multi-line strings keep working.
- TTY REPL prints the colored render; piped REPL prints plain; file mode
  prints to stderr (colored when stderr is a tty) and exits 1.

## Parser quirks (known, pre-existing)

- `&&` / `||` are NOT wired into the parser (they appear in `evalBinop` but don't
  parse). Use comparisons/ternaries instead.
- `:` constructs cons expressions and matches cons patterns (`x:rest`).
  Parenthesize cons expressions inside list literals to avoid record syntax.
- `match` follows ordinary application parsing; its alternatives are a list.

- Inside `{ }`, block statements are at one flat level (nested constructs like
  `match` may deepen it); an `indent` token directly before a statement, or a
  `,`-tuple in `( )`, are rejected with a clear error.

## The REPL

Two modes, picked automatically: a **TTY** stdin gets the raw-mode line editor
(`ReplEditor`); a **piped** stdin (`... | deno run main.ts`) gets the plain
line loop — no colors, no editor, same chunk semantics. Interactive features:

- **History**: Up/Down walk submitted chunks. In a single-line buffer the
  arrows navigate history; in a multi-line buffer (continuation or a recalled
  multi-line entry) they move between lines. Up on the first line browses older
  history; Down on the last line browses newer history, restoring the draft
  after the newest entry. Persisted across
  sessions in `~/.apn_history` (one JSON string per line, capped at 500 on
  load; needs `--allow-write` and `--allow-env=HOME`, else in-session only
  with a one-time hint).
- **Tab**: completes the word before the cursor from bound names (env walk),
  natives (`NATIVES` — same table that registers them), `match`, and
  `:commands`. One match completes; several extend the common prefix and a
  second Tab lists them. With no word (or no candidates) Tab inserts
  **4 spaces** — the indent unit; Backspace behind a full indent level
  deletes all 4 at once, and on a blank continuation line it undoes the
  line break (the cursor lands at the end of the line above — the line's
  auto-indent dies with it). Typing `}`/`]` on an indent-only line dedents
  one level first, and deleting a lone `}`/`]` at column 0 of a continuation
  line restores that indent (the assist is symmetric).
- **Enter** submits regardless of syntax validity, except immediately after
  an opening `(`, `{`, or `[` (allowing whitespace), where it inserts an
  indented newline. Enter also continues inside a bracket opened on an earlier
  line, preserving indentation. An unfinished single-line `[1,2,3` submits
  and reports a syntax error.
  Shift+Enter reverses this behavior. Strings and comments do not count as
  brackets. Option+Left/Right navigate words (including across lines).
  Modified Enter requires a terminal that sends a distinct key sequence;
  the editor requests Kitty keyboard disambiguation and also accepts xterm
  modifyOtherKeys Shift+Enter. Auto-indentation still applies to newlines.
- **Paste**: bracketed paste mode is enabled (`ESC[?2004h`), so pasted
  multi-line text is inserted verbatim, never auto-run; Enter then runs it.
- **Colors** (Catppuccin Frappé palette, truecolor): input is highlighted as
  typed (comments overlay0, strings/chars green, numbers yellow,
  bools mauve, natives blue, capital idents sky,
  punctuation overlay1, operators peach); echoed values are colored by kind with
  gray structure (brackets, colons, commas; keys plain, variant tags sky);
  errors red.
- **Keys**: Ctrl+C clear input (empty buffer = quit), Ctrl+D quit,
  Ctrl+L clear screen, Ctrl+A/E home/end, Ctrl+U/K kill to line start/end,
  Ctrl+W delete word back, arrows + Home/End/Delete.
- While the terminal is raw, `print`/`debug` output is routed through the
  editor so newlines are CRLF-correct (`console.log` is patched in TTY mode).
- `:help`/`:h` and `:quit`/`:q` work in both modes (`helpText()`).

## Conventions

- Untyped TypeScript; `Value` is a discriminated union. **Indent: 4 spaces
  per level in .ts files** (no autoformatters — manual style only). When adding a new kind,
  update `valueToString`, `eval`, and any `force`/pattern/`==` switches — they
  are exhaustive.
- Keep edits in the relevant `src/` module; keep `main.ts` a thin entry point.
  Preserve the dependency-free layout.
- Reflect new syntax in `examples/features.apn` and in the REPL `:help` block.
- **Style — whole-function `match`**: when a function's ENTIRE body is a single
  `match`, write the same-line-open form (`f x = match x [ ... ]`), not the
  block form (`f x =\n  match x [ ... ]`). Examples in `examples/features.apn` follow
  this. The block and fully single-line layouts still parse; only the
  single-line form is also shown (alongside the preferred one) in the 4b
  layout section.
- **Required brace layout**: a definition's opening `{` MUST be on the same
  line as `=`. Multiline statements are exactly four spaces deeper than the
  opening line, and `}` aligns with that line. `func = { expr; expr }` is valid.
  `func =` followed by an indented non-brace expression is valid; an indented
  `{ ... }` after `=` is a syntax error.
- **Commit and push after every task.** The user has asked that commits and
  pushes happen automatically. After each completed task (workflow green, see above), stage
  the files and commit with a concise, repo-style message:
      git add <files changed by this task>
      git commit -m "short summary of the change"
      git push
  Always push after committing. If the push fails, resolve it without force-pushing
  or overwriting remote work; report any remaining blocker.
  Don't commit secrets; there are none.


## List index assignment

`arr 0 = 10` rebinds an existing list to a modified copy in the current scope,
like record field assignment. `arr (-1) = 10` updates its final element.
The index may be a variable or a parenthesized expression evaluating to an integer; negative indexes require a finite list.
Positive updates traverse only as far as the selected cell, leaving unused
heads and the remaining tail deferred. Bounds errors leave the binding unchanged.
The RHS is evaluated against the old binding before it is replaced. Consecutive
index assignments execute in order. Inside a block the update shadows the outer
binding. On an unbound name or an existing function, the same syntax remains a
literal-pattern function definition (`f 0 = 10`).


Float ranges promote mixed bounds/steps to floats; all-integer ranges stay exact.
`[0,0.5..100]` has 201 elements. Float-range cells use origin + index * step,
a bounded endpoint tolerance, and a no-progress guard. Float ranges must work
through the same lazy list consumers, indexing, and streaming as integer ranges.

## First-class types and HashMap

`src/type-system.ts` defines numeric constructors, lossless conversions and
arithmetic promotion. Numeric values may carry `typeName`; preserve it for
checked arithmetic and print it except for Int/Float. Bare literals retain their natural numeric
kind and unadorned display. `cast Type value` is defined in lib/type.apn and
loaded alongside the match prelude. Numeric patterns, including generic (t x), expose untyped payloads;
constructors require lossless conversion of both bare and explicitly typed inputs.
Use floor/truncate/inexact before construction when rounding is intended. Internal arithmetic promotion and C ABI conversions
still use strict castNumeric by default. NEVER allow integer wraparound or
imaginary-part loss.
Same fixed-width arithmetic checks overflow. Mixed typed arithmetic tries an
existing broader operand type losslessly, then falls back to the numeric tower.
`Number`, `Real`, `Integer`, `Exact`, `Inexact` are aggregate type guards.
Typed function clauses prefer literal/exact concrete matches, then aggregates,
then lossless constructor conversions (for both bare and typed inputs). Ties retain source order. Untyped clauses retain
source order. Repeated pattern names require equal values.
`n * _ -> typedValue` repeats using the existing function iteration overload.
Numeric operands always multiply: `100 * Int 0` returns `0` (typed Int).
`HashMap` stores immutable association snapshots, with mutable JS Map used only
inside construction of a new snapshot. Keys are scalar immutable values;
numeric keys use exact normalized equality regardless of representation/type.
Association-list values remain lazy. Record arguments retain existing record
construction semantics. `insert`/`remove` return new maps. Iteration order is
insertion order; replacing a key retains its position. Missing lookup errors.


## Metacircular evaluator

`lib/meta.apn` exposes `std/meta`; implementation lives in `lib/meta/`.
The APN parser and evaluator must never delegate object source to host `parse`,
`toAST`, `load`, or an eval callback. Keep the evaluator core within the reader's
supported subset. Run `deno test --allow-read tests/metacircular-test.ts` and
`deno run --allow-read examples/metacircular-self.ts` after changing it.
The latter reads the live evaluator source as text and evaluates it twice in APN.
Document subset limitations in `docs/metacircular-evaluator.md`.

## Browser HTML

`lib/html.apn` and `lib/browser.apn` define the public variants and helpers.
`src/html.ts` decodes views and dispatches APN messages; `src/browser-runtime.ts`
patches the DOM. `src/build-html.ts` bundles the interpreter and source into a
standalone document via `apn --html SOURCE.apn [OUTPUT.html]`.
Check the browser entry with `deno check src/browser-runtime.ts` as well as main.
See `docs/browser-html.md` and `tests/html-test.ts`.

## Mutable references

`Mutable value` allocates a shared cell; `set cell value` returns unit after
replacing its contents. `reference()` preserves cell identity; `demand()` reads
its contents without memoizing that read over the cell. Zero-argument bindings
returning a cell retain it, while argument-taking factory calls allocate afresh.
Evaluate an update's outer value before replacing the cell. Keep alias, scope,
failed-update, and repeated-read assertions in `tests/mutable-test.ts` green.

## p5.js

`lib/p5.apn` defines sketch descriptions. `src/p5.ts` adapts APN callbacks
and primitive arguments to a p5 instance. Browser runtime loads pinned p5.js
only for a P5Sketch. Keep host methods scoped to each interpreter and sketch;
never expose arbitrary host object access. See `docs/p5.md` and `tests/p5-test.ts`.

Function contracts use `((Int -> Int) f)` patterns and `Int -> Int` type values.
They wrap callable arguments and enforce input/output constructors on invocation;
never execute a function to predict its signature. `Transform = Int -> Int`
defines a reusable contract. Legacy colon/:: annotations remain ignored.
See `docs/pattern-functions.md` and `tests/pattern-functions-test.ts`.

## Editor tooling

`src/lint.ts` provides non-evaluating syntax/layout diagnostics. `src/lsp.ts`
serves them over stdio with completion, hover and top-level symbols. Tooling must
use `parseDocument`, which isolates and restores parser declaration registries.
Never evaluate user code to provide editor features. Reserve stdout for JSON-RPC
in `--lsp` mode. Keep UTF-16 positions and byte-counted Content-Length framing.
`editors/neovim/apn.lua` is opt-in/session-only; don't edit user configuration.
See `docs/editor-tooling.md` and `tests/lsp-test.ts`.

## C interop

`src/ffi.ts` implements the opt-in `std/ffi` module and Pointer operations.
Keep ABI signatures fixed-width and conversions lossless; never map unbounded
Int to C int. `withLibrary` must close in finally and reject escaped functions
and pointers after closure. Pointer allocations retain memory and bounds across
aliases, offsets and C pointer round trips. Returned external pointers remain
unsafe; no forged addresses or implicit dereference. Zero-argument C functions
are native actions invoked on demand or as bare statements; () remains optional.
Use `./tests/run-c-interop-tests` in addition to the standard workflow; it compiles
`examples/c-interop/demo.c` and tests real native code. The user authorized
unrestricted --allow-ffi for the local demo and tests; normal APN still requires
an explicit FFI flag. Donut uses lazy map, not eager * iteration, to stop on Ctrl+C.

## Eager result binding

`pattern <- expression` is a statement binding at top level or inside a block.
AST patDef.eager selects reference() before pattern matching: run zero-argument
actions now but preserve Mutable/Pointer references and lazy container fields.
Do not change ordinary = action definitions or lazy destructuring semantics.
getArgs is a nullary native action; the legacy explicit unit call still works.
Tests live in tests/eager-binding-test.ts; document the eager/lazy boundary.

## Record key identity

`src/record-keys.ts` stores ordinary strings without hidden prefixes. Quoted
field syntax includes quote characters in the key. keyText is identity;
keySource escapes quoted-field contents for source rendering. Pairs, iteration,
HashMap conversion and FFI symbol names preserve the full key string.
Literal dot syntax, patterns, plucks and string application share key identity.
On an existing record, `obj "field" = value` updates that exact string key;
quoted characters and NUL have no special lookup/update encoding. Require one
string-valued argument (literal, variable or parenthesized expression), preserve scope and demand RHS before rebinding.
Tests: tests/record-keys-test.ts and tests/record-assignment-test.ts.

## APN-defined cast

The default prelude embeds lib/type.apn and lib/do.apn. Editor launchers must
allow Deno to read both text imports. cast is a clauseFn, not a native; its
source is `cast (Type target) value = target value`. Expose std/type
through module loading and browser bundles. numericPayload removes numeric
annotations without changing the original value. Numeric patterns extract
payloads after conversion; explicit result constructors reapply result types.
Numeric equality ignores these annotations. See tests/language-cast-test.ts.

## Template application and type aliases

See docs/templates-and-types.md and tests/template-application-test.ts. Scalar
numbers apply by returning the incoming number, with typed numbers reapplying
their constructor. Other scalar kinds accept same-kind replacements. [f] maps
lazily; longer/empty lists zip exactly. Strings supply Unicode code-point chars
through the existing chars primitive. Integer application remains indexing.
Record application transforms supplied slots, initializes omitted type slots, appends
new fields, and preserves every character of string keys. Assignments apply old
slots before publishing a scoped copy; the selected slot is now demanded.
No element schema is attached to the output: [Int] [] is an ordinary empty list.

Capitalized aliases are stable type-level bindings. Type-only container values
are accepted as descriptions by Type, cast, isType, and schema patterns. Variant
declarations retain formal parameters and field expressions. Specialization
creates a family descriptor with arguments and applies lazy payload contracts;
unspecialized constructors remain polymorphic. A leading | marks single
constructor declarations. Keep family identity separate from constructor names.

The metacircular evaluator handles list templates through its own meApply so
object-language closures work. Run its self-evaluation demo when changing it.

## Tail execution

Interpreter.eval consumes internal TailCall transfers for fully applied APN
functions, ternary branches, and block tails. Keep lazy arguments and action
semantics intact. TailLoad transfers only propagate from a loaded program's
final expression, including tail-called functions/actions. loadFile owns the
iterative loop and pending export merges, restoring caller scope/sourceDir on
success, error, or interruption. Pending load scopes use heap memory; non-tail
calls retain the depth guard. Test tests/tail-call-test.ts and the REPL PTY check.

`do` is an ordinary prelude function defined in lib/do.apn and exported by
std/function. It sequences a lazy list with eager result binding, returning the
last result (unit for an empty list). Keep effect ordering and sharing tests.

`load` requires an extensionless basename and always appends .apn. Reject explicit
extensions before file access; directory components may still contain dots.

`use` is a native scope operation accepting a record or finite list of records.
Validate all keys as binding identifiers before publishing; preserve lazy values
and reference identity. Later fields win; return unit. It opens the active
evaluation scope, so wrapper functions do not export into their caller's scope.
`import` accepts a literal string or list of literal strings, combining exports
in order through the existing module cache. Selective imports stay selective;
failed list imports must not install earlier modules' names in the caller.

Numeric collection arithmetic is implemented by arrayArithmetic/arrayNegate.
Pair lists lazily with strict lengths, records by exact key strings. Broadcast
only whole numeric scalars; nested paired scalar/container shapes must fail.
Keep function iteration and scalar overloads unchanged. Reuse typedArithmetic
and numericNative so numeric checks remain consistent. Array helpers belong in
lib/array.apn; docs/arrays.md and tests/array-test.ts cover their behavior.

## Zero initialization

src/zero-values.ts supplies defaults only for omitted record-template slots.
Interpreter.dataValue demands ordinary values without projecting types to zero.
Bare types print as descriptors and never act as numbers. Template construction
accepts complete positional lists, [] for all defaults, or named records and initializes omitted slots
lazily; concrete defaults persist, nested templates initialize recursively.
Assignment applies a type/function-type slot to the incoming value; untouched
slots remain descriptors and the original template is unchanged.
All assignment paths share assignSlot. Initialized numeric fields retain type
annotations; Int/Float display without labels. Function iteration stays unchanged.
Variant defaults choose a nullary constructor first, otherwise recursively default
the first constructor's payload. Detect recursive defaults and require explicit
values for Function/Mutable/Type. See docs/zero-initialization.md and its tests.
Numeric construction and cast remain lossless.

Computed collection assignment evaluates its key once before its RHS against
the old scope. Pattern-compatible parameters are interpreted as expressions
only for existing collections in evalDef. Expression-only keys use setItem,
parsed by tryItemAssign; it shares assignItem with the definition path. Keep
function clauses, lazy tails, type checks and atomic binding publication intact.

## Nominal types, diagnostics, and resources

`distinct Type` creates a generative VariantFamily with base metadata. A capitalized
alias names and memoizes it; distinct patterns unpack its payload. Numeric operators
require the same family on both sides and preserve its checked base type. Ordinary
records remain structural. Nullary-only variant families index lists by zero-based declaration order,
including assignment; listIndex shares this rule between reads and updates.
Lists carry no key-family annotation. Arithmetic operators use nullary-family
ordinals and return ordinary numbers via arithmeticValue, including numeric
collections; equality, pattern matching, and display retain variant identity.

AST sourceLocations is a WeakMap, outside serialized AST shapes. Parser expression
spans retain source/file for assertions and match-diagnostics. Lint never evaluates
source: warn only for recognizable families/literal alternatives, handle scope
shadowing conservatively, and do not treat guarded patterns as total coverage.
Warnings are severity 2 and do not fail CLI lint.

resource-scope.ts implements bracket and read-only withFile. Finish returned finite
data before release; reject escaping callables/references, detect nested cycles,
and enforce withFile handle lifetime even if stashed externally. Cleanup runs in
finally. See docs/type-and-resource-rules.md and tests/odin-rules-test.ts.

`format template arguments` requires a list and exactly one value per unescaped `%`.
`%%` renders a literal percent; check arity before rendering any values.

Dot keys may also be negative numbers or parenthesized text: `obj.-1` means
`obj "-1"`, and `obj.(x)` means `obj "(x)"`. Parentheses and their contents,
including whitespace, belong to the key; the contents are never evaluated.
The same spellings work in record literals, plucks, field assignments, and
record destructuring: `[-1: 1, (x): 2]`.
