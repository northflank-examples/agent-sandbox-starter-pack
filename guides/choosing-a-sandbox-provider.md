# Choosing an AI agent sandbox provider

A decision guide: which questions matter, and how they narrow the field. For the provider list see [resources/sandbox-providers.md](../resources/sandbox-providers.md); for prices see [agent-sandbox-pricing](https://github.com/northflank-examples/agent-sandbox-pricing).

## Hosted API or self-managed?

| | Hosted sandbox API | Self-managed (Firecracker / gVisor / Kata on your infra) |
| --- | --- | --- |
| Time to first sandbox | Minutes | Weeks |
| Who patches the hypervisor and hosts | Provider | You |
| Data location | Provider's cloud (unless BYOC) | Your cloud |
| Cost at scale | Provider margin on compute | Your compute + engineering time |
| Customisation | Whatever the API exposes | Anything |

A middle option is **BYOC (bring your own cloud)**: a managed platform that runs sandboxes on node pools inside *your* cloud account. You keep data residency and use your cloud discounts without operating the VMM layer yourself. Northflank offers BYOC self-serve: connect your cloud account and deploy a cluster yourself from the dashboard. Some other providers offer it on enterprise plans.

## The questions that decide it

1. **Isolation.** Do you run untrusted or multi-tenant code? Require a microVM or gVisor. Check what the provider uses *by default* and whether it changes for GPUs. ([Isolation guide](isolation-technologies.md).)
2. **Session length.** Some providers cap continuous runtime (for example 24 hours, or less on free tiers). Long-running agents need a provider with no cap or with pause/resume that resets it.
3. **Persistence.** Do you need state between sessions? Look for volumes, snapshots, and what happens to paused sandboxes over time (some are archived or deleted after a period).
4. **Startup latency.** Measure create-to-first-exec for *your* image, not the marketing number.
5. **Languages and SDKs.** Python and TypeScript are universal; check for a first-party SDK in your stack, a REST API, and a CLI for debugging.
6. **Resources.** Maximum CPU, memory and disk per sandbox; GPUs if you need them.
7. **Networking.** Can you disable or allowlist egress? Expose ports with authentication? Use a static egress IP?
8. **Scale and limits.** Concurrency limits per plan, rate limits on the API, and how quickly you can create hundreds of sandboxes.
9. **Where it runs.** Regions, data residency, and BYOC if compliance requires your own cloud account.
10. **Billing model.** Allocated resources vs. active CPU vs. usage-based; plan fees; idle charges. Mostly-idle agents and busy batch jobs favour different models. See [agent-sandbox-pricing](https://github.com/northflank-examples/agent-sandbox-pricing).

## Rough fit by workload

| Workload | Prioritise |
| --- | --- |
| Short code-interpreter calls | Startup latency, warm pools, low per-second cost |
| Long-running coding agents | No session cap, volumes, pause/resume, SSH or terminal access |
| Evals and RL at scale | High concurrency, fast create, low price per sandbox-hour |
| User-submitted code in a product | Strong isolation, egress control, per-tenant quotas, audit logs |
| Regulated data | BYOC / self-hosting, region choice, network controls |
| GPU workloads | GPU availability, isolation for GPUs, per-GPU pricing |

## Evaluate with a bake-off

Before committing, run the same script on your top two or three candidates:

1. Create a sandbox from **your** image; time create → first successful exec.
2. Run a representative task; check stdout, stderr and exit codes are reliable.
3. Run a runaway process; confirm timeouts kill it.
4. Try to reach the internet and an internal address with egress restricted.
5. Pause and resume; check what state survived.
6. Create 50 at once; note failures, latency and rate limits.
7. Leave one idle for a day; check the bill.

The [TypeScript examples](../examples/typescript/) cover steps 1–5 on Northflank (step 4 uses the networking example's egress probe and optional network policy) and are small enough to port to another provider's SDK.
