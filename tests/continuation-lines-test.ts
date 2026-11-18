import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

// A line deeper than its statement continues it, whether the operator ends
// the line before or starts the deeper one (as a ternary's ? and : do).
function run(source: string): string {
    const i = new Interpreter();
    i.enableChecking();
    return i.renderString(i.run(parse(source)));
}
const HEADER = `std <- import "std"; [..] = std.option
safeDiv _ 0 = None
safeDiv a b = Some (a / b)
okOr _ (Some x) = Ok x
okOr e None = Err e
`;
const PER_ITEM = [
    `perItem total count =
    okOr "no items" (safeDiv total count)
        >>= share -> share > 100
            ? Err "share too large"
            : Ok share
        >>= checked -> Ok (checked * 2)`,
    `perItem total count =
    okOr "no items" (safeDiv total count)
        >>= share -> share > 100 ? {
            Err "share too large"
        } : {
            Ok share
        } >>= checked -> Ok (checked * 2)`,
    `perItem total count = okOr "no items" (safeDiv total count)
    >>= share -> share > 100 ? Err "share too large" : Ok share
    >>= checked -> Ok (checked * 2)`,
];
for (const [n, definition] of PER_ITEM.entries()) {
    Deno.test(`a >>= chain over continuation lines, layout ${n + 1}`, () => {
        const actual = run(`${HEADER}${definition}\n[perItem 300 2, perItem 300 3, perItem 1 0]`);
        if (actual !== '[Err "share too large", Ok 200, Err "no items"]') throw new Error(actual);
    });
}

for (const [source, expected] of [
    ["x = 1\n    + 2\nx", "3"],
    ["f a = a\n    * 10\n    + 1\nf 2", "21"],
    ["g n = n > 1\n    ? \"big\"\n    : \"small\"\n[g 1, g 2]", '["small","big"]'],
    // A line at the statement's own level starts the next statement.
    ["h = {\n    x = 1\n    -x\n}\nh", "-1"],
    // In a list, a line break separates items.
    ["[\n    1\n    -2\n]", "[1,-2]"],
] as const) {
    Deno.test(`continuation lines: ${JSON.stringify(source)}`, () => {
        const actual = run(source);
        if (actual !== expected) throw new Error(`${actual} != ${expected}`);
    });
}
