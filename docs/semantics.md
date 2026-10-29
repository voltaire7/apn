# APN evaluation rules

APN uses call-by-need for deferred values, function arguments, list elements,
cons tails, and variant fields. Forcing reveals the outer value and memoizes it;
it does not recursively evaluate a whole collection. Explicit actions remain
repeatable, as described below. `tests/semantics-test.ts` asserts these rules.

## Syntax basics

### Layout and blocks

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
literal: `[0 :: []]` is `[[0]]`, while `[0: []]` is a record.

`::` always adds one element, the mirror of the cons pattern `x::xs`, which binds
one element. Like a list literal, the result may mix element types:
`[1,2]::[3,4]` is `[[1,2],3,4]` (as `[[1,2],3,4]` is), `1::["a"]` is `[1,"a"]`,
and `[1]::[[3,4]]` is `[[1],[3,4]]`. It never joins lists; that is `++`
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
  `[1 + 1, 2]`, `[Some 1, None]`, `[x: 1, y: 2]`. The items are a line's in one
  bracket, so `[[1,2],[3]]` but `[[1 + 1], [3]]`, and `[1, 2]` or `[1 + 1,2]` is
  an error. This covers list items and patterns, record fields, bare
  selections (`v.[x,y]`), ranges (`[1,3..9]`), `match` clause lists and import
  lists. Lambda parameters, which start a spaced lambda, always take one space:
  `x, y -> x + y`, `(Int x), y -> x`.
- A `,` separates two items on one line. A newline already separates items,
  so a `,` ending a line is an error, as is a trailing one (`[1,2,]`); a
  multi-line list or record puts one item per line without commas (or several
  per line, `1,2`, separated by commas).
- Application is juxtaposition with a space, also before a list, a group or a
  block: `Vector3 [1,2,3]`, `func (f x)` and `run { x }`, not `Vector3[1,2,3]`,
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
- A record field is `key: value`, not `key:value`: `[x: 1]`, not `[x:1]`;
  likewise keyed patterns and selections (`[x: a, y: b]`).
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
`print 5`, `print r.x`, `f -1`, `a + b * c`, `(f x) y` as `f x y`, and a lambda
that ends its expression takes the rest without them: `xs >>= x -> f x`. They
stay where they group differently, as in `(a + b) * c`, `f (g x)`, `(-2) ^ 2`,
`-(-x)` and `xs >>= (x -> f x) >>= g`, or where the bare spelling means
something else:

- a lambda passed as an argument, as in `withFile "notes" (file -> file.read)`:
  bare, `withFile "notes" file -> file.read` is a lambda with one typed
  parameter (as `f a e -> ...` is), which takes a type apart;
- `f = (x -> e)` binds a value, while `f = x -> e` is a clause of `f`;
- `[(x, y -> e)]`: in a list, the `,` would separate two items;
- `xs (i) = v` sets an item, while `xs i = v` defines `xs`;
- `obj.[(k)]` selects the computed key `k`, and `(r.1).2` is not `r.1.2`, which
  reads the number `1.2`.

A definition's parameters read as arguments do: each juxtaposed piece is one
parameter, so `f Int x = ...` takes the type `Int`, then `x` (called `f Int 3`,
as `to Int x` is). A constructor applied to patterns is therefore
parenthesized, `f (Some x) = ...`: a constructor pattern takes all its fields,
so `f Some x = ...` is a static error, as `Some -> 1` is. A cons is
parenthesized too: `len x :: xs = ...` is an error (write `len (x :: xs)`). A
lambda's parameter, an operator definition's operand and a binding's pattern
take a whole pattern, as an operand does: `Some x -> x`,
`(Money a) + Money b = ...`, `Some v = m`.

Lists print the same way: `print [1,2,[3]]` shows `[1,2,[3]]` and records show
`[x: 1, y: 2]`. A list prints its items once its `,` is decided: when an item
has a space, the list ends, or sixteen items are held, so an infinite one
streams after its first sixteen (whose spacing it then keeps). `apn --loose` (or the language server's `looseSpacing` option)
turns every spacing rule off, and lets a definition's `{` start on the next,
indented line (`func =` then `    {`, with the `}` aligned under the `{`).

### Functions and conditionals

`f x y = body` and `f = x, y -> body` both define curried functions, so
`add 2` is a partial application. A lambda's parameters are patterns
separated by `, ` (as in Idris); juxtaposition is one pattern, as inside a
definition's parentheses: `t x -> t` takes one argument and binds its type,
like `f (t x) = t`, and `f a e -> …` is the flat typed pattern `((f a) e)`, as
`(Vec n a xs)` is `((Vec n a) xs)`. This holds everywhere, `match` alternatives included.
Directly inside `[ ]`, a `,` separates the list's items, so a lambda with
several parameters there is parenthesized: `[(x, y -> x), f]`. A function may be written as several
equations, tried in source order:

```apn
len [] = 0
len (x::rest) = 1 + len rest
```

Literal patterns (integers, floats, strings, characters, `true`, `false`) are
tried before other clauses; numeric literal patterns compare numerically, so
`2` and `2.0` match each other. Integer ranges (`[1..9]`) are also patterns.
Otherwise clauses run in source order, so after a clause taking any argument
(distinct names or `_`, no guard) a clause of lists, cons, records or
constructor patterns never runs; one with an equivalent pattern replaces it
instead. When no equation matches, the
error names the function: `no clause of 'len'
matches the given arguments`. When what is known of the arguments already
rules out every clause (a literal, a constructor, a list's length: `pred 0`
for `pred (S k) = k`), it is a static error. Guards are not allowed on definition clauses;
use `match` with guarded pattern lambdas instead (see
[pattern functions](pattern-functions.md)).

There is no `if`/`then`/`else`; use the ternary `cond ? a : b`. Only the
selected branch runs, and the branches may differ in type (`x ? "yes" : false`;
see [choices](gradual-and-dependent-types.md), as for `match` and clauses).
The ternary's `:` is not cons (`::`), so a branch may
cons freely: `b ? x :: xs : []`. A ternary inside a ternary, in any of its
places, is parenthesized: `c ? (d ? 1 : 2) : 3`, `n < 0 ? -1 : (n > 0 ? 1 : 0)`;
`c ? d ? 1 : 2 : 3` and `c ? 1 : d ? 2 : 3` are errors.

Operator sections: `(+ 2)` is `x -> x + 2`, `(2 +)` is `x -> 2 + x`, and a lone
operator `(+)` is the function `+` is bound to, so `(+) a b` is `a + b` in every
way, its checking included (as `negate x` is `-x` and `not x` is `!x`). `-` works in the same positions:
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
Range expression bounds may now be runtime expressions: `[1..n]`, `[a,b..end]`,
`[start..]`. They must evaluate to real numbers. Existing automatic descending
steps are preserved, so `[1..0]` is `[1,0]`; std factorial handles zero separately.
A range pattern `[lo..hi]` matches any integer from `lo` to `hi` inclusive.

### Bindings and output

`name = value` is the only binding form; there is no `let`. A binding inside a
group is scoped to that group. Bindings are statements, not expressions, but a
group's value is its last statement's, and a binding's is the value it binds:
`print (x = 1)` prints 1, and `x` is unbound after it. A list item may be a
binding too (see [code](#code)). A value never changes once written, so when
something is computed never changes what it is. A name not visible here is
defined for its whole scope: code above may use it (functions may call each
other in any order), and its value may refer to itself (`ones = 1 :: ones`).
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
`xs i = v`), more clauses for a function, imports, loads and `use`; a
rebinding may have another type. The left side may be a pattern:
`[a,b] = [1,2]`, a cons pattern `x::xs = [1,2,3,4]` (or `x :: y :: rest`),
`Some x = optionValue` (parentheses optional, also for an imported
constructor), a literal (`1 = n` asserts that `n` is 1), or a keyed
record pattern `[x: a] = record`. A failed match is an error: before the
run when the value is known (`1 = 2`, `None = Some 1`), otherwise when the
binding runs. A bare `[x,y]`
pattern also matches a record, selecting the fields named `x` and `y` (extra
fields are ignored), in bindings, function parameters, and `match` alternatives. A new capitalized name on the
left defines a function that computes (with `=`, a type alias among them) or a
constructor (with `:=`); see
[templates and type aliases](templates-and-types.md#constructor-functions)
for those and variant declarations. `:=` with a scalar type (`Money := Float`,
`UserId := Int`) makes a distinct type (`=` only names the type: `Count = Int`
is `Int`). It is opaque: `Money 1.2` has none of a Float's operations, builtins
and `(Float x)` patterns reject it, its clauses give it what it needs
(`(Money a) + (Money b) = Money (a + b)`), and `(Money x)` takes it apart. See
[distinct types](type-and-resource-rules.md#distinct-types).

There are no type annotations or signatures: `:` only writes record entries
and a ternary's else; cons is `::`. State types with constructors, `x = Int 5` or `f (Int x) = ...`; see
[pattern functions](pattern-functions.md). A type pattern is also a binding,
so `Int x = 1` (or `x <- ...` with `Int x <- ...`) declares a typed name: the
value converts as an argument converts for `f (Int x)`, so `Float y = 1`
binds `1.0` and `Int z = 2.5` is a lossy-conversion error. A value the
checker knows (a negated or parenthesized literal, or a constant such as
`0 - 1` or `k * 3`) is converted statically, so `UInt n = -1` is a static
error, and so is a call such as `g -1` or `g (k * 3)` for `g (UInt n)`. Later
assignments keep the type (`x = "a"` is a type error). Built-in type names
cannot be redefined, so `Int x = ...` is always this binding; `Int = 5` and
`Int x y = 5` remain errors.

In file mode, bare expressions run for their effects but are not printed; use
`print`. The REPL echoes expression results but not assignments, so `x = x`
never hangs the prompt.

### Code

A list keeps its items as written, each in the scope it was written in: a list
is code, edited as any list is. `probe` shows a value as code (a list's items
as written, a string quoted), `print` shows its values, and `reduce xs` is the
values alone, a list that is no longer code, so `print xs` is
`probe (reduce xs)`:

```apn
probe [1 + 1, 2]            # [1 + 1, 2]
print [1 + 1, 2]            # [2,2]
```

A list item may be a binding, as a group's statement may: it binds for the
items after it and, as in a block, yields no value of its own (`print [x = 1,
x + 1]` prints `[2]`, and `do [x = 1, x + 1]` is 2). An `x <- m` item is a
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
probe code                  # [x = 1, x + 1]
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

A list function passes the items it keeps on as written, with their values
(`take 1 code ++ [x * 5]` prints `[50]`); only `++` and an update run items
again. One that makes new items (`map f xs`) makes values. Using an open
list's values (`print [x + 1]`) is an error naming the unbound name where it
is written; the static check reports it, except after code it cannot follow
(a list a function made, as `take` does), which is checked when it runs.
`toAST` gives code as lists and `toLambda` desugars it, as code (see
[code as data](standard-library.md#code-as-data--syntax)).

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
and prefix `!` are syntax, not operators: they cannot be defined or used as
sections, and `=` and `<-` have no expression precedence. Range `..` belongs
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
file that uses the operator; it applies to the whole file and to later REPL
input. An operator without one is `infixl 9`. `infix` operators do not chain:
`a == b == c` is fine (`==` is `infixl`), but two `infix` operators of the
same precedence side by side need parentheses.

Overloading an existing operator is fine and is the recommended way to give
your own types arithmetic or comparison. Clauses defined for an operator are
tried first; arguments no clause matches fall back to the operator's previous
meaning, so the builtin behavior stays available:

```apn
Money = | Money Int
(Money a) + (Money b) = Money (a + b)   # the inner + is the builtin one
Money 3 + Money 4                       # Money 7
1 + 2                                   # 3
```

The math functions (`sqrt`, `exp`, `log`, `sin`, `cos`, `tan`, `asin`, `acos`,
`atan`, `atan2`, `abs`, `floor`, `ceiling`, `truncate`, `round`, `min`, `max`)
overload the same way, so a type can give them meaning too:
`sin (Dual a b) = Dual (sin a) (b * cos a)` leaves `sin 0.5` as it was (the
`glsl` module writes GLSL this way). Clauses for any other function define it
afresh.

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

Entering `x` or `fibs` in the REPL streams elements until Ctrl+C. `print`,
`echo` and `emit` also stream lists, including nested ones. `echo x` prints `x`
as the REPL echoes it: strings and characters quoted (`echo "hi"` prints
`"hi"`, `print "hi"` prints `hi`), and colored on a terminal. File mode executes bare
expressions without echoing them; use `print x` to stream from a file.

`x = x` cannot produce even an outer value. Demanding it waits indefinitely
until interrupted, using bounded memory; Ctrl+C returns control to the REPL.
Failed or interrupted evaluations leave the interpreter usable.

The right operand of `::` must be a list. When a cons expression is evaluated,
a visibly non-list tail such as the literal in `x = x::1` raises an APN error
without evaluating its head. Computed tails are checked when demanded, preserving
`head (1::missing)`. Displaying a value nested inside itself also raises a clear
error; ordinary recursive list spines such as `x = 1::x` still stream.

## Record fields, string keys, and positions

Every record key is an ordinary string. Bare field names hide the quotes; quoted
field syntax includes literal quote characters in the key. Both may coexist:

```apn
obj = [field: 123, "field": 456, 1: 10, "1": 100]
```

| Access | Selects | Result above |
| --- | --- | --- |
| `obj.field` or `obj "field"` | Named field `field` | `123` |
| `obj."field"` or `obj "\"field\""` | String containing `"field"`, quotes included | `456` |
| `obj.1` or `obj "1"` | Numeric-named field `1` | `10` |
| `obj."1"` or `obj "\"1\""` | String containing `"1"`, quotes included | `100` |
| `obj 1` | Entry at position 1 | `["\"field\"",456]` |

A bare key in a record literal or keyed pattern may be several names, numbers
and `-`s on one line, up to its `:`, kept as written: `[my value: 123]` and
`[Content-Type: "json"]` have the keys `my value` and `Content-Type`, which are
not the quoted keys `"my value"` and `"Content-Type"`. Select them with a
string, `obj "Content-Type"` (after `.`, `obj.Content-Type` would subtract).

Application evaluates its argument: `key = "field"; obj key` selects a named
field. Include quote characters in the argument to select a quoted field.
`pairs`, iteration, and conversion to HashMap preserve the entire key string;
`pairs []` is `[]`, as `[]` is the empty record too.
`obj.(expression)` evaluates with the record fields in scope; use `obj key` for computed lookup. Missing keys
raise an error. Numeric field names retain their existing normalized spelling.
List indexing accepts integers or variants from families with only nullary constructors.
Variants select by zero-based declaration order. A string argument performs
[association-list lookup](templates-and-types.md#association-list-lookup):
`[["0",42]] "0"` returns `42`; it never coerces `"0"` to positional index zero.
Ordinary scalar lists such as `[10,20]` are not association lists and reject string lookup.
HashMap application likewise keeps numeric `0` and string `"0"` distinct keys.

Printing preserves key quotation. Field updates (`obj.field = value`,
`obj."field" = value`), record cloning, and plucks (`obj.[field,"field"]`)
preserve both identities. On an existing record, `obj "field" = value` updates
or adds the key string `field`, just like `obj.field = value`. Strings containing
quotes likewise update the corresponding quoted field. The key may be a string
literal, variable, or expression: `obj key = value` and `obj (prefix ++ key) = value`.
`obj "1" = value` updates numeric-named field `1`. An integer writes the entry
at that position as reading it gives it, a `[key,value]` pair: for `v = [x: 1,
y: 2]`, `v 0 = ["x1",22]` makes `[x1: 22, y: 2]` (a key another entry has is an
error, as is a new one on a record a schema made). Assignment evaluates the key
once before the RHS, replaces the selected slot with conversion checks for existing
numeric values, variants, and function contracts, and rebinds a scoped copy.
It does not invoke an ordinary function stored in the old slot. A new field is
inserted unchanged. On an unbound name or an existing function, `f "x" = value`
remains a string-pattern function clause.

A record a record schema made (`Quote [...]` or `Quote []` for
`Quote = [quote: String, year: Int]`, a `(Quote q)` parameter, a nested
schema's field) keeps the schema's fields: adding one, by `.`, a string key or
`_`, is an error (`[quote: String, year: Int] has no field 'yaer'`), before
the run when the checker knows the record, otherwise when the assignment runs.
An update's copy keeps the type; a literal copy (`[_: q, extra: 1]`) is an
ordinary record, open to new fields.

A record applied to a record of fields is the same update: `r [f: v, g: w]`
is `{ r.f = v; r.g = w; r }` in every way, as Elm's `{ r | f = v, g = w }`,
for a record of values and for a type given types (`Vector3 [x: Int]` is
`Vector3.x = Int`). A type given values builds one instead (`Vector3 [x: 1]`;
see [templates](templates-and-types.md)).

An empty list `[]` becomes a record on its first field assignment.
`obj.[x] = [10]` requires a one-element RHS list; `obj.[x] = 10` errors.
`obj.child.x = 10` and `obj.child.[x,y] = [10,20]` rebuild nested parent records.
See the [access and assignment reference](templates-and-types.md#access-and-assignment-reference)
for forms, conversion rules, scoping, and failure behavior.

Destructuring `[field: a, "field": b]` selects each
key explicitly; the bare pattern `[field]` selects only the named field.
Renamed plucks such as `obj.["field": value]` create named destination fields.

`pairs`, positional record access, record iteration, and conversion to `HashMap`
preserve the full key string, including quote characters. The keys `x` and `"x"`
therefore remain distinct in those views and conversions.

## Definitions and actions

Ordinary named definitions do not execute their bodies when defined.
`foo = _` declares an unfinished value; `f x = _` an unfinished function body.
The `_` expression raises "not implemented" only when evaluated. It remains a
wildcard in patterns. Both sides of `=` are required: `foo =`, `foo = ;`, and
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
pattern rebinds that clause in place (`f (Int x) = 1` then `f (Int y) = 2`
rebinds; parameter names do not matter, and `_` is a name nothing uses).
`f = Int x -> ...` is the curried spelling of `f (Int x) = ...`: the same
clause, so `f = Float x -> ...` after it overloads `f` exactly as a second
clause would. A lambda whose parameter has the definition's own name
(`x = x -> x`) stays a lambda, since as a clause that parameter would mean
equality with `x`.

## IO actions

APN code is pure; effects are **IO actions**, ordinary values describing what
to do. `print "hi"` builds the action that prints `hi`; nothing is printed
until the action runs. The effectful builtins all return actions: `print`,
`echo`, `emit` and `repl` (yielding `[]`), `readFile`, `readStdin`, `getArgs`, `fetch`, `exit`,
`set` (writing a `Mutable` cell), `bracket`, `withFile` and
`ffi.withLibrary`. An action prints as its type, since only running it shows its result:
`print (print 1)` prints `IO []`, an annotated `IO Int { ... }` prints `IO Int`,
and an action whose result is not known before it runs prints `IO a`.
`typeOf` gives the same type.

Actions run in exactly two places:

- **Statements.** A file's top-level statements, and each REPL input, form an
  implicit do-block: a statement whose value is an action runs it, in order.
  `a = print 3; a; a` prints twice; `a` alone names the action.
- **`<-` bindings.** `x <- action` runs the action now and binds its result:
  `text <- readFile "input.txt"`. The right side must be an action: `x <- 2 + 3`
  is an error (bind a value with `=`). The one exception is `load`, which runs
  a file: `module <- load "file"` binds its exports.

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
Applying such a type to a value checks it as `Int 5` converts: the value must
be an action, and its result is converted to the type when it runs, so
`sayHello = IO [] { print "hello" }` is an action and `IO Int (print 1)`
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
holds, as Haskell's). Two statements are dropped instead: `[]`, the unit (what
`print` yields; inside a list do-block it is chained), and one opening a
module. What the check cannot decide (a parameter's result) is checked when
the statement runs. A do-block's last statement must itself be an action,
whose result the block yields: end with `return x` to yield a plain value. A
block of bindings stays an ordinary value:

```apn
area w h = {
    print "computing area"    # an action, discarded: area returns an action
    return (w * h)            # a plain w * h here is an error
}
size <- area 3 4              # prints, then binds 12
double n = assert (n > 0) (n * 2)      # a plain function: double 3 is 6
answer = Int { 42 }           # an Int
action = IO Int { return 42 } # an action yielding an Int
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

`map`, `<*>`, `>>=` and `return` work in any monad. IO and lists are built
in; any other type joins by **instances**: definitions of these methods,
written like ordinary overloads, with parameters or curried (`map = mapTree`,
`return = Some`). An instance adds to the method everywhere (prelude helpers,
do-blocks and other modules see it) instead of shadowing it, and the newest
instance whose clauses accept the arguments runs. `lib/option.apn` holds Option's and Result's:

```apn
map f (Some x) = Some (f x)
map _ None = None
(Some x) >>= f = f x
None >>= _ = None
return = Some                      # return in Option
```

`to` and `from` are methods the same way: `to T x` writes `x` as a `T`
(`to String`, `to JSON`, `to (List Char)`; another type, a record type too,
converts as applying it: `to Quote x` is `Quote x`),
`from T x` reads one back. A bare type name in a pattern matches that type
itself (`describe Int = "integer"`), so an instance names its type:
`to Celsius (F f) = C ((f - 32) * 5 / 9)`. A `to String` instance is also how
its values show: `print`, `echo`, the REPL and `to String` of a value holding
one write its text, wherever it is (with `to String (Frac n d) = ...`,
`[Frac 1 2]` shows `[1/2]`). See the [standard library](standard-library.md).

`return` is overloaded on its result type (see "Overloading on the result
type" below): a context that names Option uses the newest `return` whose
result is an Option, so `return = Some` and `return x = MkCounter (s -> [x,s])`
each define it for their own type.

`map` and `<*>` follow from `>>=` and `return` when a type defines no
instance of its own. A type used where no instance accepts it is an error
(`no map instance for Tree`).

`return x` is a value in a monad not decided yet (its type is `m T`). It
takes the monad of the first context that names one:

- an annotation: `Option Int { return 42 }` is `Some 42`, `List Int { return 43 }`
  is `[43]`, `IO Int { return 44 }` an action yielding 44;
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
each other; ones with the same result type rebind, as usual. A call that
reaches such clauses is undecided until a context names the type its result
should have: a type applied to it (`Int (f 0)`), a typed pattern it is passed
to (`g (Int n)`), an annotation, or a monad context.

```apn
blank _ = 0
blank _ = ""
Int (blank [])               # 0
String (blank [])            # ""
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
pairs = List Int {
    a <- [1,2]
    b <- [10,20]
    return (a + b)       # [11,21,12,22]
}
evens = {
    x <- [1..6]
    guard (x % 2 == 0)   # [] (a throw in a list) when odd: that x yields nothing
    return x             # [2,4,6]
}
check n = {
    unless (n > 0) (Err "not positive")   # a specific error
    return (n * 2)       # check 2 is Ok 4, check 0 is Err "not positive"
}
half n = Result Int String {
    guard (n % 2 == 0)   # a false guard throws its condition
    return (n / 2)       # half 4 is Ok 2, half 3 is Err "guard failed: n % 2 == 0"
}
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
through `debug` (which prints the source it is given) and FFI calls, the two
deliberate escape hatches.

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
  the old list. Dotted `templates.[values]` applies list templates instead.
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

`tag owner ctor fields` makes a value that remembers the constructor that made
it, the type it belongs to and its fields, and does nothing else (the core
that constructors are to become sugar over); patterns of the constructor read
the fields back:

```apn
Box a = tag Box Box [a]
Box 5                           # Box 5; typeOf (Box 5) is Box
unbox (Box x) = x               # unbox (Box 5) is 5
tag Option Some [5] == Some 5   # true: a declared constructor's own value
```

A type in a pattern takes its parameters, then a value. Applied to exactly its
parameters it matches a type value, each name binding the part in its place:
`(Option t)` given `Option Int` binds `t` to `Int`, `(Vect n a)` given `Vect 3
Float` binds 3 and `Float`. One more pattern is a value of that type, the typed
pattern `((Option t) x)`, whose names the value binds: `(Option t x)` given
`Some "a"` binds `t` to `String` and `x` to the whole variant, and `(List _ xs)`
takes any list. `(List Int xs)` and `(Option Int x)` decide by the type the
checker gave the value, never by what its elements hold, so a run takes the
clause the checker chose: `["a"]`, `map show xs` and `Some "a"` do not match,
while `[1,2.5]` and `[1..]` do, their elements converted as they are used (2.5
fails only when used). A run infers these types even when it reports no type
errors, so the choice never depends on checking; code no check reaches
(`Dynamic`) has none, and there the pattern takes any list or that variant.
Any other count is a static error (`(Pair x)` for `Pair a b`).
A type without parameters takes its value at once (`(Int x)`, `(Color c)`), and
a constructor sharing its type's name (`Box a = | Box a`) is the constructor.

Destructuring definitions immediately perform the pattern match, but bound
variables remain deferred. Blocks create child scopes. Environments are
lexical, and a rebinding never changes what was written before it (see
[bindings](#bindings-and-output)). Only the selected ternary branch runs.

Record literals retain their existing field-expression evaluation behavior;
records do not become uniformly lazy. Rendering resolves ordinary data fields
but shows zero-argument definition fields as functions, so inspecting a module
does not evaluate its `halt` action.

## Inspection and numbers

`probe` shows a value as code (see [code](#code)). `debug`
forces its argument without running a returned action: `a = print 3; debug a`
prints `a`. `step n v` goes `n` levels into `v`'s unevaluated structure and
gives that level as a live value: `debug` shows its source, and `<-` runs it
when it is an action (`inner = { print 1; return 2 }`: `debug $ step 2 inner`
shows `return 2`).
`to String` demands its argument and collects its full rendering into a string.
Values render as source writes them: strings and characters escaped
(`"a\"b"`), a constructor argument that is itself
compound is parenthesized (`Some (Some 1)`, but `Distance -2`), operators show
as sections (`(+)`, `(+ 1)`, and `(1 +)` for `(+)` applied to 1). A function
with several clauses shows each as a pattern lambda on its own line:
`f (Int x) = 1; f (Float x) = 2` prints `Int x -> 1` and `Float x -> 2`
(with several parameters, constructor patterns keep their parentheses:
`(Int x), y -> 1`).

A partly applied function shows what is left of it: the clauses its arguments
match, as a call would choose them, without the matched parameters and with
the names they bound shown as the arguments. With `g (Int x) y = x + y` and
`g (Float x) y = 0`, `g 1` prints `y -> 1 + y`; `(a, b -> a + b) 1` prints
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
errors, as `arr = [Int 0]; arr 0 = .2` does. `arr -1 = 10` updates its final element, as `arr -1` reads it (`arr - 1 = 10`
defines `-`); likewise `f -1 = ...` is a clause of `f` for the argument `-1`.
A single index must evaluate to an integer or a variant from a nullary-only family
(using zero-based declaration order); a finite list of these indices selects multiple
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
`k = 1`) for `g (UInt n)` is a static error; so is `h 2` for `h x = g -x`,
where the value is known only at the call. A typed parameter (a numeric type, a schema, a contract) given a
value that depends on an enclosing function's parameter is checked at that
function's calls, by value, as a direct call would be: with
`Pt = [x: Float, y: Float]` and `g (Pt p)`, `h x = g x` accepts `h [1,2]` as
`g [1,2]` does, and `h x = g [x,-x]` rejects `h 2` for `[x: UInt, y: UInt]`
but accepts `h 0`. For numbers: `h -2` passes `2` to `g`, and `h x = g x` accepts `h 2` and rejects
`h -2` and `h "a"`. Such calls are checked even if `h` is never called: a
call of `h` inside another, uncalled function (`d y = h 2`) is checked with
its value, and `h`'s own definition is checked by type, so a parameter `h`
also uses as a String cannot reach `g (UInt n)`. The error points at the call
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
constructors are `Int8`, `Int16`, `Int32`, `Int64`, `Int128` and matching `UInt`
variants. `Float` is flexible floating precision, using binary64 by default.
`Float32` and `Float64` commit to binary32 and binary64 respectively.
`Fraction` holds an exact rational, `Complex` any numeric complex value, and
`ComplexExact` an exact one. Constructors are first-class functions, e.g.
`map Int [1,2]`. Constructed values print their type: `Int32 123`.

`UInt` is the natural numbers, with built-in constructors `Z` (`UInt 0`) and
`S` (`S n` is `n + 1`, converting `n` as `UInt n` does). The patterns `Z` and
`S k` take a number apart: `Z` matches 0, and `S k` matches any number from 1
up, binding `k` to one less, as a `UInt`. Like a `(UInt n)` pattern, they accept
a plain integer that converts; a negative one matches neither (a static error
for a literal).

```apn
factorial Z = 1
factorial (S k) = (k + 1) * factorial k
factorial 20                     # UInt 2432902008176640000
S (S Z)                          # UInt 2
```

`S k` destructures, it does not unwrap: `k` is the predecessor, itself a `UInt`,
while `(UInt k)` binds the untyped payload like any numeric constructor pattern.
A bare `Z` in a pattern takes no fields (`plus Z m = m`). A program that declares
its own constructor named `Z` or `S` gets it in that scope, matched as a variant;
a number never matches a variant pattern.

Explicit `Float`, `Float32`, and `Float64` construction rounds to the target
floating-point precision, for bare or annotated inputs. `Float32 .1` produces
`Float32 0.1` (the nearest binary32 value, displayed with the shortest
round-tripping decimal); `Float (Int 9007199254740993)` rounds to
`9007199254740992.0`. This also applies through aliases and `cast`.

Integer constructors remain lossless: `Int .2` and `Int (Float .2)` both error.
Choose integer rounding explicitly: `Int (floor .2)` is `0`, while
`Int (truncate -1.7)` is `-1`. Fixed-width integer overflow and nonzero
imaginary-part loss remain errors. Typed parameter matching, function contracts,
and assignment to existing numeric slots remain lossless. Floating arithmetic
adapts flexible Float operands as described below.
Numeric equality ignores
annotations: `.2 == Float .2` remains true. Int and Float values display without
a prefix; specialized types such as Int32, Float32 and Float64 retain theirs.

`cast` remains a compatibility helper in the APN prelude and `type`:

```apn
cast (Type target) value = target value
```

It has the same behavior as applying the type directly: floating constructors
round to their precision, while integer construction still rejects truncation.

### Flexible and fixed floating precision

A decimal literal such as `.2` behaves like `Float .2`. Both are flexible values,
including after binding to a variable, passing through a function, or storing in a
collection. Two flexible operands use binary64. A flexible operand paired with
Float32 or Float64 rounds to that fixed precision before arithmetic; the result
keeps the fixed type. Operand order does not matter and the original values are
not mutated. This is runtime precision selection, not backwards type inference.

```apn
.1 + .2                       # 0.30000000000000004
Float32 .1 + .2               # Float32 0.3
Float .2 + Float32 .1         # Float32 0.3
x = .2
Float32 .1 + x                # Float32 0.3
# Float32 .1 + Float64 .2     # error: explicit cast required
Float32 .1 + cast Float32 (Float64 .2) # Float32 0.3
```

Different fixed precisions require a cast even if a particular conversion would
be lossless. The rule covers `+`, `-`, `*`, `/`, `%`, `^`, `expt`, and elementwise
array arithmetic. Comparisons still compare numeric values without adopting an
operand's precision. Flexible values are stored in binary64; this does not give
exact decimal arithmetic or recover precision lost in an earlier computation.
`Float` construction explicitly returns a value to flexible precision.

Other numeric combinations retain their existing lossless promotion rules:
same-type operations preserve the type and check integer overflow; otherwise
arithmetic tries an existing suitable operand type before using the numeric tower.
Exact-to-inexact conversion must still be lossless. Integer `/` can produce a
typed `Fraction`. Float32 arithmetic rounds its result to binary32. Other numeric
native functions return their natural numeric result types; use a constructor to
impose a specific width on them.

`typeOf value` returns a type descriptor. `isType Type value` tests membership
without casting. `Number`, `Real`, `Integer`, `Exact`, and `Inexact` are aggregate
numeric guards. For example `isType Number (Int32 1)` is true.

Typed overloads use constructor patterns:

```apn
add (Int x) (Int y) = Int (x + y)
add (Float x) (Float y) = Float (x + y)
add (Number x) (Number y) = x + y
```

Literal matches outrank exact concrete type matches, which outrank aggregate
matches, which outrank conversion matches. Ties retain source order. Converting
either a typed or an untyped input must be lossless; explicit floating-point
construction is a separate operation and does not relax pattern matching. This ranking applies to functions with typed clauses;
ordinary pattern functions keep source order. Numeric constructor patterns extract
untyped payloads: `unwrap (Int32 x) = x` returns `5` for `Int32 5`. Return an explicit
constructor, as above, when the result should retain a type. Patterns do not mutate
the original argument or strip types from unrelated values.
Repeated variable names assert equality, so `(Number x) (Number x)` is not a
catch-all for two different numbers.

`100 * _ -> Int 0` repeats the typed value using the existing function iteration
overload. Two numeric operands always multiply: `100 * Int 0` returns `0`
and `Int 3 * Int 2` returns `6`, both still typed Int.

## HashMap

`HashMap [["x",123]]` constructs from an association list; `HashMap [x: 123]`
constructs from a record. Empty construction is `HashMap []`. Keys may be finite
numbers, strings, chars, or booleans. Numerically equal keys share an entry
regardless of exactness or numeric type; distinct strings/chars stay distinct.
Duplicate keys keep the last value. Insertion order is preserved for traversal,
and replacing an existing key keeps its position.

`insert [x: 123] $ HashMap []` returns a map containing x. `insert` accepts a
record or association list; `remove key map` returns a map without the key.
Updates preserve the old map. `lookup key map` or `map key` retrieves a value,
raising an error when absent; use `has key map` when absence is expected.
`keys`, `values`, `pairs`, `length`, and `null` operate on maps. Association-list
values stay lazy; keys are evaluated at construction. Record inputs follow the
existing record evaluation rules. `(HashMap m)` is a type pattern.

Type constructors also work directly with function iteration: `100 * Int`
returns typed integers `0` through `99`; `[1..100] * Int` returns `1` through
`100`. This differs from `100 * Int 0`, which multiplies and returns typed zero.

The nonnumeric types returned by `typeOf` are also first-class constructors:
`Bool`, `String`, `Char`, `List`, `Record`, `Function`, `Type`, and
`Variant`. Except for `Bool`, they validate and return a value of the corresponding
kind without forcing list elements or coercing unrelated values. `Bool` converts
using truthiness. Their constructor patterns
work in overloads, e.g. `f (Bool x) = x`. `isType` and identity `cast` support
these types too. Use declared constructors to create a particular variant;
`Variant` validates any such value.

A lowercase pair pattern `(t x)` captures the runtime type descriptor in `t`
and the numeric payload without its explicit type annotation in `x`. Nonnumeric
values are returned unchanged. For example, `myTypeOf (t _) = print t` still prints
`Int32` for `Int32 5`, while `payload (_ x) = x` returns `5`: `_` discards the
type, as it discards a value.
It inspects the outer value without forcing list contents. Repeating the type
variable, as in `(t x) (t y)`, requires both arguments to have the same type.

## Module imports

`import "name"` evaluates a module once per interpreter; its value is the
module, a record of its exports. Like `=`, it also binds, as a statement: a
statement whose value is a module opens the module's exports into the block
it is in (`{}`, `()` and `do []` alike), however it gets the module: the
import itself, a name for it, a function returning it, or an action yielding
it.

```
system = import "system"   # binds system; opens nothing
system.halt                # a field of the module: opens nothing
system                     # opens halt into this block
f _ = { print "f"; return system }
f []                       # prints f, then opens halt
```

Anywhere else a module is a value and opens nothing: a binding
(`m = f []`), an argument, or a field read. A module is not an action, so a
do-block yielding one ends with `return`. The check records which statements
yield a module, so one kept unevaluated (`return (import "system")`) is
evaluated to open it. A `load` opens the file's definitions by the same rule.
A plain record is not a module: only `use` opens one.
The name is looked up next to the importing file (the
current directory in the REPL) as `name.apn`, then as a `name/` folder, whose
`.apn` files (not subfolders: `import "name/sub"`) form one module; a file wins
over a folder of the same name. Failing that, each parent folder is searched
the same way up to the program's folder (the nearest match wins). Otherwise it
is a standard module such as
`function`, `option`, `sequence`, `number`, `text` or `map`. Standard modules
take no prefix; `import "std"` and `import "std/text"` are errors. Module
evaluation uses an isolated scope with builtins and explicit dependencies;
caller bindings do not affect it. Reimporting opens the cached exports
again. A definition such as `s = import "sequence"` defers importing until
demanded.
`load` remains uncached file execution relative to the current source file.
`numbers = load "number"` is repeatable like a zero-argument definition, so each use
of `numbers` loads the file again. A load the static check follows (a literal
path outside `Dynamic`) rebinds the file's definitions as a definition
would, even names the program rebound in between. A `Dynamic` load may
replace only what the same file (with unchanged text) published, plus what
its usual write checks allow.
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
conversion holds that type's values, so `Mutable (List [Int,Int] [])`, or a
record schema's value (`Mutable (Body [...])`), holds lists of any length where
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
`>>=`, `<*>`, `to`, `from`) displays like an overloaded function: its builtin's name (the IO
and list instances), then each instance's clauses, one per line. After
`import "option"`, `print return` shows `return`, `Some` and `Ok`.

## Pattern functions

`match` is an intrinsic function over a lazy list of unary functions; pattern lambdas
and runtime function contracts are described in [pattern functions](pattern-functions.md).
Only pattern mismatch or a false guard selects the next alternative; runtime
errors propagate and unused alternatives remain unevaluated. Guards use truthiness.

## CLI file errors

If the input file cannot be opened, APN exits with status 1 and prints a concise
message to stderr, for example `error: cannot read "missing.apn": file not found`.
Directories and permission failures receive similarly short messages, without
Deno stack traces. The CLI uses the supplied path literally.

## Tail calls and recursive loading

Fully applied APN functions reuse an execution loop for calls in tail position,
including selected ternary branches, the final expression of a block, and pipes.
Arguments remain lazy: an unused argument is not evaluated by this optimization.
Calls with work remaining (such as `1 + recurse n`) still consume stack, and a
large deferred accumulator can still overflow when finally forced. Use `<-` to
compute an accumulator on each iteration when appropriate.

A loaded file may finish with `load "itself"`, directly or through a tail-called
function/action. This repeats without growing the host call stack; Ctrl+C stops
it and restores the REPL's scope and source directory. Each load still reads
and executes the file, resolves paths relative to that file, and merges its
exports when it returns. Pending module scopes/merges are retained on the heap,
so recursive loading is stack-safe but not constant-memory. Ordinary tail calls
have no pending module merges. `load` before another statement returns normally
before that statement executes; circular loads are not rejected.

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

Type descriptors remain constructors in every ordinary value context. Applying a
record template initializes omitted type slots; `Vector3 []` constructs defaults.
Assigning a value into a type slot makes it that type's default
([slot assignment](templates-and-types.md#slot-assignment)). See [zero initialization](zero-initialization.md)
for the default table, type inspection, variant rules and limitations.

## String formatting

`format template arguments` requires an argument list. Each `%` consumes one
argument; `%%` prints a literal percent without consuming one. Missing or extra
arguments raise an error before any argument is rendered. For example,
`print $ format "vec = %" [vec]` prints one formatted record. Passing `vec`
directly instead of `[vec]` is invalid when `vec` is a record.

Negative dot keys remain literal: `obj.-1` means `obj "-1"`.
Parenthesized keys remain literal inside record literals, plucks, and record
patterns: `[(x): 2]`, `obj.[(x)]`, and `obj.[(x)] = [3]`. Use `obj "(x)"`
for direct lookup. Parentheses immediately after a record dot now evaluate an
expression in the record's scope; they no longer quote a field name.

`enumerate xs` returns a lazy list of `[index,value]` pairs. Indices are exact
integers starting at zero, so `enumerate [10,20]` is `[[0,10],[1,20]]`. It supports
infinite lists, and enumerating an element does not force its value.

## Record-scoped expressions

`record.(expression)` and `record.{ statements }` evaluate in a local scope populated by the
record's fields. Fields shadow outer names; other names resolve in the surrounding
lexical scope, including functions such as `sqrt`.

```apn
point = [x: 3, y: 4]
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
patterns (`f { Int x }` or `f (Int x)`), and grouped function contracts.
Definitions and ordinary field/index updates inside the expression are local;
they do not implicitly update the original record. Returned functions and deferred
values retain this local scope. Explicit side effects, including `Mutable` updates
or writes through an environment view, keep their normal behavior.

Only keys that are valid binding identifiers are exposed as local names. Quoted,
numeric, and parenthesized key spellings are not converted to identifiers. Fields
are installed without demanding their values or invoking stored actions. Existing
record-construction evaluation rules still apply.

`record.(expression) = value` is not an assignment target. To update a literal
field named `(x)`, use `record "(x)" = value` or `record.[(x)] = [value]`.
List operands retain dotted template application: `[Int,Float].([1] ++ [2])`
returns `[1,2.0]`, evaluating the input expression in the surrounding scope.

## Type descriptions

`typeOf [1,2,3]` displays `List Int`, a list of any length (`[Int]` is the
positional type of exactly one Int); heterogeneous literal lists display their
known alternatives, for example `List (Int | String)`. A list built with `::` is
described the same way (`typeOf ([1,2]::[3,4])` is `List (List Int | Int)`, as
for `[[1,2],3,4]`), reading its unevaluated tail without running it. Empty lists
and unresolved lazy computations display `List a`. Integer ranges display
`List Int`, including infinite ranges, without traversing them. Type errors
use the same notation.

Functions display argument/result descriptions: `f (Int x) = x` gives
`Int -> Int`; `x -> print x` gives `a -> []`. Clauses contribute to one
combined description, with alternatives where their known types differ.
Explicit function contracts still return their declared arrow type.
Uncontracted descriptions are conservative diagnostics, not static inference
or enforced contracts. `a`, `b`, and so on name unresolved type variables; overloaded arithmetic, recursion,
and computed lazy elements can leave unknown parts. Describing a callable never probes its body with sample arguments or forces
list elements. Inspecting an argument expression
still evaluates it enough to obtain its outer value. Existing nullary action semantics remain: demanding a nullary action runs it,
so `typeOf` describes its result.

A described type compares equal to the type it describes: `List Int == typeOf
[1,2]` and `(a -> a) == typeOf (x -> x)` are true. Compared with a bare
constructor it keeps its broad identity: `typeOf [1] == List` and
`typeOf f == Function` are true. A description is not an enforced schema; use a
typed pattern or contract when you need validation.

## Function types

Where a type is expected, a lambda is read as the function type it spells out,
as `[Int]` is both a list and a positional type: in a typed pattern
(`((a -> a) f)`), a constructor field (`MkCounter (s -> [a,s])`), dotted
application (`(a -> a).(+ 1)`), `isType`'s first argument, and beside a type in
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

Falsy values are `false`, numeric zero (including complex zero), floating NaN,
empty strings, empty lists, empty records, empty HashMaps, and null pointers.
Everything else is truthy, including type constructors, non-nullary functions,
and every variant constructor (`None` and zero-ordinal enum cases included).
Mutable cells use their current contents. Nullary actions run under the usual
demand rules. A list check inspects only its first cell, not its elements or
remaining tail; infinite nonempty lists are truthy.

`Bool x`, `!x`, ternary conditions, pattern guards, `assert`, `filter`, and
standard-library predicate consumers share these rules. `&&` and `||` return
Bool and short-circuit: `0 && missing` is false, `1 || missing` is true.
Truthiness does not change equality or Bool pattern matching: `0 != false`,
and `(Bool x)` still matches booleans rather than every convertible value.

Type variables preserve relationships: `typeOf (x, y -> x)` displays
`a -> b -> a`, `typeOf (f, x -> f x)` displays `(a -> b) -> a -> b`, and
`typeOf (x -> [x,x])` displays `a -> List a`. Names are assigned afresh in
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
