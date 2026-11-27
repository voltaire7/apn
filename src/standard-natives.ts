import { bracket, withFile } from "./resource-scope.ts";
import { ffiNative } from "./ffi.ts";
import { FFI_NAMES } from "./natives.ts";
import type { Interpreter } from "./interp.ts";
import { type Value, mkBool, mkInt, mkList, mkStr } from "./types.ts";
import { APNError } from "./errors.ts";
import { fetchSync, HttpFailure } from "./http.ts";
import { fromJson, toJson } from "./json.ts";
import { textNatives } from "./text-natives.ts";
import { p5Object, p5SketchType } from "./p5.ts";

export function standardNative(i: Interpreter, name: string, args: Value[]): Value {
    if (name === "bracket") return bracket(i, args[0], args[1], args[2]);
    if (name === "withFile") return withFile(i, args[0], args[1]);
    if (FFI_NAMES.has(name)) return ffiNative(i, name, args);
    const str = (v: Value): string => {
        // (A list of Chars is the String it is: String = List Char.)
        const text = i.textOf(i.dataValue(v));
        if (text === undefined) throw new APNError("runtime", `${name} expects strings`);
        return text;
    };
    if (name === "getArgs") return mkList(i.programArgs.map(mkStr));
    if (name === "p5Object") return p5Object(str(args[0]), i.items(args[1]));
    if (name === "p5SketchType") return p5SketchType();
    // A random 32-bit seed (random), the time in milliseconds since 1970 and
    // the local offset from UTC in minutes (time).
    if (name === "entropy") return mkInt(crypto.getRandomValues(new Uint32Array(1))[0]);
    if (name === "currentTime") return mkInt(Date.now());
    if (name === "zoneOffset") return mkInt(-new Date().getTimezoneOffset());
    if (name === "toJson" || name === "prettyJson") return mkStr(toJson(i, args[0], name === "prettyJson" ? 2 : 0, name));
    if (name === "fromJson") return fromJson(str(args[0]));
    if (name === "sendRequest") return sendRequest(i, args, str);
    if (name === "readFile" || name === "readStdin") {
        try {
            if (name === "readFile") {
                // The contents the checker saw, when it read this file before the run.
                const path = str(args[0]);
                return mkStr(i.inputFile(path) ?? Deno.readTextFileSync(path));
            }
            return mkStr(i.inputStdin());
        } catch (error) {
            throw new APNError("runtime", `${name}: ${error instanceof Error ? error.message : error}`);
        }
    }
    if (name === "fail") throw new APNError("runtime", str(args[0]));
    if (name === "chars") return mkList(textNatives.chars(str(args[0])).map((v): Value => ({ kind: "char", v })));
    // (Each item is read as the list is walked: [0..] fails at its first.)
    if (name === "fromChars") {
        const out: string[] = [];
        for (const item of i.elements(args[0])) {
            const v = i.dataValue(item);
            if (v.kind !== "char") throw new APNError("runtime", "a String is a list of Char values");
            out.push(v.v);
        }
        return mkStr(textNatives.fromChars(out));
    }
    return mkStr(textNatives[name as "upper" | "lower"](str(args[0])));
}

// sendRequest url method headers body timeout: the request lib/std/http.apn's
// fetch makes from its options (headers [name,value] pairs of strings, an
// empty body none, a timeout in milliseconds, 0 for none). The response is a
// record of status, ok, statusText, url, headers (an association list by
// lowercase name) and body.
function sendRequest(i: Interpreter, args: Value[], str: (v: Value) => string): Value {
    const fail = (message: string, hint?: string): never => { throw new APNError("runtime", `fetch: ${message}`, hint ? { hint } : {}); };
    const url = str(args[0]), method = str(args[1]), body = str(args[3]) || undefined;
    const headers = i.items(i.dataValue(args[2])).map(pair => i.items(i.dataValue(pair)).map(str) as [string, string]);
    const timeout = Number((i.dataValue(args[4]) as { v: bigint }).v) || undefined;
    let response;
    try { response = fetchSync({ url, method, headers, body, timeout }); }
    catch (error) {
        if (!(error instanceof HttpFailure)) throw error;
        return fail(`${url}: ${error.message}`, error.permission ? "allow network access: run with ./apn, or deno run --allow-net" : undefined);
    }
    return {
        kind: "record", v: [
            ["status", mkInt(response.status)], ["ok", mkBool(response.ok)], ["statusText", mkStr(response.statusText)],
            ["url", mkStr(response.url)], ["headers", mkList(response.headers.map(([k, v]) => mkList([mkStr(k), mkStr(v)])))], ["body", mkStr(response.body)],
        ],
    };
}
