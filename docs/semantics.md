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
| Exponentiation `^` | Right | `a ^ b ^ c` → `a ^ (b ^ c)` |
| Unary `-`, `!` | Prefix | `-f x` → `-(f x)` |
| `*`, `/`, `%` | Left | `a / b * c` → `(a / b) * c` |
| `+`, `-`, `++` | Left | `a - b - c` → `(a - b) - c` |
| Cons `:` | Right | `a : b : xs` → `a : (b : xs)` |
| `==`, `!=`, `<`, `>`, `<=`, `>=` | Left | `a < b == c` → `(a < b) == c` |
| Ternary `? :` | Right | `a ? b : c ? d : e` → `a ? b : (c ? d : e)` |
| Composition `\` | Right | `f \ g \ h` → `f \ (g \ h)` |
| Pipe `$` | Left | `x $ f $ g` → `(x $ f) $ g` |

`f \ g` builds a function: `(f \ g) x` means `f (g x)`. Both operands
must be functions (constructors are accepted); composing a function with a list,
string, or number raises an error. Composition binds more loosely than ordinary
calls and arithmetic, and more tightly than `$`.

```apn
import "std"
even n = n % 2 == 0
calculate bottom top = (sum \ filter even) [bottom..top]
calculate 1 10                         # 30
["x", 1] $ (print \ format "%: %")     # prints x: 1
```

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

Named fields and quoted string keys have distinct identities. Both may coexist:

```apn
obj = [field: 123, "field": 456, 1: 10, "1": 100]
```

| Access | Selects | Result above |
| --- | --- | --- |
| `obj.field` or `obj "field"` | Named field `field` | `123` |
| `obj."field"` | String key `"field"` | `456` |
| `obj.1` or `obj "1"` | Numeric-named field `1` | `10` |
| `obj."1"` | String key `"1"` | `100` |
| `obj 1` | Entry at position 1 | `["field", 456]` |

Application evaluates its argument: `key = "field"; obj key` selects a named
field. Computed dot access (`obj.(key)`) is not supported. Literal quoted dot
access selects string keys; neither form falls back to the other key kind. Missing keys
raise an error. Numeric field names retain their existing normalized spelling.
List indexing requires integers: `arr 0` indexes a list, while `arr "0"` errors.
HashMap application likewise keeps numeric `0` and string `"0"` distinct keys.

Printing preserves key quotation. Field updates (`obj.field = value`,
`obj."field" = value`), record cloning, and plucks (`obj.[field, "field"]`)
preserve both identities. On an existing record, `obj "field" = value` updates
or adds the named field, just like `obj.field = value`. The key must be one
string literal; `obj "1" = value` updates numeric-named field `1`. It reads the
RHS before rebinding, applies the existing slot to it, makes a scoped copy, and
preserves the old binding on an immediate failure. A new field is inserted unchanged. On an unbound name or an existing function, `f "x" = value` remains
a string-pattern function clause.

Destructuring `[field: a, "field": b]` selects each
kind explicitly; the bare pattern `[field]` selects only the named field.
Renamed plucks such as `obj.["field": value]` create named destination fields.

`pairs`, positional record access, and record iteration still expose key **text**
as ordinary strings. These views do not retain the named/string distinction.
Converting a record to `HashMap` also uses key text; if both kinds have the same
text, the later entry wins under the existing duplicate-key rule.

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

`getArgs` is now genuinely zero-argument; existing `getArgs ()` calls also work.
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
  indexing needs the end of the list. List arguments apply templates instead of
  selecting indexes; use `map xs indexes` for multiple selections.
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
like record field assignment. The old slot is applied to the incoming value:
`arr = [Int]; arr 0 = .2` produces `[Int 0]`. `arr (-1) = 10` updates its final element.
The index must be one integer literal; negative indexes require a finite list.
Positive updates traverse only as far as the selected cell, leaving unused
unselected heads and the remaining tail deferred. The selected head is demanded
because it is the template for this update. Bounds errors leave the binding unchanged.
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
variants. `Float` (`Float64` is an alias) uses binary64; `Float32` uses binary32.
`Fraction` holds an exact rational, `Complex` any numeric complex value, and
`ComplexExact` an exact one. Constructors are first-class functions, e.g.
`map Int [1,2]`. Constructed values print their type: `Int32 123`.

A bare number has a numeric representation but no explicit constructor annotation.
Constructors may truncate or round these untyped values: `Int .2` produces `Int 0`,
and `Float32 .1` rounds to binary32. The same applies to untyped computed values.
This does not make a decimal literal exact or defer its parsing until a type is known.

Explicitly typed inputs require lossless conversion: `Int (Float .2)` errors,
as does `Float32 (Float .1)`. To deliberately discard the original type and convert,
use `cast Type value` or `value $ cast Type`. Integer conversion truncates toward
zero. Out-of-range integers always error rather than wrap, and nonzero imaginary
parts cannot be silently discarded. Numeric equality still compares numeric values:
`.2 == Float .2` is true.

`cast` is defined in APN in `lib/type.apn`, available in the default prelude and
through `import "std/type"`:

```apn
cast (Type target) (source value) = target value
```

The generic pattern captures the source type and extracts the untyped numeric
payload. Applying the target constructor then performs the conversion. Nonnumeric
payloads retain their usual constructor validation; no native `cast` remains.

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
add (Int x) (Int y) = Int (x + y)
add (Float x) (Float y) = Float (x + y)
add (Number x) (Number y) = x + y
```

Literal matches outrank exact concrete type matches, which outrank aggregate
matches, which outrank conversion matches. Ties retain source order. Converting
a typed input must be lossless; an untyped input may round or truncate, as with
constructor application. This ranking applies to functions with typed clauses;
ordinary pattern functions keep source order. Numeric constructor patterns extract
untyped payloads: `unwrap (Int32 x) = x` returns `5` for `Int32 5`. Return an explicit
constructor, as above, when the result should retain a type. Patterns do not mutate
the original argument or strip types from unrelated values.
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
create independent cells. `set value cell` (or `cell $ set value`) evaluates the
new outer value before replacing the old contents and returns unit. A failed
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

`match` is an ordinary prelude function over unary functions; pattern lambdas
and runtime function contracts are described in [pattern functions](pattern-functions.md).
The primitive `tryMatch` distinguishes pattern failure from runtime errors and
keeps successful bodies deferred. Guards must return Bool.


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
block of expression statements. Empty input returns unit. An error stops the
sequence. It accepts computed lists too, and processes the spine incrementally.
List elements retain normal sharing: reusing an already-evaluated list does not
rerun its memoized expressions. For a repeatable action, construct the list in
the action body, as in `greet = do [print "hi"]`. This does not add statement
syntax inside lists: local definitions still belong in blocks.
