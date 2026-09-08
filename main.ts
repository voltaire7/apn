#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env=HOME

// =====================================================================
//  APN — Applicative Polish Notation: a lazy, Haskell-like, untyped
//  (JS-like) language interpreter with optional TypeScript-style type
//  annotations (not enforced). Evaluation rules: SEMANTICS.md.
//  Run:  deno run --allow-read main.ts   (REPL)
//        deno run --allow-read main.ts features.txt
// =====================================================================

import { Interpreter, dirname } from "./src/interp.ts";
import { runSource, repl, formatError } from "./src/repl.ts";
export { parse } from "./src/parser.ts";
export { lex } from "./src/lexer.ts";

// ---------------- main ----------------

if (import.meta.main) {
    const _args = Deno.args;

    if (_args.length >= 1 && !_args[0]?.startsWith(":")) {
        const file = _args[0];
        const src = Deno.readTextFileSync(file);
        const interp = new Interpreter();
        interp.sourceDir = dirname(file);
        try {
            runSource(src, interp);
        } catch (err) {
            console.error(formatError(err, Deno.stderr.isTerminal()));
            Deno.exit(1);
        }
    } else {
        repl().catch((err: unknown) => {
            console.error(err);
            Deno.exit(1);
        });
    }
}
