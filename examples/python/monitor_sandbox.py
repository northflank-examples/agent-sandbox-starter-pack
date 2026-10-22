"""Monitor sandbox resource usage.

Starts a workload that burns CPU and holds memory, watches CPU and memory
metrics while it runs, enforces a memory limit and a maximum lifetime with a
watchdog, and reads the workload's output back from the platform logs.

Run with: python monitor_sandbox.py
"""

import time
from datetime import datetime, timedelta, timezone
from typing import Any

from northflank_sandbox import Sandbox, SandboxClient

# Watchdog limits. In production these come from your per-user quotas.
MAX_LIFETIME_S = 4 * 60
MEMORY_LIMIT_MB = 400  # nf-compute-20 has 512 MB
POLL_S = 15

WORKLOAD = """
import time
blob = b'x' * (250 * 1024 * 1024)  # hold 250 MB of real, touched memory
end = time.time() + 150
i = 0
while time.time() < end:
    i += 1
    if i % 5_000_000 == 0:
        print(f'agent-workload: still running, {int(end - time.time())}s left', flush=True)
print('agent-workload: finished', flush=True)
"""

client = SandboxClient()
api, project_id = client.api, client.project_id


def latest_metrics(sandbox: Sandbox) -> dict:
    """Latest value of CPU and memory over the last few minutes."""
    response = api.get.service.metrics(
        project_id=project_id,
        service_id=sandbox.id,
        query_type="range",
        metric_types=["cpu", "memory"],
        start_time=datetime.now(timezone.utc) - timedelta(minutes=5),
    )
    data: dict[str, Any] = dict(response.data or {})
    result = {}
    for metric in ("cpu", "memory"):
        entry = data.get(metric) or {}
        points = [p for v in entry.get("values", []) for p in v.get("data", [])]
        if points:
            result[metric] = (float(points[-1]["value"]), entry["metricInfo"]["metricUnit"])
    return result


sandbox = client.create(plan="nf-compute-20")
created_at = time.monotonic()
print(f"Created {sandbox.id}")

try:
    sandbox.wait_until_ready()

    # Start the workload in the background, writing its output to /proc/1/fd/1
    # (the stdout of the sandbox's main process). The logs are fetched below.
    sandbox.write_file("/tmp/agent/workload.py", WORKLOAD)
    sandbox.exec(
        "setsid nohup python3 /tmp/agent/workload.py > /proc/1/fd/1 2>&1 < /dev/null & "
        "echo $! > /tmp/agent/workload.pid"
    )
    print("Started workload: a busy loop holding 250 MB for 150s on a 0.2 vCPU plan\n")

    # Watch metrics and enforce limits.
    while True:
        time.sleep(POLL_S)
        age = time.monotonic() - created_at
        m = latest_metrics(sandbox)
        cpu = f"{m['cpu'][0]:.2f} {m['cpu'][1]}" if "cpu" in m else "n/a (no data yet)"
        mem = f"{m['memory'][0]:.0f} {m['memory'][1]}" if "memory" in m else "n/a"
        print(f"[{age:.0f}s] cpu={cpu}  memory={mem}")

        if "memory" in m and m["memory"][1] == "mb" and m["memory"][0] > MEMORY_LIMIT_MB:
            print(f"Watchdog: memory above {MEMORY_LIMIT_MB} MB, destroying sandbox")
            break
        if age > MAX_LIFETIME_S:
            print(f"Watchdog: sandbox older than {MAX_LIFETIME_S // 60} min, destroying it")
            break
        # Slim images have no pgrep; check the PID recorded at start instead.
        running = sandbox.exec("kill -0 $(cat /tmp/agent/workload.pid) 2>/dev/null && echo yes || echo no")
        if running.stdout.strip() == "no":
            print("Workload finished")
            break

    # Read the workload's output back from the platform logs.
    lines = api.logs.fetch_service_logs(
        project_id=project_id,
        service_id=sandbox.id,
        line_limit=20,
        direction="backward",
        text_includes="agent-workload",
    )
    print("\nRecent log lines from the sandbox:")
    for line in reversed(lines):
        print(f"  {line.ts}  {line.log}")
finally:
    sandbox.destroy()
    print(f"\nDestroyed {sandbox.id}")
