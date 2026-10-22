"""Secure sandbox networking.

Part 1, ingress: the agent starts a web server in the sandbox. Expose it on a
public port protected by basic auth, then prove from outside that
unauthenticated requests are rejected and authenticated ones get through.

Part 2, egress: probe what the sandbox can reach (an allowed package index, an
arbitrary website, the cloud metadata endpoint). With --egress-policy, also
create a Northflank network policy that denies all egress except an allowlist
for sandboxes carrying the agent-sandbox tag in this project, probe again, and
delete the policy afterwards.

Run with: python secure_networking.py [--egress-policy]
"""

import base64
import secrets
import sys
import time
import urllib.error
import urllib.request

from northflank_sandbox import SANDBOX_TAG, Sandbox, SandboxClient

WITH_EGRESS_POLICY = "--egress-policy" in sys.argv
ALLOWED_EGRESS = ["pypi.org", "files.pythonhosted.org"]

# Runs inside the sandbox: try each destination, report reachable or blocked.
PROBE = """
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
"""

client = SandboxClient()
api, project_id = client.api, client.project_id


def start_web_server(s: Sandbox) -> None:
    s.write_file("/tmp/agent/site/index.html", "<h1>Preview built by the agent</h1>\n")
    s.exec(
        "kill -0 $(cat /tmp/agent/http.pid 2>/dev/null) 2>/dev/null || "
        "(setsid nohup python3 -m http.server 8080 --directory /tmp/agent/site > /proc/1/fd/1 2>&1 < /dev/null "
        "& echo $! > /tmp/agent/http.pid)"
    )


def http_status(url: str, headers: dict | None = None) -> int:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=10) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 0


def probe_egress(s: Sandbox, label: str) -> None:
    r = s.run_python(PROBE, timeout_seconds=30)
    print(f"\nEgress from inside the sandbox ({label}):")
    for line in (r.stdout or r.stderr).splitlines():
        print(f"  {line}")


sandbox = client.create()
print(f"Created {sandbox.id}")
network_policy_id = None

try:
    sandbox.wait_until_ready()

    # ---------- Part 1: ingress ----------
    password = secrets.token_urlsafe(18)
    print("\nExposing port 8080 publicly, protected by basic auth...")
    api.patch.service.deployment(
        project_id=project_id,
        service_id=sandbox.id,
        data={
            "ports": [
                {
                    "name": "http",
                    "internalPort": 8080,
                    "public": True,
                    "protocol": "HTTP",
                    "security": {
                        "credentials": [{"username": "agent", "password": password, "type": "basic-auth"}],
                        # To also restrict by source IP, add for example:
                        # "ip": [{"addresses": ["203.0.113.0/24"], "action": "ALLOW"}],
                    },
                }
            ]
        },
    )
    # Wait for the sandbox, then start the server if it isn't running.
    sandbox.wait_until_ready()
    start_web_server(sandbox)

    ports = api.get.service.ports(project_id=project_id, service_id=sandbox.id)
    dns = next((p.get("dns") for p in ports.data["ports"] if p["internalPort"] == 8080), None)
    if not dns:
        raise RuntimeError("No public DNS returned for port 8080")
    url = f"https://{dns}/"
    print(f"Public URL: {url}")

    # Retry until the public port answers.
    auth = {"Authorization": "Basic " + base64.b64encode(f"agent:{password}".encode()).decode()}
    anonymous = authenticated = 0
    for _ in range(36):
        anonymous, authenticated = http_status(url), http_status(url, auth)
        if anonymous == 401 and authenticated == 200:
            break
        time.sleep(5)
    print(f"  without credentials: HTTP {anonymous or 'no response'} {'(rejected, as intended)' if anonymous == 401 else ''}")
    print(f"  with credentials:    HTTP {authenticated or 'no response'} {'(served)' if authenticated == 200 else ''}")

    # Remove the public port as soon as the preview isn't needed.
    api.patch.service.deployment(project_id=project_id, service_id=sandbox.id, data={"ports": []})
    print("Removed the public port")
    sandbox.wait_until_ready()

    # ---------- Part 2: egress ----------
    probe_egress(sandbox, "no network policy")

    if WITH_EGRESS_POLICY:
        print(f"\nCreating a network policy: deny egress except {', '.join(ALLOWED_EGRESS)},")
        print(f'for workloads tagged "{SANDBOX_TAG}" in project {project_id}...')
        policy_name = f"sandbox-egress-{sandbox.id[-8:]}"
        policy = api.create.network_policy(
            data={
                "name": policy_name,
                "description": "agent-sandbox-starter-pack egress allowlist",
                "spec": {
                    "restrictions": {
                        "projects": {"enabled": True, "items": [project_id], "restrictionMode": "in"},
                        "tags": {"enabled": True, "items": [SANDBOX_TAG], "matchCondition": "and"},
                    },
                    # Any egress rule turns egress into an allowlist.
                    "egress": {"allowTo": ALLOWED_EGRESS},
                },
            }
        )
        network_policy_id = (policy.data or {}).get("id") or policy_name
        print(f"Created network policy {network_policy_id}; waiting 30s for it to apply...")
        time.sleep(30)
        probe_egress(sandbox, "with network policy")
    else:
        print("\nRe-run with --egress-policy to apply an egress allowlist and compare.")
finally:
    if network_policy_id:
        api.delete.network_policy(network_policy_id=network_policy_id)
        print(f"\nDeleted network policy {network_policy_id}")
    sandbox.destroy()
    print(f"Destroyed {sandbox.id}")
