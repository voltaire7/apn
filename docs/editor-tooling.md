# Linter and Neovim language server

The linter checks APN source without executing it. The language server runs that
same checker as you edit and sends diagnostics and other editor information to
Neovim over its standard LSP connection. Neither command evaluates imports,
loads files named by APN code, runs effects, or forces lazy values.

## Try locally without changing your configuration

From the APN repository:

```sh
./editors/neovim/try-apn examples/editor-playground.apn
```

This loads your normal Neovim configuration, including LazyVim, then adds APN
support for that session. Your theme, plugins, and keybindings stay available.
It does not edit your configuration or install an APN plugin. Close Neovim to
stop the experiment. Normal Neovim/plugin persistence still applies.
Requires `deno` and Neovim 0.11 or newer on PATH.

For an optional isolated session without your plugins, use:

```sh
./editors/neovim/try-apn --clean examples/editor-playground.apn
```

In the playground, delete the right side of a definition to see a diagnostic;
restore it and the diagnostic disappears without saving. In this session:

| Action | Keys / command |
| --- | --- |
| Complete a name | Insert mode: `Ctrl-X Ctrl-O` |
| Hover over a name | `K` |
| Show diagnostic details | `:lua vim.diagnostic.open_float()` |
| Next / previous diagnostic | `]d` / `[d` |
| Document outline | `:lua vim.lsp.buf.document_symbol()` |
| Confirm connection | `:checkhealth vim.lsp` |

To add the same support to an already-running Neovim session, run:

```vim
:luafile /Users/voltaire/Code/hobby/apn/editors/neovim/apn.lua
```

This enables APN support only for that Neovim session, including already-open APN
buffers. It changes APN buffer options and adds APN buffer mappings; your config
files stay untouched. Normal completion plugins can use the server, and built-in
`Ctrl-X Ctrl-O` completion remains available. If you later want it permanently,
you can source the Lua file from your config; that is optional.

## Command-line lint

```sh
apn --lint examples/editor-playground.apn
apn --lint --json examples/editor-playground.apn examples/features.apn
```

Clean files produce no text output. Errors use `file:line:column` (one-based),
with the lexer/parser's message. JSON output has one entry per file containing
`file` and `diagnostics`, or `file` and `error` for a file-read failure. JSON
ranges use zero-based UTF-16 positions, matching LSP. Exit status is 0 for clean
files (including warning-only results), 1 for errors, and 2 for missing file arguments.

The linter checks syntax and APN's strict layout rules. It reports the
first parse/lex error in each file, because the parser does not yet recover after
an error. It does not claim to detect undefined variables, runtime
errors or general type errors. It warns about a parameter its body never uses
(`f x y = x` warns about `y`; write `_` to discard it), including a name a
typed pattern's type binds (`a` in `first (x::_ : List a) = x`; a name
repeated in another parameter's type is a use). Names starting with `_`
are exempt. It warns about a clause that
[never runs](semantics.md#functions-and-conditionals) because an earlier one
takes any argument (`f xs = 0` then `f [a,b] = a + b`), and about a `match`
alternative after one that takes any value. The constructors it knows are
the program's and those its imports, `load` statements (`load "f"`, also
`(load "f" : Dynamic)`) and `use` statements declare, where `use` opens a record
bound to an import or a load (`opt = import "option"; use opt`), written in
place, or a list of them: it resolves each from the file's folder as the
interpreter does and reads (never runs) it, so a file it cannot read declares
nothing. It warns
about a literal zero divisor (`x / 0`, `x % 0`, `quotient x 0`, `remainder x 0`,
`modulo x 0`), which fails when demanded; `/` with a Float on either side is IEEE
division and is not reported. Laziness keeps these warnings rather than errors:
an expression nothing demands never fails. It warns when a function calls
itself with no smaller argument where the call is certainly evaluated (its
body, a branch, an arithmetic operand): `up n = up (n + 1)` may never finish.
An argument is smaller when a parameter's pattern took it apart (`xs` from
`x::xs`, `k` from `S k`), or it is `n - 1` or `tail xs`. A call under a lazy
constructor (`nats n = n :: nats (n + 1)`), in another function's argument, a
lambda or a block (an action's loop) is not reported. It also issues conservative variant-exhaustiveness
warnings for statically recognizable matches; see [type and resource rules](type-and-resource-rules.md). `_` placeholders are valid syntax.

## Server capabilities

`apn --lsp` runs the stdio language server. The Neovim integration invokes
`deno run --allow-read=/path/to/apn/lib /path/to/apn/main.ts --lsp`
directly. This grants read access only to the standard library: the prelude
needed during startup, and the modules completion offers. It does not grant
arbitrary file access or network permissions; without access to `lib/`,
completion offers only the standard natives. Standard output is reserved for LSP messages.

- Diagnostics on opening or changing a document; closing clears them.
- Completion for built-ins, type constructors, keywords, identifiers in the
  current document, and the standard library's exports. Accepting a standard
  name whose module is not imported yet adds the import: into the first
  one-line import, which becomes a list (`import "io"` becomes
  `import ["io","sequence"]`), or as `import "sequence"` on the first line,
  followed by a blank line.
  Document identifiers are lexical suggestions, not validated scope
  resolution. On invalid source, built-in completion remains available.
- APN applies functions without parentheses, so the Neovim integration adds
  `apn` to blink.cmp's filetypes that never get `()` after a completed
  function. With your own setup, set
  `completion.accept.auto_brackets.blocked_filetypes = { "apn" }` in blink.cmp.
- Hover shows matching top-level declarations or built-in arity/type information.
  It is a declaration reference, not inferred type information; local shadowing
  and imported definitions are not resolved.
- Syntax colors match the terminal and the web editor (one tokenizer and
  palette, `src/highlight.ts`): yellow numbers, green strings/chars, blue
  built-ins, cyan constructors, mauve booleans/import, peach operators and
  numeric markers, gray punctuation/assignment, and muted comments. Ternary
  colons are peach; record/cons colons are gray. Colors remain available on
  incomplete source, and are scoped to APN so your LazyVim theme is unchanged.
- A top-level document outline for named definitions and type declarations.

The server negotiates full document synchronization and UTF-16 positions.
Documents are parsed independently; constructor declarations never leak across
files or older edits. Import resolution, go-to-definition, rename, and formatting
are not implemented yet. Optional type diagnostics are described below.

The integration uses Neovim's built-in [`vim.lsp.start`](https://neovim.io/doc/user/lsp#vim.lsp.start()).
The server implements the relevant parts of the
[Language Server Protocol](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/).

For relaxed spacing (as `apn --loose`), pass `init_options = { looseSpacing = True }`.
For optional type diagnostics, pass `init_options = { typeChecking = True }`
to the APN LSP configuration, or use `apn --lint --types FILE.apn` independently.
See [Static checking and dependent patterns](gradual-and-dependent-types.md) for supported
checks and dynamic boundaries.
