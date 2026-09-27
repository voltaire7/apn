import { keyText } from "./record-keys.ts";
import type { Interpreter } from "./interp.ts";
import { type Value, type NativePointer, mkStr, mkBool } from "./types.ts";
import { APNError } from "./errors.ts";
import { isNumeric } from "./numbers.ts";
import { castNumeric } from "./type-system.ts";

export const FFI_NATIVES: Array<[string, number]> = [
    ["withLibrary", 3], ["allocate", 2], ["peek", 2], ["poke", 3], ["offset", 2], ["nullPointer", 1],
];
const abi: Record<string, Deno.NativeType | "void"> = {
    Int8: "i8", UInt8: "u8", Int16: "i16", UInt16: "u16", Int32: "i32", UInt32: "u32",
    Int64: "i64", UInt64: "u64", Float32: "f32", Float: "f64", Float64: "f64",
    Bool: "bool", Pointer: "pointer", String: "buffer", Unit: "void",
};
const widths: Record<string, number> = { Int8: 1, UInt8: 1, Int16: 2, UInt16: 2,
    Int32: 4, UInt32: 4, Int64: 8, UInt64: 8, Float32: 4, Float: 8, Float64: 8, Bool: 1 };
const fail = (message: string): never => { throw new APNError("runtime", `C interop: ${message}`); };
function typeName(i: Interpreter, value: Value): string {
    const type = i.demand(value);
    if (type.kind !== "type" || type.family || !Object.hasOwn(abi, type.name)) return fail("expected a C-compatible type (use fixed-width integers, Float, Bool, String, Pointer or Unit)");
    return type.name;
}
function pointer(i: Interpreter, value: Value): NativePointer {
    const p = i.dataValue(value);
    if (p.kind !== "pointer") return fail("expected Pointer");
    const pending: NativePointer[] = [p];
    const seen = new Set<NativePointer>();
    while (pending.length) {
        const current = pending.pop()!;
        if (seen.has(current)) continue;
        seen.add(current);
        if (current.owner?.closed) return fail("pointer belongs to a closed library");
        for (const root of current.roots ?? []) {
            if (root && typeof root === "object" && "kind" in root && root.kind === "pointer") pending.push(root as NativePointer);
        }
    }
    return p;
}
function memoryPermission(): void {
    if (Deno.permissions.querySync({ name: "ffi" }).state !== "granted") {
        fail("Pointer memory and String results require apn --allow-ffi (without a path restriction)");
    }
}
function makePointer(address: Deno.PointerValue, owner?: { closed: boolean }): NativePointer {
    if (address !== null) memoryPermission();
    return { kind: "pointer", address, bits: address === null ? 0n : Deno.UnsafePointer.value(address), owner, offset: 0 };
}
function count(i: Interpreter, value: Value): number {
    const v = i.dataValue(value);
    if (v.kind !== "int" || v.v < 0n || v.v > BigInt(Number.MAX_SAFE_INTEGER)) return fail("expected a nonnegative safe integer");
    return Number(v.v);
}
function encode(i: Interpreter, name: string, raw: Value): number | bigint | boolean | Uint8Array | Deno.PointerValue {
    if (name === "Pointer") return pointer(i, raw).address;
    const v = i.dataValue(raw);
    if (name === "Bool") { if (v.kind !== "bool") return fail("Bool argument expected"); return v.v; }
    if (name === "String") {
        if (v.kind !== "string") return fail("String argument expected");
        if (v.v.includes("\0")) return fail("C strings cannot contain an embedded NUL");
        return new TextEncoder().encode(v.v + "\0");
    }
    if (!isNumeric(v)) return fail(`${name} argument must be numeric`);
    const converted = castNumeric(name, v);
    if (converted.kind === "int") return name.endsWith("64") ? converted.v : Number(converted.v);
    if (converted.kind !== "float") return fail(`${name} must convert to a C float`);
    return converted.v;
}
function decode(name: string, value: unknown, owner?: { closed: boolean }): Value {
    if (name === "Unit") return { kind: "unit" };
    if (name === "Pointer") return makePointer(value as Deno.PointerValue, owner);
    if (name === "String") {
        if (value === null) return fail("C function returned a null String pointer");
        memoryPermission();
        return mkStr(new Deno.UnsafePointerView(value as Deno.PointerObject).getCString());
    }
    if (name === "Bool") return mkBool(Boolean(value));
    return castNumeric(name, name.startsWith("Float")
        ? { kind: "float", v: Number(value) } : { kind: "int", v: BigInt(value as number | bigint) });
}
function memory(p: NativePointer, size: number): DataView {
    if (p.address === null) return fail("cannot dereference a null pointer");
    if (p.length !== undefined && size > p.length) return fail("pointer access exceeds allocated memory");
    if (p.buffer) return new DataView(p.buffer.buffer, p.buffer.byteOffset + p.offset, size);
    // Deno exposes a view backed by external memory; ownership stays with C.
    return new DataView(new Deno.UnsafePointerView(p.address).getArrayBuffer(size));
}
// Native byte order is used for C scalar memory.
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
function read(view: DataView, type: string): unknown {
    switch (type) {
        case "Int8": return view.getInt8(0); case "UInt8": return view.getUint8(0);
        case "Int16": return view.getInt16(0, littleEndian); case "UInt16": return view.getUint16(0, littleEndian);
        case "Int32": return view.getInt32(0, littleEndian); case "UInt32": return view.getUint32(0, littleEndian);
        case "Int64": return view.getBigInt64(0, littleEndian); case "UInt64": return view.getBigUint64(0, littleEndian);
        case "Float32": return view.getFloat32(0, littleEndian); case "Float": case "Float64": return view.getFloat64(0, littleEndian);
        case "Bool": return view.getUint8(0) !== 0;
    }
}
function write(view: DataView, type: string, value: unknown) {
    switch (type) {
        case "Int8": view.setInt8(0, Number(value)); break; case "UInt8": view.setUint8(0, Number(value)); break;
        case "Int16": view.setInt16(0, Number(value), littleEndian); break; case "UInt16": view.setUint16(0, Number(value), littleEndian); break;
        case "Int32": view.setInt32(0, Number(value), littleEndian); break; case "UInt32": view.setUint32(0, Number(value), littleEndian); break;
        case "Int64": view.setBigInt64(0, BigInt(value as bigint), littleEndian); break; case "UInt64": view.setBigUint64(0, BigInt(value as bigint), littleEndian); break;
        case "Float32": view.setFloat32(0, Number(value), littleEndian); break; case "Float": case "Float64": view.setFloat64(0, Number(value), littleEndian); break;
        case "Bool": view.setUint8(0, value ? 1 : 0); break;
    }
}

export function ffiNative(i: Interpreter, name: string, args: Value[]): Value {
    if (typeof Deno === "undefined" || typeof Deno.dlopen !== "function") return fail("available only in the command-line runtime");
    if (["allocate", "offset", "peek", "poke"].includes(name)) memoryPermission();
    if (name === "nullPointer") return makePointer(null);
    if (name === "allocate") {
        const type = typeName(i, args[0]);
        const size = widths[type];
        if (!size) return fail("allocate requires a scalar numeric or Bool type");
        const bytes = size * count(i, args[1]);
        if (bytes > 64 * 1024 * 1024) return fail("allocation exceeds 64 MiB");
        const buffer = new Uint8Array(bytes);
        return { ...makePointer(Deno.UnsafePointer.of(buffer)), buffer, length: bytes, elementType: type };
    }
    if (name === "offset") {
        const n = count(i, args[0]), p = pointer(i, args[1]);
        if (p.address === null) return fail("cannot offset a null pointer");
        if (p.length !== undefined && n > p.length) return fail("pointer offset exceeds allocated memory");
        return { ...p, address: Deno.UnsafePointer.offset(p.address, n), bits: p.bits + BigInt(n), offset: p.offset + n,
            length: p.length === undefined ? undefined : p.length - n };
    }
    if (name === "peek" || name === "poke") {
        const type = typeName(i, args[0]);
        const size = widths[type];
        if (!size) return fail("peek/poke require a scalar numeric or Bool type");
        const p = pointer(i, args[name === "peek" ? 1 : 2]);
        if (name === "peek") return decode(type, read(memory(p, size), type));
        write(memory(p, size), type, encode(i, type, args[1]));
        return { kind: "unit" };
    }
    const path = i.demand(args[0]);
    if (path.kind !== "string") return fail("withLibrary expects a library path string");
    const definitions = i.demand(args[1]);
    if (definitions.kind !== "record") return fail("withLibrary expects a record of function signatures");
    const signatures = new Map<string, { parameters: string[]; result: string }>();
    const foreign: Record<string, Deno.ForeignFunction> = Object.create(null);
    for (const [key, raw] of definitions.v) {
        const symbol = keyText(key);
        if (Object.hasOwn(foreign, symbol)) return fail(`duplicate C symbol ${JSON.stringify(symbol)}`);
        const definition = i.demand(raw);
        if (definition.kind !== "record") return fail(`${symbol}: expected ffi.function parameters result`);
        const fields = new Map(definition.v);
        if (!fields.has("parameters") || !fields.has("result")) return fail(`${symbol}: missing parameters or result`);
        const parameters = i.items(fields.get("parameters")!).map((p) => typeName(i, p));
        if (parameters.includes("Unit")) return fail(`${symbol}: Unit is a result type; use [] for no C parameters`);
        const result = typeName(i, fields.get("result")!);
        signatures.set(key, { parameters, result });
        foreign[symbol] = { parameters: parameters.map((p) => abi[p] as Deno.NativeType), result: result === "String" ? "pointer" : abi[result] as Deno.NativeResultType };
    }
    const resolved = path.v.startsWith("/") || i.sourceDir === "." ? path.v : `${i.sourceDir}/${path.v}`;
    let library: Deno.DynamicLibrary<typeof foreign>;
    try { library = Deno.dlopen(resolved, foreign); }
    catch (error) { return fail(`cannot open ${JSON.stringify(path.v)}: ${error instanceof Error ? error.message : error}`); }
    const owner = { closed: false };
    const bindings: Value = { kind: "record", v: [...signatures].map(([key, signature]) => {
        const symbol = keyText(key);
        const fn: Value = { kind: "native", name: symbol, arity: signature.parameters.length, applied: [], invoke: (values) => {
            if (owner.closed) return fail(`cannot call ${symbol}: library is closed`);
            if (!signature.parameters.length && values.length && i.demand(values[0]).kind !== "unit") return fail(`${symbol} takes no arguments (an explicit () is also accepted)`);
            const evaluated = signature.parameters.map((_, index) => i.demand(values[index]));
            const converted = signature.parameters.map((type, index) => encode(i, type, evaluated[index]));
            const call = library.symbols[symbol] as (...args: unknown[]) => unknown;
            const result = call(...converted);
            const decoded = decode(signature.result, result, owner);
            if (decoded.kind === "pointer") {
                decoded.roots = [...evaluated, ...converted];
                const origins = evaluated.filter((v): v is NativePointer => v.kind === "pointer");
                for (const value of converted) if (value instanceof Uint8Array) {
                    origins.push({ ...makePointer(Deno.UnsafePointer.of(value)), buffer: value, length: value.length });
                }
                for (const origin of origins) {
                    if (origin.buffer && origin.length !== undefined && decoded.bits >= origin.bits && decoded.bits <= origin.bits + BigInt(origin.length)) {
                        const delta = Number(decoded.bits - origin.bits);
                        decoded.buffer = origin.buffer;
                        decoded.offset = origin.offset + delta;
                        decoded.length = origin.length - delta;
                        decoded.elementType = origin.elementType;
                        break;
                    }
                }
            }
            return decoded;
        } };
        return [key, fn];
    }) };
    try {
        // Demand the callback result while the library is open. Lazy fields that
        // escape retain closed checks rather than calling unloaded machine code.
        return i.demand(i.apply(i.demand(args[2]), bindings));
    } finally { owner.closed = true; library.close(); }
}
