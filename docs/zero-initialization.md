# Zero is initialization

A type supplies a useful zero value when consumed as data. Its constructor and
pattern behavior are preserved. This is a semantic default, not just a printing
shortcut: `Int + 1` is `1`, `sqrt Float` is `0.0`, and `Int == 0` is true.

```apn
Vector3 = [x: Float, y: Float, z: Float]
v = Vector3
print v                 # [x: 0.0, y: 0.0, z: 0.0]
v.x = 123
print v                 # [x: 123.0, y: 0.0, z: 0.0]
print Vector3           # [x: 0.0, y: 0.0, z: 0.0]
```

Updates still rebind a scoped copy; they do not modify the shared template.
Reading or printing a default does not erase a slot's constructor. Every later
assignment to the Float slots above must still convert losslessly to Float.

## Default values

| Type | Default display |
| --- | --- |
| `Int` | `0` |
| `Float` | `0.0` |
| `UInt`, fixed-width integers | Typed zero, e.g. `UInt32 0` |
| `Float32`, `Float64` | `Float32 0.0`, `Float64 0.0` |
| `Fraction` | `Fraction 0` (mathematical zero, never 0/0) |
| `Complex`, `ComplexExact` | `Complex 0`, `ComplexExact 0` |
| `Number`, `Real`, `Integer`, `Exact` | Exact integer `0` |
| `Inexact` | Inexact `0.0` |
| `Bool` | `false` |
| `String` | `""` |
| `Char` | `'\0'` (the NUL code point) |
| `Unit` | `()` |
| `List` | `[]` |
| `Record` | Empty record, displayed `[]` |
| `HashMap` | `HashMap []` |
| `Pointer` | `Pointer 0x0` (null; dereferencing still errors) |

Records retain their field structure and use each field's default. Lists retain
all their elements: **`[Int]` displays `[0]`, not `[]`**. It is still a singleton
list template, so `[Int] [1,2,3]` produces `[1, 2, 3]`. `List` is the empty-list
default; `[Int] []` also yields an ordinary empty list. There is no hidden element
schema attached to that result.

Int and Float values omit their type label in output, including explicitly
constructed values. `Int32`, `Float32`, `Float64`, and other specialized numeric
types retain labels. All annotations still participate in checked arithmetic.

## Constructors and type inspection

```apn
Int 123                     # 123, typed Int
[1,2,3] * Int               # [1, 2, 3]
f (Int x) = x + 1
f Int                       # 1

typeOf (Int 123)             # Int
typeOf Int                   # Type
Type Int                     # Int
Type Vector3                 # [x: Float, y: Float, z: Float]
```

Descriptors remain first-class types internally. `typeOf`, generic `(t x)`
patterns, and explicit `Type value` inspection return descriptors that display
type names. They remain callable: `(typeOf 123) 456` produces `456`.
A bare descriptor and its default coexist: `isType Type Int` and `isType Int Int`
are both true. Type inspection does not affect conversion or arithmetic.

Equality between inspected type descriptors compares type identity:
`Type Int == Type Float` is false. Ordinary default-value comparison uses numeric
or structural equality: `Int == Float` is true because both default to zero.
Use `Type` when comparing type descriptions, especially specialized variants.

Existing callable overloads take priority over default projection. In particular,
`3 * Int` and `Int * 3` still iterate, producing `[0, 1, 2]`; `3 * Int 0` is
numeric multiplication and produces `0`. Composition with `Int` still composes
its constructor. This preserves the existing map-like use of types.

## Variants

A family defaults to its first declared nullary constructor, if there is one.
Otherwise it uses its first constructor, recursively defaulting its fields.

```apn
Option a = Some a | None
Option Int                   # None

Color = Red | Green | Blue
Color                        # Red

User = | MkUser Int String
User                         # MkUser 0 ""

BoxType a = | MkBox a
BoxType Int                  # MkBox 0
```

The family name supplies the default; a value constructor such as `MkBox`
remains a function requiring its arguments. When family and constructor share
a name, the existing constructor binding wins. Use distinct names to access
both roles directly.

Defaults are lazy. Unused fields remain unforced. A recursive family with no
finite default reports an error when its recursive field is demanded, rather
than recursing forever. Expanding defaults are also bounded to 128 nested family
initializations. A missing type parameter needed by a field also errors.
A nullary default does not need to inspect unused type parameters.

`Type`, `Function`, function contracts, `Mutable`, and the abstract `Variant`
guard remain descriptors without implicit data defaults. APN does not invent
a function body, silently allocate a shared mutable cell, or choose an unrelated
variant. Write `Mutable Int` to allocate a cell initialized to integer zero.
Such unsupported defaults inside a variant field report an explicit-default error.

## Lossless construction

Constructors now apply the same checks to bare and annotated numbers:

```apn
Int .2                       # error: lossy conversion
Int (Float .2)               # error: lossy conversion
Int (floor .2)               # 0
Int (truncate (-1.7))        # -1
Float (inexact 9007199254740993) # 9007199254740992.0
```

Overflow and imaginary-part loss still error. `.2` remains an inexact binary64
literal, not an infinitely precise number whose representation is chosen later.
Numeric patterns remain lossless and do not match `.2` as an Int.

`cast` stays APN-defined as a compatibility wrapper:

```apn
cast (Type target) value = target value
```

It is now equivalent to direct application, including rejection of lossy inputs.
Prefer the constructor directly; choose `floor`, `ceiling`, `round`, `truncate`,
or `inexact` explicitly when the value needs rounding first. Float32 arithmetic
continues to round its results to binary32, but `Float32 .1` now errors.
