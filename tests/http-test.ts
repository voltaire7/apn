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

// JSON.stringify and JSON.parse: to JSON, prettyJson, from JSON.
for (const [source, expected] of [
    ['std <- import "std"; [..] = std.json; to JSON [ids = ["jawed"]]', '"{\\"ids\\":[\\"jawed\\"]}"'],
    ['std <- import "std"\n[..] = std.json\nto JSON [1, 2.5, True, "a", \'c\', []]', '"[1,2.5,true,\\"a\\",\\"c\\",[]]"'],
    ['std <- import "std"\n[..] = std.json\nto JSON [`Content-Type` = "x", n = 123456789012345678901234567890]', '"{\\"Content-Type\\":\\"x\\",\\"n\\":123456789012345678901234567890}"'],
    ['std <- import "std"; [..] = std.json; to JSON ([["k", 1]] : HashMap _ _)', '"{\\"k\\":1}"'],
    ['std <- import "std"; [..] = std.json; to JSON [1..3]', '"[1,2,3]"'],
    // An object is an association list: a non-empty list of [String,value] pairs.
    ['std <- import "std"; [..] = std.json; to JSON [["ids", ["jawed"]], ["n", 1]]', '"{\\"ids\\":[\\"jawed\\"],\\"n\\":1}"'],
    ['std <- import "std"; [..] = std.json; to JSON [["a", 1], [2,3]]', '"[[\\"a\\",1],[2,3]]"'],
    ['std <- import "std"; [..] = std.json; to JSON [[1,2]]', '"[[1,2]]"'],
    ['std <- import "std"; [..] = std.json; prettyJson [a = [1]]', '"{\\n  \\"a\\": [\\n    1\\n  ]\\n}"'],
    ['std <- import "std"\n[..] = std.json\nfrom JSON "{\\"status\\": 1, \\"odd-key\\": [true, null, 2.5]}"', '[["status", 1], ["odd-key", [True, [], 2.5]]]'],
    ['std <- import "std"; [..] = std.json; from JSON "{\\"odd-key\\": 3}" "odd-key"', '3'],
    ['std <- import "std"\n[..] = std.json\nv = [["a", [1,2]], ["b c","x"], ["q", [["r", 2]]]]; from JSON (to JSON v) == v', 'True'],
    ['std <- import "std"; [..] = std.json; from JSON "{\\"a\\": {}}"', '[["a", []]]'],
    ['std <- import "std"\n[..] = std.json\nfrom JSON "123456789012345678901234567890"', '123456789012345678901234567890'],
    ['std <- import "std"; [..] = std.json; from JSON "\\"\\\\u00e9\\""', '"é"'],
    ['std <- import "std"; [..] = std.json; from JSON "{\\"a\\": 1, \\"a\\": 2}"', '[["a", 2]]'],
    ['std <- import "std"; [..] = std.json; v = [a = [1,2], `b c` = "x"]; from JSON (to JSON v) == pairs v', 'True'],
] as const) Deno.test(`json: ${source}`, () => {
    const actual = run(source);
    if (actual !== expected) throw new Error(`${source}: got ${actual}`);
});
for (const [source, message] of [
    ['std <- import "std"; [..] = std.json; to JSON (1 / 3)', 'has no JSON number'],
    ['std <- import "std"; [..] = std.json; to JSON (x -> x)', 'cannot encode'],
    ['std <- import "std"\n[..] = std.[json,option]; to JSON (Some 1)', 'cannot encode the variant Some'],
    ['std <- import "std"; [..] = std.json; from JSON "[1,"', 'unexpected end of input'],
    ['std <- import "std"; [..] = std.json; from JSON "{\\"a\\" 1}"', 'expected ":"'],
    ['std <- import "std"; [..] = std.json; from JSON "[1] x"', "unexpected \"x\""],
] as const) Deno.test(`json rejects: ${source}`, () => fails(source, message));

// fetch on data: URLs needs no network.
Deno.test("fetch returns a response record", () => {
    const i = session();
    run('std <- import "std"\n[..] = std.[http,json]\nresponse <- fetch "data:application/json,{\\"a\\":[1,2]}" []; []', i);
    if (run("[response.status,response.ok,response.body]", i) !== '[200, True, "{\\"a\\":[1,2]}"]') throw new Error(run("response", i));
    if (run('response.headers "content-type"', i) !== '"application/json"') throw new Error("headers");
    if (run('from JSON response.body "a"', i) !== "[1,2]") throw new Error("json body");
    if (run('fetchJson "data:application/json,[true]" []', i) !== "[True]") throw new Error("fetchJson");
    if (run('fetchText "data:text/plain,hi" [method = "GET", timeout = 5000]', i) !== '"hi"') throw new Error("fetchText");
    // Headers are an association list, a record's pairs too.
    if (run('fetchText "data:text/plain,hi" [headers = [accept = "text/plain"]]', i) !== '"hi"') throw new Error("record headers");
});
for (const [source, message, kind] of [
    ['std <- import "std"\n[..] = std.http\nfetch "data:text/plain,x" [methd = "GET"]', "unknown option 'methd'; the options are method, headers, body, timeout", "runtime"],
    ['std <- import "std"\n[..] = std.http\nfetch "data:text/plain,x" [headers = [["a", 1]]]', "cannot use Int where String is required", "type"],
    ['std <- import "std"\n[..] = std.http\nfetch "data:text/plain,x" [timeout = -1]', "timeout must not be negative", "runtime"],
    ['std <- import "std"; [..] = std.http; fetch "data:text/plain,x" 5', "a record is made from a list or record of its fields", "runtime"],
    ['std <- import "std"\n[..] = std.http\nr <- fetch "data:text/plain,x" []; r.missing', "missing field", "type"],
    ['std <- import "std"; [..] = std.http; fetch 5 []', "", "type"],
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
        run(`std <- import "std"\n[..] = std.[http,json]
response <- fetch "${base}/api/channels" [
    method = "POST"
    headers = [
        ["Authorization","Basic token"]
        ["Content-Type","application/json"]
    ]
    body = to JSON [ids = ["jawed"]]
]
data = from JSON response.body
[]`, i);
        if (run('[response.status, data "method", data "auth", data "type", data "body"]', i) !== '[200, "POST", "Basic token", "application/json", "{\\"ids\\":[\\"jawed\\"]}"]') throw new Error(run("data", i));
        if (run('response.headers "x-echo"', i) !== '"yes"') throw new Error("response headers");
        if (run(`missing <- fetch "${base}/missing" []\n[missing.status,missing.ok,missing.statusText,missing.body]`, i) !== '[404, False, "Not Found", "nope"]') throw new Error("404");
        if (run(`big <- fetchText "${base}/big" []; length big`, i) !== "3000000") throw new Error("big body");
        fails(`std <- import "std"; [..] = std.http; fetchText "${base}/missing" []`, "answered 404 Not Found");
        fails(`std <- import "std"\n[..] = std.http\nfetchText "${base}/slow" [timeout = 100]`, "timed out after 100 ms");
    } finally {
        await new Promise(resolve => { server.onmessage = resolve; server.postMessage("stop"); });
        server.terminate();
    }
} });
