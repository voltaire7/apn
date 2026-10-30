import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

for (const [source, expected] of [
    ['[(),{},[]]', '[[],[],[]]'],
    ['f = {}; f', '[]'],
    ['do []', '[]'],
    ['typeOf ()', 'List a'],
    ['[Bool 0, Bool 1, Bool -1, Bool 0.0, Bool 0i, Bool 1i]', '[false,true,true,false,false,true]'],
    ['[Bool "", Bool "0", Bool [], Bool [missing], Bool [1..]]', '[false,true,false,true,true]'],
    ['r = [x: Record] []; [Bool r.x, Bool [x: 1], Bool (HashMap [])]', '[false,true,false]'],
    ['[Bool Int, Bool (x -> x), Bool (Mutable 0), Bool (Mutable 1)]', '[true,true,false,true]'],
    ['Option a = Some a | None; Bool None', 'true'],
    ['Flag = Bool; f = Flag false; [Bool f, !f, f ? 1 : 0, f && 1]', '[false,true,0,false]'],
    ['0 ? missing : 42', '42'],
    ['[missing] ? 42 : missing', '42'],
    ['[!0,!1,![],![missing]]', '[true,false,true,false]'],
    ['[0 && missing, 1 || missing, 1 && "", 0 || "yes"]', '[false,true,false,true]'],
    ['n = Mutable 0; 0 && missing; 1 || missing; n', '0'],
    ['n = Mutable 0; test = { set n (n + 1); return 1 }; t <- test; t && 1; n', '1'],
    ['filter (x -> x) [0,1,2,0]', '[1,2]'],
    ['match 1 [x | [] -> 0, x | 1 -> x]', '1'],
    ['import "sequence"; [takeWhile (x -> x) [1,2,0,3], all (x -> x) [1,2], any (x -> x) [0,1]]', '[[1,2],true,true]'],
    ['[1 || 0 && missing, 0 || 1 && 2]', '[true,true]'],
    ['[(0 &&) missing, (1 ||) missing]', '[false,true]'],
    ['[0 == false, [] == false]', '[false,false]'],
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
