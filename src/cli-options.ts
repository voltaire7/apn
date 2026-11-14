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
  apn --check-budget=N ...        Let the checker evaluate N steps per value (default
                                  300000) before leaving it to the run; none lifts
                                  the limit (checking then may not finish)

Files and REPL submissions are statically checked by default.
Use -- before a filename beginning with '-'. Options after FILE.apn are
script arguments, not APN options. Type :help inside the REPL for language help.
The apn launcher also accepts --allow-ffi[=PATH,...] as its first argument.`;

/** Validate APN options without interpreting arguments belonging to a script. */
export function readCliOptions(input: string[]): { args: string[]; literalFile: boolean; loose: boolean; noPrelude: boolean; checkBudget?: number; error?: string } {
    // --loose, --no-prelude and --check-budget=N come first, each once, in any order.
    const leading = new Map<string, string>();
    let rest = input;
    for (;;) {
        const [flag, value] = (rest[0] ?? "").split(/=(.*)/s);
        if (!["--loose", "--no-prelude", "--check-budget"].includes(flag) || leading.has(flag) || (flag === "--check-budget") !== (value !== undefined)) break;
        leading.set(flag, value);
        rest = rest.slice(1);
    }
    const budget = leading.get("--check-budget");
    const checkBudget = budget === undefined ? undefined : budget === "none" ? Infinity : /^[1-9][0-9]*$/.test(budget) ? Number(budget) : NaN;
    if (Number.isNaN(checkBudget)) return { args: rest, literalFile: false, loose: false, noPrelude: false, error: "--check-budget takes a number of steps or none (--check-budget=1000000)" };
    const { args, literalFile, error } = readMode(rest);
    return { args, literalFile, loose: leading.has("--loose"), noPrelude: leading.has("--no-prelude"), ...checkBudget === undefined ? {} : { checkBudget }, ...error ? { error } : {} };
}
function readMode(input: string[]): { args: string[]; literalFile: boolean; error?: string } {
    const args = [...input];
    if (args[0] === "--") {
        return { args: args.slice(1), literalFile: true, error: args.length === 1 ? "expected a filename after '--'" : undefined };
    }
    const first = args[0];
    const result = { args, literalFile: false };
    if (!first || !first.startsWith("-")) return result;
    if (first === "--loose" || first === "--no-prelude" || first.startsWith("--check-budget")) return { ...result, error: `${first.split("=")[0]} is given once, before the rest` };
    if (["--help", "-h", "--lsp", "--version"].includes(first)) {
        return args.length === 1 ? result : { ...result, error: `${first} does not accept arguments` };
    }
    if (["--check", "--lint", "--html", "--site"].includes(first)) {
        const invalid = args.slice(1).find(arg => arg.startsWith("-") && !(first === "--lint" && ["--json", "--types"].includes(arg)));
        return invalid ? { ...result, error: `unknown option '${invalid}'` } : result;
    }
    return { ...result, error: `unknown option '${first}'` };
}
