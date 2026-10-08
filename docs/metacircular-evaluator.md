# APN evaluating APN

```apn
import "meta"
metaEval "fact n = n == 0 ? 1 : n * fact (n - 1); fact 5"  # 120
metaEval "x = 1:x; take 6 x"                              # [1, 1, 1, 1, 1, 1]
```

The reader, lexical environments, recursive bindings, closure representation,
and evaluation rules are written in APN. The object program is never passed to
the TypeScript parser or evaluator. This implements a self-interpreting **core
subset** of APN; it is not a replacement for the entire host implementation.

## Reproduce the self-evaluation proof

```sh
apn examples/metacircular.apn
apn examples/metacircular-self.apn                     # from the repository root
deno run --allow-read examples/metacircular-self.ts    # from any directory
deno test --allow-read tests/metacircular-test.ts
```

The self-evaluation demo prints `42` three times. It reads the actual
`lib/meta/evaluator.apn` file as plain text with `readFile` (the path is its
first argument, defaulting to the repository-relative one); the small
TypeScript driver only supplies the absolute path. All parsing and evaluation
happens in APN:

1. The APN reader (`metaParse`) turns the evaluator's source into ordinary APN lists.
2. `meRun` evaluates those definitions, constructing an interpreted `meEval`.
3. The interpreted `meEval` evaluates an arithmetic expression, an identity
   function application, and a conditional with an unbound unused branch.

There are two object evaluation layers. Neither receives a host `eval`, `parse`,
`toAST`, `load`, or a callback to `meEval` as a primitive. Tests compare ordinary
programs against the host interpreter and run the self-evaluation checks against
the live evaluator source, so the proof cannot silently drift from the code.

## Structure

| File | Responsibility |
| --- | --- |
| `lib/meta.apn` | `metaEval source` and `metaSelfEval evaluatorSource source` |
| `lib/meta/parser.apn` | Character tokenizer and precedence parser |
| `lib/meta/evaluator.apn` | Environments, closures, recursive scope, application, dispatch |
| `lib/meta/primitives.apn` | Explicit object-language primitive environment |

Syntax is data: `["literal",42]`, `["variable","x"]`,
`["lambda","x",body]`, `["apply",function,argument]`,
`["if",condition,yes,no]`, `["list",expressions]`, and
`["scope",definitions,body]`. `metaParse` returns `[definitions,expression]`.

Environments are persistent HashMaps. A closure is a map containing its
parameter, body and lexical environment. Applying a closure extends that
captured environment and evaluates its body. Recursive scopes tie a lazy knot
between bindings and their environment. List elements and arguments remain
lazy through the host's existing call-by-need machinery. This evaluator reuses
APN's thunk sharing rather than implementing a second mutable thunk heap.

The evaluator dispatches through a lazy table of cases. Only the selected
case is demanded. As a result, unused branches and arguments can contain errors,
and recursive lists remain productive.

## Supported source

- Decimal integers, strings, booleans and finite list literals.
- Arithmetic, comparisons, `++`, cons `:`, unary `-`/`!`, and right-associative function application `$`.
- Grouping, curried application, list indexing, lambdas, and named functions
  with identifier parameters.
- Ternary conditionals and blocks containing definitions followed by a result.
- Recursive and mutually recursive definitions, lexical closures, lazy lists.
- Singleton list templates map lazily; longer templates apply positionally.
  Template elements are evaluated by the metacircular apply function, including
  object-language closures. Integer application remains indexing.
- Newline or semicolon separators, `#` comments, common string escapes.
- Exact fractions produced by division, inherited from APN arithmetic.

The source reader does **not** implement patterns, overload declarations, variant
declarations, record literals/access, ranges, decimal/radix/complex literals,
assignment, imports, or APN's strict indentation checks. Programs consist of
zero or more definitions and one final expression; arbitrary sequences of
expression statements are not supported. Braces delimit local scopes explicitly.
Its pure definition semantics do not reproduce APN's repeatable action bindings.
Malformed or unsupported input errors rather than falling back to host parsing.

The core evaluator's own source deliberately stays within this subset. The
reader uses additional APN features and is not itself bootstrapped by this test.
This demonstrates metacircular evaluation, not a self-hosting compiler or a
standalone executable without the existing runtime.

## Primitive boundary and limits

The object environment exposes arithmetic/comparisons, scalar types, list
operations, HashMap construction/access, character conversion, `seq`, and
`fail`. Those are explicit value-level operations, not evaluation shortcuts.
`lib/meta/primitives.apn` is the complete list.

The non-I/O standard-library native layer contains six functions: `seq`,
`fail`, `chars`, `fromChars`, `upper`, and `lower`. Prefix consumers, predicates,
scans, stable merge sort, splitting/joining, replacement, words, and trimming
are APN definitions. Three additional script-input natives (`readFile`, `readStdin`, `getArgs`)
are outside the metacircular primitive environment. Core interpreter natives (including folds, primitive
arithmetic, and I/O) remain; six is not the total native count of the language.

Self-interpretation consumes more stack and time than direct execution. The
host's bounded evaluation-depth limit is 512, raised from 200 to accommodate
these nested interpreters; it is not unlimited recursion. Deep programs can
still hit that limit. Sequence operations that require the end of an infinite
input still do not terminate.

List application selects indices, including a list of indices. Dotted list templates
use a separate `template` AST tag and `meTemplate`; they still apply object-language
closures through `meApply`. The reader supports bracket, string, and parenthesized
template inputs. Record plucks remain outside this core subset.
