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
- `AGENTS.md` — this file

## Run / verify

Deno required. From `sloth/`:
- Run the showcase (use this as the smoke test after any change):
    deno run --allow-read main.ts features.txt
- Start the REPL:               deno run --allow-read main.ts
- Type-check (always run after edits):
    deno check main.ts

There is NO `package.json`, no dependencies, no test framework, no `src/`.

## Architecture (all in main.ts, top to bottom)

- `Type` / `Value` — runtime values are tagged objects: int, float, bool,
  string, char, unit, list, lazyList, record, variant, closure, native.
- `Env` — lexical scope chain (mutable parent-linked maps). Free variables
  resolve at definition site (static/lexical scoping), but bindings are shared
  by reference (JS-like, not immutable).
- `Expr` / `Pattern` / `TopLevel` — AST.
- Lexer → Parser → Interpreter (`eval`, `evalBinop`, `apply`, `callNative`,
  `matchPattern`).

## Core language semantics (don't break these)

- **Lazy lists**: a list literal `[a, b]` evaluates to a `lazyList` (unevaluated
  elements + captured env) and is resolved only when forced:
  - used as a **list** (print, head/map/…, ops, case) → bare identifiers resolve
    to variables;
  - used as a **record/template** (left of `.` in fromList) → bare identifiers
    are read as field names.
  - `force()` is the single entry point for turning a `lazyList` into a concrete
    value; it recurses into nested lists/records/variants. Only invoke it when a
    list is actually needed.
- **No tuples.** `(a, b)` is invalid — parens are only for grouping/calls.
  Mixed values go in lists: `[213, "hello"]`.
- **Records**: `[name: "Alice", age: 30]`, accessed with `rec.field` (chaining
  works: `a.b.c`). The old `{ a = b }` syntax is REMOVED.
- **List→record**: `[name, value].[1, 2]` or `Template.[1, 2]` zips field names
  with a value list; field count must equal list size, else error.
- **Ternary, not if/then/else**: `cond ? a : b` (right-associative). Keywords
  `if`, `then`, `else` are removed.
- **Functions**: two styles, partial application, recursion. `fn` is removed.
  - lambda: `double = x -> x * 2`, multi-param `add = a b -> a + b`
  - Haskell-style: `func x = x + x`, `add a b = a + b` — params go on the left
    of `=` and desugar to nested lambdas. Detected via lookahead (`isDef`),
    which scans params + optional `: Type` then requires `=`. Safe alongside
    top-level application expressions (`head xs |> print`) because those lack
    `=`.
- **Variants** via `data Maybe a = Just a | Nothing`; constructors and case
  matching. Nullary constructors are bare values; arity>0 constructors are
  curried natives tagged with the constructor name.
- `let ... in ...` with multiple bindings and optional (ignored) type
  annotations. `case` with guards `|`. Pipes `x |> f`.

## Parser quirks (known, pre-existing)

- `&&` / `||` are NOT wired into the parser (they appear in `evalBinop` but don't
  parse). Use comparisons/ternaries instead.
- A `case` expression reliably parses when the lambda body starts on an
  INDENTED new line:
      f =
        x -> case x of
          [] -> 0
          ...
  (A same-line `f = x -> case x of ...` can mis-parse the layout.)
- `:` cons is only a pattern operator (`x:rest`), not an expression operator.

## Conventions

- Untyped TypeScript; `Value` is a discriminated union. When adding a new kind,
  update `valueToString`, `eval`, and any `force`/pattern/`==` switches — they
  are exhaustive.
- Keep edits consolidated in `main.ts`; keep the three-file layout (no new deps,
  no `src/`).
- Reflect new syntax in `features.txt` and in the REPL `:help` block.
- Don't commit secrets; there are none. Only commit when asked.
