import { CheckingSession } from "../src/checking-session.ts";
import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

function result(source: string): string {
    const i = new Interpreter();
    return i.renderString(i.run(parseDocument(source)));
}
for (const [source, expected] of [
    ['loop 0 = 42; loop n = { unused = missing; loop (n - 1) }; loop 10000', '42'],
    ['loop 0 = 42; loop n = loop (n - 1); loop 10000', '42'],
    ['loop = n -> n == 0 ? 42 : loop (n - 1); loop 10000', '42'],
    ['even n = n == 0 ? True : odd (n - 1); odd n = n == 0 ? False : even (n - 1); even 10001', 'False'],
    ['loop n = n == 0 ? 42 : { next = n - 1; loop $ next }; loop 10000', '42'],
    ['loop n ignored = n == 0 ? 42 : loop (n - 1) missing; loop 10000 missing', '42'],
    ['loop n = n == 0 ? [42,missing] : loop (n - 1); head (loop 10000)', '42'],
    ['loop n = n ~ [0 -> 42, k | k > 0 -> loop (k - 1)]; loop 100000', '42'],
    // A ternary is Bool c a b as written there: clauses for get the program
    // adds for a Bool are the ones it uses.
    ['get True a = _ -> "mine"; f n = n ? "yes" : "no"; [f 0, f [1]]', '["no","mine"]'],
    ['sum n total = n == 0 ? return total : { next <- return (total + n); sum (n - 1) next }\ns <- sum 10000 0\ns', '50005000'],
] as const) Deno.test(`tail call: ${source}`, () => {
    const actual = result(source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
// An expression nested past what the host's stack holds (a chain of
// thousands of operators) is an error of its own, never a host crash: the
// run's call stack overflow, the checker's depth limit, the parser's nesting.
Deno.test("an expression nested too deeply is an error, not a crash", () => {
    const chain = (head: string, piece: string, n: number, tail: string) => {
        const out = [head];
        for (let i = 0; i < n; i++) { if (out[out.length - 1].length > 85) out.push("   "); out[out.length - 1] += piece; }
        return out.join("\n") + tail;
    };
    const failure = (run: () => unknown) => { try { run(); return "ran"; } catch (error) { return String(error); } };
    const sum = chain("y = 2", " + 1", 3000, "\ny");
    const unchecked = failure(() => result(sum));
    if (!unchecked.includes("call stack overflow")) throw new Error(unchecked);
    const checked = failure(() => { const i = new Interpreter(); i.enableChecking(); i.run(parseDocument(sum)); });
    if (!checked.includes("depth limit exceeded")) throw new Error(checked);
    const parsed = failure(() => parseDocument(chain("y = 1", " :: 1", 6000, " :: []\ny")));
    if (!parsed.includes("nests too deeply to parse")) throw new Error(parsed);
});
// A load runs its file as a call: a file loading itself would never end, so
// the check rejects it as a cycle, as it does an import's.
Deno.test('a file that loads itself is a cyclic load', () => {
    const directory = new URL('./fixtures/', import.meta.url).pathname;
    try { new CheckingSession().load('self-load', directory); } catch (error) {
        if (String(error).includes("cyclic load 'self-load'")) return;
        throw error;
    }
    throw new Error('a self-load checked');
});
