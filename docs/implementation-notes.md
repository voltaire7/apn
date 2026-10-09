# Implementation notes

How the interpreter upholds the language rules, and which tests guard each
area. User-visible behavior is specified in `docs/semantics.md` and the feature
docs it links to; this file records only implementation constraints. Update it
alongside the code, and don't restate the user-facing rules here.

## Architecture

- `Value` (`src/types.ts`) is a discriminated union of tagged runtime values:
  int, rational, float, complex, bool, string, char, list, lazyList, record,
  variant, closure, clauseFn, native, plus `thunk`, internal computed
  `deferred` thunks, lazy `cons` cells, and the internal `nomatch` sentinel
  used by clause fallthrough. Adding a kind means updating `valueToString`,
  `eval`, and every `force`/pattern/equality switch.
- `Env` is a parent-linked chain of mutable maps. Free variables resolve
  lexically, but bindings are shared by reference.
- Pipeline: lexer → parser (`Expr` / `Pattern` / `TopLevel` AST) →
  `Interpreter` (`eval`, `evalBinop`, `apply`, `callNative`, `matchPattern`).
- `APNError` carries every user-facing failure; see `docs/errors.md`.
- `ReplEditor` (`src/repl.ts`) is the raw-mode line editor, with a plain loop
  for piped stdin; see `docs/repl.md`.
- AST `sourceLocations` is a WeakMap kept outside the serialized AST shapes.
  Parser expression spans keep source/file for assertions and match diagnostics.

## Evaluation core

Guarded by `tests/semantics-test.ts`; update its assertions with any
intentional evaluation change.

- `force()` reveals only the outer value and memoizes every thunk it traverses.
  It must never force a list recursively. Consume spines with `cell()` /
  `elements()` and demand needed elements with `demand()`. Failed or
  interrupted thunks must release their busy flags.
- Deferred values and arguments share their memoized outer result, including
  through alias chains; actions stay repeatable.
- Blocks are `{ t: "block" }` nodes that evaluate in a child `Env`;
  `{ t: "stmDef" }` binds into it.
- The parser detects `f x = ...` definitions by lookahead (`isDef`): it scans
  parameter patterns, then requires `=`.
- There are no type annotations. `rejectDefinitionAnnotation` (before a
  statement's `=`/`<-`) and `rejectLambdaAnnotation` (`( ... ) ->`) report a
  `:` followed by a capitalized type by token shape, before any lookahead runs;
  a ternary `c ? Int : String` never matches either shape. Application
  statements such as `print $ head $ [1,2,3]` lack `=`, so they stay
  expressions. `skipContinuation` handles indented definition bodies.
- `groupClauses` merges consecutive same-name, same-arity definitions into one
  `clauseFn`. It accumulates applied arguments as lazy thunks (supporting
  partial application); fallthrough shares those thunks so demanded effects
  never repeat.
- Pattern lambdas are `patternLambda` nodes that evaluate to `clauseFn` values.
  `match` is an intrinsic, not an AST node: it probes alternatives without
  running bodies and uses `nomatch` only for mismatch, so runtime errors
  propagate.
- Field/pluck assignment desugars to an eager pattern binding
  `vec = setFields(vec, entries, rhs)` that reads the old record and the RHS
  before rebinding (so `vec.[x,y] = vec.[y,x]` swaps).
- `(-2)` is negation because the lexer has no whitespace information.
- The REPL echo is gated by `lastIsBinding`, which keeps assignments silent.
- Inside `{ }`, statements sit at one flat level; an `indent` token directly
  before a statement, or a `,`-tuple in `( )`, is rejected with a clear error.

## Numbers and numeric types

`src/numbers.ts` owns the numeric tower; `src/type-system.ts` defines numeric
constructors, lossless conversions, and arithmetic promotion.

- `mkInt(number)` accepts only safe host counters. Integer ranges stay exact;
  fractional exact ranges use `rationalRange`, mixed ranges `floatRange`.
  Float-range cells use origin + index × step, a bounded endpoint tolerance,
  and a no-progress guard, and must work through every lazy consumer.
- Numeric values may carry `typeName`; preserve it through checked arithmetic.
  Internal arithmetic promotion and C ABI conversions use strict `castNumeric`.
  Never allow integer wraparound or imaginary-part loss.
- `numericPayload` strips numeric annotations without changing the original
  value. Numeric patterns extract payloads after conversion; explicit result
  constructors reapply types.
- Exact exponentiation, integer square root, GCD loops, and large decimal
  formatting call `checkInterrupt` so Ctrl+C can cancel them.
- Tests: `tests/numeric-tower-test.ts`, `tests/bigint-test.ts`,
  `tests/type-system-test.ts`, `tests/flexible-float-test.ts`,
  `tests/float-construction-test.ts`, `tests/float-range-test.ts`.

## HashMap

Maps are immutable association snapshots; a mutable JS `Map` is used only while
building a new snapshot. Numeric keys hash by exact normalized value regardless
of representation (`numericHash`). Tests: `tests/hash-map-test.ts`.

## Prelude and `cast`

The default prelude embeds `lib/type.apn` and `lib/do.apn` as text imports, so
editor launchers must let Deno read both. `cast` is a `clauseFn`, not a native:
its clauses validate list templates with `Type` and dispatch to
`(Type target).(value)`, other types to `target value`. Expose `type`
through module loading and browser bundles. `do` is an ordinary function
exported by `function`. Tests: `tests/language-cast-test.ts`,
`tests/do-test.ts`.

## Records, keys, and assignment

- `src/record-keys.ts` stores ordinary strings without hidden prefixes.
  `keyText` is identity; `keySource` escapes quoted-field contents for source
  rendering. Pairs, iteration, HashMap conversion, and FFI symbol names
  preserve the full key string. Quote characters and NUL have no special
  lookup/update encoding.
- All slot assignment paths share `assignSlot`. Expression-only keys use
  `setItem`, parsed by `tryItemAssign`, which shares `assignItem` with the
  definition path. Pattern-compatible parameters are treated as expressions only
  for existing collections in `evalDef`.
- Never invoke a stored action, or merge a record, merely to replace its slot.
  Validate every replacement before publishing the new binding; keep
  binding publication atomic and lazy tails intact.
- String-key association assignment must leave skipped payloads and tails lazy.
- `listIndex` shares the nullary-variant index rule between reads and updates.
- Tests: `tests/record-keys-test.ts`, `tests/record-assignment-test.ts`,
  `tests/index-assignment-test.ts`, `tests/computed-assignment-test.ts`,
  `tests/selection-symmetry-test.ts`, `tests/nested-field-assignment-test.ts`.

## Templates, dotted application, and zero values

Behavior: `docs/templates-and-types.md`, `docs/zero-initialization.md`.

- Record construction uses `applyTemplateSlot`; record defaults (including
  nested list defaults) use `replaceDefaults`. Dotted list templates reject
  scalar slots rather than replacing them.
- Dotted bracket nodes carry both expression inputs (for lists) and quoted
  selection entries (for records). Evaluate only the branch the left operand
  selects; record plucks must never evaluate field identifiers.
- Parenthesized record access evaluates in a child `Env` populated with the
  identifier fields, falling back to the outer scope.
- Keep source printing, gradual checking, and the metacircular template AST
  (`meTemplate`) in sync with template syntax.
- `src/zero-values.ts` supplies defaults only for omitted record-template slots.
  `Interpreter.dataValue` demands ordinary values without projecting types to
  zero. Detect recursive defaults.
- Variant family identity stays separate from constructor names.
- Tests: `tests/template-application-test.ts`, `tests/zero-initialization-test.ts`,
  `tests/collection-shapes-test.ts`, `tests/strict-dotted-application-test.ts`.

## Patterns

- Dotted pattern `left.right` matches one value twice, keeping lazy/reference
  identity. Ordinary dotted assignment uses `patDef.update` only when its root
  is already visible; otherwise it binds the as-pattern. In inference, keep
  original inputs separate from converted subpattern payloads.
- Function contracts (`((Int -> Int) f)`) wrap callables and check inputs and
  outputs on invocation; never execute a function to predict its signature.
- Keep runtime and checker record projection aligned, including match
  alternatives and standalone bindings. Checker remainder (`_:`) operations
  defer until call-site input shapes are known.
- Tests: `tests/dotted-pattern-test.ts`, `tests/record-flattening-test.ts`,
  `tests/type-shape-pattern-test.ts`, `tests/repeated-pattern-test.ts`,
  `tests/pattern-functions-test.ts`.

## Eager binding, tail calls, and loading

- `pattern <- expression` sets AST `patDef.eager`, which selects `reference()`
  before matching: run zero-argument actions now, but keep Mutable/Pointer
  references and lazy container fields. Don't change `=` semantics.
  `getArgs` is a nullary native action. Tests: `tests/eager-binding-test.ts`.
- `Interpreter.eval` consumes internal `TailCall` transfers for fully applied
  functions, ternary branches, and block tails. `TailLoad` transfers propagate
  only from a loaded program's final expression. `loadFile` owns the iterative
  loop and pending export merges and restores caller scope/`sourceDir` on
  success, error, or interruption. Non-tail calls keep the depth guard
  (`STACK_LIMIT`). Tests: `tests/tail-call-test.ts`, `tests/repl-interrupt-pty.py`.
- `load` rejects explicit extensions before any file access.
- Late binding in the checker: each binding's `Entry.capture` (shared by
  its copies, carried over by rebindings) lists the definitions whose
  deferred code read it (`defining`/`deferred`: function clauses, lambdas,
  lazy values). `define` and lazy `patDef` call `rederiveUsers` after a
  rebinding: each reader still bound to the same clauses or `definition`
  is re-derived in the current scope (closures and actions take the new
  type, other values must unify with the old). Failures set `Entry.broken`,
  reported at the next use (a reader broken by reading a broken definition
  keeps its original problem and adds to `through`); `rederiving` guards cycles. Tests:
  `tests/default-checking-test.ts`.
- A statically checked load (`verifyLoad` ran) publishes without
  `protectDynamicWrite`. For other loads, `publishForeignBindings` records,
  per caller scope, which origin (path plus source text) published each
  binding (`publishedBy`), and skips the guard only when the same origin
  replaces the exact value it published. Tests: `tests/dynamic-boundary-test.ts`.
- `use` validates every key as a binding identifier before publishing and opens
  the active evaluation scope, so wrapper functions don't export into their
  caller. Failed list imports must not install earlier modules' names.
  Tests: `tests/use-test.ts`, `tests/import-list-test.ts`, `tests/load-test.ts`.
- `src/modules.ts` `resolveModule` is the one place imports resolve, used by
  both `Interpreter.importStandard` and `CheckingSession.module`; both cache by
  the resolved path (`key`), so a module and its checked types always come from
  the same files. Each file of a folder module runs (and is checked) in its own
  builtins scope with `sourceDir` set to its directory. The parent-folder
  search stops at the program's folder: `Interpreter.moduleRoot` (the outermost
  run's `sourceDir`) and `CheckingSession.prepare`'s directory, passed as
  `resolveModule`'s `root`. With `moduleSources`
  (a bundle) the same lookup runs over virtual paths: the standard library
  under `/lib/` and the program's folder at `/app/` (its `sourceDir` in the
  browser). `bundleProgram` collects the program's literal imports and
  literal-path loads transitively, or the whole folder once any file
  mentions `load` other than applied to a literal (`loadPath`/`readLoad`
  read loads from the same bundle at runtime and while checking); `apn --html` checks the program against that bundle, so a build
  succeeds only when the browser will find every module.
  Tests: `tests/package-import-test.ts`, `tests/html-test.ts`.

## Mutable references and `env`

- `reference()` preserves cell identity; `demand()` reads the contents without
  memoizing the read over the cell. Tests: `tests/mutable-test.ts`.
- `env` is a live record view backed by `Env` (`record.scope`), capturing the
  lexical scope when the builtin is referenced. Never enumerate by forcing
  values. Writes use `Env.set` (nearest owner, else local) and must not rebind
  the view's name. Tests: `tests/environment-test.ts`.

## Numeric arrays

`arrayArithmetic` / `arrayNegate` implement collection arithmetic; reuse
`typedArithmetic` and `numericNative` so numeric checks stay consistent.
Array helpers belong in `lib/array.apn`. Tests: `tests/array-test.ts`.

## Nominal types and resources

- `distinct Type` creates a generative `VariantFamily` with base metadata.
  Arithmetic on nullary-family ordinals returns ordinary numbers via
  `arithmeticValue`.
- `src/resource-scope.ts` implements `bracket` and read-only `withFile`.
  Cleanup runs in `finally`; enforce `withFile` handle lifetime even if a
  handle is stashed externally.
- Tests: `tests/odin-rules-test.ts`, `tests/variant-index-test.ts`,
  `tests/variant-arithmetic-test.ts`.

## Type descriptions and truthiness

- `src/type-description.ts` gives bounded, non-evaluating descriptions for
  list/function `typeOf` results: display metadata, not contracts. Never force
  lazy elements or invoke callbacks to infer them. Keep inference bounded with
  occurs-check links for self-application. Tests: `tests/type-description-test.ts`.
- `truthy()` is the single predicate conversion used by `Bool`, `!`,
  conditions, guards, `assert`, and `filter`. There is no unit AST node or
  value. Tests: `tests/truthiness-test.ts`.

## Static checking

Behavior: `docs/gradual-and-dependent-types.md`.

- `src/type-checker.ts` is pure and never executes APN;
  `src/checking-session.ts` supplies import/load interfaces and the
  interpreter's runtime names (used to report unbound names). Normal execution
  calls `Interpreter.enableChecking()`.
- Preserve polymorphic instantiation, captured monomorphic variables, open
  record matching, overloads, and bounded affine index substitution.
- Recursive structural types are finite graphs: keep cycles when copying or
  generalizing and compare visited pairs during unification. Do not
  reintroduce an occurs-check rejection for self-application. Budget/depth
  exhaustion is a diagnostic, not a `Dynamic` fallback.
- Binding a variable to a union drops the variable's own occurrences, after
  expanding nested unions: `v = v | t` has the least solution `v = t`. A union
  is not a structural node, so keeping the self-reference never terminates.
- An empty-list pattern's type has `items: []` and no length, so unknown-length
  lists still match it; `unify` rejects one with a known non-zero length.
  `domain()` keys such clauses separately (`empty:`), because a group's input
  type is its first clause's and would otherwise reject the cons clause's inputs.
- Overload choices carry their clauses (`ClauseOrder`: source index, patterns,
  names that make a variable refutable); partial applications collect the
  call's arguments (`callArgs`). For a complete call, `rankClause` gives each
  clause a score interval from `patternScore`, which mirrors the `clauseFn`
  scoring in `interp.ts` using static argument types, and decides whether it
  definitely matches or fails. Choices whose clauses all fail, or all come
  certainly after a definitely matching clause, are dropped. Keep
  `patternScore` in step with the runtime's scoring.
- A deferred call (`deferredCall`) keeps what is known about its argument's
  value (`known`: a literal (`literalOf` covers characters, floats and
  constructor tags), a parameter's symbolic index, or `ref`, the binder
  of the parameter whose value it is). Applying a function whose parameter has
  a binder substitutes the argument's index and value (`copy`'s `value`) into
  copies of its pending checks; checks still waiting on an unknown argument are
  re-registered in the enclosing function's requirements. A `require` check
  waits while its call does (`waiting`) instead of using the call's
  provisional `solution`.
- A `fn` node's `summary` holds all of its definition's clauses and defining
  scope. At a direct call of a trusted entry (`trustsShape`: definitions with
  clauses or root `builtin`s; `inherited` only means "visible from an outer
  scope"), `literalOf` records a pending `call` in the argument's `Known`;
  `resolveKnown` evaluates it with `evaluateCall`, which ranks clauses with
  `rankClause` and evaluates bodies with `evaluateKnown` (bounded by depth and
  `evaluations`). Numbers go through the runtime's `typedArithmetic`,
  `typedPower`, `equalNumbers`, `compareNumbers` and `numericNative` (for real
  builtins only); `Known.number` holds rationals, complex values and typed
  numbers other than plain `Int`/`Float` (`knownNumber`), and `knownType`
  gives `evaluateCall` the runtime type of a known value so typed clauses
  rank; `patternScore` scores a typed pattern exactly from a known value
  (`numericOf`), and `evaluateCall` binds its converted payload.
  `Known.size` is a list's constant length: `valueEntry` reads it from the
  type just inferred for the expression (the `inferred` map; read it only
  right after inference, never from another context), `evaluateKnown`
  derives it from list literals, `:`, `++`, callee shapes (`shapeAt`) and
  summaries, and `evaluateCall` gives a `(x:xs)` tail one less.
  `Known.items` holds per-element facts when every element is known (list
  literals, finite integer ranges, `:`, `++`); `evaluateKnown` runs the
  `LIST_NATIVES` (`filter`, `map`, `take`, `drop`) over them by applying the
  function expression to a synthetic `$item`, and applies lambdas (including
  sections) directly. Finite ranges stop at 10000 elements. `Known.fn` is a
  function value (an expression with its env and scope, or a block-local
  definition's clauses with its closure and applied arguments) applied by
  `applyKnown`; a computed value over parameters drops `fn` and `seq`, since
  their closures are only known at the parameters' calls. `Known.cell` is a
  lazy list's memoized first cell (head and tail; `null` when empty) used
  for `:`, endless ranges, `iterate` and the list builtins, mirroring the
  runtime's `cell()`. Walk lists iteratively (`element`, `elementsOf`,
  `dropKnown`), never by recursion over indexes, and never materialize one
  eagerly; `elementsOf` and `dropKnown` spend one unit of work per element,
  and `Known.range` (`rangeKnown`, `rangeElement`) indexes, drops and takes
  integer ranges arithmetically. `evaluateNative` runs the
  pure `EVALUATED_NATIVES`. Depth (`EVALUATION_DEPTH`) and work
  (`EVALUATION_BUDGET`, per root via `budgeted`) are bounded, and a
  JavaScript stack overflow (`RangeError`) in static evaluation leaves the
  value unknown; keep the recursive path (`evaluateKnown` and its
  `evaluateApp`/`evaluateBinop`/`evaluateBlock` cases) free of per-call
  closures, so frames stay small and recursion reaches the runtime's own
  depth. A ternary or clause set whose first result has no facts stops
  early, so recursion over unknown values stays cheap. A value over
  parameters gets only `SYMBOLIC_BUDGET` (it is decided again at each call),
  a list's length is never walked when the other side of a `zipWith` or a
  meet is unknown or endless, and argument-free compound expressions are
  cached per node and the bindings of the names they mention
  (`sameBinding`), since nested call arguments are each evaluated.
  Effects (`print`, `emit`, `assert`, `debug`) only return their results
  statically. `Known.mutable` is a cell. While `CheckOptions.mutation` (the
  session-wide `mayMutate` scan for `set` and `load`; `env` and `use` only
  expose bindings that scan saw) is false,
  `readMutable` gives its first contents. Otherwise cells are followed per
  root (`KnownCell.root`): `writeMutable` updates them in evaluation order,
  every lazily evaluated computation runs under `lazily` as its own region,
  and `accessCell` marks the root `reordered` when a written cell is
  accessed from two regions; `budgeted` drops a root's value that read a
  cell if it was reordered, wrote an unknown target, or was `incomplete`
  (skipped code: an unevaluated application, an uncertain branch or clause
  set, the budget, any expression kind the evaluator does not follow).
  Values that touched cells are not cached. In lazy positions (list
  elements, cons heads, call arguments) `lazyValue` runs a trial that throws
  `CELL_TOUCHED` at any cell access (`once` and `lazyList` reset on it); a
  value that touches a cell becomes `Known.deferred`, forced by `demand` at
  the points the run forces it (`readMutable`, strict builtins, application,
  equality). Top-level cells (`KnownCell.program`, made while
  `creatingTopLevel`) are written only by `executeTopLevel`, which statically
  runs each top-level statement that `mayWrite` (reaches `set` or `load`
  through named definitions, `env` views and `use`d fields) before it is checked; reads in that
  statement come from `executedParts`, the values that run gave each
  argument-free part (unknown if it never evaluated them). A top-level value
  whose definition touches a top-level cell (`touchedTopLevel`) keeps its
  body as `Entry.lazyTop`; `forceLazyTop` re-runs an action and keeps a
  thunk's value from its first use in an execution, and `mayWrite.forces`
  schedules executions for statements that may use one. Every cell access,
  even unapplied, and every `forceLazyTop` makes a result uncacheable
  (`cellEvents`), or a cached value would skip its effects. An uncertain
  execution, or one leaving a deferred value `unforced`, clears
  `programValid`. Model every place the runtime forces a value (`print`
  renders deeply, `seq`, `assert`, `debug`, inspecting patterns in
  `evaluateCall`), or the `unforced` check gives up.
  An uncertain execution calls `forgetReachable`: the cells and `lazyTop`
  values `reachable` from the statement's names (through definition bodies,
  the facts of those names, the `Known.origin` of lazy values, and
  `CheckOptions.loadedNames` for literal loads, `Entry.opened` for names
  `use` opened, `Entry.bound` for pattern bindings, and `viewReach` for
  `env` views) become `invalid`. `viewFlow` runs over every program in the
  session (`CheckOptions.viewPrograms`, libraries included, once any uses
  `env`) to a fixpoint: each name per scope frame (function parameters,
  lambda parameters, block locals), each function's result, and each
  expression (`viewValue`, which tracks functions by arity, natives via
  `CheckOptions.nativeArities`) gets a kind: may be a view, hold views as
  elements or deeper, or be a local scope's view. `viewReach` then reads
  each use in walked code: a view applied to a key or field names those
  bindings (`keyStrings` evaluates keys where reached, taking each value of
  a simple local binding and refusing parameters and cells); a value that
  may be a view or hold one, given to code that may read it, fails. The
  session also shares top-level views once their program ran
  (`envTopViews`; the evaluator reads a top-level view's field at the root).
  A failing use, an opaque `use` here or elsewhere
  (`CheckOptions.openedElsewhere`), or a lazy value without an origin
  clears `programValid`. Lazy list
  cells and deferred values keep their result only when computed touching
  no cell or during an execution (`keeps`); `map`/`zipWith` heads and
  `iterate`'s next value are deferred and `filter` applies its predicate in
  the cell, as the runtime does; ranking only `peek`s; printing and `==`
  walk cells in the runtime's order; and an evaluation result with lazy
  parts is never cached (`hasLazyParts`), since evaluating it again builds
  them afresh. A top-level value whose body can write a cell is kept as
  `lazyTop` too. Unforced values that persist (`unforcedPersists`) join
  `pendingValues`; a statement reaching their holders runs statically, and a
  pending value keeps its result only when forced in such a run.
  `CheckOptions.inputs` is set only by `Interpreter.enableChecking`:
  `readFile` and `getArgs` read through `Interpreter.inputFile`, a snapshot
  cleared at each top-level checked run and shared with the runtime
  `readFile`; `readStdin` reads `Interpreter.inputStdin` (all of stdin, once,
  also for the runtime) unless stdin is a terminal. A block gives each
  name it defines one slot (`Known.slot`, read through `lookup`): lazy
  definitions store a memoized thunk (`once`, which reports a value that
  needs itself as unknown) and eager ones a value, so earlier closures see
  later rebindings as at runtime.
  A recursive self-reference is marked `recursive` with the clause's
  `selfInputs`, and a recursive call strips the lengths of an argument whose
  parameter type has none. A single-group definition's entry keeps
  `alternatives[0]` as its type, which carries the summary. A numeric
  constructor applied to a type variable defers its conversion as a
  `construct` requirement instead of unifying. Compound arguments over
  enclosing parameters become a pending `expr`, re-evaluated after
  substitution. `substituteKnown` substitutes parameters inside pending calls
  and `callArgs`. An overload call that stays ambiguous because its arguments
  are `symbolic` is deferred (`evaluatingCall` keeps one node), and `waiting`
  holds checks on it. At the end, checks still waiting only on symbolic values
  are decided with `deciding` set, so none is skipped. Literal facts on
  variables apply only to names written once (`writes`).
- `defineClauses` merges clauses of one input domain into a group. A clause
  whose type merges with its group's only after `withoutLengths` forgets list
  lengths becomes its own group (key `#index`), so overload ranking separates
  them; other conflicts still fail in the merge.
- List lengths through functions are a property of a function's code, never
  of a type node: unification shares one node between values of different
  lengths (a fold's seed and result) and between different function values (a
  ternary's branches). A `fn` node's `shape` describes its result in terms of
  argument positions (`Shape`: the argument itself, or a list whose length is
  an argument's or a constant, with item shapes). `application` collects
  `args` across curried calls and `buildShape` returns a fresh result type.
  `shapeOf` derives shapes from bodies (value-level and conservative);
  multi-clause groups keep only `meetShapes` of all clauses. Shapes are trusted
  only in callee position of a direct call to a definition or builtin
  (`callees`, `trustsShape`); every other reference, and any partial
  application leaving its chain, goes through `withoutShapes`.
  `DECLARED_KEEPS_LENGTH` marks library functions `shapeOf` cannot analyse; add
  each to `tests/stdlib-length-test.ts`, which verifies the claim at runtime.
- Keep implicit unknowns separate from explicit `Dynamic`: a concrete type
  requires a runtime constructor/contract or an actually converting pattern,
  never a silently inserted conversion.
- Reflected environment writes and imported/loaded/`use` bindings must
  preserve existing types. Never invoke an old action to guess its type.
  Preserve Mutable identity at `Dynamic` boundaries.
- `CheckingSession` checks the whole submission before effects and commits type
  state only after successful execution, restoring binding maps on runtime
  failure. Internal module/load runs must not re-check against the caller's
  root session.
- `Vect n t` uses a type descriptor with `[length,element type]` arguments;
  `list.schema` keeps its contract through index updates and `typeOf`.
- Tests: `tests/strict-checking-test.ts`, `tests/default-checking-test.ts`,
  `tests/gradual-types-test.ts`, `tests/dynamic-boundary-test.ts`,
  `tests/vect-pattern-test.ts`, `tests/record-pattern-checking-test.ts`,
  `tests/recursive-inference-test.ts`; keep `examples/types/` passing under
  ordinary execution and `--check`.

## Editor tooling

`src/lint.ts` and `src/lsp.ts` must never evaluate user code; use
`parseDocument`, which isolates and restores parser declaration registries.
Lint warns only for recognizable families/literal alternatives, handles scope
shadowing conservatively, and doesn't treat guarded patterns as total coverage;
warnings are severity 2 and don't fail CLI lint. In `--lsp` mode stdout is
reserved for JSON-RPC; keep UTF-16 positions and byte-counted Content-Length
framing. `editors/neovim/apn.lua` is opt-in and session-only; don't edit user
configuration. Tests: `tests/lsp-test.ts`.

## Metacircular evaluator

`lib/meta.apn` exposes `meta`; the implementation lives in `lib/meta/`. It
must never delegate object source to host `parse`, `toAST`, `load`, or an eval
callback, and its core must stay within the reader's supported subset. After
changes run `tests/metacircular-test.ts` and
`deno run --allow-read examples/metacircular-self.ts` (which evaluates the live
evaluator source twice in APN). Document subset limits in
`docs/metacircular-evaluator.md`.

## Browser HTML and p5.js

`src/html.ts` decodes views and dispatches APN messages;
`src/browser-runtime.ts` patches the DOM; `src/build-html.ts` bundles the
interpreter and source (`apn --html SOURCE.apn [OUTPUT.html]`). Run
`deno check src/browser-runtime.ts` as well as `main.ts`. `src/p5.ts` adapts
callbacks to a p5 instance; the runtime loads pinned p5.js only for a
`P5Sketch`. Keep host methods scoped per interpreter and sketch; never expose
arbitrary host object access. Tests: `tests/html-test.ts`, `tests/p5-test.ts`.

## C interop

`src/ffi.ts` implements the opt-in `ffi` module and Pointer operations.
Keep ABI signatures fixed-width and conversions lossless; never map unbounded
Int to C int. `withLibrary` must close in `finally` and reject escaped
functions and pointers afterward. Pointer allocations retain memory and bounds
across aliases, offsets, and C round trips; returned external pointers stay
unsafe (no forged addresses or implicit dereference). Run
`./tests/run-c-interop-tests` in addition to the standard workflow; it compiles
`examples/c-interop/demo.c`. The user authorized unrestricted `--allow-ffi` for
the local demo and tests; normal APN still requires an explicit flag. The donut
demo uses lazy `map`, not eager `*`, so Ctrl+C stops it.
