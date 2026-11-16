import { readCliOptions } from "../src/cli-options.ts";
import { Interpreter } from "../src/interp.ts";
import { parseDocument, setPreludeUsed } from "../src/parser.ts";
import { checkSource, setCheckBudget } from "../src/type-checker.ts";

for (const args of [[], ['--help'], ['-h'], ['--lsp'], ['--version'], ['--loose'], ['--loose', 'file.apn'], ['--loose', '--check', 'a.apn'], ['--loose', '--lsp'], ['--no-prelude', 'file.apn'], ['--no-prelude', '--loose', 'file.apn'], ['--loose', '--no-prelude'], ['--check-budget=1000', 'file.apn'], ['--check-budget=none', '--loose', '--check', 'a.apn'], ['--lint', '--types', '--json', 'file.apn'], ['--check', 'a.apn', 'b.apn'], ['--html', 'source.apn', 'out.html'], ['script.apn', '--ssdfls', '--help']]) {
    Deno.test(`CLI accepts ${JSON.stringify(args)}`, () => {
        if (readCliOptions(args).error) throw new Error(JSON.stringify(readCliOptions(args)));
    });
}
for (const args of [['--checked'], ['--checked', '--help'], ['--ssdfls'], ['-wat'], ['--checked', '--ssdfls'], ['--check', '--wat'], ['--lint', '--wat'], ['--html', '--wat'], ['--lsp', 'file.apn'], ['--help', 'file.apn'], ['--version', 'x'], ['--check', '--loose', 'a.apn'], ['--loose', '--loose'], ['--no-prelude', '--no-prelude'], ['--check', '--no-prelude', 'a.apn'], ['--check-budget=x', 'a.apn'], ['--check-budget=0', 'a.apn'], ['--check-budget', 'a.apn'], ['--check-budget=1', '--check-budget=2', 'a.apn'], ['--']]) {
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

// The checker's budget bounds its work: within it a long computation in a
// type is decided; past it, it is an error; none lifts the limit.
Deno.test("--check-budget sets how far the checker evaluates", () => {
    if (readCliOptions(["--check-budget=none", "a.apn"]).checkBudget !== Infinity) throw new Error("none");
    if (readCliOptions(["--check-budget=1000", "a.apn"]).checkBudget !== 1000) throw new Error("a number");
    const source = "count n acc = n == 0 ? acc : count (n - 1) (acc + 1)\ng (xs : Vect (count 200000 0) Int) = 1\ng [1]";
    const issues = () => checkSource(source, "<test>", { strict: true }).issues.map(i => i.message);
    if (!issues().some(m => m.includes("takes more than 300000 steps"))) throw new Error(`decided within the default budget: ${issues()}`);
    setCheckBudget(5000000);
    try { if (!issues().some(m => m.includes("length mismatch"))) throw new Error(`not decided: ${issues()}`); }
    finally { setCheckBudget(300000); }
});
