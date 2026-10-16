#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env=HOME

// =====================================================================
//  APN — Applicative Polish Notation: lazy execution, static checking with Dynamic boundaries,
//  value-dependent constructors and patterns, and exact numbers.
//  Evaluation rules: docs/semantics.md.
//  Run:  deno run --allow-read main.ts   (REPL)
//        deno run --allow-read main.ts examples/features.apn
// =====================================================================

import { CLI_HELP, readCliOptions, VERSION } from "./src/cli-options.ts";
import { setLooseSpacing } from "./src/parser.ts";
import { formatFileReadError } from "./src/errors.ts";
import { Interpreter, dirname } from "./src/interp.ts";
import { runSource, repl, formatError } from "./src/repl.ts";
export { parse } from "./src/parser.ts";
export { lex } from "./src/lexer.ts";

// ---------------- main ----------------

if (import.meta.main) {
    const { args: _args, literalFile, loose, error } = readCliOptions(Deno.args);
    if (error) {
        const label = Deno.stderr.isTerminal() ? "\x1b[1;31merror:\x1b[0m" : "error:";
        console.error(`${label} ${error}`);
        Deno.exit(2);
    }

    setLooseSpacing(loose);

    if (!literalFile && (_args[0] === "--help" || _args[0] === "-h")) {
        console.log(CLI_HELP);
    } else if (!literalFile && _args[0] === "--version") {
        console.log(`apn ${VERSION}`);
    } else if (!literalFile && _args[0] === "--check") {
        const { runTypeCheck } = await import("./src/type-checker.ts");
        Deno.exit(await runTypeCheck(_args.slice(1)));
    } else if (!literalFile && _args[0] === "--lint") {
        const { runLint } = await import("./src/lint.ts");
        Deno.exit(await runLint(_args.slice(1)));
    } else if (!literalFile && _args[0] === "--lsp") {
        const { runLanguageServer } = await import("./src/lsp.ts");
        try { Deno.exit(await runLanguageServer()); }
        catch (error) { console.error(formatError(error, Deno.stderr.isTerminal())); Deno.exit(1); }
    } else if (!literalFile && _args[0] === "--html") {
        const source = _args[1];
        const output = _args[2] ?? "app.html";
        if (!source || _args.length > 3) { console.error("usage: apn --html SOURCE.apn [OUTPUT.html]"); Deno.exit(1); }
        try {
            const { buildHtml } = await import("./src/build-html.ts");
            await buildHtml(source, output);
            console.log(`Built ${output}`);
        } catch (error) { console.error(formatError(error, Deno.stderr.isTerminal())); Deno.exit(1); }
    } else if (!literalFile && _args[0] === "--site") {
        const [, folder, output] = _args;
        if (!folder || !output || _args.length > 3) { console.error("usage: apn --site FOLDER OUTPUT"); Deno.exit(1); }
        try {
            const { buildSite } = await import("./src/build-html.ts");
            await buildSite(folder, output);
            console.log(`Built ${output.replace(/\/?$/, "/")}index.html and editor.html`);
        } catch (error) { console.error(formatError(error, Deno.stderr.isTerminal())); Deno.exit(1); }
    } else if (_args.length >= 1 && (literalFile || !_args[0]?.startsWith(":"))) {
        const file = _args[0];
        let src: string;
        try {
            src = Deno.readTextFileSync(file);
        } catch (error) {
            console.error(formatFileReadError(file, error));
            Deno.exit(1);
        }
        const interp = new Interpreter();
        interp.enableChecking();
        interp.sourceDir = dirname(file);
        interp.sourceFile = file;
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
