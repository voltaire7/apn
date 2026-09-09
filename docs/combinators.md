# Self-application and combinators

```apn
import "std/combinator"

selfFactorial = (self -> n -> self self n) (self -> n -> n == 0 ? 1 : n * (self self (n - 1)))
selfFactorial 5  # 120
```

This is the supplied Scheme factorial translated directly into APN. `self`
replaces `!`, which APN reserves for negation. The definition does not refer to
`selfFactorial`: recursion comes from passing a function to itself.

```apn
factorialStep recurse n = n == 0 ? 1 : n * recurse (n - 1)
combinators.Y factorialStep 5      # 120
combinators.Z factorialStep 5      # 120
combinators.Theta factorialStep 5  # 120
fix factorialStep 5               # 120
```

All definitions are APN code in `lib/combinator.apn`. Importing `std` includes
them too. Conventional capital names are record fields, since APN reserves
capital bindings for constructors. Descriptive functions are also exported.

## Classical basis and common derived combinators

There are infinitely many combinators; this is a conventional useful collection,
not a claim to enumerate all of them. The equations specify argument order.

| Field | Function | Equation |
| --- | --- | --- |
| `combinators.I` | `identity` | `I x = x` |
| `combinators.K` | `kestrel` | `K x y = x` |
| `combinators.KI` | `kite` | `KI x y = y` |
| `combinators.S` | `starling` | `S f g x = f x (g x)` |
| `combinators.B` | `bluebird` | `B f g x = f (g x)` |
| `combinators.C` | `cardinal` | `C f x y = f y x` |
| `combinators.W` | `warbler` | `W f x = f x x` |
| `combinators.M` | `mockingbird` | `M f = f f` |
| `combinators.T` | `thrush` | `T x f = f x` |
| `combinators.V` | `vireo` | `V x y f = f x y` |
| `combinators.B1` | `blackbird` | `B1 f g x y = f (g x y)` |
| `combinators.Q` | `queer` | `Q f g x = g (f x)` |
| `combinators.U` | `uCombinator` | `U f = f (f f)` |
| `combinators.Y` | `yCombinator` | Curry's fixed-point combinator |
| `combinators.Z` | `zCombinator` | A fixed-point combinator with recursion delayed behind an argument |
| `combinators.Theta` | `thetaCombinator` | Turing's fixed-point combinator |

`S K K` behaves like `I`. `M M` is the divergent term Omega; it is intentionally
not evaluated during import or demonstrations. K and KI leave their discarded
argument unevaluated.

## Fixed points and laziness

```apn
yCombinator f = (x -> f (x x)) (x -> f (x x))
zCombinator f = (x -> f (v -> x x v)) (x -> f (v -> x x v))
thetaCombinator f = (x y -> y (x x y)) (x y -> y (x x y)) f
```

These use self-application, not named recursive calls. APN's laziness lets Y
produce values without immediately chasing self-application forever. Z delays
recursive application behind a lambda; APN still evaluates it lazily, and Z is
intended for function-valued fixed points. It is not a switch to eager evaluation.

`fix` uses a shared lazy knot instead. Its one-element list ensures the binding
is a memoized value rather than a repeatable application action:

```apn
fix f = {
    result = [f (head result)]
    head result
}

take 5 (fix (xs -> 1 : xs))  # [1, 1, 1, 1, 1]
```

A fixed point need not terminate: `fix identity` has no productive outer value.
Strict recursion still has the host interpreter's bounded evaluation depth.

## What Haskell can express

Ordinary Haskell rejects the direct unwrapped `x x` pattern used here: assigning
one monomorphic type to `x` would require that type to contain itself as its
function argument type. That does not make fixed points or factorial impossible
in Haskell. Haskell supports recursive bindings and provides
[`Data.Function.fix`](https://hackage-content.haskell.org/package/base-4.19.1.0/docs/src/Data.Function.html),
with type `(a -> a) -> a`:

```haskell
factorial = fix (\recurse n -> if n == 0 then 1 else n * recurse (n - 1))
```

The distinction is the direct self-application encoding under the type system,
not whether the language can express recursion. APN accepts this encoding
because values do not have to satisfy that static type equation.

Run `apn examples/combinators.apn` for the complete demonstration.
