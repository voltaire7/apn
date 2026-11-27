# Symmetry

A symmetric form is spelled the same on both sides: what it names when read is
what it names when written to, built or taken apart. `v.a` is "`v`'s `a`"
whether it is read (`v.a`) or assigned (`v.a = x`); the only difference is
where the value comes from (from `v`, or from `x`). This page lists each such
pair and links to the rule; it states no rule of its own. The list of
spellings that mean the same thing is [equivalence](equivalence.md).

## Reading and writing a place

The left of an assignment is written as the read that gives the place it
changes. Each update binds a changed copy; nothing is changed in place (see
[records](semantics.md#records) and the
[access and assignment reference](templates-and-types.md#access-and-assignment-reference)).

| Place | Read | Write |
| --- | --- | --- |
| A field | `v.a` | `v.a = x` |
| A field by its name as text | `v "a"`, `v key` | `v "a" = x`, `v key = x` |
| A nested field | `v.child.a` | `v.child.a = x` |
| Several fields | `v.[a,b]` | `v.[a,b] = [x,y]` |
| One field, as a list | `v.[a]` | `v.[a] = [x]` |
| Nested fields | `v.child.[a,b]` | `v.child.[a,b] = [x,y]` |
| A record's entry by position | `v 0` gives `[key,value]` | `v 0 = [key,value]` |
| A field declared with a type | `v.[a : Float]` | `v.[a : Float] = [x]` |
| A list's item | `xs i` | `xs i = x` |
| Several items | `xs [2,0]` | `xs [2,0] = [x,y]` |
| An association list's entry | `entries "a"` | `entries "a" = x` |
| Any indexable value | `get v i` | `with v i x` |

`get` and `with` are the pair underneath: a program's own clauses for them give
its own type both forms at once (see [records](semantics.md#records)).

## Building and taking apart

A pattern is written as the value it matches, so a value is taken apart by the
spelling that built it (see [bindings](semantics.md#bindings-and-output) and
[patterns](semantics.md#patterns-variants-and-scope)).

| Shape | Built | Taken apart |
| --- | --- | --- |
| A list | `[x, y]` | `[a, b] = xs` |
| A cons cell | `x :: xs` | `h :: t = xs` |
| A constructed value | `Some x`, `Box 1` | `Some a = o`, `(Box n)` |
| A typed value | `(x : Int)` | `f (n : Int) = ...` |
| A record | `[a = x]` | `[a = x] = r` |
| A record and its other fields | `[a = x, [..] = rest]` | `[a = x, rest = _] = r` |
| A module | `[f = ..., g = ...]` at a file's end | `[f] <- import "file"` |

## Defining and calling

A definition's left side is written as the use it answers (see
[functions and conditionals](semantics.md#functions-and-conditionals) and
[declarations and ascription](semantics.md#declarations-and-ascription)).

| Use | Definition |
| --- | --- |
| `f x` | `f x = ...` |
| `a + b` | `a + b = ...` |
| `Box 1`, constructing | `Box x = _`, declaring the constructor |
| `f x` and `g y` | `[f x, g y] = [x, y]` |
| `xs i` on a type of the program's own | `get (Grid cells) i = ...` |
| `f x` has type `Int` | `f (x : Int) : Int = ...` |

## Values and their types

A type is written as the values it holds (see
[type descriptions](semantics.md#type-descriptions)).

| Value | Type |
| --- | --- |
| `[1, "a"]` | `[Int, String]` |
| `[p = [q = 1.5]]` | `[p : [q : Float]]` |
| `Box 3` | `Box Int` |
| `x -> x + 1` on Ints | `Int -> Int` |
| `[1..]` | `[Int..]` |

## Code and data

| One way | The other |
| --- | --- |
| `toAST [f x + 1]` gives data | `fromAST` writes it back as source |
| `to String 12` | `from String "12"` |
| Printing a value | shows it as it was written |

## Where the symmetry breaks

Every `=` binds its left from its right: a definition, a field, a record
pattern's entry (`[a = x] = r` binds `a` to `r`'s `x`) and a renamed selection
alike. That rule wins where it and the symmetry above disagree:

| Form | Read | Written |
| --- | --- | --- |
| Renamed selection, `v.[a = x]` | `v`'s `x`, as a record's `a` | `v`'s `a`, from the right side's `x` |
