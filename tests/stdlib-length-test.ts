import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

// lib/std/sequence.apn declares that these return a list as long as their
// list argument (reverse (xs : Vect n a) : Vect n a), which their runs check;
// so do the functions the checker infers from them. Each keeps it, unchecked.
const calls: Record<string, string> = {
    reverse: "reverse xs",
    sortBy: "sortBy compare xs",
    zipWithIndex: "zipWithIndex xs",
    sort: "sort xs",
    sortOn: "sortOn (x -> -x) xs",
    forceList: "forceList xs",
};
const inputs = ["[]", "[7]", "[3,1]", "[2,2,2]", "[5,1,4,1,5,9,2,6]", "[9,8,7,6,5,4,3,2,1,0,-1]"];
for (const [name, call] of Object.entries(calls)) {
    Deno.test(`${name} returns a list as long as its argument`, () => {
        const i = new Interpreter();
        i.run(parse('std <- import "std"; [..] = std.sequence'));
        for (const input of inputs) {
            const lengths = i.renderString(i.run(parse(`xs = ${input}; [length xs, length (${call})]`)));
            const [before, after] = JSON.parse(lengths);
            if (before !== after) throw new Error(`${call} with ${input}: length ${before} became ${after}`);
        }
    });
}
