# Zero is initialization

Types are constructors, not their zero values. `Int` prints `Int`, `Int + 1`
is an error, and `Int == 0` is false. Initialization happens when applying a
record template to a list or record of supplied fields:

```apn
Vector3 = [x: Float, y: Float, z: Float]
vec = Vector3 []        # [x: 0.0, y: 0.0, z: 0.0]
vec.x = 1              # [x: 1.0, y: 0.0, z: 0.0]
Vector3 [1,2,3]    # [x: 1.0, y: 2.0, z: 3.0]
# Vector3 [1,2]       # error: positional fields must be complete
Vector3 [z: 3]         # [x: 0.0, y: 0.0, z: 3.0]
Vector3                # Vector3; Type Vector3 is [x: Float, y: Float, z: Float]
typeOf vec             # Vector3
```

Supplied fields convert to their slots' types. Omitted type slots initialize to
the defaults below; omitted concrete values retain their defaults. Nested
record/list slots initialize recursively. Extra named fields are appended;
nonempty positional lists must supply exactly one value per field. Only `[]`
initializes every field from its default. Default fields remain lazy.

Assignments rebind a scoped copy and preserve numeric annotations. The displayed
`0.0` above is internally `Float 0.0`, so later assignments remain checked Float
conversions. The original template remains unchanged.

Assigning a value to a type slot makes it that type's default
([slot assignment](templates-and-types.md#slot-assignment)). Untouched slots
remain type descriptors; the shared template is unchanged:

```apn
vec = Vector3
vec.x = 1              # [x: 1.0, y: Float, z: Float]
vec []                 # [x: 1.0, y: 0.0, z: 0.0]
```

A constructed Float field keeps its type: assigning `Int` to it fails with
`cannot use Type where Float is required`.

## Default values for omitted slots

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
| `Bool` | `False` |
| `String` | `""` |
| `Char` | `'\0'` (the NUL code point) |
| `List` | `[]` |
| `Record` | Empty record, displayed `[]` |
| `HashMap` | `HashMap []` |
| `Pointer` | `Pointer 0x0` (null; dereferencing still errors) |

These are construction defaults, not alternate meanings of bare type names.
`[Int]` remains a one-element list. `[Int].[1]` constructs one value;
`[Int].[1,2,3]` and `[Int].[]` are length errors. Use `Int * [1,2,3]` to map.

Int and Float values omit their type labels in output. Specialized numeric types
retain their labels. All annotations participate in checked arithmetic.

## Constructors and type inspection

```apn
Int 123                # 123, typed Int
typeOf (Int 123)        # Int
typeOf Int              # Type
isType Int Int         # False
isType Type Int        # True
Int == Float           # False
Type Vector3           # [x: Float, y: Float, z: Float]
3 * Int                # [0,1,2]
Int * 3                # [0,1,2]
3 * Int 0              # 0
```

Types remain first-class callable values. Reflection and generic `(t x)` patterns
return the same callable type descriptions. Function iteration and composition
are unchanged. Passing `Int` to an `(Int x)` pattern fails: the descriptor is
not an integer.

## Variant defaults

Inside an omitted record slot, a family defaults to its first declared nullary
constructor if it has one. Otherwise it uses its first constructor, recursively
initializing the payload fields:

```apn
Option a = Some a | None
[choice: Option Int] []     # [choice: None]
User = | MkUser Int String
[user: User] []             # [user: MkUser 0 ""]
User                       # User, the type descriptor
```

Recursive families with no finite default and missing required type parameters
report an error when the affected field is demanded. Recursive family expansion
is bounded to 128 levels. Supplied fields bypass default initialization.

`Type`, `Function`, function contracts, `Mutable`, and the abstract `Variant`
guard require explicit values; initialization does not invent functions or
allocate mutable cells. Use `Mutable (Int 0)` for an explicit cell.

## Lossless construction

Constructors now apply the same checks to bare and annotated numbers:

```apn
Int .2                       # error: lossy conversion
Int (Float .2)               # error: lossy conversion
Int (floor .2)               # 0
Int (truncate -1.7)          # -1
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

Numeric assignment uses the same type as `typeOf`, including for literals:
`v = [x: 1]; v.x = 1.0` keeps Int 1, while `v.x = 1.5` fails.
