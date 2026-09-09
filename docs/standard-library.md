# Standard library

```apn
import "std"
take 10 primes
mean [1,2]                          # Some 3/2
"one two one" $ words $ frequencies # HashMap [["one",2],["two",1]]
```

`import` accepts a literal module name. `import "std"` brings the library into
scope; individual modules use `import "std/text"`, etc. Dependencies are imported
with them. Files resolve relative to APN's installation, so this works from any
working directory. Imports require Deno read permission (the `apn` launcher
already provides it).

Each interpreter evaluates each module once in a scope containing builtins and
its dependencies, independent of caller bindings. Reimporting restores the same
exports without reexecuting the module. Existing local names are replaced by
imported names. A bare import statement is silent. In an expression, imports return a record: `s = import "std"` allows `s.sum`.
Like other lazy definitions, this form takes effect when `s` is demanded.

`load "file"` (or `load "file.apn"`) remains file execution: paths are relative to the source file,
loading executes again each time, and it uses the caller's scope. `import` currently
recognizes only the bundled modules below; use `load` for other APN files.
Names without an extension receive `.apn`; explicitly supplied extensions are
used literally. `load` parses file contents as APN regardless of their extension.
`sq` lives in `std/number`; `halt` lives in `std/system`. The obsolete
`lib/core.apn` has been removed; replace its loads with these imports.

## Functions — `std/function`

| API | Behavior |
| --- | --- |
| `id x`, `constant x ignored` | Identity; ignore the second argument |
| `compose f g x` | `f (g x)` |
| `flip f x y` | `f y x` |
| `on f project x y` | Compare/combine projected values |
| `apply f x`, `twice f x` | Apply once or twice |
| `not x` | Boolean negation |
| `pair x y`, `fst pair`, `snd pair` | Two-element lists |
| `curry f x y`, `uncurry f pair` | Convert between pair and curried arguments |
| `seq value next` | Demand the outer value, then return `next`; does not deeply force lists |
| `fail message` | Raise a runtime error when demanded |

## Absence and errors — `std/option`

```apn
type Option a = Some a | None
type Result a e = Ok a | Err e
```

| API | Behavior |
| --- | --- |
| `isSome option`, `isNone option` | Inspect presence |
| `withDefault fallback option` | Unwrap `Some`; only demand fallback for `None` |
| `mapOption f option`, `andThen f option` | Transform a value, or chain a function returning an Option |
| `mapResult f result` | Transform `Ok`, preserve `Err` |
| `mapError f result` | Transform `Err`, preserve `Ok` |
| `andThenResult f result` | Chain a function returning a Result |
| `resultDefault fallback result` | Unwrap `Ok`, use fallback for `Err` |

These are ordinary APN variants. `Result` does not catch runtime exceptions.

## Sequences — `std/sequence`

Existing `map`, `filter`, `take`, `drop`, `zipWith`, `iterate`, `foldl`, and
`foldr` remain builtins. Function arguments come first; data comes last for `$`.

| API | Behavior |
| --- | --- |
| `repeat x`, `replicate n x`, `cycle xs` | Infinite repetition, bounded repetition, repeated list (`cycle []` is empty) |
| `zip xs ys`, `zipWithIndex xs` | Pair corresponding values; zero-based `[index, value]` pairs |
| `concat xss`, `flatten xss`, `concatMap f xs` | Flatten one level, optionally mapping first |
| `scanl f seed xs` | Lazy running accumulators, including the seed |
| `sum xs`, `product xs` | Strict left folds with identities 0 and 1 |
| `all predicate xs`, `any predicate xs`, `contains x xs` | Short-circuiting queries |
| `find predicate xs`, `findIndex predicate xs` | First match/index as an Option |
| `headOption xs`, `lastOption xs`, `atOption n xs` | Optional access; `atOption` is zero-based and returns None for negative/out-of-range indexes |
| `takeWhile predicate xs`, `dropWhile predicate xs` | Consume a matching prefix |
| `takeUntil predicate xs` | Prefix before the first match |
| `splitAt n xs`, `span predicate xs` | `[prefix, remainder]` |
| `chunksOf n xs` | Positive-sized chunks; final chunk may be shorter |
| `intersperse separator xs` | Insert separators between elements |
| `partition predicate xs` | `[matching, nonmatching]` |
| `unique xs` | Preserve the first occurrence of each value |
| `reverse value` | Overloaded for List and String; reverses finite lists or Unicode code points |
| `compare x y` | Negative, zero, or positive integer |
| `sort xs`, `sortOn project xs`, `sortBy comparator xs` | Stable ascending sort; comparator returns an integer |
| `minimum xs`, `maximum xs` | Optional extrema |

Producers and prefix operations support infinite inputs. Sorting, reversing,
statistics, and full folds require finite inputs. Searches terminate only when
they find an answer or reach the end. `unique` uses equality and repeated
filtering, so it is best for modest inputs. Lazy accumulator chains in `scanl`
can reach the interpreter's evaluation-depth limit if many preceding values
are skipped without being demanded.

## Numbers — `std/number`

| API | Behavior |
| --- | --- |
| `sq x`, `cube x`, `sign x` | Square, cube, sign (-1/0/1) |
| `clamp lo hi x` | Inclusive bounds; reversed bounds error |
| `factorial n` | Nonnegative integral argument, exact result |
| `mean xs`, `median xs` | Optional arithmetic mean and median |
| `variance xs`, `standardDeviation xs` | Optional population variance and standard deviation |
| `isPrime n`, `primes` | Integer primality by trial division; infinite ascending primes |
| `fibonacci` | Infinite exact sequence starting with 0, 1 |

Empty statistics return `None`. Exact inputs preserve exact arithmetic:
`variance [1,2,3]` is `Some 2/3`. Irrational square roots are inexact. Typed numeric
operations retain APN's existing overflow checks and lossless conversion rules.

## Text — `std/text`

| API | Behavior |
| --- | --- |
| `chars text`, `fromChars xs` | Convert between strings and lists of Char |
| `textLength text`, `reverse text` | Count/reverse Unicode code points |
| `textTake n text`, `textDrop n text` | Code-point prefixes and suffixes |
| `splitOn delimiter text`, `joinWith delimiter xs` | Literal splitting/joining; splitting preserves empty fields |
| `replaceAll search replacement text` | Literal replacement |
| `trim text`, `upper text`, `lower text` | Whitespace trimming; Unicode case conversion |
| `isBlank text` | Empty after trimming |
| `words text`, `unwords xs` | Split whitespace/discard empties; join with spaces |
| `lines text`, `unlines xs` | Split/join literal LF; no implicit trailing newline |
| `startsWith prefix text`, `endsWith suffix text` | Prefix/suffix tests |

Code points preserve emoji outside the BMP but are not grapheme clusters:
combining marks and multi-code-point emoji remain separate characters.

## Persistent maps — `std/map`

These operate on existing `HashMap` values. Builtin construction, `insert`,
`lookup`, `has`, `remove`, `keys`, `values`, and `pairs` are unchanged.

| API | Behavior |
| --- | --- |
| `getOption key m`, `getOr fallback key m` | Optional/defaulted lookup |
| `insertWith combine entries m` | Insert record/association entries; collisions use `combine old new` |
| `update key f m` | Transform an existing value; absent keys leave the map unchanged |
| `mapValues f m` | Transform values, preserve keys |
| `filterMap predicate m` | Keep entries for which `predicate key value` is true |
| `merge left right`, `mergeWith combine left right` | Right-biased merge, or resolve collisions explicitly |
| `frequencies xs` | Map each scalar key to an exact count |
| `groupBy project xs` | Map projected keys to lists in original encounter order |

Every operation returns a new map. Input maps remain unchanged, and insertion
order is preserved. Keys follow the existing HashMap scalar-key rules.

Run `apn examples/standard-library.apn` for a complete example.


## Metacircular evaluator — `std/meta`

`metaEval source` runs the supported APN core through an APN-written reader and
evaluator. `metaSelfEval evaluatorSource source` adds another evaluation layer:
it evaluates the evaluator's source, then runs the program with that evaluator.
See [the proof, supported subset and primitive boundary](metacircular-evaluator.md).

The standard-library native boundary is `seq`, `fail`, `chars`, `fromChars`,
`upper`, `lower`, and the I/O primitives `readFile`, `readStdin`, `getArgs`. Sequence search, scans, merge sort, and text splitting,
joining, replacement and trimming are implemented in APN.


## Combinators — `std/combinator`

`std` also exports the classical `combinators` record (I, K, KI, S, B, C, W,
M, T, V, B1, Q, U, Y, Z, Theta), descriptive equivalents, and shared `fix`.
All are implemented in APN. See [equations, self-application factorial, and
Haskell's type distinction](combinators.md).


## Input and puzzle utilities — `std/io`, `std/search`

`readFile path` reads UTF-8 text, `readStdin ()` reads to EOF, and `getArgs ()`
returns script arguments. `readInput ()` chooses the first file argument or
stdin (absent argument or `"-"`). These are also available through `std`.
Input is effectful; use `[input] = [readInput ()]` to share one read.

`bfsDistances neighbors starts` returns shortest unweighted distances for all
reachable scalar-key nodes. Sequence helpers include `count predicate xs`,
`repeatApply n f seed`, and finite shallow forcing with `forceList xs`.
Text helpers include `parseInt text`, `integers text`, and `nonEmptyLines text`.
See [runnable Advent of Code solutions and limits](advent-of-code.md).

## Browser modules

Explicitly import `std/html` for HTML constructors and `std/browser` for
`sandbox [init: ..., update: ..., view: ...]`. These are not automatically
imported by `std`. See [browser HTML](browser-html.md) for the API and build command.

## Process control — `std/system`

`halt` exits successfully when used (`halt = exit 0`); importing `std/system`
or `std` does not run it. The builtin `exit n` exits with an explicit status.
