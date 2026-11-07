"""Unix terminal integration: python3 tests/repl-interrupt-pty.py (no history writes)."""
import os
import pathlib
import pty
import select
import signal
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.chdir(pathlib.Path(__file__).resolve().parents[1])

class Slow(BaseHTTPRequestHandler):
    """Answers after 30 s: a fetch the REPL must interrupt."""
    def do_GET(self):
        time.sleep(30)
    def log_message(self, *args):
        pass

server = ThreadingHTTPServer(("127.0.0.1", 0), Slow)
server.daemon_threads = True
threading.Thread(target=server.serve_forever, daemon=True).start()
slow = f'fetch "http://127.0.0.1:{server.server_address[1]}/" []'.encode()

def start(*args):
    pid, terminal = pty.fork()
    if pid == 0:
        os.execvp("deno", ["deno", "run", "--no-prompt", "--allow-env=HOME",
                           "--allow-read", "--allow-net=127.0.0.1", "--allow-run=stty", "main.ts", *args])
    return pid, terminal

def stop(pid):
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    os.waitpid(pid, 0)

pid, terminal = start()

def read_for(seconds):
    data = bytearray()
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if select.select([terminal], [], [], 0.03)[0]:
            try:
                data.extend(os.read(terminal, 65536))
            except OSError:
                break
    return bytes(data)

try:
    assert b">>>" in read_for(3), "REPL failed to start"
    for source in (b"[0..]", b"x = x", b"x",
                   b'forever <- load "tests/fixtures/tail-load/forever"', b"use forever",
                   b"loop n = loop n", b"loop 0", b'std <- import "std"', b"use std.http", slow):
        os.write(terminal, source + b"\r")
        read_for(0.25)
        if source in (b"x = x", b"loop n = loop n", b'forever <- load "tests/fixtures/tail-load/forever"', b'std <- import "std"', b"use std.http"):
            continue
        os.write(terminal, b"\x03")
        output = read_for(0.7)
        assert b"Interrupted." in output and b">>>" in output, source
    os.write(terminal, b"42\r")
    assert b"42" in read_for(0.3), "REPL failed to recover"
    print("Ctrl+C interrupts infinite output, cyclic evaluation and a slow fetch; REPL recovers.")
finally:
    stop(pid)
    os.close(terminal)

# repl from a program: a session on its scope, which Ctrl+C interrupts within
# and Ctrl+D ends, after which the program goes on with its own bindings.
pid, terminal = start("tests/fixtures/repl-session.apn")
try:
    assert b">>>" in read_for(3), "repl failed to start a session"
    os.write(terminal, b"x + 1\r")
    assert b"2" in read_for(0.5), "the session does not see the program's x"
    os.write(terminal, b"[0..]\r")
    read_for(0.25)
    os.write(terminal, b"\x03")
    assert b"Interrupted." in read_for(0.7), "Ctrl+C did not interrupt within the session"
    os.write(terminal, b"x = 5\r")
    read_for(0.3)
    os.write(terminal, b"repl\r")
    read_for(0.5)
    os.write(terminal, b"x\r")
    assert b"5" in read_for(0.5), "a nested session does not see its caller's x"
    os.write(terminal, b"\x04")
    read_for(0.3)
    os.write(terminal, b"\x04")
    assert b"after 1" in read_for(1), "the program did not go on after the session"
    print("repl opens sessions on a program's scope; Ctrl+C and Ctrl+D work within them.")
finally:
    stop(pid)
    os.close(terminal)
