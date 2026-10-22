# Tutorial: Execute AI-generated code safely

When an LLM writes code, you don't know what it will do. It might work, crash, loop forever, or try to read things it shouldn't. In this tutorial you'll build the piece every code-running agent needs: a function that takes untrusted code, runs it inside a sandbox, and turns whatever happens into a result the agent can act on.

**You'll learn:**
- how to get untrusted code into a sandbox without breaking it or letting the shell interpret it
- how to stop runaway code with a timeout that runs inside the sandbox
- how to turn success, crashes and timeouts into results instead of exceptions
- why secrets must stay outside the sandbox, and how to check that they do
- how to move files in and out

**Prerequisite:** [Create your first sandbox](../create-your-first-sandbox/README.md). This tutorial uses the `Sandbox` helper from that tutorial's example code ([`sandbox.ts`](../../examples/typescript/src/sandbox.ts), [`northflank_sandbox.py`](../../examples/python/northflank_sandbox.py)), which wraps the create, wait, exec and delete calls you wrote there. The finished scripts are [`02-run-code.ts`](../../examples/typescript/src/02-run-code.ts) and [`run_python_code.py`](../../examples/python/run_python_code.py).

## The pattern

```
LLM output (untrusted code)
   └─► 1. write it to a file in the sandbox
        └─► 2. run the file with a timeout, inside the sandbox
             └─► 3. capture stdout, stderr and the exit code
                  └─► 4. classify and truncate, then hand back to the agent as data
```

## Step 1: Start a sandbox

Create a sandbox with the runtimes the agent's code needs, and wait for it to be ready. The helper does the create-and-poll from the first tutorial in two calls:

**TypeScript**

```typescript
import { SandboxClient } from "./sandbox.js";

const client = await SandboxClient.fromEnv();             // NF_API_TOKEN, NF_PROJECT_ID
const sandbox = await client.create({ image: "python:3.12-slim" });
await sandbox.waitUntilReady();
```

**Python**

```python
from northflank_sandbox import SandboxClient

client = SandboxClient()                                   # NF_API_TOKEN, NF_PROJECT_ID
sandbox = client.create(image="python:3.12-slim")
sandbox.wait_until_ready()
```

The image decides which languages can run. `python:3.12-slim` has Python; the TypeScript example uses an image with both Python and Node.js so it can run both.

## Step 2: Write the code to a file

The tempting approach is to put the code straight into a command, like `python3 -c "<code>"`. Don't. Model-written code is full of quotes, newlines and characters such as `$(...)` that the shell will either choke on or, worse, execute.

Instead, encode the code as base64, which uses only letters, digits, `+`, `/` and `=`, so nothing in it can be interpreted. Then decode it into a file inside the sandbox:

**TypeScript**

```typescript
const code = "print('hello from untrusted code')";
const encoded = Buffer.from(code, "utf8").toString("base64");

await sandbox.exec(
  `mkdir -p /tmp/agent && printf %s '${encoded}' | base64 -d > /tmp/agent/main.py`,
);
```

**Python**

```python
import base64

code = "print('hello from untrusted code')"
encoded = base64.b64encode(code.encode()).decode()

sandbox.exec(f"mkdir -p /tmp/agent && printf %s '{encoded}' | base64 -d > /tmp/agent/main.py")
```

The helpers wrap this as `writeFile(path, content)` / `write_file(path, content)`.

## Step 3: Run it with a timeout inside the sandbox

Now run the file. Model-written code can loop forever, so every run needs a time limit enforced **inside the sandbox**, where `timeout` kills the process.

The helper's `exec` wraps every command in GNU `timeout`:

**TypeScript**

```typescript
// Inside the helper: timeout -s KILL <seconds> sh -c '<command>'
const result = await sandbox.exec("cd /tmp/agent && python3 main.py", { timeoutSeconds: 5 });
console.log(result.exitCode, result.stdout, result.stderr, result.timedOut);
```

**Python**

```python
result = sandbox.exec("cd /tmp/agent && python3 main.py", timeout_seconds=5)
print(result.exit_code, result.stdout, result.stderr, result.timed_out)
```

When `timeout -s KILL` kills a command, the exit code is `137` (128 + the KILL signal, 9), which is how the helper sets `timedOut`. Steps 2 and 3 together are `sandbox.runCode("python", code, { timeoutSeconds: 5 })` in TypeScript and `sandbox.run_python(code, timeout_seconds=5)` in Python.

## Step 4: Turn the outcome into a result

Running untrusted code has three normal outcomes, and none of them should crash your program:

| Outcome | How you can tell | What the agent needs |
| --- | --- | --- |
| Success | `exitCode === 0` | stdout |
| The code failed | non-zero exit code | stderr, such as the traceback, so it can fix the bug |
| The code ran too long | `timedOut` (exit code 137) | to know it timed out, so it can try a cheaper approach |

**TypeScript**

```typescript
function describe(r: { stdout: string; stderr: string; exitCode: number; timedOut: boolean }) {
  const status = r.timedOut ? "TIMED OUT" : r.exitCode === 0 ? "OK" : `FAILED (exit ${r.exitCode})`;
  const truncate = (s: string) => (s.length > 10_000 ? `${s.slice(0, 10_000)}\n...[truncated]` : s);
  return `status: ${status}\nstdout:\n${truncate(r.stdout)}\nstderr:\n${truncate(r.stderr)}`;
}
```

Truncate the output before it goes back to a model: a program that prints a huge array would otherwise fill the model's context. Treat the output as untrusted text too. Never `eval` it or paste it into a shell command in your own application.

## Step 5: Keep secrets out, and check

Code in the sandbox can read everything in its own environment and filesystem, so the rule is simple: **put nothing there worth stealing.** Your Northflank token and your LLM API key belong only to the program that *controls* the sandbox, never inside it.

Check it by running exactly what an attacker would:

**Python**

```python
probe = (
    "import os\n"
    "print('NF_API_TOKEN' in os.environ, 'ANTHROPIC_API_KEY' in os.environ)\n"
)
print(sandbox.run_python(probe).stdout)   # False False
```

If you need to pass configuration into a sandbox, use non-secret values only, through the `env` option on `create`.

## Step 6: Move files in and out

Agents often need input files (a CSV to analyse) and produce outputs (a chart, a report).

- **Small text files:** the helpers' `writeFile` (base64, as in step 2) and `readFile` (`cat`); in Python, `write_file` and `exec("cat <path>")`.
- **Larger files and directories:** the SDK's file copy:

**TypeScript**

```typescript
await client.api.upload.service.files(
  { projectId: client.projectId, serviceId: sandbox.id },
  { localPath: "./data.csv", remotePath: "/tmp/agent" },
);
await client.api.download.service.files(
  { projectId: client.projectId, serviceId: sandbox.id },
  { localPath: "./results", remotePath: "/tmp/agent/results" },
);
```

**Python**

```python
client.api.files.upload(
    project_id=client.project_id, service_id=sandbox.id,
    local_path="./data.csv", remote_path="/tmp/agent",
)
client.api.files.download(
    project_id=client.project_id, service_id=sandbox.id,
    remote_path="/tmp/agent/results", local_path="./results",
)
```

File copy runs over the same connection as commands, so the image needs `tar` ([docs](https://northflank.com/docs/v1/application/sandboxes/configure-and-manage-sandboxes)). Files coming out of a sandbox were made by untrusted code: check their size and type before you use them.

When you're done, destroy the sandbox in a `finally` block, as in the first tutorial.

## Run the complete example

The Python script runs four model-style snippets: one that works, one that raises an exception, an infinite loop, and one that looks for secrets. The TypeScript script runs the first three plus a JavaScript snippet that writes and reads a file.

```bash
cd examples/python && python run_python_code.py
# or
cd examples/typescript && npm run run-code
```

Expected output (Python):

```
Created sbx-5e6f7a8b, waiting for it to boot...

## compute something: OK
stdout:
{"mean": 11, "stdev": 6.229}

## raises an exception: FAILED (exit 1)
stdout:
about to fail
stderr:
Traceback (most recent call last):
  File "/tmp/agent/main.py", line 2, in <module>
    raise ValueError('the model wrote a bug')
ValueError: the model wrote a bug

## infinite loop (killed by timeout): TIMED OUT

## tries to read host secrets: OK
stdout:
False False
<sandbox hostname>

Destroyed sbx-5e6f7a8b
```

Illustrative output: IDs and tracebacks will differ slightly.

## Hardening checklist for production

- [ ] Fresh sandbox per user (and ideally per task); never shared across users
- [ ] No secrets in the sandbox environment
- [ ] Egress blocked or allowlisted ([tutorial](../secure-sandbox-networking/README.md))
- [ ] Per-command timeout and a maximum sandbox lifetime
- [ ] Output truncated before it goes back to the model
- [ ] Image pinned by digest with dependencies pre-installed
- [ ] Every execution logged with user, session and sandbox IDs

Details: [Sandbox security](../../guides/sandbox-security.md).

## Common errors

| Symptom | Cause | Fix |
| --- | --- | --- |
| `python3: not found` / `node: not found` | Image lacks the runtime | Use an image with it, e.g. `python:3.12-slim`, `node:22-slim` |
| `base64: not found` when writing a file | Very minimal image (distroless/scratch) | Use a Debian/Alpine-based image (file copy also needs `tar` in the image) |
| `timeout: not found` | Image without coreutils/busybox | Use a standard base image |
| Reported as TIMED OUT (exit 137) well before the time limit | The process was killed with SIGKILL, for example on running out of memory | Use a bigger plan, or reduce memory use |

## Next

- [Connect an AI agent to a sandbox](../connect-sandbox-to-agent/README.md): give an LLM a `run_code` tool built on these steps.
