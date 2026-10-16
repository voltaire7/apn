# APN

A lazy, pure functional scripting language implemented in dependency-free
Deno/TypeScript. Effects are IO actions that statements and `x <- action` run;
operators are ordinary functions defined in the prelude.

Requires Deno 2.8.0 or newer (`deno upgrade` updates an older install); the
`apn` launcher checks this before starting.

Run these commands from the repository root:

```sh
./apn --help                       # command-line options
./apn                              # interactive REPL
./apn examples/features.apn         # runnable language showcase
deno check main.ts
deno test --allow-read tests/*-test.ts
```

| Directory | Contents |
| --- | --- |
| `src/` | Lexer, parser, interpreter, runtime values, and REPL |
| `lib/` | Modular standard library |
| `examples/` | Runnable feature showcase |
| `tests/` | Evaluation regression tests |
| `docs/` | [Evaluation semantics](docs/semantics.md), [templates and types](docs/templates-and-types.md), [zero initialization](docs/zero-initialization.md), [operator precedence](docs/semantics.md#operator-precedence-and-associativity), [IO actions](docs/semantics.md#io-actions) |

Import standard modules by name from any directory (and your own files or
folders the same way, see [the standard library](docs/standard-library.md)):

```apn
import ["sequence","number","text","map"]
take 10 primes
mean [1,2]                         # Some 3/2
frequencies $ words $ "one two one"
```

Load individual modules with `import "text"`, `import "map"`, etc.
See the [standard library reference](docs/standard-library.md) or run
`apn examples/standard-library.apn`. Imports are cached; `load "file"`
executes a file each time, relative to the current source file.

APN can also evaluate its own core. See the
[metacircular evaluator](docs/metacircular-evaluator.md):

```sh
apn examples/metacircular.apn
deno run --allow-read examples/metacircular-self.ts  # evaluator evaluating itself
```

Try the [Advent of Code examples](docs/advent-of-code.md) with a file or stdin:

```sh
apn examples/advent-of-code/run-sonar.apn examples/advent-of-code/samples/sonar.input
cat examples/advent-of-code/samples/fish.input | apn examples/advent-of-code/run-fish.apn
```

To make `apn` available on PATH (with Deno installed):

```sh
ln -s "$PWD/apn" /opt/homebrew/bin/apn
apn ~/Desktop/test.apn
```

Keep personal scratch programs outside the repository.

`main.ts` is the entry point and `apn` is the shell launcher. Contributor
instructions are in [AGENTS.md](AGENTS.md).

Build [browser apps](docs/browser-html.md) with APN HTML functions and an
`init` / `update` / `view` loop:

```sh
apn --html examples/browser/counter.apn counter.html
open counter.html
```

Ordinary file execution only defines the counter; `--html` builds its browser runtime.

Create animated canvas sketches with the [p5.js bindings](docs/p5.md):

```sh
apn --html examples/browser/p5-sketch.apn p5-sketch.html
open p5-sketch.html
```

All of [Elm's examples](https://elm-lang.org/examples) are recreated in
`examples/elm`, with commands, subscriptions, SVG, p5 canvases inside views
and a Playground. Build them as a site with an in-browser editor:

```sh
apn --site examples/elm site
open site/index.html
```

## Editor support

Run `apn --lint file.apn` to check syntax and layout without executing the file.
Spacing is strict (`x = 1`, `[1,2,3]`, `[x: 1, y: 2]`, `{ x }`) and lines hold at most 99
characters; put `--loose`
first (`apn --loose file.apn`) to relax it. `apn --version` prints the version.
Try live diagnostics, completion, hover, and an outline in a temporary Neovim
session with `./editors/neovim/try-apn examples/editor-playground.apn`.
The launcher loads your usual Neovim/LazyVim setup; its configuration files stay untouched.
See [editor tooling](docs/editor-tooling.md) for session-only LazyVim setup and limitations.

## C interop

`import "ffi"` exposes typed native calls and `Pointer` memory access.
Run `./examples/c-interop/run-demo` for a compiled C example, or
`./examples/c-interop/run-donut` for a terminal donut driven by APN (Ctrl+C stops).
The scripts build temporary libraries using `cc`; nothing is installed.
See [C interop](docs/c-interop.md) for signatures, pointers, permissions, and lifetimes.

Static checking and inference run by default, including in the REPL:

```sh
apn --check examples/types/dependent-vectors.apn
apn examples/types/dependent-vectors.apn
```

See [Static checking and dependent patterns](docs/gradual-and-dependent-types.md) for
`Vect n t`, inferred pattern binders, strict checking boundaries, and editor setup.
`apn file.apn`, the REPL, and `--check` reject implicit, unresolved dynamic boundaries.
`--check` checks dependencies without executing code.
Explicit `Dynamic` boundaries retain runtime checks; see
[the runnable example](examples/types/dynamic-boundaries.apn).
Gradual editor diagnostics remain available.
