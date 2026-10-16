// The standard natives each standard module exports, by module: a program
// reaches them only through that import (import "function" for fail).
export const NATIVE_EXPORTS: Record<string, string[]> = {
    ffi: ["withLibrary", "allocate", "peek", "poke", "offset", "nullPointer"],
    io: ["withFile", "readFile", "readStdin", "getArgs"],
    function: ["bracket", "fail", "seq", "do"],
    text: ["upper", "lower"],
    http: ["fetch"],
    json: ["prettyJson"],
    random: ["entropy"],
    time: ["currentTime", "zoneOffset"],
};
// Natives that to and from spell now (to String x for toString x): internal,
// not bound for programs; each with what to write instead.
export const RETIRED_NATIVES: Record<string, string> = {
    toString: "to String", intToString: "to String", parse: "from String",
    chars: "to (List Char)", fromChars: "from (List Char)", toJson: "to JSON", fromJson: "from JSON",
};
// The module exporting a standard native, for "add import" hints.
export function nativeModule(name: string): string | undefined {
    return Object.keys(NATIVE_EXPORTS).find(module => NATIVE_EXPORTS[module].includes(name));
}
