import { Interpreter } from "../src/interp.ts";
import { parseDocument } from "../src/parser.ts";

for (const [name, source, expected] of [
    ["reported example", 'obj = [x = 1]\nobj "x" = 10\n[obj, obj.x, obj "x"]', '[[x = 10], 10, 10]'],
    ["adds named field", 'obj = [y = 2]\nobj "x" = 10\nobj', '[y = 2, x = 10]'],
    ["sequential updates use old RHS", 'obj = [x = 1]\nobj "x" = obj.x + 1\nobj "x" = obj "x" + 1\nobj.x', '3'],
    ["block scopes update", 'obj = [x = 1]\ninner = { obj "x" = 10; obj }\n[inner,obj]', '[[x = 10], [x = 1]]'],
    ["captured alias keeps old record", 'obj = [x = 1]\nold <- return obj\nobj "x" = 10\n[old,obj]', '[[x = 1], [x = 10]]'],
    ["unused field remains deferred", 'unused = missing + 1\nobj = [x = 1, other = unused]\nobj "x" = 10\nobj.x', '10'],
    ["list value remains lazy", 'obj = [x = [0]]\nobj "x" = [missing,2]\nobj.x 1', '2'],
    ["string pattern functions", 'f "x" = 10\nf "y" = 20\n[f "x", f "y"]', '[10,20]'],
    ["existing functions", 'f x = x\nf "x" = 10\nf "x"', '10'],
    ["action returning record", 'obj = { [x = 1] }\nobj "x" = 10\nobj', '[x = 10]'],
    // A typed entry declares the field anew, as x : T = e does; the others
    // are assigned as usual.
    ["typed entries declare", 'v = [x = 1, y = 2]\nv.[x : Float, y] = [3,4]\n[v, typeOf v.y]', '[[x = 3.0, y = 4], Int]'],
    ["typed entries from a value", 'v = [x = 1]\nvs = [5]\nt = Int8\nv.[x : t] = vs\ntypeOf v.x', 'Int8'],
    ["typed renamed entries", 'w = [x = 1, y = 2]\nw.[x : Float = p, y = q] = [p = 9, q = 8]\nw', '[x = 9.0, y = 8]'],
    ["typed nested entries", 'r = [c = [n = 1]]\nr.c.[n : Float] = [2]\nr', '[c = [n = 2.0]]'],
    ["typed entries add a field", 'v = [x = 1]\nv.[z : Float] = [1]\nv', '[x = 1, z = 1.0]'],
] as const) {
    Deno.test(`record assignment: ${name}`, () => {
        const i = new Interpreter();
        const actual = i.renderString(i.run(parseDocument(source)));
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
}
Deno.test("REPL record assignment preserves the record", () => {
    const i = new Interpreter();
   
    for (const line of ['obj = [x = 1]', 'obj "x"', 'obj "x" = 10']) i.run(parseDocument(line));
    const actual = i.renderString(i.run(parseDocument('obj')));
    if (actual !== '[x = 10]') throw new Error(actual);
});
for (const [assignment, error] of [
    ['obj.[x : Int8] = [300]', "out of range"],
    ['obj "x" = missing', "unbound variable"],
    ['obj key = 10', 'unbound variable'],
    ['obj "x" "y" = 10', 'one index'],
    ['obj 0 = 10', 'an entry is a [key,value] pair'],
] as const) {
    Deno.test(`failed record assignment preserves binding: ${assignment}`, () => {
        const i = new Interpreter();
        i.run(parseDocument('obj = [x = 1]'));
        let failed = false;
        try { i.run(parseDocument(assignment)); } catch (e) {
            if (!(e instanceof Error) || !e.message.includes(error)) throw e;
            failed = true;
        }
        if (!failed || i.renderString(i.run(parseDocument('obj'))) !== '[x = 1]') {
            throw new Error('Failed assignment replaced the record');
        }
    });
}

Deno.test("record application accepts NUL as an ordinary key character", () => {
    const i = new Interpreter();
    const source = 'obj = [x = 1]\nobj "\\u0000x" = 10\n[obj "\\u0000x", obj.x]';
    const actual = i.renderString(i.run(parseDocument(source)));
    if (actual !== "[10,1]") throw new Error(actual);
});
