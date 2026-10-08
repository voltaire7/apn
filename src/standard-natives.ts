import { bracket, withFile } from "./resource-scope.ts";
import { FFI_NATIVES, ffiNative } from "./ffi.ts";
import type { Interpreter } from "./interp.ts";
import { type Value, mkList, mkStr } from "./types.ts";
import { APNError } from "./errors.ts";

// Representation, effects and Unicode casing are the stdlib's native boundary.
export const STANDARD_NATIVES: Array<[string, number]> = [
    ...FFI_NATIVES,
    ["bracket", 3], ["withFile", 2], ["readFile", 1], ["readStdin", 1], ["getArgs", 0],
    ["seq", 2], ["fail", 1], ["chars", 1], ["fromChars", 1], ["upper", 1], ["lower", 1],
];
export function standardNative(i: Interpreter, name: string, args: Value[]): Value {
    if (name === "bracket") return bracket(i, args[0], args[1], args[2]);
    if (name === "withFile") return withFile(i, args[0], args[1]);
    if (FFI_NATIVES.some(([n]) => n === name)) return ffiNative(i, name, args);
    const str = (v: Value): string => {
        v = i.dataValue(v);
        if (v.kind !== "string") throw new APNError("runtime", `${name} expects strings`);
        return v.v;
    };
    if (name === "getArgs") return mkList(i.programArgs.map(mkStr));
    if (name === "readFile" || name === "readStdin") {
        try {
            if (name === "readFile") {
                // The contents the checker saw, when it read this file before the run.
                const path = str(args[0]);
                return mkStr(i.inputFile(path) ?? Deno.readTextFileSync(path));
            }
            const decoder = new TextDecoder();
            const buffer = new Uint8Array(65536);
            const chunks: string[] = [];
            for (;;) {
                const count = Deno.stdin.readSync(buffer);
                if (count === null) break;
                chunks.push(decoder.decode(buffer.subarray(0, count), { stream: true }));
            }
            chunks.push(decoder.decode());
            return mkStr(chunks.join(""));
        } catch (error) {
            throw new APNError("runtime", `${name}: ${error instanceof Error ? error.message : error}`);
        }
    }
    if (name === "seq") { i.demand(args[0]); return args[1]; }
    if (name === "fail") throw new APNError("runtime", str(args[0]));
    if (name === "chars") return mkList([...str(args[0])].map((v): Value => ({ kind: "char", v })));
    if (name === "fromChars") return mkStr(i.items(args[0]).map((v) => {
        v = i.dataValue(v);
        if (v.kind !== "char") throw new APNError("runtime", "fromChars expects a list of Char values");
        return v.v;
    }).join(""));
    const text = str(args[0]);
    return mkStr(name === "upper" ? text.toUpperCase() : text.toLowerCase());
}
