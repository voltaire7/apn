import { readCliOptions } from "../src/cli-options.ts";

for (const args of [[], ['--help'], ['-h'], ['--checked', '--help'], ['--lsp'], ['--lint', '--types', '--json', 'file.apn'], ['--check', 'a.apn', 'b.apn'], ['--html', 'source.apn', 'out.html'], ['script.apn', '--ssdfls', '--help']]) {
    Deno.test(`CLI accepts ${JSON.stringify(args)}`, () => {
        if (readCliOptions(args).error) throw new Error(JSON.stringify(readCliOptions(args)));
    });
}
for (const args of [['--ssdfls'], ['-wat'], ['--checked', '--ssdfls'], ['--check', '--wat'], ['--lint', '--wat'], ['--html', '--wat'], ['--lsp', 'file.apn'], ['--help', 'file.apn'], ['--']]) {
    Deno.test(`CLI rejects ${JSON.stringify(args)}`, () => {
        if (!readCliOptions(args).error) throw new Error('accepted invalid options');
    });
}
Deno.test('option terminator permits a literal option-shaped filename', () => {
    const original = ['--checked', '--', '--help', '--script-flag'];
    const result = readCliOptions(original);
    if (result.error || !result.literalFile || result.args.join(' ') !== '--help --script-flag') throw new Error(JSON.stringify(result));
    if (original.length !== 4) throw new Error('mutated arguments');
});
