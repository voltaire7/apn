# APN

A lazy functional scripting language implemented in dependency-free Deno/TypeScript.

Run these commands from the repository root:

```sh
./apn                              # interactive REPL
./apn examples/features.apn         # runnable language showcase
deno check main.ts
deno test tests/*-test.ts
```

| Directory | Contents |
| --- | --- |
| `src/` | Lexer, parser, interpreter, runtime values, and REPL |
| `lib/` | Standard library (`core.apn`) |
| `examples/` | Runnable feature showcase |
| `tests/` | Evaluation regression tests |
| `docs/` | [Evaluation semantics](docs/semantics.md) |

From a REPL started in the repository root, use `load "lib/core.apn"`.
Inside files, imports are relative to that source file; examples use
`load "../lib/core.apn"`.

To make `apn` available on PATH (with Deno installed):

```sh
ln -s "$PWD/apn" /opt/homebrew/bin/apn
apn ~/Desktop/test.apn
```

Keep personal scratch programs outside the repository.

`main.ts` is the entry point and `apn` is the shell launcher. Contributor
instructions are in [AGENTS.md](AGENTS.md).
