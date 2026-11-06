# Templates and type aliases

Every record field has a type: the type it holds (`[x : Float]`), or the type of
the value it holds, which is then that type's default (`[x = 1.1]` is a Float
field defaulting to `1.1`). A record holding a type, given values, builds one;
any other record given fields is updated, exactly as by field assignment (see
[slot assignment](#slot-assignment)). Either way a given value converts to its
field's type. Dotted list application applies its slots and rejects scalar slots.
Concrete scalars (numbers, strings, characters, and booleans) are not callable.

## Concrete defaults

```apn
0 123                       # error: cannot apply a number
[0].[123]                   # error: cannot apply a number
[x = (0 : Int)] [floor .2]  # [x = 0]
[x = (0 : Int)] [(.2 : Float)] # error: lossy conversion
[x = 0] [x = 123]           # [x = 123]
[x = 1.1] [10]              # [x = 10.0]: x is a Float
[x = 1] [2.5]               # error: lossy conversion
[x = False] [1]             # error: cannot use Int where Bool is required
["old"].["new"]             # error: cannot apply a string
[Bool].[True]               # [True]
[Char].['b']                 # ['b']
```

A value given to a field (by position, by name, or by assignment) converts
losslessly to the field's type, whether or not the program is checked: a
number to the default's numeric type (`typeOf` of it, so `1` is an Int),
rejecting overflow and nonzero imaginary-part loss; a string, character or
Bool only from its own kind; a function or action only from its own kind. A
function field is replaced, never applied: `[x = 0, y = (*2)] [1,2]` is an error.
Standalone `"old" "new"`, `'a' 'b'`, and `False True` are application errors.
List templates apply their function slots, including effects (see [Lists](#lists)).

Numeric parameter patterns always require lossless conversion, including for
bare literals. `f (x : Int) = x` accepts `2.0` but does not match `.2`; another
clause may handle it, otherwise application reports no matching clause. Direct
construction `(.2 : Int)` also errors; use `(floor .2 : Int)` to round down explicitly.

## Lists

| Template | Application |
| --- | --- |
| `[f].[x]` | One slot: `[f x]` |
| `[f,g].[x,y]` | Two slots: `[f x, g y]` |
| `[].[]` | Empty list |
| `[f].[]` or `[f].[x,y]` | Length mismatch |

```apn
[(* 2), (* 3)].[1,2]  # [2,6]
[Int,String].[1,"hi"] # [1,"hi"]
Int * [1,2,3]       # mapping, separate from template application
map Int [0..]           # lazy mapping over an infinite list
```

Every template length, including one, uses exact positional matching. Output
heads and tails are deferred; mismatch or conversion errors surface when the
relevant part is consumed. A singleton never broadcasts. `[Int]` describes
exactly one position when used as a schema, including through `cast` and `isType`;
a list of any length is `List Int`, and `[Int..]` is endlessly many (see
[type descriptions](semantics.md#type-descriptions)).
Nested list templates use the same exact-length rule.

Record inputs supply their values in field order. The result preserves the
record's keys and order, and the template must have exactly as many slots as
the record has fields. Converted fields remain lazy:

```apn
[Float].[x = 1]                       # [x = 1.0]
[String,Int].[name = "a", age = 2]   # [name = "a", age = 2]
[(+ 1), (* 2)].[b = 3, a = 4]        # [b = 4, a = 8]
```

Strings supply Unicode code-point characters using the same positional rules:

```apn
[Char,Char]."hi"      # ['h','i']
[Char]."h"              # ['h']
[].""                  # []
to (List Char) "hello"  # arbitrary-length character conversion
```

A template is an ordinary list value. Use `template.values` for a variable input,
or `template.(expression)` for a computed input. On records, `record.values`
still looks up the literal field `values`, while `record.(expression)` evaluates
with the record fields in scope.
`String` converts a finite character list back to text, as `from (List Char)` does:

```apn
cast String $ to (List Char) "hello"  # "hello"
cast String $ cast [Char,Char] $ "hi"  # "hi"
(['h','i'] : String)               # "hi"
([] : String)                        # ""
```

Every element must be a `Char`; lists of strings or numbers are rejected.
Constructing a string consumes the entire list.

Integer application still indexes a list: `[10] 0` returns `10`.
A list argument selects multiple indices: `[10,20,30] [2,0]` returns `[30,10]`.
A record argument names the selected indices and returns a record:

```apn
[10,20,30] [first = 0, last = 2]   # [first = 10, last = 30]
[Int] [x = 0]                      # [x : Int]
[Int] [x = 1]                      # error: index out of bounds
```

Each record value must be an integer or enumeration index. Selection preserves
its field names and order. This is indexing, not template conversion;
`[Int].[x = 1]` instead converts the record's value and returns `[x = 1]`.
Named selections support assignment with exactly the same field names on the
right; replacement order does not matter:

```apn
arr = [10,20,30]
arr [first = 0, last = 2] = [last = 300, first = 100]
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
entries 0                   # ["x",1] (positional indexing)
entries [1,0]             # [["y",2],["x",1]] (index selection)
[["x",1],["x",2]] "x"  # 1 (first match wins)
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
# [["x",10],["y",2]]
```

Integer and enumeration arguments still index by position, list arguments still
select indices, and dot syntax still applies list templates. An association list remains
a list; it does not acquire record fields or record construction behavior.

## Records

```apn
[x : Int, y = 0] [x = 1, y = 2] # [x = 1, y = 2]
[x : Int, y : Int] [x = 123]     # [x = 123, y = 0]
[x : Int] [x = 123, z = "extra"] # [x = 123, z = "extra"]
[x : Int, y = (* 2)] [1,2]    # [x = 1, y = 4]
```

Supplied existing fields are applied, omitted type slots are initialized,
and extra fields are appended unchanged. An omitted `Int` becomes typed zero;
omitted concrete values and functions retain their defaults. See [zero initialization](zero-initialization.md).
A nonempty list argument must supply exactly one value per record field.
The empty list `[]` explicitly initializes all fields from their defaults. Record results defer field transformations until demanded.
A schema's result keeps its fields; see [record fields](semantics.md#records).

Keys retain their full string contents, including any quote characters, through application.
`[x : Int, x : Int] [x = 1]` produces `[x = 0, x = 1]`.

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
| Record, positional entry | `obj 0` returns `[key,value]` | `obj 0 = [key,value]` |
| Record, renamed selection | `obj.[a = x, b = y]` | `obj.[x = a, y = b] = [a = 10, b = 20]` |

A field after `.` is a name, in backticks when it is not one (``obj.`my value` ``).
Use `obj key` for a computed name. `obj.(expression)` performs
[scoped evaluation](semantics.md#record-scoped-expressions).
See [records](semantics.md#records) for the full rules.

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

v = [x : Float, y : Int] []
v.x = 123                  # stores 123.0
v "y" = 321                # stores integer 321
```

A slot holding a type takes a type, which changes it, or a value, which
becomes a default of that type (as `x: (123 : Float)` would be written):

```apn
v = [x : Float]
v.x = 123                  # [x = 123.0]
v = [x : Float]
v.x = Int                  # [x : Int]
xs = [Int]
# xs 0 = .2                # error: lossy conversion
```

A `Type` field's values are types: `[type : Type] [Int]` and
`[type : Type] [type : Int]` are both `[type : Int]`. Records are replaced, never
merged; a function is replaced by a function, never called:

```apn
v = [f = (* 2), child = [x = 1]]
v.f = (+ 1)                # replaces (* 2); does not call it
v.child = [y = 2]          # replaces the whole child
# v.f = 3                  # error: cannot use Int where a -> b is required
```

A record applied to a record of fields is field assignment, `r [f = v, g = w]`
being `{ r.f = v; r.g = w; r }` in every way (a field keeps its number type or
variant family, a schema's record takes no new field, nothing else is
evaluated), when the record holds values or the fields hold types. So
`[f = (* 2)] [f = (+ 1)]` is `[f = (+ 1)]`, `[x = 1] [y = 2]` is `[x = 1, y = 2]`, a
model is updated as Elm's `{ model | name = n }` (`model [name = n]`), and a
type is edited as `Vector3.x = Int` edits it: `Vector3 [x : Int]` is
`[x : Int, y : Float, z : Float]`. A record holding a type given values builds
one: given fields take their values as by assignment and the others their
defaults, so `Vector3 [x = 1]` is `[x = 1.0, y = 0.0, z = 0.0]`. (Assigning a
value into a type's field sets that field's default instead: `Vector3.x = 1`
is the type `[x = 1.0, y : Float, z : Float]`, and `Vector3 []` is then
`[x = 1.0, y = 0.0, z = 0.0]`.) A list gives values in field order, exactly as by
name: `r [10,20]` is `r [x = 10, y = 20]`. Whether a record holds a type is told
from what it was built with and the fields it is given, without evaluating the
others. A parameter given a record literal may be a function or
such a record; the checker decides once its type is known.

### Computed keys and multiple indices

```apn
arr = [10,20,30]
i = 0
arr i = 11
arr (i + 1) = 22
arr [1,2] = arr [2,1]   # swaps the old values

obj = [x = 0]
key = "x"
obj key = 3
obj (key ++ "y") = 4       # [x = 3, xy = 4]
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
obj = [x = 1, y = 2]
obj.[x] = [10]             # assigns 10 to x
# obj.[x] = 10             # error: RHS must be a list
obj.[x,y] = obj.[y,x]  # swaps the old values
obj.[] = []                # no change

obj.items = []
obj.[items] = [[1,2]]    # stores the list [1,2]
obj.items = [3,4]        # direct assignment takes the value itself
```

### Renamed field assignment

```apn
obj = [x = 1, y = 2]
obj.[x = a, y = b] = [b = 20, a = 10] # [x = 10, y = 20]
obj.[x = a, y = b] = obj.[a = y, b = x] # swap
```

Every entry must be renamed; the RHS must be a record with exactly the selected
output names. Targets must already exist. Updates use the original slots'
conversion rules and publish only after all replacements pass. Nested targets
such as `obj.child.[a = x]` follow the same rule. Ordinary `obj.[x,y]` assignment
continues to require a list.

### Nested records

```apn
obj = [child = [x = (1 : Float), y = 2], label = "kept"]
obj.child.x = 10
# [child = [x = 10.0, y = 2], label = "kept"]
obj.child.[x,y] = [20,30]
```

The update rebuilds the parent records and rebinds `obj`, preserving sibling
fields and the selected slot's conversion checks. Paths may contain any number
of literal record fields, backticked ones included. Intermediate fields must exist
and contain records; an empty list at the final parent can seed a record:

```apn
obj = [child = []]
obj.child.x = 10            # [child = [x = 10]]
# obj.missing.x = 10       # error: missing intermediate field
# obj.child.x.y = 10       # error: x is a number
```

This syntax follows record fields; it does not introduce assignment through a
list index or a computed string at an intermediate path segment.

### Scope, sharing, and failures

```apn
obj = [child = [x = 1]]
snapshot <- obj
obj.child.x = 10
print snapshot.child.x     # 1
{
    obj.child.x = 20
}
print obj.child.x          # 10
```

Ordinary updates create scoped copies; they do not mutate captured snapshots,
and a lazy alias keeps the version it saw, as every binding does.

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
Point = [x : Float, y : Float]
Points = [Point]

(123 : Count)              # 123
Numbers.[1]                # [1]; Numbers.[1,2] errors
Point [x = 1, y = 2]       # [x = 1.0, y = 2.0]
cast [Int,Int] [1,2]        # [1,2]
([Int] : Type)            # [Int]
isType Type [(* 2)]        # False
```

Aliases are shared type-level bindings, not repeatable zero-argument actions.
They introduce no new nominal identity. `Type` accepts descriptions while their
ordinary container representation remains inspectable.
Mixed defaults such as `[x : Int, y = 0]` are templates, not type descriptions.

Patterns accept aliases and inline descriptions:

```apn
firstNumber (Numbers xs) = head xs
firstNumber [123]             # 123
firstInline (xs : [Int]) = head xs
getX (p : [x : Int]) = p.x
```

These are lazy runtime conversion contracts, not a static type checker.
Record construction initializes omitted type fields from their defaults and
retains concrete defaults. `isType description value` checks membership
without conversion and requires described record fields to be present with
matching values. A complete list membership check consumes the list.

A capitalized name may also be bound to a lambda, as any name may: how it is
used decides what it is. Applied, it runs, so `Sized = n -> Vect n Int` makes
`Sized 2` the type `Vect 2 Int`, as `Sized n = Vect n Int` does. Where a type
is expected, it reads as the function type it spells: after
`Handler = a -> Int`, `run (h : Handler) = h 1` accepts functions returning
an `Int`.

## Constructor functions

A capitalized definition computes: applied, it gives what its body gives, a
type (`Sized n = Vect n Int`: `Sized 2` is `Vect 2 Int`) or any value. A scalar
type it names is kept as a
[named subtype](type-and-resource-rules.md#distinct-types) (`Count = Int`:
`5 : Count` is a `Count`). A body of `_` makes a constructor instead (see
[variants](#variants-parameters-and-distinct-wrappers)).

One that gives any other type (a type or a schema, not a constructor) gives,
applied to all its parameters, a type that remembers how it was written:
`Point = [x : Float, y : Float]` is `Point`, `Pairs 2 Int` is `Pairs 2 Int`. It
is that type wherever a type is used (`(Point : Type)` shows what it is), and the
values it makes, by applying it or by a conversion to it (`List (Pairs 1 Int)`,
a field, a slot's default), remember it too, as does an updated copy of one.
They are still what the type makes, so everything that takes one takes them,
and what is computed from them is a plain value. A pattern of a name with
parameters reads back what was remembered. Another value is read back only by
clauses that build their result from `[]` and `::`, run backwards
([dependent types](gradual-and-dependent-types.md)); this one computes
`n * 2`, which cannot be:

```apn
Pairs n a = Vect (n * 2) a
Pairs 2 Int                 # Pairs 2 Int, which is Vect 4 Int
xs = [1,2,3,4] : Pairs 2 Int
typeOf xs                   # Pairs 2 Int
length xs                   # 4; map (* 2) xs is [2,4,6,8], a plain list
size (xs : Pairs n a) = n   # size xs is 2
size [1,2,3,4]              # no clause: nothing remembers an n for a plain list
kind (Pairs n a) = n        # kind (Pairs 3 Int) is 3
```

A capitalized left side whose name is a constructor (`Some`, or `Rect` once
declared) is a pattern, so `Rect w h = r` takes `r` apart, except with the body
`_`, which declares it again; any other is a definition, whatever its
parameters. Adjacent clauses of one name are one definition:

```apn
Pairs Z a = []
Pairs (S k) a = a :: a :: Pairs k a
Pairs 2 Int                 # [Int,Int,Int,Int]
```

The run chooses among clauses with patterns; the checker leaves their result
to it.

## Variants, parameters, and distinct wrappers

A capitalized definition whose body is `_` declares a constructor: its
application stands for nothing but itself, so it is a value, with one field per
parameter. A name holds anything (a type parameter); a typed name converts its
field as a typed parameter does. A lowercase definition's `_` stays unfinished.

```apn
Box x = _                     # the same as Box a = | Box a
Rect (w : Float) (h : Float) = _ # Rect 3 4 is Rect 3.0 4.0
Nothing = _                   # a constructor without fields
unbox (Box x) = x             # unbox (Box 5) is 5
```

A body that holds `_` declares the constructor the same way and is its logic:
applying the constructor runs it, and its `_` is the value itself, the fields
as the parameters bound them (`tag Percent Percent [x]`). So the logic decides what every value of the type is:
it can normalize a value, fail, or build another one, and a pattern reads back
only what it stored.

```apn
Percent (x : Float) = x > 100 ? Percent 100.0 : _
Percent 150                   # Percent 100.0
(Percent a) + (Percent b) = Percent (a + b)
Percent 90 + Percent 20       # Percent 100.0: the clause calls Percent, so its logic runs
Span (lo : Int) (hi : Int) = lo > hi ? fail "empty span" : _
```

Every way of making one runs it, a record slot's default too (`[s = Span] []`
runs it on `Span 0 0`), and the checker checks that it gives the constructor's
type. Its fields are named, since `_` holds them.

A union of constructors declared with `_` claims them: they become one type's,
exactly as a declaration of that type with those constructors makes it. So the
first union listing a constructor owns it, and `typeOf`, typed patterns and
monads (`return = Just`) key on that type. An alternative may restate a
constructor's fields (`Just a`, tying them to the type's parameters); a bare
one keeps the constructor's own. Within one source the union's declaration
stands where its first constructor did; constructors declared elsewhere (an
earlier REPL input, a module) are claimed where the union runs, so values made
before it keep their own type.

```apn
Just x = _
Nada = _
Maybe a = Just a | Nada       # the same as Maybe a = Just a | Nada declaring both
Circle (r : Float) = _
Square (s : Float) = _
Shape = Circle | Square       # typeOf (Circle 1) is Shape
```

What `X = A | B` is depends on what its alternatives' names are bound to
where it runs. All new names declare them as constructors of `X`; all
constructors declared with `_` that no union owns yet are claimed, as above.
All existing types make `X` their union, which makes nothing: a value of any of
them is one of it, `(v : X)` matches it, and applying `X` checks membership. A
mix (a type and a new name, or another type's constructor) is an error that
names the odd one out.

```apn
Mixed = Int | String          # Type Mixed is Int | String
f (m : Mixed) = m             # takes 1 and "a", not 2.5
(2.5 : Mixed)                 # error: Float is not one of Int | String
OptOrList a = Option a | List a
```

A `|` distinguishes a constructor declaration from a type alias. On one line,
constructors are separated by `|` with no leading one, except a single
constructor, which needs a leading pipe to be a declaration. On several lines,
the constructors start on the line after `=`, each on its own line after a `|`:

```apn
Shape =
    | Circle Float
    | Square Float
```

```apn
Option a = Some a | None
Optional a = Option a
UserId = | MkUserId Int

(Some 123 : Optional Int)  # Some 123
Option Int None            # None
MkUserId 123               # MkUserId 123
Some value = Some 123      # destructures; value is 123
None = None                # pattern assertion
```

Type parameters are retained and supplied by type application. `typeOf` reports a
value's narrowest type: its fields decide the parameters they name, demanding
them (`typeOf (Some 123)` is `Option Int`, `typeOf (Box [1])` is `Box [Int]`),
and one nothing decides is a type variable (`typeOf None` is `Option a`).
Explicit specialization retains its arguments: `typeOf (None : Option Int)` is
`Option Int`. Against a bare type it still compares by name: `typeOf (Some 1) == Option`. Different type arguments produce
different type descriptions. Payload conversions are deferred until used.
Concrete fields such as `Int` in `MkUserId Int` are enforced on construction,
also lazily. They convert as a typed parameter does, and the static check
follows: with `Shape = Circle Float | Square Float`, `Circle 2` holds `2.0`;
with `Byte = MkByte UInt8 | NoByte`, `MkByte 300` is a static range error,
also when the value comes from a variable or from another function's
parameter (`mk x = MkByte x` rejects `mk 300`). A field that is a type
parameter (`Some value`) holds its value unchanged. Grouped and structural payload types compose:
`Tree a = Branch [a] | Leaf a`. A record alias is a type like any other, also as
a type's argument (`Path (List Point)`, `Got (Result Point String)` with
`Point = [x : Float, y : Float]`), and a field may name a module's type
(`Resized browser.Viewport`).

`func (value : Option Int) = ...` checks parent membership and applies the
specialized payload contract. An unrelated outer value falls through to the
next clause. A deferred payload failure is a runtime error when demanded, not
an invitation to rerun another clause.

Existing value constructor names on the left destructure and cannot be
redefined (see [constructor functions](#constructor-functions)).
An unspecialized parent pattern `(value : Option _)` still binds the whole variant.
A constructor pattern `(Some value)` extracts its field. A constructor sharing
its type's name (`Box x = _`, `Box a = | Box a`) is the constructor where a
value is expected and the type where one is expected: a field's type
(`Wrap (Box b) = _`), a record slot (`[b = Box] []` is `[b = Box 0]` for
`Box (x : Int) = _`), `isType Box`, a type's argument (`List Box`), a union.
Applied to a type for each of its type's parameters, it is likewise a value
(`Box Int`, a `Box` holding `Int`) that reads as that type applied to them
where a type is expected, as a lambda reads as a function type:
`Wrap a = | Wrap (Box a)`, `isType (Box Int) (Box 1)`, `[b = Box Int] []`. So
`f (b : Box Int) = ...`, or `f (Box Int b)`, takes a `Box Int` whole, while
`unbox (Box x) = x`, with as many arguments as `Box` has fields, still takes it
apart. This needs its fields to be exactly its parameters (`Box x = _`, not
`Box (x : Int) = _`).

Nominal wrappers are single-constructor types (`UserId (id : Int) = _`); see
[distinct types](type-and-resource-rules.md#distinct-types). No automatic
cross-type conversion or zero-cost representation is implied. Class/instance syntax and static type
inference are not part of this change.

Record-template patterns also accept positional lists with exactly as many
items as the template has fields: `f (Vector3 v) = v` accepts `f [1,2,3]`
when `Vector3 = [x : Float, y : Float, z : Float]`. Conversion is the same lazy
conversion as `Vector3 [1,2,3]`. Wrong lengths do not match; shape checking
reads at most one cell beyond the required count, including infinite inputs.
Field conversion errors remain deferred until those fields are demanded.
Equally matching record templates retain source-order dispatch.

## Flattening record fields

A `use record` field merges that record's fields into the literal:

```apn
base = [x = 1]
v = [use base, y = 2, z = 3]      # [x = 1, y = 2, z = 3]
[use base, x = "new"]            # [x = "new"]
[x = "new", use base]            # [x = 1]
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
