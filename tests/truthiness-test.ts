import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

for (const [source, expected] of [
    ['[(),{},[]]', '[[],[],[]]'],
    ['f = {}; f', '[]'],
    ['do []', '[]'],
    ['typeOf ()', '[]'],
    ['[to Bool 0, to Bool 1, to Bool -1, to Bool 0.0, to Bool 0i, to Bool 1i]', '[False,True,True,False,False,True]'],
    ['[to Bool "", to Bool "0", to Bool [], to Bool [missing], to Bool [1..]]', '[False,True,False,True,True]'],
    ['r = [x : Record] []; [to Bool r.x, to Bool [x = 1], to Bool (HashMap [])]', '[False,True,False]'],
    ['[to Bool Int, to Bool (x -> x), to Bool (Mutable 0), to Bool (Mutable 1)]', '[True,True,False,True]'],
    ['Option a = Some a | None; to Bool None', 'True'],
    ['Flag = Bool; f = False : Flag; [to Bool f, !f, f ? 1 : 0, f && 1]', '[False,True,0,False]'],
    ['0 ? missing : 42', '42'],
    ['[missing] ? 42 : missing', '42'],
    ['[!0,!1,![],![missing]]', '[True,False,True,False]'],
    ['[0 && missing, 1 || missing, 1 && "", 0 || "yes"]', '[False,True,False,True]'],
    ['n = Mutable 0; [0 && missing, 1 || missing, n]', '[False,True,0]'],
    ['n = Mutable 0; test = { set n (n + 1); return 1 }; t <- test; [t && 1, n]', '[True,1]'],
    ['filter (x -> x) [0,1,2,0]', '[1,2]'],
    ['1 ~ [x | [] -> 0, x | 1 -> x]', '1'],
    ['std <- import "std"\nuse std.sequence\n[takeWhile (x -> x) [1,2,0,3], all (x -> x) [1,2], any (x -> x) [0,1]]', '[[1,2],True,True]'],
    ['[1 || 0 && missing, 0 || 1 && 2]', '[True,True]'],
    ['[(0 &&) missing, (1 ||) missing]', '[False,True]'],
    ['[0 == False, [] == False]', '[False,False]'],
] as const) Deno.test(`empty results and truthiness: ${source}`, () => {
    const i = new Interpreter();
    const actual = i.renderString(i.run(parseDocument(source)));
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
Deno.test("NaN and null pointers are falsy", () => {
    const i = new Interpreter();
    if (i.truthy({ kind: "float", v: NaN })) throw new Error("NaN is truthy");
    if (i.truthy({ kind: "pointer", bits: 0n, address: null, offset: 0 })) throw new Error("null is truthy");
});
Deno.test("Unit is no longer a builtin", () => {
    if (new Interpreter().env.get("Unit")) throw new Error("Unit still exists");
});
