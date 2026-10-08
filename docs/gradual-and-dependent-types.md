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
element type. Length-preserving operations keep their input's length: `map`,
`enumerate`, `xs * f` iteration, elementwise arithmetic (`-xs`, `xs + ys`,
`xs * 2`), and the standard library's `reverse`, `sort`, `sortBy`, `sortOn`,
`zipWithIndex`, and `forceList`. `pairs record` has one pair per field. Your own
functions carry lengths through too, including nested ones: a result that is an
argument, a list literal of such results, or an argument passed through those
operations (`twice xs = xs * (x -> x * 2)`, `h a b = [map f a, map f b]`). A
fold, cons, append, or filter makes the length unknown. So
`g [a, b] = ...; g (sort [2, 1])` checks, `g (map f [1, 2, 3])` is a length
error, and `[1, 2] + [3, 4, 5]` is rejected before running. Lengths follow a
function only where it is called directly by name; a function value passed
through a variable, ternary, list, or argument (`pick b = b ? sort : tail`)
gives an unknown length. A list of unknown length (`tail`, `filter`) still
needs a `Dynamic` boundary to meet a fixed-length pattern. An empty-list pattern
`[]` is the exception: lists of unknown length may reach it (recursion over
`tail` needs that), but a list known to be non-empty is a static error. An
empty-list clause and a cons clause are separate overload choices, so
`f [] = "e"; f (x:xs) = x` gives `f [5]` the cons clause's type.

When several clauses could apply, the result must fit each of them, unless one
definitely matches: then, as at runtime, clauses that come after it cannot run.
The runtime ranks clauses by a score, then source order: literal patterns 40,
a typed pattern 30 for the argument's exact type, 10 for a matching numeric
aggregate (`Number`, `Real`, `Integer`, `Exact`, `Inexact`), 1 for a lossless
conversion, and other patterns 0. The checker computes the same ranking from
argument types and, where the value is known, from the value: `UInt 3`
converts losslessly to `Int`, `300` does not fit `Int8`, and `2.5` is not an
integer. Where only an unknown value decides, it keeps both possibilities. A clause definitely matches when every argument fits
its pattern for certain: a variable or `_` (not a repeated name), a list
pattern of variables with a list of that known length, `[]` or `(x:xs)` with a
known empty or non-empty list, a literal pattern with that same literal, or a
typed pattern with its exact type (or a known value that converts losslessly). So with `f [] = [0]` before `f xs = [1, 2]`,
`f []` is a one-element list, and with `f xs = [1, 2]` before `f (Int n) = [0]`,
`f 3` is too. A clause whose literal, length, or type definitely differs from
the argument is skipped. Clauses for the same kind of input must agree on their
result type, but may return lists of different lengths: with
`f (Int n) = [1, 2]` and `f 0 = [0]`, `f 0` is a one-element list and `f 3` a
two-element one. This also works through function parameters, at any depth:
with `h x = g (f x)`, the checker decides `f x` at each call of `h`, so `h 0`
uses the literal clause (as does `h 1` for `f (x - 1)`). Every literal kind
works the same way: booleans, strings, characters, floats (compared
numerically), integer ranges (`f [1..3] = ...` with `h 2`), and constructors
the argument is visibly built with (`f None = ...` with `h None`, or
`f (Some x) = ...` with `h (Some 7)`). A function's result counts too when it
is called directly by name: with `mk x = None`, `f (mk 1)` uses the `None`
clause, and `pass v = v` passes its argument's value on. Results that depend on
argument values are evaluated: the checker runs the called function's clauses
(ranked as at runtime) and its conditions (comparisons, `!`, `&&`, `||`,
arithmetic, numeric builtins such as `abs`, `floor`, `sqrt`, `min`, truthiness)
with what it knows about the arguments. Numbers use the runtime's own
arithmetic, so exact rationals stay exact (`1 / 2 == 0.5`), binary floats round
as at runtime (`0.1 + 0.2 == 0.3` is false), comparisons with NaN are false,
and an operation the runtime rejects (a lossy exact/float mix, exact division by
zero) gives no value. Fixed-width numbers keep their type: `Float32` rounds to
single precision, and fixed-width integer overflow gives no value. A numeric
conversion of a parameter (`h v = Float32 v`) is checked at each call, so
`h 0.25` is accepted while `h "x"` is not. The builtin `length` of a list or String is
evaluated when its size is known: from a literal, an argument at the call,
`x : xs`, `xs ++ ys`, builtins that keep a list's length (`map`, `sort`), and
recursion over `[]` and `(x:xs)` clauses. Where a list's elements are known
too (literals, integer ranges such as `[1..n]` with `n` known, and lists built
from them), the pure builtins run on them as at runtime: `filter`, `map`,
`take`, `drop`, `zipWith` (and `zip`, which stops at the shorter list), `head`,
`tail`, `null`, `foldl`, `foldr`, `iterate`, `enumerate`, `chars`, `fromChars`,
`upper`, `lower`, `toString`, `intToString` and `parse` (booleans and number
literals). So do standard-library functions
written in APN, such as `takeWhile`, `dropWhile`, `words`, `splitOn`, `trim`,
`contains`, `all`, `any`, `find`, `sum`, `sort` and `isPrime`, including their
blocks of local definitions. Lists are lazy here too: `take 1 [0..]` and
`take 1 (repeat 0)` have one element. Recursion is followed as deep as the
runtime's own stack allows. Blocks follow the runtime's binding rules: a name a
block defines more than once is one binding, so lazy definitions and closures
see its latest value and eager ones (`<-`) the value where they stand. Integer
ranges are cut and indexed arithmetically (`length [1..1000000]`,
`drop 1000000 [0..]`), and other long lists are walked as far as the work
budget allows; computations past the budget (such as summing a million
elements) stay unknown.

Effects are never performed while checking, but their results are known:
`print x` and `emit x` are `x`, and `set`, `assert` and `debug` give `[]`. A
`Mutable` cell's contents are known when nothing checked in the session can
write a cell (no `set` or `load`). Otherwise contents are followed
in the run's order: block statements, eager bindings (`<-`) and operands run in
order, a lazy binding is read when used, and a list element or call argument
that reads a cell is computed where it is first needed, so
`{ c = Mutable 1; a = c + 0; set c 5; a + 0 }` is 5 and
`{ c = Mutable 1; xs = [c + 0]; set c 7; head xs }` is 7. A cell defined at the
top level is followed through the top-level statements that can write it,
which the checker runs in program order before checking each one: after
`counter = Mutable 0; set counter 4`, `counter + 0` is 4. Within a statement
that writes top-level cells, each part has the value that run gave it, so with
`bump x = { set counter (counter + 1); counter + 0 }`, `(counter + 0) + bump 0`
is 1 and `bump 0 + (counter + 0)` is 2; printing forces every element, in order.
A top-level value that uses a top-level cell is followed where the program
uses it: `snap = counter + 0` is computed at its first use and kept, and an
action such as `init = set counter 5` runs at each use, so after
`set counter 4; print snap; set counter 9`, `snap` is 4. A read stays unknown
when evaluation skips code or an uncertain branch, or when accesses could happen
in another order. A statement whose run is uncertain (a write under a condition
the checker cannot decide, code it cannot follow) leaves only the top-level
cells and values it can reach unknown: those its names, and the definitions
they name, refer to, including what its lazily computed values are computed
from and what a file it loads (by a literal path) names. An `env` view
(`scope <- Dynamic env`) reaches the bindings it names by literal fields
(`scope.bump`, `scope "bump"`, `scope.[a, b]`, `scope.x = v`), and a name opened by `use`
reaches the field it was opened from; an `env` view used any other way (a
computed key, passed on, an earlier REPL input or loaded file using one, or
opened by `use` from a record of unknown fields) reaches everything. Lazily computed list elements run where the program forces
them, as at runtime: `map`'s elements when used, `filter`'s predicate as its
cells are reached, printing and `==` cell by cell, so after
`print (map (x -> set counter x) [1, 2])`, `counter` is 2, and a top-level
action such as `xs = map f ys` builds its list afresh at each use. A value a statement leaves unforced matters only if it is
kept, in a top-level cell or a kept top-level value; a later statement that can
reach it runs statically too, so it is forced, once, where the program forces
it: after `set box [set counter 3]; print box`, `counter` is 3. When the interpreter checks a
program right before running it (the CLI and the REPL), `readFile`, `getArgs`
(and so `readInput`) and `readStdin` see the program's actual input, and the run
reads the same text the checker saw. Stdin is read ahead only when it is not a
terminal (a pipe or a redirected file), so interactive programs are unaffected;
at a terminal it stays unknown. Lint and editor checks never read input. A function
argument may be a lambda, an operator section, a named function, or a partial
application, also when passed through a parameter: `filter (> 1) [1, 2]` and
`hh (> 1)` with `hh p = filter p [1, 2]` both have one element. A recursive call
does not fix the length of a parameter whose pattern leaves it open, so
`go xs = null xs ? [] : go []` accepts lists of any length. So with
`safe n = n > 0 ? Some n : None`, `f (safe 4)` uses the `Some` clause and
`f (safe (-3))` the `None` one. Inside another function (`h v = g (f (safe v))`)
the decision waits for `h`'s calls, where `v` is known. Where a value stays
unknown, every possible result counts. Evaluation is bounded in work, so very
long computations fall back to that. Calls through a variable that holds a function are not
evaluated. A step function used with `repeatApply` may feed its own
results back through arithmetic (`g [a, b] = forceList [b, a + b]`).
Record-template patterns convert positional lists at runtime and
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
