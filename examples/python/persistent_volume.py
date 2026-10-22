"""Persist files between sessions with a volume.

Writes one file to the volume (/workspace) and one to ephemeral disk (/tmp),
pauses the sandbox, resumes it, and shows which file survived. Then cleans up
in the documented order: detach the volume, delete the sandbox, delete the volume.

Run with: python persistent_volume.py [--keep-volume]
"""

import sys
import time

from northflank import ApiCallError

from northflank_sandbox import SANDBOX_PREFIX, SandboxClient

keep_volume = "--keep-volume" in sys.argv
client = SandboxClient()
api, project_id = client.api, client.project_id

# 1. Create the volume first, then attach at creation (attaching later with attach.volume redeploys the sandbox).
volume = api.create.volume(
    project_id=project_id,
    data={
        "name": f"{SANDBOX_PREFIX}data-{int(time.time()):x}",
        "mounts": [{"containerMountPath": "/workspace"}],
        "spec": {
            "accessMode": "ReadWriteMany",
            "storageClassName": "nf-multi-rw",
            "storageSize": 5120,  # MB
        },
    },
)
# Read the ID back rather than assuming it equals the name.
volume_id = volume.data["id"]
print(f"Created volume {volume_id} (5 GB, mounted at /workspace)")

sandbox = None
try:
    # 2. Create a sandbox with the volume attached.
    sandbox = client.create(volumes=[volume_id])
    print(f"Created sandbox {sandbox.id}")
    sandbox.wait_until_ready()

    # 3. Simulate a session: the agent writes state to both places.
    sandbox.write_file("/workspace/notes.md", "# Session 1\n- cloned repo\n- installed deps\n")
    sandbox.write_file("/tmp/scratch.txt", "temporary")
    print("Wrote /workspace/notes.md (volume) and /tmp/scratch.txt (ephemeral)")

    # 4. End the session: pause stops compute billing; the volume is still billed.
    print("Pausing...")
    sandbox.pause()

    # 5. Next session: resume and check what survived.
    print("Resuming...")
    sandbox.resume()
    on_volume = sandbox.exec("cat /workspace/notes.md")
    on_tmp = sandbox.exec("cat /tmp/scratch.txt")
    print(f"\n/workspace/notes.md: {'SURVIVED' if on_volume.exit_code == 0 else 'lost'}")
    for line in on_volume.stdout.splitlines():
        print(f"  | {line}")
    print(f"/tmp/scratch.txt:    {'survived' if on_tmp.exit_code == 0 else 'LOST (ephemeral disk is wiped on pause)'}")
finally:
    # 6. Clean up. A volume can't be deleted while attached, and detaching
    #    settles asynchronously, so retry delete on 409.
    if sandbox is not None:
        try:
            api.detach.volume(
                project_id=project_id,
                volume_id=volume_id,
                data={"nfObject": {"id": sandbox.id, "type": "service"}},
            )
        except ApiCallError as error:
            print(f"detach failed: {error.status} {error.message}")
        sandbox.destroy()
        print(f"\nDestroyed sandbox {sandbox.id}")

    if keep_volume:
        print(f"Kept volume {volume_id}. Attach it to a new sandbox with client.create(volumes=['{volume_id}']).")
    else:
        for attempt in range(1, 21):
            try:
                api.delete.volume(project_id=project_id, volume_id=volume_id)
                print(f"Deleted volume {volume_id}")
                break
            except ApiCallError as error:
                if error.status in (404, 410):  # already gone
                    break
                if attempt == 20:
                    raise
                time.sleep(3)  # 409 while the detach is still settling
