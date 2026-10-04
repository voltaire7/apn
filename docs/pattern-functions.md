# Pattern functions and function contracts

Pattern matching belongs to function parameters. A pattern lambda applies just
like any other function:

```apn
import "std"
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
[identity [1, 2], identity [x: 1, y: 2], add 1 2, first [1, 2] 99]
# [[1, 2], [x: 1, y: 2], 3, [1, 2]]
```

`add [1, 2]` supplies only `x` and returns a function awaiting `y`. It does not
mean `add 1 2`. A collection variable works the same way as a literal.

### Destructuring one argument

| Parameter pattern | List argument | Record argument |
| --- | --- | --- |
| `value` | Binds the entire list | Binds the entire record |
| `[x, y]` | Binds exactly two elements by position | Binds fields named `x` and `y` |
| `[x: a, y: b]` | Does not match | Binds fields `x` and `y` as `a` and `b` |
| `(x:xs)` | Binds the head and tail of a nonempty list | Does not match |

```apn
sumPair [x, y] = x + y
[sumPair [1, 2], sumPair [y: 2, x: 1, extra: 99]]
# [3, 3]
```

List patterns require the exact length. For records, the bare-name pattern
`[x, y]` requires those fields, ignores field order, and permits extra fields.
This record interpretation only applies when every element of the pattern is a
variable name. Renaming those variables also changes which fields it selects.
Use a keyed pattern when local variable names should differ from field names:

```apn
sumFields [x: a, y: b] = a + b
sumFields [y: 2, x: 1]       # 3
```

Missing fields or a wrong list length cause pattern mismatch; another clause
may handle the input. If no clause matches, the call errors. These patterns
also work in lambdas, such as `([x, y] -> x + y) [1, 2]`.

### Records as named arguments

A record argument supplies named inputs without separate named-call syntax:

```apn
area [width, height] = width * height
area [height: 20, width: 10] # 200
```

This function also accepts `area [10, 20]`. To require a record, write
`area [width: w, height: h] = w * h`. Required fields must be present;
destructuring does not itself supply defaults for omitted names.

### Record-template parameters

A template pattern converts an argument before binding its local name:

```apn
Vector3 = [x: Float, y: Float, z: Float]
lengthSquared (Vector3 v) = v.x ^ 2 + v.y ^ 2 + v.z ^ 2
lengthSquared [1, 2, 3]      # 14.0
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
[original.child.x, changed.child.x] # [1, 10]
```

List index updates work the same way. Shared references such as `Mutable` and
live environment views are exceptions to ordinary copy-and-rebind behavior.
See [slot assignment](templates-and-types.md#slot-assignment).

### Evaluation

Arguments are deferred until needed. A plain variable or wildcard parameter
does not inspect the collection; a destructuring pattern demands the shape it
needs. List elements remain deferred when bound to variables:

```apn
firstPair [x, y] = x
firstPair [42, missing]      # 42; the unused second element is not evaluated
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

`Int { ... }` independently constrains the enclosing function's result. Inside
contract patterns, arrows associate right: `Int -> Int -> Int` describes a
curried function.

In expressions, `->` always creates a lambda, regardless of whether its names
refer to types. `(Int -> Int) function` therefore applies a pattern-matching
lambda; it does not construct a function contract. `a -> a` is the identity
lambda. Write `((Int -> Int) f)` in a parameter or binding pattern to constrain
`f`. A captured contract's `typeOf` remains a first-class type value, but its
printed arrow description is not a standalone type expression.

Legacy `:` and `::` annotations are still accepted and ignored; they are
separate from these runtime contracts.


## Declared variant types in patterns

A declaration retains both the parent type and its constructors:

```apn
Maybe a = Just a | Nothing
func (Maybe value) = match value [
    Just x -> print x
    Nothing -> []
]
func (Just 123)
```

`(Maybe value)` accepts either `Just ...` or `Nothing`, binding the entire
variant to `value` without forcing its fields. `(Just x)` instead binds the
payload. Unrelated values fail the parent type pattern and may fall through to
another clause. `Maybe value`, `cast Maybe value`, and `isType Maybe value` also
check this membership; `typeOf (Just 123)` returns `Maybe`. Specialization such
as `(Maybe Int) (Just 123)` applies the parameter's payload contract lazily.
See [templates and type aliases](templates-and-types.md).

When the parent and constructor share a name (`Box a = | Box a`), that name keeps
its constructor meaning: `(Box x)` unpacks the payload. Parent type patterns
resolve in the function's definition scope, including functions from modules.
