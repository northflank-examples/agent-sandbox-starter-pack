# AI agent sandbox providers, runtimes and SDKs

A directory of the places you can run AI agent sandboxes: what isolation each uses, which SDKs it ships, and where to find working examples. For **prices**, see the companion [agent-sandbox-pricing](https://github.com/northflank-examples/agent-sandbox-pricing) repository, which tracks rates and workload costs with sources.

**Last reviewed:** 2026-10-21. Providers change quickly; each entry links to the vendor's own docs, which win if anything here disagrees. Corrections via [pull request](../CONTRIBUTING.md) are welcome, including from vendors.

> **Disclosure:** maintained by Northflank, which is listed below. Entries are in alphabetical order after the summary table.

## Hosted sandbox platforms

| Provider | Isolation | SDKs / interfaces | Max session | Persistence | Your own cloud | GPUs |
| --- | --- | --- | --- | --- | --- | --- |
| [Cloudflare Sandboxes](https://developers.cloudflare.com/sandbox/) | Cloudflare Containers (microVM); Dynamic Workers (isolates) | TypeScript (in Workers) | No fixed max; stops after an inactivity timeout (up to 6 h) | Ephemeral disk; filesystem snapshots (beta, 30-day retention); R2 bucket mounts | No | No |
| [Daytona](https://www.daytona.io/docs) | Containers by default; optional VMs | Python, TypeScript, Go, Java, Ruby, CLI, REST API | No limit (auto-stop after idle by default) | Yes; stopped sandboxes archived after a period | Custom regions / own compute | Yes (NVIDIA/AMD, up to 8 per sandbox; GPU sandboxes are ephemeral) |
| [E2B](https://docs.e2b.dev/) | Firecracker microVM | Python, JS/TS, CLI | Plan-dependent (1 h Hobby / 24 h Pro) | Pause/resume (filesystem + memory), snapshots, volumes | Enterprise | No (CPU-only) |
| [Modal Sandboxes](https://modal.com/docs/guide/sandboxes) | gVisor or VM runtime (Modal chooses if unset) | Python; JavaScript and Go (beta) | Up to 24 h | Volumes, filesystem snapshots | No | Yes |
| [Northflank](https://northflank.com/docs/v1/application/sandboxes/quickstart) | Kata Containers microVM (CPU); gVisor (GPU) | Python and JS/TS SDKs, REST API, CLI | No limit | Volumes; pause/resume | Yes, self-serve BYOC (AWS, GCP, Azure, Oracle, Civo, CoreWeave, and more) | Yes |
| [Sprites (Fly.io)](https://docs.fly.io/sprites) | microVM | JS/TS, Go, Python, Elixir SDKs; CLI, REST API, MCP | No limit (persistent) | Persistent disk, checkpoints | No | No |
| [Vercel Sandbox](https://vercel.com/docs/sandbox) | Firecracker microVM | TypeScript, Python, CLI | Plan-dependent (45 min Hobby / 24 h Pro) | Persistent by default (saved on stop), snapshots, Drives | No | No |

Session and persistence details are summarised from each provider's docs as tracked in [agent-sandbox-pricing](https://github.com/northflank-examples/agent-sandbox-pricing/tree/main/providers); check the linked docs before relying on a limit.

### Cloudflare Sandboxes

Linux sandboxes run on Cloudflare Containers (one microVM per instance), started from a Durable Object in your Worker; Dynamic Workers offer a lighter isolate-based option for JavaScript, Python or Wasm. Control code is TypeScript in Workers. A natural fit if your agent already runs on Workers or Durable Objects.

### Daytona

Sandboxes with Python, TypeScript, Go, Java and Ruby SDKs, aimed at agent workloads. GPU sandboxes are available (ephemeral, up to 8 GPUs). Container isolation by default with optional VM sandboxes that have their own kernel. Sandboxes auto-stop after idle time by default.

### E2B

Open-source Firecracker-based sandbox runtime with Python and JS SDKs, a code-interpreter SDK, and templates for building custom images. Pause/resume preserves the filesystem and memory, including running processes; snapshots and volumes are also available. Sandboxes are CPU-only. Continuous runtime limits depend on plan.

### Modal Sandboxes

Sandboxes on Modal's serverless platform, defined in Python (with JavaScript and Go SDKs in beta). Runs on gVisor or a VM runtime (Modal chooses if you don't), GPUs available on the gVisor runtime, and integrates with Modal volumes and images.

### Northflank

Sandboxes are Northflank deployment services running in Kata Containers microVMs on the managed cloud (gVisor for GPU workloads), with no session limit, volumes, public or private ports, GPUs, and self-serve **bring your own cloud** so sandboxes can run inside your AWS, GCP, Azure or other account. Driven by the Python SDK, the JS/TS client, the REST API or the CLI. This repository's [examples](../examples/) use it.

### Sprites (Fly.io)

Persistent microVMs that pause automatically when idle and resume on demand, billed on actual usage, with JavaScript, Go, Python and Elixir SDKs. Suited to long-lived agent environments rather than thousands of short tasks.

### Vercel Sandbox

Firecracker microVMs on Vercel's infrastructure with TypeScript and Python SDKs. Sandboxes are persistent by default (state is saved when they stop), with snapshots and Drives for storage. CPU is billed only while active. Session length depends on plan.

## Self-managed building blocks

| Project | What it is | Use it for |
| --- | --- | --- |
| [Firecracker](https://github.com/firecracker-microvm/firecracker) | Minimal KVM-based VMM from AWS | Building your own microVM sandbox platform |
| [Cloud Hypervisor](https://www.cloudhypervisor.org) | Rust VMM for cloud workloads | MicroVM backend, often under Kata |
| [Kata Containers](https://katacontainers.io) | Runs containers/pods inside lightweight VMs | MicroVM isolation with standard Kubernetes and OCI images |
| [gVisor](https://gvisor.dev) | User-space application kernel (`runsc`) | Stronger-than-container isolation without KVM |
| [kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) | Kubernetes API (CRD + controller) for isolated, stateful agent sandboxes | Running sandboxes on your own Kubernetes clusters |
| [nsjail](https://github.com/google/nsjail) / [bubblewrap](https://github.com/containers/bubblewrap) | Lightweight Linux process sandboxing with namespaces and seccomp | Hardening a process on a single host |
| [Anthropic sandbox-runtime](https://github.com/anthropics/sandbox-runtime) | OS-level filesystem and network restrictions for local agent processes | Sandboxing an agent CLI on a developer machine |
| [Wasmtime](https://wasmtime.dev) / [Pyodide](https://pyodide.org) | WebAssembly runtime / CPython in Wasm | Lightweight sandboxes for pure computation |

## Choosing

See [Choosing an AI agent sandbox provider](../guides/choosing-a-sandbox-provider.md) for the decision criteria and a bake-off script, and [Isolation technologies](../guides/isolation-technologies.md) for what each isolation type protects against.
