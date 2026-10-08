# Distinct types, variant indexing, and scoped resources

These features use ordinary functions. There are no new keywords.

## Distinct types

```apn
Count = Int                 # alias
UserId = distinct Int       # fresh nominal identity
OrderId = distinct Int

UserId 123                  # UserId 123
UserId == Int               # false
extract (UserId value) = value
extract (UserId 123)         # 123
```

Constructors check the underlying type. Construction from another distinct type
requires explicitly extracting its payload first. A `(UserId x)` pattern accepts
only that identity, and binds the payload to `x`; a generic `(t x)` also exposes
the type and payload. Ordinary record templates remain structural. Distinct
record/list types can wrap those templates when identity is wanted.

Bind the constructor once. Each evaluation of `distinct` creates a new identity;
ordinary capitalized aliases memoize it. Aliasing an existing distinct type
preserves its identity. Parameterized factories invoking `distinct` create fresh
identities per specialization evaluation, rather than interned generic types.

Binary numeric arithmetic requires both operands to have the same distinct type,
checks the underlying numeric rules, and preserves the wrapper. Ordering and
unary negation likewise operate on numeric payloads. Equality distinguishes
nominal identities. Other operations, native numeric functions, and FFI calls
use explicit payload extraction. An omitted record slot initialized from a
distinct type wraps its underlying default.

## Variant list indexes

Families whose constructors all have no payload can index lists, starting at
zero in declaration order:

```apn
Direction = North | East | South | West
offsets = [[0,-1],[1,0],[0,1],[-1,0]]
offsets North               # [0, -1]
offsets North = [0,0]
offsets North               # [0, 0]
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
imported `std/option` families provide the necessary information. Catch-all
lambdas cover everything. Guards and constrained payload patterns do not prove
coverage. Unknown or dynamically constructed alternatives remain runtime-checked.

Warnings never evaluate source and do not turn a successful lint command into an
error exit. This is a conservative diagnostic, not a static type system or proof
of exhaustiveness for arbitrary programs. Runtime `match` semantics are unchanged.

## Assertions

```apn
assert (length [1,2] == 3)
```

`assert` requires a truthy value and returns [] on success. On failure it reports the
original argument expression, file name and line, with a source caret. Aliases
such as `check = assert` work too. `<repl>` identifies interactive source. Wrapped
calls report the expression passed to the intrinsic, not a reconstructed call
stack. Assertions are always enabled and evaluate their argument once.

## Scoped resources

`std/function` exports `bracket acquire release use`. It acquires a value once,
calls `use resource`, finishes its returned data, and calls `release resource`
in a finally block. Both callbacks must accept one remaining argument; they are
validated before acquisition. Cleanup runs on successful completion, callback errors,
errors forcing lazy results, and normal interpreter interruption. Acquisition
failure does not run cleanup. Nested scopes release in reverse order. As with
other process-level effects, forced process termination cannot run APN cleanup.

```apn
import "std/function"
released = Mutable false
answer <- bracket 42 (_ -> set released true) (n -> [n,n + 1])
# answer is [42, 43]; released is true
```

The returned value must be finite data: lists, records, variants and HashMaps are
traversed while the resource is alive. Callable values, type descriptors, pointers,
and mutable references cannot be returned. Cyclic data errors; an infinite list
will not finish without interruption. This boundary is intentionally strict to
prevent deferred reads after cleanup. A failing cleanup propagates its own error.
A generic bracket cannot prevent a callback from stashing a resource elsewhere;
resource implementations must enforce their own lifetime.

`std/io` exports `withFile path use`, a read-only UTF-8 file scope:

```apn
import "std/io"
text <- withFile "input.txt" (file -> file.read)
```

`file.read` reads the remaining contents. It is a nullary action and an additional
read at EOF returns an empty string. The file closes even on failure. Stashed
read handles explicitly reject use after closure. Returned lazy reads are
completed before closing. File access uses the existing Deno read permissions.
