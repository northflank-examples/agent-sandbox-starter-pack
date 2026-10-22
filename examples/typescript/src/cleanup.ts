// Delete every sandbox these examples created (services named "sbx-*") in
// NF_PROJECT_ID. Use it if a script was interrupted before its cleanup ran.
// Run with: npm run cleanup            (lists only)
//           npm run cleanup -- --yes   (deletes)

import { SandboxClient } from "./sandbox.js";

const client = await SandboxClient.fromEnv();
const ids = await client.list();

if (ids.length === 0) {
  console.log("No sbx-* sandboxes found.");
} else if (!process.argv.includes("--yes")) {
  console.log(`Found ${ids.length} sandbox(es):\n  ${ids.join("\n  ")}`);
  console.log("\nRe-run with `npm run cleanup -- --yes` to delete them.");
} else {
  for (const id of ids) {
    await client.get(id).destroy();
    console.log(`deleted ${id}`);
  }
}
