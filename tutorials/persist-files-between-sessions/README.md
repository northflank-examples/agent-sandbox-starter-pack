# Tutorial: Persist files between sandbox sessions

A coding agent that clones a repo, installs dependencies and takes notes shouldn't have to start from scratch every time the user comes back. But a sandbox's own disk is wiped when it's paused or restarted. In this tutorial you'll give a sandbox a **volume**, persistent storage that outlives pauses, restarts and even the sandbox itself, and use it to carry a workspace from one session to the next.

**You'll learn:**
- the difference between ephemeral disk and a volume, and when to use each
- how to create a volume and attach it to a sandbox
- how to end a session by pausing, and pick it up again by resuming
- how to delete a volume safely when you're done

**Prerequisite:** [Create your first sandbox](../create-your-first-sandbox/README.md). The API token's role also needs permission to create, update and delete volumes in the project. The finished scripts are [`06-persistent-volume.ts`](../../examples/typescript/src/06-persistent-volume.ts) and [`persistent_volume.py`](../../examples/python/persistent_volume.py).

## Step 1: Decide what needs to persist

A sandbox has two kinds of storage:

| | Ephemeral disk (`/tmp`, the image filesystem) | Volume (mounted at e.g. `/workspace`) |
| --- | --- | --- |
| Survives a command finishing | ✅ | ✅ |
| Survives pause / resume | ❌ wiped | ✅ |
| Survives a restart | ❌ wiped | ✅ |
| Survives deleting the sandbox | ❌ | ✅ (a volume is a separate resource) |
| Billed | Included in compute | Per GB-month, including while the sandbox is paused |

Put state the user will come back to on a volume: the repo, installed dependencies, notes, outputs. Leave everything else on ephemeral disk. It's cheaper, and nothing carries over that shouldn't.

## Step 2: Create the volume

Create the volume first, because you attach it when you create the sandbox. Choose where it's mounted inside the sandbox, how it can be accessed, and its size in MB:

**TypeScript**

```typescript
import { SandboxClient } from "./sandbox.js";

const client = await SandboxClient.fromEnv();
const { api, projectId } = client;

const volume = await api.create.volume({
  parameters: { projectId },
  data: {
    name: "sbx-data-demo",
    mounts: [{ containerMountPath: "/workspace" }],
    spec: { accessMode: "ReadWriteMany", storageClassName: "nf-multi-rw", storageSize: 5120 },
  },
});
const volumeId = volume.data.id;
```

**Python**

```python
from northflank_sandbox import SandboxClient

client = SandboxClient()
api, project_id = client.api, client.project_id

volume = api.create.volume(
    project_id=project_id,
    data={
        "name": "sbx-data-demo",
        "mounts": [{"containerMountPath": "/workspace"}],
        "spec": {"accessMode": "ReadWriteMany", "storageClassName": "nf-multi-rw", "storageSize": 5120},
    },
)
volume_id = volume.data["id"]
```

Use the `id` from the response to refer to the volume from now on, rather than assuming it matches the name you chose.

## Step 3: Create a sandbox with the volume attached

Pass the volume ID when you create the sandbox. Under the hood, the helper adds `createOptions: { volumesToAttach: [volumeId] }` to the create request from the first tutorial.

**TypeScript**

```typescript
const sandbox = await client.create({ volumes: [volumeId] });
await sandbox.waitUntilReady();
```

**Python**

```python
sandbox = client.create(volumes=[volume_id])
sandbox.wait_until_ready()
```

You can also attach a volume to an existing sandbox with `attach.volume`, but that redeploys the sandbox, and its ephemeral disk is wiped. Attaching at creation avoids that.

## Step 4: Work in the volume

Anything written under the mount path, `/workspace` here, is stored on the volume. Write the session's state there, and use `/tmp` for scratch files:

**TypeScript**

```typescript
await sandbox.writeFile("/workspace/notes.md", "# Session 1\n- cloned repo\n- installed deps\n");
await sandbox.writeFile("/tmp/scratch.txt", "temporary");
```

**Python**

```python
sandbox.write_file("/workspace/notes.md", "# Session 1\n- cloned repo\n- installed deps\n")
sandbox.write_file("/tmp/scratch.txt", "temporary")
```

## Step 5: End the session by pausing

When the user goes away, pause the sandbox. Pausing stops compute billing and ends running processes; the configuration and the volume are kept. Wait for the pause to finish before you resume, or the resume can race it.

**TypeScript**

```typescript
await api.pause.service({ parameters: { projectId, serviceId: sandbox.id } });
// The helper's sandbox.pause() also waits until the sandbox reports it is paused.
```

**Python**

```python
api.pause.service(project_id=project_id, service_id=sandbox.id)
api.helpers.wait_for_service_paused(project_id=project_id, service_id=sandbox.id)
```

## Step 6: Resume and pick up where you left off

When the user returns, resume the sandbox and wait for it to be ready again. Files on the volume are back exactly as they were; ephemeral storage starts empty.

**TypeScript**

```typescript
await api.resume.service({ parameters: { projectId, serviceId: sandbox.id }, data: {} });
await sandbox.waitUntilReady();

console.log((await sandbox.exec("cat /workspace/notes.md")).stdout);   // still there
console.log((await sandbox.exec("cat /tmp/scratch.txt")).exitCode);    // non-zero: gone
```

**Python**

```python
api.resume.service(project_id=project_id, service_id=sandbox.id, data={})
sandbox.wait_until_ready()

print(sandbox.exec("cat /workspace/notes.md").stdout)   # still there
print(sandbox.exec("cat /tmp/scratch.txt").exit_code)   # non-zero: gone
```

To come back days later, you can even delete the sandbox and keep only the volume. Store the volume ID with the user's session and create a new sandbox with `volumes: [volumeId]` when they return.

## Step 7: Clean up in the right order

A volume is billed for as long as it exists, and it can't be deleted while it's attached. So clean up in three steps: detach the volume, delete the sandbox, then delete the volume. Detaching finishes in the background, so deleting the volume can return `409` for a few seconds: wait and retry. `404` or `410` means it's already gone.

**TypeScript**

```typescript
await api.detach.volume({
  parameters: { projectId, volumeId },
  data: { nfObject: { id: sandbox.id, type: "service" } },
});
await sandbox.destroy();
await api.delete.volume({ parameters: { projectId, volumeId } });   // retry on 409
```

**Python**

```python
api.detach.volume(
    project_id=project_id,
    volume_id=volume_id,
    data={"nfObject": {"id": sandbox.id, "type": "service"}},
)
sandbox.destroy()
api.delete.volume(project_id=project_id, volume_id=volume_id)   # retry on 409
```

Deleting a volume can't be undone. Copy out anything you need first, for example with `api.download.service.files` (TypeScript) or `api.files.download` (Python).

## Run the complete example

The finished scripts run all seven steps, including the retry:

```bash
cd examples/typescript && npm run persistent-volume
# or
cd examples/python && python persistent_volume.py
```

Add `--keep-volume` (`npm run persistent-volume -- --keep-volume`) to keep the volume after the sandbox is deleted.

Expected output:

```
Created volume sbx-data-m2x9k1 (5 GB, mounted at /workspace)
Created sandbox sbx-4f2a9c1e
Wrote /workspace/notes.md (volume) and /tmp/scratch.txt (ephemeral)
Pausing...
Resuming...

/workspace/notes.md: SURVIVED
  | # Session 1
  | - cloned repo
  | - installed deps
/tmp/scratch.txt:    LOST (ephemeral disk is wiped on pause)

Destroyed sandbox sbx-4f2a9c1e
Deleted volume sbx-data-m2x9k1
```

Illustrative output: IDs will differ.

## Patterns for agent workspaces

- **One volume per user and project.** Never share a volume between users. Name it after the owner so you can find it again (for example `ws-<userId>-<repo>`).
- **Put caches on the volume** (`pip` and `npm` caches, a cloned repo) so a resumed session doesn't download everything again.
- **Expire idle volumes.** Volumes are billed while paused; delete workspaces that haven't been used for a while.

## Common errors

| Symptom | Cause | Fix |
| --- | --- | --- |
| `409` when deleting the volume | Still attached, or the detach hasn't finished | Detach first; retry for a few seconds |
| File on `/workspace` is missing after resume | No volume attached | Pass `volumes` / `createOptions.volumesToAttach` when creating the sandbox |
| `Permission denied` writing to `/workspace` | Image runs as a non-root user | `chown` the mount once as root, or write as the image's user |
| Volume left behind after Ctrl+C | Script interrupted before cleanup | Delete it in the dashboard, or with `api.delete.volume` |

Northflank docs: [Create a sandbox with persistent storage](https://northflank.com/docs/v1/application/sandboxes/examples#create-a-sandbox-with-persistent-storage) · [Configure and manage sandboxes](https://northflank.com/docs/v1/application/sandboxes/configure-and-manage-sandboxes) · [Add a volume](https://northflank.com/docs/v1/application/databases-and-persistence/add-a-volume).

## Next

- [Monitor sandbox resource usage](../monitor-sandbox-usage/README.md)
- [Sandbox lifecycle guide](../../guides/sandbox-lifecycle.md)
