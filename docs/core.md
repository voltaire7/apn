# The core

**Draft.** This page is the core APN is moving toward: the few primitives the
rest of the language should be written in. Each primitive says how far today's
interpreter has it. [Semantics](semantics.md) stays authoritative for what a
program means; this page is where the implementation should go.

One idea runs through the language: **a value is what you can take apart, and
every value comes apart the same way.**

| Value | Taken apart as |
| --- | --- |
| A list | `x :: xs`, `[]` |
| A natural number | `S k`, `Z` |
| A function | `Takes t k`, any other value `Gives v` |
| A record | its (key, value) pairs |
| Code | a list of items as written |
| A type | the set of its values |

Two rules keep it small: every other form is sugar that behaves exactly as its
expansion ([sugar](semantics.md#sugar), [equivalence](equivalence.md)), and every
built-in behaves exactly as its APN definition ([intrinsics](intrinsics.md)).

## The primitives

| # | Primitive | Written | Today |
| --- | --- | --- | --- |
| 1 | Names and application | `f x` | present |
| 2 | Clauses: lambdas with patterns and guards, tried most specific first | `p \| g -> e` | present |
| 3 | A scope binding its names for all of itself | `{ xs = 1 :: xs; ... }` | present |
| 4 | Making data: a tagged value | `intrinsics.tag` | present |
| 5 | Views: a pattern defined by a function that takes a value apart | `view build match` | present |
| 6 | Sets: types as values, union, intersection, refinement, membership | `A \| B`, `x : T` | present |
| 7 | Actions as values, run only by statements and `<-` | `x <- m` | present |
| 8 | Code as data: a list keeps its items as written | `[x + 1]` | present |
| 9 | Evaluation order: laziness by default, `intrinsics.seq` to force, `fail` to stop | `seq a b` | present |

Literals (numbers, characters, strings) are spellings of values whose models
are in [intrinsics](intrinsics.md). The natives no APN definition can replace
are grouped there, under
[what only the interpreter can do](intrinsics.md#what-only-the-interpreter-can-do):
they are effects (7), evaluation order (9), reading values as data (6) and
code as data (8).

### 1–3. Functions

A definition is clauses (`f x = e` is `f = x -> e`, and `f p = a; f q = b` is
`f x = x ~ [p -> a, q -> b]`), so clauses and application are the whole of
functions. A block's bindings are the one thing a lambda does not express: a
name new to the block is bound for the whole block, which is what recursion
needs.

### 4–5. Data and views

`intrinsics.tag` makes a constructor's values, and a constructor pattern takes
them apart. A **view** is the same pattern over a value that is not stored that
way: a number is not stored as `S (S Z)`, nor a function as `Takes`. A view is
a builder and a matcher, given by a function rather than a keyword
([views](semantics.md#patterns-variants-and-scope)). The built-in views are the
prelude's: `Takes` and `Gives` ([intrinsics](intrinsics.md#functions-takes-and-gives)),
and `Z` and `S`:

```apn
Z = view (0 : UInt) ((n : UInt) | n == 0 -> [])
S = view ((k : UInt) -> k + 1) ((n : UInt) | n > 0 -> [n - 1])
```

The checker runs a view's builder and matcher on what it knows, as it runs any
pure code, so `Vect (S k) a` and `factorial 3` in a type are computed through
them.

The matcher gives the fields or does not match. One arity per name holds for
free: the builder takes as many arguments as the matcher gives fields. A
constructor made by `tag` would be the view whose matcher reads the tag, so
views would be the one way to take data apart.

### 6. Sets

A type is the set of its values: `|` and `&` are union and intersection,
`intrinsics.refine` is a refinement (`(n : Int) | n > 0`), and `x : T` asks
for membership, converting where `T` declares a conversion
([values are sets](semantics.md#values-are-sets)). The static checker is the
same sets decided early: what it cannot decide is checked as the program runs.

A typed pattern `(x : T)` is membership read as a pattern, as `[a, b] = xs` is
a list read as one ([symmetry](symmetry.md)), not a view. A view takes a value
apart by a function of the value; a typed pattern asks which set the value is
in, which the value alone does not say:

```apn
f (xs : List Int) = "ints"
f [1,2.5]                 # "ints": the checker typed the list List Int
kind (b : Box t) = t      # kind (Box 1.5) is Float: t is a type, no part of b
```

`(xs : List Int)` decides by the type the checker gave the value, and
`(b : Box t)` binds a type variable; a matcher sees neither, and the checker
would still need a rule to give the binding the type `T`.

### 7–9. Effects, code, order

An action is a function of the world ([intrinsics](intrinsics.md#effects-and-references)),
so applying one runs nothing. A list literal is code: its items keep the scope
they were written in, so quoting needs no form of its own. Evaluation is lazy;
`seq` and `fail` are the two things a definition can use but not make.

## What the core would remove

| Today | In the core |
| --- | --- |
| A checker rule written by hand for each native (`Takes`, `S`, ...) | the type of its definition |
| Natives with an APN definition in [intrinsics](intrinsics.md) (list functions, maps, `$`, `\`, `&&`, `\|\|`) | prelude definitions, with the interpreter's version kept as a faster way to compute the same thing (done; step 2 says why the rest stay) |

`tests/intrinsics-test.ts` already runs the definitions against the natives,
so moving a native to the prelude is checked by a test that exists.

## Open questions

- **Whether records need a form of their own.** A record is already code, a list
  of bindings; its literal, access (`v.x`) and update forms are sugar for `get`
  and `with`, but the parser keeps them as nodes of their own.

## Order of work

1. Views as a primitive; `S`/`Z` and `Takes`/`Gives` move to the prelude (done).
2. Natives with a definition move to the prelude, which the checker types and
   evaluates as it does any prelude function; the interpreter (and the
   checker's evaluator) keep the native only as a faster way to compute.
   Moving `head` and `tail` this way needs the checker to treat a clause
   `fail message` as no value: a call certainly evaluated that certainly takes
   one is a static error, and a call typed for mixed items takes its type from
   the other clauses; and a clause `fail message` gives its function no result
   type of its own, so `first [] = fail "empty"` leaves `first (x :: _) = x`
   a function of a list of any length (all done, for any function). Moved
   (`MODELED` in `src/natives.ts`): `head`, `tail`, `null`, `take`, `drop`,
   `filter`, `iterate`, `foldl` (strict through `intrinsics.seq`, which
   `std/function`'s `seq` is), `foldr`, `length` (its recursive clauses
   declaring their `Int` result), `enumerate`, the map functions (`keys`,
   `values`, `has`, `lookup`, `remove`, `insert`, each declaring its type),
   and the operators `$`, `\`, `&&` and `||` (`f \ g = x -> f (g x)`), which
   the checker types as any function: a call evaluates the arguments its
   definition certainly reaches, so `False && head []` leaves `head []` unrun
   as `both False (head [])` does for `both a b = truthy a ? truthy b : False`. The interpreter does not run their definitions, so
   they cannot join the native. The others stay native, each for what its
   move would lose:

   - `zipWith`: a function that only passes its parameters on to it
     (`zip xs ys = zipWith pair xs ys`) has no type of its own
     (`a -> b -> c`): the call waits for its arguments, so where the
     function's own type is needed (`set body (move mouse body)` in the p5
     soft-body example) its result is unknown, `zip`'s items unlinked from
     its lists. Typing such a parameter as a list of the elements asked needs
     a length variable for it, which the checker does not have (an open
     length is any length).
   - `truthy`: its definition could give an action's truth only as a failure
     (`truthy (_ : IO _) = fail "..."`), an error where a call certainly
     runs, where the native's type gives an action none (`y = not (print 1)`
     is rejected unrun).
   - `negate`: a real number is a `Complex`, so no short definition flips
     both a float's zero and each part of a complex number (`0 - x` makes
     `negate 0.0` `0.0`, not `-0.0`).
   - `++`, `get` and `with`: their definitions cover lists; strings, records,
     maps and code are the native's.
   - Ranges: the checker reads a range's items and length from its bounds
     (`[1..n]` has `n` items), which its definition's cells do not give.
   - `map`, `>>=` and `<*>`: an action's instance acts on the world, which
     only the interpreter has, and `return` takes its monad from the context.
