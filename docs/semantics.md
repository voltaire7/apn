# APN evaluation rules

APN uses call-by-need for deferred values, function arguments, list elements,
cons tails, and variant fields. Forcing reveals the outer value and memoizes it;
it does not recursively evaluate a whole collection. Explicit actions remain
repeatable, as described below. `tests/semantics-test.ts` asserts these rules.

## Recursive lists

These definitions are productive because each produces a cons cell before its
recursive tail is needed:

```text
x = 1:x
print (take 5 x)       # [1, 1, 1, 1, 1]

fibs = 0 : 1 : zipWith (+) fibs (tail fibs)
print (take 12 fibs)   # [0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89]
```

Entering `x` or `fibs` in the REPL streams elements until Ctrl+C. `print` and
`emit` also stream lists, including nested ones. File mode executes bare
expressions without echoing them; use `print x` to stream from a file.

`x = x` cannot produce even an outer value. Demanding it reports a cyclic
evaluation error. Failed or interrupted evaluations leave the interpreter usable.

## Definitions and actions

Ordinary named definitions do not execute their bodies when defined.

| Definition | What it binds |
| --- | --- |
| `f x = x + 1` | A pattern-dispatch function |
| `f = x -> x + 1` | A lambda closure |
| `a = { print 3; 4 }` | A repeatable zero-argument action |
| `a = print 3` | A repeatable action (application body) |
| `a = 3 $ print` | A repeatable action (pipe body) |
| `v = 1 + 2` | A memoized deferred value |
| `xs = 1:xs` | A memoized cons cell with deferred head and tail |

The parsed body determines the category. Blocks, applications, and pipes remain
APN actions; other non-lambda bodies are thunks. This is an intentional APN
convention, not uniform Haskell semantics. Parentheses are statement groups, so
introducing a group can change the definition's category.

An action runs when used as a statement or demanded by an operand or native.
`a = print 3; a; a` prints twice. Applying an action first runs it and applies its
result, so `addTwo = add 2; addTwo 10` still works. To define reusable lazy data
through a function, write a parameterized producer such as `numbers n = n :
numbers (n + 1)`; its result is a lazy list.

## Memoization and effects

All thunks traversed in an alias chain share the resulting outer value. Repeated
uses of a deferred value, including bare statements, reuse that value:

```text
value = (print 2) + 1
print value           # prints 2, then 3
print value           # prints only 3
```

List elements and arguments likewise share demanded results. An action passed
as an argument runs at most once when that argument thunk is demanded within
the call. A new call creates new argument thunks. Direct uses of the action
itself remain repeatable.

This changes earlier behavior: native calls no longer accidentally recompute
named deferred values. Side effects inside unused list elements no longer run.
Use `*` iteration for explicitly executing an operation over every element;
`map` produces a lazy result and only demanded elements execute its function.

## Lists and consumers

- `:` defers both head and tail. List literals defer each element.
- `head` demands only the first element; `tail` does not demand the discarded
  head. `head [1, missing]` is `1`.
- `take n xs` produces up to `n` elements; `take 0 missing` is `[]`.
  `drop n xs` skips cells without evaluating their heads. Counts must be
  non-negative integers.
- `map`, `filter`, `zipWith`, and list `++` produce cells on demand. `filter`
  evaluates as many predicates as necessary to find the next retained element.
  `zipWith` stops when either input ends (inspecting the left input first).
- `foldr` passes a deferred recursive result to its function, permitting an
  early result on an infinite input. `foldl` traverses the entire input.
- Positive indexing traverses only through the requested element. Negative
  indexing needs the end of the list. Multi-index selection retains its existing
  behavior, including returning a scalar for a single selected index.
- `null` inspects emptiness; `length` traverses cells without demanding heads.
  Equality compares elements incrementally and stops at the first mismatch.
- Finite and infinite ranges use the same incremental consumer interface.

Operations requiring a complete result—such as `length`, negative indexing,
`foldl`, `toString`, and full-list equality—may never finish on infinite inputs.
Use `take` when a finite result is required. Integers have arbitrary precision, so Fibonacci values remain exact instead
of rounding or overflowing to `Infinity`. Their growing size still uses memory.

## Patterns, variants, and scope

Variable and wildcard patterns leave their arguments deferred. Other patterns
force only the structure they inspect. A cons pattern binds a lazy head and
lazy tail; an exact-length list pattern checks the spine length. Pattern-clause
fallthrough shares argument thunks, preventing duplicate evaluation of an
already demanded argument. Variant construction defers its fields.

Destructuring definitions immediately perform the pattern match, but bound
variables remain deferred. Blocks create child scopes. Environments are lexical
and shared: an unforced binding can observe later rebinding, while a memoized
value retains its result after rebinding. Only the selected ternary branch runs.

Record literals retain their existing field-expression evaluation behavior;
records do not become uniformly lazy. Rendering resolves ordinary data fields
but shows zero-argument action fields as functions, so inspecting a module does
not execute its `halt` action.

## Inspection and numbers

`quote` and `toAST` inspect syntax without evaluating their arguments. `debug`
forces its argument without running a returned action: `a = print 3; debug a`
prints `a`. Forcing other expressions can still have effects. `step` retains
its expression-inspection/evaluation rules demonstrated in `examples/features.apn`.
`toString` demands its argument and collects its full rendering into a string.

Integers and floats remain distinct runtime tags: `1 + 2.0` is an error.
Integers use `BigInt` throughout lexing, parsing, arithmetic, ranges, patterns,
and formatting. Decimal literals need no suffix; `9007199254740993` stays exact.
Integer division truncates toward zero; remainder has the dividend's sign.
Division and remainder by zero raise runtime errors. Ranges require integer
bounds and use integer arithmetic for constant expressions. Floats retain
JavaScript-number precision and fractional arithmetic.

Indexes and counts remain arbitrary-precision until a checked conversion is
needed for a host array index. `exit` accepts a signed 32-bit status, matching
its host boundary; larger values raise an error instead of being rounded.

## Verification

```sh
deno check main.ts
deno test tests/*-test.ts
deno run --allow-read main.ts examples/features.apn
```

The assertions cover finite prefixes, shared effects, patterns, errors, and
streaming/interruption recovery. The showcase is the broader syntax reference.
