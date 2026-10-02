# APN evaluation rules

APN uses call-by-need for deferred values, function arguments, list elements,
cons tails, and variant fields. Forcing reveals the outer value and memoizes it;
it does not recursively evaluate a whole collection. Explicit actions remain
repeatable, as described below. `tests/semantics-test.ts` asserts these rules.

## Operator precedence and associativity

From tightest to loosest binding; operators in the same row have equal precedence.

| Operation | Associativity | Grouping example |
| --- | --- | --- |
| Field access and pluck `.` | Left | `a.b.c` → `(a.b).c` |
| Function application | Left | `f x y` → `(f x) y` |
| Composition `\` | Right | `f \ g \ h` → `f \ (g \ h)` |
| Exponentiation `^` | Right | `a ^ b ^ c` → `a ^ (b ^ c)` |
| Unary `-`, `!` | Prefix | `-f x` → `-(f x)` |
| `*`, `/`, `%` | Left | `a / b * c` → `(a / b) * c` |
| `+`, `-`, `++` | Left | `a - b - c` → `(a - b) - c` |
| Cons `:` | Right | `a : b : xs` → `a : (b : xs)` |
| `==`, `!=`, `<`, `>`, `<=`, `>=` | Left | `a < b == c` → `(a < b) == c` |
| Logical `&&` | Left | `a && b && c` → `(a && b) && c` |
| Logical `\|\|` | Left | `a \|\| b \|\| c` → `(a \|\| b) \|\| c` |
| Ternary `? :` | Right | `a ? b : c ? d : e` → `a ? b : (c ? d : e)` |
| Application `$` | Right | `f $ g $ x` → `f (g x)` |

`f \ g` creates a function that computes `f (g x)` when called with `x`.
Both operands must be functions (constructors are accepted). Ordinary calls
bind more tightly, while exponentiation, arithmetic, iteration, and `$` bind
more loosely. Thus `vec * print \ format "%: %"` means
`vec * (print \ format "%: %")`; `(+ 1) \ (* 2) $ 3` returns `7`.
Use `(sum \ filter even) values` to apply a composition to a list.

Parentheses override precedence: `2 + 3 * 4` is `14`, while `(2 + 3) * 4`
is `20`. Comparison chains are ordinary left-associated operations, not
mathematical chained comparisons.

Backtick infix functions are not supported; write `f a b`. `=` and `<-` introduce
bindings and are not expression operators; they have no expression precedence. Range `..` belongs
inside range syntax, and `@` belongs to polar numeric literals. Function-type
arrows associate right: `Int -> Int -> Int` means `Int -> (Int -> Int)`.
Unbraced lambda bodies consume a full expression; a braced body ends at `}`.

Exponentiation uses the same numeric semantics as `expt`: `2 ^ 10` is `1024`,
and `2 ^ -3` is `1/8`. `-2 ^ 2` is `-(2 ^ 2)`; use `(-2) ^ 2` for `4`.
Sections work too: `(^ 2)`, `(2 ^)`, and `(^)`.

Unary operators take a power expression as their operand; nest them with parentheses,
as in `-(-x)`. For negative function arguments use `f (-1)`. The experimental
function-minus overload also allows `f -1`, but follows binary subtraction's
precedence: `sqrt -1 * 4` groups as `sqrt - (1 * 4)`.


See [templates and type aliases](templates-and-types.md) for scalar/container
application, slot updates, aliases, and parameterized variant types.

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

## Record fields, string keys, and positions

Every record key is an ordinary string. Bare field names hide the quotes; quoted
field syntax includes literal quote characters in the key. Both may coexist:

```apn
obj = [field: 123, "field": 456, 1: 10, "1": 100]
```

| Access | Selects | Result above |
| --- | --- | --- |
| `obj.field` or `obj "field"` | Named field `field` | `123` |
| `obj."field"` or `obj "\"field\""` | String containing `"field"`, quotes included | `456` |
| `obj.1` or `obj "1"` | Numeric-named field `1` | `10` |
| `obj."1"` or `obj "\"1\""` | String containing `"1"`, quotes included | `100` |
| `obj 1` | Entry at position 1 | `["\"field\"", 456]` |

Application evaluates its argument: `key = "field"; obj key` selects a named
field. Include quote characters in the argument to select a quoted field.
`pairs`, iteration, and conversion to HashMap preserve the entire key string.
`obj.(expression)` evaluates with the record fields in scope; use `obj key` for computed lookup. Missing keys
raise an error. Numeric field names retain their existing normalized spelling.
List indexing accepts integers or variants from families with only nullary constructors.
Variants select by zero-based declaration order. A string argument performs
[association-list lookup](templates-and-types.md#association-list-lookup):
`[["0", 42]] "0"` returns `42`; it never coerces `"0"` to positional index zero.
Ordinary scalar lists such as `[10, 20]` are not association lists and reject string lookup.
HashMap application likewise keeps numeric `0` and string `"0"` distinct keys.

Printing preserves key quotation. Field updates (`obj.field = value`,
`obj."field" = value`), record cloning, and plucks (`obj.[field, "field"]`)
preserve both identities. On an existing record, `obj "field" = value` updates
or adds the key string `field`, just like `obj.field = value`. Strings containing
quotes likewise update the corresponding quoted field. The key may be a string
literal, variable, or expression: `obj key = value` and `obj (prefix ++ key) = value`.
`obj "1" = value` updates numeric-named field `1`. Assignment evaluates the key
once before the RHS, replaces the selected slot with conversion checks for existing
numeric values, variants, and function contracts, and rebinds a scoped copy.
It does not invoke an ordinary function stored in the old slot. A new field is
inserted unchanged. On an unbound name or an existing function, `f "x" = value`
remains a string-pattern function clause.

`obj.[x] = [10]` requires a one-element RHS list; `obj.[x] = 10` errors.
`obj.child.x = 10` and `obj.child.[x, y] = [10, 20]` rebuild nested parent records.
See the [access and assignment reference](templates-and-types.md#access-and-assignment-reference)
for forms, conversion rules, scoping, and failure behavior.

Destructuring `[field: a, "field": b]` selects each
key explicitly; the bare pattern `[field]` selects only the named field.
Renamed plucks such as `obj.["field": value]` create named destination fields.

`pairs`, positional record access, record iteration, and conversion to `HashMap`
preserve the full key string, including quote characters. The keys `x` and `"x"`
therefore remain distinct in those views and conversions.

## Definitions and actions

Ordinary named definitions do not execute their bodies when defined.
`foo = _` declares an unfinished value; `f x = _` an unfinished function body.
The `_` expression raises "not implemented" only when evaluated. It remains a
wildcard in patterns. Both sides of `=` are required: `foo =`, `foo = ;`, and
`= bar` are syntax errors. Use `foo = []` for an empty result. An indented body may follow
`=` on the next line in a complete source chunk; a same-level line may not.

| Definition | What it binds |
| --- | --- |
| `f x = x + 1` | A pattern-dispatch function |
| `f = x -> x + 1` | A lambda closure |
| `a = { print 3; 4 }` | A repeatable zero-argument action |
| `a = print 3` | A repeatable action (application body) |
| `a = print $ 3` | A repeatable action (pipe body) |
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

## Eager result binding with `<-`

`pattern <- expression` evaluates the right-hand side immediately, runs any
zero-argument action needed to obtain its outer result, then binds that result
in the current scope. This is an eager binding, not monadic `do` notation.

```apn
import "std/io"
args <- getArgs

result <- print "hello"  # prints now, even if result is never used
print result             # prints the captured string; does not rerun the action

greet = print "hello"    # still a repeatable action
greet = { print "hello" } # still the same behavior
```

`getArgs` is now genuinely zero-argument; existing `getArgs` calls also work.
The `<-` binding can occur at top level or inside a block, and supports the
same value patterns as destructuring. `_ <- action` runs and discards a result.
The names become bound after the RHS and pattern succeed, so `x <- x + 1`
reads the previous x. A failed binding leaves previous bindings intact, but
effects already performed are not rolled back. Bindings are local to their block.

Only the outer value is evaluated. `xs <- [missing, 42]` does not evaluate
`missing`, and `xs <- [0..]` does not traverse the infinite range. Mutable cells
and pointers are captured as references. A function that takes arguments remains
a callable value. `=` destructuring remains unchanged:

```apn
[args] = [getArgs]        # lazy element: obtain arguments only when needed
args <- getArgs          # obtain them now
```

`<-` is a statement binding, not a function-definition form or chainable binary
operator. `f x <- ...`, `x <- y <- ...`, and missing right-hand sides are invalid.
An indented continuation is allowed; opening braces follow the same layout rule
as definitions: put `{` on the line containing `<-`.

### Where laziness ends

APN uses call-by-need for deferred values, arguments, list elements, cons tails,
and variant fields. Pattern matching forces only what it inspects. That does
not make every operation lazy: `<-` evaluates now, numeric operations demand
operands, effects run when demanded, and `*` iteration eagerly collects its
results. `map` produces results lazily. Consumers such as `length` and sorting
need finite input; printing an infinite list keeps streaming until interrupted.

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
  indexing needs the end of the list. `xs indices` selects a list of indices lazily.
  `xs indices = values` checks the finite update before rebinding; both sides see
  the old list. Dotted `templates.[values]` applies list templates instead.
- `null` inspects emptiness; `length` traverses cells without demanding heads.
  Equality compares elements incrementally and stops at the first mismatch.
- Finite and infinite ranges use the same incremental consumer interface.

Operations requiring a complete result—such as `length`, negative indexing,
`foldl`, `toString`, and full-list equality—may never finish on infinite inputs.
Use `take` when a finite result is required. Integers have arbitrary precision, so Fibonacci values remain exact instead
of rounding or overflowing to `Infinity`. Their growing size still uses memory.

## Patterns, variants, and scope

See [lists and records as arguments](pattern-functions.md#lists-and-records-as-arguments)
for parameter patterns, named inputs, and local collection updates.

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
is lossless. Otherwise use `inexact` explicitly. Exact `/` returns reduced fractions;
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
like record field assignment. Bare constructors are replaced:
`arr = [Int]; arr 0 = .2` produces `[0.2]`. Existing typed values retain their
conversion checks: `arr = [Int 0]; arr 0 = .2` errors. `arr (-1) = 10` updates its final element.
A single index must evaluate to an integer or a variant from a nullary-only family
(using zero-based declaration order); a finite list of these indices selects multiple
slots. `arr [1, 2] = arr [2, 1]` swaps the old values. Multi-index assignment requires
one replacement per index; duplicate indices use the last value. Negative indices
require a finite source list. See [slot assignment](templates-and-types.md#slot-assignment).
Positive updates traverse only as far as the selected cell, leaving unused
unselected heads and the remaining tail deferred. The selected head is inspected for an existing type annotation without invoking
a stored action. Bounds errors leave the binding unchanged.
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

A closing `)` starting a separate line must align with the indentation of the
line containing its opening `(`. A closing parenthesis after an expression on
the same line remains valid.

Parentheses suppress newlines for grouped expressions, but a `{ ... }` block
or `[ ... ]` list nested inside them restores its own layout. Local definitions
in a parenthesized lambda's brace body therefore remain separate statements;
list elements on separate lines remain separate elements.

In the interactive REPL, Enter submits except immediately after an opening
`(`, `{`, or `[` (allowing whitespace), where it inserts an indented newline.
Inside a bracket opened on an earlier line, Enter continues at the current
indentation. An unfinished single-line `[1,2,3` submits and reports a syntax error. Bracketed paste preserves copied indentation and blank lines without applying
auto-indent or closing-bracket dedent; press Enter afterward to submit.
Shift+Enter reverses that choice, even
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
variants. `Float` is flexible floating precision, using binary64 by default.
`Float32` and `Float64` commit to binary32 and binary64 respectively.
`Fraction` holds an exact rational, `Complex` any numeric complex value, and
`ComplexExact` an exact one. Constructors are first-class functions, e.g.
`map Int [1,2]`. Constructed values print their type: `Int32 123`.

Explicit `Float`, `Float32`, and `Float64` construction rounds to the target
floating-point precision, for bare or annotated inputs. `Float32 .1` produces
`Float32 0.1` (the nearest binary32 value, displayed with the shortest
round-tripping decimal); `Float (Int 9007199254740993)` rounds to
`9007199254740992.0`. This also applies through aliases and `cast`.

Integer constructors remain lossless: `Int .2` and `Int (Float .2)` both error.
Choose integer rounding explicitly: `Int (floor .2)` is `0`, while
`Int (truncate (-1.7))` is `-1`. Fixed-width integer overflow and nonzero
imaginary-part loss remain errors. Typed parameter matching, function contracts,
and assignment to existing numeric slots remain lossless. Floating arithmetic
adapts flexible Float operands as described below.
Numeric equality ignores
annotations: `.2 == Float .2` remains true. Int and Float values display without
a prefix; specialized types such as Int32, Float32 and Float64 retain theirs.

`cast` remains a compatibility helper in the APN prelude and `std/type`:

```apn
cast (Type target) value = target value
```

It has the same behavior as applying the type directly: floating constructors
round to their precision, while integer construction still rejects truncation.

### Flexible and fixed floating precision

A decimal literal such as `.2` behaves like `Float .2`. Both are flexible values,
including after binding to a variable, passing through a function, or storing in a
collection. Two flexible operands use binary64. A flexible operand paired with
Float32 or Float64 rounds to that fixed precision before arithmetic; the result
keeps the fixed type. Operand order does not matter and the original values are
not mutated. This is runtime precision selection, not backwards type inference.

```apn
.1 + .2                       # 0.30000000000000004
Float32 .1 + .2               # Float32 0.3
Float .2 + Float32 .1         # Float32 0.3
x = .2
Float32 .1 + x                # Float32 0.3
# Float32 .1 + Float64 .2     # error: explicit cast required
Float32 .1 + cast Float32 (Float64 .2) # Float32 0.3
```

Different fixed precisions require a cast even if a particular conversion would
be lossless. The rule covers `+`, `-`, `*`, `/`, `%`, `^`, `expt`, and elementwise
array arithmetic. Comparisons still compare numeric values without adopting an
operand's precision. Flexible values are stored in binary64; this does not give
exact decimal arithmetic or recover precision lost in an earlier computation.
`Float` construction explicitly returns a value to flexible precision.

Other numeric combinations retain their existing lossless promotion rules:
same-type operations preserve the type and check integer overflow; otherwise
arithmetic tries an existing suitable operand type before using the numeric tower.
Exact-to-inexact conversion must still be lossless. Integer `/` can produce a
typed `Fraction`. Float32 arithmetic rounds its result to binary32. Other numeric
native functions return their natural numeric result types; use a constructor to
impose a specific width on them.

`typeOf value` returns a type descriptor. `isType Type value` tests membership
without casting. `Number`, `Real`, `Integer`, `Exact`, and `Inexact` are aggregate
numeric guards. For example `isType Number (Int32 1)` is true.

Typed overloads use constructor patterns:

```apn
add (Int x) (Int y) = Int (x + y)
add (Float x) (Float y) = Float (x + y)
add (Number x) (Number y) = x + y
```

Literal matches outrank exact concrete type matches, which outrank aggregate
matches, which outrank conversion matches. Ties retain source order. Converting
either a typed or an untyped input must be lossless; explicit floating-point
construction is a separate operation and does not relax pattern matching. This ranking applies to functions with typed clauses;
ordinary pattern functions keep source order. Numeric constructor patterns extract
untyped payloads: `unwrap (Int32 x) = x` returns `5` for `Int32 5`. Return an explicit
constructor, as above, when the result should retain a type. Patterns do not mutate
the original argument or strip types from unrelated values.
Repeated variable names assert equality, so `(Number x) (Number x)` is not a
catch-all for two different numbers.

`100 * _ -> Int 0` repeats the typed value using the existing function iteration
overload. Two numeric operands always multiply: `100 * Int 0` returns `0`
and `Int 3 * Int 2` returns `6`, both still typed Int.

## HashMap

`HashMap [["x", 123]]` constructs from an association list; `HashMap [x: 123]`
constructs from a record. Empty construction is `HashMap []`. Keys may be finite
numbers, strings, chars, or booleans. Numerically equal keys share an entry
regardless of exactness or numeric type; distinct strings/chars stay distinct.
Duplicate keys keep the last value. Insertion order is preserved for traversal.

`insert [x: 123] $ HashMap []` returns a map containing x. `insert` accepts a
record or association list; `remove key map` returns a map without the key.
Updates preserve the old map. `lookup key map` or `map key` retrieves a value,
raising an error when absent; use `has key map` when absence is expected.
`keys`, `values`, `pairs`, `length`, and `null` operate on maps. Association-list
values stay lazy; keys are evaluated at construction. Record inputs follow the
existing record evaluation rules. `(HashMap m)` is a type pattern.

Type constructors also work directly with function iteration: `100 * Int`
returns typed integers `0` through `99`; `[1..100] * Int` returns `1` through
`100`. This differs from `100 * Int 0`, which multiplies and returns typed zero.

The nonnumeric types returned by `typeOf` are also first-class constructors:
`Bool`, `String`, `Char`, `List`, `Record`, `Function`, `Type`, and
`Variant`. Except for `Bool`, they validate and return a value of the corresponding
kind without forcing list elements or coercing unrelated values. `Bool` converts
using truthiness. Their constructor patterns
work in overloads, e.g. `f (Bool x) = x`. `isType` and identity `cast` support
these types too. Use declared constructors to create a particular variant;
`Variant` validates any such value.

A lowercase pair pattern `(t x)` captures the runtime type descriptor in `t`
and the numeric payload without its explicit type annotation in `x`. Nonnumeric
values are returned unchanged. For example, `myTypeOf (t x) = print t` still prints
`Int32` for `Int32 5`, while `payload (t x) = x` returns `5`.
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

## Mutable references

`x = Mutable 0` allocates a shared cell when first used. A zero-argument binding
returning a cell retains that cell across calls; functions taking arguments can
create independent cells. `set cell value` (or `set cell $ value`) evaluates the
new outer value before replacing the old contents and returns []. A failed
update leaves the cell unchanged. Aliases and inner scopes share the cell.
Arithmetic and printing read its contents; `typeOf x` reports `Mutable`.
Existing lazy calculations still memoize: a previously forced calculation is
not recomputed after mutation. Compound contents retain ordinary lazy semantics;
`set` does not deep-copy or deeply force them.

Function values display source: `func x = print x; print func` prints
`x -> print x` without running the body. Multiple clauses display their
equations; partially applied functions include their bound arguments without
forcing them. Captured environments are not expanded. Existing zero-argument
actions still run when demanded; inspecting one as a record field shows its body.

## Pattern functions

`match` is an intrinsic function over a lazy list of unary functions; pattern lambdas
and runtime function contracts are described in [pattern functions](pattern-functions.md).
Only pattern mismatch or a false guard selects the next alternative; runtime
errors propagate and unused alternatives remain unevaluated. Guards use truthiness.


## CLI file errors

If the input file cannot be opened, APN exits with status 1 and prints a concise
message to stderr, for example `error: cannot read "missing.apn": file not found`.
Directories and permission failures receive similarly short messages, without
Deno stack traces. The CLI uses the supplied path literally.

## Tail calls and recursive loading

Fully applied APN functions reuse an execution loop for calls in tail position,
including selected ternary branches, the final expression of a block, and pipes.
Arguments remain lazy: an unused argument is not evaluated by this optimization.
Calls with work remaining (such as `1 + recurse n`) still consume stack, and a
large deferred accumulator can still overflow when finally forced. Use `<-` to
compute an accumulator on each iteration when appropriate.

A loaded file may finish with `load "itself"`, directly or through a tail-called
function/action. This repeats without growing the host call stack; Ctrl+C stops
it and restores the REPL's scope and source directory. Each load still reads
and executes the file, resolves paths relative to that file, and merges its
exports when it returns. Pending module scopes/merges are retained on the heap,
so recursive loading is stack-safe but not constant-memory. Ordinary tail calls
have no pending module merges. `load` before another statement returns normally
before that statement executes; circular loads are not rejected.

## Sequencing expression lists

`do` is an ordinary APN function available in the prelude and `std/function`:

```apn
do [print "hi", print "there"]
answer = do [print "calculating", 42]
do []  # ()
```

It evaluates each list element in order and returns the last result, like a
block of expression statements. Empty input returns []. An error stops the
sequence. It accepts computed lists too, and processes the spine incrementally.
List elements retain normal sharing: reusing an already-evaluated list does not
rerun its memoized expressions. For a repeatable action, construct the list in
the action body, as in `greet = do [print "hi"]`. This does not add statement
syntax inside lists: local definitions still belong in blocks.

Numeric lists and records support elementwise arithmetic and scalar broadcasting;
`++` remains concatenation, and `*` with a function remains iteration.
See [numeric arrays](arrays.md) for matching-shape rules and lazy validation.

Function iteration accepts either operand order: `print * [1,2,3]` is equivalent
to `[1,2,3] * print`. Records pass `[key, value]` pairs and integer counts pass
indexes. Numeric operands still multiply (including numeric arrays); two
functions are not composed by `*`—use `\` for composition.

## Zero is initialization

Type descriptors remain constructors in every ordinary value context. Applying a
record template initializes omitted type slots; `Vector3 []` constructs defaults.
Assignment replaces bare type slots; constructed typed numeric values retain conversion checks. See [zero initialization](zero-initialization.md)
for the default table, type inspection, variant rules and limitations.

## String formatting

`format template arguments` requires an argument list. Each `%` consumes one
argument; `%%` prints a literal percent without consuming one. Missing or extra
arguments raise an error before any argument is rendered. For example,
`print $ format "vec = %" [vec]` prints one formatted record. Passing `vec`
directly instead of `[vec]` is invalid when `vec` is a record.

Negative dot keys remain literal: `obj.-1` means `obj "-1"`.
Parenthesized keys remain literal inside record literals, plucks, and record
patterns: `[(x): 2]`, `obj.[(x)]`, and `obj.[(x)] = [3]`. Use `obj "(x)"`
for direct lookup. Parentheses immediately after a record dot now evaluate an
expression in the record's scope; they no longer quote a field name.

`enumerate xs` returns a lazy list of `[index, value]` pairs. Indices are exact
integers starting at zero, so `enumerate [10,20]` is `[[0,10],[1,20]]`. It supports
infinite lists, and enumerating an element does not force its value.

## Record-scoped expressions

`record.(expression)` and `record.{ statements }` evaluate in a local scope populated by the
record's fields. Fields shadow outer names; other names resolve in the surrounding
lexical scope, including functions such as `sqrt`.

```apn
point = [x: 3, y: 4]
point.(x + y)                # 7
point.([x, y])               # [3, 4]
point.(x = 10; x + y)        # 14
point.x                     # 3
point.{
    result = x + y
    result * result
}                           # 49
f = point.(n -> x + n)
f 2                         # 5
```

Brace blocks use the usual four-space indentation and aligned closing brace.
Both forms return the last expression; empty blocks return `[]`. Grouping also
accepts either delimiter for operator sections (`{+ 2}` or `(+ 2)`), parameter
patterns (`f {Int x}` or `f (Int x)`), and grouped function contracts.
Definitions and ordinary field/index updates inside the expression are local;
they do not implicitly update the original record. Returned functions and deferred
values retain this local scope. Explicit side effects, including `Mutable` updates
or writes through an environment view, keep their normal behavior.

Only keys that are valid binding identifiers are exposed as local names. Quoted,
numeric, and parenthesized key spellings are not converted to identifiers. Fields
are installed without demanding their values or invoking stored actions. Existing
record-construction evaluation rules still apply.

`record.(expression) = value` is not an assignment target. To update a literal
field named `(x)`, use `record "(x)" = value` or `record.[(x)] = [value]`.
List operands retain dotted template application: `[Int, Float].([1] ++ [2])`
returns `[1, 2.0]`, evaluating the input expression in the surrounding scope.

## Live environment

`env` is a live record view of the current lexical scope and visible parent
bindings, including builtins. It captures binding references without forcing
values. `scope <- env` retains that scope; later definitions and rebindings
are visible through it. `env.x` and `env "x"` read bindings.

`env.x = value` and `scope "x" = value` update the nearest visible binding,
using the same type conversion checks as field assignment. New names are
created in the captured scope. This explicitly writes through the view even
from an inner block; ordinary `x = value` still follows normal scope rules.
Pluck assignments validate all conversions before publishing updates.

The view can escape a function and keep its local scope alive. `pairs env`
exposes its visible entries; plucks produce ordinary lists or records.
`typeOf env` is Record. Environment views compare by scope identity.
Printing displays bindings as a record; actions are shown without invoking
them, and recursive references to the same environment print as `env`.
Ordinary lazy data is rendered normally, so an infinite list can keep printing.
Resource scopes reject environment views as escaping references.

### Type descriptions

`typeOf [1,2,3]` displays `[Int]`; heterogeneous literal lists display their
known alternatives, for example `[Int | String]`. Empty lists and unresolved
lazy computations display `[a]`. Integer ranges display `[Int]`, including
infinite ranges, without traversing them.

Functions display argument/result descriptions: `f (Int x) = x` gives
`Int -> Int`; `x -> print x` gives `a -> []`. Clauses contribute to one
combined description, with alternatives where their known types differ.
Explicit function contracts still return their declared arrow type.
Uncontracted descriptions are conservative diagnostics, not static inference
or enforced contracts. `a`, `b`, and so on name unresolved type variables; overloaded arithmetic, recursion,
and computed lazy elements can leave unknown parts. Describing a callable never probes its body with sample arguments or forces
list elements. Inspecting an argument expression
still evaluates it enough to obtain its outer value. Existing nullary action semantics remain: demanding a nullary action runs it,
so `typeOf` describes its result.

For compatibility, enriched list/function descriptions retain their broad
`List`/`Function` type identity and constructor behavior: `typeOf [1] == List`
is true. A displayed `[Int]` is descriptive metadata, not a new enforced
list schema; use an explicit schema/contract when you need validation.

### Empty results and truthiness

There is no `Unit` type or separate unit value. `[]` is the ordinary empty list
and the result of empty `()` / `{}` blocks, printing, mutation, and other
operations with no useful result. Blocks remain executable expressions.
The REPL displays an empty-list result as `[]`. Use `[]` for an explicitly
ignored argument. C interop uses `ffi.function parameters []` for `void`.

Falsy values are `false`, numeric zero (including complex zero), floating NaN,
empty strings, empty lists, empty records, empty HashMaps, and null pointers.
Everything else is truthy, including type constructors, non-nullary functions,
and every variant constructor (`None` and zero-ordinal enum cases included).
Mutable cells use their current contents. Nullary actions run under the usual
demand rules. A list check inspects only its first cell, not its elements or
remaining tail; infinite nonempty lists are truthy.

`Bool x`, `!x`, ternary conditions, pattern guards, `assert`, `filter`, and
standard-library predicate consumers share these rules. `&&` and `||` return
Bool and short-circuit: `0 && missing` is false, `1 || missing` is true.
Truthiness does not change equality or Bool pattern matching: `0 != false`,
and `(Bool x)` still matches booleans rather than every convertible value.

Type variables preserve relationships: `typeOf (x y -> x)` displays
`a -> b -> a`, `typeOf (f x -> f x)` displays `(a -> b) -> a -> b`, and
`typeOf (x -> [x,x])` displays `a -> [a]`. Names are assigned afresh in
left-to-right order for each description. Function applications, lexical
captures, list patterns and generic constructor patterns propagate constraints;
clauses contribute to one signature. For example, `f (Some x) = x` with
`f None = 0` describes `Option Int -> Int`.

This remains bounded diagnostic inference, not Haskell's static type checker.
Unresolved native behavior, overloaded operators and recursive self-application
can leave unconstrained variables; these are not guarantees of parametric
polymorphism. No new runtime restrictions or type-based dispatch are introduced.

Optional pre-execution checking and value-dependent types are documented in
[Gradual and dependent types](gradual-and-dependent-types.md). `Vector n t`
checks list length and element conversions; type aliases can accept ordinary
values. `--check` and `--checked` do not change ordinary dynamic execution.

Exact exponentiation, integer square-root and GCD loops check the REPL interrupt
flag. Large integer/rational decimal formatting is split into checked steps.
Ctrl+C can cancel large powers such as `[1, 2] ^ 100000000` and return to the
prompt. Cancellation is cooperative: a single host BigInt operation must finish
before its next check; it is not a hard real-time latency guarantee.
