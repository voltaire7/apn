# Error reporting

All user-facing failures are `APNError` — kinds `parse` / `lex` / `runtime` / `type` —
rendered by `formatError(err, color)`:

- **Parse/lex errors** point at the offending token: bold red headline, dim
  `--> line L, column C`, the source line with one line of context on each
  side (syntax-highlighted in the TTY REPL), and a green caret spanning the
  token. The lexer stamps every token with `pos`; the parser tracks the last
  token it looked at (`Parser.seen`).
- **Runtime errors** are a headline plus an optional `hint:` — `did you mean
  '...'?` for unbound variables (edit distance over bound names + natives)
  and missing record fields (over the record's fields). The non-exhaustive
  function error names the function. Operator type errors are uniform:
  `cannot apply '+' to list and int`.
- **Type errors** name an unknown name, where it is written, before any
  other error its unknown value leads to: `unbound variable 'x'`, or
  `unknown constructor 'Some' in a pattern`. A name the standard library
  exports gets a hint naming the import (``add `[..] <- import "std/option"`
  to use `okOr` ``). A name the program defines locally elsewhere (in this
  input or an earlier one) is out of scope where it is read, and its hint says
  how to get it from there instead: ``hint: `code` is defined inside `f`: end
  `f` with `return code` to return it, then `code <- f` `` (`code` and
  `code = f` when `f` is no action; no binding when `f` is a function or is
  itself local), or for a record's field ``hint: `size` is a field of
  `config`: write `config.size` ``; one defined in a block no definition names
  gets none. Others get `did you mean '...'?`.
- Code in a hint is in backticks: ``bind a value with `=` ``, ``bind its
  result first: `x <- action` ``.
- Messages carry no `Parser:`/`Lexer:`/`Runtime:` prefixes — the headline
  category replaces them. `tokenStr` returns BARE token text (the message
  templates add the quotes; the old version double-quoted).
- Unterminated strings/chars are LEX errors now (they used to silently
  swallow the rest of the file); the REPL treats "unterminated" as
  incomplete input, so multi-line strings keep working.
- TTY REPL prints the colored render; piped REPL prints plain; file mode
  prints to stderr (colored when stderr is a tty) and exits 1.
