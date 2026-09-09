import { parse } from "./parser.ts";

export async function buildHtml(sourceFile: string, outputFile: string): Promise<void> {
    const source = Deno.readTextFileSync(sourceFile);
    parse(source); // Catch syntax errors without executing user effects during the build.
    const modules: Record<string, string> = {};
    for (const entry of Deno.readDirSync(new URL("../lib/", import.meta.url))) {
        if (entry.isFile && entry.name.endsWith(".apn")) modules[entry.name.slice(0, -4)] = Deno.readTextFileSync(new URL(`../lib/${entry.name}`, import.meta.url));
    }
    const temporary = Deno.makeTempDirSync({ prefix: "apn-html-" });
    try {
        const output = `${temporary}/runtime.js`;
        const result = await new Deno.Command(Deno.execPath(), { args: ["bundle", "--platform=browser", "--no-remote", "--no-npm", "--minify", "--output", output, new URL("./browser-runtime.ts", import.meta.url).pathname], stdout: "piped", stderr: "piped" }).output();
        if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
        const runtime = Deno.readTextFileSync(output).replace(/<\/script/gi, "<\\/script");
        const data = JSON.stringify({ source, modules }).replace(/</g, "\\u003c");
        Deno.writeTextFileSync(outputFile, `<!doctype html>\n<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>APN application</title><body><div id="app"></div><pre id="apn-error" role="alert" hidden></pre><script id="apn-program" type="application/json">${data}</script><script type="module">${runtime}</script></body></html>\n`);
    } finally { Deno.removeSync(temporary, { recursive: true }); }
}
