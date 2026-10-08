import { CheckingSession } from "./checking-session.ts";
import { parse } from "./parser.ts";
import { BUNDLE_APP, bundleProgram } from "./modules.ts";

export async function buildHtml(sourceFile: string, outputFile: string): Promise<void> {
    const source = Deno.readTextFileSync(sourceFile);
    parse(source); // Catch syntax errors without executing user effects during the build.
    // The standard library and the local modules the program imports, checked
    // from the bundle exactly as the browser will run them.
    const modules = bundleProgram(source, new URL(".", new URL(sourceFile, `file://${Deno.cwd()}/`)).pathname);
    const checking = new CheckingSession();
    checking.moduleSources = modules;
    checking.prepare(parse(source), BUNDLE_APP);
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
