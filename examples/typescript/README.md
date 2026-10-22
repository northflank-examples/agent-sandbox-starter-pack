# TypeScript examples: AI agent sandboxes on Northflank

Runnable examples built on [`@northflank/js-client`](https://www.npmjs.com/package/@northflank/js-client). [`src/sandbox.ts`](src/sandbox.ts) is a small wrapper (`create`, `waitUntilReady`, `exec`, `writeFile`, `readFile`, `runCode`, `pause`, `resume`, `destroy`) that you can copy into your own project.

## Setup

```bash
npm install
cp .env.example .env   # NF_API_TOKEN, NF_PROJECT_ID; ANTHROPIC_API_KEY for the agent
```

Requires Node.js 22.9+ (the Northflank JS client needs Node 22, and the scripts use `--env-file-if-exists`). Create an API token from an RBAC role under [API tokens](https://app.northflank.com/s/account/api/tokens) in your team; note your project ID, which every API call needs.

## Scripts

| Command | File | What it shows |
| --- | --- | --- |
| `npm run first-sandbox` | [`01-first-sandbox.ts`](src/01-first-sandbox.ts) | Create, wait, exec, destroy |
| `npm run run-code` | [`02-run-code.ts`](src/02-run-code.ts) | Untrusted Python and JS: success, exception, infinite loop, files |
| `npm run lifecycle` | [`03-lifecycle.ts`](src/03-lifecycle.ts) | Pause and resume; what survives |
| `npm run agent -- "task"` | [`04-agent.ts`](src/04-agent.ts) | Claude with a `run_code` tool that executes in the sandbox |
| `npm run parallel` | [`05-parallel.ts`](src/05-parallel.ts) | One sandbox per task, run concurrently |
| `npm run persistent-volume` | [`06-persistent-volume.ts`](src/06-persistent-volume.ts) | Volume at `/workspace` survives pause/resume; safe cleanup (`-- --keep-volume` to keep it) |
| `npm run monitoring` | [`07-monitoring.ts`](src/07-monitoring.ts) | CPU and memory metrics, platform logs, a watchdog enforcing lifetime and memory limits |
| `npm run networking` | [`08-networking.ts`](src/08-networking.ts) | Public port behind basic auth, verified from outside; egress probe; `-- --egress-policy` applies a network policy |
| `npm run cleanup` | [`cleanup.ts`](src/cleanup.ts) | List leftover `sbx-*` sandboxes; `-- --yes` deletes them |
| `npm run typecheck` | | Type-check everything |

Every script destroys the sandboxes it creates in a `finally` block. Sandboxes use `nf-compute-20` (0.2 vCPU / 512 MB) by default; pass `plan` to `client.create()` for more.

## Using the wrapper

```typescript
import { SandboxClient } from "./sandbox.js";

const client = await SandboxClient.fromEnv();
const sandbox = await client.create({ image: "python:3.12-slim", plan: "nf-compute-50" });
try {
  await sandbox.waitUntilReady();
  await sandbox.writeFile("/tmp/agent/data.csv", "a,b\n1,2\n");
  const r = await sandbox.runCode("python", "import csv; print(list(csv.reader(open('data.csv'))))", {
    timeoutSeconds: 10,
  });
  console.log(r.exitCode, r.stdout, r.stderr, r.timedOut);
} finally {
  await sandbox.destroy();
}
```

Tutorials: [first sandbox](../../tutorials/create-your-first-sandbox/README.md) · [execute code](../../tutorials/execute-code-in-a-sandbox/README.md) · [connect an agent](../../tutorials/connect-sandbox-to-agent/README.md) · [persist files](../../tutorials/persist-files-between-sessions/README.md) · [monitor usage](../../tutorials/monitor-sandbox-usage/README.md) · [secure networking](../../tutorials/secure-sandbox-networking/README.md).
