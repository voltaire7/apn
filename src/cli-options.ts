export const VERSION = "1.1.0";

export const CLI_HELP = `Usage:
  apn                             Start the REPL
  apn FILE.apn [ARGS...]           Run a file; remaining arguments go to getArgs
  apn --check FILE.apn [...]       Check types without running code
  apn --lint [--json] [--types] FILE.apn [...]
                                  Lint source without running code
  apn --html SOURCE.apn [OUTPUT.html]
                                  Build a browser app (default: app.html)
  apn --lsp                       Start the language server over stdio
  apn --version                   Show the version
  apn --help, -h                   Show this help
  apn --loose ...                 Any of the above without the spacing rules
                                  ([1,2], [x: 1, y: 2], x = 1, { x }, (x))

Files and REPL submissions are statically checked by default.
Use -- before a filename beginning with '-'. Options after FILE.apn are
script arguments, not APN options. Type :help inside the REPL for language help.
The apn launcher also accepts --allow-ffi[=PATH,...] as its first argument.`;

/** Validate APN options without interpreting arguments belonging to a script. */
export function readCliOptions(input: string[]): { args: string[]; literalFile: boolean; loose: boolean; error?: string } {
    const loose = input[0] === "--loose";
    const { args, literalFile, error } = readMode(loose ? input.slice(1) : input);
    return { args, literalFile, loose, ...error ? { error } : {} };
}
function readMode(input: string[]): { args: string[]; literalFile: boolean; error?: string } {
    const args = [...input];
    if (args[0] === "--") {
        return { args: args.slice(1), literalFile: true, error: args.length === 1 ? "expected a filename after '--'" : undefined };
    }
    const first = args[0];
    const result = { args, literalFile: false };
    if (!first || !first.startsWith("-")) return result;
    if (first === "--loose") return { ...result, error: "--loose is given once, first" };
    if (["--help", "-h", "--lsp", "--version"].includes(first)) {
        return args.length === 1 ? result : { ...result, error: `${first} does not accept arguments` };
    }
    if (["--check", "--lint", "--html"].includes(first)) {
        const invalid = args.slice(1).find(arg => arg.startsWith("-") && !(first === "--lint" && ["--json", "--types"].includes(arg)));
        return invalid ? { ...result, error: `unknown option '${invalid}'` } : result;
    }
    return { ...result, error: `unknown option '${first}'` };
}
