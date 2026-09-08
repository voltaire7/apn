# APN evaluation rules

This describes the current interpreter, including its limitations. The examples
are checked by `deno test semantics_test.ts`. APN defers evaluation, but does not
provide Haskell's uniform call-by-need semantics. Changes to these rules should
update this document, the assertions, and `features.txt` together.

## Definitions and actions

Ordinary named definitions do not execute their bodies when defined.

| Definition | What it binds |
| --- | --- |
| `f x = x + 1` | A pattern-dispatch function |
| `f = x -> x + 1` | A lambda closure |
| `a = { print 3; 4 }` | A repeatable zero-argument action |
| `a = print 3` | A repeatable action (application body) |
| `a = 3 $ print` | A repeatable action (pipe body) |
| `v = 1 + 2` | A deferred value, internally a thunk |

The parsed body determines the category. Blocks, applications, and pipes are
actions; other non-lambda bodies are thunks. Parentheses are statement groups,
so introducing a group can change evaluation behavior. Destructuring bindings
are an exception to deferred definition: they evaluate and force the RHS to
match the pattern immediately.

## When code runs

- A bare expression statement runs zero-argument actions and re-evaluates thunk
  bodies. Its final value is forced. File mode does not automatically print it.
- Arithmetic operands, ternary conditions, match scrutinees, and ordinary native
  arguments demand values. Demand runs zero-argument actions and forces thunks.
  `print action` therefore runs the action; repeated uses repeat its effects.
- Applying an action to an argument first runs the action, then applies its
  result. This permits `addTwo = add 2` followed by `addTwo 10`.
- Blocks create a child scope, execute their statements, and return the last
  result. Definitions inside the block shadow outer bindings.
- Only the selected ternary branch runs.

`quote` and `toAST` inspect syntax without evaluating their arguments. `debug`
forces its argument but does not demand a returned zero-argument action:
`a = print 3; debug a` prints `a` without printing `3`. It is not a general
side-effect-free inspection primitive: forcing other expressions can run code.
`step` is a separate expression-inspection/evaluation facility demonstrated in
`features.txt`. `toString`, like `print`, demands its argument.

## Memoization is limited

Do not assume a named value is computed once. `force` caches a result on the
thunk it receives, but following a chain of thunks does not populate every
intermediate binding's cache. Each application supplies a fresh argument thunk.
As a result, this prints `2, 3, 2, 3`, on separate lines:

```text
value = (print 2) + 1
print value
print value
```

Bare value statements also re-evaluate their bodies without using a cached
result. Actions intentionally repeat. These are current behaviors captured by
regression tests, not a promise of uniform memoization. A future call-by-need
design would need an explicit decision about effects and rebinding.

## Arguments and patterns

Lambda arguments and arguments to all-variable function clauses are deferred.
`first x y = x; print (first 7 missing)` prints `7` without resolving `missing`.
A clause with a non-variable pattern demands **all** its arguments before
matching, even ones that its body does not use. Demanded arguments are reused
across pattern-clause fallthrough within that call, so a side-effecting argument
is not run again for each attempted pattern.

## Collections

List literals defer their elements until forced. Forcing a list evaluates all
its elements and recursively forces nested lists and variants. Consequently,
`head [1, missing]` and `head [1, [missing]]` both fail on `missing`. Lists are
not lazy streams and self-referential cons tails are not supported.

Finite ranges materialize when forced. Infinite ranges remain range values;
`head [3..]` returns `3` without materializing the range. Printing an infinite
range streams indefinitely. The test suite does not attempt unbounded output.

Record literals evaluate field expressions when the record is evaluated.
Forcing records leaves thunk-valued fields deferred, which allows module
records to contain definitions such as `halt`. A record is not uniformly lazy
in the same way as a list literal.

## Scope and numbers

Environments are lexical but shared and mutable. A deferred expression can see
later rebinding in its captured scope. With `n = 1; value = n + 1; print value;
n = 10; print value`, the output is `2` then `11` under current memoization.

Integers and floats are distinct runtime tags. Arithmetic does not implicitly
mix them: `1 + 2.0` is an error. Integer division truncates toward zero. Integer
storage uses JavaScript numbers, not arbitrary-precision integers.

## Verification

Run from the repository root:

```sh
deno check main.ts
deno test semantics_test.ts
deno run --allow-read main.ts features.txt
```

The assertions check observable output and expected errors. The showcase remains
the broader runnable syntax reference. Interactive terminal behavior is outside
this suite's coverage.
