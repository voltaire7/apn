export const VERSION = "1.1.0";

export const CLI_HELP = `Usage:
  apn                             Start the REPL
  apn FILE.apn [ARGS...]           Run a file; remaining arguments go to getArgs
  apn --check FILE.apn [...]       Check types without running code
  apn --lint [--json] [--types] FILE.apn [...]
                                  Lint source without running code
  apn --html SOURCE.apn [OUTPUT.html]
                                  Build a browser app (default: app.html)
  apn --site FOLDER OUTPUT        Build FOLDER's index.apn as OUTPUT/index.html and
                                  an editor running its other examples (editor.html)
  apn --lsp                       Start the language server over stdio
  apn --version                   Show the version
  apn --help, -h                   Show this help
  apn --loose ...                 Any of the above without the spacing rules
                                  ([1, 2], [x = 1, y = 2], x = 1, { x }, (x))
  apn --no-prelude ...            Any of the above without the prelude: only
                                  intrinsics.* and what the program defines

Files and REPL submissions are statically checked by default.
Use -- before a filename beginning with '-'. Options after FILE.apn are
script arguments, not APN options. Type :help inside the REPL for language help.
The apn launcher also accepts --allow-ffi[=PATH,...] as its first argument.`;

/** Validate APN options without interpreting arguments belonging to a script. */
export function readCliOptions(input: string[]): { args: string[]; literalFile: boolean; loose: boolean; noPrelude: boolean; error?: string } {
    // --loose and --no-prelude come first, each once, in either order.
    const leading = new Set<string>();
    let rest = input;
    while (["--loose", "--no-prelude"].includes(rest[0]) && !leading.has(rest[0])) { leading.add(rest[0]); rest = rest.slice(1); }
    const { args, literalFile, error } = readMode(rest);
    return { args, literalFile, loose: leading.has("--loose"), noPrelude: leading.has("--no-prelude"), ...error ? { error } : {} };
}
function readMode(input: string[]): { args: string[]; literalFile: boolean; error?: string } {
    const args = [...input];
    if (args[0] === "--") {
        return { args: args.slice(1), literalFile: true, error: args.length === 1 ? "expected a filename after '--'" : undefined };
    }
    const first = args[0];
    const result = { args, literalFile: false };
    if (!first || !first.startsWith("-")) return result;
    if (first === "--loose" || first === "--no-prelude") return { ...result, error: `${first} is given once, before the rest` };
    if (["--help", "-h", "--lsp", "--version"].includes(first)) {
        return args.length === 1 ? result : { ...result, error: `${first} does not accept arguments` };
    }
    if (["--check", "--lint", "--html", "--site"].includes(first)) {
        const invalid = args.slice(1).find(arg => arg.startsWith("-") && !(first === "--lint" && ["--json", "--types"].includes(arg)));
        return invalid ? { ...result, error: `unknown option '${invalid}'` } : result;
    }
    return { ...result, error: `unknown option '${first}'` };
}
