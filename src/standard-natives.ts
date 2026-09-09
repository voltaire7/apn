import type { Interpreter } from "./interp.ts";
import { type Value, mkList, mkStr } from "./types.ts";
import { APNError } from "./errors.ts";

// Representation, effects and Unicode casing are the stdlib's native boundary.
export const STANDARD_NATIVES: Array<[string, number]> = [
    ["seq", 2], ["fail", 1], ["chars", 1], ["fromChars", 1], ["upper", 1], ["lower", 1],
];
export function standardNative(i: Interpreter, name: string, args: Value[]): Value {
    const str = (v: Value): string => {
        v = i.demand(v);
        if (v.kind !== "string") throw new APNError("runtime", `${name} expects strings`);
        return v.v;
    };
    if (name === "seq") { i.demand(args[0]); return args[1]; }
    if (name === "fail") throw new APNError("runtime", str(args[0]));
    if (name === "chars") return mkList([...str(args[0])].map((v): Value => ({ kind: "char", v })));
    if (name === "fromChars") return mkStr(i.items(args[0]).map((v) => {
        v = i.demand(v);
        if (v.kind !== "char") throw new APNError("runtime", "fromChars expects a list of Char values");
        return v.v;
    }).join(""));
    const text = str(args[0]);
    return mkStr(name === "upper" ? text.toUpperCase() : text.toLowerCase());
}
