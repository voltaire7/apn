# Templates and type aliases

Application works on scalar values and containers as well as functions.
Container application applies each existing slot to its supplied input.

## Scalar application

```apn
0 123                 # 123
(Int 0) 123           # Int 123
(Int 0) .2            # Int 0
(Int 0) (Float .2)    # error: lossy conversion
"old" "new"           # "new"
false true            # true
```

An untyped number accepts any number unchanged. A typed number applies its
constructor to the input: untyped numbers may round/truncate, but explicitly
typed inputs require lossless conversion. Overflow and nonzero imaginary-part
loss still error. Strings, chars, booleans, and unit accept their own kind only.
Functions retain ordinary application, including effects.

Numeric parameter patterns always require lossless conversion, including for
bare literals. `f (Int x) = x` accepts `2.0` but does not match `.2`; another
clause may handle it, otherwise application reports no matching clause. Direct
construction `Int .2` still returns `Int 0`.

## Lists

| Template | Application |
| --- | --- |
| `[f] xs` | Apply `f` to every element, lazily |
| `[f, g] [x, y]` | Apply positionally: `[f x, g y]` |
| `[] []` | Empty list |
| `[] [x]` | Length mismatch |

```apn
[(* 2)] [1, 2, 3, 4]     # [2, 4, 6, 8]
[Int] [1, 2, 3]           # [Int 1, Int 2, Int 3]
[Int, String] [1, "hi"]   # [Int 1, "hi"]
[[(* 2)]] [[1, 2], [3]]  # [[2, 4], [6]]
take 3 ([Int] [0..])      # [Int 0, Int 1, Int 2]
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

Integer application still indexes a list: `[10] 0` returns `10`.
List-to-list application no longer selects indexes: `[10] [0]` returns `[0]`.
Use `map xs [0, 2]` to select multiple indexes from `xs`; it always returns a list.

## Records

```apn
[x: Int, y: 0] [x: 1, y: 2]    # [x: Int 1, y: 2]
[x: Int, y: Int] [x: 123]        # [x: Int 123, y: Int]
[x: Int] [x: 123, z: "extra"]    # [x: Int 123, z: "extra"]
[x: Int, y: (* 2)] [1, 2]       # [x: Int 1, y: 4]
```

Supplied existing fields are applied, omitted fields are preserved unchanged,
and extra fields are appended unchanged. Types and functions are ordinary
values: an omitted `Int` remains `Int`, and an omitted function stays callable.
A list argument supplies record fields positionally and must match the field
count. Record results defer field transformations until demanded.

Named fields and quoted string keys remain distinct through application.
`[x: Int, "x": Int] ["x": 1]` produces `[x: Int, "x": Int 1]`.

## Slot assignment

Index, field, and pluck assignment apply the old slot to the incoming value,
then rebind a copy in the current scope:

```apn
xs = [Int]
xs 0 = .2                 # [Int 0]
xs 0 = 123                # [Int 123]

v = [x: Int, y: Int]
v.y = 321                 # [x: Int, y: Int 321]
v "y" = .2                # [x: Int, y: Int 0]
```

The selected slot is demanded because it participates in application. Unrelated
slots remain deferred. The RHS sees the old binding. An immediate application
or bounds error preserves the binding; already-performed effects are not undone.
Nested container results retain lazy checks, so errors in an unconsumed nested
field can still surface later. Pluck updates compute against the original fields
and publish the record only after all selected outer results succeed.

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

Count 123                  # Int 123
Numbers [1, 2]             # [Int 1, Int 2]
Point [x: 1, y: 2]         # [x: Float 1.0, y: Float 2.0]
cast [Int] [1, 2]          # [Int 1, Int 2]
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
firstNumber [123]             # Int 123
firstInline ([Int] xs) = head xs
getX ([x: Int] p) = p.x
```

These are lazy runtime conversion contracts, not a static type checker.
Record conversion preserves omitted fields even in a type description; it does
not invent an input for them. `isType description value` checks membership
without conversion and requires described record fields to be present with
matching values. A complete list membership check consumes the list.

## Variants, parameters, and distinct wrappers

A `|` distinguishes a constructor declaration from a type alias. A single
constructor needs a leading pipe:

```apn
Option a = Some a | None
Maybe a = Option a
UserId = | MkUserId Int

(Maybe Int) (Some 123)     # Some Int 123
(Option Int) None          # None
MkUserId 123               # MkUserId Int 123
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
