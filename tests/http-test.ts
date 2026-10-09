import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

function session(): Interpreter {
    const i = new Interpreter();
    i.enableChecking();
    return i;
}
function run(source: string, i = session()): string {
    return i.renderString(i.run(parse(source)));
}
function fails(source: string, text: string, kind?: string): void {
    try { run(source); } catch (error) {
        const e = error as { message: string; kind?: string };
        if (e.message.includes(text) && (!kind || e.kind === kind)) return;
        throw error;
    }
    throw new Error(`accepted: ${source}`);
}

// JSON.stringify and JSON.parse: toJson, prettyJson, fromJson.
for (const [source, expected] of [
    ['import "json"; toJson [ids: ["jawed"]]', '"{"ids":["jawed"]}"'],
    ['import "json"; toJson [1,2.5,true,"a",\'c\',[]]', '"[1,2.5,true,"a","c",[]]"'],
    ['import "json"; toJson ["Content-Type": "x", n: 123456789012345678901234567890]', '"{"Content-Type":"x","n":123456789012345678901234567890}"'],
    ['import "json"; toJson (HashMap [["k",1]])', '"{"k":1}"'],
    ['import "json"; toJson [1..3]', '"[1,2,3]"'],
    ['import "json"; prettyJson [a: [1]]', '"{\n  "a": [\n    1\n  ]\n}"'],
    ['import "json"; fromJson "{\\"status\\": 1, \\"odd-key\\": [true, null, 2.5]}"', '[status: 1, "odd-key": [true,[],2.5]]'],
    ['import "json"; (fromJson "{\\"odd-key\\": 3}")."odd-key"', '3'],
    ['import "json"; fromJson "123456789012345678901234567890"', '123456789012345678901234567890'],
    ['import "json"; fromJson "\\"\\\\u00e9\\""', '"é"'],
    ['import "json"; fromJson "{\\"a\\": 1, \\"a\\": 2}"', '[a: 2]'],
    ['import "json"; v = [a: [1,2], "b c": "x"]; fromJson (toJson v) == v', 'true'],
] as const) Deno.test(`json: ${source}`, () => {
    const actual = run(source);
    if (actual !== expected) throw new Error(`${source}: got ${actual}`);
});
for (const [source, message] of [
    ['import "json"; toJson (1 / 3)', 'has no JSON number'],
    ['import "json"; toJson (x -> x)', 'cannot encode'],
    ['import ["json","option"]; toJson (Some 1)', 'cannot encode the variant Some'],
    ['import "json"; fromJson "[1,"', 'unexpected end of input'],
    ['import "json"; fromJson "{\\"a\\" 1}"', 'expected ":"'],
    ['import "json"; fromJson "[1] x"', "unexpected \"x\""],
] as const) Deno.test(`json rejects: ${source}`, () => fails(source, message));

// fetch on data: URLs needs no network.
Deno.test("fetch returns a response record", () => {
    const i = session();
    run('import ["http","json"]; response <- fetch "data:application/json,{\\"a\\":[1,2]}" []; []', i);
    if (run("[response.status,response.ok,response.body]", i) !== '[200,true,"{"a":[1,2]}"]') throw new Error(run("response", i));
    if (run('lookup "content-type" response.headers', i) !== '"application/json"') throw new Error("headers");
    if (run("(fromJson response.body).a", i) !== "[1,2]") throw new Error("json body");
    if (run('fetchJson "data:application/json,[true]" []', i) !== "[true]") throw new Error("fetchJson");
    if (run('fetchText "data:text/plain,hi" [method: "GET", timeout: 5000]', i) !== '"hi"') throw new Error("fetchText");
});
for (const [source, message, kind] of [
    ['import "http"; fetch "data:text/plain,x" [methd: "GET"]', "unknown option 'methd'", "runtime"],
    ['import "http"; fetch "data:text/plain,x" [headers: [a: 1]]', "a header value must be a string", "runtime"],
    ['import "http"; fetch "data:text/plain,x" [timeout: 0]', "timeout must be a positive Int", "runtime"],
    ['import "http"; fetch "data:text/plain,x" 5', "options must be a record", "runtime"],
    ['import "http"; r <- fetch "data:text/plain,x" []; r.missing', "missing field", "type"],
    ['import "http"; fetch 5 []', "", "type"],
] as const) Deno.test(`fetch rejects: ${source}`, () => fails(source, message, kind));

// Requests to a local server: run with deno test --allow-read --allow-net.
const net = Deno.permissions.querySync({ name: "net" }).state === "granted";
Deno.test({ name: "fetch sends method, headers and body to a server", ignore: !net, async fn() {
    // The server runs in a worker: fetch blocks this thread until the response.
    const server = new Worker(`data:text/javascript,${encodeURIComponent(`
        const server = Deno.serve({ port: 0, onListen: ({ port }) => postMessage(port) }, async (request) => {
            const url = new URL(request.url);
            if (url.pathname === "/missing") return new Response("nope", { status: 404, statusText: "Not Found" });
            if (url.pathname === "/slow") { await new Promise(r => setTimeout(r, 2000)); return new Response("late"); }
            if (url.pathname === "/big") return new Response("x".repeat(3000000));
            return Response.json({ method: request.method, auth: request.headers.get("authorization"),
                type: request.headers.get("content-type"), body: await request.text() }, { headers: { "X-Echo": "yes" } });
        });
        self.onmessage = () => server.shutdown().then(() => postMessage("closed"));
    `)}`, { type: "module" });
    const port = await new Promise<number>(resolve => server.onmessage = (e) => resolve(e.data));
    try {
        const base = `http://localhost:${port}`;
        const i = session();
        run(`import ["http","json"]
response <- fetch "${base}/api/channels" [
    method: "POST",
    headers: [
        "Authorization": "Basic token",
        "Content-Type": "application/json"
    ],
    body: toJson [ids: ["jawed"]]
]
data = fromJson response.body
[]`, i);
        if (run("[response.status,data.method,data.auth,data.type,data.body]", i) !== '[200,"POST","Basic token","application/json","{"ids":["jawed"]}"]') throw new Error(run("data", i));
        if (run('lookup "x-echo" response.headers', i) !== '"yes"') throw new Error("response headers");
        if (run(`missing <- fetch "${base}/missing" []; [missing.status,missing.ok,missing.statusText,missing.body]`, i) !== '[404,false,"Not Found","nope"]') throw new Error("404");
        if (run(`length (fetchText "${base}/big" [])`, i) !== "3000000") throw new Error("big body");
        fails(`import "http"; fetchText "${base}/missing" []`, "answered 404 Not Found");
        fails(`import "http"; fetchText "${base}/slow" [timeout: 100]`, "timed out after 100 ms");
    } finally {
        await new Promise(resolve => { server.onmessage = resolve; server.postMessage("stop"); });
        server.terminate();
    }
} });
