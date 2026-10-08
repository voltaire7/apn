import { readCliOptions } from "../src/cli-options.ts";

for (const args of [[], ['--help'], ['-h'], ['--lsp'], ['--version'], ['--loose'], ['--loose', 'file.apn'], ['--loose', '--check', 'a.apn'], ['--loose', '--lsp'], ['--lint', '--types', '--json', 'file.apn'], ['--check', 'a.apn', 'b.apn'], ['--html', 'source.apn', 'out.html'], ['script.apn', '--ssdfls', '--help']]) {
    Deno.test(`CLI accepts ${JSON.stringify(args)}`, () => {
        if (readCliOptions(args).error) throw new Error(JSON.stringify(readCliOptions(args)));
    });
}
for (const args of [['--checked'], ['--checked', '--help'], ['--ssdfls'], ['-wat'], ['--checked', '--ssdfls'], ['--check', '--wat'], ['--lint', '--wat'], ['--html', '--wat'], ['--lsp', 'file.apn'], ['--help', 'file.apn'], ['--version', 'x'], ['--check', '--loose', 'a.apn'], ['--loose', '--loose'], ['--']]) {
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
Deno.test('--loose comes first and applies to any mode', () => {
    const result = readCliOptions(['--loose', '--check', 'a.apn']);
    if (!result.loose || result.args.join(' ') !== '--check a.apn') throw new Error(JSON.stringify(result));
    if (readCliOptions(['a.apn', '--loose']).loose) throw new Error('script argument taken as an option');
});
