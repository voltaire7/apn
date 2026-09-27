import type { Value } from "./types.ts";
import { NUMERIC_TYPES, castNumeric } from "./type-system.ts";
import { integer, floating } from "./numbers.ts";

// The descriptor remains available for application and pattern matching. Value
// consumers ask for its zero state without replacing the shared descriptor.
export function builtinZero(name: string): Value | undefined {
    if (NUMERIC_TYPES.includes(name)) {
        return castNumeric(name, name === "Inexact" ? floating(0) : integer(0n));
    }
    switch (name) {
        case "Bool": return { kind: "bool", v: false };
        case "String": return { kind: "string", v: "" };
        case "Char": return { kind: "char", v: "\0" };
        case "Unit": return { kind: "unit" };
        case "List": return { kind: "list", v: [] };
        case "Record": return { kind: "record", v: [] };
        case "HashMap": return { kind: "hashmap", entries: new Map() };
        case "Pointer": return { kind: "pointer", address: null, bits: 0n, offset: 0 };
    }
}
