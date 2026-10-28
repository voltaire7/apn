# Named subtypes, variant indexing, and scoped resources

These features use ordinary definitions. There are no new keywords.

## Named subtypes

`:=` with a scalar type (a numeric type, `String`, `Bool` or `Char`) names a
subtype of it; `=` only gives the type another name (`Count = Int` is `Int`):

```apn
UserId := Int               # a named subtype of Int
OrderId := Int

UserId 123                  # UserId 123
UserId == Int               # false
extract (UserId value) = value
extract (UserId 123)        # 123
UserId 2 + 1                # UserId 3
UserId 1 + OrderId 1        # error: cannot combine UserId and OrderId
```

A `UserId` is an `Int` wherever an Int is accepted: `(Int x)` patterns, numeric
builtins (`sqrt`), and arithmetic with plain numbers, which keeps the name. An
Int is not a `UserId`: a `(UserId x)` pattern accepts only that name, binding the
payload to `x`, and outranks an `(Int x)` clause for a UserId. Two different
names never mix: arithmetic between them is an error, and they are not equal
(`UserId 3 == OrderId 3` is false, though each equals `3`). Constructors check
the base type; construction from another named type requires extracting its
payload first. Applying the base type (or another base type) is that
extraction: `Float (UserId 3)` is `3.0`, `Int (Money 1.0)` is `1`, and
`OrderId (Int (UserId 3))` is `OrderId 3`. Aliasing a named subtype (`Alias = UserId`) keeps its identity.
Aliases of other types (records, `Vect n Int`, parameterized aliases) remain
plain aliases. An omitted record slot initialized from a named type wraps its
base's default.

For a type that is not accepted as its base, declare a single-constructor
variant (`Meters = | MkMeters Float`) and unwrap it with a pattern.

## Variant list indexes

Families whose constructors all have no payload can index lists, starting at
zero in declaration order:

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
same integer ordinals and return ordinary numbers. For example, `East + 1` is
`2`, `West / South` is `3/2`, and `-East` is `-1`. Numeric collection arithmetic
uses the same rule for elements. APN's existing numeric rules still apply.
Variants retain their identity when printed, pattern-matched, or compared for
equality; `North == 0` remains false. Constructors such as `Direction` and
families with payloads do not participate in ordinal arithmetic.

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
import "function"
released = Mutable false
answer <- bracket 42 (_ -> set released true) (n -> [n, n + 1])
# answer is [42,43]; released is true
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
import "io"
text <- withFile "input.txt" (file -> file.read)
```

`file.read` is the action reading the remaining contents; an additional
read at EOF returns an empty string. The file closes even on failure. Stashed
read handles explicitly reject use after closure. Returned lazy reads are
completed before closing. File access uses the existing Deno read permissions.
