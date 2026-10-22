"""Run independent workloads in parallel, one sandbox each, so a crash in one
task can't affect the others' files, processes or memory. Run with: python parallel.py"""

import time
from concurrent.futures import ThreadPoolExecutor

from northflank_sandbox import SandboxClient

TASKS = [
    "import math; print(sum(math.factorial(n) for n in range(50)) % 1_000_007)",
    "print(sorted({w.lower() for w in 'the quick brown fox jumps over the lazy dog'.split()}))",
    "import hashlib; print(hashlib.sha256(b'agent-sandbox').hexdigest())",
]


def run_task(index: int, code: str) -> str:
    client = SandboxClient()  # one client per task (and per thread)
    with client.create() as sandbox:  # destroyed on exit, even if the task fails
        sandbox.wait_until_ready()
        r = sandbox.run_python(code, timeout_seconds=10)
        output = r.stdout.strip() or r.stderr.strip()
        return f"task {index} [{sandbox.id}] exit={r.exit_code}: {output}"


started = time.monotonic()
with ThreadPoolExecutor(max_workers=len(TASKS)) as pool:
    futures = [pool.submit(run_task, i, code) for i, code in enumerate(TASKS)]
    for future in futures:
        try:
            print(future.result())
        except Exception as error:
            print(f"task failed: {error}")

print(f"\n{len(TASKS)} sandboxes, {time.monotonic() - started:.1f}s wall clock")
