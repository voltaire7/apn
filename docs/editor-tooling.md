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
files, 1 for errors, and 2 for missing file arguments.

The initial linter checks syntax and APN's strict layout rules. It reports the
first parse/lex error in each file, because the parser does not yet recover after
an error. It does not claim to detect undefined variables, unused names, runtime
errors, exhaustiveness, or type errors. `_` placeholders are valid syntax.

## Server capabilities

`apn --lsp` runs the stdio language server. The Neovim integration invokes
`deno run main.ts --lsp` directly, without granting runtime file or network
permissions. Standard output is reserved for LSP messages.

- Diagnostics on opening or changing a document; closing clears them.
- Completion for built-ins, type constructors, keywords, and identifiers in the
  current document. Document identifiers are lexical suggestions, not validated
  scope resolution. On invalid source, built-in completion remains available.
- Hover shows matching top-level declarations or built-in arity/type information.
  It is a declaration reference, not inferred type information; local shadowing
  and imported definitions are not resolved.
- A top-level document outline for named definitions and type declarations.

The server negotiates full document synchronization and UTF-16 positions.
Documents are parsed independently; constructor declarations never leak across
files or older edits. Import resolution, go-to-definition, rename, formatting,
semantic highlighting, and static type checking are not implemented yet.

The integration uses Neovim's built-in [`vim.lsp.start`](https://neovim.io/doc/user/lsp#vim.lsp.start()).
The server implements the relevant parts of the
[Language Server Protocol](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/).
