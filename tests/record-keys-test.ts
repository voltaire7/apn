import { stringKey, keySource } from "../src/record-keys.ts";
import { Interpreter } from "../src/interp.ts";
import { parseDocument, exprToSource } from "../src/parser.ts";
import { valueToString } from "../src/types.ts";

function result(source: string): string {
    const i = new Interpreter();
    return i.renderString(i.run(parseDocument(source)));
}
for (const [name, source, expected] of [
    ["named field access", 'obj = [field: 123]\n[obj.field,obj "field"]', '[123,123]'],
    ["string key access", 'obj = ["field": 123]\nobj."field"', '123'],
    ["coexisting keys", 'obj = [field: 123, "field": 456]\n[obj.field,obj "field",obj."field"]', '[123,123,456]'],
    ["computed named keys", 'obj = [field: 123, "field": 456]\nkey = "field"\n[obj key,obj."field"]', '[123,456]'],
    ["numeric fields versus positions", 'obj = [9: 90, 1: 10, "1": 100]\n[obj.1,obj "1",obj 1,obj."1"]', '[10,10,["1",10],100]'],
    ["zero field versus position", 'arr = [other: 7, 0: 42, "0": 99]\n[arr "0",arr 0,arr."0"]', '[42,["other",7],99]'],
    ["list indexing", 'arr = [10,20]\narr 0', '10'],
    ["HashMap index types", 'arr = HashMap [[0,10],["0",20]]\n[arr 0,arr "0"]', '[10,20]'],
    ["printing preserves quotes", '[x: 1, "x": 2, 0: 3, "0": 4]', '[x: 1, "x": 2, 0: 3, "0": 4]'],
    ["named update", 'obj = [x: 1, "x": 2]\nobj.x = 3\nobj', '[x: 3, "x": 2]'],
    ["string update", 'obj = [x: 1, "x": 2]\nobj."x" = 3\nobj', '[x: 1, "x": 3]'],
    ["adding the other key kind", 'obj = [x: 1]\nobj."x" = 2\nobj', '[x: 1, "x": 2]'],
    ["pluck both kinds", 'obj = [x: 1, "x": 2]\nobj.[x,"x"]', '[1,2]'],
    ["renamed pluck", 'obj = [x: 1, "x": 2]\nobj.[x: named, "x": quoted]', '[named: 1, quoted: 2]'],
    ["pluck update", 'obj = [x: 1, "x": 2]\nobj.[x,"x"] = obj.["x",x]\nobj', '[x: 2, "x": 1]'],
    ["keyed destructuring", 'obj = [x: 1, "x": 2]\n[x: a, "x": b] = obj\n[a,b]', '[1,2]'],
    ["bare destructuring", '[x] = [x: 1, "x": 2]\nx', '1'],
    ["pattern dispatch", 'f [x: value] = value + 10\nf ["x": value] = value + 20\n[f [x: 1],f ["x": 2]]', '[11,22]'],
    ["clone preserves kinds", 'obj = [x: 1, "x": 2]\nobj ["x": 3]', '[x: 1, "x": 3]'],
    ["clone adds kind", 'obj = [x: 1]\nobj ["x": 2]', '[x: 1, "x": 2]'],
    ["positional clone", 'obj = [x: 1, "x": 2]\nobj [3,4]', '[x: 3, "x": 4]'],
    ["nested access", 'obj = [child: ["x": 2], "child": [x: 3]]\n[obj.child."x",obj."child" "x"]', '[2,3]'],
    ["unused values stay deferred", 'unused = missing + 1\nobj = [x: 1, "x": unused]\nobj "x"', '1'],
    ["pairs expose plain key text", 'pairs [x: 1, "x": 2]', '[["x",1],[""x"",2]]'],
    ["iteration exposes plain key text", '[x: 1, "x": 2] * [k,v] -> k', '["x",""x""]'],
    ["string key to HashMap", String.raw`m = HashMap ["x": 2]
m "\"x\""`, '2'],
    ["named key to HashMap", 'm = HashMap [x: 1]\nm "x"', '1'],
    ["function source keys", 'f obj = obj."x"\nf', 'obj -> obj."x"'],
    ["function source patterns", 'f ["x": value] = value\nf', '["x": value] -> value'],
    ["function source records", 'f x = [x: x, "x": x]\nf', 'x -> [x: x, "x": x]'],
] as const) {
    Deno.test(`record keys: ${name}`, () => {
        const actual = result(source);
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
}
for (const [source, message] of [
    ['obj = [x: 1]\nobj."x"', "no field"],
    ['obj = ["x": 1]\nobj.x', "no field 'x'"],
    ['obj = ["x": 1]\nobj "x"', "no field 'x'"],
    ['arr = [10,20]\narr "0"', 'association lookup expects'],
    ['[x] = ["x": 1]', 'pattern'],
    ['f [x: v] = v\nf ["x": 1]', 'no clause'],
    ['f ["x": v] = v\nf [x: 1]', 'no clause'],
    ['obj = ["x": 1]\nobj "\u0000x"', 'no field'],
] as const) {
    Deno.test(`record keys reject: ${source}`, () => {
        try { result(source); } catch (e) {
            if (e instanceof Error && e.message.includes(message)) return;
            throw e;
        }
        throw new Error(`Expected ${message}`);
    });
}
Deno.test("record key source and runtime render round-trip", () => {
    for (const key of ['field', 'my field', 'a"b', 'a\\b', 'a\nb', 'a\vb', 'a\u0000b', '']) {
        const source = `[x: 1, ${keySource(stringKey(key))}: 2]`;
        const parsed = parseDocument(source)[0];
        if (parsed.t !== "expr") throw new Error("expected expression");
        const i = new Interpreter();
        const value = i.run([parsed]);
        for (const text of [exprToSource(parsed.value), i.renderString(value), valueToString(value)]) {
            if (result(text) !== result(source)) throw new Error(`Lost key identity: ${text}`);
        }
    }
});

Deno.test("string keys containing NUL do not collide with other keys", () => {
    const key = keySource(stringKey("\u0000x"));
    const actual = result(`obj = [x: 1, "x": 2, ${key}: 3]\n[obj.x,obj."x",obj.${key}]`);
    if (actual !== "[1,2,3]") throw new Error(actual);
});

for (const [name, source, expected] of [
    ["quoted dot and string application", String.raw`v = [x: 1]
v."x" = 123
[v.x,v."x",v "\"x\""]`, "[1,123,123]"],
    ["application updates the same quoted key", String.raw`v = ["x": 1]
v "\"x\"" = 123
[v."x",length (pairs v)]`, "[123,1]"],
    ["computed quote characters", String.raw`v = ["x": 123]
key = "\"" ++ "x" ++ "\""
v key`, "123"],
    ["keys from iteration look up the original field", String.raw`v = [x: 1, "x": 2, "\"x\"": 3]
v * [key,value] -> v key == value`, "[true,true,true]"],
    ["HashMap preserves both strings", String.raw`m = HashMap [x: 1, "x": 2]
[m "x",m "\"x\""]`, "[1,2]"],
]) Deno.test(`ordinary string keys: ${name}`, () => {
    const actual = result(source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});

for (const [source, expected] of [
    ['obj = []\nobj.-1 = 1\n[obj.-1,obj "-1"]', '[1,1]'],
    ['obj = [(x): 0]\nobj "(x)" = 2\n[obj "(x)",obj "(x)"]', '[2,2]'],
    ['x = "other"\nobj = [(x): 3, other: 4]\nobj "(x)"', '3'],
    ['obj = [-1: 10, (x): 20]\nobj.[-1,(x)]', '[10,20]'],
    ['obj = [-1: 10, (x): 20]\nobj.[-1,(x)] = [30,40]\n[obj.-1,obj "(x)"]', '[30,40]'],
    ['obj = [-1: 10, (x): 20]\n[-1: a, (x): b] = obj\n[a,b]', '[10,20]'],
    ['obj = [(x): [y: 42]]\n(obj "(x)").y', '42'],
    ['obj = [((x)): 4, (): 5]\n[obj "((x))",obj "()"]', '[4,5]'],
    ['obj = [(x + 1): 6]\nobj "(x + 1)"', '6'],
    ['obj = [-1: 1]\n[obj.-1 - 1,obj (-1)]', '[0,["-1",1]]'],
] as const) Deno.test(`literal extended field names: ${source}`, () => {
    const actual = result(source);
    if (actual !== expected) throw new Error(`${actual} != ${expected}`);
});
for (const source of ['obj.(', 'obj.(x]', 'obj.-x', 'obj.- = 1']) {
    Deno.test(`malformed field name: ${source}`, () => {
        try { parseDocument(source); } catch { return; }
        throw new Error('accepted malformed key');
    });
}
Deno.test('extended record key rendering reparses', () => {
    const printed = result('[-1: 1, (x): 2]');
    if (result(printed) !== printed) throw new Error(printed);
});
