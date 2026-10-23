# AGENTS.md

## PROJECT RULES — READ FIRST

1. **The workflow is mandatory.** For ANY change (add, change, or remove a
   feature), you MUST:
   1. Edit the relevant `src/` module (or `main.ts` for entry-point changes).
   2. Update `examples/features.apn` so it demonstrates the new/updated behavior
      (this file is the living spec AND the smoke test).
   3. Type-check, test, and run the full showcase:
          deno check main.ts
          deno test --allow-read tests/*-test.ts
          deno run --allow-read main.ts examples/features.apn
   4. Confirm output matches expectations before declaring done.
   Do not end a task without completing all steps. Never leave `examples/features.apn`
   out of date. Some areas need extra checks; see the index below.
2. **Keep it green.** If a change breaks any existing feature, fix it before
   finishing. Do not leave the project in a broken state.
3. **Keep the docs true.** When behavior changes, update the matching file in
   `docs/` (and the REPL `:help` block for new syntax). `docs/semantics.md` is
   authoritative for language behavior; `docs/implementation-notes.md` holds
   only implementation constraints and must not restate it. Do not grow this file into a feature log.
4. **Layout:** `main.ts`, `apn`, `readme.md`, and `AGENTS.md` stay in the root.
   `src/` interpreter, `lib/` standard library, `examples/` runnable examples,
   `tests/` regression tests, `docs/` documentation. No dependencies.
   Personal scratch programs (e.g. `~/Desktop/test.apn`) live outside the
   repository; preserve the user's edits to them.
5. **Commit and push after every task**, once the workflow is green, directly
   to `master`: `git add <files>`, a concise repo-style message, `git push`.
   Never force-push or overwrite remote work; report any blocker.

## Project

APN — **A**pplicative **P**olish **N**otation — is a lazy, Haskell-like
scripting language with default static type checking (gradual, with explicit
`Dynamic` boundaries), implemented as a dependency-free Deno/TypeScript
interpreter with a REPL.

Key files:
- `main.ts` — thin entry point (CLI dispatch); keep logic out of it
- `apn` — sh launcher; checks the Deno version, sets permissions, no logic
- `src/lexer.ts`, `src/parser.ts`, `src/ast.ts` — syntax
- `src/interp.ts` — `Interpreter` (eval/apply/demand), `NATIVES` registry
- `src/types.ts` — runtime `Value` union, `Env`, `valueToString`
- `src/numbers.ts`, `src/type-system.ts` — numeric tower and numeric types
- `src/type-checker.ts`, `src/checking-session.ts` — static checking (evaluates pure code, never performs effects)
- `src/errors.ts` — `APNError`, `didYouMean`
- `src/repl.ts` — REPL editor and drivers
- `lib/*.apn` — standard library (`import "text"`, `import ["option","map"]`, ...)
- `examples/features.apn` — showcase of every feature; `tests/semantics-test.ts`
  asserts observable evaluation rules

## Run / verify

Deno 2.8.0 or newer (the first release that loads the interpreter's
`with { type: "text" }` imports; `apn` enforces it). From the repo root:
- Showcase / smoke test: `deno run --allow-read main.ts examples/features.apn`
- Tests: `deno test --allow-read tests/*-test.ts` (Deno.test, no package.json)
- Type-check: `deno check main.ts` (plus `src/browser-runtime.ts` and `src/editor.ts` for browser changes)
- REPL / run a file: `./apn` or `./apn FILE.apn` (adds write/env flags so
  history persists in `~/.apn_history`)

## Conventions

- TypeScript, 4-space indent, no formatter. `Value` is a discriminated union:
  when adding a kind, update `valueToString`, `eval`, and every
  `force`/pattern/equality switch — they are exhaustive.
- Every user-facing failure is an `APNError` (parse/lex/runtime/type) with a
  position and optional `hint:`; see `docs/errors.md`.
- Question questionable decisions. Before implementing a request (the user's
  or your own idea), check it against the language's existing rules; if it
  conflicts with them, is inconsistent, or has a simpler or more general
  alternative, say so plainly and propose the fix instead of silently
  bending the implementation to make it work.
- Judge a syntax rule by the code it makes people write. Before tightening
  the syntax (an error, a required or forbidden spelling, a printer's output),
  write out the programs it forces and check what each already means in the
  language: `withFile "notes" file -> file.read` is a lambda with one typed
  parameter (as `(t1 1 t2 -> ...) (Vect 1 Int)` is), so neither printing an
  application that way nor making it an error is right. A spelling that already reads one way
  keeps that meaning (`xs -2 = 5` is `xs` given `-2`).
- A definition takes exactly the parameters it is written with. Never give one
  a hidden parameter or call it with a different arity internally (no rewriting
  `return ((Option _) x) = Some x` into a two-parameter clause on the type),
  and never give a pattern a different meaning in one place.
- Things that act the same share one implementation: never special-case one
  spelling of a definition (curried or with parameters) for no reason.
- Avoid redundancy everywhere: say each thing once. Reuse an existing
  definition, helper, doc section or test instead of writing a near-copy;
  give a module's shared pieces one name and refer to it; state a rule in one
  doc and link to it from others; remove what a change makes redundant.
- Define as much of the language as possible in APN itself (`lib/prelude.apn`
  and the standard library): add a native, intrinsic or parser rule only for
  what APN cannot express, and keep it as small as it can be.
- Favor curried (point-free) definitions when parameters are only passed
  through or discarded: `return = Some`, not `return x = Some x`.
- APN style in examples: whole-function `match` uses the same-line form
  (`f x = match x [ ... ]`); a definition's `{` stays on the `=` line, with
  the body exactly +4 and `}` aligned with the opening line.

## Invariants that are easy to break

- **Laziness:** `force()` reveals only the outer value and must never force a
  list recursively; consume spines with `cell()`/`elements()` and demand
  elements with `demand()`. Self-referential lists (`x = 1:x`, Fibonacci
  streams) must stay productive and interruptible; failed thunks release
  their busy flags.
- **Numbers:** integers and rationals are exact (`bigint`); never round
  silently, never allow integer wraparound or imaginary-part loss; indexes
  and counts require exact integers.
- **Layout:** strict 4-space indentation across the whole language; newlines
  at the same level end statements, +4 continues them. Lines are at most 99
  characters, each literal and comment counting as one, in every
  APN source (lib, examples, docs, test programs).
- **Bindings:** a value never changes: `name = value` defines a new name for
  its whole scope or starts a new version of a visible one, which code written
  before keeps not seeing (`f = x -> ...` is a clause of `f`, like
  `f x = ...`); records and lists are never mutated in place (updates bind a
  modified copy). Only `Mutable` cells mutate, and only through IO actions.
- **Purity:** effectful builtins return IO actions and never act when applied;
  only statements, `<-` and running do-blocks run actions (`runIO`, keeping
  recursive actions in constant stack). Operators are prelude functions
  (`lib/prelude.apn`); intrinsics are named functions, not syntax.
- **Static checking** evaluates the pure code a type needs, in its own
  step-bounded evaluator, and never performs effects; lint/LSP never evaluate
  user code beyond that checker. What it cannot decide (a parameter, input, a
  cell's contents out of run order, the budget running out) becomes a runtime
  check, never a guess. It reads program input only when the interpreter checks
  right before a run, through the snapshot that run uses (stdin only when it is
  not a terminal).
- **File mode never auto-prints**; the REPL echoes expression results but
  not assignments.

## Where to find details

Read the relevant doc and its tests before changing an area:

| Area | Docs | Tests / extra checks |
| --- | --- | --- |
| Evaluation, laziness, operators, IO, records, indexing | `docs/semantics.md`, `docs/implementation-notes.md` | `tests/semantics-test.ts`, `tests/operators-test.ts`, `tests/io-test.ts` |
| Numbers and numeric types | `docs/semantics.md`, `docs/implementation-notes.md` | `tests/numeric-tower-test.ts`, `tests/bigint-test.ts`, `tests/type-system-test.ts` |
| Static/gradual/dependent types, `Dynamic` | `docs/gradual-and-dependent-types.md`, `docs/type-and-resource-rules.md` | `tests/strict-checking-test.ts`, `tests/default-checking-test.ts`, `tests/dynamic-boundary-test.ts`, `tests/gradual-types-test.ts` |
| Templates, type aliases, zero initialization | `docs/templates-and-types.md`, `docs/zero-initialization.md` | `tests/template-application-test.ts`, `tests/zero-initialization-test.ts` |
| Patterns and function contracts | `docs/pattern-functions.md` | `tests/pattern-functions-test.ts`, `tests/dotted-pattern-test.ts` |
| Arrays and numeric collections | `docs/arrays.md` | `tests/array-test.ts` |
| Standard library | `docs/standard-library.md`, `docs/combinators.md` | `tests/standard-library-test.ts`, `tests/http-test.ts`; also run `deno test --allow-read --allow-net tests/http-test.ts` |
| REPL | `docs/repl.md` | `tests/repl-*-test.ts`, `tests/repl-interrupt-pty.py` |
| Error rendering | `docs/errors.md` | `tests/cli-options-test.ts` |
| Editor tooling (lint, LSP) | `docs/editor-tooling.md` | `tests/lsp-test.ts` |
| Metacircular evaluator | `docs/metacircular-evaluator.md` | `tests/metacircular-test.ts`; also run `deno run --allow-read examples/metacircular-self.ts` |
| Browser HTML / p5.js | `docs/browser-html.md`, `docs/p5.md` | `tests/html-test.ts`, `tests/p5-test.ts`, `tests/elm-examples-test.ts`, `tests/p5js-examples-test.ts`; also `deno check src/browser-runtime.ts src/editor.ts` |
| C interop (FFI) | `docs/c-interop.md` | `tests/c-interop-test.ts`; also run `./tests/run-c-interop-tests` |

Per-feature invariants (record keys, eager `<-` binding, tail calls, `use`/
`import`, resources, dotted patterns, selection assignment, and more)
are in `docs/implementation-notes.md`, each with the tests that guard it.
