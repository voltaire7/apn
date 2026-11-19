# Intrinsics, defined in APN

**Intrinsics don't get special treatment.** A built-in type or function behaves
exactly as the APN definition below would: the same values, the same patterns,
the same laziness, the same errors. The interpreter only stores and computes it
faster (a bigint for a natural, IEEE 754 hardware for a float, a loop for a
fold). Where the two disagree, the definition is right and the interpreter is
wrong. `List` and `Vect` are defined this way in
the prelude already; for the others the definitions here are the model, written
as a program would write them. A built-in type's name is a name like any other:
a program that defines `Int` shadows the built-in one, as it can shadow `map`,
and from then on `Int` in its patterns, ascriptions and `typeOf` is its own.

Each definition uses only the language's own forms: a constructor is a
definition whose body is `_`, a union of types is `(A | B)`, a family of types
is a definition with parameters, and an operator is a prelude function. Where
the language cannot yet say something, this page says so: those gaps are what
the language still lacks, not exceptions the built-ins enjoy. The types come
first, then [the functions](#functions) (`src/natives.ts` lists every native).

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
HashMap k v = | Entries (List [k,v])
```

An action is a function from the state of the world to a result and the next
state, and `>>=` threads that state through, which is why no action runs when
it is applied, only when something runs it. `World` (the state
of everything outside the program) and `Ref` (a place in the store) are the
interpreter's: no program has a constructor for them, since their values exist
only while a program runs. So is `Entries`: a map is made by converting an
association list to its type, `([["a",1]] : HashMap String Int)`, which keeps each
key once. A program's own types have no such thing: APN has
no abstract types, every constructor is public. A `Mutable` cell is a reference into the world's store, and `set` an
action that changes the store; a `HashMap` is an association list whose keys
appear once.

`import` is `intrinsics.import` and `load` the prelude's `load file =
intrinsics.runFile (file ++ ".apn")`, actions as `readFileFrom` is: each runs a
file in a scope of its own, yielding its value (its last statement's), `import`
once per run, after finding the module, and for a folder every entry with it,
so reading a field (`std.option`) runs nothing; `load` again each time. Only
finding files and running one in a scope of its own are the interpreter's.

## Dynamic

`Dynamic` is the set of all values. What sets it apart is when its values are
checked: as they are used, at runtime, rather than before the program runs.

# Functions

A native is a function bound to JavaScript. Those with an APN definition are
given one here; `tests/intrinsics-test.ts` runs the definitions against the
natives on the same inputs, and they differ at most in an error's wording. Each clause takes only what
it is written with, so a definition's patterns say what the native accepts.

## Lists

```apn
head (x :: _) = x
head [] = fail "head of empty list"
tail (_ :: xs) = xs
tail [] = fail "tail of empty list"
null [] = True
null (text : String) = text == ""
null (m : HashMap _ _) = null (pairs m)
null _ = False
length [] = 0
length (_ :: xs) = 1 + length xs
length (text : String) = length (to (List Char) text)
length (m : HashMap _ _) = length (pairs m)
take 0 _ = []
take (n : UInt) [] = []
take (n : UInt) (x :: xs) = x :: take (n - 1) xs
drop 0 xs = xs
drop (n : UInt) [] = []
drop (n : UInt) (_ :: xs) = drop (n - 1) xs
filter keep [] = []
filter keep (x :: xs) = keep x ? x :: filter keep xs : filter keep xs
foldl f acc [] = acc
foldl f acc (x :: xs) = {
    next = f acc x
    seq next (foldl f next xs)
}
foldr f z [] = z
foldr f z (x :: xs) = f x (foldr f z xs)
zipWith f (x :: xs) (y :: ys) = f x y :: zipWith f xs ys
zipWith _ _ _ = []
iterate f x = x :: iterate f (f x)
enumerate xs = zipWith (i, x -> [i,x]) [0..] xs
```

Each is as lazy as its definition: `take 0` never looks at its list, `map`,
`filter`, `zipWith`, `iterate` and `enumerate` make an endless list's cells as
they are read, `foldr` stops where `f` does not read its second argument
(`foldr (x, acc -> x) 0 [1..]` is `1`), and `head [1, fail "x"]` is `1`. `foldl` is strict in its accumulator (`seq`, below), as Haskell's
`foldl'`; the interpreter runs it and `length` as loops, in constant stack.
`map` over a list is its list instance (see [monads](#monads)).

## Maps

A `HashMap` is an association list whose keys appear once, in the order they
were first inserted; `pairs m` is that list. On it:

```apn
keys m = map head (pairs m)
values m = map (entry -> entry 1) (pairs m)
has key m = not (null (filter (entry -> head entry == key) (pairs m)))
lookup key m = filter (entry -> head entry == key) (pairs m) ~ [
    [] -> fail "HashMap key not found"
    entry :: _ -> entry 1
]
remove key m = (filter (entry -> head entry != key) (pairs m) : HashMap _ _)
insert entries m = foldl (map, entry -> put entry map) m entries
# A key already there keeps its place.
put [key,value] m = has key m
    ? (map (entry -> head entry == key ? [key,value] : entry) (pairs m) : HashMap _ _)
    : (pairs m ++ [[key,value]] : HashMap _ _)
```

## Truth, operators and indexing

```apn
truthy True = True
truthy False = False
truthy (n : Complex) = truthy (realPart n) || truthy (imagPart n)
truthy (n : Number) = n == n && n != 0          # NaN is False
truthy (text : String) = text != ""
truthy [] = False
truthy (_ :: _) = True
truthy (r : Record) = not (null (pairs r))
truthy (m : HashMap _ _) = not (null (pairs m))
truthy _ = True
a && b = truthy a ? truthy b : False
a || b = truthy a ? True : truthy b
f $ x = f x
(f \ g) x = f (g x)
[] ++ ys = ys
(x :: xs) ++ ys = x :: (xs ++ ys)
negate x = 0 - x
S (n : UInt) = n + 1
```

A named subtype's value is as true as its base's (`Money 0` is `False`), and
an action is no condition: `truthy` of one is an error. `++` joins strings as
their characters. Applying a list to an index is `get`, and an item update
`with`; a negative index counts from the end:

```apn
get (x :: _) 0 = x
get (_ :: xs) (n : Int) | n > 0 = get xs (n - 1)
get xs (n : Int) | n < 0 && length xs + n >= 0 = get xs (length xs + n)
get _ (n : Int) = fail "list index out of bounds"
with (_ :: xs) 0 y = y :: xs
with (x :: xs) (n : Int) y | n > 0 = x :: with xs (n - 1) y
with xs (n : Int) y | n < 0 && length xs + n >= 0 = with xs (length xs + n) y
with _ (n : Int) _ = fail ("index " ++ to String n ++ " out of range")
```

A range (`[a..c]`, `[a,b..c]`, `[a..]`, through the prelude's `enumFrom`
functions) counts by `b - a`, or by 1 towards its end (down when the end is
below the start), and ends past `c`, or never (for a `Char`, `a + step` is the
`Char` that many code points on):

```apn
intrinsics.range a b c = {
    step = b == [] ? (c != [] && c < a ? -1 : 1) : b - a
    c == [] ? counting a step : countingTo a step c
}
counting a step = a :: counting (a + step) step
countingTo a step c = (step > 0 ? a > c : a < c) ? [] : a :: countingTo (a + step) step c
```

`assert condition x` is `condition ? x : fail ("assertion failed: " ++
intrinsics.source condition)`, the run adding where the call is.

## Monads

`map`, `>>=` (`intrinsics.bind`), `<*>` (`intrinsics.ap`), `return` and `throw`
have built-in instances for lists and actions. A list's:

```apn
map f [] = []
map f (x :: xs) = f x :: map f xs
xs >>= f = foldr (x, rest -> f x ++ rest) [] xs
fs <*> xs = fs >>= f -> map f xs
```

where `return x` is `[x]` and `throw e` is `[]`. An action's, on the model
`IO a = | IO (World -> [a,World])`:

```apn
run (IO step) world = step world
map f action = IO (world -> run action world ~ [[x,next] -> [f x,next]])
action >>= f = IO (world -> run action world ~ [[x,next] -> run (f x) next])
```

where `return x` is `IO (world -> [x,world])` and `throw e` an action failing
with `e`. What APN cannot say is how `return` and `throw` know their monad: by
the context, as a Haskell class method's result type is chosen, which the
checker decides before the run and the run decides where the value is used.
Until then the value is undecided (`return 1` shows as `return 1`).

## What only the interpreter can do

The other natives do what no APN definition can yet, each for one of these
reasons:

- **Effects** act on the `World`, whose operations are the interpreter's:
  `print`, `debug`, `emit`, `exit`, `repl`, `set`, `while`, `for`, `compile`,
  `intrinsics.import`, `intrinsics.readFileFrom`, and the standard library's
  `readFile`, `readStdin`, `getArgs`, `sendRequest` (behind `http`'s
  `fetch`, which reads its options in APN), `bracket`, `withFile`,
  `entropy`, `currentTime`, `zoneOffset` and the C interface (`withLibrary`,
  `allocate`, `peek`, `poke`, `offset`, `nullPointer`). Each is an action, a
  function of the world: `print x` is `IO (world -> [[], write (to String x ++
  "\n") world])` for the world's `write`.
- **Evaluation order**: `seq a b` is `b` once `a` is evaluated, and `fail
  message` stops with an error; a definition can use them, not make them.
- **Reading values as data**: `typeOf`, `isType`, `==`, `<` and the other
  comparisons, `|` and `&` (`intrinsics.union`, `intrinsics.intersection`),
  `intrinsics.refine`, `intrinsics.tag`, `pairs` of a record, `to` and `from`
  with their built-in instances (`String`, `JSON`, `List Char`), `format`, and
  `parse` of a literal. Each is a function by cases over every kind of value,
  which a definition could give only by matching the model of each type:
  correct, but a case per type and per program type.
- **Code as data**: `intrinsics.syntax`, `intrinsics.written`,
  `intrinsics.binding`, `intrinsics.yields`, `intrinsics.runs`,
  `intrinsics.bound`, `intrinsics.fixity`, `intrinsics.source`,
  `intrinsics.parse`, `step` (which descends into code) and `debug` (which
  prints code) read code as it was written, which needs the parser. `intrinsics.eval` is the
  [metacircular evaluator](metacircular-evaluator.md)'s `eval`, and `~`
  (`intrinsics.match`) is a function's clauses written in place:
  `x ~ [p -> a, q -> b]` is `f x` for `f p = a` and `f q = b`.
- **Numbers**: arithmetic is the models' (`add` on `UInt` above), and `sqrt`,
  `exp`, `sin` and the other functions of `Float` are their series rounded to
  IEEE 754, correct and slow. Unicode casing (`upper`, `lower`) is a table.
