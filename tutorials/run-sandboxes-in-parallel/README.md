# Tutorial: Run sandboxes in parallel

Agents rarely do one thing at a time. An eval runs hundreds of tasks, a test pipeline checks several generated apps, a multi-agent system gives each agent its own workspace. In this tutorial you'll run several tasks at once, each in its own sandbox, so they finish in roughly the time of the slowest one, and a crash in one task can't affect the others' files, processes or memory.

**You'll learn:**
- why each task should get its own sandbox
- how to write a task function that always cleans up its sandbox
- how to run tasks concurrently in TypeScript and Python
- how to collect results when some tasks fail
- what limits to plan for when you scale up

**Prerequisite:** [Create your first sandbox](../create-your-first-sandbox/README.md). The finished scripts are [`05-parallel.ts`](../../examples/typescript/src/05-parallel.ts) and [`parallel.py`](../../examples/python/parallel.py).

## Step 1: Give every task its own sandbox

You could run several tasks in one sandbox, but then they share a filesystem, processes and memory. One task can read another's files, fill the disk or exhaust the memory. A separate sandbox per task means:

- **Isolation:** a task that crashes, loops or fills its disk doesn't affect the others' files, processes or memory. (To control network traffic between sandboxes, see [Secure sandbox networking](../secure-sandbox-networking/README.md).)
- **A clean start:** no files or processes left over from an earlier task.
- **Simple cleanup:** when a task ends, its sandbox and everything in it go together.

## Step 2: Write one task as a function

Wrap the full life of one task (create, wait, run, destroy) in a single function. Put the destroy in `finally`, so the sandbox is deleted whether the task succeeds, fails or times out:

**TypeScript**

```typescript
import { SandboxClient } from "./sandbox.js";

const client = await SandboxClient.fromEnv();

async function runTask(index: number, code: string) {
  const sandbox = await client.create();
  try {
    await sandbox.waitUntilReady();
    const r = await sandbox.runCode("python", code, { timeoutSeconds: 10 });
    return { task: index, sandbox: sandbox.id, exitCode: r.exitCode, output: r.stdout.trim() || r.stderr.trim() };
  } finally {
    await sandbox.destroy();
  }
}
```

**Python**

```python
from northflank_sandbox import SandboxClient

def run_task(index: int, code: str) -> str:
    client = SandboxClient()            # one client per task (and per thread)
    with client.create() as sandbox:    # destroyed when the block exits, even on errors
        sandbox.wait_until_ready()
        r = sandbox.run_python(code, timeout_seconds=10)
        output = r.stdout.strip() or r.stderr.strip()
        return f"task {index} [{sandbox.id}] exit={r.exit_code}: {output}"
```

The Python version creates a `SandboxClient` per task, so each thread in the next step has its own HTTP client.

## Step 3: Run the tasks concurrently

Start every task at once and wait for all of them. Most of a task's time is spent waiting on the network (for the sandbox to start, for the command to finish), so running tasks side by side takes about as long as the slowest task rather than the sum of all of them.

TypeScript uses `Promise.allSettled`, which waits for every task, including the ones that fail:

```typescript
const tasks = [
  "import math; print(sum(math.factorial(n) for n in range(50)) % 1_000_007)",
  "print(sorted({w.lower() for w in 'the quick brown fox jumps over the lazy dog'.split()}))",
  "import hashlib; print(hashlib.sha256(b'agent-sandbox').hexdigest())",
];

const results = await Promise.allSettled(tasks.map((code, i) => runTask(i, code)));
```

Python uses a thread pool, one thread per task:

```python
from concurrent.futures import ThreadPoolExecutor

TASKS = [
    "import math; print(sum(math.factorial(n) for n in range(50)) % 1_000_007)",
    "print(sorted({w.lower() for w in 'the quick brown fox jumps over the lazy dog'.split()}))",
    "import hashlib; print(hashlib.sha256(b'agent-sandbox').hexdigest())",
]

with ThreadPoolExecutor(max_workers=len(TASKS)) as pool:
    futures = [pool.submit(run_task, i, code) for i, code in enumerate(TASKS)]
```

## Step 4: Collect results, including failures

Some tasks will fail: a sandbox might not start, or the code might crash. Report each result on its own, so one failure doesn't hide the others' results:

**TypeScript**

```typescript
for (const r of results) {
  if (r.status === "fulfilled") {
    console.log(`task ${r.value.task} [${r.value.sandbox}] exit=${r.value.exitCode}: ${r.value.output}`);
  } else {
    console.log(`task failed: ${r.reason}`);
  }
}
```

**Python**

```python
for future in futures:
    try:
        print(future.result())
    except Exception as error:
        print(f"task failed: {error}")
```

There are two kinds of failure here. A non-zero exit code means the sandbox worked but the task's code failed, and that shows up in the result. A rejected promise or a raised exception means the task didn't complete normally: for example, the sandbox didn't start, a command couldn't be sent, or cleanup failed.

## Step 5: Plan for scale

Three sandboxes are easy. Before running hundreds, plan for these:

- **API rate limit.** The Northflank API has a default rate limit of 1,000 requests per hour ([docs](https://northflank.com/docs/v1/api/use-the-javascript-client#rate-limits)). Every sandbox makes several API requests: create, a status poll every second while it starts, and delete. Run tasks in batches, poll less often, and read the `x-ratelimit-remaining` response header if you're close. You can ask Northflank support for a higher limit.
- **Cap concurrency.** Limit how many sandboxes run at once: `max_workers` in Python, or a small queue in TypeScript. This keeps your request rate and your bill predictable.
- **Retry the right failures.** Retry a task whose sandbox didn't start. Don't automatically retry a task whose code failed; that's a result.
- **Clean up leftovers.** If the whole script is interrupted, the `finally` blocks may not run. `npm run cleanup -- --yes` deletes every `sbx-*` sandbox in the project.

## Run the complete example

```bash
cd examples/typescript && npm run parallel
# or
cd examples/python && python parallel.py
```

Expected output:

```
task 0 [sbx-4b1c9e2a] exit=0: 772084
task 1 [sbx-8f0d3a17] exit=0: ['brown', 'dog', 'fox', 'jumps', 'lazy', 'over', 'quick', 'the']
task 2 [sbx-1e6a7c55] exit=0: 2551521c5c5b92f293574344e3e73e5e80d171f799bf1b399c21b3996bbae439

3 sandboxes, X.Xs wall clock
```

Illustrative output: sandbox IDs and timings will differ; the task results are what the code prints.

## Common errors

| Symptom | Cause | Fix |
| --- | --- | --- |
| Rate-limit errors from the API | Too many API requests in the hour | Run fewer sandboxes at once, poll less often, or ask Northflank support for a higher limit |
| Some tasks fail with `was not ready` (TypeScript) or `did not reach COMPLETED` (Python) | The sandbox didn't reach `COMPLETED` in time | Retry those tasks; check the service in the dashboard |
| `sbx-*` sandboxes left behind | The script was interrupted before cleanup | `npm run cleanup -- --yes` (from `examples/typescript`) |

## Next

- [Monitor sandbox resource usage](../monitor-sandbox-usage/README.md): watch many sandboxes and stop runaway ones.
- [Connect an AI agent to a sandbox](../connect-sandbox-to-agent/README.md)
