// Sandbox lifecycle: create -> use -> pause -> resume -> destroy.
// Shows what survives a pause and what doesn't. Run with: npm run lifecycle

import { SandboxClient } from "./sandbox.js";

const client = await SandboxClient.fromEnv();
const sandbox = await client.create();
console.log(`Created ${sandbox.id}`);

try {
  await sandbox.waitUntilReady();
  await sandbox.writeFile("/tmp/agent/state.txt", "written before pause");
  console.log("Wrote /tmp/agent/state.txt to ephemeral disk");

  console.log("Pausing. Compute billing stops while paused...");
  await sandbox.pause();

  console.log("Resuming...");
  const started = Date.now();
  await sandbox.resume();
  console.log(`Resumed in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  const check = await sandbox.exec("cat /tmp/agent/state.txt");
  console.log(
    check.exitCode === 0
      ? `File survived: ${check.stdout.trim()}`
      : "File is gone: ephemeral disk does not survive a pause. Attach a volume to persist state (tutorials/persist-files-between-sessions).",
  );
} finally {
  await sandbox.destroy();
  console.log(`Destroyed ${sandbox.id}`);
}
