# REPL

Two modes, picked automatically: a **TTY** stdin gets the raw-mode line editor
(`ReplEditor`); a **piped** stdin (`... | deno run main.ts`) gets the plain
line loop — no colors, no editor, same chunk semantics. Each input is a
statement: an action runs (as in a file) and its result is echoed, except an
empty result (`print 3` shows only `3`); bindings echo nothing. Interactive features:

- **History**: Up/Down walk submitted chunks. In a single-line buffer the
  arrows navigate history; in a multi-line buffer (continuation or a recalled
  multi-line entry) they move between lines. Up on the first line browses older
  history; Down on the last line browses newer history, restoring the draft
  after the newest entry, as if the entries were one text: Up lands on an
  older entry's last line, Down on a newer one's first. Browsing history puts
  the cursor at the end of every line it lands on; in a new entry the arrows
  keep the column, as in Vim (clamped to each line, remembered across shorter
  ones until another key moves it). Persisted across
  sessions in `~/.apn_history` (one JSON string per line, capped at 500 on
  load; needs `--allow-write` and `--allow-env=HOME`, else in-session only
  with a one-time hint).
- **Tab**: completes the word before the cursor from bound names (env walk),
  natives (`NATIVES` — same table that registers them), `match`, and
  `:commands`. One match completes; several extend the common prefix and a
  second Tab lists them. With no word (or no candidates) Tab inserts
  **4 spaces** — the indent unit; Backspace behind a full indent level
  deletes all 4 at once, and on a blank continuation line it undoes the
  line break (the cursor lands at the end of the line above — the line's
  auto-indent dies with it). Typing `}`/`]` on an indent-only line dedents
  one level first, and deleting a lone `}`/`]` at column 0 of a continuation
  line restores that indent (the assist is symmetric).
- **Enter** submits regardless of syntax validity, except immediately after
  an opening `(`, `{`, or `[`, or a trailing `=`, `<-` or `->` that still
  awaits its body (allowing whitespace and a comment), where it inserts an
  indented newline. Enter also continues inside a bracket opened on an earlier
  line, preserving indentation. An unfinished single-line `[1, 2, 3` submits
  and reports a syntax error.
  Shift+Enter reverses this behavior. Strings and comments do not count as
  brackets. Option+Left/Right (or Alt+B/F) move by word, Shift or
  Ctrl+Left/Right by whitespace-separated word (all across lines).
  Modified Enter requires a terminal that sends a distinct key sequence;
  the editor requests Kitty keyboard disambiguation and also accepts xterm
  modifyOtherKeys Shift+Enter. Auto-indentation still applies to newlines.
- **Paste**: bracketed paste mode is enabled (`ESC[?2004h`), so pasted
  multi-line text is inserted verbatim, never auto-run: copied indentation and
  blank lines are kept, without auto-indent or closing-bracket dedent. Enter
  then runs it.
- **Colors** (Catppuccin Frappé palette, truecolor): input is highlighted as
  typed, by the tokenizer the language server and the web editor share
  (`src/highlight.ts`) (comments overlay0, strings/chars green, numbers yellow,
  keywords (`import`, `load`, `use`, `match`, `do`, `return`) and bools mauve,
  natives blue, capital idents sky,
  punctuation overlay1, operators peach); echoed values are colored by kind with
  gray structure (brackets, colons, commas; keys plain, variant tags sky);
  errors red.
- **Keys** are fish's: Ctrl+C clear input (empty buffer = quit), Ctrl+D
  quit, Ctrl+L clear screen, Ctrl+A/E home/end, Ctrl+U/K kill to line
  start/end, Ctrl+W kill back to the start of a path component (`/ = { , }
  ' " : @ #` and whitespace separate them), Option+Backspace / Option+D kill a
  word back / on, Ctrl+Y yank what was killed (consecutive kills join), arrows
  + Home/End/Delete (Left and Right stay on their line, as in Vim). Words
  and their stops are fish's (`src/word-motion.ts`,
  tested with fish's own cases): `_` and other punctuation separate words.
  Caps Lock and Num Lock change no binding.
- While the terminal is raw, `print`/`debug` output is routed through the
  editor so newlines are CRLF-correct (`console.log` is patched in TTY mode).
- `:help`/`:h` and `:quit`/`:q` work in both modes (`helpText()`).
