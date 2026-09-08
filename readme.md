# APN

A lazy functional scripting language implemented in dependency-free Deno/TypeScript.

Run these commands from the repository root:

```sh
./apn                              # interactive REPL
./apn examples/features.apn         # runnable language showcase
./apn playground/test.apn           # your scratch program
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
| `playground/` | Personal scratch programs |

From a REPL started in the repository root, use `load "lib/core.apn"`.
Inside files, imports are relative to that source file; examples and playground
programs use `load "../lib/core.apn"`.

`main.ts` is the entry point and `apn` is the shell launcher. Contributor
instructions are in [AGENTS.md](AGENTS.md).
