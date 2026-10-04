# Static checking and value-dependent patterns

APN checks source before execution by default, with inferred types and explicit
`Dynamic` boundaries. Files, REPL submissions, and browser builds use the same
checker. No execution flag is required:

```sh
apn examples/types/dependent-vectors.apn
apn --check examples/types/dependent-vectors.apn
apn --lint --types --json examples/types/dependent-vectors.apn
```

`--check` checks source and its statically named dependencies without running
expressions. Unknown names,
incompatible calls, and implicit unresolved boundaries are errors before any
expression in that submission runs. The REPL preserves inferred bindings and
merges function clauses between submissions. Failed static checks install no
bindings. If execution fails, the submission's binding map is restored; already
performed I/O and mutations of reference contents are not undone.

`--lint --types` and optional editor diagnostics retain gradual analysis, reporting
known contradictions without requiring every operation to be established.

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
functions.

Input patterns and result constructors can make a function's inferred type
explicit in its definition:

```apn
twice (Int x) = Int { x + x }
# Equivalent lambda: twice = (Int x) -> Int { x + x }
print (typeOf twice)                   # Int -> Int
```

Here `Int { ... }` is ordinary constructor application. The displayed
`Int -> Int` describes the function's type; writing that arrow in an expression
creates a lambda. See [typed definitions and function contracts](pattern-functions.md#typing-a-function-through-its-definition).

## Explicit runtime boundaries

`Dynamic expression` explicitly opts that expression out of static checking.
Parsing still applies; unknown names and invalid operations inside it fail if
execution reaches them. Its result has static type `Dynamic`. Unmarked unknowns
elsewhere still fail ordinary execution and `--check`; a boundary does not disable
checking for the rest of the file.

```apn
value = Dynamic 41
Int value + 1                         # 42; Int validates at runtime
Int (Dynamic "hello")                 # runtime error

((Int -> Int) increment) <- (Dynamic (x -> x + 1))
increment 41                          # 42
((Int -> Int) bad) <- (Dynamic (x -> "hello"))
bad 1                                 # runtime error: result is not an Int

accept (Dynamic x) = x                 # explicit dynamic parameter
accept "hello"
```

Operations on a Dynamic value remain dynamic. To return to a concrete type,
apply its constructor or a function contract. Existing converting patterns,
such as `(Int x)`, also perform this runtime check. A variant pattern such as
`Some x` does not validate an inferred payload type merely by matching its tag.
An ordinary parameter whose type was inferred does not gain a hidden conversion:

```apn
square x = x == 0 ? 0 : x * x
# square (Dynamic 2)                  # static error
square (Int (Dynamic 2))              # 4
```

A `(Dynamic x)` parameter changes how `x` is checked, but does not hide unrelated
errors in the function body. Self-application does not need Dynamic; recursive
inference already supports it.

Runtime projections use APN's existing constructor rules, including lossless
integer conversion and explicit floating-point rounding. Function contracts
check arguments and results when called. `Vect` checks length and checks element
conversions when demanded. Dynamic keeps existing evaluation rules: `=` actions
remain repeatable, `<-` captures their result, and unused list elements stay lazy.
It preserves Mutable identity rather than copying its current contents.

### Reflection and writes

```apn
count = 1
scope <- Dynamic env
scope.count = 2                       # updates count
# scope.count = "hello"               # runtime error
key = "count"
Int (scope key)                        # 2
```

Checked execution protects reflected writes and names installed by `use`, `import`, or
`load` from changing existing binding types. `Dynamic env` also guards writes
through that view in ordinary execution. New names may be added, but using a
runtime-created name in checked code still requires a Dynamic boundary or an
explicitly checked projection.

These guards are conservative: existing record fields and positional list types
must be preserved, including list length. Additional record fields are allowed.
Lazy record/list payloads are checked when demanded, so a nested error can occur
on a later read. Scalar batch writes are validated before publication. Type
descriptors cannot be replaced by different descriptors through reflection.
Opaque references cannot be replaced by different references through reflection.
`set` also guards existing `Mutable` payload types in checked execution, including
writes inside Dynamic expressions.

To replace a function through reflection, first capture a function with an
explicit contract:

```apn
((Int -> Int) f) <- (x -> x)
scope <- Dynamic env
scope.f = Dynamic (x -> x + 1)
f 1                                  # 2; replacement retains the contract
```

Replacing an uncontracted function is rejected. A deferred action declared with
`=` is also a function: the guard does not run it to discover its result type.
Use `<-` when the binding should hold the evaluated value or contract. These
restrictions protect checked assumptions without evaluating arbitrary functions
to guess their types.

For embedding, call `interpreter.enableChecking()` before the first `run`.
This installs the stateful checker and runtime guards used by the CLI. The raw
`Interpreter` API remains available for internal runtime tests and hosts that
supply their own validation. `checkedExecution = true` alone enables runtime
guards; it does not run the checker. A successful check involving Dynamic is not
a promise that its runtime checks will succeed.

See [the runnable boundary example](../examples/types/dynamic-boundaries.apn).

## Values as type arguments

`Vect n elementType` describes a list of exactly `n` elements. `n` is an
ordinary nonnegative exact integer value. The constructor validates length
and applies the element type lazily, following APN's existing lossless
conversion rules.

```apn
Ints n = Vect n Int
xs = Ints 3 [10, 20, 30]
print (typeOf xs)                 # Vect 3 Int
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
index computations are dynamic boundaries: strict mode requires an explicit `Dynamic` boundary, while
ordinary execution retains runtime validation. No user code runs to decide them.

Length validation checks the list spine through the expected size plus one
cell. It rejects an infinite list promptly when the requested size is finite,
without evaluating its elements. Element conversion errors surface when those
elements are demanded. `isType (Vect n t) value` checks length and membership;
index updates retain the vector descriptor and element conversion.

Type aliases can receive values as well as types:

```apn
Choice flag = flag ? Int : String
Choice true 123
Choice false "hello"
```

Known Boolean selections are reduced statically. Unknown selections and other
arbitrary type computations remain dynamic. Generic variant declarations still
use their existing type-parameter behavior; value-dependent aliases and Vect
provide the value-indexed layer.

## Inferring arguments from a vector pattern

```apn
append (Vect n a []) (Vect m a ys) = Vect (n + m) a ys
append (Vect n a (x:xs)) (Vect m a ys) =
    Vect (n + m) a (x : append xs ys)

append [1,2] [3,4]                # [1, 2, 3, 4]
```

The first pattern introduces length `n`, element type `a`, and the contents.
The second introduces `m` and requires the same `a`. These are ordinary local
values available in the body. `Vect` is the built-in name; `Vector` was renamed.
`(Vect n Int xs)` constrains the element type explicitly, and `(Vect 3 a xs)`
constrains the length. For computed type expressions, the existing form
`((Vect (n + 1) Int) xs)` remains available.

The checker refines `n` to zero in the empty branch. In the cons branch the
tail has length `n - 1`. An explicit result constructor supplies a recursive
signature before the body is checked; affine arithmetic establishes the sum.
The example passes strict checking without executing either branch.
Returning `Vect (n + m + 1) a ys` in the empty branch is a static error.

At runtime an annotated vector supplies its descriptor without forcing its
elements. An ordinary finite list must be traversed to infer its length and
homogeneous element type; this can force elements. Mixed element types fail
the pattern. A fixed length inspects at most that length plus one cell, so an
infinite list is rejected promptly. Inferring an unknown length from an infinite
list cannot finish, but remains interruptible.

An empty unannotated list provides no element-type evidence. Its type binder
stays open for another vector argument to determine. If every argument is
empty, it remains a polymorphic empty-vector element type, displayed with the
binder name. `Vect 0 Int []` supplies explicit evidence instead.

## Repeated names

```apn
same x x = x
same 3 3                         # 3
# same 3 4                       # no matching clause

(x x -> x) 3 3                  # 3
```

Within one parameter list, the first occurrence binds and subsequent occurrences
compare using APN equality. This also applies inside list and record patterns.
The names shadow outer bindings; separate nested lambdas introduce separate
scopes. `_` is always an independent wildcard, so `(_ _ -> 1) 2 3` returns 1.
The checker requires compatible types; equal values are still checked at runtime.
Comparing infinite lists may not terminate. Function equality retains APN's
existing behavior; repeated patterns do not prove function equivalence.

## Static boundaries and limits

Static checking follows literal `import` and `load` dependencies and infers their
exports. Namespaced imports stay namespaced. `use` opens statically known records
or lists of records. Loaded files are checked with their lexical caller scope;
a source change between checking and execution is rejected. Resubmit the loading
definition to check the new source. Cyclic or computed loads need an explicit
`Dynamic` boundary. The checker never executes APN to discover types.

Overloaded arithmetic retains constraints in inferred functions: `f x = x + 1`
can be called with compatible numeric inputs, and `f "bad"` is rejected. List
literals retain positional types; homogeneous operations check every possible
element type. Record-template patterns convert positional lists at runtime and
are checked against their named field types. Inferred parameters do not silently
convert arguments; actual constructors and converting patterns provide conversions.

Runtime reflection uses `Dynamic env`. The result of `parse`, syntax inspection
with `toAST`, debugger `step`, and native FFI/resource interfaces carries Dynamic
where its shape cannot be known statically. The metacircular evaluator declares
its runtime parser/evaluator execution as Dynamic. HTML, browser configuration,
and p5 payloads declare Dynamic fields for host-interpreted data and callbacks.
These explicit library boundaries are checked again when projected into concrete
types. They do not make arbitrary user code silently unchecked.

Successful checking does not prove termination, exhaustive matching, index bounds,
or freedom from all runtime errors. Heterogeneous lists remain legal, but using
an unknown element in a constrained operation may require additional information.
Analysis budget/depth exhaustion is a diagnostic, never successful checking or
a silent Dynamic fallback. Gradual editor diagnostics remain available separately.

## Recursion and self-application

The checker infers recursive structural types, so self-application does not
require a `Dynamic` annotation or explicit wrapping:

```apn
self f = f f
self (ignored -> 123)              # 123
# self 123                        # static type error: expected a function

factorial = (self -> n -> self self n) (self -> n -> n == 0 ? 1 : n * (self self (n - 1)))
factorial 5                       # 120
```

For `self`, its argument type satisfies `r = r -> a`. The checker represents
that equation as a finite graph. Unification compares recursive graphs without
unfolding forever, and polymorphic instantiation preserves their cycles and
shared variables. Recursive diagnostics use `mu rec0. ...` to bind a recursive
reference. This is inferred metadata, not new APN declaration syntax.

Ordinary recursion, `x = x`, and self-application such as
`(x -> x x) (x -> x x)` can be checked without executing them. Acceptance does
not guarantee termination. Recursive lazy values such as `xs = 1 : xs` keep
their existing runtime behavior.

The factorial example passes strict checking with no dynamic boundary.
Runtime recursion is unrestricted, including deliberately divergent programs.

This is **not a proof-safe implementation of Calculus of Constructions**. APN still permits nontermination, effects, dynamic
environments, and effectful type computations at runtime. There are no universe
levels, totality proofs, arbitrary theorem solving, or general definitional
equality. The `typeOf` printer remains diagnostic inference, separate from the
checker and its stricter acceptance rules.

## Editor diagnostics

The LSP accepts `initializationOptions.typeChecking = true`. In Neovim's LSP
configuration this is `init_options = { typeChecking = true }`. It is disabled
by default to preserve existing sessions. No editor configuration is modified
by installing these language changes. Type diagnostics use the same inference
engine in gradual mode; ordinary execution and `--check` additionally reject remaining
implicit dynamic boundaries. Explicit `Dynamic` boundaries are accepted and
retain runtime validation.
