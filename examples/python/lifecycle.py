"""Sandbox lifecycle: create -> use -> pause -> resume -> destroy.
Shows what survives a pause and what doesn't. Run with: python lifecycle.py"""

import time

from northflank_sandbox import SandboxClient

client = SandboxClient()

sandbox = client.create()
print(f"Created {sandbox.id}")

try:
    sandbox.wait_until_ready()
    sandbox.write_file("/tmp/agent/state.txt", "written before pause")
    print("Wrote /tmp/agent/state.txt to ephemeral disk")

    print("Pausing. Compute billing stops while paused...")
    sandbox.pause()

    print("Resuming...")
    started = time.monotonic()
    sandbox.resume()
    print(f"Resumed in {time.monotonic() - started:.1f}s")

    check = sandbox.exec("cat /tmp/agent/state.txt")
    if check.exit_code == 0:
        print(f"File survived: {check.stdout.strip()}")
    else:
        print(
            "File is gone: ephemeral disk does not survive a pause. "
            "Attach a volume to persist state (tutorials/persist-files-between-sessions)."
        )
finally:
    sandbox.destroy()
    print(f"Destroyed {sandbox.id}")
