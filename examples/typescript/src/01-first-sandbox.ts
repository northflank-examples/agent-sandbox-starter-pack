// Create your first AI agent sandbox: provision it, run a command, read the
// output, clean up. Run with: npm run first-sandbox

import { SandboxClient } from "./sandbox.js";

const client = await SandboxClient.fromEnv();

console.log("1. Creating sandbox...");
const sandbox = await client.create({ image: "python:3.12-slim" });
console.log(`   created ${sandbox.id}`);

try {
  console.log("2. Waiting for it to boot...");
  const started = Date.now();
  await sandbox.waitUntilReady();
  console.log(`   ready in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  console.log("3. Running a command inside the sandbox...");
  const result = await sandbox.exec(
    "echo \"Hello from $(hostname)\" && uname -r && python3 --version",
  );
  console.log(`   exit code: ${result.exitCode}`);
  console.log(result.stdout.trimEnd().replace(/^/gm, "   | "));
} finally {
  console.log("4. Destroying sandbox...");
  await sandbox.destroy();
  console.log("   done");
}
