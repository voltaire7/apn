import { Interpreter } from "./interp.ts";
import { parse } from "./parser.ts";
import { BUNDLE_APP, BUNDLE_LIB, bundleProgram } from "./modules.ts";

// Text inside a <script> element: nothing in it may close the element.
const scriptText = (text: string) => text.replace(/<\/script/gi, "<\\/script");
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");
// A program's page: a readable base font, and how it shows an error (apn-error).
const PAGE_STYLE = "body{margin:0;padding:16px;font:16px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#1f2430}#apn-error{white-space:pre-wrap;color:#b42318;background:#fff4f2;border:1px solid #f4c7c0;border-radius:8px;padding:10px 14px;font:13px/1.5 'SF Mono',SFMono-Regular,ui-monospace,Menlo,Consolas,monospace}";

// A browser script (src/browser-runtime.ts, src/editor.ts) as one script.
async function bundle(entry: string): Promise<string> {
    const temporary = Deno.makeTempDirSync({ prefix: "apn-html-" });
    try {
        const output = `${temporary}/bundle.js`;
        const result = await new Deno.Command(Deno.execPath(), { args: ["bundle", "--platform=browser", "--no-remote", "--no-npm", "--minify", "--output", output, new URL(entry, import.meta.url).pathname], stdout: "piped", stderr: "piped" }).output();
        if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
        return scriptText(Deno.readTextFileSync(output));
    } finally { Deno.removeSync(temporary, { recursive: true }); }
}

// A program and its modules, checked from the bundle exactly as the browser
// will run them, without executing user effects.
function checkedProgram(sourceFile: string): { source: string; modules: Record<string, string> } {
    const source = Deno.readTextFileSync(sourceFile);
    const modules = bundleProgram(source, new URL(".", new URL(sourceFile, `file://${Deno.cwd()}/`)).pathname);
    const interpreter = new Interpreter();
    interpreter.moduleSources = modules;
    interpreter.checkingSession().prepare(parse(source, sourceFile), BUNDLE_APP);
    return { source, modules };
}

function programPage(program: { source: string; modules: Record<string, string> }, runtime: string): string {
    return `<!doctype html>\n<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>APN application</title><style>${PAGE_STYLE}</style><body><div id="app"></div><pre id="apn-error" role="alert" hidden></pre><script id="apn-program" type="application/json">${scriptJson(program)}</script><script type="module">${runtime}</script></body></html>\n`;
}

export async function buildHtml(sourceFile: string, outputFile: string): Promise<void> {
    const program = checkedProgram(sourceFile);
    Deno.writeTextFileSync(outputFile, programPage(program, await bundle("./browser-runtime.ts")));
}

// A folder of examples as a site: index.html is the folder's index.apn (a
// page linking to editor.html#NAME), and editor.html edits and runs each
// other NAME.apn there, with the standard library and the data files the
// examples name (each run gets those its source names). Every example is checked.
export async function buildSite(sourceDirectory: string, outputDirectory: string): Promise<void> {
    const folder = sourceDirectory.replace(/\/?$/, "/");
    const files = [...Deno.readDirSync(folder)].filter(e => e.isFile && e.name.endsWith(".apn")).map(e => e.name).sort();
    if (!files.includes("index.apn")) throw new Error(`${folder}index.apn is missing: it is the site's front page`);
    const examples: Record<string, string> = {}, data: Record<string, string> = {};
    let index = { source: "", modules: {} as Record<string, string> };
    for (const file of files) {
        const program = checkedProgram(folder + file);
        if (file === "index.apn") index = program;
        else examples[file.slice(0, -".apn".length)] = program.source;
        for (const [path, entry] of Object.entries(program.modules)) {
            if (path.startsWith(BUNDLE_APP) && !path.endsWith(".apn")) data[path.slice(BUNDLE_APP.length)] = entry;
        }
    }
    // The editor runs each example with the standard library.
    const modules = Object.fromEntries(Object.entries(index.modules).filter(([path]) => path.startsWith(BUNDLE_LIB)));
    const [runtime, editorScript] = await Promise.all([bundle("./browser-runtime.ts"), bundle("./editor.ts")]);
    Deno.mkdirSync(outputDirectory, { recursive: true });
    const output = outputDirectory.replace(/\/?$/, "/");
    Deno.writeTextFileSync(`${output}index.html`, programPage(index, runtime));
    const editor = Deno.readTextFileSync(new URL("./editor.html", import.meta.url))
        .replace("/*SITE*/", () => scriptJson({ examples, modules, data, style: PAGE_STYLE }))
        .replace("/*RUNTIME*/", () => runtime)
        .replace("/*EDITOR*/", () => editorScript);
    Deno.writeTextFileSync(`${output}editor.html`, editor);
}
