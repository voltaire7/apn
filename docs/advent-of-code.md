# Advent of Code in APN

Three first-part solutions exercise text input, sequence processing, exact
counting and graph traversal. The puzzle logic and reusable algorithms are APN;
new natives are limited to file input, stdin input, and command-line arguments.

Run from the repository root:

```sh
apn examples/advent-of-code/run-sonar.apn examples/advent-of-code/samples/sonar.input
# 7
apn examples/advent-of-code/run-fish.apn examples/advent-of-code/samples/fish.input
# 5934
cat examples/advent-of-code/samples/hill.input | apn examples/advent-of-code/run-hill.apn
# Some 31
```

Replace the sample path with your downloaded puzzle input. No login, input
download, or answer submission is automated. These examples cover part one;
`fishPopulation days text` also supports longer simulations such as 256 days.

| Puzzle | Solver | Published sample answer |
| --- | --- | --- |
| [2021 day 1: Sonar Sweep](https://adventofcode.com/2021/day/1) | `sonar-sweep.apn` | 7 |
| [2021 day 6: Lanternfish](https://adventofcode.com/2021/day/6) | `lanternfish.apn` | 5934 after 80 days |
| [2022 day 12: Hill Climbing](https://adventofcode.com/2022/day/12) | `hill-climbing.apn` | 31 steps |

Samples are small public examples from the linked puzzle pages, stored as raw
`.input` data. Solver files define functions without reading input; `run-*.apn`
files supply the input and print the answer. Unreachable hill paths return None.

## Input

```apn
import "std/io"
text = readFile "input.input"
args = getArgs
input = readInput ()
```

`apn program.apn first second` makes `getArgs` return `["first", "second"]`.
`readInput []` reads the first argument as a file, or all stdin when there is no
argument or the first argument is `"-"`. `readStdin` explicitly reads stdin
to EOF; stdin is read once, and every call returns the same text. File paths resolve against the process working directory. Text input is
UTF-8; stdin decoding handles multibyte characters spanning read buffers.

Input calls are effects. APN application bindings are repeatable actions; to
read once and share the result use `[input] = [readInput ()]`. Stdin helpers are
intended for script execution, not simultaneous use with the interactive REPL
editor. `load` still executes APN source and is distinct from `readFile`.

## Library additions

| API | Behavior |
| --- | --- |
| `integers text` | Whitespace-separated exact integers, including signs |
| `parseInt text` | Parse an exact integer; reject fractional/inexact values |
| `nonEmptyLines text` | Trim lines and discard blanks; accepts CRLF |
| `count predicate xs` | Count matching elements with a strict fold |
| `repeatApply n f seed` | Apply f exactly n times; require a nonnegative integer count |
| `forceList xs` | Demand each element of a finite list to its outer value |
| `bfsDistances neighbors starts` | Multi-source unweighted shortest-path distances as a HashMap |

BFS visits each discovered key once, marking it before enqueueing. It uses
level frontiers and handles duplicate edges, duplicate starts, cycles, and an
empty set of starts. Nodes must obey HashMap's scalar-key restriction. The hill
solver maps grid coordinates to integer indexes and stores characters in a map,
so repeated coordinate lookup does not traverse a list.

The fish solver stores nine timer counts instead of individual fish. It forces
those nine counts at each step, preventing a long deferred arithmetic chain.
BFS similarly demands each level's depth before the next iteration.

## Validation and practical limits

```sh
deno test --allow-read tests/advent-of-code-test.ts
```

Tests check all three published sample answers, malformed input, CRLF, empty
and singleton sonar data, unreachable grids, cycles and duplicate BFS edges,
2,000 increasing sonar measurements, 256 fish generations, a 2,000-character
field, and a 1,000-edge path. File arguments and both stdin invocation forms
are also checked manually through the launcher.

On the development machine, the 2,000-reading sonar test took about one second,
256 fish generations a few milliseconds, and a 1,000-edge path about 50 ms.
These are illustrative single-run measurements, not performance guarantees.

This is enough to solve these representative puzzles in short APN programs;
it does not establish that every Advent of Code puzzle is practical yet.
Persistent HashMap updates currently copy the underlying map, so BFS map work
can become quadratic as the visited set grows. Sets, efficient priority queues,
structural map keys, and broader parser utilities remain future work. Solutions
also assume the expected puzzle-input shape; diagnostics are useful but are
not a general schema-validation framework.
