import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

for (const [source, expected] of [
    ['x = 1; y = 2; [.x, .y]', '[x: 1, y: 2]'],
    ['x = 1; y = 2; [.y, .x]', '[y: 2, x: 1]'],
    ['x = 1; y = 2; [y,x]', '[2,1]'],
    ['x = 1; y = 2; [.x, other: y]', '[x: 1, other: 2]'],
    ['x = 1; y = 2; [other: y, .x]', '[other: 2, x: 1]'],
    ['x = 1; y = 2; [\n    .x\n    .y\n]', '[x: 1, y: 2]'],
    ['x = 1; { x = 2; [.x] }', '[x: 2]'],
    ['x = 1; func v = v.x; func [.x]', '1'],
    ['draw x = x + 1; callbacks = [.draw]; callbacks.draw 2', '3'],
    ['x = 1; r = [.x]; r.x = 2; [x,r.x]', '[1,2]'],
    ['x = 1; r = [.x]; [x: value] = r; value', '1'],
    ['[.1,.2]', '[0.1,0.2]'],
    ['x = Dynamic missing; r = [.x, y: 2]; r.y', '2'],
]) Deno.test(`record shorthand: ${source}`, () => {
    const i = new Interpreter();
    i.enableChecking();
    const actual = i.renderString(i.run(parseDocument(source)));
    if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
});

for (const source of ['[.x, y]', '[x, .y]', '[.x: 1]', '[.x + 1]', '[._]', '[."x"]', '[.(x)]']) {
    Deno.test(`invalid record shorthand: ${source}`, () => {
        try { parseDocument(source); } catch { return; }
        throw new Error('Expected a parse error');
    });
}
Deno.test('record shorthand checks unbound values like explicit fields', () => {
    function failure(source: string): string {
        const i = new Interpreter();
        i.enableChecking();
        try { i.run(parseDocument(source)); } catch (error) { return String(error); }
        throw new Error('Expected a static error');
    }
    const shorthand = failure('[.missing]');
    if (shorthand !== failure('[missing: missing]')) {
        throw new Error(`Shorthand changed static checking: ${shorthand}`);
    }
});
