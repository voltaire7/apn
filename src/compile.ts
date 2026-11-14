// compile's executable: a snapshot (snapshot.ts) with the runtime that runs it
// (compiled-main.ts), built by Deno. target "js" is a script deno runs
// (NAME.js); "native" an executable for this machine; any other target a
// Rust-style triple (x86_64-unknown-linux-gnu, aarch64-apple-darwin, ...),
// an executable for that platform. See docs/runtime-compilation.md.
import { APNError } from "./errors.ts";
import type { Snapshot } from "./snapshot.ts";

export interface CompileOptions { name: string; target: string }

export function buildExecutable(snapshot: Snapshot, options: CompileOptions): void {
    const folder = Deno.makeTempDirSync({ prefix: "apn-compile-" });
    try {
        Deno.writeTextFileSync(`${folder}/snapshot.json`, JSON.stringify(snapshot));
        Deno.writeTextFileSync(`${folder}/run.ts`, [
            `import snapshot from "./snapshot.json" with { type: "json" };`,
            `import { runSnapshot } from ${JSON.stringify(new URL("./compiled-main.ts", import.meta.url).href)};`,
            `runSnapshot(snapshot);`,
        ].join("\n"));
        const output = options.target === "js" && !options.name.endsWith(".js") ? `${options.name}.js` : options.name;
        const permissions = ["--allow-read", "--allow-write", "--allow-net", "--allow-env"];
        const args = options.target === "js"
            ? ["bundle", "--platform=deno", "--output", output, `${folder}/run.ts`]
            : ["compile", "--no-check", ...permissions, ...options.target === "native" ? [] : ["--target", options.target], "--output", output, `${folder}/run.ts`];
        const result = new Deno.Command(Deno.execPath(), { args, stdout: "piped", stderr: "piped" }).outputSync();
        if (!result.success) {
            const why = new TextDecoder().decode(result.stderr).replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").slice(-3).join("\n");
            throw new APNError("runtime", `compile could not build '${output}': ${why}`);
        }
    } finally { Deno.removeSync(folder, { recursive: true }); }
}
