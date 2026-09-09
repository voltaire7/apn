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

`x = x` cannot produce even an outer value. Demanding it waits indefinitely
until interrupted, using bounded memory; Ctrl+C returns control to the REPL.
Failed or interrupted evaluations leave the interpreter usable.

The right operand of `:` must be a list. When a cons expression is evaluated,
a visibly non-list tail such as the literal in `x = x:1` raises an APN error
without evaluating its head. Computed tails are checked when demanded, preserving
`head (1:missing)`. Displaying a value nested inside itself also raises a clear
error; ordinary recursive list spines such as `x = 1:x` still stream.

## Definitions and actions

Ordinary named definitions do not execute their bodies when defined.
`foo = _` declares an unfinished value; `f x = _` an unfinished function body.
The `_` expression raises "not implemented" only when evaluated. It remains a
wildcard in patterns. Both sides of `=` are required: `foo =`, `foo = ;`, and
`= bar` are syntax errors. Use `foo = ()` for unit. An indented body may follow
`=` on the next line in a complete source chunk; a same-level line may not.

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

Numbers follow a Scheme-style tower: exact arbitrary-precision integers and
reduced rational fractions, inexact binary64 reals, and complex numbers whose
components are real numbers. Exactness is separate from mathematical type:
`isInteger 3.0` is true and `isExact 3.0` is false. Arithmetic with an inexact
operand produces an inexact result only when conversion of the exact operand
is lossless. Otherwise use `cast Float` or `inexact` explicitly. Exact `/` returns reduced fractions;
`quotient` truncates integer division. `%` and `remainder` follow the dividend's
sign; `modulo` follows the divisor's sign. Exact zero division raises an error;
inexact division can produce IEEE infinities and NaNs.

Integers use `BigInt` throughout lexing, parsing, arithmetic and formatting.
APN literals include `0xFF`, `0b11010100`, `0o235461`, `.5`, and `1.2e-3`.
Scheme `#` prefixes are not used: `#` remains a comment. Fractions use ordinary
APN division (`1 / 3`); complex values accept an adjacent imaginary suffix (`1i`, `3+4i`, `.5i`),
or use `makeRectangular 3 4` or
`makePolar radius angle`. Complex output is `3+4i`. `parse` reads numeric text,
including fraction and complex output, without evaluating arbitrary APN code.

`exact` converts the actual binary floating-point value to an exact fraction:
`exact .5` is `1/2`, while `exact .1` is
`3602879701896397/36028797018963968`. `inexact` rounds an exact number to binary64.
The printer distinguishes `3` from `3.0` and preserves `-0.0`; infinity/NaN print
as `+inf.0`, `-inf.0`, and `+nan.0`. `parse` understands these spellings.

Finite numeric comparisons compare exact represented values, including mixed
exact/inexact inputs, without rounding a large exact operand first. Thus
`9007199254740993 > 9007199254740992.0` is true. NaN is unequal to every number
including itself, and ordered comparisons involving NaN are false. Non-real
complex numbers support equality but not ordering. Integer literal patterns
use numeric equality, so a pattern `1` also matches `1.0`.

All-exact ranges use exact arithmetic, including fractional bounds and steps:
`[0,1/2..2]` yields `[0, 1/2, 1, 3/2, 2]`. A float anywhere in the bounds or
step promotes the whole range to binary64, including `[0,1/2.0..2]`.

The numeric API uses APN camelCase names and fixed arities. Unary predicates:
`isNumber`, `isComplex`, `isReal`, `isRational`, `isInteger`, `isExact`,
`isInexact`, `isZero`, `isPositive`, `isNegative`, `isOdd`, `isEven`,
`isFinite`, `isInfinite`, `isNaN`. Unary operations: `exact`, `inexact`,
`numerator`, `denominator`, `floor`, `ceiling`, `truncate`, `round`, `sqrt`,
`abs`, `realPart`, `imagPart`, `magnitude`, `angle`, `conjugate`, `exp`, `log`,
`sin`, `cos`, `tan`, `asin`, `acos`, `atan`. Binary operations: `quotient`,
`remainder`, `modulo`, `gcd`, `lcm`, `min`, `max`, `expt`, `makeRectangular`,
`makePolar`, `atan2`, `rationalize`. `round` uses ties-to-even. Perfect square
roots of exact rationals remain exact; other roots and transcendental values
use floating-point approximations (with complex results when required).

This adopts the general numeric model, not implementation-specific Chez
fixnum/flonum optimization APIs or MIT machine-format controls. APN's existing
operators retain their arities and collection overloads.
References: [MIT Scheme numbers](https://groups.csail.mit.edu/mac/ftpdir/scheme-7.4/doc-html/scheme_5.html)
and [Chez Scheme numeric operations](https://www.scheme.com/csug8/numeric.html).

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


## List index assignment

`arr 0 = 10` rebinds an existing list to a modified copy in the current scope,
like record field assignment. `arr (-1) = 10` updates its final element.
The index must be one integer literal; negative indexes require a finite list.
Positive updates traverse only as far as the selected cell, leaving unused
heads and the remaining tail deferred. Bounds errors leave the binding unchanged.
The RHS is evaluated against the old binding before it is replaced. Consecutive
index assignments execute in order. Inside a block the update shadows the outer
binding. On an unbound name or an existing function, the same syntax remains a
literal-pattern function definition (`f 0 = 10`).


Leading-dot decimals such as `.1`, `.2`, and `-.5` are float literals. Like other
floats, `.1 + .2` yields `0.30000000000000004` under binary floating-point
arithmetic. An attached numeric field access (`rec.1`) stays record access;
whitespace allows a float argument (`print .1`). Range dots (`[1..3]`) are unchanged.


Float ranges support finite and infinite forms, including `[0,0.5..100]` and
`[0,.5..]`. Each value is calculated from the origin and an index to avoid
accumulating rounding error. A small endpoint tolerance includes bounds affected
by floating-point rounding; it is capped at half a step. Integer ranges remain
exact, while mixed ranges inherit float precision. A floating range that can no
longer advance reports an error. Range patterns remain integer-only.

A lambda with an explicit `{ ... }` body ends at the closing brace. Operators
following that brace belong to the surrounding expression: `[1, 2] * x ->
{ x + 1 } * x -> x * 2` produces `[4, 6]`. Unbraced lambda bodies continue
to consume a full expression.

Definition brace layout is mandatory: write `func = {` on one line. In a
multiline brace block, each statement starts exactly four spaces deeper than
that opening line, and the closing `}` aligns with the opening line. Inline
`func = { expr; expr }` is valid. A newline after `=` may introduce an indented
expression, but never an opening `{`, even for an inline block.

In the interactive REPL, Enter submits except immediately after an opening
`(`, `{`, or `[` (allowing whitespace), where it inserts an indented newline.
Inside a bracket opened on an earlier line, Enter continues at the current
indentation. An unfinished single-line `[1,2,3` submits and reports a syntax error. Shift+Enter reverses that choice, even
for invalid code. Brackets inside strings/comments are ignored. Option-arrow
keys move by word. Shift+Enter requires distinct terminal key encoding (Kitty
keyboard protocol or xterm modifyOtherKeys).

Bounded character ranges such as `['a'..'e']` produce strings. They follow
Unicode scalar order (skipping surrogate code points); descending bounds reverse
the direction. These strings are finite and constructed eagerly.

`iterate f seed` produces the lazy infinite sequence `seed`, `f seed`, and so
on. Taking zero elements does not evaluate either argument; taking one does
not call `f`. Sequential consumption supports long sequences. As with other
nested deferred computations, skipping many unevaluated elements then demanding
a value that depends on all of them can hit the evaluator's stack limit.

Experimental function-minus overload: `f - x` applies a function `f` to the
negated numeric value of `x`. It accepts native functions, lambdas, and named
functions (including partial applications). Both operands are demanded as for
ordinary subtraction. `sqrt -1` and `sqrt - 1` both produce `0+1i`.
Numeric subtraction is unchanged. Precedence and associativity are unchanged:
`sqrt -1 * 4` means `sqrt -(1 * 4)`, while `sqrt -1 + 2` means
`(sqrt -1) + 2`. Use parentheses when a different grouping is intended.

Polar literals use `radius@angle`, e.g. `2@3`, with angles in radians.
The angle may have a sign, and decimal/exponent notation is accepted. They
evaluate like `makePolar radius angle` and display in rectangular form.
Use `makePolar` for computed radius/angle expressions.

An exact zero polar angle returns the radius unchanged, avoiding floating-point
conversion: `2@0` is exact `2`, and `makePolar (1/3) 0` is exact `1/3`.
An inexact radius stays inexact; an inexact angle still uses trigonometry.

## First-class types

`Int` and `UInt` are arbitrary-precision signed/unsigned integers. Fixed-width
constructors are `Int8`, `Int16`, `Int32`, `Int64`, `Int128` and matching `UInt`
variants. `Float` (`Float64` is an alias) uses binary64; `Float32` uses binary32.
`Fraction` holds an exact rational, `Complex` any numeric complex value, and
`ComplexExact` an exact one. Constructors are first-class functions, e.g.
`map Int [1,2]`. Constructed values print their type: `Int32 123`.

Constructors only accept lossless conversions. `Int 3.0` works; `Int 3.7` errors.
`Float32 .5` works; `Float32 .1` needs `cast Float32 .1`. The explicit form is
`cast Type value` or `value $ cast Type`. Casting to integers truncates toward
zero. Out-of-range integers always error rather than wrap, and nonzero imaginary
parts cannot be silently discarded. Bare numeric literals still work.

Arithmetic between values of the same concrete type retains that type and
checks integer overflow. An untyped operand is converted losslessly to the
other operand's type when possible. Two differing explicit types try the broader
existing operand type first, using value-based lossless conversion. If neither
fits, arithmetic uses the numeric tower; exact-to-inexact conversion must still
be lossless. Integer `/` can produce a typed `Fraction`. Float32 arithmetic
rounds each result to binary32. Numeric native functions return their natural
numeric result types; use a constructor to impose a specific width on them.

`typeOf value` returns a type descriptor. `isType Type value` tests membership
without casting. `Number`, `Real`, `Integer`, `Exact`, and `Inexact` are aggregate
numeric guards. For example `isType Number (Int32 1)` is true.

Typed overloads use constructor patterns:

```apn
add (Int x) (Int y) = x + y
add (Float x) (Float y) = x + y
add (Number x) (Number y) = x + y
```

Literal matches outrank exact concrete type matches, which outrank aggregate
matches, which outrank lossless conversion matches. Ties retain source order.
This ranking applies to functions with typed clauses; ordinary pattern functions
keep source order. Arguments bound by concrete type patterns retain the type.
Repeated variable names assert equality, so `(Number x) (Number x)` is not a
catch-all for two different numbers.

`100 * _ -> Int 0` repeats the typed value using the existing function iteration
overload. Two numeric operands always multiply: `100 * Int 0` returns `Int 0`
and `Int 3 * Int 2` returns `Int 6`.

## HashMap

`HashMap [["x", 123]]` constructs from an association list; `HashMap ["x": 123]`
constructs from a record. Empty construction is `HashMap []`. Keys may be finite
numbers, strings, chars, booleans, or unit. Numerically equal keys share an entry
regardless of exactness or numeric type; distinct strings/chars stay distinct.
Duplicate keys keep the last value. Insertion order is preserved for traversal.

`HashMap [] $ insert ["x": 123]` returns a map containing x. `insert` accepts a
record or association list; `remove key map` returns a map without the key.
Updates preserve the old map. `lookup key map` or `map key` retrieves a value,
raising an error when absent; use `has key map` when absence is expected.
`keys`, `values`, `pairs`, `length`, and `null` operate on maps. Association-list
values stay lazy; keys are evaluated at construction. Record inputs follow the
existing record evaluation rules. `(HashMap m)` is a type pattern.

Type constructors also work directly with function iteration: `100 * Int`
returns `Int 0` through `Int 99`; `[1..100] * Int` returns `Int 1` through
`Int 100`. This differs from `100 * Int 0`, which multiplies and returns `Int 0`.

The nonnumeric types returned by `typeOf` are also first-class constructors:
`Bool`, `String`, `Char`, `Unit`, `List`, `Record`, `Function`, `Type`, and
`Variant`. They validate and return a value of the corresponding kind, without
forcing list elements or coercing unrelated values. Their constructor patterns
work in overloads, e.g. `f (Bool x) = x`. `isType` and identity `cast` support
these types too. Use declared constructors to create a particular variant;
`Variant` validates any such value.

A lowercase pair pattern `(t x)` captures the runtime type descriptor in `t`
and the original value in `x`. For example, `myTypeOf (t x) = print t`.
It inspects the outer value without forcing list contents. Repeating the type
variable, as in `(t x) (t y)`, requires both arguments to have the same type.


## Standard module imports

`import "std"` (or `std/function`, `std/option`, `std/sequence`, `std/number`,
`std/text`, `std/map`) evaluates a bundled module once per interpreter and brings
its exports into the current scope. Module evaluation uses an isolated scope
with builtins and explicit dependencies; caller bindings do not affect it.
Reimporting installs the cached exports again. Imports return an export record.
A definition such as `s = import "std"` defers importing until demanded.
Names resolve relative to the APN installation, independently of sourceDir.
`load` remains uncached file execution relative to the current source file.
See [the standard library reference](standard-library.md) for APIs and limits.


## REPL clauses and range syntax

Separate REPL submissions extend existing function clauses of the same arity.
An equivalent parameter pattern replaces its previous clause in place; fresh
patterns are appended. Renaming a parameter does not create another overload.
Numeric literal/type dispatch retains its normal specificity rules. Module
loading retains its existing definition behavior.

Range expression bounds may now be runtime expressions: `[1..n]`, `[a,b..end]`,
`[start..]`. They must evaluate to real numbers. Existing automatic descending
steps are preserved, so `[1..0]` is `[1,0]`; std factorial handles zero separately.
