import { checkInterrupt, type Interpreter } from "./interp.ts";
import { APNError } from "./errors.ts";
import { type Value, mkList, mkStr } from "./types.ts";

// Finish lazy data while the resource is alive. Callables and references cannot
// escape through the result; externally stored handles must enforce lifetime.
export function scopedData(i: Interpreter, value: Value, ancestors = new Set<Value>()): Value {
    checkInterrupt();
    const v = i.reference(value);
    if (ancestors.has(v)) throw new APNError("runtime", "resource scope cannot return cyclic data");
    if ((v.kind === "record" && v.scope) || ["closure", "clauseFn", "native", "contract", "mutable", "pointer", "type", "functionType", "io"].includes(v.kind)) {
        throw new APNError("runtime", "resource scope must return data, not a callable, action or reference");
    }
    const path = new Set(ancestors); path.add(v);
    if (i.isList(v)) return mkList(i.items(v).map(item => scopedData(i, item, path)));
    if (v.kind === "record") return { ...v, v: v.v.map(([key, item]): [string, Value] => [key, scopedData(i, item, path)]) };
    if (v.kind === "variant") return { ...v, v: v.v.map(item => scopedData(i, item, path)) };
    if (v.kind === "hashmap") return { ...v, entries: new Map([...v.entries].map(([hash, [key, item]]) => [hash, [scopedData(i, key, path), scopedData(i, item, path)]])) };
    return v;
}

function unary(i: Interpreter, value: Value, role: string): Value {
    const f = i.demand(value);
    const arity = f.kind === "native" || f.kind === "clauseFn" ? f.arity - f.applied.length : f.kind === "closure" ? f.params.length : f.kind === "contract" ? 1 : -1;
    if (arity !== 1) throw new APNError("runtime", `${role} must take one remaining argument`);
    return f;
}

export function bracket(i: Interpreter, acquire: Value, release: Value, use: Value): Value {
    release = unary(i, release, "bracket release");
    use = unary(i, use, "bracket callback");
    // Each part may be an action: acquiring, using and releasing run in turn.
    const resource = i.runIO(acquire);
    try { return scopedData(i, i.runIO(i.apply(i.demand(use), resource))); }
    finally { i.runIO(i.apply(i.demand(release), resource)); }
}

export function withFile(i: Interpreter, path: Value, use: Value): Value {
    use = unary(i, use, "withFile callback");
    path = i.demand(path);
    if (path.kind !== "string") throw new APNError("runtime", "withFile expects a path string");
    let file: Deno.FsFile;
    try { file = Deno.openSync(path.v, { read: true }); }
    catch (e) { throw new APNError("runtime", `withFile: ${(e as Error).message}`); }
    let open = true;
    const read: Value = { kind: "native", name: "file.read", arity: 0, applied: [], invoke: () => ({ kind: "io", label: "read", run: () => {
        if (!open) throw new APNError("runtime", "file resource is closed");
        const decoder = new TextDecoder(), bytes = new Uint8Array(65536), chunks: string[] = [];
        for (;;) {
            checkInterrupt();
            const count = file.readSync(bytes);
            if (count === null) break;
            chunks.push(decoder.decode(bytes.subarray(0, count), { stream: true }));
        }
        chunks.push(decoder.decode());
        return mkStr(chunks.join(""));
    } }) };
    try {
        const resource: Value = { kind: "record", v: [["read", read]] };
        return scopedData(i, i.runIO(i.apply(i.demand(use), resource)));
    } finally { open = false; file.close(); }
}
