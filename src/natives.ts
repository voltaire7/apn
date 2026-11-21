// Every native and each fact about it, said once: its arity, the standard
// module that exports it, and how the interpreter and the checker treat it. A
// native is a name bound to JavaScript (docs/intrinsics.md gives each in APN).
import { NUMBER_NATIVES } from "./numbers.ts";
import { PRIMITIVE_OPERATORS } from "./parser.ts";

// The natives every program has, by arity (also REPL tab completion).
export const NATIVES: Array<[string, number]> = [
    ...NUMBER_NATIVES,
    ["assert", 2], ["intrinsics.match", 2], ["set", 2], ["while", 2], ["for", 2], ["typeOf", 1], ["isType", 2], ["insert", 2], ["lookup", 2], ["has", 2], ["remove", 2], ["keys", 1], ["values", 1],
    ["print", 1], ["debug", 1], ["repl", 0], ["compile", 2], ["head", 1], ["tail", 1], ["length", 1], ["null", 1],
    ["iterate", 2], ["enumerate", 1], ["map", 2], ["filter", 2], ["foldl", 3], ["foldr", 3],
    ["intToString", 1], ["pairs", 1], ["format", 2], ["zipWith", 3],
    ["take", 2], ["drop", 2], ["toString", 1], ["parse", 1], ["exit", 1], ["[..]", 1],
    ["emit", 1], ["step", 2], ["intrinsics.syntax", 1], ["intrinsics.written", 1], ["intrinsics.binding", 1], ["intrinsics.yields", 1], ["intrinsics.runs", 1], ["intrinsics.bound", 2], ["intrinsics.eval", 1], ["intrinsics.fixity", 1],
    ...[...PRIMITIVE_OPERATORS.keys()].map((name): [string, number] => [name, 2]),
    // Functor, Applicative and Monad, for actions, lists and Option-like variants.
    // seq a b: b, once a is evaluated (std/function's seq; foldl's strictness).
    ["intrinsics.seq", 2],
    ["intrinsics.bind", 2], ["intrinsics.negate", 1], ["intrinsics.range", 3], ["intrinsics.ap", 2], ["intrinsics.return", 1], ["intrinsics.throw", 1], ["intrinsics.source", 1],
    // view build match: a pattern defined by a function taking values apart.
    ["view", 2],
    // Whether a value is a function, and the type one takes (the prelude's Takes).
    ["intrinsics.isFunction", 1], ["intrinsics.inputOf", 1],
    // to T x writes x as a T; from T x reads it back (methods, like map).
    ["to", 2], ["from", 2],
    // tag owner ctor fields: a value made by ctor, belonging to owner.
    ["intrinsics.tag", 3],
    // get v k: what applying a value that is not a function gives (xs 2, r "x").
    ["intrinsics.get", 2],
    // with v k x: a copy of v with k set to x (xs 2 = x binds xs to with xs 2 x).
    ["intrinsics.with", 3],
    // The union and the intersection of sets: of types (Mixed = Int | String),
    // or of values read as sets (see setOf): a | b, a & b.
    ["intrinsics.union", 1],
    ["intrinsics.intersection", 1],
    // truthy x: x's truth, which conditions read.
    ["intrinsics.truthy", 1],
    // refine T p: the values of T for which p is True (Positive = (n : Int) | n > 0).
    ["intrinsics.refine", 2],
    // import path: an action reading a module, its record the result.
    ["intrinsics.import", 1],
    // runFile path: an action running a file beside the running one, its value the result.
    ["intrinsics.runFile", 1],
    // readFileFrom path: an action reading a file beside the running one;
    // parse source: the code it writes, its items in the scope parse runs in.
    ["intrinsics.readFileFrom", 1], ["intrinsics.parse", 1],
];
export const FFI_NATIVES: Array<[string, number]> = [
    ["withLibrary", 3], ["allocate", 2], ["peek", 2], ["poke", 3], ["offset", 2], ["nullPointer", 1],
];
// The natives the standard library has: representation, effects and Unicode
// casing, its native boundary. A program reaches them through its modules.
export const STANDARD_NATIVES: Array<[string, number]> = [
    ...FFI_NATIVES,
    ["bracket", 3], ["withFile", 2], ["readFile", 1], ["readStdin", 0], ["getArgs", 0],
    ["fail", 1], ["chars", 1], ["fromChars", 1], ["upper", 1], ["lower", 1],
    ["sendRequest", 5], ["toJson", 1], ["prettyJson", 1], ["fromJson", 1],
    ["entropy", 0], ["currentTime", 0], ["zoneOffset", 0], ["p5Object", 2], ["p5SketchType", 0],
];
const ARITIES = new Map([...NATIVES, ...STANDARD_NATIVES]);
export const nativeArity = (name: string): number | undefined => ARITIES.get(name);

// The natives with effects: applying one builds an IO action, which running
// performs. Each with what its action yields, for its type ("a" when that
// depends on its arguments).
export const ACTIONS = new Map(Object.entries({
    "intrinsics.import": "Module", "intrinsics.runFile": "a", "intrinsics.readFileFrom": "String", compile: "[]", print: "[]", debug: "[]",
    emit: "[]", repl: "[]", exit: "[]", set: "[]", while: "[]", for: "[]", readFile: "String",
    readStdin: "String", getArgs: "[String]", sendRequest: "Record", bracket: "a", withFile: "a",
    withLibrary: "a", entropy: "Int", currentTime: "Int", zoneOffset: "Int",
}));
// Natives the prelude defines in APN: the definition is what each one means, and
// what the checker types and evaluates; the interpreter runs the native in its
// place, a faster way to compute the same thing (tests/intrinsics-test.ts).
export const MODELED = new Set(["head", "tail", "null", "drop", "filter", "iterate", "take", "foldl"]);
// Natives that show their argument as text, which an action has none of.
export const SHOWS = new Set(["print", "emit", "toString"]);
// Natives that take an undecided value as it is: they show it or pass it on.
export const TAKES_UNDECIDED = new Set([...SHOWS, "debug", "format", "typeOf", "isType", "intrinsics.seq", "Dynamic"]);
// Natives that read their argument as code (debug [print "hi"]).
export const READS_CODE = new Set(["debug", "toAST", "toLambda", "intrinsics.written", "intrinsics.syntax"]);
// Natives the checker evaluates on values it knows; the strict ones demand
// their arguments first.
export const STRICT_NATIVES = new Set([
    "head", "tail", "null", "length", "chars", "fromChars", "upper", "lower", "toString", "intToString",
    "parse", "print", "debug", "emit", "assert", "set", "intrinsics.seq", "readFile", "[..]",
]);
export const EVALUATED_NATIVES = new Set([
    ...STRICT_NATIVES, "filter", "map", "take", "drop", "zipWith", "foldl", "foldr", "iterate", "enumerate",
]);
// The standard natives each standard module exports, by module: a program
// reaches them only through that import (import "std/function" for seq).
export const NATIVE_EXPORTS: Record<string, string[]> = {
    ffi: FFI_NATIVES.map(([name]) => name),
    io: ["withFile", "readFile", "readStdin", "getArgs"],
    function: ["bracket", "do"],
    text: ["upper", "lower"],
    json: ["prettyJson"],
    random: ["entropy"],
    time: ["currentTime", "zoneOffset"],
    p5: ["p5Object", "p5SketchType"],
};
// Natives that to and from spell now (to String x for toString x): internal,
// not bound for programs; each with what to write instead.
export const RETIRED_NATIVES: Record<string, string> = {
    toString: "to String", intToString: "to String",
    chars: "to (List Char)", fromChars: "from (List Char)", toJson: "to JSON", fromJson: "from JSON",
};
// The module exporting a standard native, for "add import" hints.
export function nativeModule(name: string): string | undefined {
    return Object.keys(NATIVE_EXPORTS).find(module => NATIVE_EXPORTS[module].includes(name));
}
