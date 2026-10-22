// Run independent workloads in parallel, one sandbox each, so a crash in one
// task can't affect the others' files, processes or memory. Run with: npm run parallel

import { SandboxClient } from "./sandbox.js";

const tasks = [
  "import math; print(sum(math.factorial(n) for n in range(50)) % 1_000_007)",
  "print(sorted({w.lower() for w in 'the quick brown fox jumps over the lazy dog'.split()}))",
  "import hashlib; print(hashlib.sha256(b'agent-sandbox').hexdigest())",
];

const client = await SandboxClient.fromEnv();
const started = Date.now();

const results = await Promise.allSettled(
  tasks.map(async (code, i) => {
    const sandbox = await client.create();
    try {
      await sandbox.waitUntilReady();
      const r = await sandbox.runCode("python", code, { timeoutSeconds: 10 });
      return { task: i, sandbox: sandbox.id, exitCode: r.exitCode, output: r.stdout.trim() || r.stderr.trim() };
    } finally {
      await sandbox.destroy();
    }
  }),
);

for (const r of results) {
  if (r.status === "fulfilled") {
    console.log(`task ${r.value.task} [${r.value.sandbox}] exit=${r.value.exitCode}: ${r.value.output}`);
  } else {
    console.log(`task failed: ${r.reason}`);
  }
}
console.log(`\n${tasks.length} sandboxes, ${((Date.now() - started) / 1000).toFixed(1)}s wall clock`);
