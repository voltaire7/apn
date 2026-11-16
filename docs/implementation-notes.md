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
- The unnecessary-parentheses rule is decided where a group stands (`judge`,
  by the `(` token's index) and reported after the parse, since speculative
  parses (ranges, item assignment, lambda headers) are rolled back and the last
  parse of the tokens decides. It must never flag a group whose removal changes the
  parse: when unsure it keeps the group. Pattern groups are not judged. The
  printers write each piece for its place by the same rules: `exprToSource`
  (with `level`/`reach`, also behind function text and `probe`) and
  `fromAST` (`lib/std/syntax/source.apn`), each checked by a strict round trip
  (`tests/unnecessary-parentheses-test.ts`, `tests/syntax-test.ts`).

## Evaluation core

Guarded by `tests/semantics-test.ts`; update its assertions with any
intentional evaluation change.

- `force()` reveals only the outer value and memoizes every thunk it traverses.
  It must never force a list recursively. Consume spines with `cell()` /
  `elements()` and demand needed elements with `demand()`. Failed or
  interrupted thunks must release their busy flags. A thunk or deferred value
  drops what computes it (`env`, `compute`, `describes`) once it has its value,
  so a long-lived value never keeps the scope that made it alive (a game's
  model would otherwise keep every earlier frame; `tests/elm-examples-test.ts`).
- A definition with an application body is a 0-parameter closure, run at
  each use; when its result is not an action the closure keeps it and drops
  its `env` (a game's model holds `vx = toX ...`, `velocity = step ...`; the
  leak and First Person tests in `tests/elm-examples-test.ts`). The checker's
  `LazyTop.action` follows the same rule, from the definition's type. An IO
  native's action runs on fresh copies of its unevaluated argument thunks.
- Deferred values and arguments share their memoized outer result, including
  through alias chains; actions stay repeatable.
- Blocks are `{ t: "block" }` nodes that evaluate in a child `Env`;
  `{ t: "stmDef" }` binds into it.
- The parser detects `f x = ...` definitions by lookahead (`isDef`): it scans
  parameter patterns, then requires `=`.
- Cons is `::`. `checkColons` runs on the tokens before parsing: a `:`
  writes a record entry (directly inside `[ ]`), closes a ternary (pairing a
  `?` at the same bracket depth), or, spaced, declares or ascribes; any other
  is reported. Declarations and ascription are expanded as they are parsed,
  so nothing after the parser sees them: `e : T` is `T e` marked `ascribed`
  (a function type, which applied would call its argument, is
  `((T r) -> r) e`), which the printers show as `(e : T)`. `(p : T)` is the
  type pattern `(T args.. p)`, marked `typed`, for a name given names,
  literals and types, and a schema for any other type; `(t p)` for a type
  variable. What the name is decides it where it runs, per top-level
  statement in the runtime and the checker alike (`rewriteTypedPatterns`): a
  constructor's or a function type's is the schema `(p : T args)`, and a type
  given fewer arguments than it takes gets `_` for the rest, and
  `knownTypeArguments`, run first, makes the pattern of a type a definition
  with parameters computes a schema once its arguments are all known (`copy n (xs : Sized n)`
  tests `xs` against `Sized n`; `(xs : Pairs n a)` reads `n` back from the
  value). A lone ascription's parentheses are its own: the group is the
  ascription, not a block around it. The old spellings are rejected where each is
  known: `((T) p)` and `(t x)` by the parser once part of the program
  (`rejectOldSpellings`; parses that try a pattern and give it up do not
  count); a type's pattern the parser did not mark `typed` that has one
  argument more than the type's parameters by the checker's `constr`
  binding and, once per clause, the run (`typesAfterValues`); a type
  applied to a value as written by the checker's application and the run,
  where `apply` reads `writtenApplication` (set by an app or pipe as
  written) and lets a type take only its parameters (`typeParameter`), a
  value going through `typeValue` from an ascription alone.
  `CONSTRUCTING_TYPES` (HashMap, Mutable, Pointer) build their values. A declaration
  (`parseDeclaration`) a marker that `applyDeclarations` replaces, typing the
  parameters of the clauses after it and claiming their results. Application
  statements such as `print $ head $ [1,2,3]` lack `=`, so they stay
  expressions. `skipContinuation` handles indented definition bodies.
- `groupClauses` merges consecutive same-name, same-arity definitions into one
  `clauseFn`. It accumulates applied arguments as lazy thunks (supporting
  partial application); fallthrough shares those thunks so demanded effects
  never repeat.
- Pattern lambdas are `patternLambda` nodes that evaluate to `clauseFn` values.
  `~` is an operator over an intrinsic (`intrinsics.match`), not an AST node:
  it probes alternatives without running bodies and uses `nomatch` only for
  mismatch, so runtime errors propagate. The builtin `~` applied to written
  one-parameter lambdas (`x ~ [...]`, or `(~) x [...]`)
  (`writtenMatch`; `n -> e` is the alternative whose pattern is `n`) runs
  directly (`coreMatch`): no alternative is made a function, and the chosen
  body is a tail call. The checker types it (`inferMatch`) where it stands when
  the value's type is known, each body under its pattern's names, and as the
  `match` operation over the alternatives' function types when the value's type
  is known only at calls (a parameter's), as clauses are; one `chosen` join
  serves both. Clauses and alternatives are chosen by one `choose` at runtime
  and one `possibleClauses` in the checker, both in the order `clausePlaces`
  (`ast.ts`) gives among equally ranked ones, so the two cannot disagree. A function whose body matches its
  parameters is its alternatives as clauses (`matchedClauses`) wherever the
  checker or `typeOf` reads a definition.
- Sugar keeps its written node (printing, `probe`, tools) and runs and checks
  as its core expansion from `src/ast.ts` (`ternaryExpansion`), built once with
  each part at its source. The expansion's names mean what they mean there
  (no hygiene); the runtime and checker take the builtin `Bool`, `not` and
  `negate`, and the prelude's Bool clauses for `get`, in place (`boolSelection`:
  a match on the Bool) only while those are still the prelude's. The checker
  types a Bool where a function is required as one giving either argument.
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

- `compareNumbers` compares two floats, or a float and an integer a double
  holds exactly (within 2^53), as numbers, and anything else as exact
  fractions; never compare an unsafe integer with a float as a double.

- `mkInt(number)` accepts only safe host counters. A range is one `range`
  node holding its bounds as written; `rangeValue` (`src/types.ts`) makes its
  value for the runtime and the checker's evaluator. Integer ranges stay exact;
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

## HTTP and JSON

Behavior: `docs/standard-library.md` (`http`, `json`).

- `src/http.ts` makes `fetch` synchronous: in Deno a per-request worker (a
  `data:` URL, so nothing extra to bundle or permit) runs the platform fetch
  while the interpreter waits with `Atomics.wait` in 20 ms slices, calling
  `checkInterrupt` between them (an interrupt terminates the worker and with it
  the request); the JSON-encoded response
  crosses a fixed shared buffer in chunks. The worker is terminated after each
  request so it never keeps the process alive. In a browser build
  (`typeof Deno === "undefined"`) a synchronous `XMLHttpRequest` replaces it.
- `fetch` is APN (`lib/std/http.apn`): it ascribes its options to
  `FetchOptions` and calls `sendRequest`, a native every standard module sees
  through its builtins but none exports. `prettyJson` is a standard native
  exported only through its module, and `to JSON`/`from JSON` reach
  `toJson`/`fromJson` only through `convertTo`; none is in
  `EVALUATED_NATIVES`, so static checking never sends a request. The retired names (`RETIRED_NATIVES`) are bound nowhere.
- `src/json.ts` parses JSON itself so integers stay exact `bigint`s; an
  object decodes to its `[key,value]` pairs as `string` and value cells, so
  keys are never renamed. Encoding reads a list as an object only once every
  item has been demanded and is a pair with a string key.
  Tests: `tests/http-test.ts` (its server test needs `--allow-net`),
  `tests/repl-interrupt-pty.py` (Ctrl+C during a slow request).

## Prelude

The default prelude embeds `lib/prelude.apn` and `lib/std/do.apn` as text
imports, so editor launchers must let Deno read them.

The checker reads the prelude too: its own scope holds only what TypeScript
implements (the natives and `intrinsics.*`), and `preludeScope` checks
`lib/prelude.apn` over it once (`prelude: true`), each check copying the names
it binds (`copyTypeScope`). A method's first definition binds it
(`(>>=) = intrinsics.bind`); later clauses for a type are instances (the
prelude's are its own, which the intrinsic's typing covers). Where inference cannot derive a
prelude function's type (`sequence`'s recursion over any monad, `not` of an
action, the `enum*` functions a range is), `PRELUDE_TYPINGS` types it by a
rule, as an intrinsic is; the prelude still defines it. A prelude change needs
no checker change unless it adds such a function.

Operators: the lexer reads a maximal run of operator characters as one token;
the parser seeds its fixity table from `lib/prelude.apn` at module load and
pre-scans every parsed source for fixity declarations, which persist across
parses (later REPL input). The prelude binds each operator to an `intrinsics.*`
native (`PRIMITIVE_OPERATORS` in `src/parser.ts`), forced at startup so a
binop finds the native itself: `evalBinop` then runs `operate` directly
(strict operands evaluated in place, `::`/`++`/`&&`/`||`/`$` over thunks) and
applies any other binding as a function, unless clauses joined it (`joins`).
A `clauseFn` defined for a function its own scope binds otherwise, with that
binding's arity (`knownArity`, which runs no thunk but a field alias; the
checker's `overloaded`), keeps it as `fallback`; a checked write accepts an
imported one over the binding it extends. In the checker an operator name has its intrinsic's type, through
the prelude's alias ((+) = intrinsics.add); a binop on another binding is inferred as the call `(op l) r`, and an overload
of a prelude operator falls back to the builtin rule when its clauses do not
accept known operand types; operands not known yet make an `overloaded:op`
operation that chooses once they are. `(op)` parses as the name `op`;
`infixSpelling` has the checker read `(op) a b` as the binop and a lone `(op)`
as `$L, $R -> $L op $R`, and `operatorApplication` and `prefixApplication`
are the one typing a binop or unop shares with a call of the intrinsic
(`intrinsics.add`, `negate`, `not`). The checker's evaluator reads `(op)` the
same way, and `evaluateOperator` is the builtin meaning a binop and a call of
the intrinsic share (`evaluateBinop` only chooses a program's overload). Clauses joining a function
get an `overload` type of themselves and the previous meaning (also for their own
recursive calls); an overload's partial calls, an intrinsic's included, stay an
`overload` for the next argument to decide. `apply` gives a value outside
`CALLABLE_KINDS` to the `get` in `this.env` when clauses extend it
(`extended`), else to `builtinGet` (which `intrinsics.get` runs); `assigned`
does the same for `with` and `assignItem`, from `setItem`, a collection's
clause-spelled assignment and `setFields` on a value that is not a record. The
checker's `application` does the same with `extendedFunctions`, and the
intrinsic `get` indexes with `builtin` set, so it is not dispatched again; an
assignment takes the program's `with` clauses when they accept the value and
key (`overloadAccepts`), as a binop takes an operator's overload, and a call of
the intrinsic `with` itself is a runtime check. The evaluator's `indexed`
mirrors both: a program's `get` clauses that take the inferred types, else the
builtin on a known list or record. Tests: `tests/operators-test.ts`,
`tests/default-checking-test.ts`. `do` is an ordinary function exported by
`function`. Tests: `tests/do-test.ts`.

## Records, keys, and assignment

- A list literal with binding items keeps its items (`formulas` in the
  interpreter, a list type's `formula` in the checker): `setIndex` rebuilds
  such a list with the replaced item given as a value, binding that item's
  names to it, and the checker re-infers the items the same way; an update at
  an index known only at run time makes the items' type unknown.

- A record's key is a name: the lexer reads a backticked one as an `ident`
  token (`quoted`), so every key is one token. The parser's `recordOf` makes a
  list literal of fields alone a `record` node: each binding's name and value
  (a function's clauses wrapped in a block), `use e` as the key `_`, keeping
  the items as `items`, from which the interpreter's `recordCode` and the
  checker's record `code` give its code where code is read (`++`, `toAST`).
  Both evaluate fields in order, each in scope for those after it. The node's
  `declared` lists the fields written with their type; the record value's
  `bound` (the checker's record `bound` alike) the fields bound to a value,
  which a field holding a type is a slot only when it is not (`slotField`).
  Updates and copies keep `bound` (`keepType`), a new field is bound, and what
  a template builds is bound throughout.
  `src/record-keys.ts` writes a key back (`keySource`, backticks when it is
  not a name) and a field (`fieldSource`); pairs, iteration, HashMap
  conversion and FFI symbol names give the key's text.
- All slot assignment paths share `assignSlot`. Expression-only keys use
  `setItem`, parsed by `tryItemAssign`, which shares `assignItem` with the
  definition path. Pattern-compatible parameters are treated as expressions only
  for existing collections in `evalDef`.
- Never invoke a stored action, or merge a record, merely to replace its slot.
  Validate every replacement before publishing the new binding; keep
  binding publication atomic and lazy tails intact.
- String-key association assignment must leave skipped payloads and tails lazy.
- `listIndex` shares the index rule (an `Int`, or a `to Int`) between reads and updates.
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
- Overloads by result type: the checker records each clause's inferred result
  head in the session's `resultHeads`, keyed by the body's source position
  (modules are parsed separately by checker and runtime, so never key by AST
  object); the runtime falls back to `describeType`. Clause merging
  (`mergeClauses`) only asks for heads when patterns collide. A call reaching
  such clauses returns a `pending` `call` step, realized by the head a context
  names; `return`'s instances are chosen the same way, never by running them.
  A do-block's monad is recorded in `resultHeads` too, keyed by the block's
  position: a block that is otherwise `pending` at run time is realized in it
  (`checkedMonad`). The same holds for a `>>=`/`>>` binop and a call whose
  inferred type is a monad (`recordMonad`, which records `?` when inferences
  disagree); `eval` realizes a `pending` result by the expression it returns
  from, or the outermost one a tail call left (`decided`). `throw e` is a `pending` `throw` step, realized as `return`
  is (`instanceIn`): `[]` for a list, a failing action for IO, else the
  `throw` instance whose head is the target's. `intrinsics.source` reads a
  parameter's argument expression one step back, as `assert` reads its own.
- Typed list and variant patterns (`(xs : List Int)`, `(x : Option Int)`): the
  checker records list and variant types in the session's `valueTypes`, keyed
  by source position (a disagreement stores `null`), and each schema pattern's
  type in `patternTypes`, keyed by the type `Expr` (so `flatTypedPattern` is
  memoized: both sides must see one object). `eval` tags list and call results
  with their recorded type; `staticTypeOf` follows tags through thunks,
  variables and `.value` chains. The runtime asks the checker's own `convert`
  (`bridge.fits`, type-only), and the checker ignores elements' values while
  choosing a clause (`asUsed`, `castKnown`), so both decide alike. With no
  recorded type the pattern matches. Tests: `tests/typed-pattern-forms-test.ts`.
- The runtime reads the checker's records (`valueTypes`, `patternTypes`,
  `resultHeads`, `moduleStatements`) from `types`: the checking session, or
  for a run without `enableChecking` its own quiet one (`typing`, `typesOf`),
  which infers alike and reports nothing, so a program means the same either
  way. Tests: `tests/typed-pattern-forms-test.ts`, `tests/monad-test.ts`.
- `f a` in a written type: at runtime a variable type with `arguments` (apply
  of a variable type to a type, a `typeBind` parameter, and a `schema`
  parameter `((f a) e)` adding `e`, in `readFunctionType`; the parser reads a
  lambda parameter `f a e` or `(f a e)`, three or more lowercase names, as that
  schema); in the checker an `apply` type
  whose head, once known, is a `ctor` (a type missing its first parameters:
  `List`, `Result _ e` for `f a`, `Result` for `f a e`), and
  `resolve` turns it into that type (`appliedType`); `typeOf` describes it with
  the `apply` shape. Tests: `tests/function-types-test.ts`.
  In the checker, a union of `pending` values and one monad's value is that
  monad (`c ? return [] : Err e` is a Result).
- Function contracts (`((Int -> Int) f)`) are typed patterns whose type is a
  lambda read by `asType` (runtime) and `lambdaType` (checker); keep the two
  readings aligned, including which bound names stay bound. They wrap callables
  and check inputs and outputs on invocation, deciding type variables per call
  (copy the contract's variable map, never share it between calls); never
  execute a function to predict its signature. Reading a lambda as a type
  evaluates its body with its names bound to types, never to values.
- Keep runtime and checker record projection aligned, including match
  alternatives and standalone bindings. Checker remainder (`_:`) operations
  defer until call-site input shapes are known.
- Tests: `tests/dotted-pattern-test.ts`, `tests/record-flattening-test.ts`,
  `tests/type-shape-pattern-test.ts`, `tests/repeated-pattern-test.ts`,
  `tests/pattern-functions-test.ts`.

## Eager binding, tail calls, and loading

- IO: an action is a `Value` of kind `io` whose `run` performs it. `IO_NATIVES`
  (and host natives) return actions from `callNative` instead of acting;
  `runStmt` (top-level statements) and `runIO` run them. A file runs with
  `run(program, tailLoad, file = true)` (`main.ts`, `load`, the browser) and
  checks with `CheckOptions.file`, so its last statement follows the block
  rule; the REPL and tests run inputs without it, showing the last value. A do-block's last
  step returns an `IOTail` that `runIO`'s loop continues, so recursive actions
  use no stack; never run a tail action recursively. Block evaluation turns
  into a do-block at its first `<-` (always) or discarded statement whose value
  is an action, and `runDoBlock` creates a fresh `Env` per run from that point.
  The checker mirrors this: `IO t` is the variant type `IO` (`io`, `isIO`),
  `runType` gives what running yields (a deferred `run` operation while
  unknown), and the static evaluator's `Known.action` runs only through
  `runKnown`, at statements, `<-` and inside running do-blocks; a top-level
  `x <- action` keeps the run's facts (`runLocally` keeps its cells local).
  Tests: `tests/io-test.ts`.
- Clauses that travel with a type (`isForTypes`, decided where they run by
  `Interpreter.travelling`, by what the scope binds) bind no name: for a
  method (`METHOD_INTRINSICS`: map, >>=, <*>, return, throw, to, from) they are
  registered in `instances`, for any other function in `attachments` under
  its root (`functionRoot`, through aliases and scoped extensions), and
  `joinedCall` tries them (newest first, by a probing apply) before the
  function's own clauses or builtin, so the operator and range fast paths
  step aside (`joins`). The checker overloads the function with them
  (`travels`, `overloaded`), and with a scope's own extension of what it
  bound otherwise (`ownDefinitions`).
- Monads: `instanceFamilies` records the types instances
  cover (a discarded value of a type with `>>=` makes a do-block). `return` builds a `pending` value
  (`PendingStep` return/bind/do) that `realize` turns into a concrete monad
  (IO, List, or a `return` instance keyed by a type pattern that matches type
  descriptors). `bind`/`mapValue`/`apValue` dispatch IO and lists natively,
  then instances; map and <*> derive from >>= and return. A block's first
  `<-` value decides its monad: IO keeps `runDoBlock`, others go through
  `desugarDo` (a fresh scope per continuation). The checker types pending as
  `m t` (internally `$monad t`, unifies with any monadic type), records instance types in the
  session's `instances` (`define` infers them on a copy of the scope), tracks
  each do-block's monad in `doBlocks`, and its view analysis and `topNames`
  skip instance clauses. Tests: `tests/monad-test.ts`.
- `pattern <- expression` sets AST `patDef.eager`: the value must be an action
  (`isLoadCall` reads `load` unevaluated), run with `runIO` and its result `reference`d
  before matching, keeping Mutable/Pointer references and lazy container
  fields. The checker never re-derives an eager binding (no `definition`), and
  view/key analysis sees through `return`/`return`. Don't change `=` semantics.
  Tests: `tests/eager-binding-test.ts`.
- `Interpreter.eval` consumes internal `TailCall` transfers for fully applied
  functions, chosen `match` alternatives (a ternary's branches), and block
  tails. `TailLoad` transfers propagate only from a `use` of code that is a
  spliced program's final expression. `spliceCode` (what `use` of code runs)
  owns the iterative loop, splices into the scope `use` was written in, and
  restores `sourceDir` (set to the code's file's folder, `codeSources`; code's
  own reads use `codeDirs`) on success, error, or interruption.
  `intrinsics.import` and `intrinsics.readFileFrom` actions keep the
  `dynamicDepth` they were made at, so one written inside `Dynamic` runs
  unchecked; `parse` keeps whether the text it reads was (`sourcePaths`), as
  `verifyLoad` checks. The checker types the prelude's `load` by its rule
  (`PRELUDE_TYPINGS`). Non-tail calls keep the depth guard
  (`STACK_LIMIT`), and a host `RangeError` in `evaluate` is the same overflow.
  A left-nested chain of primitive operators that force their left operand
  first (`LEFT_FIRST_OPERATORS` and the strict ones) runs in a loop in
  `evalBinop`, a run of `++` over lists as one `appendCodes` of them all
  (each list after another rerun with the bindings of all the items before
  it, as nested appends give); a long `$` chain runs in `pipedChain`,
  innermost first, while each function `forcesFirst` (a conservative check:
  one clause of names and no guard, unjoined, its body starting with the
  argument by `startsWith`, or its parameter a scalar typed one), so the order
  of every evaluation, and so of every error, is the nested one's; a long
  composition applied runs so in `composedChain` (`compositions` keeps each
  one's parts), and a right-nested chain of strict operators (`\\`, `^`)
  evaluates its lefts outermost first, then folds from the inside; the parser joins a right-associative chain from the right in
  `parseOperators` (`join`) rather than recursing per operator. Tests:
  `tests/tail-call-test.ts`, `tests/repl-interrupt-pty.py`.
- Fixity: the parser sees the prelude's declarations and the parsed file's
  (`fileFixities`, one table per `parse`, `fixitiesOf(program)`); a chain
  holding another operator is marked `reassociate` (its parentheses are kept
  as written) and regrouped where it is evaluated or checked (`regroup`, cached
  per set of fixities) by the fixity its operator's value carries:
  `Interpreter.valueFixities` (through aliases and `fallback`s) and the
  checker's `Entry.fixity`, both set where a program defines the operator and
  kept by added clauses. Tests: `tests/operators-test.ts`.
- Versions: `Interpreter.bindNames` defines a name new to the scope in its
  root (`Env.root`) and gives a rebound one a version (`new Env(env, True)`),
  which the statement loops (top level, blocks, do-blocks) go on in;
  `Env.bindings` reads a scope through its versions (module exports), and
  `newest` is the version `eval` runs in. `use` publishes the same way, and its
  statement adopts the version (`adoptPublished`). The runtime tags the
  records `importStandard` makes and the code `parse` makes of a file
  (`moduleValues`, with their origin; the REPL echoes none), and the checker
  types both as `ModuleFields` (kept through `copy`); no statement opens one. `use` of a module
  record publishes its names with the module's origin; the checker opens the
  module's scope entries (clauses too) and settles each type (`validate`) as a
  statement's value is, so later code meets its calls decided; a module
  leaves out of its record the names it bound to the modules it read
  (`readsModule`, the runtime's `moduleValues`). Tests: `tests/load-test.ts`,
  `tests/default-checking-test.ts`. The checker never re-checks a reader: a reader's types
  are its version's. Its static block evaluation (`evaluateBlock`) follows
  the same rule. Tests: `tests/semantics-test.ts`, `tests/default-checking-test.ts`.
- A statically checked load's record (`verifyLoad` ran) publishes by `use` without
  `protectDynamicWrite`. For other loads, `publishForeignBindings` records,
  per caller scope, which origin (path plus source text) published each
  binding (`publishedBy`), and skips the guard only when the same origin
  replaces the exact value it published. Tests: `tests/dynamic-boundary-test.ts`.
- `use` validates every key as a binding identifier before publishing and opens
  the active evaluation scope, so wrapper functions don't export into their
  caller. Tests: `tests/use-test.ts`, `tests/std-import-test.ts`, `tests/load-test.ts`.
- `src/modules.ts` `resolveModule` is the one place imports resolve, used by
  both `Interpreter.importStandard` and `CheckingSession.module`; both cache by
  the resolved path (`key`), so a module and its checked types always come from
  the same files. A module runs (and is checked) in its own builtins scope with
  `sourceDir` set to its directory; a folder's record holds its entries
  deferred (`Interpreter.defer`, the checker's `moduleType`), each resolved,
  run and checked when first read. A module's record leaves out the module
  records it imported for itself, so `std <- import "std"` in a library module
  makes no cycle through `std`. The parent-folder
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

## Mutable references

- `reference()` preserves cell identity; `demand()` reads the contents without
  memoizing the read over the cell. Tests: `tests/mutable-test.ts`.
- A cell keeps the type a conversion declared for its first contents
  (`declaredTypes`: `(x : List T)`, a record schema's value) as `schema`, and `set`
  conforms to it. A record marked `shared` (a p5 object) is cached by its
  zero-argument definition like a cell, and a checked write replaces it with
  another shared record of the same fields as itself. Tests:
  `tests/default-checking-test.ts` (p5.js-example cases).
- A record schema's value is marked in `declaredTypes` by every path that
  makes one (a record or list argument, `[]`, a nested default), and each
  update's copy keeps the mark (`keepType`), so `newField` can refuse a field
  its schema lacks; the checker's record type carries the same fact as
  `closed`. Tests: `tests/semantics-test.ts`, `tests/default-checking-test.ts`.

## Numeric arrays

`arrayArithmetic` / `arrayNegate` implement collection arithmetic; reuse
`typedArithmetic` and `numericNative` so numeric checks stay consistent.
Array helpers belong in `lib/std/array.apn`. Tests: `tests/array-test.ts`.

## Nominal types and resources

- A name defined as a type, whatever its case (`namedValue`: on a capitalized
  definition's value, a lowercase one's thunk or zero-argument closure as it is
  forced, once), names it. One for a scalar type (`NAMED_BASES`, runtime and checker)
  creates a generative `VariantFamily` with base metadata. It is its base to
  operators (`conform` keeps the name), builtins and base patterns
  (`baseValue`), and the checker unifies it with its base only where the base
  is expected. It is built from its base only by conversions (`conform`; the
  checker's `convert` unless `matching`, a typed parameter's own check).
  A value of another type of the program's is a built-in one through its `to`
  instance (`builtinValue`; the checker's `builtinTyped`): `listIndex`,
  `arithmeticValue`, a scalar typed pattern (`matchPattern`, `patternScore`;
  the checker's `convert` when `matching`), guarded (`converting`) against the
  instance's own patterns meeting the value again. An enumeration's positions
  are `to Int` clauses (`enumerationPositions`) the runtime and the checker
  define with its declaration.
- Every definition, `name params [: T] = body`, is parsed once
  (`parseDefinition`): one whose body holds `_` as a value (`holdsPlaceholder`,
  not a type's `List _`) is a constructor declaration, any other a clause whose
  body is ascribed `T` (`typedClauses`).
- A statement's patterns are read once, where it runs (`readPatterns` in
  `ast.ts`): at the top level, and in a block that declares names as each of
  its statements runs; `withinScope` keeps an outer pass out of such blocks.
  Its rules are written once, against a `Binding` (what a name is bound to);
  the run (`Interpreter.binding`) and the checker (`boundAs`) only describe
  their names in those terms, so the two cannot read a pattern differently.
- A lowercase name applied in a pattern parses as a head (`constr` with
  `head`); `resolveHeads` decides it where the statement runs, by binding
  (the checker's `constructorNames` keeps a name's
  constructor, NewBox = Box): data drops the mark, a free name
  becomes the typed run it was, anything else keeps it, and matching it is an
  error (`headError`) unless the definition assigns an item (`assignmentKey`).
- A constructor whose rules give other types is `widened` in the checker: a
  call is its type or theirs, its own where every rule definitely fails for the
  arguments (`ownCalls`).
- `Name params = _` is parser sugar (`constructorDeclaration`): the same
  `type` declaration `Name a = | Name a` makes, its fields from the
  parameters, so runtime and checker treat both alike; it declares again where
  the name is a constructor already (`isPatBinding`). `Name params : T = _`
  is a declaration of `T` marked `extends` (`ownerType` reads `T`): the parser
  merges it into `T`'s declaration earlier in the same statements
  (`declareInto`); runtime and checker merge it into `T`'s recorded
  declaration (`Interpreter.declarations`, the checker entry's `declaration`),
  all through `extendedDeclaration`.
- A constructor applied to a type for each field reads as the type of the
  values it makes where a type is expected: at runtime through `sharedType`
  (its type's own name with its parameters is that type applied; any other,
  `constructedType`, a refinement of its type whose `made` is the constructor
  as written, which `to` instances key on), in the checker through `sharedType`
  and `namesItsType`, the `constructs` mark letting a constructor take type
  arguments. A constructor with logic skips it given types (`apply`'s
  `__constr`). Typed patterns of a constructor are rewritten where they run
  (`rewriteTypedPatterns`: a schema, or with a type variable an as-pattern).
- `X = A | B` written bare stays a `type` statement; runtime and checker decide
  whether it declares by what its names are bound to (`unionKind`, worded
  once in `ast.ts`), and an existing type or constructor there is an error; only a
  union of list types is run as `X = intrinsics.union [...]` (`unionClause`).
  `X = (A | B)` is a definition whose body is the prelude's `|`, which the
  checker reads as `intrinsics.union [A, B]` while `|` is the prelude's; the
  parser keeps those parentheses (`parseDefBody`). Either way the union is a
  `type` value with `choices` at runtime and a `union` type in the checker.
- A `|` or `&` written where a type is expected is marked by the parser
  (`typeOperators`, `types` on the call and its operand list; `unionClause`
  too): at runtime it counts `typeOperands`, so its lists and records are read
  as types; the checker reads the operand list's mark. Elsewhere lists and
  records are values (`setOf` never calls one a type).
- Values read as sets (`Interpreter.setOf`) share one view for `<=`, `&` and
  `|`: an ordered value by its rank, a sequence or a graph by its pairs
  (`pairs`, `at`; lists walked once by `prefixOf` and `commonPrefix`). `&` and
  `|` go through `intrinsics.intersection` and `intrinsics.union`, of values
  when no operand is a type (`ofValues`); an intersection of types is a
  refinement of the first by membership in the rest. The checker reads `&` as
  `intrinsics.intersection [a, b]` as it does `|`.
- A constructor's logic (`ConstructorLogic`) is parsed with its `_` filled
  by `intrinsics.tag Owner Name [fields]` (`constructorDeclaration`), the
  owner being `T` for one declared into it. At runtime the constructor's native runs it
  as a clause (`invoke`), as does a slot default (`zeroValue`); the checker
  unifies its result with the constructor's.
- Promotion (`Interpreter.promote` when a binop's builtin meets a defined
  type; the checker's `promotedOperands` where a user's operator clauses
  reject the operands) finds a `to` instance with `instance`/`instanceFor` and
  applies the operator's binding again.
- `tag` makes a `variant` whose family is a declared
  owner's or one per capitalized definition (`ownerFamily`); the checker types
  `tag Owner Ctor [fields]` by its shape (`taggedType`): a declared
  constructor's application, else a `fields` variant of the field types, which
  a pattern of the tagging function binds. Tests: `tests/core-test.ts`.
- A capitalized function is a `type` value with `alias`: its clauses as a
  `clauseFn` (`run`), so choosing among them is a function's; `construct`
  applies it, as the checker's `construct` does. A non-scalar type it gives is
  a shallow copy registered in `asWritten` (name, arguments, the type made);
  applying or conforming to it marks a copy of the result's outer part in
  `declaredTypes`, which `typeOf`, rendering and patterns read; a value it did
  not make is read back by `readBack` (`describes`, `holds`), and a written
  list of types applies as `templateList`. One whose length `countingOf` reads
  off its clauses (`Counting`: `scale * n + offset`) is instead a `type` with
  `counts` (`counted`; the checker's `factory` with `counts`), Vect's included
  (the parser checks a redefinition of `Vect` after grouping clauses, and the
  checker's scope declares the prelude's): `vectorParts` and
  `matchVectorPattern` turn the index into the length and back, and a call
  solves a parameter's `c * n + d` for `n` (`application`). A family of lists
  is read as clauses (`listClauses`) where it is declared, its `Nil` and `Cons`
  by what they are bound to (`listAlternatives`). The checker
  leaves such patterns to the run (`explicitDynamic` parameters); `constructed` is the type a
  pattern of it takes (a tagging function's `fields` variant). The parser
  joins adjacent clauses (`continues`);
  whether a left side destructures is decided where the scope is known
  (`evalDef`, `defineClauses`). Tests: `tests/constructor-function-test.ts`.
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

- `src/type-checker.ts` never runs the interpreter or performs effects; its
  own bounded evaluator (`evaluateKnown`, over partially known values) runs
  pure code a type needs. Its conditions (`boolean`) fall back to it inside
  `peek`, so a value reading a top-level cell is decided only in the run's
  order; a type a condition chooses at runtime is `chosen`;
  `src/checking-session.ts` supplies import/load interfaces and the
  interpreter's runtime names (used to report unbound names). Normal execution
  calls `Interpreter.enableChecking()`.
- Preserve polymorphic instantiation, captured monomorphic variables, open
  record matching, overloads, and bounded affine index substitution.
- Recursive structural types are finite graphs: keep cycles when copying or
  generalizing and compare visited pairs during unification. Do not
  reintroduce an occurs-check rejection for self-application. Inference
  budget/depth exhaustion is a diagnostic, not a `Dynamic` fallback (`limit`
  keeps the budget's issue for its statement, past any `succeeds`). An
  operation found undecided keeps that (`idle`) until `typeChanges` (or
  `deciding`, `choosing`) moves, and reads its operands again only if reading
  changed a type, so a chain of them costs linear work: whatever changes a type
  (a `link`, `decided`, `solution`) must count in `typeChanges`, as `unify`
  does; one waiting only on unlinked variables keeps them (`waits`, followed
  through aliases) and stays undecided while they stay so, until an operation
  it waits through is decided or given a solution (`settled` drops its
  dependents' `waits`; `copy` carries them to the copy's variables), and
  `linkEnd` follows a variable's aliases in a loop, compressing them. A chain
  of them 32 deep in `resolve` is resolved from its innermost
  out, and a left- or right-nested `binop` or `pipe` chain longer than 64 is
  typed so (`typedSpine`, its types in `spineTypes` while its top is typed,
  each node's recorded type slimmed of a list's items and code once the one
  above it is typed), so neither nests with its length; `++` of code types only
  the right's items, after the left's (`codeList` with `joined`, its bindings
  kept in `Formula.bound`). Nor does `copy` nest with a chain of operations,
  copying it from its innermost out from 64 deep, nor `waiting`, nor the
  checks an argument's type carries, with stacks of their own. A `RangeError`
  in a statement is its
  depth limit. A walk over a whole program or expression keeps its own stack
  (`walkObjects`, or one of its own as `mentionedNames` and `valueNames`,
  which keep each node's result), never the host's: a chain of thousands of
  operators is a tree that deep. An evaluation that runs out of budget leaves its value unknown, an
  error where a type needs it (`budgetCut`, below).
  `tests/type-level-evaluation-test.ts`, `tests/strict-checking-test.ts`.
- The checker's evaluator calls the runtime's text functions
  (`text-natives.ts`: `upper`, `lower`, `chars`, `fromChars`, `parse`, which
  `to`/`from` with `String` or `List Char` run) on known values; never reimplement a native in `evaluateNative`.
- `typeOf` of a builtin reads the checker's signature (`builtinSignature`,
  written by `signatureText` and read back as a written type), so the two
  never disagree; only intrinsics the checker types specially (`map`,
  `length`, `fail`) keep a written signature in `type-description.ts`.
- Indexed families: the runtime computes a value's indices on demand
  (`indicesOf`, cached per value); the checker types an index position as an
  open variable (`Index` once written) and checks indices only through
  evaluation (`knownIndices`, the same rule over known values). A family's
  arguments fill by position (`applied`), never "the first open variable",
  which merged `k` and `a` in `Vec k a`. `tests/indexed-family-test.ts`.
- Claim proofs (`index-proofs.ts`) read the AST only, never evaluate: affine
  indices, solved by substitution for the oldest variable (so `n = k + 1`
  reads in the parts' indices). An error needs a constant difference in a
  certain case: simple patterns, no guard, a clause no earlier one covers,
  every equation solved. Anything else proves nothing and is left to the
  runtime check. `define` runs them; proven functions are `provenClaims`.
- The checker never rewrites the program the runtime runs. It reads flat typed
  patterns as typed (`typedForm`, `ast.ts`, a copy) where it takes in a
  definition's clauses (`define`) or a function's parameters (`inferFunction`),
  and `bind` reads one met anywhere else, so every checker pass sees one form;
  the runtime applies the same `flatTypedPattern` when it matches, except that
  it takes `(xs : Vect n a)` apart itself (a length mismatch fails the match;
  a type variable reads no element, see `matchVectorPattern`).
  `tests/vect-pattern-test.ts`.
- A `match` alternative's input starts from `patternInput` (the scrutinee's
  length at cons positions, fresh elsewhere), so its patterns still only test.
  `selfOpen` lets a recursive call pass any length to a parameter whose typed
  pattern binds its length. A claim around a literal `match`
  (`alternativeClaims`) is compared inside `functionType`, while the
  alternative's `lengthFacts` hold; the match keeps a length only when every
  alternative's equals it. `tests/typed-pattern-forms-test.ts`.
- `Z`/`S k` patterns take a number apart by the value they meet (runtime
  `matchPattern`, checker `naturalArgument`), so a program's own `Z`/`S`
  variants keep matching as variants. The parser reads a bare `Z` as nullary
  unless the program declared `Z` with fields. Clauses whose types differ
  only in known-versus-unknown list lengths (`toList Z = []`) are separate
  overload choices, like differing lengths. The checker types a numeric
  constructor pattern's payload untyped (`untypedPayload`), as the runtime
  binds it, but checks a literal payload against the type; unifying function
  types converts at a converting parameter (a recursive `f (k - 1)` for an
  `(k : UInt)` clause). `tests/natural-numbers-test.ts`.
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
  clause a score interval from `patternScore`, which mirrors the run's
  `patternScore` (1 for an argument taken as it is by a type or literal its
  pattern names, 0 for a lossless conversion or no type named) using static
  argument types, and decides whether it definitely matches or fails; equal
  scores are ordered by `clausePlaces`, each side reading types through its
  own `Contains` (`containsPattern` at runtime; here `containsIn`, built-in
  names through `builtinContains`, a program's types by their declarations;
  a scalar type's refinement is a named type there as at runtime, `namedSubtype`). Choices whose clauses all fail, or all come
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
  derives it from list literals, `::`, `++`, callee shapes (`shapeAt`) and
  summaries, and `evaluateCall` gives a `(x::xs)` tail one less.
  `Known.items` holds per-element facts when every element is known (list
  literals, finite integer ranges, `::`, `++`); `evaluateKnown` runs the
  `LIST_NATIVES` (`filter`, `map`, `take`, `drop`) over them by applying the
  function expression to a synthetic `$item`, and applies lambdas (including
  sections) directly. Finite ranges stop at 10000 elements. `Known.fn` is a
  function value (an expression with its env and scope, or a block-local
  definition's clauses with its closure and applied arguments) applied by
  `applyKnown`; a computed value over parameters drops `fn` and `seq`, since
  their closures are only known at the parameters' calls. `Known.cell` is a
  lazy list's memoized first cell (head and tail; `null` when empty) used
  for `::`, endless ranges, `iterate` and the list builtins, mirroring the
  runtime's `cell()`. Walk lists iteratively (`element`, `elementsOf`,
  `dropKnown`), never by recursion over indexes, and never materialize one
  eagerly; `elementsOf` and `dropKnown` spend one unit of work per element,
  and `Known.range` (`rangeKnown`, `rangeElement`) indexes, drops and takes
  integer ranges arithmetically. A clause that walks a range by a tail call
  to itself, its other arguments passed on or moved by a constant (a count),
  takes every step it would repeat at once (`skipRange`): up to the first
  step an earlier clause may take, at a `[]` or at a count's literal, for
  any function so written, not only the prelude's. `evaluateNative` runs the
  pure `EVALUATED_NATIVES`. Depth (`EVALUATION_DEPTH`, which a tail call
  continuing in `evaluateKnown`'s loop does not add to) and work
  (`EVALUATION_BUDGET`, per root via `budgeted`) are bounded, and a
  JavaScript stack overflow (`RangeError`) in static evaluation leaves the
  value unknown, as running out does. `needed` and `resolveKnown` mark such a
  value `cut`; only the checks a type makes of it (`budgetCut`: a factory's
  length, `refinementFails`, a chosen type in `construct` or a ternary) turn
  that into an error, and a name's waiting `expr` goes with its value. So recursion reaches the runtime's own depth with room to
  spare, a call whose one possible clause is known leaves its body as a
  `Tail` (`callStep`, `matchStep`, a ternary, a named call without a result
  shape), which `evaluateKnown` evaluates by looping: an evaluated call costs
  no frames of its own, only what is pending around it (`1 + f x`'s `+`).
  Keep those steps returning a `Tail`, and the pending paths
  (`evaluateBinop`, `evaluateOperator`) free of per-call closures. A ternary or clause set whose first result has no facts stops
  early, so recursion over unknown values stays cheap. A value over
  parameters gets only `SYMBOLIC_BUDGET` (it is decided again at each call);
  one over none gets `QUICK_BUDGET` at first, and if that runs out it waits
  (an `expr` with no bindings) until a check needs it (`needed`, from
  `application` unless the callee is `valueBlind`, and `noClauseMatches`), so
  a value only passed on (`print (fib 24)`) is not computed before the run
  computes it. A result the budget or depth cut short (`finishing`) is never
  kept by `once`, `lazyList` or the per-node cache: a later evaluation, with a
  budget of its own, may finish it. A list's length is never walked when the other side of a `zipWith` or a
  meet is unknown or endless, and argument-free compound expressions are
  cached per node and the bindings of the names they mention
  (`sameBinding`), since nested call arguments are each evaluated.
  Effects (`print`, `echo`, `emit`, `assert`, `debug`) only return their results
  statically. `Known.mutable` is a cell. While `CheckOptions.mutation` (the
  session-wide `mayMutate` scan for `set` and `load`; `use` only exposes
  bindings that scan saw) is false,
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
  through named definitions and `use`d fields) before it is checked; reads in that
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
  `use` opened, and `Entry.bound` for pattern bindings) become `invalid`.
  An opaque `use` here or elsewhere
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
  name new to it one slot (`Known.slot`, read through `lookup`), and a
  rebinding a new version of its known values, as at runtime: lazy
  definitions store a memoized thunk (`once`, which reports a value that
  needs itself as unknown) and eager ones a value.
  A recursive self-reference is marked `recursive` with the clause's
  `selfInputs`, and a recursive call strips the lengths of an argument's data
  that its parameter type leaves open (`withoutOpenLengths`), never those in
  a function's or an action's type (a record of methods keeps `IO []`). A
  single-group definition's entry keeps `alternatives[0]` as its type, which
  carries the summary. A numeric constructor applied to a type variable, or a
  numeric or schema conversion of an undecided operation, defers its
  conversion as a `construct` requirement instead of unifying; so does a list
  indexed by a value not known yet. Compound arguments over
  enclosing parameters become a pending `expr`, re-evaluated after
  substitution. `substituteKnown` substitutes parameters inside pending calls
  and `callArgs`. An overload call that stays ambiguous because its arguments
  are `symbolic` is deferred (`evaluatingCall` keeps one node), and `waiting`
  holds checks on it; so is a call of a typed parameter (`coerce`) with a
  symbolic argument whose type waits (for a list or record schema, in a part
  too: `waitingWithin`; `symbolicArgument` includes list `items`), except
  while trying an overload's choices (`choosing`). Constructors of
  concrete fields are `coerce` functions; a converting payload pattern on a
  concrete field converts it (`bind`). `castPattern` walks a parameter or
  binding pattern beside the argument's known value (variant `payload`s of
  any arity, list `items`, cons cells) and converts each typed part. Record
  literals record their `fields` (lazy in `evaluateKnown`, as list elements
  are; `recordFields` merges spreads in order, and an unknown spread clears
  the fields before it), which `castKnown` converts by name; `fieldExpr`
  names the literal that gives a field its value, if no later spread may. `substituteKnown` skips values it is
  already inside (a recursive function in its own env). `castKnown` converts a
  known argument value to the parameter type (list elements, or a list's
  elements to a record schema's fields, or a one-field variant's `payload`,
  which constructor applications record; a pending `expr` is re-evaluated once
  no longer symbolic); `problem` reports a deferred
  check (a `placeholder`) at the active call, except while the top-level
  definition that deferred it (`operation.within`, `outermost`) is still
  being checked, where it reports at `operation.written`. At the end, checks still waiting only on symbolic values
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
  A library function `shapeOf` cannot analyse declares the length it keeps
  (`reverse (xs : Vect n a) : Vect n a`, its body `: Dynamic`), as a program's
  can; `tests/stdlib-length-test.ts` exercises each.
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
- `Vect n t` uses a type descriptor with `[length, element type]` arguments;
  `list.schema` keeps its contract through index updates and `typeOf`.
- Tests: `tests/strict-checking-test.ts`, `tests/default-checking-test.ts`,
  `tests/gradual-types-test.ts`, `tests/dynamic-boundary-test.ts`,
  `tests/vect-pattern-test.ts`, `tests/record-pattern-checking-test.ts`,
  `tests/recursive-inference-test.ts`; keep `examples/types/` passing under
  ordinary execution and `--check`.

## Editor tooling

`src/lint.ts` and `src/lsp.ts` must never evaluate user code beyond the
checker's bounded evaluator (with `--types`); use
`parseDocument`, which isolates and restores parser declaration registries.
Lint warns only for recognizable families/literal alternatives, handles scope
shadowing conservatively, and doesn't treat guarded patterns as total coverage;
warnings are severity 2 and don't fail CLI lint. In `--lsp` mode stdout is
reserved for JSON-RPC; keep UTF-16 positions and byte-counted Content-Length
framing. `editors/neovim/apn.lua` is opt-in and session-only; don't edit user
configuration. Tests: `tests/lsp-test.ts`.

## Code as data

Code is kept per item, not per list: `Interpreter.writtenItems` maps an item
value to how it was written (expression, scope, the names a binding bound),
and `written` sees through a thunk that only names another value (`x :: acc`
in a fold), so list functions that pass items on keep their code. A list
literal's item must be a fresh value it owns (a binding's is wrapped), never a
shared one. Only `++` (`appendCode`) and an item update (`setIndex`) run items
again, through `rerun`, which is lazy in the spine (`cycle xs = xs ++ cycle
xs` still streams) and reruns only items that `mentions` a changed name.
Items written in one scope share one `Env`, so clauses written as items merge.
The checker mirrors this in `codeList`: a list type's `formula` holds each
item's expression, scope, type and bindings, and `open` the names read
unbound, which `closed` reports where values are needed (any application or
operator but `++` and the functions in `READS_CODE`); `++` after a list whose
code it cannot follow makes them a runtime check. `toAST` reads items with
`intrinsics.syntax` (`sexprOf` of each item's expression; source text, which
the tests and the meta reader compare against, reads with `readSource`): operator
sections become names, partial applications or `"()"` nodes, and an
application's spine is flattened. `lib/std/syntax.apn` loads its printer
(`lib/std/syntax/source.apn`) and `toLambda`'s desugarer (`lib/std/syntax/lambda.apn`)
behind `Dynamic`, as `meta` does, since syntax data mixes leaves and nodes;
both load into one scope, so their `_` helpers need distinct names; `intrinsics.fixity` gives it the parser's fixities. `eval`
parses `fromAST`'s text with the parser itself, spacing rules and line limit
off, so evaluated code cannot drift from written code. Tests:
`tests/syntax-test.ts`.

## Metacircular evaluator

`lib/std/meta.apn` exposes `meta`; the implementation lives in `lib/std/meta/`. It
must never delegate object source to host `parse`, `toAST`, `load`, or an eval
callback, and its core must stay within the reader's supported subset. After
changes run `tests/metacircular-test.ts` and
`deno run --allow-read examples/metacircular-self.ts` (which evaluates the live
evaluator source twice in APN). Document subset limits in
`docs/metacircular-evaluator.md`.

## Browser HTML and p5.js

`src/html.ts` (`BrowserApp`) decodes views, applies messages, runs commands
and lists subscriptions through a `Platform` (deferral, HTTP, file pickers,
the viewport), so tests drive programs with a fake one;
`src/browser-runtime.ts` patches the DOM (writing only the attributes and
styles that changed, with one listener per event that reads the newest
handler: rewriting unchanged ones makes Firefox lay the page out again),
installs subscriptions as passive listeners (as Elm does) and implements the
platform;
`src/build-html.ts` bundles the interpreter and source (`apn --html`, and
`apn --site` with `src/editor.html` and its script `src/editor.ts`, whose
preview runs each program in a sandboxed frame of the editor's origin, as
Elm's editor does, so Firefox keeps it in the page's process). The editor, the REPL and the
language server color with one tokenizer and palette, `src/highlight.ts`;
keep it free of interpreter imports, since the editor bundles it. Commands and subscriptions stay APN data until the host
reads them; a message from a command is applied after the current update.
Run `deno check src/browser-runtime.ts src/editor.ts` as well as `main.ts`. `src/p5.ts`
adapts callbacks to a p5 instance; the runtime loads pinned p5.js only for a
`P5Sketch` or a canvas node, whose sketch persists across renders and takes
each render's callbacks. Keep host methods scoped per interpreter and sketch;
never expose arbitrary host object access. A p5 object is a record with a
description (`p5Object`) that each `P5Sketch` makes on first use; its methods
act on the running sketch (`running`). The method tables (`P5_METHODS`,
`RESULTS`) give both the runtime record and the checker's `Sketch` type, so
add a method there once. Bundled data files reach p5 as blob URLs
(`assetUrl`), fonts as their data URL (CSS takes no blob URL in the editor's
sandboxed frame); the site build gives the editor every example's data files
and each run those its source names. Tests: `tests/html-test.ts`,
`tests/p5-test.ts`, `tests/elm-examples-test.ts`,
`tests/p5js-examples-test.ts`; also build `examples/elm` and `examples/p5js`
with `apn --site` and run their pages in a browser.

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
