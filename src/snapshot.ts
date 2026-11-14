// A snapshot of an entry value and everything it reaches, which an executable
// made by compile runs (docs/runtime-compilation.md). Code travels as code: a
// thunk as its expression and scope, which evaluating again gives the same
// value, as only actions have effects; a value an action gave (x <- e) as data.
// What the runtime has itself (its natives, types and prelude) travels by name.
// A value that cannot travel (an action already made, a value a native is
// still computing, a C pointer) is left as an error its use raises.
import { Env, type Value } from "./types.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Snapshot { apn: 1; nodes: Json[]; entry: Json; root: Array<[string, Json]>; instances: Array<[string, Json[]]> }

// What compile reads of the interpreter: its scope, the bindings it starts
// with, and the method instances a program added.
export interface Runtime {
    programEnv: Env;
    initialBindings: Map<string, Value>;
    addedInstances(): Array<[string, Value[]]>;
}

class Unmovable extends Error {}

export function captureSnapshot(runtime: Runtime, entry: Value): Snapshot {
    const own = new Map<unknown, string>();
    for (const [name, value] of runtime.initialBindings) if (value && typeof value === "object" && !own.has(value)) own.set(value, name);
    const ids = new Map<object, number>(), order: object[] = [], nodes: Json[] = [];
    const encode = (x: unknown): Json => {
        if (x === null || typeof x === "boolean" || typeof x === "string") return x;
        if (typeof x === "number") return Number.isFinite(x) ? x : { $num: String(x) };
        if (x === undefined) return { $undef: 1 };
        if (typeof x === "bigint") return { $big: x.toString() };
        if (typeof x === "function" || typeof x === "symbol") throw new Unmovable("a value the interpreter computes");
        const object = x as object;
        if (own.has(object)) return { $own: own.get(object)! };
        if (object === runtime.programEnv) return { $root: 1 };
        if (ids.has(object)) return { $ref: ids.get(object)! };
        const id = nodes.length;
        ids.set(object, id); order.push(object); nodes.push(null);
        nodes[id] = node(object);
        return { $ref: id };
    };
    const node = (x: object): Json => {
        if (x instanceof Env) {
            const map: Array<[string, Json]> = [];
            for (const [name, value] of x.map) map.push([name, binding(name, value)]);
            return { $env: { parent: x.parent ? encode(x.parent) : null, version: x.version, map } };
        }
        if (x instanceof Map) return { $map: [...x].map(([k, v]) => [encode(k), encode(v)]) };
        if (x instanceof Set) return { $set: [...x].map(encode) };
        if (Array.isArray(x)) return { $arr: x.map(encode) };
        const value = x as Value;
        // Code travels as code: a thunk as what computes it, whatever it gave.
        // One that has its value has dropped its scope: it travels as that value.
        if (value.kind === "thunk") {
            if (!value.env) {
                if (value.value === undefined) throw new Unmovable("code without its scope");
                return { $same: encode(value.value) };
            }
            return { $obj: { kind: "thunk", body: encode(value.body), env: encode(value.env), names: encode(value.names) } };
        }
        if (value.kind === "deferred") {
            if (value.value !== undefined) return { $same: encode(value.value) };
            throw new Unmovable("a value a native was still computing");
        }
        if (value.kind === "io") throw new Unmovable("an action already made (pass it unevaluated)");
        if (value.kind === "pointer") throw new Unmovable("a C pointer");
        const fields: { [key: string]: Json } = {};
        for (const [key, field] of Object.entries(x)) if (key !== "busy" && key !== "newest") fields[key] = encode(field);
        return { $obj: fields };
    };
    // A value, or undefined when it cannot travel (what it began to add is
    // taken back), and why in reason.
    let reason = "";
    const attempt = (x: unknown): Json | undefined => {
        const mark = nodes.length;
        try { return encode(x); }
        catch (error) {
            if (!(error instanceof Unmovable)) throw error;
            for (const object of order.splice(mark)) ids.delete(object);
            nodes.length = mark;
            reason = error.message;
            return undefined;
        }
    };
    // One binding, or the error its use raises when it cannot travel.
    const binding = (name: string, value: Value): Json =>
        attempt(value) ?? { $unmovable: `${name} cannot travel to the executable: it is ${reason}` };
    // A top-level definition is evaluated in the program's scope: one whose
    // value cannot travel (an action, main = print "hi") travels as its code there.
    const root: Array<[string, Json]> = [];
    for (const [name, value] of runtime.programEnv.map) {
        if (runtime.initialBindings.get(name) === value) continue;
        const code = value.kind === "thunk" ? { kind: "thunk", body: value.body, env: runtime.programEnv } : undefined;
        root.push([name, attempt(value) ?? (code && attempt(code)) ?? { $unmovable: `${name} cannot travel to the executable: it is ${reason}` }]);
    }
    const instances = runtime.addedInstances().map(([method, fns]): [string, Json[]] => [method, fns.map(f => binding(method, f))]);
    // An entry that is a top-level definition's value (compile main opts) is
    // that definition, read where the program defines it.
    const settled = (v: Value): Value => v.kind === "thunk" && v.value !== undefined ? settled(v.value) : v;
    const written = entry.kind === "thunk" && entry.body.t === "var" && runtime.programEnv.map.has(entry.body.name) ? entry.body.name : undefined;
    const named = written ?? [...runtime.programEnv.map].find(([, value]) => settled(value) === settled(entry))?.[0];
    const start = named ? encode({ kind: "thunk", body: { t: "var", name: named }, env: runtime.programEnv }) : attempt(entry);
    if (start === undefined) throw new Error(`the entry cannot travel to the executable: it is ${reason}`);
    return { apn: 1, nodes, entry: start, root, instances };
}

// The entry a snapshot holds, its program rebuilt in a fresh interpreter.
export function restoreSnapshot(runtime: Runtime & { addInstance(method: string, fn: Value): void }, snapshot: Snapshot): Value {
    const made: unknown[] = snapshot.nodes.map(node => {
        const n = node as { [key: string]: Json };
        if ("$env" in n) return new Env();
        if ("$map" in n) return new Map();
        if ("$set" in n) return new Set();
        if ("$arr" in n) return [];
        if ("$same" in n) return undefined;
        return {};
    });
    const decode = (j: Json): unknown => {
        if (j === null || typeof j !== "object") return j;
        if (Array.isArray(j)) return j.map(decode);
        if ("$num" in j) return Number(j.$num);
        if ("$undef" in j) return undefined;
        if ("$big" in j) return BigInt(j.$big as string);
        if ("$own" in j) return runtime.initialBindings.get(j.$own as string);
        if ("$root" in j) return runtime.programEnv;
        if ("$unmovable" in j) return { kind: "deferred", compute: () => { throw new Error(j.$unmovable as string); } };
        if ("$ref" in j) {
            const id = j.$ref as number, node = snapshot.nodes[id] as { [key: string]: Json };
            if ("$same" in node) return made[id] ??= decode(node.$same);
            return made[id];
        }
        throw new Error("a snapshot this runtime cannot read");
    };
    snapshot.nodes.forEach((node, id) => {
        const n = node as { [key: string]: Json }, target = made[id];
        if (target instanceof Env) {
            const e = n.$env as { parent: Json; version: boolean; map: Array<[string, Json]> };
            target.parent = e.parent === null ? null : decode(e.parent) as Env;
            target.version = e.version;
            for (const [name, value] of e.map) target.map.set(name, decode(value) as Value);
        } else if (target instanceof Map) for (const [k, v] of n.$map as Json[][]) target.set(decode(k), decode(v));
        else if (target instanceof Set) for (const v of n.$set as Json[]) target.add(decode(v));
        else if (Array.isArray(target)) target.push(...(n.$arr as Json[]).map(decode));
        else if ("$obj" in n) {
            const fields = Object.fromEntries(Object.entries(n.$obj as { [key: string]: Json }).map(([k, v]) => [k, decode(v)]).filter(([, v]) => v !== undefined));
            Object.assign(target as object, fields);
        }
    });
    for (const [name, value] of snapshot.root) runtime.programEnv.map.set(name, decode(value) as Value);
    for (const [method, fns] of snapshot.instances) for (const fn of fns) runtime.addInstance(method, decode(fn) as Value);
    return decode(snapshot.entry) as Value;
}
