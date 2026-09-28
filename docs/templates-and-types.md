# Templates and type aliases

Application works on scalar values and containers as well as functions.
Container application applies each existing slot to its supplied input.

## Scalar application

```apn
0 123                 # 123
(Int 0) 123           # 123
(Int 0) (floor .2)    # 0
(Int 0) (Float .2)    # error: lossy conversion
"old" "new"           # "new"
false true            # true
```

An untyped number accepts any number unchanged. A typed number applies its
constructor to the input: all inputs require lossless conversion. Overflow and nonzero imaginary-part
loss still error. Strings, chars, booleans, and unit accept their own kind only.
Functions retain ordinary application, including effects.

Numeric parameter patterns always require lossless conversion, including for
bare literals. `f (Int x) = x` accepts `2.0` but does not match `.2`; another
clause may handle it, otherwise application reports no matching clause. Direct
construction `Int .2` also errors; use `Int (floor .2)` to round down explicitly.

## Lists

| Template | Application |
| --- | --- |
| `[f] xs` | Apply `f` to every element, lazily |
| `[f, g] [x, y]` | Apply positionally: `[f x, g y]` |
| `[] []` | Empty list |
| `[] [x]` | Length mismatch |

```apn
[(* 2)] [1, 2, 3, 4]     # [2, 4, 6, 8]
[Int] [1, 2, 3]           # [1, 2, 3]
[Int, String] [1, "hi"]   # [1, "hi"]
[[(* 2)]] [[1, 2], [3]]  # [[2, 4], [6]]
take 3 ([Int] [0..])      # [0, 1, 2]
```

A singleton template maps over any input length. Every other length uses exact
positional matching. Output heads and tails are deferred; mismatch or conversion
errors surface when the relevant part is consumed. Finite prefixes of infinite
inputs remain usable. A template is itself a value, so determining whether it
is a singleton demands its first two spine cells, but not its element bodies.

Strings can supply the input characters using the same rules:

```apn
[Char] "hello"          # ['h', 'e', 'l', 'l', 'o']
[Char, Char] "hi"       # ['h', 'i']
[c -> 42] "hi"          # [42, 42]
[Char] ""               # []
```

Characters follow Unicode code points, like `chars`; an emoji is one element.
The result is a list, and element transformations remain lazy. Positional
length checks still apply. This also works through aliases and `cast [Char]`.
`String` converts a finite character list back to text, using `fromChars`:

```apn
import "std/text"
chars "hello" $ cast String          # "hello"
"hello" $ cast [Char] $ cast String  # "hello"
String ['h', 'i']                    # "hi"
String []                            # ""
```

Every element must be a `Char`; lists of strings or numbers are rejected.
Constructing a string consumes the entire list.

Integer application still indexes a list: `[10] 0` returns `10`.
List-to-list application no longer selects indexes: `[10] [0]` returns `[0]`.
Use `map xs [0, 2]` to select multiple indexes from `xs`; it always returns a list.

## Records

```apn
[x: Int, y: 0] [x: 1, y: 2]    # [x: 1, y: 2]
[x: Int, y: Int] [x: 123]        # [x: 123, y: 0]
[x: Int] [x: 123, z: "extra"]    # [x: 123, z: "extra"]
[x: Int, y: (* 2)] [1, 2]       # [x: 1, y: 4]
```

Supplied existing fields are applied, omitted type slots are initialized,
and extra fields are appended unchanged. An omitted `Int` becomes typed zero;
omitted concrete values and functions retain their defaults. See [zero initialization](zero-initialization.md).
A nonempty list argument must supply exactly one value per record field.
The empty list `[]` explicitly initializes all fields from their defaults. Record results defer field transformations until demanded.

Keys retain their full string contents, including any quote characters, through application.
`[x: Int, "x": Int] ["x": 1]` produces `[x: 0, "x": 1]`.

## Slot assignment

Index, field, and pluck assignment apply the old slot to the incoming value,
then rebind a copy in the current scope:

```apn
xs = [Int] [0]
xs 0 = floor .2                 # [0]
xs 0 = 123                # [123]

v = [x: Int, y: Int] []
v.y = 321                 # [x: 0, y: 321]
v "y" = floor .2                # [x: 0, y: 0]
```

Uninitialized type slots reject assignment: `v = [x: Int]; v.x = 1` and
`xs = [Int]; xs 0 = 1` both error. Construct values first, as above.
The selected slot is demanded because it participates in application. Unrelated
slots remain deferred. The RHS sees the old binding. An immediate application
or bounds error preserves the binding; already-performed effects are not undone.
Nested container results retain lazy checks, so errors in an unconsumed nested
field can still surface later. Pluck updates compute against the original fields
and publish the record only after all selected outer results succeed.

Indices and record keys can be variables or parenthesized expressions:

```apn
arr = [0, 0]
i = 0
arr i = 1
arr (i + 1) = 2             # [1, 2]
obj = [x: 0]
key = "x"
obj key = 3                # [x: 3]
obj (key ++ "y") = 4       # [x: 3, xy: 4]
```

The key is evaluated once before the RHS, in the current scope against the old
binding. Lists require an integer (negative indices count from the end); records
require a string. Numeric strings never become positional indices. Unbound names
and existing functions retain ordinary pattern definitions: `f i = i + 1` still
defines a function. Expression-only left sides such as `arr (i + 1) = value`
require an existing collection. Assignment accepts exactly one index/key.

New record fields are inserted as given. List updates never append: `xs 1 = 4`
on the one-slot list above is an error. Negative indexes still count from the end.

There is no persistent container schema. `[Int] []` returns an ordinary empty
list, and an update at index zero fails. After transformation, a function slot is
replaced by its result:

```apn
v = [x: (* 2)]
v.x = 3                   # x becomes 6
v.x = 4                   # x becomes 4, not 8
```

Rebind a whole variable to replace a template instead of applying it. Ordinary
numeric/string-pattern function definitions on function or unbound names remain
function definitions, not slot assignments.

## Type descriptions and aliases

A finite list or record consisting entirely of type descriptions is itself
accepted in type positions. Ordinary transformation functions are not types.

```apn
Count = Int
Numbers = [Int]
Point = [x: Float, y: Float]
Points = [Point]

Count 123                  # 123
Numbers [1, 2]             # [1, 2]
Point [x: 1, y: 2]         # [x: 1.0, y: 2.0]
cast [Int] [1, 2]          # [1, 2]
Type [Int]                # [Int]
isType Type [(* 2)]        # false
```

Aliases are shared type-level bindings, not repeatable zero-argument actions.
They introduce no new nominal identity. `Type` accepts descriptions while their
ordinary container representation remains inspectable; `typeOf [Int]` is `List`.
Mixed defaults such as `[x: Int, y: 0]` are templates, not type descriptions.

Patterns accept aliases and inline descriptions:

```apn
firstNumber (Numbers xs) = head xs
firstNumber [123]             # 123
firstInline ([Int] xs) = head xs
getX ([x: Int] p) = p.x
```

These are lazy runtime conversion contracts, not a static type checker.
Record construction initializes omitted type fields from their defaults and
retains concrete defaults. `isType description value` checks membership
without conversion and requires described record fields to be present with
matching values. A complete list membership check consumes the list.

## Variants, parameters, and distinct wrappers

A `|` distinguishes a constructor declaration from a type alias. A single
constructor needs a leading pipe:

```apn
Option a = Some a | None
Maybe a = Option a
UserId = | MkUserId Int

(Maybe Int) (Some 123)     # Some 123
(Option Int) None          # None
MkUserId 123               # MkUserId 123
Some value = Some 123      # destructures; value is 123
None = None                # pattern assertion
```

Type parameters are retained and supplied by type application. Bare constructors
remain polymorphic; `typeOf (Some 123)` reports the unspecialized parent `Option`
without demanding its payload. Explicit specialization retains its arguments:
`typeOf ((Option Int) None)` is `Option Int`. Different type arguments produce
different type descriptions. Payload conversions are deferred until used.
Concrete fields such as `Int` in `MkUserId Int` are enforced on construction,
also lazily. Grouped and structural payload types compose:
`Tree a = Branch [a] | Leaf a`.

`func ((Option Int) value) = ...` checks parent membership and applies the
specialized payload contract. An unrelated outer value falls through to the
next clause. A deferred payload failure is a runtime error when demanded, not
an invitation to rerun another clause.

Fresh capitalized bindings define aliases; existing value constructor names on
the LHS destructure and cannot be reassigned as aliases or unrelated constructors.
An unspecialized parent pattern `(Option value)` still binds the whole variant.
A constructor pattern `(Some value)` extracts its field. Explicitly declared
same-name legacy wrappers remain supported (`Box a = | Box a`), but the shared
name denotes the value constructor; use distinct names for type specialization.

Nominal wrappers use ordinary single-constructor variants; no automatic unwrap
or zero-cost representation is implied. Class/instance syntax and static type
inference are not part of this change.

Record-template patterns also accept positional lists with exactly as many
items as the template has fields: `f (Vector3 v) = v` accepts `f [1,2,3]`
when `Vector3 = [x: Float, y: Float, z: Float]`. Conversion is the same lazy
conversion as `Vector3 [1,2,3]`. Wrong lengths do not match; shape checking
reads at most one cell beyond the required count, including infinite inputs.
Field conversion errors remain deferred until those fields are demanded.
Equally matching record templates retain source-order dispatch.
