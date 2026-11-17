# Equivalence

Spellings that mean the same thing: each runs and checks as the other does.
This page lists them and links to the rule; it states no rule of its own. Forms
spelled alike on two sides (a read and its write, a value and its pattern) are
[symmetry](symmetry.md). The forms in [sugar](semantics.md#sugar) are their
expansions in every way, and `tests/sugar-test.ts` holds each beside it.

## Functions

| Written | Same as | See |
| --- | --- | --- |
| `f x y = e` | `f = x, y -> e`, `f = x -> y -> e` | [functions](semantics.md#functions-and-conditionals) |
| `f p = a`, `f q = b` | `f x = x ~ [p -> a, q -> b]` | [functions](semantics.md#functions-and-conditionals) |
| `f (x : Int) : Int = x + x` | `f : Int -> Int`, then `f x = x + x` | [declarations](semantics.md#declarations-and-ascription) |
| `f : Int -> Int -> Int = x -> y -> x + y` | `f = x -> y -> x + y : Int -> Int -> Int` | [declarations](semantics.md#declarations-and-ascription) |
| `Int -> Int -> Int` | `Int -> (Int -> Int)` | [operators](semantics.md#operator-precedence-and-associativity) |
| `return x = Some x` | `return = Some` | [conventions](../AGENTS.md#conventions) |
| `(Vec n a xs)`, a pattern | `((Vec n a) xs)` | [functions](semantics.md#functions-and-conditionals) |

## Operators

| Written | Same as | See |
| --- | --- | --- |
| `a + b` (any operator) | `(+) a b` | [sugar](semantics.md#sugar) |
| `(+ 2)`, `(2 +)` | `x -> x + 2`, `x -> 2 + x` | [sugar](semantics.md#sugar) |
| `(- 2)`, `(10 -)` | `x -> x - 2`, `x -> 10 - x` | [functions](semantics.md#functions-and-conditionals) |
| `-x`, `!x` | `negate x`, `not x` | [sugar](semantics.md#sugar) |
| `-2 ^ 2` | `-(2 ^ 2)` | [operators](semantics.md#operator-precedence-and-associativity) |
| `f $ x` | `($) f x` | [sugar](semantics.md#sugar) |
| `f =<< m` | `m >>= f` | [monads](semantics.md#monads-and-instances) |
| `print * [1,2,3]` | `[1,2,3] * print` | [functions](semantics.md#functions-and-conditionals) |
| `c ? a : b` | `truthy c a b` | [sugar](semantics.md#sugar) |

## Lists

| Written | Same as | See |
| --- | --- | --- |
| `[a, b]` (a value or a pattern) | `a :: b :: []`, `Cons a (Cons b Nil)` | [sugar](semantics.md#sugar), [types](semantics.md#type-descriptions) |
| `x :: xs` as a pattern | `Cons x xs` | [pattern functions](pattern-functions.md) |
| `[a..]`, `[a,b..]` | `enumFrom a`, `enumFromThen a b` | [sugar](semantics.md#sugar) |
| `[a..c]`, `[a,b..c]` | `enumFromTo a c`, `enumFromThenTo a b c` | [sugar](semantics.md#sugar) |
| `[Int..]` | `Int :: [Int..]` | [types](semantics.md#type-descriptions) |
| `xs i` | `get xs i` | [records](semantics.md#records) |
| `xs i = v` | `xs = with xs i v` | [sugar](semantics.md#sugar) |

## Records

| Written | Same as | See |
| --- | --- | --- |
| `v.x` | `v "x"`; `get v "x"` on a value that is not a record | [records](semantics.md#records) |
| `v.x = y` | `v = with v "x" y` | [sugar](semantics.md#sugar) |
| ``v.`my value` `` | `v "my value"`, `v."my value"` | [records](semantics.md#records) |
| `r [f = v, g = w]` | `{ r.f = v; r.g = w; r }` | [records](semantics.md#records) |
| `r [10,20]` (fields in order) | `r [x = 10, y = 20]` | [records](semantics.md#records) |
| `r []` | `r` | [records](semantics.md#records) |
| `Vector3 [x : Int]` | `Vector3.x = Int` | [records](semantics.md#records) |
| `v.[x : T, y] = [a, b]` | `v = [use v, x : T = a].[y] = [b]` | [records](semantics.md#records) |
| `[x = 1, x = x + 1]` | `[x = 2]` | [records](semantics.md#records) |
| `[_ = e, b = 2]` | `[b = 2]` (`_ = e` binds nothing, as in a block) | [records](semantics.md#records) |
| `[x] = r`, a pattern | `[x = x] = r` | [records](semantics.md#records) |
| `v.[x,_] = [a,b]` | `v.[x] = [a]` (`_` takes `b` and discards it) | [records](semantics.md#records) |

## Blocks and actions

| Written | Same as | See |
| --- | --- | --- |
| `{ x <- m; rest }` | `m >>= x -> { rest }` | [sugar](semantics.md#sugar) |
| `{ m; rest }` | `m >> { rest }` | [sugar](semantics.md#sugar) |
| `{ x = e; rest }` | `(x -> { rest }) e` | [sugar](semantics.md#sugar) |
| `{ e }`, `{}` | `e`, `[]` | [sugar](semantics.md#sugar) |
| `{ x = 1 }` | `(x -> {}) 1`, so `[]` | [blocks are do-blocks](semantics.md#blocks-are-do-blocks) |
| `do [a,b]` | `{ a; b }` | [monads](semantics.md#monads-and-instances) |
| `mapM f xs` | `sequence (map f xs)` | [monads](semantics.md#monads-and-instances) |
| `loop m` | `m >> loop m` | [monads](semantics.md#monads-and-instances) |
| `empty` | `throw "empty"` | [monads](semantics.md#monads-and-instances) |

## Types

| Written | Same as | See |
| --- | --- | --- |
| `Box x = _` | `Box a = \| Box a` | [templates and types](templates-and-types.md) |
| `isType t x` | `typeOf x <= t` | [values are sets](semantics.md#values-are-sets) |
| `to Float32 x` | `(x : Float32)` | [fixed-width types](semantics.md#fixed-width-types) |
| `Ints = [] \| Int :: Ints` | `List Int` | [types](semantics.md#type-descriptions) |

## Modules

| Written | Same as | See |
| --- | --- | --- |
| `import` | `intrinsics.import` | [intrinsics](intrinsics.md) |
| `load file` | `intrinsics.runFile (file ++ ".apn")` | [module imports](semantics.md#module-imports) |
| `[upper = upper]` | a field holding the `upper` already in scope (a rebinding reads the one before it) | [records](semantics.md#records) |
