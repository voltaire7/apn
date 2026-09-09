"""Unix terminal integration: python3 tests/repl-interrupt-pty.py (no history writes)."""
import os
import pathlib
import pty
import select
import signal
import time

os.chdir(pathlib.Path(__file__).resolve().parents[1])
pid, terminal = pty.fork()
if pid == 0:
    os.execvp("deno", ["deno", "run", "--no-prompt", "--allow-env=HOME",
                       "--allow-read", "--allow-run=stty", "main.ts"])

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
    assert b">>>" in read_for(1), "REPL failed to start"
    for source in (b"[0..]", b"x = x", b"x"):
        os.write(terminal, source + b"\r")
        read_for(0.25)
        if source == b"x = x":
            continue
        os.write(terminal, b"\x03")
        output = read_for(0.7)
        assert b"Interrupted." in output and b">>>" in output, source
    os.write(terminal, b"42\r")
    assert b"42" in read_for(0.3), "REPL failed to recover"
    print("Ctrl+C interrupts infinite output and cyclic evaluation; REPL recovers.")
finally:
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    os.waitpid(pid, 0)
    os.close(terminal)
