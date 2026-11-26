# APN evaluation rules

APN uses call-by-need for deferred values, function arguments, list elements,
cons tails, and variant fields. Forcing reveals the outer value and memoizes it;
it does not recursively evaluate a whole collection. Explicit actions remain
repeatable, as described below. `tests/semantics-test.ts` asserts these rules.

## Syntax basics

### Layout and blocks

Layout and spacing are rigid on purpose: much APN code is written by coding
agents, and a language that accepts only one tidy spelling of each line keeps
them from writing ugly production code. So spacing is checked, not formatted:
indentation, the spaces around operators and `=`, and comma spacing each have
one correct form, and any other is a syntax error saying which (`--loose`
accepts any spacing).

Indentation is strict: every nested level is exactly four spaces deeper than
its parent (`+2`, `+8`, and other steps are syntax errors). Blank and
comment-only lines are ignored for layout. A newline at the same level ends a
statement, and `;` also separates statements. A definition's body may start on
the next line indented four spaces. A deeper line continues its statement
when the line before ends with an operator or the deeper line starts with one
(or with a ternary's `?` or `:`), so a chain can put each step on its own line:

```apn
perItem total count = okOr "no items" (safeDiv total count)
    >>= share -> share > 100 ? Err "share too large" : Ok share
    >>= checked -> Ok (checked * 2)
```

A deeper line starting an argument (a name, a literal, `(` or `[`) continues an
application, so a long call puts its arguments on lines of their own:

```apn
quoteDecoder = map4 toQuote
    (field "quote" string)
    (field "author" string)
    (field "year" int)
```

A line at the statement's own level starts the next statement, and inside
`[ ]` a line break separates items; a line deeper than an item or a record
field continues it, by the same rules. A line that only closes a multi-line
bracket, or one ending with `}`, ends its statement: a deeper line after it
is an error, not an argument.

A line holds at most 99 characters (code points), each string, character or
number literal on it, and its comment, counting as one: a line may overflow
only by what cannot be broken. A longer one is a syntax error. Break it as above:
arguments, operator chains, list items and record fields continue on deeper
lines.

Definition brace layout is mandatory: write `func = {` on one line. In a
multiline brace block, each statement starts exactly four spaces deeper than
that opening line, and the closing `}` aligns with the opening line. Inline
`func = { expr; expr }` is valid. A newline after `=` may introduce an indented
expression, but never an opening `{`, even for an inline block.

A closing `)` starting a separate line must align with the indentation of the
line containing its opening `(`. A closing parenthesis after an expression on
the same line remains valid.

Parentheses suppress newlines for grouped expressions, but a `{ ... }` block
or `[ ... ]` list nested inside them restores its own layout. Local definitions
in a parenthesized lambda's brace body therefore remain separate statements;
list elements on separate lines remain separate elements.

List literals separate elements with commas or newlines, so a multi-line list
needs no commas. Juxtaposition on one line is application: `[f 2]` is a
one-element list. Cons is `::`, so it needs no parentheses inside a list
literal: `[0 :: []]` is `[[0]]`.

`::` always adds one element, the mirror of the cons pattern `x::xs`, which binds
one element. Like a list literal, the result may mix element types:
`[1,2]::[3,4]` is `[[1,2],3,4]` (as `[[1,2],3,4]` is), `1::["a"]` is `[1,"a"]`,
and `[1]::[[3,4]]` is `[[1],[3,4]]`, its type the literal's too: `[0] :: [tail zs]`
types as `[[0], tail zs]`, and onto a list of unknown items, lists whose lengths
differ from theirs are of any length (a state `[frontier = [0], d = 1]` onto
states whose frontier the run finds). It never joins lists; that is `++`
(`[1,2] ++ [3,4]` is `[1,2,3,4]`).

`( )` and `{ }` are interchangeable statement groups. Their value is the last
statement's value (`(x = 4; x * 3)` and `{ x = 4; x * 3 }` are both `12`), and an empty group is
`[]`. Definitions inside a group are local to it:
`x = 1; y = { x = 40; x + 2 }` leaves `x` as `1` and `y` as `42`.
There are no tuples: `(1, 2)` is a syntax error; use a list such as
`[213,"hello"]` for mixed values.

Spacing is part of the syntax (a parse error otherwise):

- A binding's `=` has one space on each side: `x = 1`, not `x=1` or `x  = 1`.
- A `,` follows its item directly. When no item it separates has a space in
  it (outside string and character literals), it takes nothing after it:
  `[1,2,3]`, `[0,-1,1/2,v.x]`, `["a b","c"]`; otherwise it takes one space:
  `[1 + 1, 2]`, `[Some 1, None]`, `[x = 1, y = 2]`. Literals of different kinds
  take one space too: `["a", 1]`, `[[1], 2]`, `[True, 'c']` (the kinds are
  number, string, character, Bool and list, so `[1,2.5,1/2]` and `["a","b"]`
  stay as they are). The items are a line's in one
  bracket, so `[[1,2],[3]]` but `[[1 + 1], [3]]`, and `[1, 2]` or `[1 + 1,2]` is
  an error. This covers list items and patterns, record fields, bare
  selections (`v.[x,y]`), ranges (`[1,3..9]`), `match` clause lists and import
  lists. A bracket just before `=` or `->` pairs its items with the bracket just
  after it, so both sides count as one: `[a, b] = [f 1, 2]`,
  `[f x, g y] = [x, y]`, `f [x, y] = [x + x, y + y]` and
  `[x, y] -> [x + x, y + y]`, but `[a,b] = [1,2]`. Lambda parameters, which start a spaced lambda, always take one space:
  `x, y -> x + y`, `(x : Int), y -> x`.
- A `,` separates two items on one line. A newline already separates items,
  so a `,` ending a line is an error, as is a trailing one (`[1,2,]`); a
  multi-line list or record puts one item per line without commas (or several
  per line, `1,2`, separated by commas).
- Application is juxtaposition with a space, also before a list, a group or a
  block: `sum [1,2,3]`, `func (f x)` and `run { x }`, not `sum[1,2,3]`,
  `func(f x)` or `run{ x }` (a `[`, `(` or `{` directly after a name, literal
  or closing bracket is an error). Selections keep their dot: `v.[x,y]`,
  `v.(key)`, `obj.{ x + 1 }`.
- A binary operator has a space on both sides or neither: `1 + 2` or `1+2`,
  not `1 +2` or `1+ 2`, except that a space before `-` or `!` alone passes a
  negated argument: `f -1` passes `-1` and `f !b` passes `!b`. A `-` written
  against its operand negates it (`-x`, `-(1/3)`, `-[1,2,3]`, `[-1]`,
  `a == -1`); a spaced one always subtracts, so `y = - 3` is an error and
  `(- 2)` a section. Before a closing bracket an operator ends a section
  (`(1 +)`).
- A record field is `key: value`, not `key:value`: `[x = 1]`, not `[x:1]`;
  likewise keyed patterns and selections (`[a = x, b = y]`).
- `( )` and `[ ]` take no space inside (`(f x)`, `[1,2]`); a `{ }` block on one
  line takes exactly one (`{ 123 }`, not `{123}` or `{ 123  }`). Empty groups
  are `()`, `[]` and `{}`.
- Across lines, a bracket ending its line (before an optional comment) and a
  closing bracket starting one follow the layout rules instead.
- A `;` only separates two statements on one line, written `print 1; print 2`
  (no space before, one after). A newline already ends a statement, so a `;`
  at the end of a line, at the start of one, doubled (`;;`), or next to a
  bracket's inside (`{ print 1; }`) is an error. `--loose` lifts all of
  these, so `{ print 1;print 2 }` and a `;` at a line's end are accepted there.
  It lifts the 99-character line limit, and the parentheses rule below, too.

Parentheses appear only where they change how code reads: a group that reads
the same without them is a parse error (`unnecessary parentheses`). So
`print 5`, `print r.x`, `f -1`, `a + b * c`, `(f x) y` as `f x y`, a lambda
that ends its expression takes the rest without them: `xs >>= x -> f x`, and a
definition ascribed whole is declared, `x : T = e` for `x = (e : T)` (in a
record entry too; `x = e : T` says the same where nothing follows). They
stay where they group differently, as in `(a + b) * c`, `f (g x)`, `(-2) ^ 2`,
`-(-x)` and `xs >>= (x -> f x) >>= g`, or where the bare spelling means
something else:

- a lambda passed as an argument, as in `withFile "notes" (file -> file.read)`:
  bare, `withFile "notes" file -> file.read` is a lambda with one typed
  parameter (as `f a e -> ...` is), which takes a type apart;
- `f = (x -> e)` binds a value, while `f = x -> e` is a clause of `f`;
- `[(x, y -> e)]`: in a list, the `,` would separate two items;
- `xs (i) = v` sets an item, while `xs i = v` defines `xs`.

A definition's parameters read as arguments do: each juxtaposed piece is one
parameter, so `f Int x = ...` takes the type `Int`, then `x` (called `f Int 3`,
as `to Int x` is). A constructor applied to patterns is therefore
parenthesized, `f (Some x) = ...`: a constructor pattern takes all its fields,
so `f Some x = ...` is a static error, as `Some -> 1` is. A cons is
parenthesized too: `len x :: xs = ...` is an error (write `len (x :: xs)`). A
lambda's parameter, an operator definition's operand and a binding's pattern
take a whole pattern, as an operand does: `Some x -> x`,
`Money a + Money b = ...`, `Some v = m`, as does a list's item
(`[Some x, y]`), and cons takes applied constructors (`Some x :: rest`). So
parentheses around a pattern follow the rule above: `f (Some x)`,
`Some (Ok x)`, `(x :: xs) ++ ys` and `(x :: y) :: z` need them, while
`f (None)`, `f (-1)`, `Some (x)`, `(Some x) >>= f`, `(Some x) -> x`,
`[(Some x), y]` and `(Some v) = m` are errors, and a name keeps them only to set
an item (`xs (i) = v`).

`Name args = value` defines `Name`, unless `Name` is a constructor where it
runs, which makes it a pattern binding: `Some v = Some 5` binds `v`,
`Cons x xs = [1,2]` binds `x` and `xs`, and `Int x = x + 1` defines a
function `Int` (a built-in type's name is a name like any other).

Lists print the same way: `print [1,2,[3]]` shows `[1,2,[3]]` and records show
`[x = 1, y = 2]`. A list prints its items once its `,` is decided: when an item
has a space, the list ends, or sixteen items are held, so an infinite one
streams after its first sixteen (whose spacing it then keeps). `apn --loose` (or the language server's `looseSpacing` option)
turns every spacing rule off, and lets a definition's `{` start on the next,
indented line (`func =` then `    {`, with the `}` aligned under the `{`).

### Functions and conditionals

`f x y = body` and `f = x, y -> body` both define curried functions, so
`add 2` is a partial application. A lambda's parameters are patterns
separated by `, ` (as in Idris); juxtaposition is one pattern, as inside a
definition's parentheses: `t x -> t` takes one argument and binds its type,
like `f (x : t) = t`, and `f a e -> …` is the flat typed pattern `((f a) e)`, as
`(Vec n a xs)` is `((Vec n a) xs)`. This holds everywhere, `match` alternatives included.
Directly inside `[ ]`, a `,` separates the list's items, so a lambda with
several parameters there is parenthesized: `[(x, y -> x), f]`. A function may be written as several
equations, tried most specific first ([ranking](#clause-ranking)):

```apn
len [] = 0
len (x::rest) = 1 + len rest
```

A function's clauses are a match (`~`) on its arguments: `len` is
`len xs = xs ~ [[] -> 0, x::rest -> 1 + len rest]`, and with two parameters
`f a b = [a,b] ~ [[p,q] -> ...]`; either spelling runs and checks the same
(the one exception: clauses with equivalent patterns and different result types
are an overload the context chooses: [overloading on the result type](#overloading-on-the-result-type)).
As an alternative takes a guard (`n | n > 0 -> n`), so does a clause, after its
parameters: `f x | x >= 0 = "pos"`. Several guards of the same parameters are
written one per line, each a clause of them, tried as written, and `else` (the
prelude's `True`) is the guard that always holds:

```apn
sign n : Int
    | n > 0 = 1
    | n < 0 = -1
    | else = 0
```

A guard is a choice: when it fails the next clause is tried. A condition in a
type is a requirement instead: `func : (n : Float) | n > 0 -> Float` takes only
positive Floats, a call given another failing (see
[refinements](#refinement-types)).
Literal patterns (integers, floats, strings, characters, `True`, `False`) are
tried before other clauses ([ranking](#clause-ranking)); numeric literal patterns compare numerically, so
`2` and `2.0` match each other. Integer ranges (`[1..9]`) are also patterns.
Where they were written does not matter: `len xs = 0` before `len (x::rest) =
...` still leaves `len [1,2]` to the second, and a later clause with an
equivalent pattern replaces an earlier one. When no equation matches, the
error names the function: `no clause of 'len'
matches the given arguments`. A call that certainly fails is a static error:
one where what is known of the arguments rules out every clause (a literal, a
constructor, a list's length: `pred 0` for `pred (S k) = k`), or certainly
takes a clause that is `fail message` (`first []` for `first [] = fail
"empty"`, reported with the message). Only a call that is certainly evaluated
counts: a statement's value, what a strict operator or native such as `print`
demands of it, a condition, a block's statements, and what a call so evaluated
evaluates: an argument whose parameter each clause takes apart or demands
(`g (head [])` for `g x = x + 1`), the branch a known condition takes
(`True && head []`), and its clause's body (`f 1` fails for `f x = head []`,
and an `f` never called does not). One in a list item, a branch, an
unused binding or an argument the function may not use waits until it is used,
and may never be (`[pred 0, 2] 1` is 2; `k 1 (head [])` is 1 for `k a b = a`). A clause that is `fail message` gives no
value, so it gives its function no result type of its own: `first [] = fail
"empty"` leaves `first (x :: _) = x` a function of a list of any length,
giving its first item's type. A clause may have a guard (`f n | n > 0 =
n`, see [pattern functions](pattern-functions.md)).

There is no `if`/`then`/`else`; use the ternary `cond ? a : b`, which is
`truthy cond a b` as if written in its place: the condition's
[truth](#empty-results-and-truthiness) is a Bool, which applied to the two
branches is one of them ([get](#records)); clauses
for `get` a program adds for a Bool are the ones a ternary there uses. Only the
selected branch runs, and the branches may differ in type (`x ? "yes" : False`;
see [choices](gradual-and-dependent-types.md), as for `match` and clauses).
The ternary's `:` is not cons (`::`), so a branch may
cons freely: `b ? x :: xs : []`. A ternary inside a ternary, in any of its
places, is parenthesized: `c ? (d ? 1 : 2) : 3`, `n < 0 ? -1 : (n > 0 ? 1 : 0)`;
`c ? d ? 1 : 2 : 3` and `c ? 1 : d ? 2 : 3` are errors.

Operator sections: `(+ 2)` is `x -> x + 2`, `(2 +)` is `x -> 2 + x`, and a lone
operator `(+)` is the function `+` is bound to, so `(+) a b` is `a + b` in every
way, its checking included; likewise `-x` is `negate x` and `!x` is `not x`,
with what those names mean where it is written. `-` works in the same positions:
`(- 2)` is `x -> x - 2`, `(10 -)` is `x -> 10 - x` and `(-)` subtracts, while
`-2` is the number (`(-2) ^ 2` is `4`).

### Iteration and ranges

`*` with a function operand iterates and returns the list of results. A list
supplies its elements, a string its characters (`"hi" * print`), a record its
`[key,value]` pairs, and an integer `n` the indexes `0` to `n - 1` (a negative
`n` counts down: `-3 * f` passes `0, -1, -2`).
Function iteration accepts either operand order: `print * [1,2,3]` is equivalent
to `[1,2,3] * print`. Records pass `[key,value]` pairs and integer counts pass
indexes. Numeric operands still multiply (including numeric arrays); two
functions are not composed by `*`—use `\` for composition.

`[a..b]` is an inclusive range whose step follows the direction of the bounds
(`[5..3]` is `[5,4,3]`). `[a,b..c]` uses the step `b - a`; an explicit step
pointing away from the end produces `[]` (`[0,1..-100]`). `[a..]` and
`[a,b..]` are infinite lazy ranges.
Range bounds are expressions, evaluated when the range is (`[1..n]`,
`[a,b..end]`, `[start..]`), and a range prints as written. They must evaluate
to real numbers. Existing automatic descending
steps are preserved, so `[1..0]` is `[1,0]`; std factorial handles zero separately.
A range pattern `[lo..hi]` matches any integer from `lo` to `hi` inclusive.

### Bindings and output

`name = value` is the only binding form; there is no `let`. A binding inside a
group is scoped to that group. Bindings are statements, not expressions, but a
group's value is its last statement's, and a binding's is the value it binds:
`print (x = 1)` prints 1, and `x` is unbound after it. A list item may be a
binding too (see [code](#code)). A value never changes once written, so when
something is computed never changes what it is. A name not visible here is
defined for its whole scope: code above may use it (functions and values may
refer to each other in any order: `a = b + 1` then `b = 2`), and its value may
refer to itself (`ones = 1 :: ones`).
A name already visible, here or in an enclosing scope (the prelude's too), is
rebound: a new version from that line on, whose right side reads the one
before (`count = count + 1` is 2 after `count = 1`), while what was written
before keeps the version it saw:

```apn
n = 1
m = n + 1
n = 10
print m           # 2
```

The top level and every block follow this rule, as do updates (`r.x = v`,
`xs i = v`), more clauses for a function, imports, loads and `[..]`; a
rebinding may have another type. The left side may be a pattern:
`[a,b] = [1,2]`, a cons pattern `x::xs = [1,2,3,4]` (or `x :: y :: rest`),
`Some x = optionValue` (parentheses optional, also for an imported
constructor), a literal (`1 = n` asserts that `n` is 1), or a keyed
record pattern `[a = x] = record` (binding `a` to the field `x`). A failed match is an error: before the
run when the value is known (`1 = 2`, `None = Some 1`), otherwise when the
binding runs. A list of definition heads defines each by its own item of a list
written on the right: `[f x, g y] = [x, y]` is `f x = x` and `g y = y` (a list
of names alone, `[a,b] = [1,2]`, is the pattern binding above). A bare `[x,y]`
pattern also matches a record, selecting the fields named `x` and `y` (extra
fields are ignored), in bindings, function parameters, and `match` alternatives. A new capitalized name on the
left defines a function that computes (a type alias among them), or with the
body `_` a constructor; see
[templates and type aliases](templates-and-types.md#constructor-functions)
for those and variant declarations. One giving a type or a schema gives, applied
to all its parameters, a type that remembers how it was written (`Point`,
`Pairs 2 Int`), as do the values made with it (`typeOf p` is `Point`), which
patterns read back (`(Pairs n a xs)`). A scalar
type (`Count = Int`) makes a named subtype: a `Count` is an `Int` wherever one is accepted and keeps its name when
a result fits (`(5 : Count) + 1` is `6`, a `Count`); one of a list is that
list where a list is taken (`n : Name = "ab"` for `Name = String`: `head n`,
`n 1`, `c :: cs`), and `++` keeps its name as arithmetic does (`n ++ "c"` is a
`Name`). A constructor (`UserId (id : Int) =
_`) makes a distinct type: `UserId 1` has none of an Int's operations, builtins
and `(x : Int)` patterns reject it, its clauses give it what it needs
(`UserId a + UserId b = UserId (a + b)`), and `(UserId x)` takes it apart.
See [named and distinct types](type-and-resource-rules.md#distinct-types).

A declaration or an ascription states a type (see
[declarations and ascription](#declarations-and-ascription)); otherwise `:`
writes a record entry or a ternary's else, and cons is `::`. The constructor
forms `x = 5 : Int` and `f (x : Int) = ...` mean what `x = 5 : Int` and
`f (x : Int) = ...` do; see [pattern functions](pattern-functions.md). A type pattern is also a binding,
so `x : Int = 1` (or `x <- ...` with `(x : Int) <- ...`) declares a typed name: the
value converts as an argument converts for `f (x : Int)`, so `y : Float = 1`
binds `1.0` and `z : Int = 2.5` is a lossy-conversion error. A value the
checker knows (a negated or parenthesized literal, or a constant such as
`0 - 1` or `k * 3`) is converted statically, so `n : UInt = -1` is a static
error, and so is a call such as `g -1` or `g (k * 3)` for `g (n : UInt)`. Later
assignments keep the type (`x = "a"` is a type error). Built-in type names
cannot be redefined, so `x : Int = ...` is always this binding; `Int = 5` and
`Int x y = 5` remain errors.

In file mode, bare expressions run for their effects but are not printed; use
`print`. The REPL echoes expression results but not assignments, so `x = x`
never hangs the prompt.

### Declarations and ascription

Every definition is `left : T = body`, both `: T` and the body optional, and
`: T` is the type of what is on the left of it, as `= body` is its value.
`name : T` declares the definition of `name` right after it in the same
block; `name : T = value` declares and defines at once. With parameters, the
left is the function applied to them, so `T` is the type of its result:
`f (x : Int) : Int = x + x` is `f : Int -> Int` with `f x = x + x`, and
`adder n : Int -> Int = x -> x + n` gives a function. A piece of the type may name its
parameter, `(k : T)`: each clause's parameter takes a `T`, and `k` names it for
the result and the pieces after it, whatever the clause calls it
(`g : (n : Int) -> Vect n Int` then `g 2 = [1,2]`). A lambda defined with its type,
`func : t -> IO [] = x -> print [x,t]`, is that declaration of the lambda's
clause, as `func : t -> IO []` then `func x = print [x,t]` is: `t` is bound in
its body. The left is a pattern, so
`f Int Int : Int = 123` is the clause for the types `Int`, `Int` themselves,
not a signature. A declaration no definition follows defines the name as its
type's zero, as a record slot does
([zero initialization](zero-initialization.md)): `x : Int` alone is `x = ([] : [x :
Int]).x`, so `0`; with parameters (`f x : Int` alone) it is an error, as a
function has no zero. A capitalized definition whose body holds `_` is a
constructor, `: T` the type it is declared into
([variants](templates-and-types.md#variants-parameters-and-distinct-wrappers)).
Lowercase names in the type that nothing binds are its variables, the same
name the same type throughout:

```apn
x : Int32 = 123
y : Int32
y = 123
double (x : Int) : Int = x + x

append : Vect n a -> Vect m a -> Vect (n + m) a
append [] ys = ys
append (x :: xs) ys = x :: append xs ys
```

Each clause is checked against the declaration: each parameter's type is
the typed pattern around it (`append ([] : Vect n a)`), and the result's type
the claim of its body, proved per clause (see
[pattern functions](pattern-functions.md)), so declaring `Vect (n + m + 1) a`
above is a length mismatch. A clause with fewer parameters than the type
takes (`inc : Int -> Int` then `inc = (+ 1)`) has the rest of the type as its
body's. A result naming a type variable no parameter binds (`List b` beside
`(a -> b)`) is left to inference, and so is `_`, any type: `func : Int -> Int
-> _` declares only the parameters.

`e : T` is `e` as a value of `T`: `e` itself if it is one, else what a
conversion to `T` makes of it, and an error if none does. The conversions are
`to T`'s: the built-in ones between numbers, lossless (`1.0 : Int` is the Int
`1`; `1.5 : Int` is a lossy-conversion error; `123 : Int32` is an `Int32`), and
those a program's `to` instances declare (`to Int East = 1` makes `East : Int`
`1`, and `to (Box Int) (n : Int) = Box n` makes `3 : Box Int` `Box 3`). `to T e` is the
same operation as a function. Nothing else converts: `5 : Bool` is an error,
as `5 : String` is (a condition's truth is `truthy 5`). It is written outermost on a definition's right side
(`x = 123 : Int32`) or in parentheses (`(5 : Int32) + 1`); a ternary ascribed
is parenthesized, `(c ? a : b) : T`, and `x = c ? a : b : T` is an error.
`(p : T)` in a pattern matches what `e : T` makes of the value, then `p`, and
fails where it fails: `f (n : Int) = n + 1` takes `1.0` as `1`, `(b : Box Int)`
takes `3` as `Box 3`, and `(x : t)` binds the value's type `t`, unless `t`
names a type (a list or record of types, or a function, too): then it is that
type, as in [a function type](#function-types) (after `t = [Int,Int]`,
`(xs : t)` takes two Ints, and `(xs : typeOf ys)` what `ys` is).

A type is given a value only by ascription: `Int 5`, `Int $ x` and a type
passed where a function goes (`f t = t 1`) are errors, `5 : Int` ascribes and
`to Int x` converts. A type still takes its parameters (`Vect 2 Int`,
`Option Int`, a computed `Sized 2`): until given them it is a function of types,
as any function is (`Option : Type -> Type`, `map Option [Int,String]` is
`[Option Int, Option String]`), and a constructor is a function that does not
evaluate (`map Box [1,2]`). And `Mutable` and `Pointer`, types that are their
own constructors, build their values (`Mutable 0`). A typed pattern writes its
type after the value: `(Int x)`, `((T) p)` and `(t x)` are errors whose hint is
`(x : Int)`. A type of values is given every parameter it takes, `_` for any:
unapplied it is a function of types, so `(xs : List)`, `([1] : List)` and
`isType Option x` are errors (write `List _`, `Option _`), as is any name used
with another arity. `_` reads nothing: `isType (Option _) (Some missing)` is
`True`.

### Code

A list keeps its items as written, each in the scope it was written in: a list
is code, edited as any list is. `debug` shows a value as code (a list's items
as written, a string quoted), `print` shows its values, and `reduce xs` is the
values alone, a list that is no longer code, so `print xs` is
`debug (reduce xs)`:

```apn
debug [1 + 1, 2]            # [1 + 1, 2]
print [1 + 1, 2]            # [2,2]
```

A list item may be a binding, as a group's statement may: it binds for the
items after it and, as in a block, yields no value of its own (`print [x = 1,
x + 1]` prints `[2]`, and `do [x = 1, x + 1]` is 2). A `[..] = r` item is one,
binding `r`'s fields (`print [[..] = [a = 1], a]` prints `[1]`); one whose record
an `x <- m` item before it binds opens it when the code runs. A list of bindings alone
is a [record](#records), which keeps them as its code. An `x <- m` item is a
statement too: its value is the action `m`, and `do` runs it, binding `x` for
the items after it, in any monad (`do [x <- [1,2], return (x * 10)]` is
`[10,20]`). What such code yields item by item (`print`, `reduce`) is, for an
item after it, the block of the bindings before the item ending in it, as
`toLambda` reads it: `print [x <- [1,2], return (x * 10)]` prints `[[10,20]]`.
A block whose monad nothing decides is run, as the REPL runs it, so `print
[x <- return 1, return x]` prints `[1]`; `print [x <- return 1, x]` is an error
(`{ x <- return 1; x }` ends in no action). The item's own value stays its statement's, so `x` is bound only
when the code runs: `[x <- m, x] 1` is an error. The
list is still its code, the binding one of its items: `length` counts it,
indexing and updates reach it, and `print`, `to String` and `reduce` give what
the code yields, fewer items, as `filter` may. A pattern
binding's item matches when a name it binds is first used. An item may read a
name bound nowhere where it is written: the list is open code, which code
joined before it may complete. `++` joins code: the items after a binding see
it, wherever they were written, and it wins over a name visible there:

```apn
code = [x = 1] ++ [x + 1]
debug code                  # [x = 1, x + 1]
print code                  # [2]
y = 100
print ([y = 1] ++ [y + 1])  # [2]
```

An item update replaces the item with the code on its right, run in the list
(a value it gives takes the replaced item's type): the items after it that
read a name either item binds run again, and every other keeps its value. The
copy is a new list; one read from the old keeps its old items:

```apn
code = [x = 1, x + 1] ++ [5]
code 0 = (x = 10)
print code                  # [11,5]
code 1 = x * 3              # x is the list's: [30,5]
```

Code's bindings are its fields, as a record's are: `code.x` is the value
the last item binding `x` gives, and `code.x = v` replaces that item with
`x = v`, an update as above (`code.[x] = [v]` too). On a list binding no `x`,
`.x` is association lookup, as below (`[["x", 1]].x` is `1`, and `.x = v`
assigns it). An `x <- m`
item binds `x` only when `do` runs the code, so `code.x` is an error there,
as is replacing a binding made by a pattern (`[a,b] = ...`), which replaces
as an item (`code 0 = ...`):

```apn
code = [x = 1, x + 1]
code.x                      # 1
code.x = 10
debug code                  # [x = 10, x + 1]
print code                  # [11]
```

A list function passes the items it keeps on as written, with their values
(`take 1 code ++ [x * 5]` prints `[50]`); only `++` and an update run items
again. One that makes new items (`map f xs`) makes values. Using an open
list's values (`print [x + 1]`) is an error naming the unbound name where it
is written; the static check reports it, except after code it cannot follow
(a list a function made, as `take` does), which is checked when it runs.
`toAST` gives code as lists and `toLambda` desugars it, as code (see
[code as data](standard-library.md#code-as-data--syntax)).

### Sugar

These forms are their expansions, as if written in their place: each runs and
checks as its expansion does, with what its names mean there (a program's own
`+`, `not` or `get` is the one they use). Printing and `debug` show what was
written. `tests/sugar-test.ts` holds each form beside its expansion.

| Written | Is |
| --- | --- |
| `a + b` (any operator) | `(+) a b` |
| `(+ 2)`, `(2 +)` | `x -> x + 2`, `x -> 2 + x` |
| `f $ x` | `($) f x` |
| `-x`, `!x` | `negate x`, `not x` |
| `[a, b]` (a value or a pattern) | `a :: b :: []` |
| `[a..]`, `[a,b..]`, `[a..c]`, `[a,b..c]` | `enumFrom a`, `enumFromThen a b`, `enumFromTo a c`, `enumFromThenTo a b c` |
| `c ? a : b` | `truthy c a b` |
| `v.x` | `get v "x"` |
| `xs i = v`, `v.x = y` | `xs = with xs i v`, `v = with v "x" y` |
| `f x = e` | `f = x -> e` |
| `f p = a; f q = b` | `f x = x ~ [p -> a, q -> b]` |
| `{ x <- m; rest }` | `m >>= x -> { rest }` |
| `{ m; rest }` (`m` an action or other monadic value) | `m >> { rest }` |
| `{ x = e; rest }` | `(x -> { rest }) e` |
| `{ e }`, `{}` | `e`, `[]` |

A block's bindings are the one thing a lambda does not express: a name new to
the block is bound for the whole block, so its value and earlier statements
may read it (`{ ones = 1 :: ones; take 2 ones }`); a rebinding reads the
version before it, as the lambda does.

A file is a block, run once: its top level follows every rule a block's
statements do, and a block may hold everything a file does, a type
declaration (`Color = Red | Green`, `Box a = _`) among them, declared for the
block only. So a statement that binds nothing is an action (or another
monadic value), and once one ran, the last is too: `print 1` then `5` is the
error a block reports, since the 5 would be dropped (see
[blocks are do-blocks](#blocks-are-do-blocks)). `load "file"` runs a file and
gives its value, its last statement's (see [module imports](#module-imports)). The REPL is a block still being
written: each input is its next statement, and the last value of one is shown
instead of dropped.

## Operator precedence and associativity

Every binary operator is an ordinary function defined in the language: the
prelude (`lib/prelude.apn`, in scope everywhere) binds each symbol to an
intrinsic function, a field of the `intrinsics` record (`(+) = intrinsics.add`),
and declares its fixity, and `a + b` applies whatever `+` is bound to. The table below is the prelude's, from tightest to loosest
binding; operators in the same row have equal precedence.

| Operation | Fixity | Associativity | Grouping example |
| --- | --- | --- | --- |
| Field access and pluck `.` | syntax | Left | `a.b.c` → `(a.b).c` |
| Function application | syntax | Left | `f x y` → `(f x) y` |
| Composition `\` | `infixr 9` | Right | `f \ g \ h` → `f \ (g \ h)` |
| Exponentiation `^` | `infixr 8` | Right | `a ^ b ^ c` → `a ^ (b ^ c)` |
| Unary `-`, `!` | syntax | Prefix | `-f x` → `-(f x)` |
| `*`, `/`, `%` | `infixl 7` | Left | `a / b * c` → `(a / b) * c` |
| `+`, `-`, `++` | `infixl 6` | Left | `a - b - c` → `(a - b) - c` |
| Cons `::` | `infixr 5` | Right | `a :: b :: xs` → `a :: (b :: xs)` |
| `==`, `!=`, `<`, `>`, `<=`, `>=` | `infixl 4` | Left | `a < b == c` → `(a < b) == c` |
| Type union `\|` | `infixr 4` | Right | `A \| B \| C` → `A \| (B \| C)`; `(A \| B) == C` needs its parentheses |
| Logical `&&` | `infixl 3` | Left | `a && b && c` → `(a && b) && c` |
| Logical `\|\|` | `infixl 2` | Left | `a \|\| b \|\| c` → `(a \|\| b) \|\| c` |
| Ternary `? :` | syntax | — | a nested one is parenthesized: `a ? b : (c ? d : e)` |
| Application `$` | `infixr 0` | Right | `f $ g $ x` → `f (g x)` |

`f \ g` creates a function that computes `f (g x)` when called with `x`.
Both operands must be functions (constructors are accepted). Ordinary calls
bind more tightly, while exponentiation, arithmetic, iteration, and `$` bind
more loosely. Thus `vec * print \ format "%: %"` means
`vec * (print \ format "%: %")`; `(+ 1) \ (* 2) $ 3` returns `7`.
Use `(sum \ filter even) values` to apply a composition to a list.

Parentheses override precedence: `2 + 3 * 4` is `14`, while `(2 + 3) * 4`
is `20`. Comparison chains are ordinary left-associated operations, not
mathematical chained comparisons.

Backtick infix functions are not supported; write `f a b`. `=`, `<-`, `->`, `|`
and prefix `!` are syntax, not operators: they cannot be defined (define `not`
to change `!`) or used as sections, and `=` and `<-` have no expression precedence. Range `..` belongs
inside range syntax, and `@` belongs to polar numeric literals. Inside function-contract patterns,
arrows associate right: `Int -> Int -> Int` means `Int -> (Int -> Int)`.
In expressions, arrows always form lambdas, including `Int -> Int`.
Unbraced lambda bodies consume a full expression; a braced body ends at `}`.

Exponentiation uses the same numeric semantics as `expt`: `2 ^ 10` is `1024`,
and `2 ^ -3` is `1/8`. `-2 ^ 2` is `-(2 ^ 2)`; use `(-2) ^ 2` for `4`.
Sections work too: `(^ 2)`, `(2 ^)`, and `(^)`.

Unary operators take a power expression as their operand; nest them with parentheses,
as in `-(-x)`. As an argument (`f -x`, a space before the `-` and none after)
the negation takes only its operand, as any argument does: `sqrt -1 * 4` is
`(sqrt -1) * 4`, and `x -1` for a number `x` is an error (subtract with `x - 1`).

### Defining and overloading operators

An operator is any run of the characters `! $ % & * + - / < = > \ ^ | ~ :`,
read as one token (so `a+-b` is one operator, `+-`; write `a + -b`). It is a
function named by its symbol:

```apn
(+)                          # the function behind +: (+) 1 2 is 3
infixr 5 +++                 # a fixity declaration: infixl, infixr or infix, 0..9
xs +++ ys = xs ++ [0] ++ ys  # an infix definition; (+++) = f binds a function
[1] +++ [2] +++ [3]          # [1,0,2,0,3]
```

A fixity declaration stands on its own line, anywhere at the top level of the
file defining the operator; it applies to the whole file, and travels with the
operator's value: a program that opens it with `[..]` (`infixr 3 <|>` is
`std.parser`'s), an alias of it, clauses added to it and later REPL input group
its chains by it. An operator without one is `infixl 9`. `infix` operators do not chain:
`a == b == c` is fine (`==` is `infixl`), but two `infix` operators of the
same precedence side by side need parentheses, as do two of one precedence
and different associativity (`Int | String == t` is an error; write
`(Int | String) == t`).

Overloading an existing operator for a type, beside the type's declaration, is
the recommended way to give your own types arithmetic or comparison: the
clauses [travel with the type](#functions-travel-with-types), tried first, and
arguments no clause matches keep the operator's meaning:

```apn
Money (m : Int) = _
Money a + Money b = Money (a + b)   # the inner + is +, these clauses included
Money 3 + Money 4                       # Money 7
1 + 2                                   # 3
```

When no clause takes a value of a type the program defines together with one
of another type, an arithmetic or comparison operator converts the other
through a `to` instance and runs again (promotion). Equality never converts.
If both could convert into each other's type, the operator is ambiguous and an
error; if neither can, it fails as before:

```apn
to Money (n : Int) = Money n
Money 3 + 4                             # Money 7: 4 is to Money 4 first
4 + Money 3                             # Money 7
```

The other way round, a value of a type the program defines converts through
its `to` instance wherever a built-in type is needed: an index (`to Int`), an
operand of arithmetic no clause takes (`to Int`, else `to Float`), and a typed
pattern of a scalar type (`(i : Int)`, `(x : Float)`, `(s : String)`), which takes it
only when no pattern of its own type does. An enumeration has these
instances by declaration ([variant list indexes](type-and-resource-rules.md#variant-list-indexes)):

```apn
Level (n : Int) = _
to Int (Level n) = n
[10,20,30] (Level 2)                    # 30
Level 2 * 5                             # 10
```

Every other function works the same way, `get` and `with` ([indexing](#records))
and `negate` and `not` (so `-x` and `!x`) included:
`sin (Dual a b) = Dual (sin a) (b * cos a)` beside `Dual`'s declaration leaves
`sin 0.5` as it was (the `glsl` module writes GLSL this way). Clauses join only
a function taking as many arguments: `log b x = ...` and the `http` module's
`get request = ...` define new functions.

**Creating new operators is possible but not recommended.** A named function
is easier to read, to search for and to explain; reach for a new symbol only
where it is already conventional. Rebinding a prelude operator to something
unrelated (`(+) = max`) is allowed for the rest of its scope, and equally
discouraged.

See [templates and type aliases](templates-and-types.md) for scalar/container
application, slot updates, aliases, and parameterized variant types.

## Recursive lists

These definitions are productive because each produces a cons cell before its
recursive tail is needed:

```text
x = 1:x
print (take 5 x)       # [1,1,1,1,1]

fibs = 0 : 1 : zipWith (+) fibs (tail fibs)
print (take 12 fibs)   # [0,1,1,2,3,5,8,13,21,34,55,89]
```

Entering `x` or `fibs` in the REPL streams elements until Ctrl+C. `print`
and `emit` also stream lists, including nested ones. `debug x` prints `x` as
code (see [inspection](#inspection-and-numbers)): strings and characters quoted
(`debug "hi"` prints `"hi"`, `print "hi"` prints `hi`). File mode executes bare
expressions without echoing them; use `print x` to stream from a file.

`x = x` cannot produce even an outer value. Demanding it waits indefinitely
until interrupted, using bounded memory; Ctrl+C returns control to the REPL.
Failed or interrupted evaluations leave the interpreter usable.

The right operand of `::` must be a list. When a cons expression is evaluated,
a visibly non-list tail such as the literal in `x = x::1` raises an APN error
without evaluating its head. Computed tails are checked when demanded, preserving
`head (1::missing)`. Displaying a value nested inside itself also raises a clear
error; ordinary recursive list spines such as `x = 1::x` still stream.

## Records

A list literal whose items are all fields is a record. A field is a binding
(`x = 1`, or a function, `f n = n * 2`), a declaration (`x : Float`, a field
holding the type, or `x : Float = 1`, a typed value), a type declaration (its
type and constructors are fields), or `[..] = r`, which spreads `r`'s fields.
Fields are code, run as a block's statements are (see [bindings](#bindings-and-output)):
a name a field binds is in scope for the whole record (`[f n = g n, g n = n + 1]`),
a function's clauses join, `x = x + 1` reads the `x` before it, so
`[x = 1, x = x + 1]` is `[x = 2]`, and `_ = e` binds nothing (`[_ = e, b = 2]`
is `[b = 2]`). The record's fields are the names it binds,
in the order first bound. The record keeps that code, so code joins and reads it as a list:
`[x = 1] ++ [x + 1]` is the code `[x = 1, x + 1]` (see [code](#code)). A
declaration alone (`x : Float`) is a slot, which makes the record a template
(see [templates](templates-and-types.md)); a binding holds its value, a type
included: `[x = Float]` is a record holding `Float`, not a template. Each
prints as it was written; what a template builds holds values (`[x : Float]
[1]` is `[x = 1.0]`).

A record is the list of its `[key, value]` pairs, in order: `[x = 1, y = 2] ==
[["x", 1], ["y", 2]]`, and what takes a list takes it (`length`, `map`,
`filter`, `foldl`, `r * f`, a `List [String,Int]` parameter), as it takes an
association list. It prints as a record. `to Record` makes one from an
association list with String keys, a repeated key keeping its first place
and last value as in code: `to Record [["x", 1], ["y", 2]]` is `[x = 1, y = 2]`.

A field's name is its key: a name, or any text in backticks, which printing
writes when the key is not a name. A string names a field too:

```apn
obj = [field = 123, `my value` = 1]
```

| Access | Selects | Result above |
| --- | --- | --- |
| `obj.field` or `obj "field"` | Field `field` | `123` |
| ``obj.`my value` `` or `obj "my value"` | Field `my value` | `1` |
| `obj 1` | Entry at position 1 | `["my value",1]` |

After `.`, a string is applied (`obj."my value"` is `obj "my value"`), and a
number is no field: `obj.1` is an error (write ``obj.`1` `` or `obj 1`).

Application evaluates its argument: `key = "field"; obj key` selects a named
field. `pairs` and iteration give each key's text;
`pairs []` is `[]`, as `[]` is the empty record too.
`obj.(expression)` evaluates with the record fields in scope; use `obj key` for computed lookup. Missing keys
raise an error.
Applying a value that is not a function is `get`: `xs 2` is `get xs 2`, the
prelude's `intrinsics.get`, which indexes lists, records and HashMaps as
described here, and the prelude's clauses `get True a = _ -> a` and
`get False _ = b -> b`, so a Bool applied to two values is one of them
(`True "yes" "no"` is `"yes"`; the other is never evaluated). Numbers, strings
and characters cannot be applied. A parameter applied (`at xs n = xs n`) may
be either, so the checker takes it as a function only where nothing else is
given: `at [1,2] 1`, `at [a = 1] "a"` and `at (x -> x * 2) 4` all check. Assigning is its counterpart `with`: `xs 2 = x` binds `xs` to
`with xs 2 x`, a copy with that slot replaced. Clauses for `get` and `with`
extend them, so a type of the program's own can be indexed and assigned to,
wherever it is applied (`map g`, too); other values keep the builtin meaning.
On a value that is not a record, `v.x` is `get v "x"` and `v.x = y` is
`with v "x" y`:

```apn
Grid (cells : List Int) = _
get (Grid cells) [(r : Int), (c : Int)] = cells (3 * r + c)
with (Grid cells) [(r : Int), (c : Int)] (x : Int) = Grid (with cells (3 * r + c) x)
g = Grid [1,2,3,4,5,6,7,8,9]
g [1,2] = 60
g [1,2]                                 # 60
```

List indexing accepts integers or values whose `to Int` makes one, as an
enumeration's values do (their positions). A string argument performs
[association-list lookup](templates-and-types.md#association-list-lookup):
`[["0",42]] "0"` returns `42`; it never coerces `"0"` to positional index zero.
Ordinary scalar lists such as `[10,20]` are not association lists and reject string lookup.
A HashMap likewise keeps numeric `0` and string `"0"` distinct keys.

On an existing record, `obj "field" = value` updates or adds the field `field`,
just like `obj.field = value`. The key may be a string literal, variable, or
expression: `obj key = value` and `obj (prefix ++ key) = value`. An integer
writes the entry at that position as reading it gives it, a `[key,value]` pair:
for `v = [x = 1, y = 2]`, `v 0 = ["x1",22]` makes `[x1 = 22, y = 2]` (a key another entry has is an
error, as is a new one on a record a schema made). Assignment evaluates the key
once before the RHS, replaces the selected slot with conversion checks for existing
numeric values, variants, and function contracts, and rebinds a scoped copy.
It does not invoke an ordinary function stored in the old slot. A new field is
inserted unchanged. On an unbound name or an existing function, `f "x" = value`
remains a string-pattern function clause.

A record a record schema made (`[...] : Quote` or `[] : Quote` for
`Quote = [quote : String, year : Int]`, a `(Quote q)` parameter, a nested
schema's field) keeps the schema's fields: adding one, by `.` or a string
key, is an error (`[quote : String, year : Int] has no field 'yaer'`), before
the run when the checker knows the record, otherwise when the assignment runs.
An update's copy keeps the type; a literal copy (`[[..] = q, extra = 1]`) is an
ordinary record, open to new fields.

A typed entry declares its field anew, as `x : T = e` does in a literal, so
the field's type becomes `T` (`v.[x : Float] = [3]` makes `x` the Float
`3.0`, where `v.x = 3.0` keeps an Int field an Int): `v.[x : T, y] = [a, b]`
is `v = [[..] = v, x : T = a].[y] = [b]`, the untyped entries assigned as usual,
renamed ones too (`v.[x : T = a] = r`), and `T` is any type expression.

A record applied to fields is the same update: `r [f = v, g = w]` is
`{ r.f = v; r.g = w; r }` in every way, as Elm's `{ r | f = v, g = w }`, or all
of them in order (`r [10,20]`), a type given fields too (`Vector3 [x : Int]` is
`Vector3.x = Int`); `r []` is `r`. A record's value is made by ascription
instead (`[x = 1] : Vector3`; see [zero initialization](zero-initialization.md)).
A record is code, so `++` joins it to more code (`[x = 1] ++ [x + 1]`), and
to a record it gives one record: the first's fields, then the other's, whose
items written there see the first's names, as code joined after it does
(`r ++ [x = a + 1]` is `[[..] = r, x = a + 1]`; `r ++ s` takes `s`'s fields as
they are). Nothing of the first runs again: its values and types are its own.

An empty list `[]` becomes a record on its first field assignment.
`obj.[x] = [10]` requires a one-element RHS list; `obj.[x] = 10` errors.
A `_` among the fields takes its value and discards it, as in a list
pattern: `obj.[x,_] = [1,2]` sets `x` alone.
`obj.child.x = 10` and `obj.child.[x,y] = [10,20]` rebuild nested parents. A
parent may be an association list or HashMap, as a JSON object is: each step
is `get` and its rebuild `with`, so `json.user.name = "b"` is `json "user" =
(json.user "name" = "b")` with the inner update's value. `obj.[y = x] = r`
assigns `r.x` to `y`, on an association list too.
See the [access and assignment reference](templates-and-types.md#access-and-assignment-reference)
for forms, conversion rules, scoping, and failure behavior.

Destructuring `[a = x, b = y]` binds each name on the left to the field on the
right, as every `=` binds its left; the bare pattern `[x]` binds the field `x`
to `x`, `_ = x` takes `x` and discards it, and `rest = _` binds the record of the
remaining fields. Renamed plucks such as `obj.[value = field]` create named
destination fields.

## Definitions and actions

Ordinary named definitions do not execute their bodies when defined.
A definition whose body is `_` makes data, whatever its name's case: `foo = _`
is a value that is itself, `f x = _` makes `f 2` stand for itself (see
[variants](templates-and-types.md#variants-parameters-and-distinct-wrappers)).
Code still to write is `fail "todo"`. Elsewhere, as a value (`g _`), `_` means
nothing: an error, reported by the checker and raised if it runs (code read as
code, `toAST [_]`, holds it). It remains a
wildcard in patterns, and given to a type or a constructor it is any type, as
there: `List _` is every list, so `typeOf x <= List _`, `isType (List _) x` and
`(xs : List _)` agree, and `Option Int <= Option _`. It prints `_`. Both sides of `=` are required: `foo =`, `foo = ;`, and
`= bar` are syntax errors. Use `foo = []` for an empty result. An indented body may follow
`=` on the next line in a complete source chunk; a same-level line may not.

| Definition | What it binds |
| --- | --- |
| `f x = x + 1` | A pattern-dispatch function |
| `f = x -> x + 1` | The same function as `f x = x + 1` |
| `v = 1 + 2` | A lazy value, computed when first used and kept |
| `a = print 3` | An IO action (not run here) |
| `a = { print 3; 4 }` | An IO action yielding 4 (a do-block) |
| `b = { x = 2; x + 1 }` | A lazy value (a block of bindings) |
| `xs = 1::xs` | A memoized cons cell with deferred head and tail |

More clauses for a function in the same scope extend it, as a rebinding: code
written before them keeps the clauses it saw (after `describe 0 = "hi"`,
`label x = describe x` and `describe 1 = "hello"`, `label 1` matches no
clause). A clause with a new pattern overloads it, and one with an equivalent
pattern rebinds that clause in place (`f (x : Int) = 1` then `f (y : Int) = 2`
rebinds; parameter names do not matter, and `_` is a name nothing uses).
`f = (x : Int) -> ...` is the curried spelling of `f (x : Int) = ...`: the same
clause, so `f = (x : Float) -> ...` after it overloads `f` exactly as a second
clause would. A lambda whose parameter has the definition's own name
(`x = x -> x`) stays a lambda, since as a clause that parameter would mean
equality with `x`. Clauses for a function the scope binds as another value
(`get = intrinsics.get`, then `get True a = ...`) extend it too: what they do
not take keeps its meaning. A definition in an inner scope shadows the visible
function there, as any new version of a name does (a local `loop n = ...` is a
function of its own).

### Functions travel with types

A type takes part in functions defined elsewhere as in Julia: clauses for a
visible function, written for a type the same scope declares, join that
function itself. They are for the type when a parameter's pattern names it or
one of its constructors (`Money a + Money b`, `map f (Some x)`, `to String
(Node l v r)`, `get (Grid cells) [r, c]`), or, for a method overloaded on its
result, when the body makes one (`return = Some`, `return x = Parser ...`).
Wherever a value of the type goes, code calling the function takes them first:
a library's `sum` adds `Money`, a do-block's `>>=` runs a `Parser`, `print`
shows a `Node` by its `to String`. They bind nothing in their own scope; the
name keeps meaning the function, which now has them. Any other definition stays
in its scope as above, so a program changes what a function means elsewhere
only for its own types.

## IO actions

APN code is pure; effects are **IO actions**, ordinary values describing what
to do. `print "hi"` builds the action that prints `hi`; nothing is printed
until the action runs. The effectful builtins all return actions: `print`,
`debug`, `emit` and `repl` (yielding `[]`), `readFile`, `readStdin`, `getArgs`, `exit`,
`set` (writing a `Mutable` cell), `bracket`, `withFile` and
`ffi.withLibrary`. An action has no value to show until it runs, so showing one is an
error, as in Haskell: `print (readFile "f")`, `print [print "hi"]`, `toString` of one, or
the REPL echoing a list holding one (run it first: `x <- readFile "f"`, then `print x`).
The check reports it before the run where it sees the action. `typeOf` gives its type:
`typeOf (print 1)` is `IO []`, and a do-block yields what its last statement does,
known without running it when that statement reads no name the block binds (`typeOf
{ print 1; return 5 }` is `IO Int`), and otherwise the type the check inferred (`{ x <-
readFile "f"; return x }` is `IO String`; `IO a` where it inferred none, as in the body of
a function generic in what it returns). `debug`
shows code, a list's items as written (`debug [print "hi"]` is `[print "hi"]`).

Actions run in exactly two places:

- **Statements.** A file is a block, and each REPL input a statement of one: a
  statement whose value is an action runs it, in order.
  `a = print 3; a; a` prints twice; `a` alone names the action.
- **`<-` bindings.** `x <- action` runs the action now and binds its result:
  `text <- readFile "input.txt"`. The right side must be an action: `x <- 2 + 3`
  is an error (bind a value with `=`).

`repl` opens a REPL session where it runs, on the names visible there, a
function's parameters and local names among them. A top-level name as the
running statement has it is checked against the program's types there. Any
other name (a local, or an older version of a top-level name that a function
sees) is typed by its value: data already evaluated, or a literal not
evaluated yet, as the literal that writes it (`n` given `3` is an `Int`), and
anything else as `Dynamic`, so its uses are checked when they run. Opening a
session evaluates nothing. Its inputs run as the REPL's do, and it ends on `:quit` or the end of input (Ctrl+D),
yielding `[]`; the program then goes on. What the session binds stays in it,
so the program keeps its own bindings, but its actions take effect: a
`Mutable` cell it sets keeps the contents. A session needs the command line
(`apn`); elsewhere `repl` is a runtime error.

```
x = 1
repl                   # >>> x + 1 shows 2; >>> x = 5 binds x in the session
print x                # 1, once the session ends
f n = { repl; return n }
f 3                    # >>> n + 1 shows 4; >>> n ++ "a" is a type error
```

`IO` is a type constructor, like `Option`: `IO []` is the type of an action
yielding `[]` (what `print` builds), `IO Int` of one yielding an `Int`.
Applying such a type to a value checks it as `(5 : Int)` converts: the value must
be an action, and its result is converted to the type when it runs, so
`sayHello = { print "hello" } : IO []` is an action and `(print 1 : IO Int)`
is an error. `IO` applied to anything but a type (`IO { ... }`, `IO 5`) is an
error. `return x` yields `x` in whatever monad the context needs (see below), as in
`check n = n > 0 ? return n : fail "negative"`.

### Blocks are do-blocks

A block is Haskell's do, its bindings `let`s:

```
{ e }              is e
{ e; ss }          is e >> { ss }
{ x <- e; ss }     is e >>= x -> { ss }
{ x = e; ss }      is (x -> { ss }) e     (a binding scopes over what follows)
```

So a block with a `<-` binding, or a statement that binds nothing before its
last, is a **do-block**: it evaluates to an action (or an Option, a list, ...)
that runs its statements in order, and a discarded `Err e` or `None` stops it.
Each such statement is in the block's monad, an action in an IO block; a plain
value (`{ 123; print "x" }`) would be computed and dropped, so it is an error
(check a condition with `guard c`, or `assert c x`, which is `x` once `c`
holds, as Haskell's). One statement is dropped instead: `[]`, the unit (what
`print` yields; inside a list do-block it is chained). (A binding, `[..] = r`
among them, is no statement value at all.) What the check cannot decide (a parameter's result) is checked when
the statement runs. A do-block's last statement must itself be an action,
whose result the block yields: end with `return x` to yield a plain value. The
unit ends an action too (`print 1 >> []` prints and yields `[]`), so a block
ending in a binding, which `{}` follows (`{ x = e }` is `(x -> {}) e`), yields
`[]`: `{ x = 1 }` is `[]`, `{ print 1; x = 5 }` an action yielding `[]`, and a
list block so ending is the empty list. A block of bindings stays an ordinary
value:

```apn
area w h = {
    print "computing area"    # an action, discarded: area returns an action
    return (w * h)            # a plain w * h here is an error
}
size <- area 3 4              # prints, then binds 12
double n = assert (n > 0) (n * 2)      # a plain function: double 3 is 6
answer = { 42 } : Int         # an Int
action = { return 42 } : IO Int # an action yielding an Int
```

Each run of a do-block starts a fresh scope for the statements from that point
on, so running an action twice repeats its effects and its bindings. A recursive
action (`loop n = { print n; loop (n + 1) }`) runs its last statement in place,
in constant stack. Using an action where a value is needed is an error that
says so: `print 1 + 1`, `(readFile "f").x`, `action ? a : b`. Bind the result first.

`<-` is a statement binding, not a function-definition form or chainable binary
operator. `f x <- ...`, `x <- y <- ...`, and missing right-hand sides are invalid.
An indented continuation is allowed; opening braces follow the same layout rule
as definitions: put `{` on the line containing `<-`. It supports the same
patterns as destructuring (`[a,b] <- action`, `_ <- action`); names are bound
after the action and pattern succeed, so `x <- return (x + 1)` reads the previous
`x`. The result's outer value is evaluated as it is bound, which makes
`x <- return v` the strict form of `x = v`; only the outer value is:
`xs <- return [missing,42]` does not evaluate `missing`.

### Monads and instances

`map`, `<*>`, `>>=` and `return` work in any monad. In `m >>= f`, `f` gives a
value of `m`'s monad (a `return` is made in it): `print 1 >> 2` is an error,
as `{ print 1; 2 }` is. IO is built in, as is a
`return` still waiting for its monad; every other type, lists included (the
prelude's `[] >>= f = []` and `(x :: rest) >>= f = f x ++ (rest >>= f)`), joins
by **instances**: definitions of these methods,
written like ordinary overloads, with parameters or curried (`return =
Some`), written beside the type's declaration, so they [travel with
the type](#functions-travel-with-types): prelude helpers, do-blocks and other
modules see them, and the newest instance whose clauses accept the arguments
runs. `lib/std/option.apn` holds Option's and Result's:

```apn
map f (Some x) = Some (f x)
map _ None = None
Some x >>= f = f x
None >>= _ = None
return = Some                      # return in Option
```

`to` and `from` are methods the same way: `to T x` writes `x` as a `T`
(`to String`, `to JSON`, `to (List Char)`, `to Record`; another type, a
record type too, converts as applying it: `to Quote x` is `Quote x`),
`from T x` reads one back. A type name in a pattern, bare or applied to types
alone, matches each type within the one it names, as `<=` compares types
(`describe Int = "integer"` takes `Int` and `typeOf 5`; `describe Number` takes
`Float` too, after `describe Int` for `Int`, the type itself ranking first;
`typeOf [1,2,3] ~ [List Int -> ...]` matches, as `Pairs Int` does `typeOf [1,2]`;
a type the check knows only as some type is decided by the run). In
parentheses, a union matches a value instead, as `(a -> a)` matches a
function: `x ~ [(Int | String) -> e]` takes an Int or a String, and
`((Int | String) n)` names it; a union of types matches by its name
(`IS = (Int | String)`, then `typeOf x ~ [IS -> e]`), and unparenthesized,
`Int | String -> e` is the parameter `Int` with the guard `String`. So an
instance names its type:
`to Celsius (F f) = C ((f - 32) * 5 / 9)`. A `to String` instance is also how
its values show: `print`, `debug`, the REPL and `to String` of a value holding
one write its text, wherever it is (with `to String (Point x y) = ...`,
`[Point 1 2]` shows `[1@2]`). See the [standard library](standard-library.md).

`return` is overloaded on its result type (see "Overloading on the result
type" below): a context that names Option uses the newest `return` whose
result is an Option, so `return = Some` and `return x = MkCounter (s -> [x,s])`
each define it for their own type.

`map` and `<*>` follow from `>>=` and `return` when a type defines no
instance of its own. A type used where no instance accepts it is an error
(`no map instance for Tree`).

`return x` is a value in a monad not decided yet (its type is `m T`). It
takes the monad of the first context that names one:

- an annotation: `({ return 42 } : Option Int)` is `Some 42`, `({ return 43 } : List Int)`
  is `[43]`, `({ return 44 } : IO Int)` an action yielding 44;
- a `>>=` with a concrete value: `Some 3 >>= x -> return (x * 2)` is `Some 6`;
- running it: a statement or `<-` runs it as IO.

Until then it stays undecided, so one `return` value can be used in several
monads. It prints as each value it can become, one per line: the list's, then
each instance's (`print (return 123)` prints `[123]`, `Some 123` and `Ok 123`
with the option module; `print empty` prints `[]`, `None` and `Err "empty"`), and an undecided `>>=`
prints as its source; using one as a plain value is an ambiguity error.
There are no `Functor` or `Monad` types: a parameter passed to `map` or `>>=`
accepts whatever has an instance, checked at each call (`double m = map (* 2) m`;
`double 5` is a static error, as is a type with no `map` instance).
`typeOf map` is `(a -> b) -> f a -> f b`, `f` being that type, and the monad
functions read as Haskell's: `typeOf (>>=)` is `f a -> (a -> f b) -> f b`,
`typeOf (>>)` is `f a -> f b -> f b` (see "Function types"). A variable
applied to types is named `f`, `g`, ...; the others `a`, `b`, ....

### Overloading on the result type

Clauses with the same patterns but a different inferred result type overload
each other; ones with the same result type rebind, as usual. Patterns are the
same when only the names they bind differ (`f (x : Int)` and `f (y : Int)`); the
types they name count (`f (xs : List Int)` and `f (xs : List String)` are two
clauses). A call that
reaches such clauses is undecided until a context names the type its result
should have: a type applied to it (`(f 0 : Int)`), a typed pattern it is passed
to (`g (n : Int)`), an annotation, or a monad context.

```apn
blank _ = 0
blank _ = ""
(blank [] : Int)             # 0
(blank [] : String)          # ""
print (blank [])             # 0 and "" (each overload, one per line)
blank [] + 1                 # error: ambiguous: nothing decides which blank
```

The result types come from the type checker's inference, which every run
performs; code run without it uses the runtime's own description of each
clause (`typeOf`'s). The checker reports the same ambiguity statically, and
`typeOf (blank [])` is `Int | String`.

A do-block is in the monad of its first `<-` (or annotation): a list block
tries every combination, an Option block stops at the first `None`; an IO
action cannot run inside a block of another monad. Its statements are
chained with `>>=`, and its last statement must be a value in the same monad
(`return x`):

```apn
pairs = {
    a <- [1,2]
    b <- [10,20]
    return (a + b)       # [11,21,12,22]
} : List Int
evens = {
    x <- [1..6]
    guard (x % 2 == 0)   # [] (a throw in a list) when odd: that x yields nothing
    return x             # [2,4,6]
}
check n = {
    unless (n > 0) (Err "not positive")   # a specific error
    return (n * 2)       # check 2 is Ok 4, check 0 is Err "not positive"
}
half n = {
    guard (n % 2 == 0)   # a False guard throws its condition
    return (n / 2)       # half 4 is Ok 2, half 3 is Err "guard failed: n % 2 == 0"
} : Result Int String
```

A block whose statements can all be undecided at run time (`check 2` above
runs only `return` values) takes the monad its code names, as types decide in
Haskell: the checker finds it (`Result`, from `Err`), and the run uses it. So
does a `>>=` or `>>` chain, a call, and a ternary whose other branch names the
monad: `unless (n > 0) (Err "x") >> return n` and `n > 0 ? return n : Err "x"`
are Results for any `n`, even when the condition is known. Where inferences disagree (a generic function such as
`wrap x = return x`, used in several monads), the context decides, as before.
`throw e` is the monad's failure, chosen by the context as `return` is: `[]`
in a list, an action failing with `e` in IO, and an instance for each variant
type (`throw _ = None`, `throw = Err`). A false guard throws the condition as
its call wrote it, as `assert` shows its expression (`guard b` names `b`).

| Function | Meaning |
| --- | --- |
| `map f m`, `f <$> m` | `m` with `f` applied to what it holds or yields |
| `return x` | `x` in the monad the context decides |
| `mf <*> mx` | the function `mf` holds, applied to what `mx` holds |
| `m >>= f` | `f` applied to what `m` holds or yields, flattened (`f` must be a function: to run a value after `m`, use `>>`) |
| `m >> k`, `f =<< m` | `m >>= _ -> k`; `m >>= f` |
| `sequence ms` | each of `ms` in turn, in their monad, yielding the list of what each holds or yields: `sequence [Some 1, Some 2]` is `Some [1,2]`, `sequence [[1,2],[3]]` is `[[1,3],[2,3]]`; a list of actions runs each, in constant stack |
| `mapM f xs` | `sequence (map f xs)` |
| `when c m`, `unless c m` | `m >> return []` when `c` is true (false), else `return []`: in any monad (`unless ok (Err e)`) |
| `loop m` | `m >> loop m`: runs `m` forever, until the program exits or is stopped |
| `while [c] m` | [code](#code) as written, run again before each pass (earlier items may bind names, the last is the condition), then the action `m` while it holds: `while [n < 3] (set n (n + 1))` reads the cell `n` anew; `m` reads the code's names |
| `for [start, c, step] m` | [code](#code) as written: `start`'s bindings, then while `c` holds, `m` (which reads the code's names, as code joined after it does) and `step`, an action it runs or a binding the next pass sees: `for [i = 0, i < 3, i = i + 1] { print i }`, or with a cell, `for [i = Mutable 0, i < 3, set i $ i + 1] { print i }` |
| `throw e` | the monad's failure: `[]` in a list, `None` in an Option, `Err e` in a Result, a failing action in IO (instances: `throw _ = None`) |
| `empty` | `throw "empty"`: the monad's value holding nothing |
| `guard c` | `return []` when `c` holds, else `throw "guard failed: c"` (as written): a false guard stops a do-block |
| `do statements` | the block with those statements: `do [a,b]` is `{ a; b }` |

`xs * f` iterates: when `f` returns actions it is the single action running
each in turn (`[1,2,3] * x -> print x`), yielding the results. It runs each
element's action as it reaches it, so `[0..] * print` streams until Ctrl+C.

### Where laziness ends

APN uses call-by-need for deferred values, arguments, list elements, cons tails,
and variant fields. Pattern matching forces only what it inspects. That does
not make every operation lazy: `<-` evaluates now, numeric operations demand
operands, actions run where statements run them, and `*` iteration eagerly
collects its results (over actions, it runs each as it goes). `map` produces results lazily. Consumers such as `length`
and sorting need finite input; printing an infinite list keeps streaming until
interrupted.

## Memoization and sharing

All thunks traversed in an alias chain share the resulting outer value. Repeated
uses of a deferred value, including bare statements, reuse that value:
`value = 2 + 1` computes 3 once, and so does a definition whose body is an
application that is not an action (`n = abs x`, `xs = map f ys`). One that is
an action is evaluated again at each use (`bump = set c (c + 1)`), and each run
of an action evaluates the expressions written in it again, reading cells as
they are then, as a do-block's statements are: `xs = [set c (c + 1)]` run twice
(`head xs; head xs`) adds 2. A value passed in (a name, a parameter) is the one
it is. List elements and arguments likewise share
demanded results. Values are return, so sharing is never observable except
through FFI calls, the deliberate escape hatch.

## Lists and consumers

- `::` defers both head and tail. List literals defer each element.
- `head` demands only the first element; `tail` does not demand the discarded
  head. `head [1,missing]` is `1`.
- `take n xs` produces up to `n` elements; `take 0 missing` is `[]`.
  `drop n xs` skips cells without evaluating their heads. Counts must be
  non-negative integers.
- `map`, `filter`, `zipWith`, and list `++` produce cells on demand. `filter`
  evaluates as many predicates as necessary to find the next retained element.
  `zipWith` stops when either input ends (inspecting the left input first).
- `foldr` passes a deferred recursive result to its function, permitting an
  early result on an infinite input. `foldl` traverses the entire input.
- Positive indexing traverses only through the requested element. Negative
  indexing needs the end of the list. `xs indices` selects a list of indices lazily.
  `xs indices = values` checks the finite update before rebinding; both sides see
  the old list.
- `null` inspects emptiness; `length` traverses cells without demanding heads.
  Equality compares elements incrementally and stops at the first mismatch.
- Finite and infinite ranges use the same incremental consumer interface.

Operations requiring a complete result—such as `length`, negative indexing,
`foldl`, `to String`, and full-list equality—may never finish on infinite inputs.
Use `take` when a finite result is required. Integers have arbitrary precision, so Fibonacci values remain exact instead
of rounding or overflowing to `Infinity`. Their growing size still uses memory.

## Patterns, variants, and scope

See [lists and records as arguments](pattern-functions.md#lists-and-records-as-arguments)
for parameter patterns, named inputs, and local collection updates.

Variable and wildcard patterns leave their arguments deferred. Other patterns
force only the structure they inspect. A cons pattern binds a lazy head and
lazy tail; an exact-length list pattern checks the spine length, and its
items may be cons patterns (`[x :: _, d]`), as in a list expression. Pattern-clause
fallthrough shares argument thunks, preventing duplicate evaluation of an
already demanded argument. Variant construction defers its fields. In a
constructor pattern, a bare capitalized argument takes no fields of its own
(`R low None high`); one with fields is parenthesized (`R (Some x) y`).

A capitalized definition whose body is `_` (`Box x = _`) declares a
constructor, and one whose body holds `_` is a constructor with logic, its `_`
the value itself. `Name fields : T = _` declares it into the type `T`
(`Circle (r : Float) : Shape = _`), which a union declaration stands for; see
[variants](templates-and-types.md#variants-parameters-and-distinct-wrappers).
That value is `tag Box Box [x]`: `tag owner ctor fields` (the prelude's name
for `intrinsics.tag`) makes a value that remembers the constructor that made
it, the type it belongs to and its fields, and does nothing else; patterns of
the constructor read the fields back:

```apn
Box a = tag Box Box [a]
Box 5                           # Box 5; typeOf (Box 5) is Box Int
unbox (Box x) = x               # unbox (Box 5) is 5
tag Option Some [5] == Some 5   # True: a declared constructor's own value
```

A **view** is a pattern defined by a function: `view build match` is a
constructor that builds with `build`, and whose pattern takes a value apart by
`match`, a function giving the list of its fields, or matching nothing (no
clause of it fits). The pattern takes as many fields as `build` takes
arguments; a matcher giving another count is an error. A nullary view (`build`
a value, not a function) is that value wherever it is used:

```apn
Nat = view (k -> k + 1) (n | n > 0 -> [n - 1])
Zero = view 0 (0 -> [])
fact Zero = 1
fact (Nat k) = (k + 1) * fact k
fact 5                          # 120
Nat 4                           # 5
```

The fields' types are what the matcher gives. Which values a view's pattern
matches only the matcher decides, so the checker leaves it to the run.

A type in a pattern takes its parameters, then a value. Applied to exactly its
parameters it matches a type value, each name binding the part in its place:
`(Option t)` given `Option Int` binds `t` to `Int`, `(Vect n a)` given `Vect 3
Float` binds 3 and `Float`. One more pattern is a value of that type, the typed
pattern `((Option t) x)`, whose names the value binds: `(x : Option t)` given
`Some "a"` binds `t` to `String` and `x` to the whole variant, and `(xs : List _)`
takes any list. `IO` takes one parameter, as `List` does: `(IO t)` given `IO Int`
binds `Int`, and `(a : IO [])` or `(a : IO _)` is an action, `a` the action itself,
which the pattern does not run (`[]` is a type there, the empty list's). `(xs : List Int)` and `(x : Option Int)` decide by the type the
checker gave the value, never by what its elements hold, so a run takes the
clause the checker chose: `["a"]`, `map show xs` and `Some "a"` do not match,
while `[1,2.5]` and `[1..]` do, their elements converted as they are used (2.5
fails only when used). A run infers these types even when it reports no type
errors, so the choice never depends on checking; code no check reaches
(`Dynamic`) has none, and there the pattern takes any list or that variant.
Any other count is a static error (`(Pair x)` for `Pair a b`).
A type without parameters takes its value at once (`(x : Int)`, `(c : Color)`).
A constructor is a function that does not evaluate, and reads as one there:
bare, it is its function type (`(f : Some)` takes an `a -> Some a`, `(x :
None)` the value `None`); given a type for each field, the type of the values
it makes (`(b : Box Int)`, `(s : Some Int)`, `p : Point Int Int = Point 1 2`),
converting a value as ascription does; a type variable among them binds that
field's type (`kind (b : Box t) = t`). See [templates and
types](templates-and-types.md#constructor-functions).

Destructuring definitions immediately perform the pattern match, but bound
variables remain deferred. Blocks create child scopes. Environments are
lexical, and a rebinding never changes what was written before it (see
[bindings](#bindings-and-output)). Only the selected ternary branch runs.

Record literals retain their existing field-expression evaluation behavior;
records do not become uniformly lazy. Rendering resolves ordinary data fields,
and a field holding a zero-argument function shows its value too (`m0 = ([[0,0]]
: HashMap _ _)` then `[d = m0]` shows the map), except one whose call runs
statements (a block, `bye = { print "bye" }`), which shows as a function, so
inspecting a record runs nothing.

## Inspection and numbers

`debug x` is the action printing `x` as code, highlighted on a terminal: code,
a list, as its items are written (`debug [1 + 1]` prints `[1 + 1]`, see
[code](#code)), any other value as source writes it (`debug "hi"` prints
`"hi"`). A list or record literal prints as its source text, from its `[` to its
`]`, with its line breaks, indentation and comments, its lines moved left by the
indentation of the line it starts on; a list or record built by running code
(`map`, `++`, `step`, an update such as `r [x = 1]`) has no source text and
prints from its items. Code is quoted, so an action in it is shown, not run:
`debug [print 3]`. `step n code` goes `n` levels into code (its last item): a
name to what it is defined as, a block to its last statement, anything else
computable one level further, and gives the level as code, which `debug` shows
and `do` runs (`inner = { print 1; return 2 }`: `debug (step 2 [inner])` prints
`[return 2]`).
`to String` demands its argument and collects its full rendering into a string.
Values render as source writes them: strings and characters escaped
(`"a\"b"`), a constructor argument that is itself
compound is parenthesized (`Some (Some 1)`, but `Distance -2`), operators show
as sections (`(+)`, `(+ 1)`, and `(1 +)` for `(+)` applied to 1). A function
with several clauses shows each as a pattern lambda on its own line:
`f (x : Int) = 1; f (x : Float) = 2` prints `(x : Int) -> 1` and `(x : Float) -> 2`
(with several parameters, constructor patterns keep their parentheses:
`(x : Int), y -> 1`).

A partly applied function shows what is left of it: the clauses its arguments
match, as a call would choose them, without the matched parameters and with
the names they bound shown as the arguments. With `g (x : Int) y = x + y` and
`g (x : Float) y = 0`, `g 1` prints `y -> 1 + y`; `(a, b -> a + b) 1` prints
`b -> 1 + b`. A clause a call could still reach stays (`h x 0 = x` alongside
adds the line `0 -> 1`). Printing evaluates an argument only as far as
matching a pattern needs; one not evaluated yet shows as its source.

Numbers follow a Scheme-style tower: exact arbitrary-precision integers and
reduced rational fractions, inexact binary64 reals, and complex numbers whose
components are real numbers. Exactness is separate from mathematical type:
`isInteger 3.0` is true and `isExact 3.0` is false. Arithmetic with an inexact
operand produces an inexact result only when conversion of the exact operand
is lossless. Otherwise use `inexact` explicitly. Exact `/` returns reduced fractions;
`quotient` truncates integer division. `%` and `remainder` follow the dividend's
sign; `modulo` follows the divisor's sign. Exact zero division raises an error;
inexact division can produce IEEE infinities and NaNs. `safeDiv` (in `number`)
returns `None` for any zero divisor and `Some` quotient otherwise.

Integers use `BigInt` throughout lexing, parsing, arithmetic and formatting.
APN literals include `0xFF`, `0b11010100`, `0o235461`, `.5`, and `1.2e-3`.
Scheme `#` prefixes are not used: `#` remains a comment. Fractions use ordinary
APN division (`1 / 3`); complex values accept an adjacent imaginary suffix (`1i`, `3+4i`, `.5i`),
or use `makeRectangular 3 4` or
`makePolar radius angle`. Complex output is `3+4i`. `from String` reads numeric text,
including fraction and complex output, without evaluating arbitrary APN code.

`exact` converts the actual binary floating-point value to an exact fraction:
`exact .5` is `1/2`, while `exact .1` is
`3602879701896397/36028797018963968`. `inexact` rounds an exact number to binary64.
The printer distinguishes `3` from `3.0` and preserves `-0.0`; infinity/NaN print
as `+inf.0`, `-inf.0`, and `+nan.0`. `from String` understands these spellings.

Finite numeric comparisons compare exact represented values, including mixed
exact/inexact inputs, without rounding a large exact operand first. Thus
`9007199254740993 > 9007199254740992.0` is true. NaN is unequal to every number
including itself, and ordered comparisons involving NaN are false. Non-real
complex numbers support equality but not ordering. Integer literal patterns
use numeric equality, so a pattern `1` also matches `1.0`.

All-exact ranges use exact arithmetic, including fractional bounds and steps:
`[0,1/2..2]` yields `[0,1/2,1,3/2,2]`. A float anywhere in the bounds or
step promotes the whole range to binary64, including `[0,1/2.0..2]`.

The numeric API uses APN camelCase names and fixed arities. Unary predicates:
`isNumber`, `isComplex`, `isReal`, `isRational`, `isInteger`, `isExact`,
`isInexact`, `isZero`, `isPositive`, `isNegative`, `isOdd`, `isEven`,
`isFinite`, `isInfinite`, `isNaN`. Unary operations: `exact`, `inexact`,
`numerator`, `denominator`, `floor`, `ceiling`, `truncate`, `round`, `sqrt`,
`abs`, `realPart`, `imagPart`, `magnitude`, `angle`, `conjugate`, `exp`, `log`,
`sin`, `cos`, `tan`, `asin`, `acos`, `atan`. Binary operations: `quotient`,
`remainder`, `modulo`, `gcd`, `lcm`, `min`, `max`, `expt`, `makeRectangular`,
`makePolar`, `atan2`, `rationalize`. `round` uses ties-to-even. Perfect square
roots of exact rationals remain exact; other roots and transcendental values
use floating-point approximations (with complex results when required).

This adopts the general numeric model, not implementation-specific Chez
fixnum/flonum optimization APIs or MIT machine-format controls. APN's existing
operators retain their arities and collection overloads.
References: [MIT Scheme numbers](https://groups.csail.mit.edu/mac/ftpdir/scheme-7.4/doc-html/scheme_5.html)
and [Chez Scheme numeric operations](https://www.scheme.com/csug8/numeric.html).

Indexes and counts remain arbitrary-precision until a checked conversion is
needed for a host array index. `exit` accepts a signed 32-bit status, matching
its host boundary; larger values raise an error instead of being rounded.

## Verification

```sh
deno check main.ts
deno test --allow-read tests/*-test.ts
```

The assertions cover finite prefixes, shared effects, patterns, errors, and
streaming/interruption recovery. `examples/features.apn` is a tour of the
language.

## List index assignment

`arr 0 = 10` rebinds an existing list to a modified copy in the current scope,
like record field assignment, converting the value to the element's type:
`arr = [Float]; arr 0 = 1` produces `[1.0]`, and `arr = [Int]; arr 0 = .2`
errors, as `arr = [(0 : Int)]; arr 0 = .2` does. `arr -1 = 10` updates its final element, as `arr -1` reads it (`arr - 1 = 10`
defines `-`); likewise `f -1 = ...` is a clause of `f` for the argument `-1`.
A single index must evaluate to an integer or a value whose `to Int` makes one
(an enumeration's position); a finite list of these indices selects multiple
slots. `arr [1,2] = arr [2,1]` swaps the old values. Multi-index assignment requires
one replacement per index; duplicate indices use the last value. Negative indices
require a finite source list. See [slot assignment](templates-and-types.md#slot-assignment).
Positive updates traverse only as far as the selected cell, leaving unused
unselected heads and the remaining tail deferred. The selected head is inspected for an existing type annotation without invoking
a stored action. Bounds errors leave the binding unchanged.
The RHS is evaluated against the old binding before it is replaced. Consecutive
index assignments execute in order. Inside a block the update shadows the outer
binding. On an unbound name or an existing function, the same syntax remains a
literal-pattern function definition (`f 0 = 10`).

Leading-dot decimals such as `.1`, `.2`, and `-.5` are float literals. Like other
floats, `.1 + .2` yields `0.30000000000000004` under binary floating-point
arithmetic. An attached numeric field access (`rec.1`) stays record access;
whitespace allows a float argument (`print .1`). Range dots (`[1..3]`) are unchanged.

Float ranges support finite and infinite forms, including `[0,0.5..100]` and
`[0,.5..]`. Each value is calculated from the origin and an index to avoid
accumulating rounding error. A small endpoint tolerance includes bounds affected
by floating-point rounding; it is capped at half a step. Integer ranges remain
exact, while mixed ranges inherit float precision. A floating range that can no
longer advance reports an error. Range patterns remain integer-only.

A lambda with an explicit `{ ... }` body ends at the closing brace. Operators
following that brace belong to the surrounding expression: `[1, 2] * x ->
{ x + 1 } * x -> x * 2` produces `[4, 6]`. Unbraced lambda bodies continue
to consume a full expression.

Bounded character ranges such as `['a'..'e']` produce strings. They follow
Unicode scalar order (skipping surrogate code points); descending bounds reverse
the direction. These strings are finite and constructed eagerly.

`iterate f seed` produces the lazy infinite sequence `seed`, `f seed`, and so
on. Taking zero elements does not evaluate either argument; taking one does
not call `f`. Sequential consumption supports long sequences. As with other
nested deferred computations, skipping many unevaluated elements then demanding
a value that depends on all of them can hit the evaluator's stack limit.

The checker checks a negated argument as written, so `g -1` (or `g -k` with
`k = 1`) for `g (n : UInt)` is a static error; so is `h 2` for `h x = g -x`,
where the value is known only at the call. A typed parameter (a numeric type, a schema, a contract) given a
value that depends on an enclosing function's parameter is checked at that
function's calls, by value, as a direct call would be: with
`Pt = [x : Float, y : Float]` and `g (Pt p)`, `h x = g x` accepts `h [1,2]` as
`g [1,2]` does, and `h x = g [x,-x]` rejects `h 2` for `[x : UInt, y : UInt]`
but accepts `h 0`. For numbers: `h -2` passes `2` to `g`, and `h x = g x` accepts `h 2` and rejects
`h -2` and `h "a"`. Such calls are checked even if `h` is never called: a
call of `h` inside another, uncalled function (`d y = h 2`) is checked with
its value, and `h`'s own definition is checked by type, so a parameter `h`
also uses as a String cannot reach `g (n : UInt)`. The error points at the call
that supplies the value, or at `g x` when `h`'s definition alone decides it.
Numeric subtraction is unchanged. Precedence and associativity are unchanged:
`sqrt -1 * 4` means `(sqrt -1) * 4`, as `sqrt -1 + 2` means
`(sqrt -1) + 2`. Use parentheses when a different grouping is intended.

Polar literals use `radius@angle`, e.g. `2@3`, with angles in radians.
The angle may have a sign, and decimal/exponent notation is accepted. They
evaluate like `makePolar radius angle` and display in rectangular form.
Use `makePolar` for computed radius/angle expressions.

An exact zero polar angle returns the radius unchanged, avoiding floating-point
conversion: `2@0` is exact `2`, and `makePolar (1/3) 0` is exact `1/3`.
An inexact radius stays inexact; an inexact angle still uses trigonometry.

## First-class types

`Int` and `UInt` are arbitrary-precision signed/unsigned integers. Fixed-width
types are `Int8`, `Int16`, `Int32`, `Int64`, `Int128` and matching `UInt`
variants. `Float` is flexible floating precision, using binary64 by default.
`Float32` and `Float64` commit to binary32 and binary64 respectively.
`Fraction` holds an exact rational, `Complex` any numeric complex value, and
`ComplexExact` an exact one. A value is given one by ascription (`5 : Int32`),
and `to T` is the conversion as a function (`map (to Int) [1.0,2.0]`). A number prints as its value whatever its type (`(123 : Int32)`
prints `123`), as a named subtype's value does (`5 : Count` prints `5`); `typeOf`
gives the type.

`UInt` is the natural numbers, with the prelude's constructors `Z` (`(0 : UInt)`) and
`S` (`S n` is `n + 1`, converting `n` as `(n : UInt)` does). The patterns `Z` and
`S k` take a number apart: `Z` matches 0, and `S k` matches any number from 1
up, binding `k` to one less, as a `UInt`. Like a `(n : UInt)` pattern, they accept
a plain integer that converts; a negative one matches neither (a static error
for a literal).

```apn
factorial Z = 1
factorial (S k) = (k + 1) * factorial k
factorial 20                     # 2432902008176640000, a UInt
S (S Z)                          # 2, a UInt
```

Every value is taken apart the same way by `Takes` and `Gives`, the prelude's
[views](#patterns-variants-and-scope), a function as a list of what it takes: `Takes t k` matches a function, binding `t` to the type
it takes (what `typeOf` gives as its input, any value where that is unwritten) and
`k` to the function itself, which applied gives the rest, again a `Takes` or a
`Gives`; `Gives v` matches any other value, binding it. Built, `Takes t k` is `k`
taking only `t` and `Gives v` is `v`. Taking a function apart shows what it takes,
never how it is written, so equal functions take apart alike (`return = Some` and
`return x = Some x`). A function whose arity its arguments decide has no static
type, so its result is `Dynamic`:

```apn
arity (Takes _ k) = 1 + arity (k 0)
arity (Gives _) = 0
add x y = x + y
arity add                        # 2
[Takes t _] = [(n : Int) -> n]   # t is Int
sumTo0 total = Takes Int (n -> n == 0 ? (Gives total : Dynamic) : sumTo0 (total + n))
sumTo0 0 1 2 3 0                 # 6
```

`S k` destructures, it does not unwrap: `k` is the predecessor, itself a `UInt`,
while `(k : UInt)` binds a `UInt`, as any typed pattern binds a value of its type.
A bare `Z` in a pattern takes no fields (`plus Z m = m`). A program that declares
its own constructor named `Z`, `S`, `Takes` or `Gives` gets it in that scope,
matched as a variant; a number never matches a variant pattern.

Ascribing `Float`, `Float32`, or `Float64` rounds to the target floating-point
precision, for bare or annotated inputs: `(.1 : Float32)` is `0.1` as a Float32
(the nearest binary32 value, displayed with the shortest round-tripping
decimal); `((9007199254740993 : Int) : Float)` rounds to `9007199254740992.0`.
This also applies through aliases and `to T` (`to Float32 x` is `(x : Float32)`).

Integer ascription stays lossless: `(.2 : Int)` and `((.2 : Float) : Int)` both error.
Choose integer rounding explicitly: `(floor .2 : Int)` is `0`, while
`(truncate -1.7 : Int)` is `-1`. Fixed-width integer overflow and nonzero
imaginary-part loss remain errors. Typed parameter matching, function contracts,
and assignment to existing numeric slots remain lossless. Floating arithmetic
adapts flexible Float operands as described below.
Numeric equality ignores
annotations: `.2 == (.2 : Float)` remains true. Int and Float values display without
a prefix; specialized types such as Int32, Float32 and Float64 retain theirs.

A type takes types and never a value: `Int32 5`, `map Int32 xs` and `xs *
Int32` are errors, however the type reaches the value, as applying any name to
more than it takes is. A value is made a member by ascription, `(5 : Int32)`,
and `to T` is that conversion as a function: `map (to Int32) xs`.

### Flexible and fixed floating precision

A decimal literal such as `.2` behaves like `(.2 : Float)`. Both are flexible values,
including after binding to a variable, passing through a function, or storing in a
collection. Two flexible operands use binary64. A flexible operand paired with
Float32 or Float64 rounds to that fixed precision before arithmetic; the result
keeps the fixed type. Operand order does not matter and the original values are
not mutated. This is runtime precision selection, not backwards type inference.

```apn
.1 + .2                       # 0.30000000000000004
(.1 : Float32) + .2           # 0.3, a Float32
(.2 : Float) + (.1 : Float32) # 0.3, a Float32
x = .2
(.1 : Float32) + x            # 0.3, a Float32
# (.1 : Float32) + (.2 : Float64)  # error: cannot combine Float32 and Float64
(.1 : Float32) + ((.2 : Float64) : Float32) # 0.3, a Float32
```

Different fixed precisions do not mix, even where a conversion would be
lossless ([fixed-width types](#fixed-width-types)). Comparisons still compare numeric values without adopting an
operand's precision. Flexible values are stored in binary64; this does not give
exact decimal arithmetic or recover precision lost in an earlier computation.
`Float` construction explicitly returns a value to flexible precision.

The sized integers follow their [APN model](intrinsics.md): same-type
operations preserve the type and check integer overflow, and so does a sized
integer with an `Int`, whose result (not the `Int`) must fit:
`(2000000000 : Int32) - 3000000000` is the `Int32` `-1000000000`, and
`(1233421412 : Int32) + 10^20` is an error, never a wrapped or widened number.

#### Fixed-width types

The fixed-width types are the sized integers (`Int8` ... `UInt128`, `UInt`,
`Char`) and the fixed precisions (`Float32`, `Float64`); `Int` and `Float` are
flexible and join any of them. Two different fixed-width types do not mix: `+`, `-`, `*`,
`/`, `%`, `^`, `expt` and elementwise array arithmetic on them are an error
(`(1 : Int32) + (2 : Int64)`, `(1 : Float32) + (2 : Float64)`,
`(1 : Int32) + (2.5 : Float32)`), and `(x : Int64)` converts one explicitly. A
typed parameter is a value of its type, so the check sees it from the patterns
alone: `f (x : Int32) (y : Int64) = x + y` is a static error.

Another typed number keeps its type
with an untyped one where both convert to it (`(1 : Float32) / 10` is a
`Float32`); otherwise arithmetic uses the numeric tower.
Exact-to-inexact conversion must still be lossless. Integer `/` can produce a
typed `Fraction`. Float32 arithmetic rounds its result to binary32. Other numeric
native functions return their natural numeric result types; use a constructor to
impose a specific width on them.

`typeOf value` returns a type descriptor: the smallest type the value is in, each
part widened to its type. `typeOf 5` is `Int` and `typeOf Int` is `Type`, a type
being a value too; with `Box a = | Box a`, `typeOf (Box 3)` is `Box Int` and
`typeOf (Box Int)` is `Box Type`, a `Box` holding a type, which is in `Type` as
well because `Box Int` names one (`isType Type (Box Int)` is true; `Box Type`
is the smaller). `isType Type value` tests membership
without casting. `Number`, `Real`, `Integer`, `Exact`, and `Inexact` are aggregate
numeric guards. For example `isType Number (1 : Int32)` is true.

### Clause ranking

Typed overloads use constructor patterns:

```apn
add (x : Int) (y : Int) = x + y : Int
add (x : Float) (y : Float) = x + y : Float
add (x : Number) (y : Number) = x + y
```

A clause is tried before another when its patterns match only values the
other's match: a type is the set of its values, so `0` before `(x : Int)`
before `(x : Number)` before `x`, `(x : Money)` before `(x : Float)` (a
named type's pattern takes only its values, its base's those too), `Circle r`
before `(s : Shape)`, as
`[x,y]` before `x :: rest` before `xs`, `Some x` before `_`, `f x x` before
`f x y`, and a guarded clause before the same patterns unguarded. One thing
comes before that: how many arguments a clause takes as they are, each a
value of a type or literal its pattern names. So `(x : Int)` takes `5` before
`(x : Int8)` would convert it, while `(x : Int8)` still takes it before `_`
(a pattern naming no type takes nothing as such), and a conversion through a
to instance comes after both. Patterns neither of which contains the other
(`[x, 0]` and `[0, y]`) keep the order they were written in. Ranking reads no
argument a program's constructor pattern would (it converts nothing: a value it
does not take fails it when tried), so after `pick (Box a) b = a` and
`pick a (Box b) = b`, `pick (Box 1) boom` is 1 without evaluating `boom`. So no
clause hides another by coming first, and clauses added elsewhere (a module's
instance, a REPL session's) take their place by what they match. Converting
either a typed or an untyped input must be lossless; explicit floating-point
construction is a separate operation and does not relax pattern matching. The same
ranking chooses among any function's clauses and a `match`'s alternatives:
`0 ~ [n -> "any", 0 -> "zero"]` is `"zero"`. A typed pattern binds what ascription
makes, a value of its type: `unwrap (x : Int32) = x` returns the `Int32` `5`, given
`5` or `(5 : Int32)`, while `(x : Number)` and the other aggregates bind the value
as it is (`(x : Int)` of `3` is `3`, and its `x / 2` the `Fraction` `3/2`). Patterns do not mutate
the original argument or strip types from unrelated values.
Repeated variable names assert equality, so `(x : Number) (x : Number)` is not a
catch-all for two different numbers.

`100 * _ -> (0 : Int)` repeats the typed value using the existing function iteration
overload. Two numeric operands always multiply: `100 * (0 : Int)` returns `0`
and `(3 : Int) * (2 : Int)` returns `6`, both still typed Int.

## HashMap

`HashMap k v` is the type of maps from keys of `k` to values of `v` (`HashMap
String Int`; `_` for one to infer): an association list whose keys appear once,
in the order first inserted, which the run stores to find a key at once. A map
is an association list (a record too: its fields are its pairs) converted to
it, as any value of a type is made: `([["x",123]] : HashMap String Int)`,
`table : HashMap String Int = [["x",123]]`, or `([] : HashMap _ _)` for none.
It is that list: it prints as it, equals it (`== [["x",123]]`), and what takes
a list takes it (`length`, `map`, `*`, a `List [String,Int]` parameter); its
`typeOf` is `HashMap String Int`. A key is any value with equality: a number,
text, a list, a record, a constructor's value. Numerically equal keys share an
entry regardless of exactness or numeric type; distinct strings/chars stay
distinct. Duplicate keys keep the last value, at the position first inserted.

`insert [["x",123]] m` returns `m` with those entries, and `remove key m` one
without the key; the old map stays as it was. `lookup key m` or `m key`
retrieves a value, raising an error when absent; use `has key m` when absence
is expected. `m key = v` binds `m` to a copy with the key's value replaced or
added at the end, as for an association list, and `m.x` is `m "x"` (`m.x = v`
is `m "x" = v`), as on any value that is not a record. `keys`, `values`, `pairs`, `length`, and `null` operate on maps.
Values stay lazy; keys are evaluated at construction. `(m : HashMap k v)` is a
map's pattern, `k` and `v` its keys' and values' types (see
[intrinsics](intrinsics.md#maps)).

Iterating a conversion converts each: `100 * to Int` is the integers `0` through
`99`, and `[1..100] * to Int` `1` through `100`; `100 * (0 : Int)` multiplies.

The nonnumeric type names are types as the numeric ones are: `Bool`, `String`,
`List a`, `Record`, `Function`, `Type`, and `Variant` (a `Char` is a number:
see [text](intrinsics.md#text)). Ascription to one
checks a value of its kind without forcing list elements or coercing unrelated
values (`([1,missing] : List _)` reads nothing), and their typed patterns work
in overloads, e.g. `f (x : Bool) = x`; `isType` tests them. A `Record`
holds any record, whose fields the run reads (`f (r : Record) = r.a`). Use declared
constructors to create a particular variant; `Variant` holds any such value.

A typed pattern whose type is a lowercase name, `(x : t)`, binds `t` to the
value's type and `x` to the value, a number without its explicit type:
`myTypeOf (_ : t) = print t` prints `Int32` for `(5 : Int32)`, while `payload (x :
_) = x` returns `5`, as `_` discards the type, as it discards a value. It
inspects the outer value without forcing list contents. Repeating the type
variable, as in `(x : t) (y : t)`, requires both arguments to have the same type.

## Module imports

A file is code whose value is its last statement's, as a block's is: a module
ends in the record of what it gives, and what comes before the record stays its
own. `import "name"` is an action yielding a module's value: it runs the file
once per interpreter, in a scope of its own (the prelude and what the file
imports; the caller's bindings do not reach it), and a later import yields the
same value. Like any action, it is run by `<-` or as a statement, and it opens
nothing: a pattern does. `[..]` binds each of a record's fields under its own
name, as Haskell's `{..}` does: `[..] = r` opens `r`, `[..] <- import "name"` a
module, and `r.[..] = e` binds `r` and opens it, as any dotted pattern binds
both its parts. Its names must be known where it stands (a record the check
reads; `Dynamic` for one only the run knows). A list of records opens each in
turn (`[..] = std.[option,text]`, as `std.[option,text]` is the list of those
modules), and `[]` opens nothing. A folder's record holds its modules, each
imported in turn; a module may import its own folder (`std <- import "std"`
in `std/glsl`, which then opens `std.[text,sequence]`), whose modules are
then each imported when first read, and one needing itself while it is
imported (opening its own entry) is a cyclic import.

```
# shapes.apn
[..] <- import "std/number"    # the file's own: an importer does not get it
turn = 2 * pi                  # its own too, a helper the record reads
[
    circumference r = turn * r
    area r = pi * sq r
]
```

```
std <- import "std"            # the standard library, a record of its modules
[..] = std.[function,option]   # opens both modules' names
[..] <- import "std/text"      # imports and opens a module
option <- import "std/option"  # one module: option.withDefault, option.Some
text.[..] <- import "std/text" # both: text.words, and words
[browser,task] = std           # modules of std, by a record pattern
[halt] <- import "std/system"  # one name, by a record pattern
```

A module's record is a record as any is (see [records](#records)): its fields
are in scope for all of it, a function's clauses join, a type's constructors
are fields, and `r ++ [...]` gives `r`'s names with its own. So what both the
record and a helper above it need is a record of its own, opened where it is
defined and joined to the record the module gives:
`shared.[..] = [Shader = | Glsl String]` before the helpers, and
`shared ++ [...]` last.
A file ending in a binding gives `[]`. One ending in a function gives the
function, a module that takes parameters: after `make <- import "counter"`,
`make 10` is a module of its own. `import` is a prelude function (`import =
intrinsics.import`), not syntax; the check follows a path written as a
literal, and another is decided by the run (`Dynamic`).

`std` is the library's folder; `std/name` one of its modules. Any other name
is looked up next to the importing file (the current directory in the REPL)
as `name.apn`, else as a `name/` folder, then the same way in each parent
folder up to the program's folder (the nearest match wins). A folder is the
record of its entries' values, each `.apn` file or subfolder a module of its
own (`shapes.solid.box`), all imported when the folder is: reading a field never
runs a module. A file wins over a folder of the same name, whose folder is
then reached by path (`import "report/lines"`). A module importing a folder
that holds it is a cycle, an error like any other import cycle: a library
module imports the modules beside it (`import "std/option"`), not `std`.
Inside the library, a bare name is a module beside the file. Clauses a module
defines for its own types join their functions from the moment it runs, opened
or not (see [functions travel with types](#functions-travel-with-types)).
`load` is the prelude's `load file = intrinsics.runFile (file ++ ".apn")`: an
action running `file.apn` beside the running file as an import runs a module,
but again each time it runs, yielding its value. A file is so a function of no
arguments, and `[..] <- load "f"` opens what it gives. A file may load
itself, as a function calls itself: a load as its last statement is a tail call,
which loops without growing the stack (`print "again"`, then `load "again"`,
runs until Ctrl+C), and one before the end nests, as a call that is not last
does. The check follows a load with a literal path outside `Dynamic`, as
an import's. To read a file as [code](#code) instead, which `[..] =` runs where it
stands, write `parse` of what `readFileFrom` reads (`std.io`'s).
See [the standard library reference](standard-library.md) for APIs and limits.

## REPL clauses

The interactive editor (Enter/Shift+Enter, paste, history, completion) is
described in [the REPL guide](repl.md).

Separate REPL submissions extend existing function clauses of the same arity,
as later clauses do anywhere (see "Definitions and actions"): code entered
before keeps the clauses it saw, as in GHCi.
Numeric literal/type dispatch retains its normal specificity rules. Module
loading retains its existing definition behavior.

## Mutable references

`x = Mutable 0` allocates a shared cell when first used (an IORef); functions
taking arguments can create independent cells. A cell holds values of its
first contents' type (`Mutable [0,0]` holds pairs); one made from a
conversion holds that type's values, so `Mutable ([] : List [Int,Int])`, or a
record schema's value (`Mutable ([...] : Body)`), holds lists of any length where
the type says `List`. Like a cell, a stateful object a definition makes (a
[p5](p5.md) object such as `loadImage "a.png"`) is made once, where the
definition is first used, and a cell holding one takes another as itself.

Writing is an action: `set cell value` (or `set cell $ value`) builds the
action that, when run,
evaluates the new outer value, replaces the old contents and yields []. A
failed update leaves the cell unchanged. Aliases and inner scopes share the
cell. Arithmetic, printing, application and field access (`cell.x`) read its
contents as they are when evaluated;
`typeOf x` reports `Mutable`. Existing lazy calculations still memoize: a
previously forced calculation is not recomputed after mutation. Compound
contents retain ordinary lazy semantics; `set` does not deep-copy or deeply
force them. So a part of the new contents computed later (an element of
`map f cell`) reads the cell as it is then, the new contents: a typed
parameter reads the old ones when its function is called (`step (List _ xs) =
map f xs`, then `set cell (step cell)`). A value that depends on itself never
finishes; in a browser page, which cannot wait, it is an error.

Function values display source: `func x = print x; print func` prints
`x -> print x` without running the body. Multiple clauses display their
equations; partially applied functions include their bound arguments without
forcing them. Captured environments are not expanded. A method (`map`, `return`,
`>>=`, `<*>`, `to`, `from`) displays like an overloaded function: its builtin's name (what
IO and other built-in values do), then each instance's clauses, one per line. After
`[..] = std.option`, `print return` shows `return`, `Some` and `Ok`.

## Pattern functions

`x ~ alternatives` (the prelude's `~`, `intrinsics.match`) matches `x` against a
list of unary functions; pattern lambdas
and runtime function contracts are described in [pattern functions](pattern-functions.md).
It tries them as a function's clauses are tried, most specific first
([ranking](#clause-ranking)). Only pattern mismatch or a false guard selects the next
alternative; runtime errors propagate and unchosen alternatives' bodies never run.
Guards use truthiness.

## CLI file errors

If the input file cannot be opened, APN exits with status 1 and prints a concise
message to stderr, for example `error: cannot read "missing.apn": file not found`.
Directories and permission failures receive similarly short messages, without
Deno stack traces. The CLI uses the supplied path literally.

## Tail calls and recursive loading

Fully applied APN functions reuse an execution loop for calls in tail position,
including the chosen alternative of a `match` (so a ternary's branch), the final
expression of a block, and pipes.
Arguments remain lazy: an unused argument is not evaluated by this optimization.
Calls with work remaining (such as `1 + recurse n`) still consume stack, and a
large deferred accumulator can still overflow when finally forced. Use `<-` to
compute an accumulator on each iteration when appropriate. So does an
expression nested deeply, as a chain of hundreds of operators is: past what the
stack holds it is a call stack overflow (a parse error for parsing it).

Code `[..] =` runs may end with another `[..] =` of code: that one runs in place of
the last statement, as a tail call, so it does not grow the host call stack.

## Sequencing expression lists

`do` is an ordinary APN function available in the prelude and `function`:

```apn
do [print "hi", print "there"]
answer <- do [print "calculating", return 42]  # prints, binds 42
```

`do statements` is the [block](#blocks-are-do-blocks) with those statements:
`do [a,b,c]` is `{ a; b; c }` in every way, so `do []` is `{}` (the empty
list), `do [x = 1, x + 1]` is 2, `do [1,2]` is an error (`1 >> 2`), and with an
action among them it is a do-block whose last element must be an action. It accepts computed lists too, and
processes the spine incrementally. Each run of the action runs the elements
again; an error stops the sequence.

Numeric lists and records support elementwise arithmetic and scalar broadcasting;
`++` remains concatenation, and `*` with a function remains iteration.
See [numeric arrays](arrays.md) for matching-shape rules and lazy validation.

## Zero is initialization

A value is given a type by ascription; ascribing a list or record to a record
template initializes its omitted type slots: `[] : Vector3` is its defaults.
Assigning a value into a type slot makes it that type's default
([slot assignment](templates-and-types.md#slot-assignment)). See [zero initialization](zero-initialization.md)
for the default table, type inspection, variant rules and limitations.

## String formatting

`format template arguments` requires an argument list. Each `%` consumes one
argument; `%%` prints a literal percent without consuming one. Missing or extra
arguments raise an error before any argument is rendered. For example,
`print $ format "vec = %" [vec]` prints one formatted record. Passing `vec`
directly instead of `[vec]` is invalid when `vec` is a record.

`enumerate xs` returns a lazy list of `[index,value]` pairs. Indices are exact
integers starting at zero, so `enumerate [10,20]` is `[[0,10],[1,20]]`. It supports
infinite lists, and enumerating an element does not force its value.

## Record-scoped expressions

`record.(expression)` and `record.{ statements }` evaluate in a local scope populated by the
record's fields. Fields shadow outer names; other names resolve in the surrounding
lexical scope, including functions such as `sqrt`. It is `{ [..] = record;
expression }`, except that the record's names may be known only when it runs
(`r.(x + 1)` with `r : Dynamic`), where `[..]` needs them before.

```apn
point = [x = 3, y = 4]
point.(x + y)                # 7
point.([x,y])              # [3,4]
point.(x = 10; x + y)        # 14
point.x                     # 3
point.{
    result = x + y
    result * result
}                           # 49
f = point.(n -> x + n)
f 2                         # 5
```

Brace blocks use the usual four-space indentation and aligned closing brace.
Both forms return the last expression; empty blocks return `[]`. Grouping also
accepts either delimiter for operator sections (`{ + 2 }` or `(+ 2)`), parameter
patterns (`f {x : Int}` or `f (x : Int)`), and grouped function contracts.
Definitions and ordinary field/index updates inside the expression are local;
they do not implicitly update the original record. Returned functions and deferred
values retain this local scope. Explicit side effects, including `Mutable` updates
or writes through an environment view, keep their normal behavior.

Only fields whose keys are names are exposed as local names (`` `my value` ``
is not). Fields are installed without demanding their values or invoking stored
actions. Existing
record-construction evaluation rules still apply.

`record.(expression) = value` is not an assignment target; `record key = value`
updates a computed key.
A list's names are its keys' strings, known only at runtime, so `xs.(e)` is
an error: open a record of its pairs, `(to Record xs).(e)`.

## Type descriptions

A list value's type is exact, the list of its items' types: `typeOf [1,2,3]`
displays `[Int,Int,Int]`, `typeOf [1, "a"]` is `[Int,String]`, and `typeOf []`
is `[]`, the empty list's type. A record's is the record of its fields' types,
each found when it is shown: `typeOf [x = 1, y = Float]` is
`[x : Int, y : Type]`, and `typeOf [p = [q = 1.5]]` is `[p : [q : Float]]`. A
record a record type made has that type (`typeOf ([] : Quote)` is `Quote`). A list's type
is made as it is read, an item or tail read only when its type is
(`head (typeOf [1,missing])` is `Int`), so a list built with `::` is exact too
(`typeOf ([1,2]::[3,4])` is `[[Int,Int],Int,Int]`, as for `[[1,2], 3, 4]`). An endless
list is endlessly many of its elements' type: `typeOf [1..]` is `[Int..]`, and
so is `typeOf ones` for `ones = 1 :: ones`. That is a range of a type, which
repeats it as a range of numbers counts (a range is `enumFrom` and its
siblings, whose prelude clauses do both; see [sugar](#sugar)): `[Int..]` is the list
`[Int,Int,Int..]` (`head [Int..]` is `Int`), and as a type it is the type of
endless lists of Ints, so `to [Int..] [1,2]` is a length mismatch and
`isType [Int..] [1..]` is `True`. A type has no step or bound
(`[Int,String..]` and `[Int..String]` are errors). `List` is the prelude's
recursive type, `List a = Nil | Cons a (List a)`: a list is empty or an element
on a list. `[]` and `::` only write them another way (the prelude's `Nil = []`,
`Cons = intrinsics.cons` and `(::) = Cons`): `[1,2]` is `Cons 1 (Cons 2 Nil)`,
and the patterns `Cons x xs` and `x :: xs` are the same. A union naming them,
by what the names are bound to, is one of lists, so `Vect` and any list type a
program writes reuse them rather than declaring their own. `List Int` is the union of its unfoldings, `[] | [Int] | [Int,Int] | ...`,
each a different member (`List Int == [Int]` is `False`, as a union is none of
its members), and endless lists belong too, as their unfoldings never end:
`[Int..]` is `Int :: [Int..]`, so `isType (List Int) [1..]` is `True`, and
`isType (List Int) [1, "a"]` is `False`. A type test reads a list as it
unfolds, accepting a cell it meets again (`ones = 1 :: ones`) or an endless
range, whose elements share one type. Any union of this shape
(`Seq a = Nil | Cons a (Seq a)`) is the same type. Any other union of list types is
a union too, unfolded the same way: `Pairs a = [] | a :: a :: Pairs a` holds
the even-length lists of `a` (`isType (Pairs Int) [1,2,3]` is `False`),
`Ints = [] | Int :: Ints` is `List Int`'s members, and `Tree = [] | Tree :: Tree`
lists of trees; `(xs : Pairs Int)` matches a value of it, and the static check
leaves such a union to the run. A [family](gradual-and-dependent-types.md#indexed-families)
is the same alternatives, each saying its index. A list's type is a list,
made as it is read, so any list's is exact: `typeOf (filter (> 0) [1,2,3])` is
`[Int,Int,Int]`, `head (typeOf [1, "a"])` is `Int`, and `length (typeOf xs)` is
`length xs`. `(List a) xs` binds `a` to the type
every item has: `Int | String` for `[1, "a"]`. Type errors use the same
notation.

Functions display argument/result descriptions: `f (x : Int) = x` gives
`Int -> Int`; `x -> print x` gives `a -> []`. Clauses contribute to one
combined description, with alternatives where their known types differ.
Explicit function contracts still return their declared arrow type.
Uncontracted descriptions are conservative diagnostics, not static inference
or enforced contracts. `a`, `b`, and so on name unresolved type variables; overloaded arithmetic, recursion,
and computed lazy elements can leave unknown parts. Describing a callable never probes its body with sample arguments or forces
list elements. Inspecting an argument expression
still evaluates it enough to obtain its outer value. Existing nullary action semantics remain: demanding a nullary action runs it,
so `typeOf` describes its result.

A described type compares equal to the type it describes: `[Int,Int] == typeOf
[1,2]` and `(a -> a) == typeOf (x -> x)` are true. A type taking
parameters is no type of values until given them: `typeOf [1] == List` is
false, and `typeOf f == Function` is true. `==` is exact (`typeOf [1,2]` is
`[Int,Int]`, not `List Int`); whether a value's type is within one is `<=`:
`typeOf [1,2] <= List _`, or `isList [1,2]`. A counted list type is the positional type it
makes: `Vect 3 Int == [Int,Int,Int]` is true. A description is not an enforced
schema; use a typed pattern or contract when you need validation.

### Values are sets

Every value is a set, and `<=`, `&` and `|` are inclusion, intersection and
union (the prelude's `a | b = intrinsics.union [a,b]` and
`a & b = intrinsics.intersection [a,b]`):

| Value | Its set | `a <= b` | `a & b` | `a \| b` |
| --- | --- | --- | --- | --- |
| A type | its values | every value of `a` is one of `b` | the values of both | the values of either |
| A number (a `Char` its code point, `False` 0 and `True` 1) | the numbers below it (a cut) | order | the lesser | the greater |
| A list or string | its (position, item) pairs | `a` is a prefix of `b` | the longest common prefix | the longer, one being a prefix of the other |
| A record or `HashMap` | its (key, value) pairs | every field of `a` is in `b`, equal | the fields equal in both | both, agreeing on shared keys |

```apn
[1] <= [1,2]                    # True: a prefix
[1,2] <= [1,3]                  # False, as is [1,3] <= [1,2]
"ab" <= "b"                     # False; compare "ab" "b" is -1 (dictionary order)
[x = 1] <= [x = 1, y = 2]       # True
[1,2] & [1,3]                   # [1]
3 & 5                           # 3
[x = 1] | [y = 2]               # [x = 1, y = 2]
# [1,2] | [1,3]                 # error: neither starts the other
Int & Positive                  # the Ints that are Positive
```

`a < b` is `a <= b` where `b` has more, and `>=`, `>` are the same turned
round. Inclusion is a partial order: two lists neither of which starts the
other are unordered. Sorting uses dictionary order instead, the standard
library's `compare`. Values of different kinds do not compare (`3 <= Int` is an
error: `3` is a member of `Int`, `3 : Int`, not a part of it; `[1,2,3] < 2` is
one too, statically or at runtime, whose hint compares the items, each with
`(< 2) * xs` or every one with `all (< 2) xs`), and a value is never a type's
subset. `==` and `!=` take any two values: ones of different
kinds are never equal (`1 == "a"`, `"" == []` and `[a = 1] == [1]` are
`False`), and records are equal where their fields are, in any order.

A list or record is a value, whatever it holds: `[Int] <= [Int,Int]` is `True`
(a prefix) and `[Int] | [Int,Int]` is `[Int,Int]`. It is read as a type where a
type is expected: beside a type (`[Int] <= List Int`, `[Int,Int] == typeOf
[1,2]`), after `:`, in a typed pattern and in a type declaration, where `|`
and `&` are of types (`(x : [Int] | [Int,Int])`, `Two = [Int] | [Int,Int]`).

For types, `X = (A | B)` names a union, while a bare `X = A | B` declares
constructors. `a <= b` is
containment, every value of `a` being one of `b` (`Int <= Number`,
`typeOf [1,2,3] <= List Int`, `[Int..] <= List Int`, `Pairs Int <= List Int`);
`a < b` is containment where `b` has more, and `>=`, `>` are the same turned
round. `==` is having the same values, `a <= b` and `b <= a`: the order of a
union does not matter (`Int | String == String | Int`), nor how it is written
(`List Int == E` for `E = [] | Int :: List Int`; `Seq Int == List Int`), but a
union is none of its members (`List Int == [Int]` is `False`), so
`isType t x` is `typeOf x <= t` where `typeOf` is exact (and `t` is no
unnamed [refinement](#refinement-types)). Containment is decided
as a type test is: unions alternative by alternative, list types as they
unfold (a head within the heads it may be, the rest within their rests), a
pair of types met again holding, as their unfoldings never end. A type
variable in a description (`List a`) is any type. A union of list types may
list written lists, `Two = [Int] | [Int,Int]` being `Int :: [] | Int :: [Int]`.

### Refinement types

`X = (p : T) | condition` defines `X` as the values of `T` that the pattern
`(p : T)` takes and for which the condition holds: the guard of a clause
(`f (n : Int) | n > 0 = n`) read as a set, `{ n : Int | n > 0 }`. It makes
nothing and names no constructor: it is the expression
`intrinsics.refine T (v -> v ~ [(p : T) -> condition, _ -> False])`, the set
of `T`'s values for which a function is truthy.

```apn
Positive = (n : Int) | n > 0
Small = (n : Positive) | n < 10       # a refinement of a refinement
Bounded lo hi = (n : Int) | lo <= n && n <= hi
Ordered = ([a,b] : [Int,Int]) | a <= b
f (x : Positive) = x                  # f -3 matches no clause
(3 : Bounded 1 10)                    # 3
(-3 : Positive)                       # error: -3 is not in Positive
typeOf ((3 : Positive) + 1)           # Positive
```

A name for a refinement of a scalar type, defined without parameters,
whatever its case, names a subtype, as `Count = Int` does
([named types](type-and-resource-rules.md#distinct-types)), and the sized
integers are exactly this (`Int32`, see [intrinsics](intrinsics.md)):
`(3 : Positive)` is a `Positive` (`typeOf` says so), it keeps its name through
arithmetic, each result tested against the condition (with
`I32 = (n : Int) | -2147483648 <= n && n <= 2147483647`, `(2000000000 : I32) * 2`
is an error, never a wrapped number), and `isType Positive 3` is `False` for
the plain `3`, as `isType Int32 3` is. A typed pattern of it takes one of its
values or a plain value its refinement holds (converted as the base's pattern
converts it: `(c : Scalar)` takes `65` as `(c : UInt)` does), binding the plain
value, as `(x : Int32)` takes `5`. Like any named type it is no subset of its
base (`Positive <= Int` is `False`, as `Int32 <= Int` is); a refinement of it,
`Small`, is a subtype of its own, taking a `Positive` or a plain value.

A refinement is a type wherever one is written, unnamed: `x : (n : Int) | n > 0
= 5`, and in a function type, whose parameter it refines: `(n : Float) | n > 0
-> Float` is a guarded lambda read as the function type it spells, taking the
Floats the guard holds for. Followed by `->` it is that lambda, else the
refinement. A function's declared result is converted as a value is, so `func :
(n : Float) | n > 0 -> Float` then `func = sqrt` checks that each result is a
Float when it runs (`sqrt` gives a `Number`, a `Complex` for a negative).
A declared type converts the value that crosses it, and never decides how
that value was computed: `wallis : Int -> Float` converts its body's exact
product of fractions once, at the end, and `x = 123` stays an exact `Int`,
received as `123.0` by `half (y : Float)` and halved to `123/2` elsewhere.

Any other refinement (of a list type, `Ordered`, or one a type function gives,
`Bounded 1 10`) is the set of its base's values for which the condition holds:
`typeOf ([1,2] : Ordered)` is `[Int,Int]`, `isType Ordered [1,2]` is `True`,
and it is within its base (`Ordered <= [Int,Int]`), while nothing is within it
but itself and its own refinements (conditions are not compared). Ascription,
typed patterns, constructor fields and unions test the condition on every
refinement; the static check decides it on values it knows (`f -3` above is a
static error) and leaves the rest to the run.

## Function types

Where a type is expected, a lambda is read as the function type it spells out,
as `[Int]` is both a list and a positional type: in a typed pattern
(`((a -> a) f)`), a constructor field (`MkCounter (s -> [a,s])`), an
ascription (`((+ 1) : a -> a)`), `isType`'s first argument, and beside a type in
`==` or `!=`. Elsewhere it stays a lambda. In the type, a lowercase name bound
to a type (or to a function, which builds one) is that type; any other is a
type variable, the same one throughout the signature. `(a -> b) -> List a ->
List b` is a function type taking a function: a parameter `(a -> b)` with no
name matches a function of that type without binding it, as `Int` matches an
Int.

A type variable applied to a type, `f a`, is any type holding an `a`: `List a`,
`Option a`, `Result a e` (the parameter `map` maps, the first). So `(a -> b) ->
f a -> f b` is `map`'s type, and a contract `(((a -> b) -> f a -> f b) m)`
accepts `map` and checks each use: the checker rejects `m (* 2) 5` (cannot use
Int where f a is required). Applied to more types, it fills the first
parameters in order: `f a e` is `Result a e` (but not `List a` or `Option a`),
so `(a -> b) -> f a e -> f b e` maps a Result (`f a e` as a parameter is the
flat typed pattern `((f a) e)`; parenthesized, `(f a e)`, it reads the same).
Headed by a name bound to nothing, such a pattern takes a type apart, as
`(Option t)` matches a type value: each name binds the type's part in its
place, and a literal must equal it, so `(t1 1 t2 -> print [t1,t2]) (Vect 1 Int)`
prints `[Vect,Int]` (and `withFile "notes" file -> ...` is such a lambda). A
definition's parameter reads the same in parentheses, `f (t1 1 t2) = ...`, as
does a type applied to its parameters (see [patterns](#patterns-variants-and-scope)).
Such a function takes a `Type`: `typeOf f` is `Type -> ...`.

Types differing only in their variables' names are equal: `(b -> b) == typeOf
(x -> x)`. A function contract checks each call: its arguments decide its type
variables (with `(a -> a)`, the argument `1` makes `a` Int), and the result
must then have that type, else the call is an error. Each call decides them
afresh. The checker checks the same statically.

## Empty results and truthiness

There is no `Unit` type or separate unit value. `[]` is the ordinary empty list
and the result of empty `()` / `{}` blocks, printing, mutation, and other
operations with no useful result. Blocks remain executable expressions.
The REPL displays an empty-list result as `[]`. Use `[]` for an explicitly
ignored argument. C interop uses `ffi.function parameters []` for `void`.

Falsy values are `False`, numeric zero (including complex zero), floating NaN,
empty strings, empty lists, empty records, empty HashMaps, and null pointers.
Everything else is truthy, including type constructors, non-nullary functions,
and every variant constructor (`None` and zero-ordinal enum cases included).
Mutable cells use their current contents, and a named subtype's value its base's
(`Flag = Bool` makes `(False : Flag)` falsy). Nullary actions run under the usual
demand rules. A list check inspects only its first cell, not its elements or
remaining tail; infinite nonempty lists are truthy.

`truthy x` (the prelude's `truthy = intrinsics.truthy`), `!x`, ternary
conditions, pattern guards, `assert`, `filter`, and standard-library predicate
consumers share these rules. `&&` and `||` return
Bool and short-circuit: `0 && missing` is false, `1 || missing` is true.
Truthiness does not change equality or Bool pattern matching: `0 != False`,
and `(x : Bool)` and `x : Bool` take only booleans.

Type variables preserve relationships: `typeOf (x, y -> x)` displays
`a -> b -> a`, `typeOf (f, x -> f x)` displays `(a -> b) -> a -> b`, and
`typeOf (x -> [x,x])` displays `a -> [a,a]`. Names are assigned afresh in
left-to-right order for each description. Function applications, lexical
captures, list patterns and generic constructor patterns propagate constraints;
clauses contribute to one signature. For example, `f (Some x) = x` with
`f None = 0` describes `Option Int -> Int`. A builtin function describes the
signature the checker gives it: `typeOf S` is `UInt -> UInt`, `typeOf print`
is `a -> IO []`. A `[]` written in a type is the empty list's type.

This remains bounded diagnostic inference, not Haskell's static type checker.
Unresolved native behavior, overloaded operators and recursive self-application
can leave unconstrained variables; these are not guarantees of parametric
polymorphism. No new runtime restrictions or type-based dispatch are introduced.

Default pre-execution checking and value-dependent types are documented in
[Gradual and dependent types](gradual-and-dependent-types.md). `Vect n t`
checks list length and element conversions; type aliases can accept ordinary
values. Files and REPL submissions check before execution; `Dynamic` marks runtime
boundaries. `--check` performs the same analysis without executing effects.

Exact exponentiation, integer square-root and GCD loops check the REPL interrupt
flag. Large integer/rational decimal formatting is split into checked steps.
Ctrl+C can cancel large powers such as `[1,2] ^ 100000000` and return to the
prompt. Cancellation is cooperative: a single host BigInt operation must finish
before its next check; it is not a hard real-time latency guarantee.
