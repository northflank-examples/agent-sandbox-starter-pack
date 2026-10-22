// Persist files between sessions with a volume. Writes one file to the volume
// (/workspace) and one to ephemeral disk (/tmp), pauses the sandbox, resumes
// it, and shows which file survived. Then cleans up in the documented order:
// detach the volume, delete the sandbox, delete the volume.
//
// Run with: npm run persistent-volume
// Keep the volume afterwards (to resume the session later): npm run persistent-volume -- --keep-volume

import { SandboxClient, SANDBOX_PREFIX, type Sandbox } from "./sandbox.js";

const keepVolume = process.argv.includes("--keep-volume");
const client = await SandboxClient.fromEnv();
const { api, projectId } = client;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 1. Create the volume first, then attach at creation (attaching later with attach.volume redeploys the sandbox).
const volumeName = `${SANDBOX_PREFIX}data-${Date.now().toString(36)}`;
const volume = await api.create.volume({
  parameters: { projectId },
  data: {
    name: volumeName,
    mounts: [{ containerMountPath: "/workspace" }],
    spec: {
      accessMode: "ReadWriteMany",
      storageClassName: "nf-multi-rw",
      storageSize: 5120, // MB
    },
  },
});
// Read the ID back rather than assuming it equals the name.
const volumeId = volume.data.id;
console.log(`Created volume ${volumeId} (5 GB, mounted at /workspace)`);

let sandbox: Sandbox | undefined;
try {
  // 2. Create a sandbox with the volume attached.
  sandbox = await client.create({ volumes: [volumeId] });
  console.log(`Created sandbox ${sandbox.id}`);
  await sandbox.waitUntilReady();

  // 3. Simulate a session: the agent writes state to both places.
  await sandbox.writeFile("/workspace/notes.md", "# Session 1\n- cloned repo\n- installed deps\n");
  await sandbox.writeFile("/tmp/scratch.txt", "temporary");
  console.log("Wrote /workspace/notes.md (volume) and /tmp/scratch.txt (ephemeral)");

  // 4. End the session: pause stops compute billing; the volume is still billed.
  console.log("Pausing...");
  await sandbox.pause();

  // 5. Next session: resume and check what survived.
  console.log("Resuming...");
  await sandbox.resume();
  const onVolume = await sandbox.exec("cat /workspace/notes.md");
  const onTmp = await sandbox.exec("cat /tmp/scratch.txt");
  console.log(`\n/workspace/notes.md: ${onVolume.exitCode === 0 ? "SURVIVED" : "lost"}`);
  if (onVolume.exitCode === 0) console.log(onVolume.stdout.trimEnd().replace(/^/gm, "  | "));
  console.log(`/tmp/scratch.txt:    ${onTmp.exitCode === 0 ? "survived" : "LOST (ephemeral disk is wiped on pause)"}`);
} finally {
  // 6. Clean up. A volume can't be deleted while attached, and detaching
  //    settles asynchronously, so retry delete on 409.
  if (sandbox) {
    const sandboxId = sandbox.id;
    await api.detach.volume({
      parameters: { projectId, volumeId },
      data: { nfObject: { id: sandboxId, type: "service" } },
    }).catch((e) => console.warn(`detach failed: ${e}`));
    await sandbox.destroy();
    console.log(`\nDestroyed sandbox ${sandboxId}`);
  }

  if (keepVolume) {
    console.log(`Kept volume ${volumeId}. Attach it to a new sandbox with client.create({ volumes: ["${volumeId}"] }).`);
  } else {
    for (let attempt = 1; ; attempt++) {
      try {
        await api.delete.volume({ parameters: { projectId, volumeId } });
        console.log(`Deleted volume ${volumeId}`);
        break;
      } catch (e) {
        const status = (e as { status?: number }).status;
        if (status === 404 || status === 410) break; // already gone
        if (attempt >= 20) throw e;
        await sleep(3_000); // 409 while the detach is still settling
      }
    }
  }
}
