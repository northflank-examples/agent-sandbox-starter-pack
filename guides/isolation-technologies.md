# Sandbox isolation technologies explained

How AI agent sandboxes keep untrusted code away from your host, your data and other users: containers, gVisor, microVMs, full VMs and WebAssembly, and how to choose between them.

**Short answer:** for arbitrary AI-generated or user-submitted code, use a boundary that does not share the host kernel directly: a **microVM** (Firecracker, Kata Containers, Cloud Hypervisor) or a **user-space kernel** (gVisor). Plain containers are fine for trusted code and are a reasonable layer *inside* a stronger boundary, but they shouldn't be the only thing between hostile code and your infrastructure.

## Contents

- [Do you need a sandbox at all?](#do-you-need-a-sandbox-at-all)
- [The kernel is the boundary that matters](#the-kernel-is-the-boundary-that-matters)
- [Containers are not a security boundary by default](#containers-are-not-a-security-boundary-by-default)
- [gVisor: a kernel in user space](#gvisor-a-kernel-in-user-space)
- [MicroVMs: Firecracker, Kata Containers, Cloud Hypervisor](#microvms-firecracker-kata-containers-cloud-hypervisor)
- [Full virtual machines](#full-virtual-machines)
- [WebAssembly and language-level sandboxes](#webassembly-and-language-level-sandboxes)
- [Comparison](#comparison)
- [How to choose](#how-to-choose)

## Do you need a sandbox at all?

You need one whenever code you didn't write and review runs with access to something you care about. For agents, that means:

- The model **writes and executes code** (code interpreter, data analysis, coding agents).
- The agent **runs shell commands** or installs packages.
- The agent reads **untrusted input** (web pages, emails, issues, uploaded files) *and* has tools that act. Prompt injection turns that input into instructions.
- You execute **user-submitted code** in a multi-tenant product.

You probably don't need one if the agent only calls a fixed set of well-defined APIs whose inputs you validate (for example, "look up order status by ID"). The tool interface is the sandbox there. Keep it narrow.

## The kernel is the boundary that matters

Every process eventually asks the kernel to do things: open files, open sockets, map memory. A process can only escape its isolation by convincing the kernel (or the hypervisor) to do something it shouldn't. So the useful question about any sandbox is: **how much kernel does the untrusted code get to talk to, and whose kernel is it?**

| | Talks directly to | Attack surface for escape |
| --- | --- | --- |
| Container | The **host** kernel (hundreds of syscalls, filtered) | Host kernel |
| gVisor | gVisor's user-space kernel (Sentry), which uses a small set of host syscalls | gVisor, then a reduced host surface |
| MicroVM / VM | Its **own guest** kernel | Hypervisor / VMM (small, purpose-built) |
| Wasm | The runtime's import functions only | The Wasm runtime |

## Containers are not a security boundary by default

Containers use Linux **namespaces** (separate views of processes, mounts, network, users), **cgroups** (resource limits) and **seccomp**/**AppArmor**/**SELinux** (syscall and access filtering). This is good isolation for trusted workloads, but every container on a host shares one kernel. A single kernel vulnerability, a mounted Docker socket, `--privileged`, or an over-broad capability can hand the code the whole host.

If you must use containers for untrusted code, harden them:

- Run as a non-root user and enable **user namespaces** (rootless).
- Drop all capabilities (`--cap-drop=ALL`), set `no-new-privileges`, keep the default (or stricter) seccomp profile.
- Read-only root filesystem with a small writable `tmpfs`.
- Never mount the Docker/containerd socket, host paths, or cloud metadata access.
- Set CPU, memory, PID and disk limits.
- Put each tenant on separate nodes if you can.

Even then, most hosted agent sandbox providers add a stronger layer underneath.

## gVisor: a kernel in user space

[gVisor](https://gvisor.dev) runs an application kernel (the *Sentry*), written in Go, between the container and the host. The untrusted code's syscalls go to the Sentry, which implements Linux behaviour itself and uses only a small, filtered set of host syscalls. It plugs into Docker and Kubernetes as the `runsc` runtime.

- **Pros:** container-like startup and density, a much smaller host attack surface, and it works without hardware virtualisation.
- **Cons:** syscall-heavy and I/O-heavy workloads run slower; a small number of syscalls or `/proc` behaviours differ from Linux.
- **Used by:** Google Cloud Run (first generation) and GKE Sandbox, Modal (one of two Sandbox runtimes, alongside a VM runtime; required for GPU Sandboxes), Northflank for GPU sandboxes.

## MicroVMs: Firecracker, Kata Containers, Cloud Hypervisor

A microVM is a virtual machine stripped down to what a server workload needs: usually no BIOS (direct kernel boot), no emulated USB or graphics, a minimal virtual device model. Each sandbox boots **its own Linux kernel** inside hardware virtualisation (KVM), so a kernel exploit inside the sandbox compromises only that guest kernel. To reach the host it must also break the virtual machine monitor (VMM).

- **[Firecracker](https://firecracker-microvm.github.io)** (AWS, Rust): the VMM behind AWS Lambda and Fargate. Boots in around 125 ms with a few MB of overhead. Used by E2B, Vercel Sandbox and others.
- **[Kata Containers](https://katacontainers.io)**: runs each Kubernetes pod or container inside a lightweight VM, using Cloud Hypervisor, Firecracker or QEMU underneath, so standard container images and Kubernetes tooling just work. Used by Northflank for CPU sandboxes.
- **[Cloud Hypervisor](https://www.cloudhypervisor.org)** (Rust): a modern VMM aimed at cloud workloads; a common Kata backend.

**Tradeoffs:** you need KVM (bare-metal hosts or nested virtualisation), memory overhead is a little higher than containers, and features such as GPU passthrough and live snapshots depend on the VMM.

## Full virtual machines

Traditional VMs (QEMU/KVM, cloud instances) give the same kernel-level separation as microVMs with a full device model and OS. They are the right choice for workloads that need a desktop, unusual devices or Windows, and for long-lived single-tenant environments. Boot times are typically seconds to minutes and per-instance overhead is higher, which makes them expensive for thousands of short agent tasks.

## WebAssembly and language-level sandboxes

[WebAssembly](https://webassembly.org) runtimes such as [Wasmtime](https://wasmtime.dev) run code with no direct system access; everything goes through functions the host explicitly provides (via WASI). [Pyodide](https://pyodide.org) runs CPython compiled to Wasm, even in a browser.

- **Pros:** microsecond start, tiny overhead, can run in-process or client-side, capability-based by design.
- **Cons:** only languages and libraries compiled to Wasm; no arbitrary binaries, `pip install` of native packages, browsers, compilers or shell tools. Many agent tasks need a real Linux userland.

Language-level "sandboxes" such as restricted `exec()` in Python, `vm` in Node.js, or AST filtering are **not** security boundaries. They have a long history of escapes. Don't rely on them for untrusted code.

## Comparison

| | Container | gVisor | MicroVM | Full VM | Wasm |
| --- | --- | --- | --- | --- | --- |
| Separate kernel from host | No | Yes (user space) | Yes (guest) | Yes (guest) | n/a |
| Typical cold start | ~100 ms–1 s | ~100 ms–1 s | ~125 ms–2 s | seconds+ | µs–ms |
| Runs any Linux binary | Yes | Mostly | Yes | Yes | No |
| Overhead | Lowest | Low–medium (syscall heavy) | Low | Higher | Lowest |
| Needs hardware virtualisation | No | No | Yes | Yes | No |
| Fit for hostile multi-tenant code | Only heavily hardened | Yes | Yes | Yes | Yes, within its limits |

Start times are indicative and depend heavily on image size, pre-warming and the platform.

## How to choose

1. **What will run?** Arbitrary Linux tools, package installs, browsers → microVM or gVisor. Pure Python/JS computation with no native dependencies → Wasm can be enough.
2. **Who wrote it?** Your own reviewed code → hardened containers are fine. Model-generated or user-submitted code → microVM or gVisor.
3. **Who else is on the host?** Multiple customers or users → kernel-level separation plus per-tenant sandboxes.
4. **Do you need GPUs?** GPU passthrough to microVMs is still uncommon; gVisor and dedicated VMs are typical.
5. **Do you run it yourself?** MicroVMs on your own infrastructure need KVM-capable nodes. Hosted providers handle that for you; BYOC (bring your own cloud) platforms install and manage the runtime, but your node pools still need bare-metal or nested-virtualisation instances (or fall back to gVisor).

Isolation is only one layer. Network egress, secrets and resource limits matter just as much: see [Sandbox security](sandbox-security.md).
