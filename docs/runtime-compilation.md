# Runtime compilation (design note)

**A prototype.** This records a planned feature and the questions it leaves
open; a prototype of it runs on the current interpreter (see
[the prototype](#the-prototype)). The rest describes the design, not settled
behavior; [semantics](semantics.md) does that.

## The idea

A program compiles another while it runs:

```apn
main = print "hi"
opts = []
compile main opts
```

`compile entry opts` is an action, as every effect is: run, it writes an
executable that runs `entry`. `opts` says how: the executable's name, its
target platform, and so on.

This reverses Jai, which runs arbitrary code at compile time. Here compiling
happens at run time, so whatever the program computed before `compile` is
already a value: a table, a parsed configuration, code it generated. There is
no second, compile-time language, and the static checker still never performs
an effect (see [gradual and dependent types](gradual-and-dependent-types.md)):
the effect is `compile`, an ordinary action.

A build is then an ordinary program, which may compile several executables:

```apn
targets = [Linux, MacOS, Windows]
for target in targets compile main [name = "hi", target = target]
```

(The loop's spelling is illustrative.)

## Options

`opts` is a record of a declared type, so `[]` is every default
([zero initialization](zero-initialization.md)) and a program sets only what
it needs:

```apn
Options = [name : String, target : Target, optimize : Bool]
compile main ([target = Browser] : Options)
```

`apn --html` would become such a call (`target = Browser`): a command-line mode
turned into a library function, as the language prefers.

## What an entry carries

`compile` is given a value, not source: `main` and everything it reaches
(definitions, closures and their environments, instances that travel with
values). The executable is a snapshot of that part of the running program, as
Lisp's `save-lisp-and-die` or Julia's PackageCompiler make one. Open questions:

- **Laziness.** A value not yet computed travels as code, one already computed
  as data. Whether `compile` forces anything first, or only what is computed,
  is open.
- **Mutable cells.** A cell is most likely captured with its contents when
  `compile` runs, each executable starting from them.
- **Resources.** An open file, a network connection or a C pointer cannot
  travel. `compile` should refuse them, naming each, rather than write an
  executable that fails later.
- **Checking.** `compile` can check what it captures statically, so the
  executable runs without checking, with no checking cost at startup. What a
  `Dynamic` boundary leaves to the run stays a runtime check.
- **The prelude and modules.** What the entry uses of them travels with it,
  as any other definition does.

## The prototype

`compile entry opts` is a native action. `opts` is a record of `name` (the
executable, `main` by default) and `target`: `"native"` (the default, an
executable for this machine), `"js"` (`name.js`, a script `deno run` runs), or a
platform triple (`x86_64-pc-windows-msvc`, `aarch64-apple-darwin`, ...). It
writes a snapshot (`src/snapshot.ts`) with the interpreter that runs it
(`src/compiled-main.ts`), which Deno bundles or compiles (`src/compile.ts`):

```apn
std <- import "std"
use std.io
greeting <- return "made before compile ran"
count = Mutable 10
set count 42
main = {
    print greeting
    print (count + 0)
    args <- getArgs
    print args
}
compile main [name = "demo"]
```

`./demo one two` prints `made before compile ran`, then `42`, then `["one","two"]`.
How the snapshot answers the questions above, for now:

- A definition travels as its code and scope, which the executable evaluates
  again (only actions have effects, so it gives the same value); a value an
  action gave, or one already computed whose scope is gone, travels as data.
  The runtime's own natives, types and prelude travel by name, and the method
  instances a program added with them.
- A cell travels with its contents when `compile` ran.
- A value that cannot travel (one a native was still computing, an action
  already made, a C pointer) is an error where the executable uses it, not
  when `compile` runs, so a program can compile an entry that never touches it.
- The executable runs unchecked; `compile` does not check what it captures yet.
  Errors in it lose their source positions.
- A native executable embeds Deno's runtime (about 100 MB); its permissions are
  fixed (read, write, network, environment). A platform other than this one
  needs Deno to download that runtime once.

## Plan

1. Done as a prototype: the program a captured snapshot, with Deno's runtime
   as the executable's. Still to decide: refusing what cannot travel when
   `compile` runs, checking what it captures, permissions as options, and
   `apn --html` as a `compile` target.
2. Native executables with the Rust interpreter: its runtime with a serialized
   snapshot. A target platform is the runtime built for it.
3. Generating native code, if ever, after that.
