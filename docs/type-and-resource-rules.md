# Distinct types, variant indexing, and scoped resources

These features use ordinary definitions. There are no new keywords.

## Distinct types

`=` names a type: `Count = Int` makes `Count` another name for `Int`, the
same values (`Count <= Int` and `Int <= Count` are both `True`), so a
`(5 : Count)` is an `Int` and arithmetic on it gives one.

```apn
Count = Int

(5 : Count) + 1             # 6
typeOf (5 : Count)          # Int
(1 : Count) + (2 : Age)     # 3, with Age = Int: both are Ints
```

A type of its own is a constructor (see
[variants](templates-and-types.md#variants-parameters-and-distinct-wrappers)):
`UserId (id : Int) = _` declares `UserId`, whose one field is an `Int`. It has
none of an `Int`'s operations, only those its clauses and instances define: a
`to Int` instance lets it stand wherever an `Int` is needed (a typed parameter,
a builtin, arithmetic with a plain number), as `to` does for any type.

```apn
UserId (id : Int) = _
OrderId (id : Int) = _

UserId 123                  # UserId 123
UserId 3 == UserId 3        # True: every value has equality and printing
extract (UserId value) = value
extract (UserId 123)        # 123
UserId 2 + 1                # error: + cannot combine UserId and Int
UserId a + UserId b = UserId (a + b)
UserId 2 + UserId 1         # UserId 3
```

A `UserId` is not an `Int`: `(x : Int)` patterns, builtins (`sqrt`) and `Int (UserId
3)` reject it, and it equals no plain number (`UserId 3 == 3` is false). Its own
pattern, `(UserId x)`, takes it apart and binds the `Int` to `x`; that pattern
accepts only a `UserId`. Applying `UserId` makes one from an `Int`, checking the
value as `Int` would (`UserId .2` is a lossy conversion); nothing else converts
to one (`UserId (OrderId 3)` and assigning `3` to a `UserId` slot are errors).
Its name is also its type where a type is expected: an omitted record slot
(`[id : UserId] []` is `[id = UserId 0]`), another constructor's field
(`Order (UserId u) (n : Int) = _`), `isType UserId`, `List UserId`.

```apn
to Int (UserId n) = n
double (n : Int) = n * 2
double (UserId 4)           # 8
UserId 9 + 1                # 10: + takes the Int to Int gives
```

## Variant list indexes

An enumeration, a family whose constructors all have no payload, gives each
value its position as an `Int`, from zero in declaration order: declaring
`Direction = North | East | South | West` also declares `to Int North = 0`
through `to Int West = 3`. So its values index lists and take part in
arithmetic, as any value with a `to Int` does
([conversions](semantics.md#defining-and-overloading-operators)):

```apn
Direction = North | East | South | West
offsets = [[0,-1],[1,0],[0,1],[-1,0]]
offsets North               # [0,-1]
offsets North = [0,0]
offsets North               # [0,0]
```

This uses ordinary list indexing and assignment, including bounds checks and
scoped copy updates. Computed variant values work too. Lists have no key-family
annotation: any eligible family's second constructor selects index 1. Families
with payload constructors are not eligible, even for their nullary cases.
Arithmetic operators `+`, `-`, `*`, `/`, `%`, `^`, and unary negation use these
same positions and return ordinary numbers, and an `(i : Int)` parameter takes
them. For example, `East + 1` is
`2`, `West / South` is `3/2`, and `-East` is `-1`. Numeric collection arithmetic
uses the same rule for elements. APN's existing numeric rules still apply.
Variants retain their identity when printed, pattern-matched, or compared for
equality; `North == 0` remains false. Constructors such as `Direction` and
families with payloads have no positions.

## Exhaustiveness diagnostics

The linter/LSP warns when a known variant family has no unconditional handler
for one or more constructors in a literal `match` list. Local family declarations,
direct constructor expressions, `(Family value)` parameters, and explicitly
imported `option` families provide the necessary information. Catch-all
lambdas cover everything. Guards and constrained payload patterns do not prove
coverage. Unknown or dynamically constructed alternatives remain runtime-checked.

Warnings never evaluate source and do not turn a successful lint command into an
error exit. This is a conservative diagnostic, not a static type system or proof
of exhaustiveness for arbitrary programs. Runtime `match` semantics are unchanged.

## Assertions

```apn
area w h = assert (w >= 0 && h >= 0) (w * h)
```

`assert c x` is `x` once `c` holds, as Haskell's: `x` may be a value or an
action (`assert ok (print "ready")`), in any monad. `c` must be truthy; on
failure it reports the original condition expression, file name and line,
with a source caret. Aliases such as `check = assert` work too. `<repl>` identifies interactive source. Wrapped
calls report the expression passed to the intrinsic, not a reconstructed call
stack. Assertions are always enabled and evaluate their argument once.

## Scoped resources

`function` exports `bracket acquire release use`, an action. Running it
acquires a value once (running `acquire` if it is an action), runs
`use resource`, finishes its returned data, and runs `release resource`
in a finally block. Both callbacks must accept one remaining argument; they are
validated before acquisition. Cleanup runs on successful completion, callback errors,
errors forcing lazy results, and normal interpreter interruption. Acquisition
failure does not run cleanup. Nested scopes release in reverse order. As with
other process-level effects, forced process termination cannot run APN cleanup.

```apn
std <- import "std"
use std.function
released = Mutable False
answer <- bracket 42 (_ -> set released True) (n -> [n, n + 1])
# answer is [42,43]; released is True
```

The returned value must be finite data: lists, records, variants and HashMaps are
traversed while the resource is alive. Callable values, type descriptors, pointers,
actions and mutable references cannot be returned. Cyclic data errors; an infinite list
will not finish without interruption. This boundary is intentionally strict to
prevent deferred reads after cleanup. A failing cleanup propagates its own error.
A generic bracket cannot prevent a callback from stashing a resource elsewhere;
resource implementations must enforce their own lifetime.

`io` exports `withFile path use`, a read-only UTF-8 file scope:

```apn
std <- import "std"
use std.io
text <- withFile "input.txt" (file -> file.read)
```

`file.read` is the action reading the remaining contents; an additional
read at EOF returns an empty string. The file closes even on failure. Stashed
read handles explicitly reject use after closure. Returned lazy reads are
completed before closing. File access uses the existing Deno read permissions.
