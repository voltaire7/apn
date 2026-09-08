# APN

A lazy functional scripting language implemented in dependency-free Deno/TypeScript.

Run these commands from the repository root:

```sh
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
| `docs/` | [Evaluation semantics](docs/semantics.md) |

Import the standard library from any directory:

```apn
import "std"
take 10 primes
mean [1,2]                         # Some 3/2
"one two one" $ words $ frequencies
```

Load individual modules with `import "std/text"`, `import "std/map"`, etc.
See the [standard library reference](docs/standard-library.md) or run
`apn examples/standard-library.apn`. Imports are cached; `load "file.apn"`
executes a file each time, relative to the current source file.

To make `apn` available on PATH (with Deno installed):

```sh
ln -s "$PWD/apn" /opt/homebrew/bin/apn
apn ~/Desktop/test.apn
```

Keep personal scratch programs outside the repository.

`main.ts` is the entry point and `apn` is the shell launcher. Contributor
instructions are in [AGENTS.md](AGENTS.md).
