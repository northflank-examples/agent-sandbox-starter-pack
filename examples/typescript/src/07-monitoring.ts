// Monitor sandbox resource usage. Starts a workload that burns CPU and
// allocates memory, watches CPU and memory metrics while it runs, enforces a
// memory limit and a maximum lifetime with a watchdog, and reads the
// workload's output back from the platform logs.
//
// Run with: npm run monitoring

import { MetricType } from "@northflank/js-client";
import { SandboxClient, type Sandbox } from "./sandbox.js";

// Watchdog limits. In production these come from your per-user quotas.
const MAX_LIFETIME_MS = 4 * 60_000;
const MEMORY_LIMIT_MB = 400; // nf-compute-20 has 512 MB
const POLL_MS = 15_000;

const client = await SandboxClient.fromEnv();
const { api, projectId } = client;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sandbox = await client.create({ plan: "nf-compute-20" });
const createdAt = Date.now();
console.log(`Created ${sandbox.id}`);

/** Latest value of each requested metric over the last few minutes. */
async function latestMetrics(s: Sandbox) {
  const { data } = await api.get.service.metricsRange({
    parameters: { projectId, serviceId: s.id },
    options: {
      metricTypes: [MetricType.Cpu, MetricType.Memory],
      startTime: new Date(Date.now() - 5 * 60_000),
      endTime: new Date(),
    },
  });
  const latest = (metric: MetricType) => {
    const entry = data[metric];
    const points = entry?.values?.flatMap((v) => v.data) ?? [];
    const last = points[points.length - 1];
    return last ? { value: Number(last.value), unit: entry.metricInfo.metricUnit } : undefined;
  };
  return { cpu: latest(MetricType.Cpu), memory: latest(MetricType.Memory) };
}

try {
  await sandbox.waitUntilReady();

  // Start the workload in the background, writing its output to /proc/1/fd/1
  // (the stdout of the sandbox's main process). The logs are fetched below.
  const workload = [
    "import time",
    "blob = b'x' * (250 * 1024 * 1024)  # hold 250 MB of real, touched memory",
    "end = time.time() + 150",
    "i = 0",
    "while time.time() < end:",
    "    i += 1",
    "    if i % 5_000_000 == 0:",
    "        print(f'agent-workload: still running, {int(end - time.time())}s left', flush=True)",
    "print('agent-workload: finished', flush=True)",
  ].join("\n");
  await sandbox.writeFile("/tmp/agent/workload.py", workload);
  await sandbox.exec(
    "setsid nohup python3 /tmp/agent/workload.py > /proc/1/fd/1 2>&1 < /dev/null & echo $! > /tmp/agent/workload.pid",
  );
  console.log("Started workload: a busy loop holding 250 MB for 150s on a 0.2 vCPU plan\n");

  // Watch metrics and enforce limits.
  while (true) {
    await sleep(POLL_MS);
    const age = Date.now() - createdAt;
    const m = await latestMetrics(sandbox);
    const cpu = m.cpu ? `${m.cpu.value.toFixed(2)} ${m.cpu.unit}` : "n/a (no data yet)";
    const mem = m.memory ? `${m.memory.value.toFixed(0)} ${m.memory.unit}` : "n/a";
    console.log(`[${Math.round(age / 1000)}s] cpu=${cpu}  memory=${mem}`);

    if (m.memory && m.memory.unit === "mb" && m.memory.value > MEMORY_LIMIT_MB) {
      console.log(`Watchdog: memory above ${MEMORY_LIMIT_MB} MB, destroying sandbox`);
      break;
    }
    if (age > MAX_LIFETIME_MS) {
      console.log(`Watchdog: sandbox older than ${MAX_LIFETIME_MS / 60_000} min, destroying it`);
      break;
    }
    // Slim images have no pgrep; check the PID recorded at start instead.
    const running = await sandbox.exec(
      "kill -0 $(cat /tmp/agent/workload.pid) 2>/dev/null && echo yes || echo no",
    );
    if (running.stdout.trim() === "no") {
      console.log("Workload finished");
      break;
    }
  }

  // Read the workload's output back from the platform logs.
  const logs = await api.get.service.logs({
    parameters: { projectId, serviceId: sandbox.id },
    options: { lineLimit: 20, direction: "backward", textIncludes: "agent-workload" },
  });
  console.log("\nRecent log lines from the sandbox:");
  for (const line of [...logs.data].reverse()) {
    console.log(`  ${new Date(line.ts).toISOString()}  ${line.log}`);
  }
} finally {
  await sandbox.destroy();
  console.log(`\nDestroyed ${sandbox.id}`);
}
