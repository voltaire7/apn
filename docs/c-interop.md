# C interop

APN calls shared C libraries through Deno FFI. No new call syntax is required:

```apn
ffi = import "ffi"
ffi.withLibrary "./libmath.dylib" [
    add: ffi.function [Int32, Int32] Int32
] c -> {
    print (c.add 20 22)  # Int32 42
}
```

The full record key string must match the exported C symbol name. Use `add:`
for the C symbol `add`, accessed with `c.add` or `c "add"`. Quoted field syntax
includes literal quotes in the symbol name. `ffi.function` is written in
APN; it builds `[parameters: ..., result: ...]`. `withLibrary` is an action:
running it loads the library, passes a record of curried functions to its
callback, runs the callback's result if that is an action, and closes the
library in `finally`, including after an APN error. C calls themselves are not
wrapped in IO: they run where they are evaluated, an escape hatch from purity
(as are `allocate`, `peek` and `poke`); keep them inside the callback's
do-block. Relative paths resolve against the APN
source directory (the working directory in the REPL).

## Try it

From the repository root, with Deno and a C compiler on PATH:

```sh
./examples/c-interop/run-demo
./examples/c-interop/run-donut       # Ctrl+C stops and restores the terminal
./examples/c-interop/run-donut 120   # finite animation
```

The scripts support macOS and Linux and build temporary shared libraries with
`cc`. The demo exercises integers, strings and writable pointers. The
donut follows the torus projection and luminance algorithm from the original C
example: C renders/paces a frame; APN calculates angles and consumes frames with
lazy `map` and `takeWhile`. It fits within the current terminal on startup and
restores its alternate screen/cursor on completion, interruption, or unloading.

## Permissions

For an APN program that uses pointer memory or C string results:

```sh
apn --allow-ffi program.apn
```

For scalar calls alone, permission can be restricted to the library:

```sh
apn --allow-ffi=/absolute/path/libmath.dylib program.apn
```

Normal `apn` does not grant FFI permission automatically. `run-demo` explicitly
enables unrestricted FFI for pointer operations; `run-donut` restricts permission
to its temporary library. Deno requires unrestricted FFI for its unsafe pointer
APIs even when the shared library itself is allowed by path. The Neovim LSP
and linter never load libraries or execute C code.

C runs with the process's privileges. Incorrect signatures, invalid external
pointers, retaining borrowed buffers, or C memory bugs can crash the process;
APN cannot validate a native ABI or guarantee external memory safety. Use libraries
and signatures you trust. See [Deno FFI](https://docs.deno.com/runtime/fundamentals/ffi/).

## C signatures

| APN type | C ABI | Notes |
| --- | --- | --- |
| `Int8`, `UInt8` | `int8_t`, `uint8_t` | 8-bit integers |
| `Int16`, `UInt16` | `int16_t`, `uint16_t` | 16-bit integers |
| `Int32`, `UInt32` | `int32_t`, `uint32_t` | 32-bit integers |
| `Int64`, `UInt64` | `int64_t`, `uint64_t` | Exact BigInt transport |
| `Float32` | `float` | Binary32 |
| `Float` / `Float64` | `double` | Binary64 |
| `Bool` | `_Bool` / `bool` | C boolean, not an arbitrary int |
| `Pointer` | pointer | Opaque address, including null |
| `String` | `const char *` | NUL-terminated UTF-8 |
| `[]` | `void` return | Result only; use `[]` for no parameters |

Native numeric results retain their APN type: `add` above returns `Int32 42`.
Arguments convert only without loss. Out-of-range integers and lossy float
conversions fail before the C function is called. Float32 arithmetic rounds to binary32;
constructors and `cast` require lossless conversion even for bare literals. Unbounded `Int`, `UInt`, fractions, complex
numbers, and aggregate numeric types are not C ABI descriptors. Match platform
`long` and `size_t` to the appropriate fixed width yourself.

A C function with no parameters is a zero-argument APN action:

```apn
# greeting: ffi.function [] String
print c.greeting
```

A bare `c.donut_finish` statement calls it. In `print c.greeting`, APN calls
`greeting` when its value is needed. Separate calls repeat their effects; unused
lazy expressions do not run them. `c.greeting []` remains valid for compatibility,
but [] is optional. Functions with parameters keep normal curried application.

Input strings are temporary UTF-8 buffers valid for the duration of that call;
C must not retain them. Embedded NULs are rejected. Returned String pointers must
point to a valid NUL-terminated UTF-8 string; APN copies it immediately. A null
String result is an error. Use a `Pointer` result instead for nullable pointers
or memory with an explicit native ownership protocol.

## Pointer memory

```apn
ffi = import "ffi"
p = ffi.allocate Int32 2
set p $ 41
ffi.peek Int32 p                # Int32 41
ffi.poke Int32 99 (ffi.offset 4 p)
ffi.peek Int32 (ffi.offset 4 p) # Int32 99
```

`p = ffi.allocate ...` retains the same allocation on repeated use, like a
`Mutable` binding. A parameterized factory creates a fresh allocation per call.
Pointers do not implicitly dereference during arithmetic; use `peek` explicitly.

| Operation | Behavior |
| --- | --- |
| `ffi.allocate Type count` | Zeroed, GC-managed memory for numeric/Bool scalars; maximum 64 MiB per allocation |
| `ffi.peek Type pointer` | Read one scalar using native byte order |
| `ffi.poke Type value pointer` | Write one scalar; returns [] |
| `set pointer $ value` | Write using an APN allocation's element type |
| `ffi.offset bytes pointer` | Nonnegative byte offset, retaining backing memory and remaining bounds |
| `ffi.nullPointer []` | Null Pointer value |
| `typeOf pointer`, `isType Pointer pointer` | Normal type inspection |
| `(Pointer p)` | Pattern binding the pointer itself |

Null dereferences and known allocation-bound violations are errors. C pointer
round trips retain input memory and bounds when they refer to a known allocation.
External C pointers have unknown bounds; the caller must ensure valid, writable
memory for `poke`. Use the library's own free function for C-owned heap memory,
exactly as its API requires. APN cannot detect memory freed directly by C.
`set` on an untyped external pointer requires an explicit `poke Type` instead.

The library stays open only during the callback. Functions and library pointers
that escape it reject later use. The callback's outer result is demanded before
closing; lazy list/record fields are not recursively forced. Complete any C calls
inside the callback before returning their results (for example, print there or
use `forceList` from `sequence` for a finite list). APN-managed allocations
are freed by garbage collection once no pointer aliases retain them.

This version supports synchronous fixed-signature functions. Structs by value,
variadic functions, C-to-APN callbacks, and automatic header parsing are not yet
implemented. Use small C wrappers when a library needs those features. FFI is
CLI-only, not available in generated browser programs.

## Verification

```sh
./tests/run-c-interop-tests
```

This compiles the included C fixture and runs real ABI, string, pointer, bounds,
and lifetime tests. The regular `deno test --allow-read tests/*-test.ts` run skips
native fixture tests unless a compiled library path is supplied to that test.
