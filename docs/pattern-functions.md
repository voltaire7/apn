# Pattern functions and function contracts

Pattern matching belongs to function parameters. A pattern lambda applies just
like any other function:

```apn
import "option"
(Some x -> print x) (Some 123)  # prints 123
(None -> print "no") None      # prints no
```

Applying `(None -> print x)` to `Some 123` fails with a no-clause error. Its body
is not run, so `x` is never looked up. `_` in a body still means unfinished code;
use `[]` when a matched branch should do nothing.

`match` is an intrinsic function, available by default. It tries a lazy list of unary functions in order:

```apn
handlers = [
    Some y -> print y
    None -> []
]
func x = match x handlers
func (Some 123)
```

Inline lists work identically. Lists can be constructed, passed, and reused;
`match` itself can be passed or rebound. As with other function applications,
parenthesize computed arguments: `match (head xs) handlers`.

Literals, lists, constructors, type patterns, and wildcards can be lambda
parameters. A guard follows the parameters, e.g. `n | n > 0 -> n`. A falsy guard
is a mismatch; guards use the same truthiness rules as conditions. Multiple parameter lambdas are curried,
but match alternatives must have exactly one remaining argument.

## Lists and records as arguments

A list or record supplies **one argument**, regardless of its size. Collections
are not automatically spread across parameters. Functions with multiple
parameters are curried:

```apn
identity value = value
add x y = x + y
first x y = x
[identity [1,2],identity [x: 1, y: 2],add 1 2,first [1,2] 99]
# [[1, 2], [x: 1, y: 2], 3, [1, 2]]
```

`add [1,2]` supplies only `x` and returns a function awaiting `y`. It does not
mean `add 1 2`. A collection variable works the same way as a literal.

### Destructuring one argument

| Parameter pattern | List argument | Record argument |
| --- | --- | --- |
| `value` | Binds the entire list | Binds the entire record |
| `[x,y]` | Binds exactly two elements by position | Binds fields named `x` and `y` |
| `[x: a, y: b]` | Does not match | Binds fields `x` and `y` as `a` and `b` |
| `(x:xs)` | Binds the head and tail of a nonempty list | Does not match |

```apn
sumPair [x,y] = x + y
[sumPair [1,2],sumPair [y: 2, x: 1, extra: 99]]
# [3, 3]
```

List patterns require the exact length. Their elements may be type
patterns, which convert as a whole-argument type pattern does:
`pair [UInt8 a,UInt8 b] = a + b` accepts `pair [3,3]` (and
`[UInt8 a,UInt8 b] = [3,3]` as a binding), while `pair [3,300]` is a static
range error; `firstFloat ((Float x):rest) = x` returns `1.0` for `[1,2]`.
Variant payloads convert the same way: `g (Some (Float x)) = x` returns `1.0`
for `g (Some 1)`, and `g (Some 300)` is a static range error for
`g (Some (UInt8 x))`, also through a variable (`k = Some 300`) or another
function (`h x = g (Some x)` rejects `h 300`). This holds for every field of
a constructor with several: with `P = P2 Int Int | P0`, `g (P2 a (UInt8 y))`
accepts `g (P2 1 3)` and rejects `g (P2 1 300)`, and with
`Pair a b = MkPair a b | NoPair`, `g (MkPair (Float x) (UInt8 y))` rejects
`g (MkPair 1 300)`. Record literals are checked by field the same way: for
`g ([x: UInt8] r)`, `g [x: 300]` is a static range error, as are
`k = [x: 300]; g k`, `h r = g r; h [x: 300]` and `h v = g [x: v * 100]; h 3`,
while `h 1` passes. A spread (`_: other`) contributes its fields in order, as
at runtime, so `g [x: 300, _: [x: 3]]` passes (the spread's `x` wins) and
`g [x: 3, _: [x: 300]]` is rejected; with `h b = g [_: b, x: 3]`, a field of
`b` is checked at each call of `h`.

For records, the bare-name pattern
`[x,y]` requires those fields, ignores field order, and permits extra fields.
This record interpretation only applies when every element of the pattern is a
variable name. Renaming those variables also changes which fields it selects.
Use a keyed pattern when local variable names should differ from field names:

```apn
sumFields [x: a, y: b] = a + b
sumFields [y: 2, x: 1]       # 3
```

Missing fields or a wrong list length cause pattern mismatch; another clause
may handle the input. If no clause matches, the call errors. These patterns
also work in lambdas, such as `([x,y] -> x + y) [1,2]`.

### Records as named arguments

A record argument supplies named inputs without separate named-call syntax:

```apn
area [width,height] = width * height
area [height: 20, width: 10] # 200
```

This function also accepts `area [10,20]`. To require a record, write
`area [width: w, height: h] = w * h`. Required fields must be present;
destructuring does not itself supply defaults for omitted names.

### Record-template parameters

A template pattern converts an argument before binding its local name:

```apn
Vector3 = [x: Float, y: Float, z: Float]
lengthSquared (Vector3 v) = v.x ^ 2 + v.y ^ 2 + v.z ^ 2
lengthSquared [1,2,3]      # 14.0
```

The positional list must have exactly as many elements as the record template.
The pattern binds the converted record to `v`; its fields use the template's
conversion rules. See [templates and type aliases](templates-and-types.md#type-descriptions-and-aliases).

### Returning local updates

Updating a collection parameter rebinds a local copy. Return that copy to keep
the result; the caller's ordinary record is unchanged:

```apn
change obj = {
    obj.child.x = 10
    obj
}
original = [child: [x: 1]]
changed = change original
[original.child.x,changed.child.x] # [1, 10]
```

List index updates work the same way. Shared references such as `Mutable` and
live environment views are exceptions to ordinary copy-and-rebind behavior.
See [slot assignment](templates-and-types.md#slot-assignment).

### Evaluation

Arguments are deferred until needed. A plain variable or wildcard parameter
does not inspect the collection; a destructuring pattern demands the shape it
needs. List elements remain deferred when bound to variables:

```apn
firstPair [x,y] = x
firstPair [42,missing]      # 42; the unused second element is not evaluated
```

An exact-length list pattern checks the spine length; a cons pattern only needs
a nonempty list and can accept an infinite one. Record literals retain their
existing field-expression evaluation rules: passing a record does not make all
its fields uniformly lazy. See [evaluation semantics](semantics.md#patterns-variants-and-scope).

## Dispatch behavior

Patterns and guards demand only what they inspect. A mismatch never evaluates
its body. Once a candidate matches, its result is returned without inspecting
later alternatives. `_ -> ...` and `x -> ...` remain ordinary unary functions
and can serve as catch-all alternatives.

An error while inspecting a pattern, evaluating a guard, or executing a selected
body propagates; it does not select another branch. Empty/exhausted alternatives
raise a non-exhaustive-match error. The dispatcher traverses alternatives
iteratively, including lazily generated lists.

There is no trailing fallback argument or public attempt-result wrapper.
Applying a successful result to another argument retains ordinary application
semantics. This matches values, not the source syntax of an unevaluated
application such as `1 2`.

## Typing a function through its definition

Constrain inputs with patterns and results with ordinary constructor application:

```apn
func = (Int x) -> Int { x + x }
twice (Int x) = Int { x + x }

func 21                       # 42
twice 21                      # 42
typeOf func                   # Int -> Int
typeOf twice                  # Int -> Int
```

Both definitions describe the same input and result types. `(Int x)` checks or
losslessly converts the argument and binds its payload to `x`. `Int { x + x }`
applies `Int` to the body's result. The checker infers the function's type from
these existing patterns and expressions; no separate signature is needed.
The function itself remains a callable value, not a type descriptor.

`(Int x) -> Int x + x` is also valid, but application binds more tightly than
addition: its body is `(Int x) + x`. Use `Int { x + x }` or `Int (x + x)` to
explicitly constrain the whole result. Without a result constructor, the checker
still infers a result type from the body.

## Function contracts

Function contracts are written in patterns:

```apn
func ((Int -> Int) f) = Int {
    f 123
}
func (*2)                       # 246 (typed Int)

((Int -> Int) increment) <- (x -> x + 1)
increment 123                  # 124
```

The pattern binds `f` through a wrapper. Calling it applies the input constructor,
then calls the original function, then applies the output constructor to its
result. Numeric inputs require lossless conversion, whether bare or explicitly typed. Wrong types raise errors. No function body is run merely to match a
function contract. Consequently a callable can match and later fail its contract;
that failure is an error, not a reason to try another handler.

`Int { ... }` independently constrains the enclosing function's result. A
contract is an ordinary typed pattern whose type is a lambda, read as the
function type it spells out; arrows associate right, so `Int -> Int -> Int`
describes a curried function. A lowercase name not bound to a type is a type
variable: `((a -> a) f)` accepts a function whose result has its argument's
type, checked at each call (`f 1` must return an Int). A function type may take
functions: `((a -> b) -> List a -> List b)`. See "Function types" in
[semantics](semantics.md).

In expressions, `->` creates a lambda, regardless of whether its names refer to
types; it is read as a type only where a type is expected (a typed pattern, a
constructor field, `(a -> a).(+ 1)`, `isType`, or beside a type in `==`).
`(Int -> Int) function` therefore applies a pattern-matching lambda; it does not
construct a function contract. `a -> a` is the identity lambda.

Constructor patterns and contracts are the only way to state a type. There are
no `:` annotations or `::` signatures: `:` always builds a list (`x:rest`) or a
record entry (`[x: 1]`). Because a list tail can never be a type, `f x: Int = x`,
`(x: Int) -> x`, and `x: Int = 5` are syntax errors that point to the
constructor form (`f (Int x) = x`, `x = Int 5`).


## Declared variant types in patterns

A declaration retains both the parent type and its constructors:

```apn
Option a = Some a | None
func (Option value) = match value [
    Some x -> print x
    None -> []
]
func (Some 123)
```

`(Option value)` accepts either `Some ...` or `None`, binding the entire
variant to `value` without forcing its fields. `(Some x)` instead binds the
payload. Unrelated values fail the parent type pattern and may fall through to
another clause. `Option value`, `cast Option value`, and `isType Option value` also
check this membership; `typeOf (Some 123)` returns `Option`. Specialization such
as `(Option Int) (Some 123)` applies the parameter's payload contract lazily.
See [templates and type aliases](templates-and-types.md).

When the parent and constructor share a name (`Box a = | Box a`), that name keeps
its constructor meaning: `(Box x)` unpacks the payload. Parent type patterns
resolve in the function's definition scope, including functions from modules.

## Repeating the definition name

The name of a parameter-taking definition participates in repeated-name matching:

```apn
x x = x
x x                       # returns x itself
x 1                       # error: argument 'x' must equal the function 'x'; got Int
```

The parameter named `x` must equal the function bound by the definition.
Functions compare by identity here: an alias of `x` matches, but a separately
created function does not, even if its body is identical. Partial application
retains the original definition's identity. The rule also applies to names
inside nested parameter patterns.

Other captured variables can still be shadowed by parameters. A lambda starts
its own parameter scope: `x = x -> x` remains an ordinary identity function.
Static checking rejects known incompatible argument types; matching checks
function identity at runtime, because sharing a type does not imply equality.

## Wildcard fields in schema patterns

Use `_` for a field that accepts any type and preserves its value:

```apn
func ([x: _] v) = print v.x
func [1]                    # 1
func ["hello"]              # hello
func [x: true]              # true
```

The schema supplies field names and positional order; `v` receives a record.
Named records may include extra fields. Positional lists must supply exactly the
schema's field count. A wildcard field has no default and must be supplied.

Wildcards can be mixed with explicit types or nested in record/list schemas:
`([x: _, y: Float] v)` preserves `x` and converts `y` as usual. Each `_` is
independent. Inference can constrain how the body uses a field, but `_` adds no
conversion and does not opt out of static checking like `Dynamic`.

This meaning applies in schema patterns. Ordinary expressions such as
`value = _` and `[x: _]` still contain unfinished code; `_` remains a wildcard
in ordinary matching patterns.

## Dotted patterns: keep the whole value

`left.right` matches the same argument against both patterns. No values-list
conversion happens: the left and right patterns see the original value.

```apn
func v.x = print [v,x]
func 1                            # [1, 1]

show whole.[x,y] = print [whole,x,y]
show [x: 1, y: 2, z: 3]           # [[x: 1, y: 2, z: 3], 1, 2]
show [1,2]                        # [[1, 2], 1, 2]

first whole.(x:xs) = x
unwrap whole.(Some x) = x
```

`[x,y]` keeps its existing meaning: named fields on records, positions on lists.
`_.[x,y]` discards the whole-value binding. Repeated names impose equality;
both patterns must match before the function body runs. Both views share the
same lazy argument and references. A converting subpattern only converts its
own view: `original.(Float x)` keeps the original input as `original`.

The same patterns work in bindings:

```apn
v.x = 1                           # v = 1, x = 1 (v previously unbound)
whole.[a,b] = [1,2]                # whole = [1,2], a = 1, b = 2
```

For an ordinary dotted `=` assignment, an already-bound root keeps the existing
field-update meaning. An existing scalar root errors; it does not fall back to
binding two names. Roots visible from an outer scope count as already bound,
and ordinary field updates retain their existing scoped-copy behavior.
Function parameters always introduce patterns, even if an outer name exists.
`<-` explicitly captures an eager pattern binding.

## Capturing type shapes and value shapes

A lowercase name not already bound in a schema pattern captures the supplied
value's type. Concrete type names retain their existing checking/conversion role.

```apn
inspect ([t] [x]) = print [t,x]
inspect [1]                       # [Int, 1]
inspect ["hello"]                 # [String, "hello"]

inspectPair ([a,b] [x,y]) = print [a,b,x,y]
inspectPair [1,"hi"]              # [Int, String, 1, "hi"]
```

The first shape describes/captures types, the second destructures values.
Each list shape has its written length; `[t]` is one slot, not an arbitrary-length
list. Nested lists and record schemas also work. Repeating `t` requires the same
type in each position. Existing lowercase type bindings are used as schemas;
capitalized constructors such as `Int` are never new capture names.

Like `(t x)`, a captured numeric type exposes its numeric payload separately:
`inspect [Int32 1]` prints `[Int32,1]`. `_` accepts a value without capturing
its type or stripping its annotation. These patterns still participate in static
inference; they are not `Dynamic` boundaries.

List schema patterns also accept records when the value pattern is a list of
names. Those names select fields; the corresponding type slots check or capture
the selected fields' types. Record order does not matter, and extra fields are
allowed, just as for ordinary `[x,y]` record destructuring.

```apn
inspect ([t] [x]) = print [t,x]
inspect [1]                       # [Int, 1]
inspect [x: 1]                    # [Int, 1]
inspect [answer: 1]               # no match: missing x

integer ([Int] [x]) = print x
integer [x: 1]                    # 1
integer [x: .2]                   # rejected: lossy Int conversion

pairTypes ([a,b] [x,y]) = [a,b,x,y]
pairTypes [y: "hi", x: 1]         # [Int, String, 1, "hi"]
```

Unlike dotted template application, this selects by the value pattern's names,
not record order. Use `whole.([t] [x])` to retain the complete original record.

## Record remainder patterns

`_: rest` in a keyed record pattern captures the fields not explicitly selected:

```apn
[x: first, _: rest] = [x: 1, y: 2, z: 3]
# first = 1; rest = [y: 2, z: 3]

withoutX [x: first, _: rest] = rest
withoutX [x: 1, y: 2]              # [y: 2]
[_: rest, x: first]                # rebuild: [y: 2, z: 3, x: 1]
```

There may be one remainder entry, anywhere in the pattern. Explicit fields must
exist. The remainder is a record (including when empty), preserves source order,
and shares untouched lazy fields and references. This works in bindings,
function parameters, and pattern lambdas used by `match`. Its meaning is the
counterpart of `_:` flattening in record expressions.
