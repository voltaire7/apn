#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env=HOME

// =====================================================================
//  APN — Applicative Polish Notation: a lazy, Haskell-like, untyped
//  (JS-like) language interpreter with optional TypeScript-style type
//  annotations (not enforced), arbitrary-precision integers. Evaluation rules: docs/semantics.md.
//  Run:  deno run --allow-read main.ts   (REPL)
//        deno run --allow-read main.ts examples/features.apn
// =====================================================================

import { formatFileReadError } from "./src/errors.ts";
import { Interpreter, dirname } from "./src/interp.ts";
import { runSource, repl, formatError } from "./src/repl.ts";
export { parse } from "./src/parser.ts";
export { lex } from "./src/lexer.ts";

// ---------------- main ----------------

if (import.meta.main) {
    const _args = Deno.args;

    if (_args[0] === "--lint") {
        const { runLint } = await import("./src/lint.ts");
        Deno.exit(await runLint(_args.slice(1)));
    } else if (_args[0] === "--lsp") {
        const { runLanguageServer } = await import("./src/lsp.ts");
        try { Deno.exit(await runLanguageServer()); }
        catch (error) { console.error(String(error)); Deno.exit(1); }
    } else if (_args[0] === "--html") {
        const source = _args[1];
        const output = _args[2] ?? "app.html";
        if (!source || _args.length > 3) { console.error("usage: apn --html SOURCE.apn [OUTPUT.html]"); Deno.exit(1); }
        try {
            const { buildHtml } = await import("./src/build-html.ts");
            await buildHtml(source, output);
            console.log(`Built ${output}`);
        } catch (error) { console.error(String(error)); Deno.exit(1); }
    } else if (_args.length >= 1 && !_args[0]?.startsWith(":")) {
        const file = _args[0];
        let src: string;
        try {
            src = Deno.readTextFileSync(file);
        } catch (error) {
            console.error(formatFileReadError(file, error));
            Deno.exit(1);
        }
        const interp = new Interpreter();
        interp.sourceDir = dirname(file);
        interp.programArgs = _args.slice(1);
        try {
            runSource(src, interp, true); // file mode executes effects without rendering the last value
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
