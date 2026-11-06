// JSON text and APN values (the json module): toJson and prettyJson encode,
// fromJson decodes. Integers stay exact both ways; null becomes []. A record's
// key is a name, any text, so a JSON object's keys are its fields' names
// (r.status, r.`Content-Type`, r "Content-Type").
import { APNError } from "./errors.ts";
import type { Interpreter } from "./interp.ts";
import { type Value, mkBool, mkList, mkStr } from "./types.ts";

export function toJson(i: Interpreter, value: Value, indent = 0, name = "toJson"): string {
    const fail = (message: string, hint?: string): never => { throw new APNError("runtime", `${name}: ${message}`, hint ? { hint } : {}); };
    const encode = (input: Value, depth: number): string => {
        const v = i.dataValue(input);
        const pad = (n: number) => indent ? "\n" + " ".repeat(indent * n) : "";
        const join = (parts: string[], open: string, close: string) =>
            parts.length ? open + parts.map(part => pad(depth + 1) + part).join(",") + pad(depth) + close : open + close;
        switch (v.kind) {
            case "string": case "char": return JSON.stringify(v.v);
            case "bool": return v.v ? "true" : "false";
            case "int": return v.v.toString();
            case "float":
                if (!Number.isFinite(v.v)) fail(`${v.v} has no JSON number`);
                return JSON.stringify(v.v);
            case "rational": case "complex":
                return fail(`${i.renderString(v)} has no JSON number`, "convert it with inexact first (a JSON number is an integer or a float)");
            case "record":
                return join(v.v.map(([key, item]) => `${JSON.stringify(key)}:${indent ? " " : ""}${encode(item, depth + 1)}`), "{", "}");
            case "hashmap":
                return join([...v.entries.values()].map(([key, item]) => {
                    const k = i.dataValue(key);
                    if (k.kind !== "string" && k.kind !== "char") fail("a HashMap's keys must be strings to become a JSON object");
                    return `${JSON.stringify((k as { v: string }).v)}:${indent ? " " : ""}${encode(item, depth + 1)}`;
                }), "{", "}");
            case "variant":
                return fail(`cannot encode the variant ${v.tag}`, "convert it to a record, list or string first");
            default:
                if (i.isList(v)) return join(i.items(v).map(item => encode(item, depth + 1)), "[", "]");
                return fail(`cannot encode a ${v.kind} value`);
        }
    };
    return encode(value, 0);
}

export function fromJson(text: string, name = "fromJson"): Value {
    let pos = 0;
    const fail = (message: string): never => { throw new APNError("runtime", `${name}: ${message} at position ${pos}`); };
    const space = () => { while (pos < text.length && " \t\n\r".includes(text[pos])) pos++; };
    const expect = (literal: string) => {
        if (text.startsWith(literal, pos)) { pos += literal.length; return; }
        fail(`expected ${JSON.stringify(literal)}`);
    };
    const string = (): string => {
        const match = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(text.slice(pos));
        if (!match) fail("invalid string");
        pos += match![0].length;
        return JSON.parse(match![0]);
    };
    const value = (): Value => {
        space();
        const c = text[pos];
        if (c === "{") {
            pos++;
            const fields: Array<[string, Value]> = [];
            space();
            if (text[pos] === "}") { pos++; return { kind: "record", v: fields }; }
            for (;;) {
                space();
                if (text[pos] !== '"') fail("expected a string key");
                const key = string();
                space(); expect(":");
                const item = value();
                // A repeated key keeps its last value, as JSON.parse does.
                const at = fields.findIndex(([k]) => k === key);
                if (at >= 0) fields.splice(at, 1);
                fields.push([key, item]);
                space();
                if (text[pos] === ",") { pos++; continue; }
                expect("}");
                return { kind: "record", v: fields };
            }
        }
        if (c === "[") {
            pos++;
            const items: Value[] = [];
            space();
            if (text[pos] === "]") { pos++; return mkList(items); }
            for (;;) {
                items.push(value());
                space();
                if (text[pos] === ",") { pos++; continue; }
                expect("]");
                return mkList(items);
            }
        }
        if (c === '"') return mkStr(string());
        if (text.startsWith("true", pos)) { pos += 4; return mkBool(true); }
        if (text.startsWith("false", pos)) { pos += 5; return mkBool(false); }
        if (text.startsWith("null", pos)) { pos += 4; return mkList([]); }
        const number = /^-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(pos));
        if (!number) return fail(pos >= text.length ? "unexpected end of input" : `unexpected ${JSON.stringify(text[pos])}`);
        pos += number[0].length;
        // Integers stay exact; others are floats, as JSON numbers are.
        return number[1] || number[2] ? { kind: "float", v: Number(number[0]) } : { kind: "int", v: BigInt(number[0]) };
    };
    const result = value();
    space();
    if (pos < text.length) fail(`unexpected ${JSON.stringify(text[pos])}`);
    return result;
}
