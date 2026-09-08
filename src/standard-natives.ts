import type { Interpreter } from "./interp.ts";
import { type Value, mkList, mkStr, mkBool } from "./types.ts";
import { APNError } from "./errors.ts";
export const STANDARD_NATIVES: Array<[string, number]> = [
    ["seq", 2], ["all", 2], ["any", 2], ["find", 2], ["words", 1], ["fail", 1], ["chars", 1], ["fromChars", 1], ["splitOn", 2], ["joinWith", 2],
    ["trim", 1], ["upper", 1], ["lower", 1], ["replaceAll", 3],
    ["takeWhile", 2], ["dropWhile", 2], ["scanl", 3], ["sortBy", 2],
];
export function standardNative(i: Interpreter, name: string, args: Value[]): Value {
    const str = (v: Value): string => {
        v = i.demand(v);
        if (v.kind !== "string") throw new APNError("runtime", `${name} expects strings`);
        return v.v;
    };
    const predicate = (fn: Value, value: Value): boolean => {
        const result = i.demand(i.apply(i.demand(fn), value));
        if (result.kind !== "bool") throw new APNError("runtime", `${name} predicate must return Bool`);
        return result.v;
    };
    if (name === "all" || name === "any" || name === "find") {
        for (const value of i.elements(args[1])) {
            const yes = predicate(args[0], value);
            if (name === "find" && yes) return { kind: "variant", tag: "Some", v: [value] };
            if (name === "all" && !yes) return mkBool(false);
            if (name === "any" && yes) return mkBool(true);
        }
        return name === "find" ? { kind: "variant", tag: "None", v: [] } : mkBool(name === "all");
    }
    if (name === "seq") { i.demand(args[0]); return args[1]; }
    if (name === "words") return mkList(str(args[0]).split(/\s+/u).filter(Boolean).map(mkStr));
    if (name === "fail") throw new APNError("runtime", str(args[0]));
    if (name === "takeWhile") {
        const loop = (xs: Value): Value => i.defer(() => {
            const cell = i.cell(xs);
            return cell && predicate(args[0], cell.head) ? { kind: "cons", head: cell.head, tail: loop(cell.tail) } : mkList([]);
        });
        return loop(args[1]);
    }
    if (name === "dropWhile") {
        let xs = args[1];
        for (;;) {
            const cell = i.cell(xs);
            if (!cell || !predicate(args[0], cell.head)) return xs;
            xs = cell.tail;
        }
    }
    if (name === "scanl") {
        const loop = (acc: Value, xs: Value): Value => i.defer(() => ({
            kind: "cons", head: acc, tail: i.defer(() => {
                const cell = i.cell(xs);
                return cell ? loop(i.defer(() => i.apply(i.apply(i.demand(args[0]), acc), cell.head)), cell.tail) : mkList([]);
            }),
        }));
        return loop(args[1], args[2]);
    }
    if (name === "sortBy") {
        const items = i.items(args[1]);
        items.sort((a, b) => {
            const order = i.demand(i.apply(i.apply(i.demand(args[0]), a), b));
            if (order.kind !== "int") throw new APNError("runtime", "sortBy comparator must return an integer");
            return order.v < 0n ? -1 : order.v > 0n ? 1 : 0;
        });
        return mkList(items);
    }
    if (name === "chars") return mkList([...str(args[0])].map((v): Value => ({ kind: "char", v })));
    if (name === "fromChars") return mkStr(i.items(args[0]).map((v) => {
        v = i.demand(v);
        if (v.kind !== "char") throw new APNError("runtime", "fromChars expects a list of Char values");
        return v.v;
    }).join(""));
    if (name === "splitOn") return mkList(str(args[0]) === "" ? [...str(args[1])].map(mkStr) : str(args[1]).split(str(args[0])).map(mkStr));
    if (name === "joinWith") return mkStr(i.items(args[1]).map(str).join(str(args[0])));
    if (name === "replaceAll") {
        const search = str(args[0]), replacement = str(args[1]), text = str(args[2]);
        return mkStr(text.split(search).join(replacement));
    }
    const text = str(args[0]);
    return mkStr(name === "trim" ? text.trim() : name === "upper" ? text.toUpperCase() : text.toLowerCase());
}
