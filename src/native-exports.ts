// The standard natives each standard module exports, by module: a program
// reaches them only through that import (import "function" for fail).
export const NATIVE_EXPORTS: Record<string, string[]> = {
    ffi: ["withLibrary", "allocate", "peek", "poke", "offset", "nullPointer"],
    io: ["withFile", "readFile", "readStdin", "getArgs"],
    function: ["bracket", "fail", "seq", "do"],
    text: ["chars", "fromChars", "upper", "lower"],
    http: ["fetch"],
    json: ["toJson", "prettyJson", "fromJson"],
};
// The module exporting a standard native, for "add import" hints.
export function nativeModule(name: string): string | undefined {
    return Object.keys(NATIVE_EXPORTS).find(module => NATIVE_EXPORTS[module].includes(name));
}
