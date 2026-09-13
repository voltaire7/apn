"""Bounded terminal integration test: python3 tests/donut-terminal-test.py."""
import fcntl
import os
from pathlib import Path
import pty
import select
import signal
import subprocess
import termios
import time

root = Path(__file__).resolve().parent.parent
master, slave = pty.openpty()


def setup():
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)


process = subprocess.Popen(
    [str(root / "examples/c-interop/run-donut")],
    stdin=slave, stdout=slave, stderr=slave, preexec_fn=setup, close_fds=True,
)
os.close(slave)
data = b""
sent = False
try:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if select.select([master], [], [], .1)[0]:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            data += chunk
        if not sent and b"\x1b[?25l" in data and len(data) > 7000:
            os.write(master, b"\x03")
            sent = True
        if process.poll() is not None:
            break
    assert sent, "donut never displayed animated frames"
    process.wait(timeout=3)
    try:
        while select.select([master], [], [], .05)[0]:
            chunk = os.read(master, 65536)
            if not chunk:
                break
            data += chunk
    except OSError:
        pass
    assert process.returncode == 0, f"donut exited with {process.returncode}"
    assert b"\x1b[?25h" in data, "cursor was not restored"
    assert b"\x1b[?1049l" in data, "original terminal screen was not restored"
    print("Donut Ctrl+C: exited cleanly and restored terminal")
finally:
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    os.close(master)
