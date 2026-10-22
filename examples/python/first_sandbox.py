"""Create your first AI agent sandbox from Python: provision, run a command,
read the output, destroy. Run with: python first_sandbox.py"""

import time

from northflank_sandbox import SandboxClient

client = SandboxClient()

print("1. Creating sandbox...")
with client.create(image="python:3.12-slim") as sandbox:  # destroyed on exit
    print(f"   created {sandbox.id}")

    print("2. Waiting for it to boot...")
    started = time.monotonic()
    sandbox.wait_until_ready()
    print(f"   ready in {time.monotonic() - started:.1f}s")

    print("3. Running a command inside the sandbox...")
    result = sandbox.exec('echo "Hello from $(hostname)" && uname -r && python3 --version')
    print(f"   exit code: {result.exit_code}")
    for line in result.stdout.splitlines():
        print(f"   | {line}")

    print("4. Destroying sandbox...")
print("   done")
