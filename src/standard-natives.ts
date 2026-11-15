import { bracket, withFile } from "./resource-scope.ts";
import { ffiNative } from "./ffi.ts";
import { FFI_NATIVES } from "./natives.ts";
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
    if (FFI_NATIVES.some(([n]) => n === name)) return ffiNative(i, name, args);
    const str = (v: Value): string => {
        v = i.dataValue(v);
        if (v.kind !== "string") throw new APNError("runtime", `${name} expects strings`);
        return v.v;
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
    if (name === "fetch") return fetchNative(i, str(args[0]), args[1]);
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
    if (name === "seq") { i.demand(args[0]); return args[1]; }
    if (name === "fail") throw new APNError("runtime", str(args[0]));
    if (name === "chars") return mkList(textNatives.chars(str(args[0])).map((v): Value => ({ kind: "char", v })));
    if (name === "fromChars") return mkStr(textNatives.fromChars(i.items(args[0]).map((v) => {
        v = i.dataValue(v);
        if (v.kind !== "char") throw new APNError("runtime", "from (List Char) expects a list of Char values");
        return v.v;
    })));
    return mkStr(textNatives[name as "upper" | "lower"](str(args[0])));
}

// fetch url options: options is a record of method, headers (an association
// list of strings), body and timeout (milliseconds), each optional, or [] for
// none. The response is a record of status, ok, statusText, url, headers (an
// association list by lowercase name) and body.
function fetchNative(i: Interpreter, url: string, optionsValue: Value): Value {
    const fail = (message: string, hint?: string): never => { throw new APNError("runtime", `fetch: ${message}`, hint ? { hint } : {}); };
    const text = (value: Value, what: string): string => {
        const v = i.dataValue(value);
        return v.kind === "string" ? v.v : fail(`${what} must be a string`);
    };
    const options = i.dataValue(optionsValue);
    const fields: Array<[string, Value]> = options.kind === "record" ? options.v : i.isList(options) && !i.items(options).length ? [] :
        fail("options must be a record such as [method = \"POST\"], or [] for none");
    let method = "GET", body: string | undefined, timeout: number | undefined;
    const headers: Array<[string, string]> = [];
    for (const [option, value] of fields) {
        if (option === "method") method = text(value, "method").toUpperCase();
        else if (option === "body") body = text(value, "body");
        else if (option === "timeout") {
            const v = i.dataValue(value);
            if (v.kind !== "int" || v.v <= 0n) fail("timeout must be a positive Int (milliseconds)");
            timeout = Number((v as { v: bigint }).v);
        } else if (option === "headers") {
            const pairs = i.dataValue(value), hint = 'headers = [["Content-Type", "text/plain"]]';
            if (!i.isList(pairs)) fail("headers must be an association list of strings", hint);
            for (const entry of i.items(pairs)) {
                const pair = i.dataValue(entry), parts = i.isList(pair) ? i.items(pair) : [];
                if (parts.length !== 2) fail("headers must be [name,value] pairs", hint);
                headers.push([text(parts[0], "a header name"), text(parts[1], "a header value")]);
            }
        } else fail(`unknown option '${option}'`, "fetch options are method, headers, body and timeout");
    }
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
