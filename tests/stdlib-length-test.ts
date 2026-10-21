import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";
import { DECLARED_KEEPS_LENGTH } from "../src/type-checker.ts";

// The checker trusts DECLARED_KEEPS_LENGTH in src/type-checker.ts: these
// standard-library functions return a list as long as their list argument.
// Verify that claim at runtime (unchecked, so the claim itself is not assumed),
// together with the functions the checker infers from them.
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
        i.run(parse('import "sequence"'));
        for (const input of inputs) {
            const lengths = i.renderString(i.run(parse(`xs = ${input}; [length xs, length (${call})]`)));
            const [before, after] = JSON.parse(lengths);
            if (before !== after) throw new Error(`${call} with ${input}: length ${before} became ${after}`);
        }
    });
}
Deno.test("every declared length-preserving function is verified here", () => {
    const missing = [...DECLARED_KEEPS_LENGTH].filter(name => !(name in calls));
    if (missing.length) throw new Error(`add runtime checks for: ${missing.join(", ")}`);
});
