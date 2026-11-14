# Intrinsic types, defined in APN

**Intrinsics don't get special treatment.** A built-in type behaves exactly as
the APN definition below would: the same values, the same patterns, the same
errors. The interpreter only stores and computes it faster (a bigint for a
natural, IEEE 754 hardware for a float). Where the two disagree, the definition
is right and the interpreter is wrong. `List` and `Vect` are defined this way in
the prelude already; for the others the definitions here are the model, written
as a program would write them. A built-in type's name is a name like any other:
a program that defines `Int` shadows the built-in one, as it can shadow `map`,
and from then on `Int` in its patterns, ascriptions and `typeOf` is its own.

Each definition uses only the language's own forms: a constructor is a
definition whose body is `_`, a union of types is `(A | B)`, a family of types
is a definition with parameters, and an operator is a prelude function. Where
the language cannot yet say something, this page says so: those gaps are what
the language still lacks, not exceptions the built-ins enjoy.

## Bool

```apn
Bool = True | False
# A Bool applied to two values is one of them (the prelude's own clauses), so
# c ? a : b is truthy c a b, and not swaps the two.
get True a = _ -> a
get False _ = b -> b
not x = truthy x False True
```

`True` and `False` are spelled as keywords; they are these two constructors. A
condition's truth is `truthy x`, a function (`False`, zero, empty and null
values are `False`, anything else `True`), not a conversion: `5 : Bool` is an
error, as only a `Bool` is one.

## Natural numbers: `UInt`

```apn
UInt = Z | S UInt              # S (S Z) is 2
add Z m = m
add (S n) m = S (add n m)
```

A `UInt` is stored as a bigint, and `Z` and `S` are its constructors as a view:
`f (S k) = k` takes `5` apart as `S 4`, and `S (S Z)` prints `2`. A natural is
a list of units, `List []`, its length the only thing it keeps: the two have
the same shape (`Z` is `Nil`, `S n` is `Cons [] n`).

## Lists

```apn
Nil = []
Cons = intrinsics.cons
List a = Nil | Cons a (List a)                                  # the prelude's
Vect n a = Nil -> Vect Z a | Cons a (Vect k a) -> Vect (S k) a  # the prelude's
```

`[]` and `::` only write `Nil` and `Cons` another way. `Vect n a` is a list
indexed by its length, the natural each list forgets its elements down to. It
reuses `List`'s constructors rather than declaring its own (Idris's `Vect` has
its own `Nil` and `::`): its values are the same lists, so `Vect 3 Int <=
List Int` and no conversion is needed.

## Integers and the other exact numbers

```apn
Int = Pos UInt | Neg UInt
Neg Z = Pos Z                  # one zero
Fraction (n : Int) (d : Int) = d == 0 ? fail "zero denominator" : lowest n d _
```

`lowest` divides by the greatest common divisor and makes the denominator
positive, so every fraction has one spelling; a `Fraction` whose denominator is
1 is never made (`6 / 3` is `2`, an `Int`). `ComplexExact` is
`ComplexExact [re : Fraction, im : Fraction]` with the same care.

The sized integers (`Int8` ... `Int128`, `UInt8` ... `UInt128`) are `Int`
restricted to a range, a [refinement type](semantics.md#refinement-types):

```apn
Int8 = (n : Int) | -128 <= n && n <= 127
UInt8 = (n : UInt) | n <= 255
```

A name defined as a type names a subtype of it
([named types](type-and-resource-rules.md#distinct-types)), so an `Int8` keeps its
name (`typeOf (1 : Int8)` is `Int8`, printed as its number) through arithmetic
with itself or a plain `Int` (`(1 : Int8) + 2` is an `Int8`), and the range is
checked where a value becomes one and on each result (`300 : UInt8` and
`(200 : UInt8) + (100 : UInt8)` are errors), never by wrapping around. Two
different names do not mix (`(1 : Int8) + (2 : Int16)` is an error).

## Inexact numbers

```apn
Float = | Float [sign : Bool, exponent : Int, significand : UInt]
Complex = | Complex [re : Float, im : Float]
```

A `Float` is an IEEE 754 binary64 number: its arithmetic rounds each result to
the nearest representable value. The model above is correct and slow, which is
the whole reason the type is intrinsic. `Float32` is the binary32 one.

## The numeric unions

```apn
Integer = (Int | UInt | Int8 | UInt8 | Int16 | UInt16 | Int32 | UInt32 | Int64 | UInt64
    | Int128 | UInt128)
Exact = (Integer | Fraction | ComplexExact)
Inexact = (Float | Float32 | Complex)
Real = (Integer | Fraction | Float | Float32)
Number = (Real | Complex | ComplexExact)
```

These name sets of the types above and make nothing: `Int <= Real` is `True`
because every `Int` is in the union.

## Text

A `Char`'s number is a Unicode scalar value, a code point that is no
surrogate:

```apn
Scalar = (n : UInt) | n <= 1114111 && (n < 55296 || n > 57343)
Char = | Char Scalar
String = | String (List Char)  # text: to (List Char) and from (List Char) convert
```

## Records, functions and types

- A **record** is code: a list of bindings (`[x = 1, y = x + 1]`), each field
  the value its binding gives. `Record` is the set of all of them.
- A **function** is what the rest of this page is made of: a definition's
  clauses, applied by substitution. Its model is the language itself, and
  `(a -> b)` is the set of functions taking an `a` to a `b`.
- A **type** is a set of values. `Type` is the set of types, and itself one of
  them (`Type : Type`): consistent for programming, though not as a logic.
- A **variant** is any constructor's application; `Variant` is the set of all.

## Effects and references

```apn
IO a = | IO (World -> [a,World])
Mutable a = | Mutable Ref
Pointer = | Pointer UInt
HashMap k v = | HashMap (List [k,v])
```

An action is a function from the state of the world to a result and the next
state, and `>>=` threads that state through, which is why no action runs when
it is applied, only when something runs it. `World` (the state
of everything outside the program) and `Ref` (a place in the store) are the
interpreter's: no program has a constructor for them, since their values exist
only while a program runs. A program's own types have no such thing: APN has
no abstract types, every constructor is public. A `Mutable` cell is a reference into the world's store, and `set` an
action that changes the store; a `HashMap` is an association list whose keys
appear once.

Modules are where the language cannot yet say it. `load` is the prelude's
(`load file = map parse (intrinsics.readFileFrom (file ++ ".apn"))`), but
`import` is `intrinsics.import`: a folder's modules (`std.option`) are read and
run when a field is first used, an effect inside reading a value, which APN
expresses only as an action. Defining it in APN would take an intrinsic running
an action when its value is needed, which would let any program hide an effect,
or importing every module of a folder at once.

## Dynamic

`Dynamic` is the set of all values. What sets it apart is when its values are
checked: as they are used, at runtime, rather than before the program runs.
