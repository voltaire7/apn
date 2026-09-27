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
use `()` when a matched branch should do nothing.

`match` is an intrinsic function, available by default. It tries a lazy list of unary functions in order:

```apn
handlers = [
    Some y -> print y
    None -> ()
]
func x = match x handlers
func (Some 123)
```

Inline lists work identically. Lists can be constructed, passed, and reused;
`match` itself can be passed or rebound. As with other function applications,
parenthesize computed arguments: `match (head xs) handlers`.

Literals, lists, constructors, type patterns, and wildcards can be lambda
parameters. A guard follows the parameters, e.g. `n | n > 0 -> n`. A false guard
is a mismatch; guards must return Bool. Multiple parameter lambdas are curried,
but match alternatives must have exactly one remaining argument.

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

## Function contracts

Types are constructors, including function types:

```apn
func ((Int -> Int) f) = Int {
    f 123
}
func (*2)                       # 246 (typed Int)

Transform = Int -> Int
applyTransform (Transform f) = f 123
```

The pattern binds `f` through a wrapper. Calling it applies the input constructor,
then calls the original function, then applies the output constructor to its
result. Untyped numeric inputs may round/truncate; explicitly typed inputs
require lossless conversion. Wrong types raise errors. No function body is run merely to match a
function contract. Consequently a callable can match and later fail its contract;
that failure is an error, not a reason to try another handler.

`Int { ... }` independently constrains the enclosing function's result. Arrows
associate right: `Int -> Int -> Int` describes a curried function. A function type
can also be applied directly as a constructor: `(Int -> Int) (*2)`. Named contracts
currently use capitalized top-level aliases. Legacy `:` and `::` annotations are
still accepted and ignored; they are separate from these runtime contracts.


## Declared variant types in patterns

A declaration retains both the parent type and its constructors:

```apn
Maybe a = Just a | Nothing
func (Maybe value) = match value [
    Just x -> print x
    Nothing -> ()
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
