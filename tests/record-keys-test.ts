import { keySource } from "../src/record-keys.ts";
import { Interpreter } from "../src/interp.ts";
import { parseDocument, exprToSource } from "../src/parser.ts";
import { valueToString } from "../src/types.ts";

// A record's key is a name; one that is not written as a name is in backticks,
// and a string reads the field it names.
function result(source: string): string {
    const i = new Interpreter();
    return i.renderString(i.run(parseDocument(source)));
}
for (const [name, source, expected] of [
    ["named field access", 'obj = [field = 123]\n[obj.field, obj "field"]', '[123,123]'],
    ["a backticked key", 'obj = [`Content-Type` = "json", `my field` = 1]\n[obj.`Content-Type`, obj "my field"]', '["json",1]'],
    ["a backticked name is the name", 'obj = [`x` = 1]\nobj.x', '1'],
    ["a dotted string reads its field", 'obj = [`a b` = 1]\nobj."a b"', '1'],
    ["computed keys", 'obj = [field = 123]\nkey = "field"\nobj key', '123'],
    ["list indexing", 'arr = [10,20]\narr 0', '10'],
    ["printing writes backticks", '[x = 1, `a b` = 2, `1` = 3]', '[x = 1, `a b` = 2, `1` = 3]'],
    ["named update", 'obj = [x = 1, y = 2]\nobj.x = 3\nobj', '[x = 3, y = 2]'],
    ["backticked update", 'obj = [`a b` = 1]\nobj.`a b` = 2\nobj', '[`a b` = 2]'],
    ["string update", 'obj = [x = 1]\nobj "x" = 3\nobj', '[x = 3]'],
    ["renamed selection", 'obj = [x = 1, y = 2]\nobj.[first = x, second = y]', '[first = 1, second = 2]'],
    ["keyed destructuring", 'obj = [x = 1, y = 2]\n[x = a, y = b] = obj\n[a,b]', '[1,2]'],
    ["bare destructuring", '[x] = [x = 1, y = 2]\nx', '1'],
    ["pattern dispatch", 'f [x = value] = value + 10\n[f [x = 1], f [x = 2]]', '[11,12]'],
    ["unused values stay deferred", 'unused = missing + 1\nobj = [x = 1, y = unused]\nobj "x"', '1'],
    ["fields are computed when used", 'obj = [x = head [], y = 2]\nobj.y', '2'],
    ["pairs give the key's text", 'pairs [x = 1, `a b` = 2]', '[["x",1],["a b",2]]'],
    ["a record to HashMap", 'm = HashMap [x = 1]\nm "x"', '1'],
    ["function source keys", 'f obj = obj.`a b`\nf', 'obj -> obj.`a b`'],
    ["function source patterns", 'f [x = value] = value\nf', '[x = value] -> value'],
    ["function source records", 'f x = [x = x, y = x]\nf', 'x -> [x = x, y = x]'],
] as const) {
    Deno.test(`record keys: ${name}`, () => {
        const actual = result(source);
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
}
for (const [source, message] of [
    ['obj = [x = 1]\nobj.y', "no field 'y'"],
    ['obj = [x = 1]\nobj "y"', "no field 'y'"],
    ['arr = [10,20]\narr "0"', 'association lookup expects'],
    ['f [x = v] = v\nf [y = 1]', 'no clause'],
    ['obj = [x: 1]', "a record's field is written x = 1"],
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
    for (const key of ['field', 'my field', 'a"b', 'a\\b', 'Content-Type', '123']) {
        const source = `[x = 1, ${keySource(key)} = 2]`;
        const parsed = parseDocument(source)[0];
        if (parsed.t !== "expr") throw new Error("expected expression");
        const i = new Interpreter();
        const value = i.run([parsed]);
        for (const text of [exprToSource(parsed.value), i.renderString(value), valueToString(value)]) {
            if (result(text) !== result(source)) throw new Error(`Lost the key: ${text}`);
        }
    }
});
for (const source of ['obj.(', 'obj.(x]', 'obj.-x', 'obj.- = 1', 'x = `a', 'x = ``']) {
    Deno.test(`malformed field name: ${source}`, () => {
        try { parseDocument(source); } catch { return; }
        throw new Error('accepted malformed key');
    });
}
