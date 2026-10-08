import { CheckingSession } from "../src/checking-session.ts";
import { parse } from "../src/parser.ts";

// Every example must pass default static checking, so `apn FILE` can run it.
// Checking never executes the program, so FFI, browser, and input-reading
// examples are covered without their native libraries or arguments.
function apnFiles(dir: URL): URL[] {
    const files: URL[] = [];
    for (const entry of Deno.readDirSync(dir)) {
        const url = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir);
        if (entry.isDirectory) files.push(...apnFiles(url));
        else if (entry.name.endsWith(".apn")) files.push(url);
    }
    return files.sort((a, b) => a.href.localeCompare(b.href));
}
const examples = new URL("../examples/", import.meta.url);
for (const file of apnFiles(examples)) {
    const name = file.pathname.slice(examples.pathname.length);
    Deno.test(`example type-checks: ${name}`, () => {
        new CheckingSession().prepare(parse(Deno.readTextFileSync(file), name), new URL(".", file).pathname.replace(/\/$/, ""));
    });
}
