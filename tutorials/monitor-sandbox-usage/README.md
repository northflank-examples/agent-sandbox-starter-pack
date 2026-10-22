# Tutorial: Monitor sandbox resource usage

Agents run code nobody reviewed. Most of it is fine, but some of it will burn CPU in a stuck loop, leak memory, or keep running long after the user has left. In this tutorial you'll build the monitoring an agent platform needs: read a sandbox's CPU and memory, read its output from the logs, and run a watchdog that destroys sandboxes that break your limits.

**You'll learn:**
- what to watch in an agent sandbox, and why
- how to send a background workload's output to the sandbox logs
- how to query CPU and memory metrics
- how to read and filter logs
- how to build a watchdog that enforces a lifetime and a memory limit

**Prerequisite:** [Create your first sandbox](../create-your-first-sandbox/README.md). The API token's role also needs permission to view observability data (metrics and logs) for services in the project. The finished scripts are [`07-monitoring.ts`](../../examples/typescript/src/07-monitoring.ts) and [`monitor_sandbox.py`](../../examples/python/monitor_sandbox.py).

## Step 1: Decide what to watch

| Signal | What it can mean |
| --- | --- |
| CPU busy for a long time | A stuck loop, or abuse such as crypto mining after a prompt injection |
| Memory climbing towards the plan's memory | A leak that will run out of memory |
| Age of the sandbox | A sandbox nobody is using, still costing money |
| Log output | The only record of what code did when nobody was watching |

Every limit in this tutorial maps to one of these.

## Step 2: Start a workload that writes to the logs

Start a background job the way an agent might, and write its output to `/proc/1/fd/1`, the standard output of the sandbox's main process (process 1). Step 4 fetches the sandbox's logs.

**TypeScript**

```typescript
import { SandboxClient } from "./sandbox.js";

const client = await SandboxClient.fromEnv();
const { api, projectId } = client;
const sandbox = await client.create({ plan: "nf-compute-20" });
await sandbox.waitUntilReady();

await sandbox.writeFile(
  "/tmp/agent/workload.py",
  "import time\nfor i in range(10):\n    print(f'agent-workload: step {i}', flush=True)\n    time.sleep(5)\n",
);
await sandbox.exec(
  "setsid nohup python3 /tmp/agent/workload.py > /proc/1/fd/1 2>&1 < /dev/null & echo $! > /tmp/agent/workload.pid",
);
```

**Python**

```python
from northflank_sandbox import SandboxClient

client = SandboxClient()
api, project_id = client.api, client.project_id
sandbox = client.create(plan="nf-compute-20")
sandbox.wait_until_ready()

sandbox.write_file(
    "/tmp/agent/workload.py",
    "import time\nfor i in range(10):\n    print(f'agent-workload: step {i}', flush=True)\n    time.sleep(5)\n",
)
sandbox.exec(
    "setsid nohup python3 /tmp/agent/workload.py > /proc/1/fd/1 2>&1 < /dev/null & echo $! > /tmp/agent/workload.pid"
)
```

What each part does: `&` runs the job in the background so the command returns right away, `setsid nohup` detaches it from the command that started it, and `echo $!` saves its process ID so you can check on it later. Prefixing each line with `agent-workload:` makes it easy to find in the logs.

## Step 3: Read CPU and memory metrics

Ask for a time range of CPU and memory data. The response has one series per container, each a list of `{ value, ts }` points, plus the unit in `metricInfo.metricUnit` (for example `vCPU` or `mb`).

**TypeScript**

```typescript
import { MetricType } from "@northflank/js-client";

const { data } = await api.get.service.metricsRange({
  parameters: { projectId, serviceId: sandbox.id },
  options: {
    metricTypes: [MetricType.Cpu, MetricType.Memory],
    startTime: new Date(Date.now() - 5 * 60_000),
    endTime: new Date(),
  },
});
const latestMemory = data.memory?.values[0]?.data.at(-1);   // { value, ts }
console.log(latestMemory?.value, data.memory?.metricInfo.metricUnit);
```

**Python**

```python
from datetime import datetime, timedelta, timezone

response = api.get.service.metrics(
    project_id=project_id,
    service_id=sandbox.id,
    query_type="range",
    metric_types=["cpu", "memory"],
    start_time=datetime.now(timezone.utc) - timedelta(minutes=5),
)
print(response.data)
```

Other metric types include `networkIngress`, `networkEgress`, `tcpConnectionsOpen` and `diskUsage`.

## Step 4: Read the logs

Fetch recent log lines, filtered to the workload's prefix. `textIncludes` filters on the server, which is much cheaper than fetching everything and filtering yourself.

**TypeScript**

```typescript
const logs = await api.get.service.logs({
  parameters: { projectId, serviceId: sandbox.id },
  options: { lineLimit: 20, direction: "backward", textIncludes: "agent-workload" },
});
for (const line of logs.data) console.log(line.ts, line.log);
```

**Python**

```python
lines = api.logs.fetch_service_logs(
    project_id=project_id,
    service_id=sandbox.id,
    line_limit=20,
    direction="backward",
    text_includes="agent-workload",
)
for line in lines:
    print(line.ts, line.log)
```

To stream logs live instead, use `api.get.service.logTail` (TypeScript) or `api.logs.tail_service_logs` (Python).

## Step 5: Enforce limits with a watchdog

A watchdog is a loop that checks a sandbox against your limits and destroys it when one is broken. This one enforces a maximum lifetime and a memory limit, and stops when the workload finishes:

**TypeScript**

```typescript
const MAX_LIFETIME_MS = 4 * 60_000;
const MEMORY_LIMIT_MB = 400;   // nf-compute-20 has 512 MB
const startedAt = Date.now();

while (true) {
  await new Promise((r) => setTimeout(r, 15_000));
  const { data } = await api.get.service.metricsRange({
    parameters: { projectId, serviceId: sandbox.id },
    options: { metricTypes: [MetricType.Memory], startTime: new Date(Date.now() - 5 * 60_000), endTime: new Date() },
  });
  const memory = Number(data.memory?.values[0]?.data.at(-1)?.value ?? 0);

  if (memory > MEMORY_LIMIT_MB) { console.log("memory limit exceeded"); break; }
  if (Date.now() - startedAt > MAX_LIFETIME_MS) { console.log("lifetime exceeded"); break; }

  const running = await sandbox.exec("kill -0 $(cat /tmp/agent/workload.pid) 2>/dev/null && echo yes || echo no");
  if (running.stdout.trim() === "no") break;   // the workload finished
}
await sandbox.destroy();
```

`kill -0` sends no signal; it only checks that the process still exists. Slim images don't include `pgrep`, so checking the saved PID is the portable option.

Some limits worth enforcing in production:

| Check | Example limit | Why |
| --- | --- | --- |
| Lifetime | Minutes for a code interpreter, hours for a coding agent | Stops forgotten sandboxes costing money |
| Memory | Below the plan's memory | Catches leaks before the process is killed |
| Sustained CPU | Near-full CPU for a long time with no user activity | Typical sign of abuse such as crypto mining |
| Network egress | An unexpected volume | Possible data exfiltration |

In production, run the watchdog as a separate scheduled job over *all* sandboxes (list them by the `sbx-` prefix or the `agent-sandbox` tag) rather than inside the script that created them, so it still runs if that script crashes.

## Run the complete example

The finished scripts run a workload that holds 250 MB of memory and keeps the CPU busy for 150 seconds, poll the metrics every 15 seconds, enforce the limits above, and print the workload's log lines at the end.

```bash
cd examples/typescript && npm run monitoring
# or
cd examples/python && python monitor_sandbox.py
```

Expected output:

```
Created sbx-7b1e0d42
Started workload: a busy loop holding 250 MB for 150s on a 0.2 vCPU plan

[27s] cpu=n/a (no data yet)  memory=n/a
[44s] cpu=0.20 vCPU  memory=262 mb
[60s] cpu=0.20 vCPU  memory=263 mb
...
[171s] cpu=0.20 vCPU  memory=263 mb
Workload finished

Recent log lines from the sandbox:
  2026-10-21T12:01:10.000Z  agent-workload: still running, 121s left
  2026-10-21T12:02:01.000Z  agent-workload: still running, 70s left
  2026-10-21T12:03:12.000Z  agent-workload: finished

Destroyed sbx-7b1e0d42
```

Illustrative output: values, units and timings will differ.

## Production checklist

- [ ] Every sandbox has a maximum lifetime, enforced outside the code that created it
- [ ] Per-user limits on concurrent sandboxes and total sandbox-hours
- [ ] Agent commands and their exit codes logged with user and session IDs
- [ ] Alerts on sustained CPU, memory near the limit, and unusual egress
- [ ] Logs exported to your log platform (Northflank supports log sinks) for retention and search
- [ ] Spend alerts on the account

Northflank docs: [Configure and manage sandboxes](https://northflank.com/docs/v1/application/sandboxes/configure-and-manage-sandboxes) · [Retrieve metrics](https://northflank.com/docs/v1/api/retrieve-metrics) · [Log tailing](https://northflank.com/docs/v1/api/log-tailing).

## Next

- [Secure sandbox networking](../secure-sandbox-networking/README.md)
- [Sandbox security guide](../../guides/sandbox-security.md)
