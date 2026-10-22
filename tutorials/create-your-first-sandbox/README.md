# Tutorial: Create your first AI agent sandbox

An AI agent that runs code needs somewhere to run it that isn't your own machine or servers. In this tutorial you'll build that place: a script that creates an isolated sandbox, runs a command inside it, reads the result, and deletes the sandbox. Every other tutorial in this repo builds on these four steps.

**You'll learn:**
- what a sandbox is on Northflank, and what you choose when you create one
- why a sandbox needs a long-running command
- how to tell when a sandbox is ready
- how to run a command and capture its stdout, stderr and exit code
- how to make sure sandboxes are always cleaned up

Code is shown in TypeScript and Python. The finished scripts are [`01-first-sandbox.ts`](../../examples/typescript/src/01-first-sandbox.ts) and [`first_sandbox.py`](../../examples/python/first_sandbox.py).

## Before you start

- A [Northflank account](https://app.northflank.com/signup) and a **project** on Northflank Cloud ([create one](https://app.northflank.com/s/account/projects/new)). Note its project ID; every API call needs it.
- An **API token**. Create one from an RBAC role under [API tokens](https://app.northflank.com/s/account/api/tokens) in your team; the token gets that role's permissions. For this tutorial the role needs the Project → Services → General Create, Read and Delete permissions (each endpoint's required permission is listed in the [API reference](https://northflank.com/docs/v1/api/project/services/create-deployment-service)).
- **TypeScript:** Node.js 22.9+. **Python:** Python 3.10+.

Cost: the examples use the `nf-compute-20` plan (0.2 vCPU / 512 MB, about $0.008/hour) and delete the sandbox when done, so a run costs a fraction of a cent.

## Step 1: Connect to the Northflank API

Everything in this tutorial goes through the Northflank SDK, authenticated with your API token. Keep the token in an environment variable, never in code.

```bash
export NF_API_TOKEN=...      # your API token
export NF_PROJECT_ID=...     # your project ID
```

**TypeScript** ([`@northflank/js-client`](https://northflank.com/docs/v1/api/use-the-javascript-client)):

```typescript
import { ApiClient, ApiClientInMemoryContextProvider } from "@northflank/js-client";

const contextProvider = new ApiClientInMemoryContextProvider();
await contextProvider.addContext({ name: "default", token: process.env.NF_API_TOKEN! });

// Throw on HTTP errors instead of returning them, so failures can't go unnoticed.
const api = new ApiClient(contextProvider, { throwErrorOnHttpErrorCode: true });
const projectId = process.env.NF_PROJECT_ID!;
```

**Python** ([`northflank`](https://northflank.com/docs/v1/api/use-the-python-client)):

```python
import os
from northflank import ApiClient

client = ApiClient()   # reads NF_API_TOKEN (or NORTHFLANK_API_TOKEN); raises on HTTP errors
project_id = os.environ["NF_PROJECT_ID"]
```

## Step 2: Create the sandbox

On Northflank, a sandbox is a **deployment service**: a container image running in its own isolated environment. On Northflank Cloud, CPU sandboxes run in microVMs, each with its own kernel. Creating a sandbox means choosing:

- **an image**, which decides what software is available inside (here `python:3.12-slim`, so Python is installed)
- **a plan**, which sets the CPU and memory (here `nf-compute-20`)
- **a command to keep it running.** Base images like `python:3.12-slim` exit as soon as they start, and you can't run commands in a container that has exited. `sleep infinity` keeps the sandbox up, waiting for work.
- **ephemeral disk**, the scratch space inside the sandbox, in MB

**TypeScript**

```typescript
const sandboxId = `sbx-${crypto.randomUUID().split("-")[0]}`;

await api.create.service.deployment({
  parameters: { projectId },
  data: {
    name: sandboxId,
    billing: { deploymentPlan: "nf-compute-20" },
    deployment: {
      instances: 1,
      external: { imagePath: "python:3.12-slim" },
      docker: { configType: "customCommand", customCommand: "sleep infinity" },
      storage: { ephemeralStorage: { storageSize: 2048 } },
    },
  },
});
```

**Python**

```python
import uuid

sandbox_id = f"sbx-{uuid.uuid4().hex[:8]}"

client.create.service.deployment(
    project_id=project_id,
    data={
        "name": sandbox_id,
        "billing": {"deploymentPlan": "nf-compute-20"},
        "deployment": {
            "instances": 1,
            "external": {"imagePath": "python:3.12-slim"},
            "docker": {"configType": "customCommand", "customCommand": "sleep infinity"},
            "storage": {"ephemeralStorage": {"storageSize": 2048}},
        },
    },
)
```

Giving every sandbox the same prefix (`sbx-`) makes leftovers easy to find later.

## Step 3: Wait until it's ready

Before running commands, poll the sandbox's status until the deployment reports `COMPLETED`. On Northflank, `COMPLETED` means the sandbox has rolled out and is **running**, not that it has finished. `FAILED` means the deployment failed.

**TypeScript**

```typescript
async function waitUntilReady(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await api.get.service({ parameters: { projectId, serviceId: sandboxId } });
    const status = "deployment" in data.status! ? data.status.deployment?.status : undefined;
    if (status === "COMPLETED") return;
    if (status === "FAILED") throw new Error("Sandbox failed to start");
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Sandbox was not ready in time");
}
await waitUntilReady();
```

The Python SDK has this loop built in:

```python
client.helpers.wait_for_service_ready(
    project_id=project_id, service_id=sandbox_id, timeout_s=180, poll_interval_s=1
)
```

Always set a timeout, so a sandbox that never starts can't leave your agent waiting forever.

## Step 4: Run a command and read the result

Now run a command inside the sandbox. You get back three things, and an agent needs all of them:

- **stdout**, the program's normal output
- **stderr**, its error output, such as a Python traceback
- **the exit code**: `0` for success, anything else for failure

**TypeScript**

```typescript
const result = await api.exec.execServiceCommand(
  { projectId, serviceId: sandboxId },
  {
    command: 'timeout -s KILL 60 sh -c \'echo "Hello from $(hostname)" && uname -r && python3 --version\'',
    shell: "sh -c",
  },
);
console.log(result.commandResult.exitCode, result.stdOut, result.stdErr);
```

**Python**

```python
result = client.exec.run_service_command(
    project_id=project_id,
    service_id=sandbox_id,
    command="timeout -s KILL 60 sh -c 'echo \"Hello from $(hostname)\" && uname -r && python3 --version'",
    shell="sh -c",
)
print(result.exit_code, result.stdout, result.stderr)
```

Two details here protect you once an agent writes the commands:

- **`timeout -s KILL 60`** runs inside the sandbox and kills the command after 60 seconds. Because it's enforced inside the sandbox, it applies however your side behaves. When `timeout` kills a command, the exit code is `137`.
- **`shell: "sh -c"`** runs the command through a shell, so `&&`, pipes and `$(...)` work.

The example scripts wrap this in an `exec()` helper that adds the timeout and quoting for you ([`sandbox.ts`](../../examples/typescript/src/sandbox.ts), [`northflank_sandbox.py`](../../examples/python/northflank_sandbox.py)).

## Step 5: Always clean up

A sandbox keeps running, and costing money, until you pause or delete it. Put the deletion in a `finally` block (or a Python context manager), so it runs even when a step above fails:

**TypeScript**

```typescript
try {
  await waitUntilReady();
  // ... run commands ...
} finally {
  await api.delete.service({ parameters: { projectId, serviceId: sandboxId } });
}
```

**Python**

```python
try:
    client.helpers.wait_for_service_ready(project_id=project_id, service_id=sandbox_id)
    # ... run commands ...
finally:
    client.delete.service(project_id=project_id, service_id=sandbox_id)
```

## Run the complete example

The finished scripts put these five steps together using the helpers in this repo.

**TypeScript:**

```bash
git clone https://github.com/northflank-examples/agent-sandbox-starter-pack
cd agent-sandbox-starter-pack/examples/typescript
npm install
cp .env.example .env    # set NF_API_TOKEN and NF_PROJECT_ID
npm run first-sandbox
```

**Python:**

```bash
cd agent-sandbox-starter-pack/examples/python
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export NF_API_TOKEN=... NF_PROJECT_ID=...
python first_sandbox.py
```

Expected output:

```
1. Creating sandbox...
   created sbx-1a2b3c4d
2. Waiting for it to boot...
   ready in X.Xs
3. Running a command inside the sandbox...
   exit code: 0
   | Hello from <sandbox hostname>
   | 6.x.y
   | Python 3.12.x
4. Destroying sandbox...
   done
```

Illustrative output: IDs, timings and versions will differ. The kernel version printed by `uname -r` is the sandbox's **own kernel**, not your machine's.

## Common errors

| Error | Cause | Fix |
| --- | --- | --- |
| `NF_API_TOKEN is not set` | `.env` missing or not loaded | `cp .env.example .env` and fill it in; run via `npm run ...` |
| `401` / `403` from the API | Token invalid, or its RBAC role lacks permissions in this project | Edit the RBAC role the token was generated from; changes apply to its tokens immediately |
| `404` from the API | `NF_PROJECT_ID` doesn't match a project the token can access | Check the project ID |
| `Sandbox ... failed to start` | The deployment failed | Check the service's deployment status and logs in the dashboard |
| `was not ready after 180000 ms` | The sandbox didn't reach `COMPLETED` in time | Check the service in the dashboard; retry |
| Python: `ConfigurationError: Northflank API token is not configured` | Neither `NF_API_TOKEN` nor `NORTHFLANK_API_TOKEN` is set | Export one of them |
| Python: `ApiCallError` 401/403 | Token invalid or its RBAC role lacks permissions; `NORTHFLANK_API_TOKEN` wins if both variables are set | Check which variable is set, and the token's RBAC role |
| Leftover `sbx-*` services | A run was interrupted before cleanup | `npm run cleanup` to list, `npm run cleanup -- --yes` to delete |

## Clean up

The scripts delete their own sandboxes. To remove anything left over from an interrupted run:

```bash
cd examples/typescript && npm run cleanup -- --yes
```

## Next

- [Execute AI-generated code safely](../execute-code-in-a-sandbox/README.md): run untrusted code and handle errors, runaway processes and files.
- [Connect an AI agent to a sandbox](../connect-sandbox-to-agent/README.md): give an LLM a `run_code` tool.
- [Sandbox lifecycle](../../guides/sandbox-lifecycle.md): pause, resume and persistent volumes.
