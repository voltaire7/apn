# Gradual checking and value-dependent types

APN keeps its dynamic execution model. Checking is opt-in:

```sh
apn --check examples/types/dependent-vectors.apn
apn --checked examples/types/dependent-vectors.apn
apn --lint --types --json examples/types/dependent-vectors.apn
```

`--check` reads and checks source without running it. `--checked` checks the
entire entry file before any of that file's expressions run. A type error
stops execution and gives a nonzero exit status. Ordinary `apn file.apn` and
the REPL retain their existing runtime behavior.

The checker infers polymorphic functions, propagates application constraints,
checks structural record fields, constructor patterns, same-scope assignments,
and dependent list lengths. Inner scopes may shadow names with another type.
Clauses for the same input domain must share a result type; distinct typed
input domains remain overloads. No `::` declaration is required.

```apn
identity x = x
print (identity 123)
print (identity "hello")

unwrap (Some x) = x
unwrap None = 0
```

A known call such as `unwrap (Some "hello")` conflicts with the numeric fallback.
The function's clauses are checked together, rather than treated as unrelated
functions. A caller can explicitly select a dynamic boundary:

```apn
selfApply (Dynamic f) = f f
```

`Dynamic` is a first-class identity constructor and a permissive pattern. It
keeps runtime behavior; it does not pretend a dynamic value has a static proof.

## Values as type arguments

`Vector n elementType` describes a list of exactly `n` elements. `n` is an
ordinary nonnegative exact integer value. The constructor validates length
and applies the element type lazily, following APN's existing lossless
conversion rules.

```apn
Ints n = Vector n Int
xs = Ints 3 [10, 20, 30]
print (typeOf xs)                 # Vector 3 Int
xs 0 = 40                        # still Int, still length 3

copy n ((Ints n) values) = values
copy 3 [10, 20, 30]
# copy 3 [10, 20]                 # static length error in checked mode

appendOne n ((Ints n) values) (Int value) = Ints (n + 1) (values ++ [value])
```

Later parameter patterns can refer to earlier argument bindings. A dependent
function application substitutes the supplied index into subsequent parameter
and result types. The checker normalizes integer constants and affine index
expressions (addition, subtraction, multiplication by a known constant).
Known contradictory lengths are rejected. Unknown lengths and unsupported
index computations retain runtime validation; no user code runs to decide them.

Length validation checks the list spine through the expected size plus one
cell. It rejects an infinite list promptly when the requested size is finite,
without evaluating its elements. Element conversion errors surface when those
elements are demanded. `isType (Vector n t) value` checks length and membership;
index updates retain the vector descriptor and element conversion.

Type aliases can receive values as well as types:

```apn
Choice flag = flag ? Int : String
Choice true 123
Choice false "hello"
```

Known Boolean selections are reduced statically. Unknown selections and other
arbitrary type computations remain dynamic. Generic variant declarations still
use their existing type-parameter behavior; value-dependent aliases and Vector
provide the value-indexed layer.

## Dynamic boundaries and limits

Successful checking is not a claim that all runtime checks disappeared. The
CLI reports remaining dynamic boundaries. Imported names, `use`, `load`, live
environment reflection, unknown native operations, and unresolved overloads
remain dynamic. The checker does not execute or recursively inspect imported
files; check those files separately if desired. A dynamic boundary can still
fail at runtime. Losslessness or numeric range checks that depend on unknown
values also remain runtime checks.

Heterogeneous lists remain legal. Unsupported operations produce Dynamic in
the checker rather than acquiring invented constraints. The checker is bounded;
exhausting its analysis budget also produces a reported dynamic boundary.
Unrestricted self-application requires a Dynamic boundary in checked code;
unrestricted execution remains available in ordinary mode.

This is gradual, value-dependent typing, **not a proof-safe implementation of
Calculus of Constructions**. APN still permits nontermination, effects, dynamic
environments, and effectful type computations at runtime. There are no universe
levels, totality proofs, arbitrary theorem solving, or general definitional
equality. The `typeOf` printer remains diagnostic inference, separate from the
checker and its stricter acceptance rules.

## Editor diagnostics

The LSP accepts `initializationOptions.typeChecking = true`. In Neovim's LSP
configuration this is `init_options = { typeChecking = true }`. It is disabled
by default to preserve existing sessions. No editor configuration is modified
by installing these language changes. Type diagnostics use the same checker
as `--check` and `--lint --types`.
