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
| `[f,g].[x,y]` | Two slots: `[f x,g y]` |
| `[].[]` | Empty list |
| `[f].[]` or `[f].[x,y]` | Length mismatch |

```apn
[(* 2),(* 3)].[1,2]   # [2, 6]
[Int,String].[1,"hi"] # [1, "hi"]
Int * [1,2,3]         # mapping, separate from template application
map Int [0..]           # lazy mapping over an infinite list
```

Every template length, including one, uses exact positional matching. Output
heads and tails are deferred; mismatch or conversion errors surface when the
relevant part is consumed. A singleton never broadcasts. `[Int]` describes
exactly one position when used as a schema, including through `cast` and `isType`.
Nested list templates use the same exact-length rule.

Record inputs supply their values in field order. The result preserves the
record's keys and order, and the template must have exactly as many slots as
the record has fields. Converted fields remain lazy:

```apn
[Float].[x: 1]                        # [x: 1.0]
[String,Int].[name: "a", age: 2]      # [name: "a", age: 2]
[(+ 1),(* 2)].[b: 3, a: 4]           # [b: 4, a: 8]
```

Strings supply Unicode code-point characters using the same positional rules:

```apn
[Char,Char]."hi"       # ['h', 'i']
[Char]."h"              # ['h']
[].""                  # []
chars "hello"           # arbitrary-length character conversion
```

A template is an ordinary list value. Use `template.values` for a variable input,
or `template.(expression)` for a computed input. On records, `record.values`
still looks up the literal field `values`, while `record.(expression)` evaluates
with the record fields in scope.
`String` converts a finite character list back to text, using `fromChars`:

```apn
import "text"
cast String $ chars "hello"          # "hello"
cast String $ cast [Char,Char] $ "hi"  # "hi"
String ['h','i']                    # "hi"
String []                            # ""
```

Every element must be a `Char`; lists of strings or numbers are rejected.
Constructing a string consumes the entire list.

Integer application still indexes a list: `[10] 0` returns `10`.
A list argument selects multiple indices: `[10,20,30] [2,0]` returns `[30,10]`.
A record argument names the selected indices and returns a record:

```apn
[10,20,30] [first: 0, last: 2]       # [first: 10, last: 30]
[Int] [x: 0]                       # [x: Int]
[Int] [x: 1]                       # error: index out of bounds
```

Each record value must be an integer or enumeration index. Selection preserves
its field names and order. This is indexing, not template conversion;
`[Int].[x: 1]` instead converts the record's value and returns `[x: 1]`.
Named selections support assignment with exactly the same field names on the
right; replacement order does not matter:

```apn
arr = [10,20,30]
arr [first: 0, last: 2] = [last: 300, first: 100]
# arr = [100,20,300]
```

Indices are resolved once against the old binding. Duplicate indices use the
last selection entry's replacement, after all conversions succeed.

Selection is lazy and preserves index order and duplicates. Integer and enumeration
indices use the same rules as single indexing; negative indices require a finite input.
Dotted application explicitly selects template behavior: `[Int].[0]` returns `[0]`; `[10].[0]` errors.
For variable inputs use `template.values`; for other expressions use `template.(expression)`. This overload is only for
lists; `record.(expression)` instead performs scoped evaluation.

For updates and swaps, see [computed keys and multiple indices](#computed-keys-and-multiple-indices).

### Association-list lookup

Applying a list to a string looks up the first matching `[string,value]` pair:

```apn
entries = [["x",1],["y",2]]
entries "x"                 # 1
key = "y"
entries key                 # 2
entries 0                   # ["x", 1] (positional indexing)
entries [1,0]              # [["y", 2], ["x", 1]] (index selection)
[["x",1],["x",2]] "x"    # 1 (first match wins)
```

Lookup scans incrementally. It does not evaluate skipped values or entries after
its first match, so it can find a key in an infinite list. A missing key errors
once the list ends; searching an infinite list for an absent key may not finish.
Every visited entry must be a two-element list with a string key. Malformed
entries error when reached. Keys compare by their exact string contents.

String-key assignment updates the first matching pair, preserving its key and
the remaining list. It errors for missing keys, rather than appending. The old
payload's usual slot-conversion rules apply; unrelated payloads are not forced.

```apn
entries "x" = 10
# [["x", 10], ["y", 2]]
```

Integer and enumeration arguments still index by position, list arguments still
select indices, and dot syntax still applies list templates. An association list remains
a list; it does not acquire record fields or record construction behavior.

## Records

```apn
[x: Int, y: 0] [x: 1, y: 2]    # [x: 1, y: 2]
[x: Int, y: Int] [x: 123]        # [x: 123, y: 0]
[x: Int] [x: 123, z: "extra"]    # [x: 123, z: "extra"]
[x: Int, y: (* 2)] [1,2]       # [x: 1, y: 4]
```

Supplied existing fields are applied, omitted type slots are initialized,
and extra fields are appended unchanged. An omitted `Int` becomes typed zero;
omitted concrete values and functions retain their defaults. See [zero initialization](zero-initialization.md).
A nonempty list argument must supply exactly one value per record field.
The empty list `[]` explicitly initializes all fields from their defaults. Record results defer field transformations until demanded.

Keys retain their full string contents, including any quote characters, through application.
`[x: Int, "x": Int] ["x": 1]` produces `[x: 0, "x": 1]`.

For passing collections to functions, destructuring parameters, and records as
named arguments, see [lists and records as arguments](pattern-functions.md#lists-and-records-as-arguments).

## Access and assignment reference

| Container | Read | Assign |
| --- | --- | --- |
| Association list, string key | `entries "x"` or `entries key` | `entries "x" = value` or `entries key = value` |
| List, one index | `arr i` or `arr (i + 1)` | `arr i = value` or `arr (i + 1) = value` |
| List, several indices | `arr [2,0]` or `arr indices` | `arr [2,0] = [a,b]` or `arr indices = values` |
| Record, literal field | `obj.x` | `obj.x = value` |
| Record, computed string key | `obj key` or `obj (prefix ++ key)` | `obj key = value` or `obj (prefix ++ key) = value` |
| Record, several literal fields | `obj.[x,y]` | `obj.[x,y] = [a,b]` |
| Record, one-field selection | `obj.[x]` returns a one-element list | `obj.[x] = [value]` |
| Nested record | `obj.child.x` | `obj.child.x = value` |
| Nested field selection | `obj.child.[x,y]` | `obj.child.[x,y] = [a,b]` |
| Record, positional entry | `obj 0` returns `[key,value]` | Not supported; assign by field name |
| Record, renamed selection | `obj.[x: a, y: b]` | `obj.[x: a, y: b] = [a: 10, b: 20]` |

Bare dot field names are literal strings. Use `obj key` for a computed name
and `obj "(key)"` for a key containing parentheses. `obj.(expression)` performs
[scoped evaluation](semantics.md#record-scoped-expressions). Quoted field syntax includes the
quote characters: `obj."x"` is equivalent to `obj "\"x\""`.
See [record key identity](semantics.md#record-fields-string-keys-and-positions) for the full rules.

List dot syntax performs template application, not indexing or assignment:
`templates.values`, `templates.(expression)`, and `[Int,Float].[1,2]`.
Use `arr indices = values` for a list update, not `arr.[indices] = values`.

## Slot assignment

Index, field, and pluck assignment replace selected slots and rebind a modified
copy in the current scope. Numeric values retain their lossless conversion
checks, variants retain their family, and wrapped functions retain their contracts.

```apn
arr = [1,2]
arr 0 = 3.0                # stores integer 3
# arr 0 = 3.5              # error: lossy conversion

v = [x: Float, y: Int] []
v.x = 123                  # stores 123.0
v "y" = 321                # stores integer 321
```

Bare constructors are replaced without conversion:

```apn
v = [x: Float]
v.x = 123                  # changes the default to integer 123
v = [x: Float]
v.x = Int                  # replaces the constructor
```

Construct the record first (`v = [x: Float] []`) or store an explicit numeric
value (`Float 1`) to retain that numeric constraint on subsequent assignments.
Ordinary records and functions are replaced, never merged or called:

```apn
v = [f: (* 2), child: [x: 1]]
v.f = 3                    # stores 3; does not call (* 2)
v.child = [y: 2]           # replaces the whole child
```

Record application remains a separate operation: `[f: (* 2)] [f: 3]` produces
`[f: 6]`, and `[x: 1] [y: 2]` produces `[x: 1, y: 2]`.

### Computed keys and multiple indices

```apn
arr = [10,20,30]
i = 0
arr i = 11
arr (i + 1) = 22
arr [1,2] = arr [2,1]     # swaps the old values

obj = [x: 0]
key = "x"
obj key = 3
obj (key ++ "y") = 4       # [x: 3, xy: 4]
```

The index or key is evaluated once before the RHS, against the old binding.
List indices are exact integers or nullary enumeration values; a list of indices
selects multiple slots. Negative indices count from the end and require a finite
list. Numeric strings never become indices. Record assignment keys must be strings;
integer record access is read-only positional entry access.

Multi-index assignment requires a finite index list and the same number of
replacement values. Duplicate indices use the last replacement. `arr [] = []`
is a no-op. List assignment never appends: out-of-bounds indices error. Positive
indices can update a finite prefix of an infinite list without consuming its tail.
New record fields are allowed; `obj = []; obj.x = 1` seeds a record.

### Bracketed field assignment

Unnamed bracketed selections require a list with one value per selected field, even for one field:

```apn
obj = [x: 1, y: 2]
obj.[x] = [10]             # assigns 10 to x
# obj.[x] = 10             # error: RHS must be a list
obj.[x,y] = obj.[y,x]    # swaps the old values
obj.[] = []                # no change

obj.items = []
obj.[items] = [[1,2]]     # stores the list [1, 2]
obj.items = [3,4]         # direct assignment takes the value itself
```

### Renamed field assignment

```apn
obj = [x: 1, y: 2]
obj.[x: a, y: b] = [b: 20, a: 10]  # [x: 10, y: 20]
obj.[x: a, y: b] = obj.[y: a, x: b] # swap
```

Every entry must be renamed; the RHS must be a record with exactly the selected
output names. Targets must already exist. Updates use the original slots'
conversion rules and publish only after all replacements pass. Nested targets
such as `obj.child.[x: a]` follow the same rule. Ordinary `obj.[x,y]` assignment
continues to require a list.

### Nested records

```apn
obj = [child: [x: Float 1, y: 2], label: "kept"]
obj.child.x = 10
# [child: [x: 10.0, y: 2], label: "kept"]
obj.child.[x,y] = [20,30]
```

The update rebuilds the parent records and rebinds `obj`, preserving sibling
fields and the selected slot's conversion checks. Paths may contain any number
of literal record fields, including quoted keys. Intermediate fields must exist
and contain records; an empty list at the final parent can seed a record:

```apn
obj = [child: []]
obj.child.x = 10            # [child: [x: 10]]
# obj.missing.x = 10       # error: missing intermediate field
# obj.child.x.y = 10       # error: x is a number
```

This syntax follows record fields; it does not introduce assignment through a
list index or a computed string at an intermediate path segment.

### Scope, sharing, and failures

```apn
obj = [child: [x: 1]]
snapshot <- obj
obj.child.x = 10
print snapshot.child.x     # 1
{
    obj.child.x = 20
}
print obj.child.x          # 10
```

Ordinary updates create scoped copies; they do not mutate captured snapshots.
Use eager binding (`<-`) when taking a snapshot: ordinary lazy aliases can
observe later rebinding. Live [environment views](semantics.md#live-environment)
are an exception: writes through them update their backing bindings.

The RHS sees the old binding. Bounds, shape, and immediate conversion failures
leave that binding unchanged. Selected outer values are checked before publishing;
unrelated values remain deferred. Nested lazy checks may still fail when later
consumed. Side effects performed during evaluation are not rolled back.

Dotted templates return ordinary lists without a persistent container schema;
`Vect n t` retains its explicit schema through list updates. Unbound names and
existing functions keep ordinary pattern-definition behavior: `f i = i + 1`
defines a function, while an expression-only target such as `arr (i + 1) = value`
requires an existing collection.

## Type descriptions and aliases

A finite list or record consisting entirely of type descriptions is itself
accepted in type positions. Ordinary transformation functions are not types.

```apn
Count = Int
Numbers = [Int]
Point = [x: Float, y: Float]
Points = [Point]

Count 123                  # 123
Numbers.[1]                # [1]; Numbers.[1, 2] errors
Point [x: 1, y: 2]         # [x: 1.0, y: 2.0]
cast [Int,Int] [1,2]          # [1, 2]
Type [Int]                # [Int]
isType Type [(* 2)]        # false
```

Aliases are shared type-level bindings, not repeatable zero-argument actions.
They introduce no new nominal identity. `Type` accepts descriptions while their
ordinary container representation remains inspectable.
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
also lazily. They convert as a typed parameter does, and the static check
follows: with `Shape = Circle Float | Square Float`, `Circle 2` holds `2.0`;
with `Byte = MkByte UInt8 | NoByte`, `MkByte 300` is a static range error,
also when the value comes from a variable or from another function's
parameter (`mk x = MkByte x` rejects `mk 300`). A field that is a type
parameter (`Some value`) holds its value unchanged. Grouped and structural payload types compose:
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

## Record field shorthand

`[.x, .y]` expands to `[x: x, y: y]`, using variables from the current scope.
Shorthand and explicit fields can appear together, separated by commas or
newlines:

```apn
x = 1
y = 2
record = [.x, .y]                 # [x: 1, y: 2]
mixed = [.x, other: y]            # [x: 1, other: 2]
```

Each shorthand entry must be a dot followed by a variable name. Use an explicit
field for an expression or renamed value. Values retain ordinary record laziness;
undefined names receive the same checks as explicit field values.

`[x,y]` remains a positional list. `[y,x]` swaps its positions; `[.y, .x]`
creates named fields in that order. To exchange named values, use `[x: y, y: x]`.
The shorthand is record-construction syntax, independent of the receiving function
or inferred types. Existing record patterns and pluck syntax are unchanged.

For example, when these callbacks are in scope:

```apn
main = p5.sketch [.setup, .draw, .mousePressed]
```

## Flattening record fields

An anonymous `_: record` entry merges that record's fields into the literal:

```apn
base = [x: 1]
v = [_: base, y: 2, z: 3]         # [x: 1, y: 2, z: 3]
[_: base, x: "new"]              # [x: "new"]
[x: "new", _: base]              # [x: 1]
```

Entries are processed in source order. New names are appended at that point;
later entries replace duplicate values without moving the existing key's
position. This is a shallow merge, without type conversion. Named nested records
stay nested. Field values and reference cells are shared normally; the outer
record has no parent link to the source. The spread expression must produce a
record; lists and scalars are errors. Multiple `_:` entries are supported.

For an existing record, `v._ = other` merges `other` into a new scoped copy of
`v` using the same replacement rules. No field names are introduced into the
surrounding scope; `use v` remains the explicit way to do that.

An unbound root in `v.x = value` instead starts a dotted pattern binding; see
[dotted patterns](pattern-functions.md#dotted-patterns-keep-the-whole-value).
