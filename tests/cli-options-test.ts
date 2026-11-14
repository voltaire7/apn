import { readCliOptions } from "../src/cli-options.ts";
import { Interpreter } from "../src/interp.ts";
import { parseDocument, setPreludeUsed } from "../src/parser.ts";

for (const args of [[], ['--help'], ['-h'], ['--lsp'], ['--version'], ['--loose'], ['--loose', 'file.apn'], ['--loose', '--check', 'a.apn'], ['--loose', '--lsp'], ['--no-prelude', 'file.apn'], ['--no-prelude', '--loose', 'file.apn'], ['--loose', '--no-prelude'], ['--lint', '--types', '--json', 'file.apn'], ['--check', 'a.apn', 'b.apn'], ['--html', 'source.apn', 'out.html'], ['script.apn', '--ssdfls', '--help']]) {
    Deno.test(`CLI accepts ${JSON.stringify(args)}`, () => {
        if (readCliOptions(args).error) throw new Error(JSON.stringify(readCliOptions(args)));
    });
}
for (const args of [['--checked'], ['--checked', '--help'], ['--ssdfls'], ['-wat'], ['--checked', '--ssdfls'], ['--check', '--wat'], ['--lint', '--wat'], ['--html', '--wat'], ['--lsp', 'file.apn'], ['--help', 'file.apn'], ['--version', 'x'], ['--check', '--loose', 'a.apn'], ['--loose', '--loose'], ['--no-prelude', '--no-prelude'], ['--check', '--no-prelude', 'a.apn'], ['--']]) {
    Deno.test(`CLI rejects ${JSON.stringify(args)}`, () => {
        if (!readCliOptions(args).error) throw new Error('accepted invalid options');
    });
}
Deno.test('option terminator permits a literal option-shaped filename', () => {
    const original = ['--', '--help', '--script-flag'];
    const result = readCliOptions(original);
    if (result.error || !result.literalFile || result.args.join(' ') !== '--help --script-flag') throw new Error(JSON.stringify(result));
    if (original.length !== 3) throw new Error('mutated arguments');
});
Deno.test('--no-prelude comes first, with or without --loose', () => {
    const result = readCliOptions(['--no-prelude', '--loose', 'a.apn']);
    if (!result.noPrelude || !result.loose || result.args.join(' ') !== 'a.apn') throw new Error(JSON.stringify(result));
    if (readCliOptions(['a.apn', '--no-prelude']).noPrelude) throw new Error('script argument taken as an option');
});
Deno.test('--loose comes first and applies to any mode', () => {
    const result = readCliOptions(['--loose', '--check', 'a.apn']);
    if (!result.loose || result.args.join(' ') !== '--check a.apn') throw new Error(JSON.stringify(result));
    if (readCliOptions(['a.apn', '--loose']).loose) throw new Error('script argument taken as an option');
});

// Without the prelude a program has the intrinsics and what it defines; the
// checker sees the same, so 1 + 1 is unbound until the program binds +.
Deno.test("--no-prelude runs and checks without the prelude", () => {
    setPreludeUsed(false);
    try {
        const run = (source: string) => { const i = new Interpreter(); i.enableChecking(); return i.renderString(i.run(parseDocument(source))); };
        if (run("intrinsics.add 2 3") !== "5") throw new Error("intrinsics");
        if (run("(+) = intrinsics.add\ninfixl 6 +\n1 + 2") !== "3") throw new Error("own operator");
        let failed = "";
        try { run("1 + 1"); } catch (error) { failed = String(error); }
        if (!failed.includes("unbound operator '+'")) throw new Error(failed || "the prelude's + was bound");
    } finally { setPreludeUsed(true); }
});
