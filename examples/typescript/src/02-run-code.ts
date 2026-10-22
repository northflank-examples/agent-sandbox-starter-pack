// Execute untrusted, AI-generated code in a sandbox and handle every outcome:
// success, a runtime error, and a runaway process. Run with: npm run run-code

import { SandboxClient, type ExecResult } from "./sandbox.js";

// Pretend these came from an LLM. Treat them as untrusted input.
const snippets: { name: string; language: "python" | "javascript"; code: string }[] = [
  {
    name: "Python: compute something",
    language: "python",
    code: [
      "import statistics, json",
      "data = [12, 7, 3, 21, 9, 14]",
      "print(json.dumps({'mean': statistics.mean(data), 'stdev': round(statistics.stdev(data), 3)}))",
    ].join("\n"),
  },
  {
    name: "Python: raises an exception",
    language: "python",
    code: "print('about to fail')\nraise ValueError('the model wrote a bug')",
  },
  {
    name: "Python: infinite loop (killed by timeout)",
    language: "python",
    code: "while True:\n    pass",
  },
  {
    name: "JavaScript: write and read a file",
    language: "javascript",
    code: [
      "const fs = require('node:fs');",
      "fs.writeFileSync('/tmp/agent/report.txt', 'generated inside the sandbox');",
      "console.log(fs.readFileSync('/tmp/agent/report.txt', 'utf8'));",
    ].join("\n"),
  },
];

function report(name: string, r: ExecResult) {
  const status = r.timedOut ? "TIMED OUT" : r.exitCode === 0 ? "OK" : `FAILED (exit ${r.exitCode})`;
  console.log(`\n## ${name}: ${status}`);
  if (r.stdout.trim()) console.log(`stdout:\n${r.stdout.trimEnd()}`);
  if (r.stderr.trim()) console.log(`stderr:\n${r.stderr.trimEnd()}`);
}

const client = await SandboxClient.fromEnv();
// A public image with both python3 and node, so one sandbox runs every snippet.
// In production, build and pin your own image (see guides/sandbox-security.md).
const sandbox = await client.create({ image: "nikolaik/python-nodejs:python3.12-nodejs22-slim" });
console.log(`Created ${sandbox.id}, waiting for it to boot...`);

try {
  await sandbox.waitUntilReady();
  for (const snippet of snippets) {
    const result = await sandbox.runCode(snippet.language, snippet.code, {
      timeoutSeconds: 5,
    });
    report(snippet.name, result);
  }
} finally {
  await sandbox.destroy();
  console.log(`\nDestroyed ${sandbox.id}`);
}
