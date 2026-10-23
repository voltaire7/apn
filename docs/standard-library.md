# Standard library

```apn
import ["sequence","number","text","map"]
take 10 primes
mean [1,2]                         # Some 3/2
frequencies $ words $ "one two one" # HashMap [["one",2],["two",1]]
```

The prelude, `lib/prelude.apn`, needs no import: it defines every binary
operator (`(+) = intrinsics.add`, ...; the `intrinsics` record holds the
functions APN cannot define) and its fixity, `negate` and `not` (the functions
`-x` and `!x` are), `quote` and `toAST`, and the Functor, Applicative
and Monad functions (`map`, `<$>`, `return`, `<*>`, `>>=`, `>>`, `=<<`,
`sequence`, `mapM`, `map2`–`map4`, `when`, `unless`, `return`, `throw`, `empty`, `guard`), and is in scope in every file and module. See [operators](semantics.md#defining-and-overloading-operators).

`import` accepts a literal module name or a list of literal module names.
For example, `import ["number","text"]` opens both modules and returns
a merged export record. Later modules win name collisions, and `import []`
returns an empty record. Commas or newlines separate module names, and a list
names each module once (`import ["option","option"]` is a parse error). Standard
modules are imported by name, with no prefix: `import "text"`. There is no
whole-library module; `import "std"` and `import "std/text"` are errors.
Dependencies are imported with them. Imports require Deno read permission (the
`apn` launcher already provides it).

A name is looked up next to the importing file (the current directory in the
REPL) before the standard library:

- `import "name"` imports `name.apn`;
- otherwise, if `name/` is a folder, it imports every `.apn` file directly in
  it, in name order, as one module. A name two of its files define is an
  error. Subfolders are not included; import them as `import "name/sub"`;
- when both `name.apn` and `name/` exist, the file is the package's entry and
  `name/...` reaches inside (like `lib/meta.apn` beside `lib/meta/`).

When the importing file's folder has neither, each parent folder is searched
the same way, up to the program's folder (the main program's, or the current
directory in the REPL), so `widgets/view.apn` can `import "labels"` from
`labels.apn` beside the program. The nearest match wins, and the search never
goes above the program's folder.

`examples/packages/main.apn` uses each of these: a file module, a folder
module, a subfolder package, a file that is its folder's entry, and imports
from a parent folder (`apn examples/packages/main.apn`).

A local `text.apn` therefore shadows the standard `text` module for code in
its folder and below. Each file of a module runs in its own scope of builtins,
and resolves its own imports and loads relative to its directory. Browser builds (`apn
--html`) bundle the standard library, the local modules the program imports
and the files it loads (every `.apn` file in the program's folder once a
load names a computed path), so the same imports and loads work in the
browser.

Each interpreter evaluates each module once in a scope containing builtins and
its dependencies, independent of caller bindings. Reimporting restores the same
exports without reexecuting the module. Existing local names are replaced by
imported names. A bare import statement is silent. In an expression, imports return a record: `s = import "sequence"` allows `s.sum`.
Like other lazy definitions, this form takes effect when `s` is demanded.

`use record` brings its fields into the current scope without forcing their
values. `use [recordA,recordB]` opens a finite list of records in order; later
fields replace earlier bindings. It returns `()`. Fields must be valid binding
identifiers (not quoted keys, numeric keys, `_`, or keywords). Invalid input is
rejected before any fields are installed. Bindings inside a block stay local.

```apn
combinators = import "combinator"
use combinators
identity 123

use [[first: 10], [second: 20]]
first + second                         # 30
```

`use` is an ordinary builtin function, so aliases and pipelines work too.
An APN wrapper function opens the record in its own scope, not its caller's.

List imports support the same selection: `[id,sum] = import ["function","sequence"]`.

Destructuring imports select only the requested exports: `[halt] = import "system"`
binds `halt` without introducing the module's other names.
Renaming works too: `[halt: stop] = import "system"` binds only `stop`. Unselected
local bindings remain unchanged, including when the module is already cached.

`load "file"` remains file execution (the `.apn` extension must be omitted): paths are relative to the source file,
loading executes again each time, and it uses the caller's scope; `import`
runs a module once, in its own scope.
Names without an extension receive `.apn`; explicitly supplied extensions are
used literally. `load` parses file contents as APN regardless of their extension.
`sq` lives in `number`; `halt` lives in `system`. The obsolete
`lib/core.apn` has been removed; replace its loads with these imports.

## Types — `type`

`cast Type value` is an ordinary APN compatibility wrapper for `Type value`,
implemented in `lib/type.apn` and loaded by the default prelude. Both require
lossless conversion. Use `Int (floor value)`, `Int (truncate value)`, or
`Float (inexact value)` to choose the intended rounding explicitly.
See [zero initialization](zero-initialization.md) for type defaults and inspection.

## Functions — `function`

| API | Behavior |
| --- | --- |
| `id x`, `constant x ignored` | Identity; ignore the second argument |
| `compose f g x` | `f (g x)` |
| `flip f x y` | `f y x` |
| `on f project x y` | Compare/combine projected values |
| `apply f x`, `twice f x` | Apply once or twice |
| `pair x y`, `fst pair`, `snd pair` | Two-element lists |
| `curry f x y`, `uncurry f pair` | Convert between pair and curried arguments |
| `seq value next` | Demand the outer value, then return `next`; does not deeply force lists |
| `fail message` | Raise a runtime error when demanded |

## Representations — `to` and `from` (prelude)

`to T x` writes `x` as a `T`; `from T x` reads one back. The prelude declares
`JSON` (JSON text, a named `String`); a string's characters are `List Char`.

| API | Behavior |
| --- | --- |
| `to String x`, `from String text` | Display text; read a `Bool` or number literal back (`Dynamic`) |
| `to JSON x`, `from JSON text` | JSON text; decode it (`Dynamic`) |
| `to (List Char) text`, `from (List Char) chars` | A string's characters (code points); join them |
| `to T x` for another type | Applies `T`, as a conversion: `to Float (Money 1.2)`, `to Quote [year: 1]` |
| `to [T1,T2] x` | A list template converts position by position, as `cast` does: `to [Char,Char] "hi"`; `[Char]` is exactly one `Char` |

They are methods, like `map`: a program adds a type by defining an instance,
which joins them everywhere. A bare type name in a pattern matches that type,
so an instance names its type as its first parameter (as `option` defines
`to Option (Ok x) = Some x` and `to Option (Err _) = None`):

```apn
Celsius = | C Float
Fahrenheit = | F Float
to Celsius (F f) = C ((f - 32) * 5 / 9)
to Celsius (F 212)              # C 100.0
```

## Absence and errors — `option`

```apn
Option a = Some a | None
Result a e = Ok a | Err e
```

Importing `option` also brings the Functor and Monad instances of both types
(`map`, `>>=` and `return`): `map f (Some x)` is `Some (f x)`, `None` and
`Err e` pass through, and an `Option` do-block stops at the first `None`.

| API | Behavior |
| --- | --- |
| `isSome option`, `isNone option` | Inspect presence |
| `withDefault fallback option` | Unwrap `Some`; only demand fallback for `None` |
| `map f option`, `map f result` | Transform `Some`/`Ok`, preserve `None`/`Err` (the `map` instances) |
| `option >>= f`, `f =<< option` (and for Result) | Chain a function returning an Option or Result (the `>>=` instances) |
| `mapError f result` | Transform `Err`, preserve `Ok` |
| `resultDefault fallback result` | Unwrap `Ok`, use fallback for `Err` |
| `okOr error option` | `Some x` as `Ok x`; `None` as `Err error` |
| `to Option result` | `Ok x` as `Some x`; `Err e` as `None` (Elm's `Result.toMaybe`) |
| `expect message m` | The value in `Some`/`Ok`; for `None` a runtime error with the message, for `Err e` the message and `e` |
| `unwrap m` | The value in `Some`/`Ok`, or a runtime error (`unwrap: None`, `unwrap: Err "oops"`) |

A function with one way to fail returns an `Option` (`mean`, `headOption`,
`safeDiv`, ...): `None` already says what happened. `okOr` turns it into a
`Result` where a message describes the failure, such as in a chain of steps
that report errors; `to Option` drops the message again.

These are ordinary APN variants. `Result` does not catch runtime exceptions.

## Arrays — `array`

`dot`, `transpose`, `matmul`, and `shape` are implemented in APN and included
in `std`. Numeric collection operators work without an import. See
[arrays](arrays.md) for broadcasting, shape rules, and lazy error behavior.

## Sequences — `sequence`

Existing `map`, `filter`, `take`, `drop`, `zipWith`, `iterate`, `foldl`, and
`foldr` remain builtins. Function arguments come first; data comes last for `$`.

| API | Behavior |
| --- | --- |
| `repeat x`, `replicate n x`, `cycle xs` | Infinite repetition, bounded repetition, repeated list (`cycle []` is empty) |
| `zip xs ys`, `zipWithIndex xs` | Pair corresponding values; zero-based `[index,value]` pairs |
| `concat xss`, `flatten xss`, `concatMap f xs` | Flatten one level, optionally mapping first |
| `scanl f seed xs` | Lazy running accumulators, including the seed |
| `sum xs`, `product xs` | Strict left folds with identities 0 and 1 |
| `all predicate xs`, `any predicate xs`, `contains x xs` | Short-circuiting queries |
| `find predicate xs`, `findIndex predicate xs` | First match/index as an Option |
| `headOption xs`, `lastOption xs`, `atOption n xs` | Optional access; `atOption` is zero-based and returns None for negative/out-of-range indexes |
| `takeWhile predicate xs`, `dropWhile predicate xs` | Consume a matching prefix |
| `takeUntil predicate xs` | Prefix before the first match |
| `splitAt n xs`, `splitWhile predicate xs` | `[prefix,remainder]` |
| `chunksOf n xs` | Positive-sized chunks; final chunk may be shorter |
| `intersperse separator xs` | Insert separators between elements |
| `partition predicate xs` | `[matching,nonmatching]` |
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

## Numbers — `number`

| API | Behavior |
| --- | --- |
| `sq x`, `cube x`, `sign x` | Square, cube, sign (-1/0/1) |
| `clamp lo hi x` | Inclusive bounds; reversed bounds error |
| `safeDiv x y` | `Some (x / y)`, or `None` when `y` is zero (a Float zero too, rather than an infinity) |
| `factorial n` | Nonnegative integral argument, exact result |
| `mean xs`, `median xs` | Optional arithmetic mean and median |
| `variance xs`, `standardDeviation xs` | Optional population variance and standard deviation |
| `isPrime n`, `primes` | Integer primality by trial division; infinite ascending primes |
| `fibonacci` | Infinite exact sequence starting with 0, 1 |
| `pi`, `degrees d`, `turns t` | π, and angles in radians as Elm's Basics: `degrees 180` and `turns 0.5` are `pi` |

Empty statistics return `None`. Exact inputs preserve exact arithmetic:
`variance [1,2,3]` is `Some 2/3`. Irrational square roots are inexact. Typed numeric
operations retain APN's existing overflow checks and lossless conversion rules.

## Text — `text`

| API | Behavior |
| --- | --- |
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

## Persistent maps — `map`

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


## Code as data — `syntax`

```apn
toAST (f x + 1)                        # ["+",["f","x"],1]   (prelude)
import "syntax"
fromAST (toAST (n -> n * 2 + 1))       # "n -> n * 2 + 1"
doubled e = ["*",e,2]
eval (doubled ["sqrt",16])             # 8
```

`toAST e` gives `e`, unevaluated and unchecked, as lists (a `Dynamic` value).
The prelude defines it with a [`(Quote q)` parameter](semantics.md#inspection-and-numbers),
which takes the argument's source text, and reads that text as lists:

- a leaf is a number, a Bool, a name (`"x"`, `"+"`, `"Some"`) or a literal's
  source text, quotes included (`"\"hi\""`, `"'c'"`), so `f x` is
  `["f","x"]` and `f "x"` is `["f","\"x\""]`;
- an application is a list, function first: `f x y` is `["f","x","y"]` and
  `a + b` is `["+","a","b"]`; `(2 +)` is `["+",2]`, `(+)` is `"+"`, and
  negation is a call (`-x` is `["negate","x"]`, `!b` is `["not","b"]`);
- other syntax is a list headed by a token no name can be: `["[]",...]` a
  list, `["[:]",[key,value]...]` a record, `["->",[params],body]` a lambda
  (a guard makes the body `["|",guard,body]`), `["?:",c,a,b]`, `[".",r,key]`
  (or a selection: `[".",r,["[]","x","y"]]`), `["{}",...]` a block,
  `["..",low,high]` (`[]` for no end; a step adds the second element),
  `["=",left,right]`, `["<-",left,right]`, `["()","+",x]` the section
  `(+ x)`, and `["import",...]`;
- a pattern is written as the expression it is (`Some x` is `["Some","x"]`),
  and every binding is an `"="` node: `f n = ...` is `["=",["f","n"],...]`.

Building code is building a list. `fromAST` writes such data as source,
parenthesized only where precedence needs it, which reads back as the same
data. `eval` runs it as written source runs, at the program's top level (as
Lisp's `eval` uses the global environment): its bindings stay inside it, an
action it makes is returned, not run, and its result is `Dynamic`.

`toLambda e` gives `e` as `toAST` does, desugared to a core of names,
literals, one-parameter lambdas and application, which runs as `e` does:

```apn
fromAST (toLambda { x = 10; y = x + 1; y })    # "(x -> (y -> y) (x + 1)) 10"
fromAST (toLambda (x, y -> x + y))              # "x -> y -> x + y"
fromAST (toLambda [x = 1, y = 2, x + y])        # "(x -> (y -> [x, y, x + y]) 2) 1"
eval (toLambda { fact n = n == 0 ? 1 : n * fact (n - 1); fact 5 })   # 120
```

A block's binding `x = e; rest` is `(x -> rest) e`, so a later binding of a
name is an inner lambda shadowing it, as a new version does; `x <- e; rest` is
`e >>= x -> rest`, and an action statement `s; rest` is `s >> rest`. A
binding that refers to itself is a fixed point, through Curry's Y combinator
written out, so the result needs no library. A definition with several
clauses, or patterns for parameters, is a lambda per argument and a `match`
over them; sections and `$` become lambdas and application. A list's
bindings scope over its later items as a block's do, each item being the
value its binding binds (a pattern binding's whole value, under a fresh name
`_item1`, ...). Other syntax
(`?:`, lists, records, ranges, patterns) stays as it is, its parts
desugared. `toLambda` sees only the quoted code, so a binding of a name bound
outside it that refers to that name (`x = x + 1`) is read as recursion, not
as a new version of the outer `x`.

## Metacircular evaluator — `meta`

`metaEval source` runs the supported APN core through an APN-written reader and
evaluator. `metaParse source` returns the reader's output, in `toAST`'s lists,
as `Dynamic` data, and `metaEvalSyntax` runs such data, `toAST`'s included. `metaSelfEval evaluatorSource source` adds another evaluation layer:
it evaluates the evaluator's source, then runs the program with that evaluator.
See [the proof, supported subset and primitive boundary](metacircular-evaluator.md).

The standard-library native boundary is `seq`, `fail`, `to (List Char)`,
`from (List Char)`, `upper`, `lower`, and the I/O primitives `readFile`, `readStdin`, `getArgs`. Sequence search, scans, merge sort, and text splitting,
joining, replacement and trimming are implemented in APN.


## Combinators — `combinator`

`std` also exports the classical `combinators` record (I, K, KI, S, B, C, W,
M, T, V, B1, Q, U, Y, Z, Theta), descriptive equivalents, and shared `fix`.
All are implemented in APN. See [equations, self-application factorial, and
Haskell's type distinction](combinators.md).


## Input and puzzle utilities — `io`, `search`

`readFile path` is the action reading UTF-8 text, `readStdin` reads to EOF
(once: every run yields the same text), and `getArgs` yields the script
arguments. `readInput` chooses the first file argument or stdin (absent
argument or `"-"`). Run one with `<-`: `input <- readInput`.

`bfsDistances neighbors starts` returns shortest unweighted distances for all
reachable scalar-key nodes. Sequence helpers include `count predicate xs`,
`repeatApply n f seed`, and finite shallow forcing with `forceList xs`.
Text helpers include `parseInt text`, `integers text`, and `nonEmptyLines text`.
See [runnable Advent of Code solutions and limits](advent-of-code.md).

## HTTP — `http`

`fetch url options` is the action sending one request; it yields the
response, whatever its status, as a record:

| Field | Value |
| --- | --- |
| `status`, `ok`, `statusText` | `Int`, `Bool` (a 2xx status), `String` |
| `url` | the final URL, after redirects |
| `headers` | a `HashMap` by lowercase name (`lookup "content-type" r.headers`) |
| `body` | the body as text |

`options` is a record whose fields are all optional, or `[]` for none: `method`
(`"GET"` by default), `headers` (a record or a `HashMap` of strings), `body`
(a `String`) and `timeout` (milliseconds). Any other field is an error. Options
and header names are bare keys (`Content-Type: "application/json"`); a quoted
key (`"Content-Type": ...`) is a different key and an error here.

```apn
import ["http","json"]
response <- fetch "https://www.youtube-transcript.io/api/channels" [
    method: "POST"
    headers: [
        Authorization: "Basic <your-api-token>"
        Content-Type: "application/json"
    ]
    body: to JSON [ids: ["jawed"]]
]
channels = from JSON response.body
```

`fetchText url options` yields a successful (2xx) response's body and fails
with the status otherwise; `fetchJson url options` decodes that body as JSON.
All three are actions: `body <- fetchText url []`.
A request that gets no response (no network, a refused connection, a timeout)
fails with the reason. Requests are synchronous, like the rest of APN; Ctrl+C
in the REPL interrupts a slow one (abandoning it), and `timeout` bounds one in
a script. Network access
needs Deno's `--allow-net` (the `apn` launcher grants it). Static checking
never sends a request; `data:` URLs need no network. In a browser build,
`fetch` uses a synchronous request, subject to the page's CORS rules, and
`get [url: ..., expect: ...]` is a [command](browser-html.md#elements-commands-and-subscriptions)
sending one without blocking.

## JSON — `json`

`to JSON value` (prelude) is `JSON.stringify`, `prettyJson value` the same
indented by two spaces, and `from JSON text` (prelude) is `JSON.parse`:

| APN | JSON |
| --- | --- |
| record, `HashMap` with string keys | object, each key's text as it is |
| list (also lazy or a range, if finite) | array |
| `String`, `Char` | string |
| `Int` (exact, any size), `Float` | number |
| `Bool` | `true`, `false` |

A fraction, complex number, variant or function has no JSON form and is an
error; convert it first. A record key's text is the JSON key, so a bare key
`status` writes `"status"` and a quoted key `"status"` keeps its quotes; they
never collide. `from JSON` returns an object as a record of bare keys with the
JSON keys' text (`r.status`, `r "odd-key"`), an integer as an exact `Int`,
other numbers as `Float`, and `null` as `[]`, so `from JSON (to JSON v)` gives
back `v`. Its result is `Dynamic`; give it a type with a
pattern or `cast` where the program needs one.

## Browser modules

Modules for browser programs, after Elm's packages of the same names. See
[browser HTML](browser-html.md) for their APIs and the build commands.

| Module | Provides |
| --- | --- |
| `html` | HTML elements, attributes and events |
| `browser` | `sandbox`, `element`, `none`, `batch`, `getViewport`, and the event subscriptions |
| `svg` | SVG elements and attributes |
| `task` | `perform` and `attempt`: commands running an action |
| `time` | `Posix`, `Zone`, `now`, `here`, `every`, `toHour` ... `toMillis` |
| `random` | generators and `generate` |
| `decode` | JSON decoders |
| `file` | file pickers, `download` and `toUrl` |
| `playground` | pictures, animations and games from shapes |
| `gallery` | an examples site's index page: `page`, `examples` (a section) and `link` |

`random` and `decode` share names (`int`, `float`, `list`), as do `svg` and
`playground` (`circle`, `image`): a program using both of a pair imports one
qualified (`random = import "random"`; `random.int 1 6`). Each alone may be
opened, as Elm's examples open `Json.Decode`.

## Process control — `system`

`halt` exits successfully when used (`halt = exit 0`); importing `system`
or `std` does not run it. The builtin `exit n` exits with an explicit status.

Constructor declarations use capitalized bindings: `Option a = Some a | None`.
A new capitalized name also supports a single constructor: `Box a = Box a`.
An already declared constructor on the left remains a destructuring pattern
unless `|` introduces alternatives. Neither `type` nor `data` is a keyword.

A leading `|` is optional, and alternatives can span lines:

```apn
Option a =
    | Some a
    | None
```

Use a leading `|` to explicitly declare a single constructor when its name
is already in scope, e.g. `Box a = | Box a`.

## Creative coding — `p5`, `glsl`

`import "p5"` exposes `sketch callbacks`, `canvas callbacks` for a sketch
inside an HTML view, the `Sketch` type of a callback's `p`, the objects
(`loadImage`, `createGraphics`, `buildGeometry`, ...), shaders with hooks in
APN (`buildFilterShader`, `buildColorShader`, `buildMaterialShader`), and
p5's calculations (`remap`, `lerp`, `constrain`, `dist`, and vectors: `mag`,
`normalize`, `setMag`, `limit`, `heading`, `fromAngle`). `glsl` makes GLSL
expressions APN values: arithmetic and the math functions on a `Glsl` write
GLSL, with `vec`, `swizzle`, `fract`, `distance`, `mix`, `getTexture` and
`call name args` for any other function. See the [p5 reference](p5.md).

## Matching

`match value handlers` is an intrinsic function available without importing std.
It selects the first matching unary function from a lazy list of alternatives.
See [pattern functions and contracts](pattern-functions.md).

A bare `load "file"` in the REPL runs the file without automatically displaying
its exported record. This avoids forcing unused exports such as infinite lists.
Explicit output in the file still prints. Use `module <- load "file"` to retain
the record, then inspect selected fields. Explicit `print (load "file")` still
requests the full record and can stream indefinitely if it contains infinite lists.

## Resource scopes and type utilities

`function` exports `bracket acquire release use`; `io` exports
`withFile path use`. Both are actions; an acquire, use or release that is an
action runs in turn. Returned data is completed before cleanup.
`assert` is available without imports.
See [type and resource rules](type-and-resource-rules.md) for examples and limits.
