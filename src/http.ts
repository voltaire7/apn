// HTTP requests for the http module's fetch. APN evaluates synchronously, so
// in Deno a short-lived worker runs the platform fetch while the interpreter
// waits on shared memory; the response comes back in chunks through a fixed
// buffer. In a browser build, a synchronous XMLHttpRequest does the same.

import { checkInterrupt } from "./interrupt.ts";

export interface HttpRequest { url: string; method: string; headers: Array<[string, string]>; body?: string; timeout?: number }
export interface HttpResponse { status: number; statusText: string; ok: boolean; url: string; headers: Array<[string, string]>; body: string }
/** Why a request failed (no response at all): the message, and whether permission was missing. */
export class HttpFailure extends Error { constructor(message: string, readonly permission = false) { super(message); } }

// control[0]: 1 when a chunk is ready (0 once taken), [1]: its length, [2]: 1 on the last.
const WORKER = `
self.onmessage = async ({ data: { request, control, buffer } }) => {
    const state = new Int32Array(control), bytes = new Uint8Array(buffer);
    let payload;
    try {
        const response = await fetch(request.url, {
            method: request.method, headers: request.headers, body: request.body,
            signal: request.timeout ? AbortSignal.timeout(request.timeout) : undefined,
        });
        payload = { status: response.status, statusText: response.statusText, ok: response.ok, url: response.url,
            headers: [...response.headers], body: await response.text() };
    } catch (error) {
        const name = error && error.name;
        // The platform's message, with its cause ("fetch failed" says little alone).
        const cause = error && error.cause && (error.cause.message || String(error.cause));
        const message = String(error && error.message || error) + (cause ? ": " + cause : "");
        payload = { error: name === "TimeoutError" ? "timed out after " + request.timeout + " ms" : message,
            permission: name === "NotCapable" || name === "PermissionDenied" };
    }
    const encoded = new TextEncoder().encode(JSON.stringify(payload));
    for (let offset = 0;;) {
        const length = Math.min(bytes.length, encoded.length - offset);
        bytes.set(encoded.subarray(offset, offset + length));
        offset += length;
        Atomics.store(state, 1, length);
        Atomics.store(state, 2, offset >= encoded.length ? 1 : 0);
        Atomics.store(state, 0, 1);
        Atomics.notify(state, 0);
        if (offset >= encoded.length) break;
        Atomics.wait(state, 0, 1);
    }
};`;
const WORKER_URL = `data:text/javascript;base64,${btoa(WORKER)}`;
const CHUNK = 1 << 20;

export function fetchSync(request: HttpRequest): HttpResponse {
    return typeof Deno === "undefined" ? fetchInBrowser(request) : fetchInWorker(request);
}

function fetchInWorker(request: HttpRequest): HttpResponse {
    const control = new SharedArrayBuffer(12), buffer = new SharedArrayBuffer(CHUNK);
    const state = new Int32Array(control);
    const worker = new Worker(WORKER_URL, { type: "module" });
    try {
        worker.postMessage({ request, control, buffer });
        const chunks: Uint8Array[] = [];
        for (;;) {
            // Wait in slices so Ctrl+C interrupts a slow request (the worker,
            // and with it the request, is dropped in finally).
            while (Atomics.wait(state, 0, 0, 20) === "timed-out") checkInterrupt();
            chunks.push(new Uint8Array(buffer, 0, Atomics.load(state, 1)).slice());
            const last = Atomics.load(state, 2) === 1;
            Atomics.store(state, 0, 0);
            Atomics.notify(state, 0);
            if (last) break;
        }
        const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        const payload = JSON.parse(new TextDecoder().decode(bytes));
        if ("error" in payload) throw new HttpFailure(payload.error, payload.permission);
        return payload as HttpResponse;
    } finally { worker.terminate(); }
}

// The part of a browser's XMLHttpRequest used here (Deno has none).
interface SyncRequest {
    open(method: string, url: string, async: boolean): void;
    setRequestHeader(name: string, value: string): void;
    send(body: string | null): void;
    getAllResponseHeaders(): string;
    status: number; statusText: string; responseURL: string; responseText: string;
}
function fetchInBrowser(request: HttpRequest): HttpResponse {
    const Request = (globalThis as unknown as { XMLHttpRequest?: new () => SyncRequest }).XMLHttpRequest;
    if (!Request) throw new HttpFailure("this host has no way to make HTTP requests");
    const xhr = new Request();
    try {
        xhr.open(request.method, request.url, false);
        for (const [name, value] of request.headers) xhr.setRequestHeader(name, value);
        xhr.send(request.body ?? null);
    } catch (error) {
        throw new HttpFailure(error instanceof Error ? error.message : String(error));
    }
    const headers = xhr.getAllResponseHeaders().trim().split(/[\r\n]+/).filter(Boolean).map((line: string): [string, string] => {
        const at = line.indexOf(":");
        return [line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()];
    });
    return { status: xhr.status, statusText: xhr.statusText, ok: xhr.status >= 200 && xhr.status < 300, url: xhr.responseURL || request.url, headers, body: xhr.responseText };
}
