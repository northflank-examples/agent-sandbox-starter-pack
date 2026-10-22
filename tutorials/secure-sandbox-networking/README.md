# Tutorial: Secure sandbox networking

A sandbox stops code from touching your host, but the network is a way out. A preview server the agent starts can be found by anyone on the internet, and code with open outbound access can send whatever it reads anywhere it likes. In this tutorial you'll control both directions: put a web server the agent started behind authentication and prove it from outside, then measure and restrict what the sandbox can reach.

**You'll learn:**
- which network directions matter for a sandbox
- how to expose a sandbox port behind basic auth, and how to test it
- how to probe outbound access from inside a sandbox
- how to apply an egress allowlist to sandboxes with a network policy
- how to keep sandboxes away from your other services

**Prerequisite:** [Create your first sandbox](../create-your-first-sandbox/README.md). Background reading: [Networking and secrets guide](../../guides/networking-and-secrets.md). The finished scripts are [`08-networking.ts`](../../examples/typescript/src/08-networking.ts) and [`secure_networking.py`](../../examples/python/secure_networking.py).

## Step 1: Know the three directions

| Direction | Example | What can go wrong |
| --- | --- | --- |
| **Inbound** | A preview server or notebook the agent started | Anyone who finds the URL can use it |
| **Outbound** | `pip install`, calling an API, `curl` | Code downloads tools or sends data out |
| **Internal** | Your databases and internal APIs | A sandbox reaches services it should never see |

Steps 2–4 handle inbound, steps 5–6 outbound, and step 7 internal.

## Step 2: Expose a port behind basic auth

Agents often start servers: an app preview, a notebook, an API under test. A dev server has no authentication of its own, so put a security policy on the port before making it public. Generate a fresh password for each sandbox.

**TypeScript**

```typescript
import { randomBytes } from "node:crypto";
import { SandboxClient } from "./sandbox.js";

const client = await SandboxClient.fromEnv();
const { api, projectId } = client;
const sandbox = await client.create();
await sandbox.waitUntilReady();

const password = randomBytes(18).toString("base64url");
await api.patch.service.deployment({
  parameters: { projectId, serviceId: sandbox.id },
  data: {
    ports: [{
      name: "http", internalPort: 8080, public: true, protocol: "HTTP",
      security: {
        credentials: [{ username: "agent", password, type: "basic-auth" }],
        // and/or restrict by source IP: ip: [{ addresses: ["203.0.113.0/24"], action: "ALLOW" }],
      },
    }],
  },
});
```

**Python**

```python
import secrets
from northflank_sandbox import SandboxClient

client = SandboxClient()
api, project_id = client.api, client.project_id
sandbox = client.create()
sandbox.wait_until_ready()

password = secrets.token_urlsafe(18)
api.patch.service.deployment(
    project_id=project_id,
    service_id=sandbox.id,
    data={"ports": [{
        "name": "http", "internalPort": 8080, "public": True, "protocol": "HTTP",
        "security": {"credentials": [{"username": "agent", "password": password, "type": "basic-auth"}]},
    }]},
)
```

The example then waits for the sandbox and starts a small web server on port 8080 (`python3 -m http.server 8080`), playing the part of the agent's preview. Ports are set with `patch.service.deployment`; the older `update.service.ports` endpoint is deprecated.

## Step 3: Find the URL and test it from outside

Read the port's public hostname, then request it from your own machine twice: once without credentials, once with them.

**TypeScript**

```typescript
const ports = await api.get.service.ports({ parameters: { projectId, serviceId: sandbox.id } });
const url = `https://${ports.data.ports.find((p) => p.internalPort === 8080)?.dns}/`;

const auth = `Basic ${Buffer.from(`agent:${password}`).toString("base64")}`;
console.log((await fetch(url)).status);                                      // 401
console.log((await fetch(url, { headers: { Authorization: auth } })).status); // 200
```

**Python**

```python
import base64
import urllib.error
import urllib.request

ports = api.get.service.ports(project_id=project_id, service_id=sandbox.id)
dns = next(p.get("dns") for p in ports.data["ports"] if p["internalPort"] == 8080)
url = f"https://{dns}/"

def status(headers: dict[str, str]) -> int:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers)) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code

auth = "Basic " + base64.b64encode(f"agent:{password}".encode()).decode()
print(status({}))                        # 401
print(status({"Authorization": auth}))   # 200
```

`401` without credentials and `200` with them is the result you want. The example retries for a few minutes until the port answers.

Choose the most restrictive option that works:

| Option | Who can reach it | Use for |
| --- | --- | --- |
| No port | Nobody; use exec and file copy | Code interpreters, batch jobs |
| `public: false` and `vpcAccessible: false` | Workloads in the same project; developers via `northflank forward` | Sandbox-to-sandbox, local debugging |
| Public + IP allowlist | Listed addresses only | Previews for your office or VPN |
| Public + basic auth or SSO | Anyone with credentials, or your organisation's SSO users | Previews shared with users |
| Public, no policy | Anyone on the internet | Avoid |

## Step 4: Remove the port when you're done

A preview only needs to exist while someone is looking at it. Remove the port as soon as it's no longer needed:

**TypeScript**

```typescript
await api.patch.service.deployment({
  parameters: { projectId, serviceId: sandbox.id },
  data: { ports: [] },
});
```

**Python**

```python
api.patch.service.deployment(project_id=project_id, service_id=sandbox.id, data={"ports": []})
```

## Step 5: Measure what the sandbox can reach

Before restricting outbound traffic, measure it. Run a probe *inside* the sandbox that tries a package index, an arbitrary website and the cloud metadata address (`169.254.169.254`, which on many clouds can hand out credentials):

**Python**

```python
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
```

The examples run this with `sandbox.runCode("python", PROBE)` / `sandbox.run_python(PROBE)`. This first run shows what your sandbox can reach today, before any policy.

## Step 6: Apply an egress allowlist

Northflank [network policies](https://northflank.com/docs/v1/application/network/configure-network-policies) control inbound and outbound traffic between workloads, projects and external destinations. Adding any egress rule turns outbound traffic into an **allowlist**: only the destinations you list are allowed.

Scope the policy so it only applies to sandboxes. Every sandbox in these examples is tagged `agent-sandbox`, so restrict the policy to that tag in your sandbox project:

**TypeScript**

```typescript
const policyName = "sandbox-egress";
const policy = await api.create.networkPolicy({
  data: {
    name: policyName,
    spec: {
      restrictions: {
        projects: { enabled: true, items: [projectId], restrictionMode: "in" },
        tags: { enabled: true, items: ["agent-sandbox"], matchCondition: "and" },
      },
      egress: { allowTo: ["pypi.org", "files.pythonhosted.org"] },   // or denyAll: true
    },
  },
});
const networkPolicyId: string = policy.data?.id ?? policyName;
```

**Python**

```python
policy_name = "sandbox-egress"
policy = api.create.network_policy(data={
    "name": policy_name,
    "spec": {
        "restrictions": {
            "projects": {"enabled": True, "items": [project_id], "restrictionMode": "in"},
            "tags": {"enabled": True, "items": ["agent-sandbox"], "matchCondition": "and"},
        },
        "egress": {"allowTo": ["pypi.org", "files.pythonhosted.org"]},
    },
})
network_policy_id = (policy.data or {}).get("id") or policy_name
```

Then run the probe again. Once the policy is in effect, you should see:

```
Egress from inside the sandbox (with network policy):
  pypi.org (package index)           REACHABLE
  example.com (arbitrary site)       blocked (URLError)
  169.254.169.254 (cloud metadata)   blocked (URLError)
```

> **Always verify with the probe.** An allowlist that isn't in effect looks exactly like no policy at all. Only rely on the policy once `example.com` and the metadata address show as blocked from inside the sandbox.

Pick the rule that matches what the task needs:

| Egress need | Policy |
| --- | --- |
| Pure computation | `egress: { denyAll: true }` |
| Install packages | `allowTo` your package registry or internal mirror |
| Call one API | `allowTo` that host |
| Reach a service in another project | `allowToProjects` / `allowToTags` |

Two more ways to need less outbound access: **pre-install dependencies** in the image, and **route egress through a proxy** that enforces an allowlist and logs every request. The network policy API also has an `egressSecretInjection` field (`name`, `header`, `hosts`, `value`); see the [API reference](https://northflank.com/docs/v1/api/team/network-policies/create-network-policy).

The example creates the policy only when you pass `--egress-policy`, and deletes it at the end:

**TypeScript**

```typescript
await api.delete.networkPolicy({ parameters: { networkPolicyId } });
```

**Python**

```python
api.delete.network_policy(network_policy_id=network_policy_id)
```

Creating and deleting network policies needs the Account → Networking → NetworkPolicies permissions on the token's role.

## Step 7: Keep sandboxes away from your other services

Run sandboxes in a **dedicated project**. On Northflank, each project is a self-contained network by default: its resources are reachable only from inside the project, unless you expose a port publicly or forward it. To let one project reach another, you [allow ingress from other projects](https://northflank.com/docs/v1/application/network/enable-multi-project-networking#allow-ingress-from-other-projects) on the target project. Ingress is one-way and works only between projects on the same cluster. Never allow ingress from your sandbox project into a production project.

If a third-party API must allowlist your sandboxes' traffic, route them through a [static egress IP](https://northflank.com/docs/v1/application/network/configure-egress-ips). It gives outbound traffic a fixed address; use a network policy to control which destinations a sandbox can reach.

## Run the complete example

The finished scripts run steps 2–5, and step 6 with `--egress-policy`, then clean up:

```bash
cd examples/typescript && npm run networking
npm run networking -- --egress-policy
# or
cd examples/python && python secure_networking.py
python secure_networking.py --egress-policy
```

Expected output (the ingress part):

```
Public URL: https://http--sbx-3c9d1f0a--agent-sandboxes--abc1.code.run/
  without credentials: HTTP 401 (rejected, as intended)
  with credentials:    HTTP 200 (served)
Removed the public port
```

Illustrative output: your generated hostname will differ.

## Clean up

The scripts delete their sandbox and, with `--egress-policy`, their network policy. If a run was interrupted, delete any `sandbox-egress-*` policy under Networking → Network policies, and run `npm run cleanup -- --yes` for sandboxes.

## Common errors

| Symptom | Cause | Fix |
| --- | --- | --- |
| Public URL keeps returning no response | Port not reachable yet | The script retries 36 times, 5 seconds apart; check the port in the dashboard |
| HTTP 200 without credentials | Port patched without `security` | Include the `security` block for the port in the `ports` payload |
| Permission error creating the network policy | Token role lacks network policy permissions | Grant Account → Networking → NetworkPolicies (Create, Delete) to the RBAC role the token was generated from |
| Probe results don't change with the policy | Policy not in effect for this sandbox | Wait and re-probe; check the policy's project and tag restrictions match the sandbox (tag `agent-sandbox`) under Networking → Network policies |

Northflank docs: [Configure network policies](https://northflank.com/docs/v1/application/network/configure-network-policies) · [Add security policies for ports](https://northflank.com/docs/v1/application/network/add-security-policies-for-ports) · [Networking on Northflank](https://northflank.com/docs/v1/application/network/networking-on-northflank).

## Next

- [Networking and secrets guide](../../guides/networking-and-secrets.md)
- [Sandbox security guide](../../guides/sandbox-security.md)
