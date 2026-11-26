# APN evaluating APN

```apn
std <- import "std"
[..] = std.meta
metaEval "fact n = n == 0 ? 1 : n * fact (n - 1); fact 5"  # 120
metaEval "x = 1 :: x; take 6 x"                          # [1,1,1,1,1,1]
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
`lib/std/meta/evaluator.apn` file as plain text with `readFile` (the path is its
first argument, defaulting to the repository-relative one); the small
TypeScript driver only supplies the absolute path. All parsing and evaluation
happens in APN:

1. The APN reader (`metaParse`) turns the evaluator's source into ordinary APN lists.
2. `meEval` evaluates those definitions, constructing an interpreted `meEval`.
3. The interpreted `meEval` evaluates an arithmetic expression, an identity
   function application, and a conditional with an unbound unused branch.

There are two object evaluation layers. Neither receives a host `eval`, `parse`,
`toAST`, `load`, or a callback to `meEval` as a primitive. Tests compare ordinary
programs against the host interpreter and run the self-evaluation checks against
the live evaluator source, so the proof cannot silently drift from the code.

## Structure

| File | Responsibility |
| --- | --- |
| `lib/std/meta.apn` | `metaEval source`, `metaEvalSyntax syntax` and `metaSelfEval evaluatorSource source` |
| `lib/std/meta/parser.apn` | Character tokenizer and precedence parser |
| `lib/std/meta/evaluator.apn` | Environments, closures, recursive scope, application, dispatch |
| `lib/std/meta/primitives.apn` | Explicit object-language primitive environment |

Syntax is data, in the lists [`toAST`](standard-library.md#code-as-data--syntax)
gives (an item's, as `toAST [e] 1`): `metaParse "fact n = n * 2; fact 5"` is
`["{}", ["=", ["fact","n"], ["*", "n", 2]], ["fact", 5]]`, and `metaEvalSyntax`
runs `toAST`'s output as it runs the reader's. A leaf is a number, a Bool, a
name or a string literal's quoted source (which the evaluator unescapes); a
list headed by `->`, `?:`, `[]`, `.`, `$`, `:` (an ascription, `(x : T)`; a
declaration `x : T = e` reads as `x = e : T`) or
`{}` is that form, and any other
list applies its first element to the rest. `$` is a form, not a primitive, so
it can apply an object-language closure. To run the user's program, the
self-evaluation names it and its primitives (`objectProgram`, `objectScope`)
in the outer scope.

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
- Arithmetic, comparisons, `++`, cons `::`, unary `-`/`!`, and right-associative function application `$`.
- Grouping, curried application, list indexing, lambdas, and named functions
  with identifier parameters.
- Ternary conditionals and blocks containing definitions followed by a result.
- Recursive and mutually recursive definitions, lexical closures, lazy lists.
- Singleton list templates map lazily; longer templates apply positionally.
  Template elements are evaluated by the metacircular apply function, including
  object-language closures. Integer application remains indexing.
- Newline or semicolon separators (a deeper line continues its statement, and a
  line ending in `{` opens a block 4 deeper), `#` comments, common string escapes.
- Exact fractions produced by division, inherited from APN arithmetic.

The source reader does **not** implement patterns, overload declarations, variant
declarations, record literals/access, ranges, decimal/radix/complex literals,
assignment, imports, or APN's strict indentation checks. Programs consist of
zero or more definitions and one final expression; arbitrary sequences of
expression statements are not supported. Braces delimit local scopes explicitly.
It has no IO actions: its definitions are pure values.
Malformed or unsupported input errors rather than falling back to host parsing.

The core evaluator's own source deliberately stays within this subset. The
reader uses additional APN features and is not itself bootstrapped by this test.
This demonstrates metacircular evaluation, not a self-hosting compiler or a
standalone executable without the existing runtime.

## Primitive boundary and limits

The object environment exposes arithmetic/comparisons, scalar types, list
operations, maps (made by ascription, `(entries : HashMap _ _)`, and told by
`isType`; `lookup`, `insert`, ...), character conversion, `seq`, and `fail`.
The object language checks nothing before it runs, so its any type `_` is
`Dynamic`. Those are explicit value-level operations, not evaluation shortcuts.
`lib/std/meta/primitives.apn` is the complete list.

The non-I/O standard-library native layer contains six functions: `seq`,
`fail`, `upper`, `lower`, and the character conversions behind
`to (List Char)` and `from (List Char)`. Prefix consumers, predicates,
scans, stable merge sort, splitting/joining, replacement, words, and trimming
are APN definitions. Three additional script-input natives (`readFile`, `readStdin`, `getArgs`)
are outside the metacircular primitive environment. Core interpreter natives (including folds, primitive
arithmetic, and I/O) remain; six is not the total native count of the language.

Self-interpretation consumes more stack and time than direct execution. The
host's bounded evaluation-depth limit is 512, raised from 200 to accommodate
these nested interpreters; it is not unlimited recursion. Deep programs can
still hit that limit. Sequence operations that require the end of an infinite
input still do not terminate.

List application selects indices, including a list of indices. Record plucks remain outside this core subset.
