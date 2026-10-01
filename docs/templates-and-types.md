# Templates and type aliases

Record construction applies callable slots and overrides concrete defaults.
Dotted list application applies its slots and rejects scalar slots.
Concrete scalars (numbers, strings, characters, and booleans) are not callable.

## Concrete defaults

```apn
0 123                       # error: cannot apply a number
[0].[123]                   # error: cannot apply a number
[x: Int 0] [floor .2]       # [x: 0]
[x: Int 0] [Float .2]          # error: lossy conversion
[x: 0] [x: 123]             # [x: 123]
["old"].["new"]             # error: cannot apply a string
[Bool].[true]               # [true]
[Char].['b']                 # ['b']
```

Inside a record template, an untyped numeric default accepts any number unchanged.
An explicitly typed numeric default converts through its constructor: all inputs require lossless conversion. Overflow and nonzero imaginary-part
loss still error. String, character, and boolean defaults accept their own kind only inside record templates.
Standalone `"old" "new"`, `'a' 'b'`, and `false true` are application errors.
Functions retain ordinary application, including effects.

Numeric parameter patterns always require lossless conversion, including for
bare literals. `f (Int x) = x` accepts `2.0` but does not match `.2`; another
clause may handle it, otherwise application reports no matching clause. Direct
construction `Int .2` also errors; use `Int (floor .2)` to round down explicitly.

## Lists

| Template | Application |
| --- | --- |
| `[f].[x]` | One slot: `[f x]` |
| `[f, g].[x, y]` | Two slots: `[f x, g y]` |
| `[].[]` | Empty list |
| `[f].[]` or `[f].[x,y]` | Length mismatch |

```apn
[(* 2), (* 3)].[1, 2]   # [2, 6]
[Int, String].[1, "hi"] # [1, "hi"]
Int * [1, 2, 3]         # mapping, separate from template application
map Int [0..]           # lazy mapping over an infinite list
```

Every template length, including one, uses exact positional matching. Output
heads and tails are deferred; mismatch or conversion errors surface when the
relevant part is consumed. A singleton never broadcasts. `[Int]` describes
exactly one position when used as a schema, including through `cast` and `isType`.
Nested list templates use the same exact-length rule.

Strings supply Unicode code-point characters using the same positional rules:

```apn
[Char, Char]."hi"       # ['h', 'i']
[Char]."h"              # ['h']
[].""                  # []
chars "hello"           # arbitrary-length character conversion
```

A template is an ordinary list value. Use `template.(values)` for a computed
input. On records, parenthesized dot keys retain their literal spelling.
`String` converts a finite character list back to text, using `fromChars`:

```apn
import "std/text"
cast String $ chars "hello"          # "hello"
cast String $ cast [Char, Char] $ "hi"  # "hi"
String ['h', 'i']                    # "hi"
String []                            # ""
```

Every element must be a `Char`; lists of strings or numbers are rejected.
Constructing a string consumes the entire list.

Integer application still indexes a list: `[10] 0` returns `10`.
A list argument selects multiple indices: `[10,20,30] [2,0]` returns `[30,10]`.
Selection is lazy and preserves index order and duplicates. Integer and enumeration
indices use the same rules as single indexing; negative indices require a finite input.
Dotted application explicitly selects template behavior: `[Int].[0]` returns `[0]`; `[10].[0]` errors.
For computed template inputs use `template.(values)`. This overload is only for
lists; `record.(key)` remains a literal parenthesized field name.

Multi-index assignment reads indices and replacement values against the old binding:

```apn
arr = [10,20,30]
arr [1,2] = arr [2,1]   # arr becomes [10,30,20]
```

Assignment requires a finite index list and exactly as many replacement values.
Bounds and outer conversion failures leave the binding unchanged. Duplicate indices
are written in order, so the last value wins. Positive indices can update a finite
prefix of an infinite list without demanding the remaining tail. Separate side effects
performed while evaluating arguments are not rolled back.

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

Index, field, and pluck assignment replace the selected slot, then rebind a
copy in the current scope. Existing numeric values, implicitly or explicitly typed, retain
their conversion checks; variants retain their family and wrapped functions
retain their contracts:

```apn
xs = [Int].[0]
xs 0 = floor .2                 # [0]
xs 0 = 123                # [123]

v = [x: Int, y: Int] []
v.y = 321                 # [x: 0, y: 321]
v "y" = floor .2                # [x: 0, y: 0]
```

Bare constructors are replaced without conversion: `v = [x: Float]; v.x = 1`
produces `[x: 1]`, and `v.x = Int` stores Int. To keep a numeric constraint,
construct the field first (`v = [x: Float] []`) or assign `Float 1` explicitly.
Ordinary records and functions are replaced, never merged or called by assignment.
Explicit record application still merges fields.
The old slot is inspected without invoking a stored action. Unrelated slots
remain deferred. The RHS sees the old binding. A conversion or bounds error
preserves the binding; already-performed effects are not undone.
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

Dotted templates return ordinary lists without a persistent container schema.
`[].[]` is empty, and an update at index zero fails; `[Int].[]` is a length error. After transformation, a function slot is
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
Numbers.[1, 2]             # [1, 2]
Point [x: 1, y: 2]         # [x: 1.0, y: 2.0]
cast [Int, Int] [1, 2]          # [1, 2]
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

Nominal wrappers can use single-constructor variants or `distinct Type`;
see [distinct types](type-and-resource-rules.md#distinct-types). No automatic
cross-type conversion or zero-cost representation is implied. Class/instance syntax and static type
inference are not part of this change.

Record-template patterns also accept positional lists with exactly as many
items as the template has fields: `f (Vector3 v) = v` accepts `f [1,2,3]`
when `Vector3 = [x: Float, y: Float, z: Float]`. Conversion is the same lazy
conversion as `Vector3 [1,2,3]`. Wrong lengths do not match; shape checking
reads at most one cell beyond the required count, including infinite inputs.
Field conversion errors remain deferred until those fields are demanded.
Equally matching record templates retain source-order dispatch.
