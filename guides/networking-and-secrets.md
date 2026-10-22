# Sandbox networking and secrets

How to control what an AI agent sandbox can reach, how to expose services running inside one, and how to give code the credentials it needs without letting it steal them.

## Contents

- [Three directions of traffic](#three-directions-of-traffic)
- [Outbound (egress): default deny](#outbound-egress-default-deny)
- [Internal: keep sandboxes off your private network](#internal-keep-sandboxes-off-your-private-network)
- [Inbound: exposing ports from a sandbox](#inbound-exposing-ports-from-a-sandbox)
- [Secrets: the rules](#secrets-the-rules)
- [Patterns for giving code a credential safely](#patterns-for-giving-code-a-credential-safely)
- [On Northflank](#on-northflank)

## Three directions of traffic

| Direction | Example | Default risk |
| --- | --- | --- |
| **Outbound** to the internet | `pip install`, calling an API, `curl` | Data exfiltration, malware download, abuse from your IPs |
| **Internal** to your own services | Database, internal APIs, other sandboxes, cloud metadata | Lateral movement, credential theft |
| **Inbound** from users or your app | A dev server, notebook or preview the agent started | Unauthenticated exposure of whatever is running |

Decide each one explicitly for every sandbox type you run.

## Outbound (egress): default deny

Ask what the task actually needs:

| Task | Egress policy |
| --- | --- |
| Code interpreter, data analysis on uploaded files | **None** |
| Installing packages | Package registry only (PyPI, npm), or better, your own mirror |
| Calling one external API | That host only, ideally via a proxy that injects the credential |
| Browsing / research agents | Broad egress through a logging proxy with a blocklist, plus strict secret hygiene |

How to enforce it, depending on where sandboxes run:

- **Provider network policy.** Many sandbox platforms let you disable internet access or set allowlists per sandbox. Check your provider's docs; it's the simplest option when available. On Northflank, use [network policies](#on-northflank).
- **Kubernetes `NetworkPolicy`** (self-managed or BYOC clusters): a default-deny egress policy for the sandbox namespace, plus explicit allows. Requires a CNI that enforces policies (Cilium, Calico).
- **Egress proxy.** Route all outbound traffic through an HTTP(S) proxy (Squid, Envoy, a custom service) that enforces an allowlist and logs every request. Combine with a network rule that blocks direct egress so code can't bypass it.
- **Pre-install dependencies** in the image so most tasks don't need the network at all.

Always block the cloud **instance metadata service** (`169.254.169.254`, `metadata.google.internal`), which can return credentials for the underlying node.

## Internal: keep sandboxes off your private network

A sandbox that can reach your production database is one prompt injection away from a breach.

- Run sandboxes in a **separate project, namespace, VPC or cluster** from production services.
- Don't enable private networking between sandboxes and internal services unless a task needs it, and then only to that one service.
- Block sandbox-to-sandbox traffic, especially across tenants.
- If sandboxes need data, hand it over explicitly (upload a file, mount a read-only volume) rather than granting network access to the source.

## Inbound: exposing ports from a sandbox

Agents often start servers: a web app preview, a Jupyter notebook, an API under test. To expose one:

- **Private first.** Expose the port only inside the project, or forward it to a developer's machine, before making anything public.
- **Authenticate public ports.** Put an IP allowlist, basic auth or SSO in front of anything public. A dev server started by an agent has no auth of its own.
- **Short-lived URLs.** Remove the port, or destroy the sandbox, when the preview is no longer needed.

## Secrets: the rules

1. **The agent loop and its API keys live outside the sandbox.** Your app calls the LLM; the sandbox only executes code. ([Example](../examples/typescript/src/04-agent.ts).)
2. **Your sandbox platform token never enters a sandbox.** It can create, read and delete every sandbox.
3. **Nothing in the image.** No secrets in `ENV`, build args, or files baked into images.
4. **Scoped and short-lived.** If code needs a credential, it gets one for this task only, with the minimum permissions, expiring in minutes or hours.
5. **Assume anything inside is readable by the code.** Environment variables, files and process memory are all visible to code running as the same user. "Hidden" secrets aren't hidden.

## Patterns for giving code a credential safely

| Pattern | How it works | Code sees the secret? |
| --- | --- | --- |
| **Tool on the host** | The model calls a tool in your app (e.g. `create_issue`), which uses the credential. The sandbox is only for computation. | No |
| **Credential-injecting proxy** | Sandbox calls `http://proxy/github/...`; the proxy adds the token and forwards only allowed paths. | No |
| **Short-lived scoped token** | Mint a token (GitHub App installation token, cloud STS credential) for one repo/bucket, valid for minutes, and pass it as an env var. | Yes, but it's narrow and expires |
| **Long-lived key in env** | Pass your real key as an environment variable. | Yes. **Avoid.** |

## On Northflank

- **Sandboxes are services.** Each one is a deployment service in a project. Use a dedicated project for sandboxes, separate from production workloads.
- **Runtime variables:** pass non-secret configuration with `runtimeEnvironment` when creating the sandbox ([example](../examples/typescript/src/sandbox.ts)). Northflank **secret groups** can scope secrets to specific services if a sandbox type genuinely needs one.
- **Ports:** set `ports` with `patch.service.deployment` (the older `update.service.ports` endpoint is deprecated). Set `public: false` and `vpcAccessible: false` to keep a port reachable only from inside the project; public ports get a generated DNS name and TLS. Port **security policies** (`security.credentials`, `security.ip`, SSO) add basic auth, IP allowlists or SSO in front of public ports.
- **Network policies** define ingress and egress allowlists (`egress.denyAll`, `egress.allowTo` hosts/CIDRs, `allowToProjects`, `allowToTags`) and can target workloads by project and tag, for example every sandbox tagged `agent-sandbox`. Verify a policy from inside a sandbox before relying on it. See [Configure network policies](https://northflank.com/docs/v1/application/network/configure-network-policies).
- **Static egress IPs** let you route selected workloads through a fixed outbound IP, which is useful when a third-party API must allowlist you.
- **Bring your own cloud (BYOC), self-serve:** connect your own AWS, GCP, Azure or other cloud account and run sandboxes on a cluster inside it; your data and compute stay inside your infrastructure.

Hands-on: [Tutorial: Secure sandbox networking](../tutorials/secure-sandbox-networking/README.md) exposes a port behind basic auth, probes egress from inside a sandbox, and applies an egress allowlist.

Northflank docs: [Sandboxes](https://northflank.com/docs/v1/application/sandboxes/quickstart) · [Networking](https://northflank.com/docs/v1/application/network/networking-on-northflank) · [Secrets](https://northflank.com/docs/v1/application/secure/inject-secrets).
