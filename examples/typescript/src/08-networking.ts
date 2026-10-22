// Secure sandbox networking.
//
// Part 1, ingress: the agent starts a web server in the sandbox. Expose it on
// a public port protected by basic auth, then prove from outside that
// unauthenticated requests are rejected and authenticated ones get through.
//
// Part 2, egress: probe what the sandbox can reach (an allowed package index,
// an arbitrary website, the cloud metadata endpoint). With --egress-policy,
// also create a Northflank network policy that denies all egress except an
// allowlist for sandboxes carrying the agent-sandbox tag in this project,
// probe again, and delete the policy afterwards.
//
// Run with: npm run networking
//           npm run networking -- --egress-policy   (needs Networking > NetworkPolicies permissions)

import { randomBytes } from "node:crypto";
import { SandboxClient, SANDBOX_TAG, type Sandbox } from "./sandbox.js";

const withEgressPolicy = process.argv.includes("--egress-policy");
const ALLOWED_EGRESS = ["pypi.org", "files.pythonhosted.org"];

const client = await SandboxClient.fromEnv();
const { api, projectId } = client;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sandbox = await client.create();
console.log(`Created ${sandbox.id}`);

async function startWebServer(s: Sandbox) {
  await s.writeFile("/tmp/agent/site/index.html", "<h1>Preview built by the agent</h1>\n");
  await s.exec(
    "kill -0 $(cat /tmp/agent/http.pid 2>/dev/null) 2>/dev/null || " +
      "(setsid nohup python3 -m http.server 8080 --directory /tmp/agent/site > /proc/1/fd/1 2>&1 < /dev/null & echo $! > /tmp/agent/http.pid)",
  );
}

/** Runs inside the sandbox: try each destination, report reachable or blocked. */
const PROBE = `
import urllib.request
targets = {
    "pypi.org (package index)": "https://pypi.org/simple/",
    "example.com (arbitrary site)": "https://example.com/",
    "169.254.169.254 (cloud metadata)": "http://169.254.169.254/",
}
for name, url in targets.items():
    try:
        urllib.request.urlopen(url, timeout=5)
        result = "REACHABLE"
    except urllib.error.HTTPError as e:
        result = f"REACHABLE (HTTP {e.code})"
    except Exception as e:
        result = f"blocked ({type(e).__name__})"
    print(f"{name:34} {result}")
`;

async function probeEgress(s: Sandbox, label: string) {
  const r = await s.runCode("python", PROBE, { timeoutSeconds: 30 });
  console.log(`\nEgress from inside the sandbox (${label}):`);
  console.log((r.stdout || r.stderr).trimEnd().replace(/^/gm, "  "));
}

let networkPolicyId: string | undefined;

try {
  await sandbox.waitUntilReady();

  // ---------- Part 1: ingress ----------
  const password = randomBytes(18).toString("base64url");
  console.log("\nExposing port 8080 publicly, protected by basic auth...");
  await api.patch.service.deployment({
    parameters: { projectId, serviceId: sandbox.id },
    data: {
      ports: [
        {
          name: "http",
          internalPort: 8080,
          public: true,
          protocol: "HTTP",
          security: {
            credentials: [{ username: "agent", password, type: "basic-auth" }],
            // To also restrict by source IP, add for example:
            // ip: [{ addresses: ["203.0.113.0/24"], action: "ALLOW" }],
          },
        },
      ],
    },
  });
  // Wait for the sandbox, then start the server if it isn't running.
  await sandbox.waitUntilReady();
  await startWebServer(sandbox);

  const ports = await api.get.service.ports({
    parameters: { projectId, serviceId: sandbox.id },
  });
  const dns = ports.data.ports.find((p) => p.internalPort === 8080)?.dns;
  if (!dns) throw new Error("No public DNS returned for port 8080");
  const url = `https://${dns}/`;
  console.log(`Public URL: ${url}`);

  // Retry until the public port answers.
  const auth = `Basic ${Buffer.from(`agent:${password}`).toString("base64")}`;
  let anonymous = 0;
  let authenticated = 0;
  for (let i = 0; i < 36 && !(anonymous === 401 && authenticated === 200); i++) {
    anonymous = await fetch(url).then((r) => r.status).catch(() => 0);
    authenticated = await fetch(url, { headers: { Authorization: auth } }).then((r) => r.status).catch(() => 0);
    if (!(anonymous === 401 && authenticated === 200)) await sleep(5_000);
  }
  console.log(`  without credentials: HTTP ${anonymous || "no response"} ${anonymous === 401 ? "(rejected, as intended)" : ""}`);
  console.log(`  with credentials:    HTTP ${authenticated || "no response"} ${authenticated === 200 ? "(served)" : ""}`);

  // Remove the public port as soon as the preview isn't needed.
  await api.patch.service.deployment({
    parameters: { projectId, serviceId: sandbox.id },
    data: { ports: [] },
  });
  console.log("Removed the public port");
  await sandbox.waitUntilReady();

  // ---------- Part 2: egress ----------
  await probeEgress(sandbox, "no network policy");

  if (withEgressPolicy) {
    console.log(`\nCreating a network policy: deny egress except ${ALLOWED_EGRESS.join(", ")},`);
    console.log(`for workloads tagged "${SANDBOX_TAG}" in project ${projectId}...`);
    const policyName = `sandbox-egress-${sandbox.id.slice(-8)}`;
    const policy = await api.create.networkPolicy({
      data: {
        name: policyName,
        description: "agent-sandbox-starter-pack egress allowlist",
        spec: {
          restrictions: {
            projects: { enabled: true, items: [projectId], restrictionMode: "in" },
            tags: { enabled: true, items: [SANDBOX_TAG], matchCondition: "and" },
          },
          // Any egress rule turns egress into an allowlist.
          egress: { allowTo: ALLOWED_EGRESS },
        },
      },
    });
    networkPolicyId = policy.data?.id ?? policyName;
    console.log(`Created network policy ${networkPolicyId}; waiting 30s for it to apply...`);
    await sleep(30_000);
    await probeEgress(sandbox, "with network policy");
  } else {
    console.log("\nRe-run with -- --egress-policy to apply an egress allowlist and compare.");
  }
} finally {
  if (networkPolicyId) {
    await api.delete.networkPolicy({ parameters: { networkPolicyId } });
    console.log(`\nDeleted network policy ${networkPolicyId}`);
  }
  await sandbox.destroy();
  console.log(`Destroyed ${sandbox.id}`);
}
